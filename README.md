# hodifly

Deploy from git on cPanel, from your own machine.

`hodifly` is the command line for [Hodifly](https://hodifly.app): connect a repository, and every push
builds and publishes to your cPanel hosting. This tool drives the same thing from a terminal, a
script, or CI.

One file, no dependencies, Node 18+. macOS, Linux and Windows.

## Install

Use whichever package manager you already have:

- `pnpm add -g hodifly`
- `npm i -g hodifly`
- `yarn global add hodifly`.

## Sign in

Open **Hodifly → API** in cPanel and press *Create an API token*. It hands you a complete command:

```
hodifly login --host server.example.com --user myaccount --token ...
```

Or run `hodifly login` with no arguments and it asks for the three values, reading the token without
echoing it.

Credentials are stored in `~/.hodifly/config.json`, readable only by you. The token is an ordinary
cPanel API token carrying your own privileges: revoke it any time under **Manage API Tokens**.

## Use

```
hodifly projects                       # what you have, and how the last build went
hodifly deploy my-site                 # build and publish the current branch head
hodifly ls my-site --prod              # the deployments you could roll back to
hodifly rollback my-site <deployment>  # instant: the release is already on disk
hodifly logs my-site                   # build output, newest deployment by default
hodifly remove my-site                 # forget the project (files on disk are kept)
```

Create a project from a repository:

```
hodifly projects add \
  --repo my-org/my-site \
  --domain example.com \
  --build-command "npm run build" \
  --output-directory dist
```

Change a setting on a project that already exists:

```
hodifly projects set my-api --startup dist/main.js   # the file Passenger boots (NestJS builds here)
hodifly projects set my-site --build-command ""      # an empty value clears a field
hodifly projects set my-site --previews 0            # a value turns a switch off
```

It is a patch: only what you name changes, and nothing is built until the next deploy. The domain,
the folder on the account and the repository are not editable here, because those belong to the
installation rather than to the project - a repository published to a second domain is a second
project. A repository carrying a `hodifly.json` needs none of this: what that file declares wins on
every deploy.

`hodifly --help` lists every option. They are named the way Vercel names them: `--build-command`,
`--output-directory`, `--root-directory`, `--framework`.

## More than one account

Hosting accounts live on different servers, so `hodifly login` remembers each one as a profile and
records which projects and domains it serves. After that you name the site, not the server:

```
hodifly deploy blog.example.com    # finds the account, and the project on that domain
hodifly profiles                   # the accounts you are signed in to
hodifly use work                   # pick the default
hodifly refresh                    # re-read what each account has
```

A name that exists on two accounts is never guessed at: you are told, and asked to add
`--profile <name>`.

## Scripting

`--json` prints the raw API response for any command. Every command is one call to the
`Cpanel::API::Hodifly` UAPI module on your server, so anything here can be done with plain HTTP:

```
curl -H "Authorization: cpanel USER:TOKEN" \
  --data-urlencode "project=my-site" \
  https://server.example.com:2083/execute/Hodifly/create_deployment
```

| Command | UAPI function |
| --- | --- |
| `projects` | `list_projects` |
| `projects add` | `create_project` |
| `projects set` | `update_project` |
| `deploy` | `create_deployment` |
| `ls` | `list_deployments` |
| `rollback` | `rollback_deployment` |
| `logs` | `get_deployment_logs` |
| `remove` | `delete_project` |

## Environment

| Variable | Effect |
| --- | --- |
| `HODIFLY_HOST`, `HODIFLY_USER`, `HODIFLY_TOKEN` | Use these credentials for one command, ignoring saved profiles |
| `HODIFLY_PROFILE` | Use that saved profile |
| `HODIFLY_CONFIG_DIR` | Where profiles live (default `~/.hodifly`) |
| `HODIFLY_INSECURE=1` | Accept a cPanel server whose TLS certificate does not validate |

## Requirements

Node 18 or newer, and a cPanel server running Hodifly. The API listens on port 2083, so a network
that blocks it will block this too.

## Licence

MIT
