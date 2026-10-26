#!/usr/bin/env node
// One command for a contributor checkout: Postgres and Temporal in Docker, then the
// API, web, worker and CLI host from this tree. State stays under .dev-stack/.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "..");

export const COMPOSE_PROJECT = "spaceapp-devstack";
export const STATE_MARKER = "spaceapp-dev-stack";
export const TEMPORAL_NAMESPACE = "spaceapp-dev";
export const TEMPORAL_TASK_QUEUE = "spaceapp-dev-agent-turns";
export const DATABASE_NAME = "spaceapp";
export const DATABASE_USER = "spaceapp";

export const DEFAULT_PORTS = {
  api: 5910,
  web: 5911,
  postgres: 55432,
  temporal: 57233
};

const INSTALLED_API_PORT = 4910;
const INSTALLED_WEB_PORT = 4911;
const SOCKET_PATH_LIMIT = 100;

const PACKAGE_BUILD_ORDER = [
  "@space/contracts",
  "@space/icons",
  "@space/streaming",
  "@space/opencode-control",
  "@space/memory-graph",
  "@space/browser-host",
  "@space/cli-host",
  "@space/codex-app-server",
  "@space/runtime",
  "@space/db",
  "@space/gateway"
];

const COMPOSE_TEMPLATE = join(repoRoot, "packages/run-spaceapp/templates/compose.yml");
const DOCKERFILE = join(repoRoot, "Dockerfile");

export function parseComposeImages(text) {
  const images = {};
  let service = null;
  for (const line of text.split(/\r?\n/)) {
    const serviceMatch = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (serviceMatch) {
      service = serviceMatch[1];
      continue;
    }
    if (!service || !line.startsWith(" ".repeat(4))) continue;
    const imageMatch = line.match(/^ {4}image:\s*(\S+)\s*$/);
    if (!imageMatch) continue;
    images[service] = imageMatch[1];
  }
  const postgres = images.postgres;
  const temporal = images.temporal;
  const digest = /@sha256:[a-f0-9]{64}$/;
  if (!postgres || !digest.test(postgres)) {
    throw new Error("packages/run-spaceapp/templates/compose.yml must pin the postgres image with a sha256 digest.");
  }
  if (!temporal || !digest.test(temporal)) {
    throw new Error("packages/run-spaceapp/templates/compose.yml must pin the temporal image with a sha256 digest.");
  }
  return { postgres, temporal };
}

export function parseOpenCodePackage(text) {
  const match = text.match(/(?:opencode-ai|@opencode\/cli)@\d+\.\d+\.\d+/);
  if (!match) {
    throw new Error("Dockerfile must pin opencode-ai or @opencode/cli with an exact version.");
  }
  return match[0];
}

export function resolvePorts(env = process.env) {
  const ports = {
    api: portFrom(env.SPACE_DEV_STACK_API_PORT, DEFAULT_PORTS.api, "SPACE_DEV_STACK_API_PORT"),
    web: portFrom(env.SPACE_DEV_STACK_WEB_PORT, DEFAULT_PORTS.web, "SPACE_DEV_STACK_WEB_PORT"),
    postgres: portFrom(env.SPACE_DEV_STACK_POSTGRES_PORT, DEFAULT_PORTS.postgres, "SPACE_DEV_STACK_POSTGRES_PORT"),
    temporal: portFrom(env.SPACE_DEV_STACK_TEMPORAL_PORT, DEFAULT_PORTS.temporal, "SPACE_DEV_STACK_TEMPORAL_PORT")
  };
  const values = Object.values(ports);
  if (new Set(values).size !== values.length) {
    throw new Error("Dev-stack ports must be unique.");
  }
  if (!env.SPACE_DEV_STACK_API_PORT && ports.api === INSTALLED_API_PORT) {
    throw new Error("The dev stack API port must not default to the installed app's 4910.");
  }
  if (!env.SPACE_DEV_STACK_WEB_PORT && ports.web === INSTALLED_WEB_PORT) {
    throw new Error("The dev stack web port must not default to the installed app's 4911.");
  }
  return ports;
}

function portFrom(raw, fallback, name) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer port.`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`${name} must be between 1 and 65535.`);
  return port;
}

export function stateDirPathProblems(stateDir, root = repoRoot, home = homedir()) {
  const resolved = resolve(stateDir);
  const problems = [];
  const forbidden = [resolve("/"), resolve(home), resolve(root), resolve(root, "..")];
  if (forbidden.includes(resolved)) problems.push(`Refusing to use ${resolved} as the dev-stack state directory.`);
  const repo = resolve(root);
  if (repo === resolved || repo.startsWith(`${resolved}${sep}`)) {
    problems.push("The state directory must not contain the checkout.");
  }
  const rel = relative(repo, resolved);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (insideRepo && rel !== ".dev-stack" && !rel.startsWith(`.dev-stack${sep}`)) {
    problems.push("Inside the checkout, dev-stack state must live in .dev-stack/.");
  }
  return problems;
}

export function assertSafeStateDir(stateDir, root = repoRoot) {
  const problems = stateDirPathProblems(stateDir, root);
  if (problems.length) throw new Error(problems.join(" "));
  return resolve(stateDir);
}

export function renderCompose({ images, ports, project = COMPOSE_PROJECT }) {
  if (project !== COMPOSE_PROJECT && !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(project)) {
    throw new Error("Compose project name must be a short lowercase token.");
  }
  return `name: ${project}
services:
  postgres:
    image: ${images.postgres}
    restart: "no"
    environment:
      POSTGRES_DB: ${DATABASE_NAME}
      POSTGRES_USER: ${DATABASE_USER}
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    ports:
      - "127.0.0.1:${ports.postgres}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DATABASE_USER} -d ${DATABASE_NAME}"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 10s
  temporal:
    image: ${images.temporal}
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: "5432"
      POSTGRES_USER: ${DATABASE_USER}
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    # The image user is uid 1000. A host secret of mode 0600 is readable there
    # only when the host user is also uid 1000. GitHub-hosted runners are uid
    # 1001, so cat fails and the server exits 1. Read it as root, then drop.
    user: root
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - |
        set -eu
        cp /run/secrets/postgres-password /tmp/postgres-password
        chown temporal:temporal /tmp/postgres-password
        chmod 0400 /tmp/postgres-password
        export POSTGRES_PWD="$$(cat /tmp/postgres-password)"
        rm -f /tmp/postgres-password
        exec su temporal -c 'exec /etc/temporal/entrypoint.sh autosetup'
    ports:
      - "127.0.0.1:${ports.temporal}:7233"
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 10s
      timeout: 10s
      retries: 30
      start_period: 20s
secrets:
  postgres-password:
    file: ./secrets/postgres-password
volumes:
  postgres-data:
`;
}

export function renderOpenCodeWrapper({ stateDir, repo, packageSpec }) {
  const root = resolve(stateDir);
  const source = resolve(repo);
  return `#!/usr/bin/env bash
# Generated by scripts/dev-stack.mjs for ${packageSpec}. Provider state stays in this dev stack.
set -euo pipefail
STATE="${root}"
REPO="${source}"
BIN="$STATE/tools/opencode/node_modules/.bin"
export PATH="$BIN:$PATH"
PROVIDER="$STATE/cli-state/providers/opencode"
export HOME="$PROVIDER"
export TMPDIR="$PROVIDER/tmp"
export XDG_CONFIG_HOME="$PROVIDER/config"
export XDG_DATA_HOME="$PROVIDER/data"
export XDG_CACHE_HOME="$PROVIDER/cache"
export XDG_STATE_HOME="$PROVIDER/state"
export OPENCODE_DISABLE_AUTOUPDATE=true
export USER="\${USER:-$(id -un 2>/dev/null || echo spaceapp)}"
export LOGNAME="$USER"
umask 077
mkdir -p "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
chmod 700 "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

if ! command -v opencode >/dev/null 2>&1; then
  echo "OpenCode is not installed in the dev-stack state directory." >&2
  exit 69
fi

case "\${1:-}" in
  credential-status)
    printf 'READY\\n'
    exit 0
    ;;
  credential-observation)
    hash=$(printf '%s' 'opencode:ready' | (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}')
    printf 'OBSERVATION:%s\\n' "$hash"
    exit 0
    ;;
  credential-smoke)
    if ! node "$REPO/deploy/docker/opencode-first-run.mjs"; then
      echo "OpenCode's free-model check did not succeed. OpenCode starts anyway." >&2
    fi
    printf 'SPACE_OPENCODE_OK\\n'
    exit 0
    ;;
  --help|-h|--version|-v)
    exec opencode "$@"
    ;;
esac

if ! node "$REPO/deploy/docker/opencode-first-run.mjs"; then
  echo "SpaceApp could not confirm a working free OpenCode model right now. OpenCode starts anyway: choose a model with /models, or reopen this pane later." >&2
fi

server_url=""
while IFS='=' read -r key value; do
  case "$key" in
    OPENCODE_SERVER_URL) server_url="$value" ;;
    OPENCODE_SERVER_USERNAME) export OPENCODE_SERVER_USERNAME="$value" ;;
    OPENCODE_SERVER_PASSWORD) export OPENCODE_SERVER_PASSWORD="$value" ;;
  esac
done < <(node "$REPO/deploy/docker/opencode-shared-server.mjs" || true)
if [ -z "$server_url" ]; then
  echo "SpaceApp could not start OpenCode. Reopen this pane." >&2
  exit 69
fi
exec opencode --server "$server_url" "$@" "$PWD"
`;
}

export function parseProcStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  if (rest.length < 20) return null;
  return {
    comm: text.slice(open + 1, close),
    state: rest[0],
    pgrp: Number(rest[2]),
    starttime: rest[19]
  };
}

export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "linux") {
      const parsed = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
      if (!parsed?.starttime) return null;
      return { pid, starttime: parsed.starttime, platform: "linux" };
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFile("ps", ["-o", "lstart=", "-p", String(pid)]);
      const start = stdout.trim();
      if (!start) return null;
      return { pid, starttime: start, platform: "darwin" };
    }
  } catch {
    return null;
  }
  return { pid, starttime: null, platform: process.platform };
}

export async function processIdentityMatches(record) {
  if (!record?.pid) return false;
  const current = await readProcessIdentity(record.pid);
  if (!current) return false;
  if (record.starttime && current.starttime && record.starttime !== current.starttime) return false;
  return true;
}

export function failureLine(name, code, signal, logPath) {
  const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  return `dev-stack: ${name} exited unexpectedly (${how}). See ${logPath}\ndev-stack: shutting the stack down so nothing is left half-running.`;
}

export function bindChildFailure(records, onFailure) {
  for (const record of records) {
    record.child.once("exit", (code, signal) => {
      if (record.child.expectedExit) return;
      record.child.expectedExit = true;
      onFailure(failureLine(record.name, code, signal, record.logPath), record);
    });
  }
}

export function pullFailureIsTransient(message) {
  return /timeout|deadline exceeded|toomanyrequests|TLS handshake|connection reset|unexpected EOF|temporarily unavailable|i\/o timeout|Client\.Timeout/i.test(message);
}

export function scrubSecrets(text, secrets = []) {
  let next = String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]")
    .replace(/(setup token[^\n]*\n\s*)(\S+)/gi, "$1[redacted]");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) next = next.split(secret).join("[redacted]");
  }
  return next;
}

export function cwdBelongsToState(stateDir, cwd) {
  if (!cwd) return false;
  const root = resolve(stateDir);
  const current = resolve(cwd);
  return current === root || current.startsWith(`${root}${sep}`);
}

export function executableBelongsToState(stateDir, executable) {
  if (!executable) return false;
  const cleaned = executable.replace(/ \(deleted\)$/, "");
  const prefix = `${join(resolve(stateDir), "tools", "opencode")}${sep}`;
  return resolve(cleaned).startsWith(prefix);
}

/** Env vars whose config.ts fallback is an installed-product path. */
export function installedPathFallbacks(configSource) {
  const keys = new Set();
  for (const line of configSource.split(/\r?\n/)) {
    if (!line.includes("/opt/spaceapp") && !line.includes("/var/lib/spaceapp")) continue;
    for (const match of line.matchAll(/\b(?:env|valid)\.(SPACE_[A-Z0-9_]+)/g)) keys.add(match[1]);
  }
  return [...keys].sort();
}

export function devProcessEnv({ stateDir, ports, databaseUrl, sessionSecret, repo = repoRoot }) {
  const root = resolve(stateDir);
  const varRoot = join(root, "var");
  const env = { ...process.env };
  delete env.SPACE_DEV_LOGIN;
  const socketPath = chooseSocketPath(root);
  const overrides = {
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    SPACE_DEV_LOGIN: "false",
    SPACE_INSTANCE: "dev",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_SESSION_SECRET: sessionSecret,
    SPACE_SETUP_TOKEN_FILE: join(root, "secrets", "setup-token"),
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(ports.api),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(ports.web),
    SPACE_API_ORIGIN: `http://127.0.0.1:${ports.api}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: TEMPORAL_NAMESPACE,
    SPACE_TEMPORAL_TASK_QUEUE: TEMPORAL_TASK_QUEUE,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_CLI_COMMAND_PATH: join(root, "bin"),
    SPACE_CLI_OPENCODE_COMMAND: "opencode-vscode-parity",
    SPACE_CLI_HOST_SOCKET: socketPath,
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"),
    SPACE_CLI_ADMIN_HOST_SOCKET: join(root, "sockets", "admin.sock"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_EVIDENCE_ENABLED: "false",
    SPACE_T3CODE_ENABLED: "false",
    SPACE_T3CODE_SOCKET: join(root, "sockets", "t3code.sock"),
    SPACE_FILES_HOST_MODE: "disabled",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_OPTIONAL_MODULES: "none",
    SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_INSTALL_ROOT: resolve(repo),
    SPACE_PROJECTS_ROOT: join(varRoot, "projects"),
    SPACE_DEMO_PROJECTS_ROOT: join(varRoot, "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: join(varRoot, "demo-projects"),
    SPACE_ARTIFACT_ROOT: join(varRoot, "artifacts"),
    SPACE_APP_DIAGNOSTICS_ROOT: join(varRoot, "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(varRoot, "maintenance-autopilot", "state.json"),
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(varRoot, "cli-account-balancer", "state.json"),
    SPACE_MEMORY_GRAPH_ROOT: join(varRoot, "memory-graph"),
    SPACE_MEMORY_ROOT: join(varRoot, "memory"),
    SPACE_STARTER_MEMORY_ROOT: join(resolve(repo), "starter-memory"),
    SPACE_MEMORY_INDEX_PATH: join(varRoot, "memory", "space_memory.md"),
    SPACE_MEMORY_MONTHLY_PATH: join(varRoot, "memory", "space_memory_monthly.md"),
    SPACE_MEMORY_LOCK_PATH: join(varRoot, "memory", ".memory.lock"),
    SPACE_CODEX_HOME: join(root, "cli-state", "providers", "codex"),
    SPACE_CODEX_APP_SERVER_HOME: join(root, "cli-state", "providers", "codex"),
    SPACE_CODEX_GOALS_DB_PATH: join(varRoot, "codex-goals.sqlite"),
    SPACE_CODEX_APP_SERVER_COMMAND: join(root, "bin", "codex-vscode-parity"),
    SPACE_CLI_VPN_LAUNCHER: join(root, "bin", "space-cli-vpn-launcher"),
    SPACE_DESIGN_GATEWAY_KEY_FILE: join(root, "secrets", "space-design.key"),
    SPACE_VIDEO_TOOLS_DIR: join(varRoot, "models", "video"),
    SPACE_VIDEO_WORK_ROOT: join(varRoot, "video"),
    SPACE_CONNECTOR_KEY_FILE: join(varRoot, "connector", "space-connector.key"),
    SPACE_TELEGRAM_SECRET_ROOT: join(varRoot, "telegram"),
    SPACE_STREAMING_SECRET_ROOT: join(varRoot, "streaming-secrets"),
    SPACE_BROWSER_HOST_SOCKET: join(root, "sockets", "browser-host.sock"),
    SPACE_CHESS_MOVE_SOCKET: join(root, "sockets", "chess.sock"),
    SPACE_STREAMING_BOT_API_BASE_URL: `http://127.0.0.1:${ports.api}`,
    SPACE_ENABLE_DB_SWEEP: "false"
  };
  return { env: { ...env, ...overrides }, socketPath, overrides };
}

export function serviceCommands({ repo = repoRoot, ports }) {
  const tsx = join(repo, "node_modules/tsx/dist/cli.mjs");
  const vite = join(repo, "node_modules/vite/bin/vite.js");
  return {
    "cli-host": {
      cwd: repo,
      args: [tsx, join(repo, "packages/cli-host/src/main.ts")]
    },
    api: {
      cwd: join(repo, "apps/api"),
      args: [tsx, "watch", "--clear-screen=false", "src/server.ts"]
    },
    worker: {
      cwd: join(repo, "apps/worker"),
      args: [join(repo, "apps/worker/dist/worker.js")]
    },
    web: {
      cwd: join(repo, "apps/web"),
      args: [vite, "--host", "127.0.0.1", "--port", String(ports.web), "--strictPort"]
    }
  };
}

function chooseSocketPath(stateDir) {
  const preferred = join(stateDir, "sockets", "host.sock");
  if (preferred.length <= SOCKET_PATH_LIMIT) return preferred;
  const short = join(tmpdir(), "spaceapp-dev-stack", "host.sock");
  if (short.length > SOCKET_PATH_LIMIT) {
    throw new Error(`CLI host socket path is too long (${short.length}). Set TMPDIR to a short directory.`);
  }
  return short;
}

export const DOWN_COMPOSE_ARGS = ["down", "--remove-orphans"];
export const RESET_COMPOSE_ARGS = ["down", "-v", "--remove-orphans"];

export function composeArgs(file, project, ...rest) {
  return ["-p", project, "-f", file, ...rest];
}

function parseArgs(argv) {
  const args = [...argv];
  let command = "up";
  let stateDir = process.env.SPACE_DEV_STACK_STATE_DIR || join(repoRoot, ".dev-stack");
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--state-dir") {
      stateDir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--") continue;
    positional.push(arg);
  }
  if (positional.length) command = positional[0];
  return { command, stateDir: resolve(stateDir) };
}

async function main() {
  const { command, stateDir } = parseArgs(process.argv.slice(2));
  try {
    if (command === "up") await runUp(stateDir);
    else if (command === "down") await runDown(stateDir);
    else if (command === "reset") await runReset(stateDir);
    else if (command === "rebuild") await runRebuild(stateDir);
    else if (command === "status") await runStatus(stateDir);
    else throw new Error(`Unknown dev-stack command "${command}". Use up, down, reset, rebuild, or status.`);
  } catch (error) {
    writeLine(2, `dev-stack: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function writeLine(fd, text) {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  try {
    const handle = fd === 2 ? process.stderr : process.stdout;
    handle.write(line);
  } catch {
    // The pipe may already be closed during shutdown.
  }
}

async function runUp(stateDir) {
  assertSafeStateDir(stateDir);
  const paths = layout(stateDir);
  await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  await chmod(paths.secrets, 0o700);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const markerPath = join(paths.root, "OWNED");
  if (!existsSync(markerPath)) {
    await writeFile(markerPath, `${JSON.stringify({ marker: STATE_MARKER, repoRoot, project: COMPOSE_PROJECT }, null, 2)}\n`, { mode: 0o600 });
  } else {
    await assertOwned(stateDir);
  }
  const running = await readStack(paths.stackFile);
  if (running?.supervisorPid && await processIdentityMatches({ pid: running.supervisorPid, starttime: running.supervisorStarttime })) {
    throw new Error("A dev stack is already running for this state directory. Stop it with npm run dev:stack -- down.");
  }

  const images = parseComposeImages(await readFile(COMPOSE_TEMPLATE, "utf8"));
  const packageSpec = parseOpenCodePackage(await readFile(DOCKERFILE, "utf8"));
  const ports = resolvePorts();
  const secrets = await ensureSecrets(paths.secrets);
  const databaseUrl = databaseUrlFrom(secrets.password, ports.postgres);
  await writeFile(join(paths.secrets, "database-url"), `${databaseUrl}\n`, { mode: 0o600 });
  await chmod(join(paths.secrets, "database-url"), 0o600);
  const { env, socketPath } = devProcessEnv({
    stateDir,
    ports,
    databaseUrl,
    sessionSecret: secrets.sessionSecret
  });
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.composeFile, renderCompose({ images, ports }), { mode: 0o600 });
  await writeWrapper(paths, packageSpec);
  await copyStarterMemory(join(paths.varRoot, "memory"));
  await ensureDirectories(paths, socketPath);

  const docker = await resolveDocker();
  writeLine(1, "dev-stack: starting PostgreSQL and Temporal");
  // Pull first so the health wait is not spent downloading images.
  await pullComposeImages(docker, paths);
  try {
    await runLogged(docker.argv, composeArgs(paths.composeFile, COMPOSE_PROJECT, "up", "-d", "--wait", "--wait-timeout", "300", "postgres", "temporal"), {
      cwd: paths.root
    });
  } catch (error) {
    const logs = await runLogged(docker.argv, composeArgs(paths.composeFile, COMPOSE_PROJECT, "logs", "--no-color", "--tail", "160"), {
      cwd: paths.root,
      allowFailure: true
    });
    const message = error instanceof Error ? error.message : String(error);
    const tail = scrubSecrets(`${logs.stdout}\n${logs.stderr}`, [secrets.password, secrets.sessionSecret, secrets.setupToken]).slice(-4000);
    throw new Error(`${message}\n----- compose logs -----\n${tail}`);
  }
  await ensureTemporalNamespace(docker, paths.composeFile);
  writeLine(1, "dev-stack: installing the pinned OpenCode CLI into the state directory");
  await installOpenCode(paths, packageSpec, env);
  writeLine(1, "dev-stack: building workspace packages and applying migrations");
  await buildPackages(env);
  await runLogged(["npm", "run", "db:migrate"], [], { cwd: repoRoot, env });
  await runLogged(["npm", "run", "build", "-w", "@space/worker"], [], { cwd: repoRoot, env });

  const commands = serviceCommands({ ports });
  const children = [];
  const logDir = paths.logs;
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  for (const name of ["cli-host", "api", "worker", "web"]) {
    const spec = commands[name];
    const logPath = join(logDir, `${name}.log`);
    const child = spawnLogged(process.execPath, spec.args, { cwd: spec.cwd, env, logPath });
    const identity = await readProcessIdentity(child.pid);
    children.push({ name, pid: child.pid, starttime: identity?.starttime ?? null, logPath, child });
  }
  const supervisorIdentity = await readProcessIdentity(process.pid);
  const stack = {
    marker: STATE_MARKER,
    project: COMPOSE_PROJECT,
    supervisorPid: process.pid,
    supervisorStarttime: supervisorIdentity?.starttime ?? null,
    ports,
    socketPath,
    composeFile: paths.composeFile,
    children: children.map(({ name, pid, starttime, logPath }) => ({ name, pid, starttime, logPath }))
  };
  await writeFile(paths.stackFile, `${JSON.stringify(stack, null, 2)}\n`, { mode: 0o600 });

  let shuttingDown = false;
  let failure = null;
  const shutdown = async (status) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const record of children) record.child.expectedExit = true;
    await stopChildren(children);
    try {
      await stopOwnedOpenCodeServer(stateDir);
      await runLogged(docker.argv, composeArgs(paths.composeFile, COMPOSE_PROJECT, ...DOWN_COMPOSE_ARGS), { cwd: paths.root });
    } catch (error) {
      writeLine(2, `dev-stack: docker down reported: ${error instanceof Error ? error.message : error}`);
    }
    await writeFile(paths.stackFile, `${JSON.stringify({ ...stack, supervisorPid: null, children: [] }, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    process.exit(status);
  };
  requestShutdown = shutdown;

  bindChildFailure(children, (line, record) => {
    if (shuttingDown || failure) return;
    failure = line;
    writeLine(2, line);
    const tail = tailFile(record.logPath);
    if (tail) writeLine(2, scrubSecrets(tail));
    void shutdown(1);
  });
  process.once("SIGINT", () => { writeLine(1, "dev-stack: stopping"); void shutdown(0); });
  process.once("SIGTERM", () => { void shutdown(0); });
  process.on("SIGUSR1", () => {
    if (shuttingDown) return;
    void restartBuiltServices(children, commands, env, logDir, paths).catch((error) => {
      failure = `dev-stack: rebuild restart failed: ${error instanceof Error ? error.message : error}`;
      writeLine(2, failure);
      void shutdown(1);
    });
  });

  try {
    await waitForReady(`http://127.0.0.1:${ports.api}/readyz`, children, 240_000);
  } catch (error) {
    writeLine(2, `dev-stack: ${error instanceof Error ? error.message : error}`);
    await shutdown(1);
    return;
  }
  await printBanner(ports, secrets, paths);
  await new Promise(() => {});
}

async function restartBuiltServices(children, commands, env, logDir, paths) {
  writeLine(1, "dev-stack: restarting from-source processes so rebuilt packages are loaded");
  for (const name of ["cli-host", "api", "worker", "web"]) {
    const current = children.find((record) => record.name === name);
    if (!current) continue;
    current.child.expectedExit = true;
    const stopped = await stopRecordedProcess(current);
    if (!stopped) throw new Error(`Could not stop ${name} before restart.`);
    const spec = commands[name];
    const logPath = join(logDir, `${name}.log`);
    const child = spawnLogged(process.execPath, spec.args, { cwd: spec.cwd, env, logPath });
    const identity = await readProcessIdentity(child.pid);
    current.pid = child.pid;
    current.starttime = identity?.starttime ?? null;
    current.child = child;
    current.logPath = logPath;
    child.once("exit", (code, signal) => {
      if (child.expectedExit) return;
      writeLine(2, failureLine(name, code, signal, logPath));
      void requestShutdown(1);
    });
  }
  const stack = JSON.parse(await readFile(paths.stackFile, "utf8"));
  stack.children = children.map(({ name, pid, starttime, logPath }) => ({ name, pid, starttime, logPath }));
  await writeFile(paths.stackFile, `${JSON.stringify(stack, null, 2)}\n`, { mode: 0o600 });
}

async function printBanner(ports, secrets, paths) {
  let setupRequired = true;
  try {
    const response = await fetch(`http://127.0.0.1:${ports.api}/api/setup/status`);
    if (response.ok) setupRequired = Boolean((await response.json()).setupRequired);
  } catch {
    setupRequired = true;
  }
  const lines = [
    "",
    "SpaceApp is running from this checkout.",
    "",
    `  Web:   http://127.0.0.1:${ports.web}`,
    `  API:   http://127.0.0.1:${ports.api}`,
    `  Ready: http://127.0.0.1:${ports.api}/readyz`,
    ""
  ];
  if (setupRequired) {
    lines.push("  One-time owner setup token:");
    lines.push(`  ${secrets.setupToken}`);
    lines.push("");
    lines.push("  Open the web URL, create the owner with that token, then sign in.");
  } else {
    lines.push("  The owner already exists. Sign in at the web URL.");
  }
  lines.push("  The dev-login shortcut is off. Browser panes stay disabled in this stack.");
  lines.push(`  Logs:  ${paths.logs}`);
  lines.push("  Stop:  npm run dev:stack -- down");
  lines.push("  Reset: npm run dev:stack -- reset");
  lines.push("");
  writeLine(1, lines.join("\n"));
}

async function runDown(stateDir) {
  assertSafeStateDir(stateDir);
  const paths = layout(stateDir);
  if (!existsSync(paths.root)) {
    writeLine(1, "dev-stack: nothing to stop");
    return;
  }
  await assertOwned(stateDir);
  const stack = await readStack(paths.stackFile);
  if (stack?.supervisorPid && stack.supervisorPid !== process.pid && await processIdentityMatches({ pid: stack.supervisorPid, starttime: stack.supervisorStarttime })) {
    process.kill(stack.supervisorPid, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && await processIdentityMatches({ pid: stack.supervisorPid, starttime: stack.supervisorStarttime })) {
      await delay(200);
    }
  }
  if (stack?.children) await stopChildren(stack.children.map((child) => ({ ...child, child: null })));
  await stopOwnedOpenCodeServer(stateDir);
  if (existsSync(paths.composeFile)) {
    const docker = await resolveDocker();
    await runLogged(docker.argv, composeArgs(paths.composeFile, stack?.project || COMPOSE_PROJECT, ...DOWN_COMPOSE_ARGS), { cwd: paths.root });
  }
  if (existsSync(paths.stackFile)) {
    const next = { ...(stack ?? {}), supervisorPid: null, children: [] };
    await writeFile(paths.stackFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
  writeLine(1, "dev-stack: stopped");
}

async function runReset(stateDir) {
  assertSafeStateDir(stateDir);
  const paths = layout(stateDir);
  if (!existsSync(paths.root)) {
    writeLine(1, "dev-stack: nothing to remove");
    return;
  }
  await assertOwned(stateDir);
  const stack = await readStack(paths.stackFile);
  const project = stack?.project || COMPOSE_PROJECT;
  const socketPath = stack?.socketPath;
  await runDown(stateDir);
  if (existsSync(paths.composeFile)) {
    const docker = await resolveDocker();
    await runLogged(docker.argv, composeArgs(paths.composeFile, project, ...RESET_COMPOSE_ARGS), { cwd: paths.root });
    const leftover = await leftoverResources(docker, project);
    if (leftover.containers.length || leftover.volumes.length) {
      throw new Error(`Reset left Docker resources for ${project}: ${JSON.stringify(leftover)}`);
    }
  }
  await rm(paths.root, { recursive: true, force: true });
  if (socketPath && !socketPath.startsWith(paths.root) && existsSync(dirname(socketPath))) {
    const parent = dirname(socketPath);
    if (parent.includes("spaceapp-dev-stack")) await rm(parent, { recursive: true, force: true });
  }
  writeLine(1, "dev-stack: removed the dev-stack containers, volumes and state directory");
}

async function runRebuild(stateDir) {
  assertSafeStateDir(stateDir);
  const paths = layout(stateDir);
  const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" };
  await buildPackages(env);
  await runLogged(["npm", "run", "build", "-w", "@space/worker"], [], { cwd: repoRoot, env });
  const stack = await readStack(paths.stackFile);
  if (stack?.supervisorPid && await processIdentityMatches({ pid: stack.supervisorPid, starttime: stack.supervisorStarttime })) {
    process.kill(stack.supervisorPid, "SIGUSR1");
    writeLine(1, "dev-stack: packages rebuilt; the running API and worker are restarting");
    return;
  }
  writeLine(1, "dev-stack: packages rebuilt. The next npm run dev:stack will use them.");
}

async function runStatus(stateDir) {
  assertSafeStateDir(stateDir);
  const paths = layout(stateDir);
  const stack = await readStack(paths.stackFile);
  const supervisor = stack?.supervisorPid && await processIdentityMatches({ pid: stack.supervisorPid, starttime: stack.supervisorStarttime });
  writeLine(1, JSON.stringify({
    stateDir,
    running: Boolean(supervisor),
    supervisorPid: supervisor ? stack.supervisorPid : null,
    children: stack?.children ?? []
  }, null, 2));
}

function layout(stateDir) {
  const root = resolve(stateDir);
  return {
    root,
    secrets: join(root, "secrets"),
    logs: join(root, "logs"),
    bin: join(root, "bin"),
    varRoot: join(root, "var"),
    composeFile: join(root, "compose.yml"),
    stackFile: join(root, "stack.json"),
    tools: join(root, "tools", "opencode")
  };
}

async function assertOwned(stateDir) {
  const markerPath = join(stateDir, "OWNED");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(`Refusing to touch ${stateDir}: it is not a dev-stack state directory.`);
  }
  if (parsed.marker !== STATE_MARKER) {
    throw new Error(`Refusing to touch ${stateDir}: ownership marker does not match.`);
  }
}

export async function ensureSecrets(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const password = await ensureSecret(join(directory, "postgres-password"), () => randomBytes(24).toString("hex"));
  const sessionSecret = await ensureSecret(join(directory, "session-secret"), () => randomBytes(32).toString("hex"));
  const setupToken = await ensureSecret(join(directory, "setup-token"), () => randomBytes(32).toString("hex"));
  for (const name of ["postgres-password", "session-secret", "setup-token"]) {
    await chmod(join(directory, name), 0o600);
    const info = await stat(join(directory, name));
    if ((info.mode & 0o777) !== 0o600) {
      throw new Error(`${name} must be mode 0600.`);
    }
  }
  return { password, sessionSecret, setupToken };
}

async function ensureSecret(file, create) {
  try {
    const existing = (await readFile(file, "utf8")).replace(/\r?\n$/, "");
    if (existing) return existing;
  } catch {
    // Created below.
  }
  const value = create();
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  return value;
}

function databaseUrlFrom(password, port) {
  return `postgres://${DATABASE_USER}:${password}@127.0.0.1:${port}/${DATABASE_NAME}`;
}

async function writeWrapper(paths, packageSpec) {
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  const file = join(paths.bin, "opencode-vscode-parity");
  await writeFile(file, renderOpenCodeWrapper({ stateDir: paths.root, repo: repoRoot, packageSpec }), { mode: 0o700 });
  await chmod(file, 0o700);
}

async function copyStarterMemory(memoryRoot) {
  await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
  const source = join(repoRoot, "starter-memory");
  for (const name of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) {
    const target = join(memoryRoot, name);
    if (!existsSync(target) && existsSync(join(source, name))) {
      await copyFile(join(source, name), target);
      await chmod(target, 0o600);
    }
  }
}

async function ensureDirectories(paths, socketPath) {
  for (const dir of [
    join(paths.varRoot, "projects"),
    join(paths.varRoot, "artifacts"),
    join(paths.varRoot, "app-diagnostics"),
    join(paths.varRoot, "memory-graph"),
    join(paths.root, "workspaces"),
    join(paths.root, "cli-state", "providers", "opencode"),
    dirname(socketPath)
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

async function installOpenCode(paths, packageSpec, env) {
  const versionFile = join(paths.root, "opencode-version");
  const binary = join(paths.tools, "node_modules", ".bin", "opencode");
  const installed = existsSync(versionFile) ? (await readFile(versionFile, "utf8")).trim() : "";
  if (installed === packageSpec && existsSync(binary)) return;
  await mkdir(paths.tools, { recursive: true, mode: 0o700 });
  const manifest = join(paths.tools, "package.json");
  if (!existsSync(manifest)) await writeFile(manifest, "{\"private\":true}\n", { mode: 0o600 });
  await runLogged(["npm", "install", "--prefix", paths.tools, "--no-audit", "--no-fund", "--no-save", packageSpec], [], {
    cwd: paths.root,
    env
  });
  if (!existsSync(binary)) throw new Error(`OpenCode install did not produce ${binary}.`);
  await writeFile(versionFile, `${packageSpec}\n`, { mode: 0o600 });
}

async function buildPackages(env) {
  for (const name of PACKAGE_BUILD_ORDER) {
    await runLogged(["npm", "run", "build", "-w", name], [], { cwd: repoRoot, env });
  }
}

async function pullComposeImages(docker, paths) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runLogged(docker.argv, composeArgs(paths.composeFile, COMPOSE_PROJECT, "pull", "postgres", "temporal"), {
        cwd: paths.root
      });
      return;
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!pullFailureIsTransient(message) || attempt === 3) throw error;
      writeLine(2, `dev-stack: image pull failed (attempt ${attempt}); retrying`);
      await delay(5_000 * attempt);
    }
  }
  throw last;
}

async function ensureTemporalNamespace(docker, composeFile) {
  const result = await runLogged(docker.argv, composeArgs(
    composeFile,
    COMPOSE_PROJECT,
    "exec",
    "-T",
    "temporal",
    "temporal",
    "operator",
    "namespace",
    "create",
    "--namespace",
    TEMPORAL_NAMESPACE,
    "--address",
    "temporal:7233",
    "--retention",
    "24h"
  ), { cwd: dirname(composeFile), allowFailure: true });
  if (result.status === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/already exists|NamespaceAlreadyExists/i.test(output)) return;
  throw new Error(`Could not create the Temporal namespace ${TEMPORAL_NAMESPACE}: ${scrubSecrets(output).slice(-2000)}`);
}

async function waitForReady(url, children, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response yet";
  while (Date.now() < deadline) {
    const dead = children.find((record) => record.child.exitCode !== null || record.child.signalCode);
    if (dead && !dead.child.expectedExit) {
      throw new Error(`${dead.name} exited before /readyz passed. See ${dead.logPath}`);
    }
    try {
      const response = await fetch(`${url}?strict=1`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json();
      const worker = body?.dependencies?.worker;
      if (response.ok && body?.ok === true && worker === "RUNNING") return body;
      last = `HTTP ${response.status} ok=${body?.ok} worker=${worker}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`/readyz did not report workflows running within ${Math.round(timeoutMs / 1000)}s (${last}).`);
}

export async function leftoverResources(docker, project) {
  const containers = (await runLogged(docker.argv[0] === "sudo" ? ["sudo", "-n", "docker"] : ["docker"], [
    "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`
  ], { allowFailure: true })).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const volumes = (await runLogged(docker.argv[0] === "sudo" ? ["sudo", "-n", "docker"] : ["docker"], [
    "volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`
  ], { allowFailure: true })).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return { containers, volumes };
}

export async function resolveDocker() {
  // `docker compose version` succeeds without a daemon. `docker info` checks the socket.
  const candidates = [
    ["docker"],
    ["sudo", "-n", "docker"]
  ];
  for (const argv of candidates) {
    const result = await runLogged(argv, ["info"], { allowFailure: true });
    if (result.status === 0) return { argv: [...argv, "compose"] };
  }
  throw new Error("Docker Compose is required. Install Docker and make `docker compose` usable without a password prompt.");
}

function spawnLogged(command, args, { cwd, env, logPath }) {
  const fd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", fd, fd]
  });
  closeSync(fd);
  child.expectedExit = false;
  return child;
}

async function stopChildren(records) {
  await Promise.all(records.map((record) => stopRecordedProcess(record)));
}

export async function stopOwnedOpenCodeServer(stateDir) {
  const recordPath = join(stateDir, "cli-state", "providers", "opencode", "state", "opencode", "spaceapp-shared-server.json");
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch {
    return false;
  }
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const cwd = await processWorkingDirectory(pid);
  const executable = await processExecutable(pid);
  if (!cwdBelongsToState(stateDir, cwd) && !executableBelongsToState(stateDir, executable)) return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { return false; }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await delay(100);
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  return true;
}

async function processWorkingDirectory(pid) {
  try {
    if (process.platform === "linux") return await readlink(`/proc/${pid}/cwd`);
    if (process.platform === "darwin") {
      const { status, stdout } = await execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      if (status !== 0) return null;
      return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

async function processExecutable(pid) {
  try {
    if (process.platform === "linux") return await readlink(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
  return null;
}

let requestShutdown = async (status) => {
  process.exitCode = status;
};

export async function stopRecordedProcess(record) {
  if (!record?.pid) return false;
  if (!(await processIdentityMatches(record))) return false;
  const pid = record.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { return false; }
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && await processIdentityMatches(record)) await delay(100);
  if (await processIdentityMatches(record)) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  return true;
}

async function readStack(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function tailFile(file) {
  try {
    const text = readFileSync(file, "utf8");
    return text.split(/\r?\n/).slice(-40).join("\n");
  } catch {
    return "";
  }
}

function execFile(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function runLogged(argv, args, { cwd = repoRoot, env = process.env, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (process.env.SPACE_DEV_STACK_TRACE === "1") {
      writeLine(1, `dev-stack: run ${new Date().toISOString()} ${[...argv, ...args].join(" ")}`);
    }
    const child = spawn(argv[0], [...argv.slice(1), ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (allowFailure) resolvePromise({ status: 127, stdout, stderr: error.message });
      else reject(error);
    });
    child.once("exit", (status) => {
      if (status !== 0 && !allowFailure) {
        reject(new Error(`${argv.join(" ")} ${args.join(" ")} failed (${status})\n${scrubSecrets(`${stdout}\n${stderr}`).slice(-4000)}`));
        return;
      }
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
