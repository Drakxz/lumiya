const test = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {installProcessProtection, redact} = require("../anticrash/runtime");
const {restartDelay} = require("../start");

function fixture(t) {
  const base = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
  fs.mkdirSync(base, {recursive: true});
  const directory = fs.mkdtempSync(path.join(base, "anticrash-test-"));
  const proc = new EventEmitter();
  proc.env = {DISCORD_TOKEN: "secret-test-token-123456789"};
  const exits = [], output = [];
  proc.exit = code => exits.push(code);
  const guard = installProcessProtection({proc, logDirectory: directory, stderr: line => output.push(line)});
  t.after(() => {guard.dispose();fs.rmSync(directory, {recursive: true, force: true});});
  return {proc, guard, exits, output, directory};
}

test("known Discord API rejections are logged without terminating the process", t => {
  const f = fixture(t);
  const error = Object.assign(new Error("Invalid Form Body"), {name: "DiscordAPIError[50035]", code: 50035});
  f.proc.emit("unhandledRejection", error);
  assert.equal(f.exits.length, 0);
  assert.ok(fs.readFileSync(path.join(f.directory, "anticrash.log"), "utf8").includes("Invalid Form Body"));
});

test("programming exceptions terminate safely instead of continuing with corrupted state", t => {
  const f = fixture(t);
  f.proc.emit("uncaughtException", new TypeError("Unexpected undefined"));
  f.proc.emit("uncaughtException", new Error("Repeated exception"));
  assert.deepEqual(f.exits, [1]);
});

test("unknown unhandled promises are fatal, while network failures are diagnostic", t => {
  const f = fixture(t);
  f.proc.emit("unhandledRejection", Object.assign(new Error("Connection reset"), {code: "ECONNRESET"}));
  assert.equal(f.exits.length, 0);
  f.proc.emit("unhandledRejection", new TypeError("Programming error"));
  assert.deepEqual(f.exits, [1]);
});

test("invalid credentials use a permanent configuration exit status", t => {
  const f = fixture(t);
  f.guard.loginFailure(Object.assign(new Error("Invalid token"), {code: "TokenInvalid"}));
  assert.deepEqual(f.exits, [78]);
});

test("client API errors, gateway failures and invalidated sessions are handled", t => {
  const f = fixture(t), client = new EventEmitter();
  f.guard.bindClient(client);f.guard.bindClient(client);
  assert.equal(client.listenerCount("error"), 1);
  client.emit("error", Object.assign(new Error("No permission"), {name: "DiscordAPIError[50013]", code: 50013}));
  client.emit("shardError", new Error("Temporary gateway failure"));
  assert.equal(f.exits.length, 0);
  client.emit("invalidated");
  assert.deepEqual(f.exits, [1]);
});

test("tokens and webhook credentials are redacted from logs", t => {
  const f = fixture(t);
  f.guard.log("TEST", new Error(`token=${f.proc.env.DISCORD_TOKEN} https://discord.com/api/v10/webhooks/123456789012345678/private-webhook-token/messages/@original`));
  const log = fs.readFileSync(path.join(f.directory, "anticrash.log"), "utf8");
  assert.equal(log.includes(f.proc.env.DISCORD_TOKEN), false);
  assert.equal(log.includes("private-webhook-token"), false);
  assert.ok(redact("Authorization: Bot another-secret-token").includes("[REDACTED]"));
});

test("duplicate diagnostics are suppressed and protection can be cleanly removed", t => {
  const f = fixture(t);
  f.guard.log("TEST", "Repeated message");f.guard.log("TEST", "Repeated message");
  assert.equal(f.output.length, 1);
  assert.equal(installProcessProtection({proc: f.proc}), f.guard);
  f.guard.dispose();assert.equal(f.proc.listenerCount("uncaughtException"), 0);
});

test("IPC shutdown triggers existing graceful save hooks", t => {
  const f = fixture(t);let saved = false;
  f.proc.once("SIGTERM", () => {saved = true;});
  f.proc.emit("message", {type: "mds:shutdown"});assert.equal(saved, true);
});

test("restart backoff is bounded and stops a crash loop", () => {
  const now = Date.now();
  assert.equal(restartDelay([now], now), 1000);
  assert.equal(restartDelay([now, now], now), 2000);
  assert.equal(restartDelay([now, now, now, now], now), 8000);
  assert.equal(restartDelay(Array(5).fill(now), now), null);
  assert.equal(restartDelay([now - 600001, now], now), 1000);
});
