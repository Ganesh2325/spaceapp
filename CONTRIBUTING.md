# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network; the smoke command below does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Run the full app from source

`npm run dev:stack` starts a contributor copy of the product from this checkout.
It does not use an installed SpaceApp, its ports, its database, or its dev-login
shortcut.

Prerequisites, in addition to the Node and npm versions above:

- Docker, with `docker compose` usable without an interactive password prompt.
  On macOS use Docker Desktop or Colima. On Windows 11 use Docker Desktop's
  WSL2 engine and run these commands inside the WSL2 distro, not from PowerShell.
  The stack uses Unix sockets and a PTY, so a native Windows shell is not enough.
- A local checkout with `npm ci` already finished. The first run pulls the
  pinned PostgreSQL and Temporal images and installs the OpenCode version
  pinned in the Dockerfile. Those steps need the network. Later runs reuse them.
- `stty` on `PATH` (`/usr/bin/stty`). It is part of a normal Linux install and of
  Docker Desktop's utility image on macOS.

```sh
npm run dev:stack
npm run dev:stack -- down
npm run dev:stack -- reset
npm run dev:stack -- rebuild
```

`dev:stack` starts PostgreSQL and Temporal, applies migrations, then runs the
API, the Vite app, the Temporal worker, and the CLI host from this tree. While
the owner still needs to be created it prints the web URL and a one-time setup
token. Open that URL, create the owner with the token, and sign in. The token
is not printed again after the owner exists. `down` stops the processes and
containers and keeps the data. `reset` removes only the containers, volumes,
and state directory this command created.

Everything for this command lives under `.dev-stack/` (override with
`SPACE_DEV_STACK_STATE_DIR` or `--state-dir`). That directory is gitignored.
Docker uses a compose project named `spaceapp-` plus ten hex characters of
the checkout path, and the image digests in
`packages/run-spaceapp/templates/compose.yml`. Two checkouts therefore do not
share a volume. Secrets are created in `.dev-stack/secrets/` with mode `0600`.
The database password and session secret stay there. Only the setup token is
written to the terminal. The API, worker, and CLI host get a small environment
with `HOME` under `.dev-stack/home`, not your own home directory.

Ports bind to `127.0.0.1` and stay off the installed app's `4910`, `4911`, and
OpenCode port `47047`.

On macOS, `node-pty` starts each CLI pane by `posix_spawn` of `spawn-helper`
next to its native module. The file published in the npm package is mode
`0644`, so that spawn fails with `posix_spawnp failed.` and the OpenCode pane
stays idle. `dev:stack` sets the helper to mode `0755` before it starts the
CLI host, and clears a download quarantine attribute when one is present.

| Service   | Default | Override                         |
| --------- | ------- | -------------------------------- |
| Web       | 5911    | `SPACE_DEV_STACK_WEB_PORT`       |
| API       | 5910    | `SPACE_DEV_STACK_API_PORT`       |
| Postgres  | 55432   | `SPACE_DEV_STACK_POSTGRES_PORT`  |
| Temporal  | 57233   | `SPACE_DEV_STACK_TEMPORAL_PORT`  |
| OpenCode  | 54747   | `SPACE_DEV_STACK_OPENCODE_PORT`  |

Saving a file under `apps/api/src` restarts the API. Saving a file under
`apps/web/src` updates the browser through Vite. After a change under
`packages/*`, run `npm run dev:stack -- rebuild`. That rebuilds the workspace
packages and restarts the CLI host, API, worker, and web app.

Browser panes and the companion services stay off, and the UI says so. The
Getting Started room's OpenCode pane is the one CLI this command installs. The
binary is under `.dev-stack/tools/`, not on the system `PATH`.

Troubleshooting:

- `Docker Compose is required` means the daemon is stopped or `docker info`
  failed for your user. Start Docker Desktop, or `colima start` on macOS, then
  retry. This command does not use `sudo`.
- A port already in use fails the process that wanted it. Set the matching
  `SPACE_DEV_STACK_*_PORT` variable. Do not point this stack at `4910` or `4911`
  while an installed copy is running.
- `CLI host socket path is too long` means the state directory is too deep for
  a Unix socket. The fallback directory is `$TMPDIR/spaceapp-` plus the same
  checkout hash, so one checkout's reset does not remove another's socket.
  Export a short `TMPDIR` and start again.
- If the API, worker, web app, or CLI host exits, the supervisor prints
  `dev-stack: <name> exited unexpectedly` and shuts the rest down. The log path
  is on that line, under `.dev-stack/logs/`. Fix the cause and run `dev:stack`
  again. `reset` if you want a new database and a new setup token.
- OpenCode needs outbound network access the first time its pane starts. No
  provider account is required to reach its terminal UI. If the pane says
  OpenCode did not start, run `reset` and open the pane again.
- `npm run dev:api` is a different, older shortcut. It turns on dev-login. This
  stack does not.

## Make and verify a small change

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Checks before a commit

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.

## License of contributions

SpaceApp is licensed under the [MIT License](LICENSE). Contributions are
accepted under the same license (inbound = outbound): by submitting a
contribution you license it to everyone under the MIT License. You keep the
copyright of your contribution.

Every commit must carry a `Signed-off-by:` line with your real name and email,
which certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under the MIT
License. `git commit -s` adds the line. There is no separate contributor
license agreement.
