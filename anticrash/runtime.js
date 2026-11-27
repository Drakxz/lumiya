const fs = require("node:fs");
const path = require("node:path");

const INSTALLED = Symbol.for("mds.runtimeProtection");
const NETWORK = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "GuildMembersTimeout"]);
const CONFIG = new Set(["TokenInvalid", "DisallowedIntents", 4004, 4014, 401, 50014]);

function redact(value, env = process.env) {
  let result = String(value);
  for (const [key, secret] of Object.entries(env)) {
    if (/(TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(key) && typeof secret === "string" && secret.length >= 6) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result
    .replace(/(\/webhooks\/\d+\/)[^\s/?"']+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)(?:Bot\s+|Bearer\s+)?[^\s,}"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,})\b/g, "[REDACTED]");
}

function operational(error) {
  return error?.name === "DiscordAPIError" || /^DiscordAPIError\[/.test(error?.name || "") ||
    NETWORK.has(error?.code) || ["AbortError", "TimeoutError", "GatewayRateLimitError"].includes(error?.name);
}

function installProcessProtection({ proc = process, logDirectory = path.join(__dirname, "..", "logs"), stderr = console.error } = {}) {
  if (proc[INSTALLED]) return proc[INSTALLED];
  let exiting = false;
  const clients = new WeakSet();
  const clientHooks = [];
  const hooks = [];
  const file = path.join(logDirectory, "anticrash.log");
  const recent = new Map();

  function log(kind, error) {
    try {
      const detail = redact(error instanceof Error ? (error.stack || error.message) : String(error), proc.env).slice(0, 12000);
      const key = `${kind}:${detail}`;
      const now = Date.now();
      if (recent.has(key) && now - recent.get(key) < 10_000) return;
      if (recent.size >= 100) recent.clear();
      recent.set(key, now);
      const line = `[${new Date(now).toISOString()}] [${kind}] ${detail}\n`;
      stderr(line.trimEnd());
      fs.mkdirSync(logDirectory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
        fs.renameSync(file, file + ".previous");
      }
      fs.appendFileSync(file, line, "utf8");
    } catch {
      // A falha do próprio logger nunca provoca recursão de erros.
      try { stderr("[ANTICRASH] Não foi possível gravar o diagnóstico."); } catch {}
    }
  }
  function fatal(error, code = 1) {
    if (exiting) return;
    exiting = true;
    log("FATAL", error);
    // Não continua executando num estado possivelmente corrompido. Os hooks
    // síncronos de exit já existentes salvam/fecham o SQLite antes de sair.
    proc.exit(code);
  }
  function add(event, handler) { proc.on(event, handler); hooks.push([event, handler]); }
  add("uncaughtException", error => fatal(error));
  add("unhandledRejection", error => {
    if (CONFIG.has(error?.code)) fatal(error, 78);
    else if (operational(error)) log("PROMISE/API", error);
    else fatal(error);
  });
  add("warning", warning => log("WARNING", warning));
  add("message", message => {
    if (message?.type !== "mds:shutdown") return;
    if (proc.listenerCount("SIGTERM")) proc.emit("SIGTERM");
    else proc.exit(0);
  });
  const api = {
    log, fatal,
    loginFailure(error) { fatal(error, CONFIG.has(error?.code) ? 78 : 1); },
    bindClient(client) {
      if (clients.has(client)) return;
      clients.add(client);
      const bind = (event, handler) => { client.on(event, handler); clientHooks.push([client, event, handler]); };
      const report = error => {
        if (CONFIG.has(error?.code)) fatal(error, 78);
        else if (operational(error)) log("DISCORD/API", error);
        else fatal(error);
      };
      // discord.js já utiliza captureRejections: rejeições de listeners async
      // chegam ao evento error em vez de derrubar o processo sem diagnóstico.
      bind("error", report);
      bind("shardError", error => {
        if (CONFIG.has(error?.code)) fatal(error, 78);
        else log("GATEWAY", error); // O discord.js reconecta o Gateway.
      });
      bind("warn", warning => log("DISCORD/WARNING", warning));
      bind("invalidated", () => fatal(new Error("Sessão Discord invalidada; reinício necessário.")));
    },
    dispose() {
      for (const [event, handler] of hooks) proc.removeListener(event, handler);
      for (const [client, event, handler] of clientHooks) client.removeListener(event, handler);
      delete proc[INSTALLED];
    }
  };
  proc[INSTALLED] = api;
  return api;
}

module.exports = { installProcessProtection, operational, redact };
