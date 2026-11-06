#!/usr/bin/env node
/*
 * hodifly - deploy from git on cPanel, from your own machine.
 *
 * ONE FILE, ZERO DEPENDENCIES. Node 18+ (for global fetch). Install it with
 *   pnpm add -g hodifly     (or npm i -g hodifly)
 * or just download this file and run `node hodifly.js`.
 *
 * Every command is a call to the Hodifly UAPI module on your cPanel server
 * (https://HOST:2083/execute/Hodifly/...), authenticated with a cPanel API token that carries your
 * own privileges and nothing more. The command names follow the Vercel CLI, so what you already know
 * transfers: projects hold configuration, deployments are the immutable builds under them.
 *
 * Several servers at once is the normal case here, not an edge case: a hosting account lives on one
 * machine, and somebody with sites on three of them should not have to remember which. So `login`
 * stores a named PROFILE per account and records which domains and projects that account serves;
 * every later command finds the right server and credentials from the name you typed. See resolve().
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const VERSION = '1.3.0';
const PROG = 'hodifly';

// ---------------------------------------------------------------------------------------------
// configuration
//
// ~/.hodifly/config.json, mode 0600, one entry per cPanel account:
//
//   { "version": 1, "current": "main",
//     "profiles": { "main": { host, user, token, domains: [...], projects: [...], updated } } }
//
// `sites` is a CACHE of this account's projects and the domain each one publishes to, refreshed on
// login and by `hodifly refresh`. It is what lets a bare name resolve to the right server without a
// round trip to every account you own - and it means a DOMAIN works wherever a project name does,
// which is usually what someone reaches for first.
// ---------------------------------------------------------------------------------------------

const CONFIG_DIR = process.env.HODIFLY_CONFIG_DIR || path.join(os.homedir(), '.hodifly');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object' || !c.profiles) return { version: 1, current: null, profiles: {} };
    return c;
  } catch {
    return { version: 1, current: null, profiles: {} };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Written 0600 and replaced atomically: the file holds API tokens, and a half-written one would
  // lock you out of every account at once.
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort on Windows */ }
}

// The environment always wins, so a one-off against another account needs no config at all.
function envProfile() {
  const { HODIFLY_HOST: host, HODIFLY_USER: user, HODIFLY_TOKEN: token } = process.env;
  return host && user && token ? { name: '(environment)', host, user, token } : null;
}

// ---------------------------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------------------------

class ApiError extends Error {}

// `module` is Hodifly for everything but `db`, which drives cPanel's own Mysql / Postgresql modules
// with the same token.
async function call(profile, fn, args = {}, module = 'Hodifly') {
  const url = `https://${profile.host}:2083/execute/${module}/${fn}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    // An EMPTY string is sent, not dropped: on `projects set` it is how a field is cleared
    // (--build-command "" means "no build"), which the server reads differently from an absent key.
    if (v !== undefined && v !== null) body.append(k, String(v));
  }

  // cPanel hosts usually carry a valid certificate for their hostname. When one does not, this is
  // the escape hatch - narrow and explicit, rather than silently trusting anything.
  if (process.env.HODIFLY_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `cpanel ${profile.user}:${profile.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `hodifly-cli/${VERSION}`,
      },
      body,
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new ApiError(`${profile.host} did not answer within 3 minutes.`);
    const hint = /certificate|self-signed|altname/i.test(String(e && e.message))
      ? ` The server's TLS certificate was rejected; if that is expected, re-run with HODIFLY_INSECURE=1.`
      : ` Check the host name, and that you can reach port 2083 from here.`;
    throw new ApiError(`could not reach https://${profile.host}:2083 -${hint}`);
  }

  // An unusable token gets an HTTP error and an HTML page; without this it would surface as a JSON
  // parse failure and send people looking in entirely the wrong place.
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(`the server rejected your credentials for "${profile.user}" on ${profile.host}.\n` +
      `  The token may have been revoked. Create a new one in cPanel > Manage API Tokens, then run: ${PROG} login`);
  }
  if (res.status === 404) {
    throw new ApiError(module === 'Hodifly'
      ? `${profile.host} has no Hodifly API. Is Hodifly installed on that server?`
      : `${profile.host} does not offer ${module} on this account.`);
  }

  const text = await res.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ApiError(`${profile.host} did not return JSON (HTTP ${res.status}).`);
  }
  // /execute/ answers flat; the uapi CLI wraps the same thing in "result". Accept either.
  const r = doc.result || doc;
  if (!r.status) throw new ApiError((r.errors && r.errors[0]) || 'the request failed');
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// profiles: which server and which credentials
// ---------------------------------------------------------------------------------------------

function profileList(cfg) {
  return Object.entries(cfg.profiles).map(([name, p]) => ({ name, ...p }));
}

// Work out which account a command is about, and what to call the project on it.
//
//   --profile / HODIFLY_PROFILE   an explicit choice always wins
//   HODIFLY_HOST/USER/TOKEN       an ad-hoc account, no config needed
//   the name you typed            matched against every account's cached projects AND domains
//   the current profile           when the name is not in any cache yet (a project created
//                                 elsewhere a minute ago is the common case)
//
// A name that matches two accounts is refused rather than guessed at: picking one at random would
// deploy to the wrong site, and that is not a mistake anybody catches quickly.
//
// Returns { profile, subject } - `subject` is the project name to send, which is NOT always what
// was typed: a domain is the thing people reach for first, so a domain carrying exactly one project
// is rewritten to that project's name before the call goes out.
function pick(cfg, opts, typed, { asProject = true } = {}) {
  const explicit = opts.profile || process.env.HODIFLY_PROFILE;
  if (explicit) {
    const p = cfg.profiles[explicit];
    if (!p) throw new ApiError(`no profile called "${explicit}". Run: ${PROG} profiles`);
    const prof = { name: explicit, ...p };
    return { profile: prof, subject: asProject ? rewrite(prof, typed) : typed };
  }

  const env = envProfile();
  if (env) return { profile: env, subject: typed };

  const all = profileList(cfg);
  if (all.length === 0) throw new ApiError(`not signed in yet. Run: ${PROG} login`);
  if (all.length === 1) return { profile: all[0], subject: asProject ? rewrite(all[0], typed) : typed };

  if (typed) {
    const needle = String(typed).toLowerCase();
    const hits = all.filter((p) => (p.sites || []).some(
      (s) => s.name.toLowerCase() === needle || (s.domain || '').toLowerCase() === needle));
    if (hits.length === 1) return { profile: hits[0], subject: asProject ? rewrite(hits[0], typed) : typed };
    if (hits.length > 1) {
      throw new ApiError(
        `"${typed}" exists on more than one of your accounts (${hits.map((h) => h.name).join(', ')}).\n` +
        `  Say which: ${PROG} <command> ${typed} --profile ${hits[0].name}`);
    }
  }

  const cur = cfg.current && cfg.profiles[cfg.current];
  if (cur) {
    const p = { name: cfg.current, ...cur };
    return { profile: p, subject: asProject ? rewrite(p, typed) : typed };
  }

  throw new ApiError(
    `you have several accounts and I cannot tell which this is for.\n` +
    `  Add --profile <name>, or set a default with: ${PROG} use <name>`);
}

// A domain instead of a project name: fine when that domain carries exactly one project. When it
// carries several, say so and name them rather than picking one.
function rewrite(profile, typed) {
  if (!typed) return typed;
  const needle = String(typed).toLowerCase();
  const sites = profile.sites || [];
  if (sites.some((s) => s.name.toLowerCase() === needle)) return typed;   // already a project name

  const onDomain = sites.filter((s) => (s.domain || '').toLowerCase() === needle);
  if (onDomain.length === 1) return onDomain[0].name;
  if (onDomain.length > 1) {
    const names = onDomain.map((s) => s.name);
    const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? `, and ${names.length - 8} more` : '');
    throw new ApiError(
      `${typed} has ${names.length} projects on it: ${shown}.\n` +
      `  Name the one you mean, or run: ${PROG} projects`);
  }
  return typed;                       // an id, or something only the server can judge
}

// Refresh a profile's domain/project index. Best effort: a server that is down must not stop a
// login from being saved, it just leaves that account out of name resolution until the next run.
async function reindex(profile) {
  try {
    const projects = await call(profile, 'list_projects');
    profile.sites = projects
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, domain: p.domain || '' }));
    delete profile.projects;                 // shape used before sites existed
    delete profile.domains;
    profile.updated = new Date().toISOString();
    return profile.sites.length;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------

const wantJson = () => process.argv.includes('--json');

function table(rows, headers) {
  if (!rows.length) return console.log('(none)');
  const all = [headers, ...rows];
  const w = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  const line = (r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd();
  console.log(line(headers));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

const when = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString() : '');

function show(view, data) {
  if (wantJson()) return console.log(JSON.stringify(data, null, 2));
  if (view === 'projects') {
    table((data || []).map((p) => [p.name, p.domain, p.branch, p.last_status, p.id]),
      ['NAME', 'DOMAIN', 'BRANCH', 'STATUS', 'ID']);
  } else if (view === 'deployments') {
    table((data || []).map((d) => [
      d.id, (d.sha || '').slice(0, 8), d.status, d.action || 'deploy', when(d.started),
      (d.message || '').split('\n')[0].slice(0, 48),
    ]), ['ID', 'COMMIT', 'STATUS', 'ACTION', 'STARTED', 'MESSAGE']);
  } else if (view === 'log') {
    process.stdout.write((data && data.log) || '(no output kept for this build)\n');
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

// ---------------------------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------------------------

function ask(question, { silent = false } = {}) {
  return new Promise((resolve_) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) return rl.question(question, (a) => { rl.close(); resolve_(a.trim()); });

    // Keep the token off the screen. It is also never passed as an argument by default, so it does
    // not end up in shell history or in the process list.
    process.stdout.write(question);
    const onData = (ch) => {
      if (['\n', '\r', ''].includes(String(ch))) process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
    rl.output.write = () => {};
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve_(a.trim());
    });
  });
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

async function cmdLogin(args, opts) {
  const cfg = readConfig();

  const host = opts.host || await ask('cPanel server (e.g. server.example.com): ');
  const user = opts.user || await ask('cPanel username: ');
  // --token is accepted so the cPanel page can hand over a complete command, but the prompt is the
  // default on purpose: an argument is visible in `ps` and lands in shell history.
  const token = opts.token || await ask('API token (cPanel > Manage API Tokens): ', { silent: true });

  if (!host || !user || !token) throw new ApiError('nothing saved - server, username and token are all needed.');

  const name = opts.profile || user;
  const profile = { host, user, token };

  const n = await reindex(profile);
  if (n === null) {
    throw new ApiError(`saved nothing: could not use those credentials against ${host}.\n` +
      `  Check the username and token, then try again.`);
  }

  cfg.profiles[name] = profile;
  if (!cfg.current) cfg.current = name;
  writeConfig(cfg);

  console.log(`Signed in as ${user} on ${host}, saved as profile "${name}".`);
  console.log(`${n} project${n === 1 ? '' : 's'} found. Credentials are in ${CONFIG_FILE} (owner-only).`);
  if (Object.keys(cfg.profiles).length > 1) {
    console.log(`You now have ${Object.keys(cfg.profiles).length} accounts; project and domain names pick the right one automatically.`);
  }
}

function cmdLogout(args, opts) {
  const cfg = readConfig();
  const name = opts.profile || args[0] || cfg.current;
  if (!name || !cfg.profiles[name]) throw new ApiError(`no profile called "${name}". Run: ${PROG} profiles`);
  delete cfg.profiles[name];
  if (cfg.current === name) cfg.current = Object.keys(cfg.profiles)[0] || null;
  writeConfig(cfg);
  console.log(`Removed profile "${name}". The token still exists on the server: revoke it in cPanel > Manage API Tokens.`);
}

function cmdProfiles() {
  const cfg = readConfig();
  const all = profileList(cfg);
  if (!all.length) return console.log(`No accounts yet. Run: ${PROG} login`);
  table(all.map((p) => [
    p.name === cfg.current ? `* ${p.name}` : `  ${p.name}`,
    p.user, p.host, (p.sites || []).length, new Set((p.sites || []).map((s) => s.domain).filter(Boolean)).size,
  ]), ['PROFILE', 'USER', 'SERVER', 'PROJECTS', 'DOMAINS']);
}

function cmdUse(args) {
  const cfg = readConfig();
  const name = args[0];
  if (!name || !cfg.profiles[name]) throw new ApiError(`no profile called "${name}". Run: ${PROG} profiles`);
  cfg.current = name;
  writeConfig(cfg);
  console.log(`Default account is now "${name}".`);
}

async function cmdRefresh() {
  const cfg = readConfig();
  const all = profileList(cfg);
  if (!all.length) throw new ApiError(`no accounts yet. Run: ${PROG} login`);
  for (const p of all) {
    const n = await reindex(cfg.profiles[p.name]);
    console.log(n === null ? `${p.name}: unreachable, left as it was` : `${p.name}: ${n} project(s)`);
  }
  writeConfig(cfg);
}

async function cmdProjects(args, opts) {
  const cfg = readConfig();
  if (args[0] === 'add' || args[0] === 'create') return cmdCreate(args.slice(1), opts);
  if (args[0] === 'set' || args[0] === 'update' || args[0] === 'edit') return cmdSet(args.slice(1), opts);
  const { profile } = pick(cfg, opts, null);
  show('projects', await call(profile, 'list_projects'));
}

// The build settings, shared by `projects add` and `projects set`. Vercel's names where Vercel has
// one; the domain, the folder on the account and every secret are deliberately absent from `set`,
// because those belong to the installation rather than to the project's configuration.
const SETTINGS = ['branch', 'root_directory', 'build_command', 'output_directory', 'framework',
                  'runtime', 'mode', 'docroot', 'startup', 'previews', 'rebuild_every'];
const SET_ONLY = ['autodeploy', 'notify_success', 'notify_failed', 'notify_email', 'persist'];

async function cmdCreate(args, opts) {
  const cfg = readConfig();
  // A create says which domain it is for, and a domain belongs to exactly one account, so that is
  // the strongest hint available for picking the profile.
  if (!opts.repo || !opts.domain) {
    throw new ApiError(`--repo and --domain are both required.\n  e.g. ${PROG} projects add --repo my-org/site --domain example.com`);
  }
  const { profile } = pick(cfg, opts, opts.domain, { asProject: false });
  const send = {};
  for (const key of ['repo', 'domain', 'directory', ...SETTINGS]) {
    if (opts[key] !== undefined) send[key] = opts[key];
  }
  const out = await call(profile, 'create_project', send);
  show('json', out);
  // The new project is not in the cached index yet, and the very next command is usually about it.
  await reindex(cfg.profiles[profile.name]);
  if (cfg.profiles[profile.name]) writeConfig(cfg);
}

// Change settings on a project that already exists. A PATCH: only what you name is sent, and
// anything you leave out stays as it is. Nothing is built here - the new settings apply to the next
// deploy, so `hodifly deploy <project>` is the usual follow-up.
async function cmdSet(args, opts) {
  const typed = need(args[0],
    `which project? ${PROG} projects set <project> --startup dist/main.js`);
  const cfg = readConfig();
  const { profile, subject: project } = pick(cfg, opts, typed);

  const send = { project };
  for (const key of [...SETTINGS, ...SET_ONLY]) {
    if (opts[key] !== undefined) send[key] = opts[key];
  }
  if (Object.keys(send).length === 1) {
    throw new ApiError(`nothing to change. Name a setting, for example:\n` +
      `  ${PROG} projects set ${typed} --startup dist/main.js`);
  }

  const out = await call(profile, 'update_project', send);
  show('json', out);
  if (!wantJson()) console.log(`Saved. It applies to the next build: ${PROG} deploy ${typed}`);
}

async function cmdDeploy(args, opts) {
  const typed = need(args[0], `which project? ${PROG} deploy <project>`);
  const cfg = readConfig();
  const { profile, subject: project } = pick(cfg, opts, typed);
  await startDeployment(profile, project);
}

// One place that starts a build, so `env ... --deploy` behaves exactly like `hodifly deploy`.
async function startDeployment(profile, project) {
  show('json', await call(profile, 'create_deployment', { project }));
}

async function cmdLs(args, opts) {
  const typed = need(args[0], `which project? ${PROG} ls <project>`);
  const cfg = readConfig();
  const target = (opts.prod || opts.production) ? 'production' : undefined;
  const { profile, subject: project } = pick(cfg, opts, typed);
  show('deployments', await call(profile, 'list_deployments', { project, target }));
}

async function cmdRollback(args, opts) {
  const typed = need(args[0], `which project? ${PROG} rollback <project> <deployment>`);
  const deployment = need(args[1], `which deployment? run: ${PROG} ls ${typed} --prod`);
  const cfg = readConfig();
  const { profile, subject: project } = pick(cfg, opts, typed);
  show('json', await call(profile, 'rollback_deployment', { project, deployment }));
}

async function cmdLogs(args, opts) {
  const typed = need(args[0], `which project? ${PROG} logs <project> [deployment]`);
  const cfg = readConfig();
  const { profile, subject: project } = pick(cfg, opts, typed);
  show('log', await call(profile, 'get_deployment_logs', { project, deployment: args[1] }));
}

async function cmdRemove(args, opts) {
  const typed = need(args[0], `which project? ${PROG} remove <project>`);
  const cfg = readConfig();
  const { profile, subject: project } = pick(cfg, opts, typed);
  show('json', await call(profile, 'delete_project', { project }));
  await reindex(cfg.profiles[profile.name]);
  if (cfg.profiles[profile.name]) writeConfig(cfg);
}

// ---------------------------------------------------------------------------------------------
// env: the project's environment variables
//
// They live on the server, encrypted, and the engine writes them into shared/.env on EVERY deploy.
// So editing them here means editing the stored set and redeploying: shared/.env itself is never
// touched, because whatever is written there by hand is gone at the next build.
//
// Values travel in the POST body only (call() never builds a query string), so they stay out of
// the server's access logs. Error messages name keys and line numbers, never values.
// ---------------------------------------------------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILD_ONLY_MARK = '# build-only';

// Parse dotenv text into ordered maps. The rules match the server's import_env, so whatever `edit`
// accepts the server accepts too:
//   blank lines and # comments skipped, optional `export ` prefix, KEY=value;
//   'single quotes' are literal; "double quotes" understand \n, \" and \\ and may span lines;
//   unquoted values are trimmed, and a ` #` starts an inline comment.
// A `# build-only` comment line directly above a variable marks it build-only (used by `edit` and
// written by `export`; the server's import ignores it like any other comment).
// The last definition of a key wins. Throws on malformed input, naming the line, never a value.
function parseDotenv(text) {
  const vars = new Map();
  const buildOnly = new Set();
  const src = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  let marked = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const t = raw.trim();
    if (t === '') { marked = false; continue; }
    if (t.startsWith('#')) {
      marked = t.toLowerCase() === BUILD_ONLY_MARK;
      continue;
    }

    let rest = raw.replace(/^[ \t]+/, '');
    rest = rest.replace(/^export[ \t]+/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(rest);
    if (!m) throw new ApiError(`line ${lineNo}: expected KEY=value with a name made of letters, digits and _`);
    const key = m[1];
    rest = rest.slice(m[0].length).replace(/^[ \t]+/, '');

    let value;
    if (rest.startsWith('"')) {
      // Double quotes: walk character by character, possibly over several lines.
      let out = '';
      let j = 1;
      let buf = rest;
      let closed = false;
      for (;;) {
        if (j >= buf.length) {
          if (i + 1 >= lines.length) break;
          out += '\n';
          i++;
          buf = lines[i];
          j = 0;
          continue;
        }
        const c = buf[j];
        if (c === '\\' && j + 1 < buf.length) {
          const n = buf[j + 1];
          if (n === 'n') out += '\n';
          else if (n === '"') out += '"';
          else if (n === '\\') out += '\\';
          else out += '\\' + n;          // unknown escapes are kept as written
          j += 2;
          continue;
        }
        if (c === '"') { closed = true; j++; break; }
        out += c;
        j++;
      }
      if (!closed) throw new ApiError(`${key} (line ${lineNo}): the double quote is never closed`);
      const tail = buf.slice(j);
      if (tail.trim() !== '' && !tail.trim().startsWith('#')) {
        throw new ApiError(`${key} (line ${i + 1}): unexpected text after the closing quote`);
      }
      value = out;
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) throw new ApiError(`${key} (line ${lineNo}): the single quote is never closed on this line`);
      const tail = rest.slice(end + 1);
      if (tail.trim() !== '' && !tail.trim().startsWith('#')) {
        throw new ApiError(`${key} (line ${lineNo}): unexpected text after the closing quote`);
      }
      value = rest.slice(1, end);
    } else {
      const hash = rest.search(/[ \t]#/);
      value = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
    }

    vars.set(key, value);
    if (marked) buildOnly.add(key); else buildOnly.delete(key);
    marked = false;
  }
  return { vars, buildOnly };
}

// Always double-quoted, escaping exactly what parseDotenv (and the server) unescape, so the output
// of `export` imports back unchanged.
function quoteDotenv(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function serializeDotenv(vars, buildOnly) {
  let out = '';
  for (const [k, v] of vars) {
    if (buildOnly.has(k)) out += BUILD_ONLY_MARK + '\n';
    out += `${k}=${quoteDotenv(v)}\n`;
  }
  return out;
}

// list_env answers an array; turn it into the same shape parseDotenv returns.
function envFromList(data) {
  const vars = new Map();
  const buildOnly = new Set();
  for (const v of (data && data.vars) || []) {
    vars.set(v.name, v.value === undefined || v.value === null ? '' : String(v.value));
    if (Number(v.build_only)) buildOnly.add(v.name);
  }
  return { vars, buildOnly };
}

// Which project an env command is about. Positionals mix keys, files and the project, so:
//   --project NAME   always wins
//   otherwise the positional the subcommand leaves over (see cmdEnv), and
//   with none, the account's only project, when it has exactly one.
function envTarget(cfg, opts, typed, example) {
  const name = typeof opts.project === 'string' ? opts.project : typed;
  if (name) {
    const { profile, subject } = pick(cfg, opts, name);
    return { profile, project: subject, typed: name };
  }
  const { profile } = pick(cfg, opts, null);
  const sites = profile.sites || [];
  if (sites.length === 1) return { profile, project: sites[0].name, typed: sites[0].name };
  throw new ApiError(`which project? ${example}`);
}

// A positional that is not a shell-valid name, or that is exactly a known project or domain, is the
// project; anything else is a key. --project removes any doubt.
function looksLikeProject(cfg, a) {
  if (!ENV_NAME.test(a)) return true;
  return profileList(cfg).some((p) => (p.sites || []).some((s) => s.name === a || s.domain === a));
}

function warnSecretsOnTty() {
  if (process.stdout.isTTY) {
    console.error(`${PROG}: warning: printing secret values to the terminal. Redirect to a file instead, e.g. > .env.prod`);
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const a = await ask(question);
  return /^y(es)?$/i.test(a);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    throw new ApiError('could not read from standard input.');
  }
}

// What a write changed, by name only, then either the deploy or the hint to run one.
async function afterEnvWrite(out, profile, project, typed, opts) {
  if (wantJson()) console.log(JSON.stringify(out, null, 2));
  else {
    const o = out || {};
    const lines = [];
    for (const [label, list] of [['added', o.added], ['changed', o.changed], ['removed', o.removed]]) {
      if (list && list.length) lines.push(`  ${label.padEnd(8)} ${list.join(', ')}`);
    }
    if (lines.length) console.log(`${project}:\n${lines.join('\n')}`);
    else console.log(`${project}: nothing changed.`);
  }
  if (opts.deploy) {
    await startDeployment(profile, project);
  } else if (!wantJson()) {
    console.log(`Applied at the next deploy. Run: ${PROG} deploy ${typed}`);
  }
}

async function cmdEnv(args, opts) {
  const cfg = readConfig();
  const SUBS = ['list', 'ls', 'get', 'set', 'add', 'unset', 'rm', 'remove', 'import', 'export', 'edit', 'help'];
  const sub = SUBS.includes(args[0]) ? args.shift() : 'list';

  if (sub === 'help') return envUsage();

  if (sub === 'list' || sub === 'ls') {
    const { profile, project } = envTarget(cfg, opts, args[0], `${PROG} env <project>`);
    const reveal = !!opts.show;
    if (reveal) warnSecretsOnTty();
    const data = await call(profile, 'list_env', { project, reveal: reveal ? 1 : 0 });
    if (wantJson()) return console.log(JSON.stringify(data, null, 2));
    const vars = (data && data.vars) || [];
    const shown = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[\x00-\x1f"]/.test(s) ? quoteDotenv(s).replace(/\r/g, '\\r').replace(/\t/g, '\\t') : s;
    };
    table(vars.map((v) => {
      const row = [v.name, Number(v.set) ? 'set' : 'empty', Number(v.build_only) ? 'build-only' : 'build + app'];
      if (reveal) row.push(shown(v.value));
      return row;
    }), reveal ? ['NAME', 'STATUS', 'SCOPE', 'VALUE'] : ['NAME', 'STATUS', 'SCOPE']);
    return;
  }

  if (sub === 'get') {
    const key = need(args[0], `which variable? ${PROG} env get KEY [project]`);
    if (!ENV_NAME.test(key)) throw new ApiError(`"${key}" is not a valid variable name.`);
    const { profile, project } = envTarget(cfg, opts, args[1], `${PROG} env get ${key} <project>`);
    const data = await call(profile, 'list_env', { project, reveal: 1 });
    const hit = ((data && data.vars) || []).find((v) => v.name === key);
    if (!hit) throw new ApiError(`${key} is not defined on ${project}.`);
    const value = hit.value === undefined || hit.value === null ? '' : String(hit.value);
    // Raw bytes when piped or captured; a newline only to keep an interactive prompt tidy.
    process.stdout.write(process.stdout.isTTY ? value + '\n' : value);
    return;
  }

  if (sub === 'set' || sub === 'add') {
    const pairs = [];
    let typed;
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq > 0) pairs.push([a.slice(0, eq), a.slice(eq + 1)]);
      else if (typed === undefined && typeof opts.project !== 'string') typed = a;
      else throw new ApiError(`unexpected argument "${a}". Variables are given as KEY=VALUE.`);
    }
    if (!pairs.length) throw new ApiError(`nothing to set. ${PROG} env set KEY=VALUE [KEY=VALUE...] [project]`);
    for (const [k] of pairs) {
      if (!ENV_NAME.test(k)) throw new ApiError(`"${k}" is not a valid variable name (letters, digits and _, not starting with a digit).`);
    }

    // KEY=- keeps a secret out of shell history: from a pipe, or typed without echo on a terminal.
    const fromStdin = pairs.filter(([, v]) => v === '-');
    if (fromStdin.length > 1 && !process.stdin.isTTY) {
      throw new ApiError('only one KEY=- can read from a pipe. Set the others separately.');
    }
    const { profile, project, typed: label } = envTarget(cfg, opts, typed, `${PROG} env set KEY=VALUE <project>`);
    const vars = Object.create(null);   // __proto__ is a valid variable name
    for (const [k, v] of pairs) {
      if (v !== '-') { vars[k] = v; continue; }
      if (process.stdin.isTTY) vars[k] = await ask(`Value for ${k}: `, { silent: true });
      else vars[k] = readStdin().replace(/\r?\n$/, '');
    }
    const send = { project, vars: JSON.stringify(vars) };
    if (opts.build_only) {
      const flags = Object.create(null);
      for (const [k] of pairs) flags[k] = true;
      send.build_only = JSON.stringify(flags);
    }
    return afterEnvWrite(await call(profile, 'set_env', send), profile, project, label, opts);
  }

  if (sub === 'unset' || sub === 'rm' || sub === 'remove') {
    const names = [];
    let typed;
    for (const a of args) {
      if (typed === undefined && typeof opts.project !== 'string' && looksLikeProject(cfg, a)) typed = a;
      else if (ENV_NAME.test(a)) names.push(a);
      else throw new ApiError(`"${a}" is not a valid variable name.`);
    }
    if (!names.length) throw new ApiError(`which variable? ${PROG} env unset KEY [KEY...] [project]`);
    const { profile, project, typed: label } = envTarget(cfg, opts, typed, `${PROG} env unset ${names.join(' ')} --project <project>`);
    const out = await call(profile, 'set_env', { project, unset: JSON.stringify(names) });
    return afterEnvWrite(out, profile, project, label, opts);
  }

  if (sub === 'import') {
    const file = need(args[0], `which file? ${PROG} env import .env [project] [--replace]`);
    const { profile, project, typed: label } = envTarget(cfg, opts, args[1], `${PROG} env import ${file} <project>`);
    let text;
    if (file === '-') text = readStdin();
    else {
      try { text = fs.readFileSync(file, 'utf8'); } catch { throw new ApiError(`cannot read ${file}.`); }
    }
    // Parsed here too, so a malformed file is refused before anything is sent, and so a replace can
    // say how many variables are about to become the whole set.
    const parsed = parseDotenv(text);
    if (opts.replace && !opts.yes) {
      if (!process.stdin.isTTY) throw new ApiError('--replace removes every variable not in the file. Add --yes to confirm when not on a terminal.');
      const ok = await confirm(`Replace ALL variables of ${project} with the ${parsed.vars.size} in ${file}? Any other is removed. [y/N] `);
      if (!ok) return console.log('Nothing sent.');
    }
    const out = await call(profile, 'import_env', { project, text, mode: opts.replace ? 'replace' : 'merge' });
    return afterEnvWrite(out, profile, project, label, opts);
  }

  if (sub === 'export') {
    const { profile, project } = envTarget(cfg, opts, args[0], `${PROG} env export <project> > .env`);
    warnSecretsOnTty();
    const data = await call(profile, 'list_env', { project, reveal: 1 });
    const { vars, buildOnly } = envFromList(data);
    process.stdout.write(serializeDotenv(vars, buildOnly));
    return;
  }

  if (sub === 'edit') return envEdit(cfg, args, opts);
}

function editorCommand() {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
}

function runEditor(file) {
  const quoted = process.platform === 'win32' ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`;
  // Through the shell, because $EDITOR is often a command line of its own ("code --wait").
  const r = spawnSync(`${editorCommand()} ${quoted}`, { stdio: 'inherit', shell: true });
  if (r.error) throw new ApiError(`could not start the editor (${editorCommand()}). Set $EDITOR.`);
  if (r.status !== 0) throw new ApiError(`the editor exited with status ${r.status}; nothing sent.`);
}

// Compare two sets, by name. Values never appear in the result.
function envDiff(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  const flagged = [];
  for (const [k, v] of after.vars) {
    if (!before.vars.has(k)) added.push(k);
    else if (before.vars.get(k) !== v) changed.push(k);
    const was = before.vars.has(k) && before.buildOnly.has(k);
    const now = after.buildOnly.has(k);
    if (before.vars.has(k) && was !== now) flagged.push([k, now]);
  }
  for (const k of before.vars.keys()) if (!after.vars.has(k)) removed.push(k);
  return { added, changed, removed, flagged };
}

async function envEdit(cfg, args, opts) {
  const { profile, project, typed } = envTarget(cfg, opts, args[0], `${PROG} env edit <project>`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ApiError(`env edit needs a terminal. In a script, use: ${PROG} env set / env import`);
  }
  const before = envFromList(await call(profile, 'list_env', { project, reveal: 1 }));

  // A private directory (mkdtemp is 0700) holding a 0600 file: the values are in clear while the
  // editor is open, so nobody else on the machine may read them, and the finally removes both.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hodifly-env-'));
  const file = path.join(dir, `${String(project).replace(/[^A-Za-z0-9._-]/g, '_')}.env`);
  // A finally does not run when the process is killed, so a Ctrl-C or a closed terminal removes the
  // file too. While the editor runs these fire once it exits, which is when cleaning up is safe.
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };
  const onSignal = (sig) => { cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.once(sig, onSignal);
  try {
    const header =
      `# Environment variables of ${project}. Save and close the editor to review the changes.\n` +
      `# Delete a line to remove that variable. A "${BUILD_ONLY_MARK}" line directly above a\n` +
      `# variable keeps it out of the running app (visible to the build only).\n` +
      `# Values in double quotes understand \\n, \\" and \\\\. Changes apply at the next deploy.\n\n`;
    fs.writeFileSync(file, header + serializeDotenv(before.vars, before.buildOnly), { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }

    let after;
    for (;;) {
      runEditor(file);
      try {
        after = parseDotenv(fs.readFileSync(file, 'utf8'));
        const bad = [...after.vars.keys()].find((k) => !ENV_NAME.test(k));
        if (bad) throw new ApiError(`"${bad}" is not a valid variable name.`);
        break;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        console.error(`${PROG}: ${e.message}`);
        if (!(await confirm('Open the editor again? [y/N] '))) return console.log('Nothing sent.');
      }
    }

    const d = envDiff(before, after);
    if (!d.added.length && !d.changed.length && !d.removed.length && !d.flagged.length) {
      return console.log(`No change to ${project}. Nothing sent.`);
    }

    console.log(`Changes to ${project} (values not shown):`);
    for (const k of d.added) console.log(`  + ${k}${after.buildOnly.has(k) ? '  (build-only)' : ''}`);
    for (const k of d.changed) console.log(`  ~ ${k}  (value changed)`);
    for (const [k, now] of d.flagged) console.log(`  ~ ${k}  (${now ? 'now build-only' : 'no longer build-only'})`);
    for (const k of d.removed) console.log(`  - ${k}`);
    if (!opts.yes && !(await confirm('Apply? [y/N] '))) return console.log('Nothing sent.');

    const send = { project };
    const vars = Object.create(null);   // __proto__ is a valid variable name
    for (const k of [...d.added, ...d.changed]) vars[k] = after.vars.get(k);
    if (Object.keys(vars).length) send.vars = JSON.stringify(vars);
    if (d.removed.length) send.unset = JSON.stringify(d.removed);
    const flags = Object.create(null);
    for (const k of d.added) if (after.buildOnly.has(k)) flags[k] = true;
    for (const [k, now] of d.flagged) flags[k] = now;
    if (Object.keys(flags).length) send.build_only = JSON.stringify(flags);

    await afterEnvWrite(await call(profile, 'set_env', send), profile, project, typed, opts);
  } finally {
    cleanup();
    for (const sig of signals) process.removeListener(sig, onSignal);
  }
}

function envUsage() {
  console.log(`${PROG} env - the environment variables of a project

  ${PROG} env [project]                           names, set or empty, build-only marked (no values)
  ${PROG} env --show [project]                    the same, with the values
  ${PROG} env get KEY [project]                   the raw value only, for scripts
  ${PROG} env set KEY=VALUE [KEY=VALUE...] [project] [--build-only] [--deploy]
                                                  add or change; KEY=- reads that value from
                                                  standard input (keeps it out of shell history)
  ${PROG} env unset KEY [KEY...] [project] [--deploy]
  ${PROG} env import FILE [project] [--replace] [--deploy]
                                                  load a .env file (FILE - reads standard input);
                                                  merges, or --replace removes everything else
  ${PROG} env export [project] > .env.prod        dotenv on standard output, values double-quoted
  ${PROG} env edit [project] [--deploy]           open the variables in $VISUAL / $EDITOR, review
                                                  the changes, then apply them in one call

The variables are stored on the server, encrypted, and written into the app's .env on every
deploy, so a change applies at the next deploy (or right away with --deploy). Editing the .env
on the server by hand does not last: the next deploy rewrites it.

The project is the positional left over once keys and files are taken, or --project NAME. With a
single project on the account it can be omitted. A build-only variable is visible to the build
and kept out of the running app; in "edit" and "export" it carries a "${BUILD_ONLY_MARK}" line
directly above it.

--show, get and export print secret values: redirect them rather than leave them on screen.

Options:
  --project NAME   the project, when a positional could be read as a key
  --show           list values too
  --build-only     with set: mark these variables build-only
  --replace        with import: the file becomes the whole set
  --deploy         start a deployment once the change is saved
  --yes            skip the confirmation (edit, import --replace)
  --json           print the raw API response`);
}

// ---------------------------------------------------------------------------------------------
// databases
//
// `db create` does what anyone setting up an app needs in one go - database, user with a generated
// password, all privileges - through cPanel's own Mysql / Postgresql modules, with the same token.
// The rules match the Hodi MCP's create_database, so both name things the same way:
//   - the cPanel prefix (user_) is added when missing;
//   - with --project, the connection settings go straight into that project's environment
//     variables (DATABASE_URL, plus DB_* when the project is Laravel) and are never printed;
//   - without it, the .env lines go to stdout (so `>> .env` works) and the rest to stderr.
// Nothing here deletes: a database is removed in cPanel, where the consequences are visible.
// ---------------------------------------------------------------------------------------------

const DB_ENGINES = {
  mysql:      { module: 'Mysql',      port: 3306, scheme: 'mysql',      connection: 'mysql' },
  postgresql: { module: 'Postgresql', port: 5432, scheme: 'postgresql', connection: 'pgsql' },
};

function dbEngine(v) {
  const e = String(v || 'mysql').toLowerCase();
  const name = { mysql: 'mysql', mariadb: 'mysql', postgresql: 'postgresql', postgres: 'postgresql', pg: 'postgresql', pgsql: 'postgresql' }[e];
  if (!name) throw new ApiError(`--engine is mysql or postgresql, not "${v}".`);
  return name;
}

// 24 characters from an alphabet that needs no escaping in a URL, a shell or a .env file.
function dbPassword() {
  const { randomInt } = require('crypto');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function dbPrefixed(name, prefix) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n.startsWith(prefix) ? n : prefix + n;
}

// The project, looked up BEFORE anything is created: a typo there must not leave an orphan
// database behind. Names are not unique on an account (several projects can deploy one repo), so a
// name carried by two projects is refused and the ids are shown.
async function dbProject(profile, subject) {
  const list = (await call(profile, 'list_projects')) || [];
  const hits = list.filter((p) => p.id === subject || p.name === subject);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new ApiError(`no project "${subject}" on ${profile.name}. Run: ${PROG} projects`);
  throw new ApiError(`${hits.length} projects are called "${subject}". Give the id instead:\n` +
    hits.map((p) => `  ${p.id}  ${p.domain || ''}${p.base_dir && p.base_dir !== '.' ? ' (' + p.base_dir + ')' : ''}`).join('\n'));
}

async function cmdDb(args, opts) {
  const cfg = readConfig();
  const SUBS = ['list', 'ls', 'create', 'add', 'new', 'help'];
  const sub = SUBS.includes(args[0]) ? args.shift() : 'list';
  if (sub === 'help') return dbUsage();

  if (sub === 'list' || sub === 'ls') {
    const { profile } = pick(cfg, opts, null, { asProject: false });
    const out = {};
    const rows = [];
    for (const [engine, e] of Object.entries(DB_ENGINES)) {
      try {
        out[engine] = (await call(profile, 'list_databases', {}, e.module)) || [];
      } catch {
        out[engine] = null;               // engine not offered on this account
        continue;
      }
      for (const d of out[engine]) rows.push([d.database, engine, (d.users || []).join(', ') || '-']);
    }
    if (wantJson()) return console.log(JSON.stringify(out, null, 2));
    if (!rows.length) return console.log('No databases on this account.');
    return table(rows, ['DATABASE', 'ENGINE', 'USERS']);
  }

  // create
  const name = need(args[0], `which name? ${PROG} db create NAME [--engine postgresql] [--project P]`);
  const engine = dbEngine(opts.engine);
  const e = DB_ENGINES[engine];
  const projectArg = typeof opts.project === 'string' ? opts.project : args[1];
  let profile;
  let project = null;
  if (projectArg) {
    const r = pick(cfg, opts, projectArg);
    profile = r.profile;
    project = await dbProject(profile, r.subject);
  } else {
    profile = pick(cfg, opts, null, { asProject: false }).profile;
  }

  let restr = {};
  try { restr = (await call(profile, 'get_restrictions', {}, e.module)) || {}; } catch (err) {
    throw new ApiError(`${engine} is not available on ${profile.name}: ${err.message}`);
  }
  const prefix = restr.prefix || `${profile.user}_`;
  const db = dbPrefixed(name, prefix);
  const user = dbPrefixed(typeof opts.user === 'string' ? opts.user : name, prefix);
  const maxDb = Number(restr.max_database_name_length) || 64;
  const maxUser = Number(restr.max_username_length) || (engine === 'mysql' ? 47 : 63);
  if (!/^[a-z0-9_]+$/.test(db) || db.length > maxDb) {
    throw new ApiError(`"${db}" is not a valid database name: lower-case letters, digits and _, ${maxDb} characters at most with the prefix.`);
  }
  if (!/^[a-z0-9_]+$/.test(user) || user.length > maxUser) {
    throw new ApiError(`"${user}" is not a valid user name: lower-case letters, digits and _, ${maxUser} characters at most with the prefix.`);
  }

  const password = dbPassword();
  await call(profile, 'create_database', { name: db }, e.module);
  const done = ['database'];
  try {
    await call(profile, 'create_user', { name: user, password }, e.module);
    done.push('user');
    if (engine === 'mysql') {
      await call(profile, 'set_privileges_on_database', { user, database: db, privileges: 'ALL PRIVILEGES' }, e.module);
    } else {
      await call(profile, 'grant_all_privileges', { user, database: db }, e.module);
    }
    done.push('privileges');
  } catch (err) {
    // Say what exists rather than deleting it: the next step can be finished in cPanel.
    throw new ApiError(`stopped after creating: ${done.join(', ')} (${db}). Finish in cPanel. ${err.message}`);
  }

  const url = `${e.scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${e.port}/${encodeURIComponent(db)}`;
  const env = { DATABASE_URL: url };
  const laravel = /laravel/i.test(`${(project && project.framework) || ''} ${(project && project.runtime) || ''}`);
  if (!project || laravel) {
    Object.assign(env, {
      DB_CONNECTION: e.connection, DB_HOST: 'localhost', DB_PORT: String(e.port),
      DB_DATABASE: db, DB_USERNAME: user, DB_PASSWORD: password,
    });
  }

  if (project) {
    console.error(`Created ${engine} database ${db}, user ${user}, all privileges.`);
    const out = await call(profile, 'set_env', { project: project.id, vars: JSON.stringify(env) });
    return afterEnvWrite(out, profile, project.id, projectArg, opts);
  }

  if (wantJson()) {
    return console.log(JSON.stringify({ engine, host: 'localhost', port: e.port, database: db, user, password, env }, null, 2));
  }
  console.error(`Created ${engine} database ${db}, user ${user}, all privileges.`);
  console.error('The password is shown once, below. Keep it in your .env, not in your shell history.');
  process.stdout.write(Object.entries(env).map(([k, v]) => `${k}=${quoteDotenv(v)}`).join('\n') + '\n');
}

function dbUsage() {
  console.log(`${PROG} db - MySQL and PostgreSQL databases of the account

  ${PROG} db                                       list them, with their users
  ${PROG} db create NAME [--engine postgresql]      database + user + all privileges
  ${PROG} db create NAME --project P [--deploy]     ...and put the settings into project P

The cPanel prefix (user_) is added when missing. The password is generated (24 characters).
With --project, DATABASE_URL (plus DB_* for Laravel) goes straight into the project's environment
variables and is never printed. Without it, the .env lines are printed on stdout, so
  ${PROG} db create shop >> .env
keeps them in a file. Nothing here deletes: remove a database in cPanel.

Options:
  --engine E      mysql (default) or postgresql
  --user U        the user name, when it should differ from the database name
  --project P     the Hodifly project to receive the settings
  --deploy        with --project: deploy once the settings are saved
  --json          print everything as JSON (the password included)`);
}

function need(v, msg) {
  if (!v) throw new ApiError(msg);
  return v;
}

// ---------------------------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------------------------

// --flag value, or --flag on its own for a switch. Dashes become underscores, so --root-directory
// arrives as root_directory: the name the API uses. The SWITCHES never take a value, so a
// positional after them stays a positional (`env --show my-site`, `ls --prod my-site`).
const SWITCHES = new Set(['show', 'build_only', 'deploy', 'replace', 'yes', 'prod', 'production']);

function parse(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
      if (SWITCHES.has(key)) { opts[key] = true; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; } else { opts[key] = true; }
    } else {
      args.push(a);
    }
  }
  return { args, opts };
}

function usage() {
  console.log(`${PROG} ${VERSION} - deploy from git on cPanel

  ${PROG} login                                sign in to a cPanel account and save it
  ${PROG} profiles                             list the accounts you are signed in to
  ${PROG} use <profile>                        choose the default account
  ${PROG} refresh                              re-read which projects and domains each account has
  ${PROG} logout [profile]                     forget an account

  ${PROG} projects                             list your projects and their status
  ${PROG} projects add --repo O/R --domain D   set up a new project from a repository
  ${PROG} projects set <project> --startup F   change settings on an existing project
  ${PROG} deploy <project>                     build and publish the current branch head
  ${PROG} ls <project> [--prod]                list deployments, newest first
  ${PROG} rollback <project> <deployment>      re-point the site at an earlier deployment
  ${PROG} logs <project> [deployment]          build output (defaults to the newest deployment)
  ${PROG} remove <project>                     delete the project (files on disk are kept)

  ${PROG} env [project] [--show]               the project's environment variables
  ${PROG} env set KEY=VALUE [project]          add or change one (KEY=- reads it from stdin)
  ${PROG} env unset KEY [project]              remove one
  ${PROG} env edit [project]                   edit them all in $EDITOR, review, apply
  ${PROG} env import FILE | export [project]   load or write a .env file
                                               (${PROG} env --help for the details)

  ${PROG} db                                   MySQL and PostgreSQL databases of the account
  ${PROG} db create NAME [--project P]         database + user + privileges, settings into P
                                               (${PROG} db --help for the details)

<project> is a project name or its id. With several accounts signed in, the project or domain name
picks the right server on its own; add --profile <name> when you want to be explicit.

Options for "projects add", named as Vercel names them:
  --repo O/R            the git repository                       (required)
  --domain D            the domain on your account to publish to (required)
  --directory D         subfolder under that domain, e.g. blog
  --branch B            branch to deploy      (default: the repository's own)
  --root-directory D    folder to build from in a monorepo
  --build-command CMD   build command
  --output-directory D  static sites: the folder the build writes into
  --framework F         framework, when detection should not decide
  --runtime R           node:22, php:8.3, python:3.12, ruby:3.3, none
  --mode M              static | node | python | php | ruby
  --docroot DIR         php: the front-controller folder (public)
  --startup FILE        node/python: the entry file Passenger runs (server.js, dist/main.js)
  --previews            build a preview URL for each pull request
  --rebuild-every N     also rebuild on a timer: 0, 60, 1440, 10080 (minutes)

"projects set" takes the same settings, plus --autodeploy, --notify-success, --notify-failed,
--notify-email and --persist. Only what you name changes; everything else stays as it is. Give a
switch a value to turn it off (--previews 0), and an empty value to clear a field
(--build-command ""). The domain, the folder on the account and the repository cannot be changed
here: those belong to the installation, and a repository on a second domain is a second project.
A repo that carries a hodifly.json is simpler still - what it declares wins on every deploy.

Global:
  --profile NAME        act on that account
  --json                print the raw API response
  --help, --version

Accounts live in ${CONFIG_FILE} (owner-only). HODIFLY_HOST, HODIFLY_USER and HODIFLY_TOKEN
override it for a single command.`);
}

const COMMANDS = {
  login: cmdLogin, logout: cmdLogout, profiles: cmdProfiles, whoami: cmdProfiles,
  use: cmdUse, refresh: cmdRefresh,
  projects: cmdProjects, project: cmdProjects, create: cmdCreate, new: cmdCreate,
  deploy: cmdDeploy, redeploy: cmdDeploy,
  ls: cmdLs, list: cmdLs, deployments: cmdLs,
  rollback: cmdRollback,
  logs: cmdLogs, log: cmdLogs,
  remove: cmdRemove, rm: cmdRemove, delete: cmdRemove,
  env: cmdEnv,
  db: cmdDb, database: cmdDb, databases: cmdDb,
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'env' && (argv.includes('--help') || argv.includes('-h'))) return envUsage();
  if (/^(db|databases?)$/.test(argv[0] || '') && (argv.includes('--help') || argv.includes('-h'))) return dbUsage();
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) return usage();
  if (argv.includes('--version')) return console.log(`${PROG} ${VERSION}`);

  const { args, opts } = parse(argv);
  const cmd = args.shift();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`${PROG}: unknown command "${cmd}"`);
    console.error(`Try '${PROG} --help'.`);
    process.exit(2);
  }
  await fn(args, opts);
}

main().catch((e) => {
  console.error(`${PROG}: ${e instanceof ApiError ? e.message : (e && e.stack) || e}`);
  process.exit(1);
});
