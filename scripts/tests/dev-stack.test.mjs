import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionCookieFrom, terminalFrameText, terminalSocketUrl } from "../ci-dev-stack-gate.mjs";
import {
  COMPOSE_PROJECT,
  DEFAULT_PORTS,
  DOWN_COMPOSE_ARGS,
  RESET_COMPOSE_ARGS,
  assertClaimableStateDir,
  assertSafeStateDir,
  bindChildFailure,
  composeArgs,
  composeUsesGuestPortForward,
  cwdBelongsToState,
  devProcessEnv,
  ensureNodePtySpawnHelper,
  ensureSecrets,
  executableBelongsToState,
  failureLine,
  installedPathFallbacks,
  parseComposeImages,
  nodePtySpawnHelperPaths,
  parseOpenCodePackage,
  pullFailureIsTransient,
  parseProcStat,
  processIdentityMatches,
  readProcessIdentity,
  renderCompose,
  renderOpenCodeWrapper,
  repoRoot,
  resolvePorts,
  scrubSecrets,
  serviceCommands,
  stateDirPathProblems,
  stopRecordedProcess
} from "../dev-stack.mjs";

const scriptSource = await readFile(new URL("../dev-stack.mjs", import.meta.url), "utf8");
const composeText = await readFile(join(repoRoot, "packages/run-spaceapp/templates/compose.yml"), "utf8");
const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
const configSource = await readFile(join(repoRoot, "apps/api/src/config.ts"), "utf8");

test("image pins and the OpenCode version are read from the shared files", () => {
  const images = parseComposeImages(composeText);
  const packageSpec = parseOpenCodePackage(dockerfile);
  assert.match(images.postgres, /^pgvector\/pgvector:.+@sha256:[a-f0-9]{64}$/);
  assert.match(images.temporal, /^temporalio\/auto-setup:.+@sha256:[a-f0-9]{64}$/);
  assert.match(packageSpec, /^(?:opencode-ai|@opencode\/cli)@\d+\.\d+\.\d+$/);
  assert.equal(scriptSource.includes(images.postgres.split("@")[1]), false);
  assert.equal(scriptSource.includes(images.temporal.split("@")[1]), false);
  assert.equal(scriptSource.includes(packageSpec), false);
  assert.throws(() => parseComposeImages("services:\n  postgres:\n    image: postgres:17\n"), /sha256/);
  assert.throws(() => parseOpenCodePackage("FROM scratch\n"), /Dockerfile must pin/);
});

test("dev-stack ports default off the installed app and stay on loopback", async () => {
  assert.deepEqual(resolvePorts({}), DEFAULT_PORTS);
  assert.equal(DEFAULT_PORTS.api === 4910 || DEFAULT_PORTS.web === 4911, false);
  const overridden = resolvePorts({
    SPACE_DEV_STACK_API_PORT: "4910",
    SPACE_DEV_STACK_WEB_PORT: "18080",
    SPACE_DEV_STACK_POSTGRES_PORT: "18081",
    SPACE_DEV_STACK_TEMPORAL_PORT: "18082"
  });
  assert.equal(overridden.api, 4910);
  assert.throws(() => resolvePorts({ SPACE_DEV_STACK_API_PORT: "5910", SPACE_DEV_STACK_WEB_PORT: "5910" }), /unique/);
  assert.throws(() => resolvePorts({ SPACE_DEV_STACK_API_PORT: "nope" }), /integer/);
  const rendered = renderCompose({ images: parseComposeImages(composeText), ports: DEFAULT_PORTS });
  assert.match(rendered, new RegExp(`^name: ${COMPOSE_PROJECT}$`, "m"));
  assert.equal(rendered.includes("profiles:"), false);
  assert.equal(rendered.includes("postgres://"), false);
  assert.equal(rendered.includes("0.0.0.0:"), false);
  for (const port of Object.values(DEFAULT_PORTS)) {
    if (port === DEFAULT_PORTS.api || port === DEFAULT_PORTS.web) continue;
    assert.match(rendered, new RegExp(`127\\.0\\.0\\.1:${port}:`));
  }
  assert.match(rendered, /POSTGRES_PASSWORD_FILE/);
  assert.match(rendered, /user: root/);
  assert.match(rendered, /exec su temporal -c 'exec \/etc\/temporal\/entrypoint.sh autosetup'/);
  const forwarded = renderCompose({ images: parseComposeImages(composeText), ports: DEFAULT_PORTS, guestPortForward: true });
  assert.match(forwarded, /"55432:5432"/);
  assert.match(forwarded, /"57233:7233"/);
  assert.equal(forwarded.includes("127.0.0.1:"), false);
  assert.equal(forwarded.includes("0.0.0.0:"), false);
  assert.equal(await composeUsesGuestPortForward({ SPACE_DEV_STACK_PUBLISH: "guest" }), true);
  assert.equal(await composeUsesGuestPortForward({ SPACE_DEV_STACK_PUBLISH: "loopback", DOCKER_CONTEXT: "colima" }), false);
  assert.equal(await composeUsesGuestPortForward({ DOCKER_CONTEXT: "colima" }), true);
  assert.equal(await composeUsesGuestPortForward({ DOCKER_HOST: "unix:///Users/runner/.colima/default/docker.sock" }), true);
  assert.equal(await composeUsesGuestPortForward({ DOCKER_CONTEXT: "default" }), false);
});

test("macOS node-pty spawn-helper is made executable before a pane can start", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-pty-"));
  try {
    const helper = join(root, "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper");
    await mkdir(join(helper, ".."), { recursive: true });
    await writeFile(helper, "not a real binary\n", { mode: 0o644 });
    await chmod(helper, 0o644);
    const first = await ensureNodePtySpawnHelper({ root, platformName: "darwin", archName: "x64" });
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
    assert.equal(first.some((item) => item.file === helper && item.action === "chmod" && item.mode === 0o644), true);
    const second = await ensureNodePtySpawnHelper({ root, platformName: "darwin", archName: "x64" });
    assert.equal(second.some((item) => item.file === helper && item.action === "already-executable"), true);
    assert.deepEqual(await ensureNodePtySpawnHelper({ root, platformName: "linux", archName: "x64" }), []);
    assert.deepEqual(nodePtySpawnHelperPaths(root, "darwin", "arm64").at(-1), join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-empty state directory without OWNED is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-claim-"));
  try {
    await assertClaimableStateDir(join(root, "missing"));
    const empty = join(root, "empty");
    await mkdir(empty);
    await assertClaimableStateDir(empty);
    const owned = join(root, "owned");
    await mkdir(owned);
    await writeFile(join(owned, "OWNED"), "marker\n");
    await writeFile(join(owned, "notes.txt"), "keep\n");
    await assertClaimableStateDir(owned);
    const dirty = join(root, "dirty");
    await mkdir(dirty);
    await writeFile(join(dirty, "notes.txt"), "keep\n");
    await assert.rejects(() => assertClaimableStateDir(dirty), /not empty and is not a dev-stack state directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compose cleanup is registered before steps that follow compose up", () => {
  const start = scriptSource.indexOf("async function runUp");
  const end = scriptSource.indexOf("async function restartBuiltServices");
  const up = scriptSource.slice(start, end);
  const shutdown = up.indexOf("const shutdown = async");
  const namespace = up.indexOf("await ensureTemporalNamespace");
  const install = up.indexOf("await installOpenCode");
  const build = up.indexOf("await buildPackages");
  const migrate = up.indexOf('await runLogged(["npm", "run", "db:migrate"]');
  const ready = up.indexOf("await waitForReady");
  assert.ok(shutdown !== -1 && shutdown < namespace);
  assert.ok(namespace < install && install < build && build < migrate && migrate < ready);
  assert.match(up.slice(shutdown, namespace), /DOWN_COMPOSE_ARGS/);
  const failure = up.lastIndexOf("} catch (error) {");
  assert.ok(failure > ready);
  assert.match(up.slice(failure), /await shutdown\(1\)/);
});

test("state directories cannot replace the checkout, home, or an install path", () => {
  assert.deepEqual(stateDirPathProblems(join(repoRoot, ".dev-stack")), []);
  assert.deepEqual(stateDirPathProblems(join(tmpdir(), "spaceapp-dev-stack-ok")), []);
  for (const unsafe of ["/", homedir(), repoRoot, join(repoRoot, ".."), join(repoRoot, "tmp"), join(repoRoot, "scripts")]) {
    assert.ok(stateDirPathProblems(unsafe).length > 0, unsafe);
    assert.throws(() => assertSafeStateDir(unsafe), /Refusing|must live in \.dev-stack/);
  }
});

test("secrets are mode 0600 and stay stable for an existing state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-secrets-"));
  try {
    const first = await ensureSecrets(root);
    const second = await ensureSecrets(root);
    assert.deepEqual(second, first);
    assert.match(first.password, /^[a-f0-9]{48}$/);
    assert.equal(first.setupToken.includes("\n"), false);
    for (const name of ["postgres-password", "session-secret", "setup-token"]) {
      const info = await stat(join(root, name));
      assert.equal(info.mode & 0o777, 0o600, name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process environment stays off dev-login and off installed paths", () => {
  const previous = process.env.SPACE_DEV_LOGIN;
  process.env.SPACE_DEV_LOGIN = "true";
  try {
    const ports = resolvePorts({});
    const { env, overrides } = devProcessEnv({
      stateDir: join(tmpdir(), "spaceapp-dev-env"),
      ports,
      databaseUrl: "postgres://spaceapp:secret-value@127.0.0.1:55432/spaceapp",
      sessionSecret: "s".repeat(32)
    });
    assert.equal(env.SPACE_DEV_LOGIN, "false");
    assert.equal(env.SPACE_INSTANCE, "dev");
    assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
    assert.equal(env.SPACE_CLI_ROOT_ENABLED, "false");
    assert.equal(env.SPACE_DATABASE_URL.includes("/spaceapp"), true);
    assert.equal(env.SPACE_DATABASE_URL.endsWith("/space"), false);
    const keys = installedPathFallbacks(configSource);
    assert.ok(keys.length > 5);
    for (const key of keys) {
      assert.equal(Object.hasOwn(overrides, key), true, `${key} still falls back to an installed path`);
      const value = String(overrides[key]);
      assert.equal(value.includes("/opt/spaceapp"), false, key);
      assert.equal(value.includes("/var/lib/spaceapp"), false, key);
    }
  } finally {
    if (previous === undefined) delete process.env.SPACE_DEV_LOGIN;
    else process.env.SPACE_DEV_LOGIN = previous;
  }
});

test("the API is watched from source and the web app binds loopback", () => {
  const commands = serviceCommands({ ports: DEFAULT_PORTS });
  assert.deepEqual(commands.api.args.slice(1, 4), ["watch", "--clear-screen=false", "src/server.ts"]);
  assert.equal(commands.web.args.includes("127.0.0.1"), true);
  assert.equal(commands.web.args.includes("--strictPort"), true);
  assert.equal(commands.web.args.includes("0.0.0.0"), false);
  assert.match(commands["cli-host"].args.at(-1), /packages\/cli-host\/src\/main\.ts$/);
  assert.match(commands.worker.args[0], /apps\/worker\/dist\/worker\.js$/);
});

test("the OpenCode wrapper keeps provider state in the dev-stack directory", () => {
  const stateDir = join(tmpdir(), "spaceapp-dev-wrapper");
  const text = renderOpenCodeWrapper({ stateDir, repo: repoRoot, packageSpec: "@opencode/cli@9.9.9" });
  assert.match(text, /printf 'READY\\n'/);
  assert.match(text, new RegExp(stateDir.replaceAll("\\", "\\\\")));
  assert.match(text, /cli-state\/providers\/opencode/);
  assert.equal(text.includes("/var/lib/spaceapp"), false);
  assert.equal(text.includes("/opt/spaceapp"), false);
  assert.match(text, /sha256sum|shasum -a 256/);
  assert.match(text, /opencode-first-run\.mjs/);
  assert.match(text, /--server/);
});

test("logs drop database URLs and the setup token", () => {
  const token = "abc123def456abc123def456abc123de";
  const raw = [
    "postgres://spaceapp:secret-value@127.0.0.1:55432/spaceapp",
    "One-time owner setup token:",
    `  ${token}`,
    `token=${token}`
  ].join("\n");
  const cleaned = scrubSecrets(raw, [token]);
  assert.equal(cleaned.includes("secret-value"), false);
  assert.equal(cleaned.includes(token), false);
  assert.match(cleaned, /postgres:\/\/\[redacted\]/);
});

test("down keeps volumes and reset removes them", () => {
  assert.equal(DOWN_COMPOSE_ARGS.includes("-v"), false);
  assert.equal(RESET_COMPOSE_ARGS.includes("-v"), true);
  const args = composeArgs("/tmp/compose.yml", COMPOSE_PROJECT, ...RESET_COMPOSE_ARGS);
  assert.deepEqual(args.slice(0, 4), ["-p", COMPOSE_PROJECT, "-f", "/tmp/compose.yml"]);
});

test("a child exit is reported instead of leaving the stack half running", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 30)"], { stdio: "ignore" });
  const lines = [];
  bindChildFailure([{ name: "worker", child, logPath: "/tmp/worker.log" }], (line) => lines.push(line));
  await new Promise((resolve) => child.once("exit", resolve));
  assert.match(lines[0], /dev-stack: worker exited unexpectedly \(exit code 3\)/);
  assert.match(lines[0], /shutting the stack down so nothing is left half-running/);
  assert.match(failureLine("api", null, "SIGTERM", "/tmp/api.log"), /signal SIGTERM/);
});

test("process identity uses start time, so a recycled pid is not killed", { skip: process.platform !== "linux" }, async () => {
  const parsed = parseProcStat(await readFile("/proc/self/stat", "utf8"));
  assert.equal(typeof parsed.starttime, "string");
  assert.ok(parsed.starttime.length > 0);
  const held = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const identity = await readProcessIdentity(held.pid);
    assert.equal(identity.starttime, parseProcStat(await readFile(`/proc/${held.pid}/stat`, "utf8")).starttime);
    assert.equal(await processIdentityMatches({ pid: held.pid, starttime: "not-this-process" }), false);
    assert.equal(await stopRecordedProcess({ pid: held.pid, starttime: "not-this-process" }), false);
    assert.equal(await processIdentityMatches(identity), true);
    assert.equal(await stopRecordedProcess(identity), true);
    assert.equal(await processIdentityMatches(identity), false);
  } finally {
    try { process.kill(held.pid, "SIGKILL"); } catch { /* already stopped */ }
  }
});

test("OpenCode cleanup only matches processes from this state directory", () => {
  const stateDir = "/tmp/spaceapp-dev-owned";
  assert.equal(cwdBelongsToState(stateDir, `${stateDir}/cli-state/providers/opencode`), true);
  assert.equal(cwdBelongsToState(stateDir, "/tmp/other"), false);
  assert.equal(executableBelongsToState(stateDir, `${stateDir}/tools/opencode/node_modules/.bin/opencode`), true);
  assert.equal(executableBelongsToState(stateDir, "/usr/local/bin/opencode"), false);
});

test("image pull retries only transient registry failures", () => {
  assert.equal(pullFailureIsTransient("docker compose pull failed (1)\nnet/http: request canceled (Client.Timeout exceeded while awaiting headers)"), true);
  assert.equal(pullFailureIsTransient("toomanyrequests: You have reached your pull rate limit"), true);
  assert.equal(pullFailureIsTransient("manifest unknown"), false);
  assert.equal(pullFailureIsTransient("postgres-password must be mode 0600."), false);
});

test("the gate reads the session cookie and builds a loopback terminal socket", () => {
  const cookie = sessionCookieFrom([
    "other=1; Path=/",
    "space_session_dev=session-token; HttpOnly; Path=/"
  ], "space_session_dev");
  assert.equal(cookie, "session-token");
  const url = new URL(terminalSocketUrl("http://127.0.0.1:5910", "pane:1", {
    sessionId: "cli_session:1",
    token: "a".repeat(24)
  }));
  assert.equal(url.protocol, "ws:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, `/api/panes/${encodeURIComponent("pane:1")}/cli/terminal`);
  assert.equal(url.searchParams.get("sessionId"), "cli_session:1");
  assert.equal(url.searchParams.get("initialCols"), "80");
  const frame = terminalFrameText(JSON.stringify({ type: "output", data: "OpenCode \u001b[0m" }));
  assert.match(frame, /OpenCode/);
  assert.equal(frame.includes(String.fromCharCode(0x1b)), true);
});
