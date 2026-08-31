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

const VERSION = '1.1.0';
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

async function call(profile, fn, args = {}) {
  const url = `https://${profile.host}:2083/execute/Hodifly/${fn}`;
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
    throw new ApiError(`${profile.host} has no Hodifly API. Is Hodifly installed on that server?`);
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

function need(v, msg) {
  if (!v) throw new ApiError(msg);
  return v;
}

// ---------------------------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------------------------

// --flag value, or --flag on its own for a switch. Dashes become underscores, so --root-directory
// arrives as root_directory: the name the API uses.
function parse(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
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
};

async function main() {
  const argv = process.argv.slice(2);
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
