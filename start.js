const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LOCK_FILE = path.join(__dirname, ".bot-instance.lock");

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
      console.error(`[BOT] Já existe uma instância rodando (PID ${pid}). Encerrando esta para evitar respostas duplicadas.`);
      process.exit(0);
    }
  } catch { /* sem trava existente */ }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE);
    } catch { /* já removida */ }
  };
  process.once("exit", release);
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  return release;
}

function restartDelay(failures, now, windowMs = 10 * 60_000) {
  const recent = failures.filter(time => now - time < windowMs);
  if (recent.length >= 5) return null;
  return Math.min(30_000, 1000 * 2 ** Math.max(0, recent.length - 1));
}

function supervise() {
  let child = null;
  let stopping = false;
  let timer = null;
  let killTimer = null;
  let failures = [];
  function launch() {
    if (stopping) return;
    child = fork(path.join(__dirname, "index.js"), [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
    const launched = child;
    let completed = false;
    function finish(code, signal) {
      if (completed) return;
      completed = true;
      child = null;
      clearTimeout(killTimer);
      if (stopping || code === 0) { process.exitCode = stopping ? 0 : code; return; }
      if (code === 78) {
        console.error("[ANTICRASH] Erro de configuração/token/intents. Corrija a configuração antes de iniciar novamente.");
        process.exitCode = 78;
        return;
      }
      const now = Date.now();
      failures = failures.filter(time => now - time < 10 * 60_000);
      failures.push(now);
      const delay = restartDelay(failures, now);
      if (delay === null) {
        console.error("[ANTICRASH] Limite de 5 quedas em 10 minutos atingido. Reinício interrompido; consulte logs/anticrash.log.");
        process.exitCode = 1;
        return;
      }
      console.error(`[ANTICRASH] Processo encerrado (${code ?? signal}); reiniciando em ${delay / 1000}s.`);
      timer = setTimeout(launch, delay);
    }
    launched.once("error", error => {
      console.error("[ANTICRASH] Falha ao iniciar o processo:", error.message);
      finish(1, null);
    });
    launched.once("exit", finish);
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    if (!child) return;
    // IPC permite ao filho salvar o SQLite também no Windows. SIGTERM enviado
    // com child.kill() pode terminar o processo sem seus hooks nessa plataforma.
    if (child.connected) child.send({ type: "mds:shutdown" }, () => {});
    else child.kill("SIGTERM");
    killTimer = setTimeout(() => { if (child) child.kill("SIGKILL"); }, 5000);
    killTimer.unref();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  launch();
}

if (require.main === module) {
  acquireLock();
  supervise();
}
module.exports = { restartDelay, acquireLock };
