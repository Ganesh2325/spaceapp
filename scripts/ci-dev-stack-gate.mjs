#!/usr/bin/env node
// CI and local proof for `npm run dev:stack`. No TTY is allocated.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  composeProjectName,
  devStackOwnedProcesses,
  leftoverResources,
  processIdentityMatches,
  readProcessIdentity,
  repoRoot,
  resolveDocker,
  resolvePorts,
  scrubSecrets
} from "./dev-stack.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = "space_session_dev";
const SUPERVISOR_LOG = "/tmp/spaceapp-dev-stack-supervisor.log";
const TRANSCRIPT = "/tmp/spaceapp-dev-stack-linux-transcript.txt";
const LOG_SNAPSHOT = "/tmp/spaceapp-dev-stack-logs";

export function sessionCookieFrom(setCookieLines, name) {
  for (const line of setCookieLines) {
    const pair = line.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

export function terminalFrameText(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.data === "string") return parsed.data;
  } catch {
    // A frame can be plain text while the socket is still opening.
  }
  return text;
}

export function viteHotUpdate(messages) {
  let sawUpdate = false;
  for (const message of messages) {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      continue;
    }
    if (parsed?.type === "full-reload") return "full-reload";
    if (parsed?.type === "update") sawUpdate = true;
  }
  return sawUpdate ? "update" : null;
}

export function terminalSocketUrl(apiHttpUrl, paneId, ticket) {
  const url = new URL(`/api/panes/${encodeURIComponent(paneId)}/cli/terminal`, apiHttpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("sessionId", ticket.sessionId);
  url.searchParams.set("token", ticket.token);
  url.searchParams.set("initialCols", "80");
  url.searchParams.set("initialRows", "24");
  return url.href;
}

function stateDir() {
  return process.env.SPACE_DEV_STACK_STATE_DIR || join(repoRoot, ".dev-stack");
}

function say(text) {
  process.stdout.write(`${text.endsWith("\n") ? text : `${text}\n`}`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function waitForReady(api, supervisor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response yet";
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null) {
      throw new Error(`dev stack exited ${supervisor.exitCode} before /readyz. The supervisor log is printed above.`);
    }
    try {
      const response = await fetch(`${api}/readyz?strict=1`, { signal: AbortSignal.timeout(5_000) });
      const body = await readJson(response);
      if (response.ok && body?.ok === true && body?.dependencies?.worker === "RUNNING") return body;
      last = `HTTP ${response.status} ok=${body?.ok} worker=${body?.dependencies?.worker}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`/readyz did not report workflows running (${last}).`);
}

async function claimOwner(api, token) {
  const password = randomBytes(18).toString("hex");
  const response = await fetch(`${api}/api/setup/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, email: "dev-stack@example.com", password })
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`Owner setup failed (${response.status}): ${JSON.stringify(body).slice(0, 500)}`);
  const cookie = sessionCookieFrom(response.headers.getSetCookie?.() ?? [], SESSION_COOKIE);
  if (!cookie) throw new Error("Owner setup did not set the dev session cookie.");
  if (!body?.starterRoomId) throw new Error("Owner setup did not return the Getting Started room.");
  return { cookie, starterRoomId: body.starterRoomId, password };
}

async function csrfToken(api, cookie) {
  const response = await fetch(`${api}/api/auth/csrf`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  const body = await readJson(response);
  if (!response.ok || !body?.csrfToken) throw new Error(`CSRF token was not issued (${response.status}).`);
  return body.csrfToken;
}

async function openCodePane(api, cookie, roomId) {
  const headers = { cookie: `${SESSION_COOKIE}=${cookie}` };
  const listed = await fetch(`${api}/api/panes?roomId=${encodeURIComponent(roomId)}&includeClosed=false`, { headers });
  const panes = await readJson(listed);
  if (!listed.ok) throw new Error(`Pane list failed (${listed.status}): ${JSON.stringify(panes).slice(0, 400)}`);
  const pane = (panes.data ?? []).find((item) => item.terminalRuntimeId === "cli:opencode" || item.title === "OpenCode CLI");
  if (!pane) throw new Error("Getting Started has no OpenCode pane.");
  const token = await csrfToken(api, cookie);
  const started = await fetch(`${api}/api/panes/${encodeURIComponent(pane.id)}/cli/session`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "x-space-csrf-token": token },
    body: JSON.stringify({ runtimeId: "cli:opencode", includeTranscript: true })
  });
  const session = await readJson(started);
  if (!started.ok || !session?.websocket?.token) {
    throw new Error(`OpenCode session was not created (${started.status}): ${JSON.stringify(session).slice(0, 500)}`);
  }
  const output = [];
  const socket = new WebSocket(terminalSocketUrl(api, pane.id, session.websocket), {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` }
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (data) => output.push(terminalFrameText(data)));
  await opened;
  const deadline = Date.now() + 180_000;
  let status = session.session?.status ?? "UNKNOWN";
  while (Date.now() < deadline) {
    const current = await fetch(`${api}/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { headers });
    const body = await readJson(current);
    status = body?.session?.status ?? status;
    const rendered = output.join("");
    if (status === "RUNNING" && /opencode/i.test(rendered)) {
      socket.close();
      return { paneId: pane.id, status, outputBytes: rendered.length };
    }
    if (status === "EXITED" || status === "ERROR") break;
    await delay(1_000);
  }
  socket.close();
  const sample = output.join("").split(String.fromCharCode(0x1b)).join("").slice(-500);
  throw new Error(`OpenCode pane did not reach a running terminal UI (status ${status}). Last output: ${sample}`);
}

async function proveApiReload(api) {
  const serverFile = join(repoRoot, "apps/api/src/server.ts");
  const original = await readFile(serverFile, "utf8");
  const probe = "\n// dev-stack reload probe\n";
  if (original.includes(probe.trim())) throw new Error("The API reload probe is already in server.ts.");
  const before = await readJson(await fetch(`${api}/readyz`));
  try {
    await writeFile(serverFile, `${original}${probe}`);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const body = await readJson(await fetch(`${api}/readyz`, { signal: AbortSignal.timeout(5_000) }));
        if (body?.apiStartedAt && body.apiStartedAt !== before.apiStartedAt) return body.apiStartedAt;
      } catch {
        // The API is restarting.
      }
      await delay(500);
    }
    throw new Error("Saving apps/api/src/server.ts did not restart the API.");
  } finally {
    await writeFile(serverFile, original);
  }
}

async function proveWebReload(webPort) {
  const web = `http://127.0.0.1:${webPort}`;
  const component = join(repoRoot, "apps/web/src/features/SurfaceErrorBoundary.tsx");
  const original = await readFile(component, "utf8");
  const probe = "\n// dev-stack hmr probe\n";
  if (original.includes(probe.trim())) throw new Error("The web reload probe is already in SurfaceErrorBoundary.tsx.");
  await fetch(`${web}/src/main.tsx`);
  await fetch(`${web}/src/features/SurfaceErrorBoundary.tsx`);
  const client = await (await fetch(`${web}/@vite/client`)).text();
  const token = client.match(/const wsToken = "([^"]*)"/)?.[1] ?? "";
  const socket = new WebSocket(`${web.replace("http:", "ws:")}/?token=${encodeURIComponent(token)}`, "vite-hmr");
  const messages = [];
  socket.on("message", (data) => messages.push(String(data)));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    await writeFile(component, `${original}${probe}`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const kind = viteHotUpdate(messages);
      if (kind === "full-reload") {
        throw new Error("Saving apps/web/src/features/SurfaceErrorBoundary.tsx produced a full reload, not a hot update.");
      }
      if (kind === "update") return;
      await delay(200);
    }
    throw new Error("Saving apps/web/src/features/SurfaceErrorBoundary.tsx did not produce a Vite hot update.");
  } finally {
    socket.close();
    await writeFile(component, original);
  }
}

async function proveWorkerFailure(supervisor, root) {
  const stack = JSON.parse(await readFile(join(root, "stack.json"), "utf8"));
  const worker = stack.children.find((child) => child.name === "worker");
  if (!worker) throw new Error("stack.json has no worker pid.");
  process.kill(worker.pid, "SIGTERM");
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const log = await readFile(SUPERVISOR_LOG, "utf8").catch(() => "");
    if (log.includes("dev-stack: worker exited unexpectedly") && log.includes("shutting the stack down so nothing is left half-running")) {
      while (Date.now() < deadline && supervisor.exitCode === null) await delay(200);
      if (supervisor.exitCode === null) throw new Error("The supervisor printed the worker failure and then stayed up.");
      return;
    }
    await delay(300);
  }
  throw new Error("Stopping the worker did not fail the dev stack.");
}

async function secretValues(root) {
  const secrets = [];
  for (const name of ["postgres-password", "session-secret", "setup-token"]) {
    try {
      const value = (await readFile(join(root, "secrets", name), "utf8")).trim();
      if (value) secrets.push(value);
    } catch {
      // Already removed.
    }
  }
  return secrets;
}

async function assertClean(docker, project, records, optExisted) {
  const leftover = await leftoverResources(docker, project);
  if (leftover.containers.length || leftover.volumes.length) {
    throw new Error(`Reset left Docker resources: ${JSON.stringify(leftover)}`);
  }
  if (existsSync(stateDir())) throw new Error("Reset left the state directory in place.");
  for (const record of records) {
    if (await processIdentityMatches(record)) throw new Error(`${record.name} pid ${record.pid} is still running.`);
  }
  if (!optExisted && existsSync("/opt/spaceapp")) throw new Error("The dev stack created /opt/spaceapp.");
}

async function main() {
  const exercise = process.argv.includes("--exercise-reload");
  const docker = await resolveDocker();
  const ports = resolvePorts();
  const api = `http://127.0.0.1:${ports.api}`;
  const root = stateDir();
  const optExisted = existsSync("/opt/spaceapp");
  writeFileSync(SUPERVISOR_LOG, "");
  const supervisor = spawn(process.execPath, [join(scriptDir, "dev-stack.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1", TERM: "dumb", SPACE_DEV_STACK_TRACE: "1" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const captured = [];
  const capture = (chunk) => {
    const buffer = Buffer.from(chunk);
    captured.push(buffer);
    appendFileSync(SUPERVISOR_LOG, buffer);
  };
  supervisor.stdout.on("data", capture);
  supervisor.stderr.on("data", capture);
  supervisor.capturedOutput = () => Buffer.concat(captured).toString("utf8");
  let secrets = [];
  let records;
  let resetFailure = null;
  try {
    say("dev-stack gate: waiting for /readyz");
    const ready = await waitForReady(api, supervisor, 20 * 60_000);
    if (ready.dependencies?.worker !== "RUNNING" || ready.ok !== true) throw new Error("readyz was not ok with a running worker.");
    say("dev-stack gate: claiming the owner");
    const token = (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim();
    const claimed = await claimOwner(api, token);
    const status = await readJson(await fetch(`${api}/api/setup/status`));
    if (status?.setupRequired !== false) throw new Error("Setup still required after the owner was claimed.");
    say("dev-stack gate: opening the OpenCode pane");
    const pane = await openCodePane(api, claimed.cookie, claimed.starterRoomId);
    say(`dev-stack gate: OpenCode pane ${pane.status}, ${pane.outputBytes} bytes of terminal output`);
    secrets = await secretValues(root);
    const stack = JSON.parse(await readFile(join(root, "stack.json"), "utf8"));
    const owned = await devStackOwnedProcesses(root);
    const children = stack.children ?? [];
    records = [
      { name: "supervisor", pid: supervisor.pid, starttime: (await readProcessIdentity(supervisor.pid))?.starttime ?? stack.supervisorStarttime },
      ...children,
      ...owned.filter((record) => record.pid !== supervisor.pid && !children.some((child) => child.pid === record.pid))
    ];
    if (exercise) {
      say("dev-stack gate: checking API reload and Vite HMR");
      await proveApiReload(api);
      await proveWebReload(ports.web);
      say("dev-stack gate: stopping the worker");
      await proveWorkerFailure(supervisor, root);
    }
  } finally {
    if (!secrets.length) secrets = await secretValues(root).catch(() => []);
    const earlyLog = scrubSecrets(supervisor.capturedOutput?.() ?? "", secrets);
    if (earlyLog.trim()) say(`----- supervisor log -----\n${earlyLog.slice(-20000)}\n----- end supervisor log -----`);
    const copied = await cp(join(root, "logs"), LOG_SNAPSHOT, { recursive: true, force: true }).then(() => true, () => false);
    if (copied) say(`dev-stack gate: saved process logs to ${LOG_SNAPSHOT}`);
    say("dev-stack gate: resetting");
    const reset = spawn(process.execPath, [join(scriptDir, "dev-stack.mjs"), "reset"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resetOut = "";
    reset.stdout.on("data", (chunk) => { resetOut += chunk; });
    reset.stderr.on("data", (chunk) => { resetOut += chunk; });
    const resetCode = await new Promise((resolve) => reset.once("exit", resolve));
    const transcript = scrubSecrets(await readFile(SUPERVISOR_LOG, "utf8").catch(() => ""), secrets);
    await writeFile(TRANSCRIPT, transcript);
    if (resetCode !== 0) resetFailure = new Error(`reset failed (${resetCode}): ${scrubSecrets(resetOut, secrets).slice(-2000)}`);
  }
  if (resetFailure) throw resetFailure;
  await assertClean(docker, composeProjectName(repoRoot), records, optExisted);
  say(`dev-stack gate: clean. Scrubbed supervisor log: ${TRANSCRIPT}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolveArgv(process.argv[1])).href;
function resolveArgv(argvPath) {
  return argvPath.startsWith("/") ? argvPath : join(process.cwd(), argvPath);
}
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`dev-stack gate: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
