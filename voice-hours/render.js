const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { formatDuration, weekLabel } = require("./time");
const fs = require("node:fs");
const path = require("node:path");
const backgroundImage = loadImage(fs.readFileSync(path.join(__dirname, "hours-background.png")));

function round(ctx, x, y, width, height, radius = 20) {
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
}

function fitText(ctx, text, width) {
  const chars = Array.from(String(text));
  if (ctx.measureText(chars.join("")).width <= width) return chars.join("");
  while (chars.length && ctx.measureText(chars.join("") + "…").width > width) chars.pop();
  return chars.join("") + "…";
}

function icon(ctx, x, y, muted) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = muted ? "#c4caff" : "#8bddff";
  ctx.lineWidth = 2.8; ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (muted) {
    // Microfone sólido, suporte separado e corte com fundo para uma silhueta limpa.
    ctx.fillStyle = "#c4caff";
    round(ctx, -5.5, -15, 11, 22, 5.5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-11, -2); ctx.lineTo(-11, 1);
    ctx.bezierCurveTo(-11, 16, 11, 16, 11, 1); ctx.lineTo(11, -2);
    ctx.moveTo(0, 13); ctx.lineTo(0, 19); ctx.moveTo(-7, 19); ctx.lineTo(7, 19);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-17, -16); ctx.lineTo(17, 18);
    ctx.lineWidth = 7; ctx.strokeStyle = "#253057"; ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = "#f3f1ff"; ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.6;
    for (let n = 0; n < 4; n++) {
      const angle = n * Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(angle) * 13, Math.sin(angle) * 13);
      ctx.lineTo(Math.cos(angle) * 15, Math.sin(angle) * 15); ctx.stroke();
    }
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(0, 0); ctx.lineTo(8, 5); ctx.stroke();
    ctx.fillStyle = "#e4f7ff"; ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

const AVATAR_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
const avatarHostValido = url => AVATAR_HOSTS.includes(url.hostname) && url.protocol === 'https:';

async function getAvatar(url) {
  if (!url) return null;
  const parsed = new URL(url);
  if (!avatarHostValido(parsed)) return null;
  try {
    // Avatares animados (.gif) costumam ser servidos via redirect ao media proxy.
    const response = await fetch(parsed, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    const destino = new URL(response.url || url);
    if (!avatarHostValido(destino)) return null;
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return null;
    if (Number(response.headers.get("content-length")) > 8_000_000) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8_000_000) return null;
    // loadImage decodifica o GIF animado; drawImage usa o primeiro frame.
    return await loadImage(bytes);
  } catch { return null; }
}

async function renderHoursCard({ name, avatarURL, stats, maintenance=null }) {
  const [avatar, background] = await Promise.all([getAvatar(avatarURL), backgroundImage]);
  // Cartão ampliado em 16:9: formato retangular largo, aproveitando os
  // até 400px de largura que o Discord usa para imagens em embed.
  // K aumenta o cartão e todos os seus elementos; S é a densidade do PNG.
  const W = 1280, H = 720, K = 1.25, S = 2;
  const canvas = createCanvas(W * K * S, H * K * S);
  const ctx = canvas.getContext("2d");
  ctx.scale(S * K, S * K);
  const font = '"Segoe UI", "DejaVu Sans", sans-serif';

  const bgScale = Math.max(W / background.width, H / background.height);
  const bgWidth = background.width * bgScale, bgHeight = background.height * bgScale;
  ctx.drawImage(background, (W - bgWidth) / 2, (H - bgHeight) / 2, bgWidth, bgHeight);
  round(ctx, 18, 18, W - 36, H - 36, 28);
  ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fill();
  ctx.strokeStyle = "rgba(215,215,215,0.28)"; ctx.lineWidth = 1; ctx.stroke();

  // Bloco centralizado verticalmente no cartão.
  const topo = 64, margem = 60, largura = W - margem * 2;
  const cabecalho = 120;
  round(ctx, margem, topo, cabecalho, cabecalho, 24); ctx.fillStyle = "rgba(0,0,0,0.48)"; ctx.fill();
  ctx.beginPath(); ctx.arc(margem + 60, topo + 60, 54, 0, Math.PI * 2); ctx.fillStyle = "#111"; ctx.fill();
  ctx.save(); ctx.clip();
  if (avatar) ctx.drawImage(avatar, margem + 6, topo + 6, 108, 108);
  else {
    ctx.fillStyle = "#eee"; ctx.font = `600 46px ${font}`; ctx.textAlign = "center";
    ctx.fillText(Array.from(name)[0]?.toUpperCase() || "?", margem + 60, topo + 82);
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(margem + 60, topo + 60, 56, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(235,235,235,0.55)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = "left";
  ctx.fillStyle = "#f1f1f1"; ctx.font = `700 42px ${font}`;
  ctx.fillText(fitText(ctx, name, largura - 180), margem + 148, topo + 52);
  ctx.fillStyle = "#b9b9b9"; ctx.font = `24px ${font}`;
  ctx.fillText("Tempo em call", margem + 148, topo + 94);

  const espaco = 30, cartaoLargura = (largura - espaco) / 2, cartaoAltura = 140;
  const linha1 = topo + cabecalho + 24, linha2 = linha1 + cartaoAltura + 20;
  function card(x, y, title, duration) {
    round(ctx, x, y, cartaoLargura, cartaoAltura, 20);
    ctx.fillStyle = "rgba(10,10,10,0.5)"; ctx.fill();
    ctx.strokeStyle = "rgba(220,220,220,0.22)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#bcbcbc"; ctx.font = `24px ${font}`;
    ctx.fillText(fitText(ctx, title, cartaoLargura - 34), x + 20, y + 40);
    let size = 46;
    const value = formatDuration(duration);
    do { ctx.font = `700 ${size--}px ${font}`; } while (ctx.measureText(value).width > cartaoLargura - 40 && size > 26);
    ctx.fillStyle = "#f5f5f5"; ctx.fillText(value, x + 20, y + 100);
  }
  card(margem, linha1, `Atual · desmutado (${weekLabel(stats.weekStart)})`, stats.weekCallMs);
  card(margem + cartaoLargura + espaco, linha1, `Atual · mutado (${weekLabel(stats.weekStart)})`, stats.weekMutedMs);
  card(margem, linha2, `Passada · desmutado (${weekLabel(stats.lastWeekStart)})`, stats.lastWeekCallMs);
  card(margem + cartaoLargura + espaco, linha2, `Passada · mutado (${weekLabel(stats.lastWeekStart)})`, stats.lastWeekMutedMs);

  const faixaY = linha2 + cartaoAltura + 24, faixaAltura = 120;
  round(ctx, margem, faixaY, largura, faixaAltura, 20);
  ctx.fillStyle = "rgba(10,10,10,0.5)"; ctx.fill();
  ctx.strokeStyle = "rgba(220,220,220,0.22)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#bcbcbc"; ctx.font = `24px ${font}`;
  if (maintenance?.requiredMs) {
    const lead = "Meta semanal para manter ";
    ctx.fillText(lead, margem + 22, faixaY + 44);
    const leadWidth = ctx.measureText(lead).width;
    ctx.save();
    ctx.shadowColor = maintenance.roleColor || "#ffffff"; ctx.shadowBlur = 9;
    ctx.fillStyle = maintenance.roleColor || "#ffffff";
    ctx.fillText(fitText(ctx, maintenance.roleName, largura - leadWidth - 44), margem + 22 + leadWidth, faixaY + 44);
    ctx.restore();
    ctx.fillStyle = "#d8d8d8"; ctx.font = `700 24px ${font}`;
    ctx.fillText(`Horas feitas: ${formatDuration(stats.weekCallMs)}  |  Necessárias: ${formatDuration(maintenance.requiredMs)}`,
      margem + 22, faixaY + 88);
  } else ctx.fillText("Sem meta configurada para manter o cargo.", margem + 22, faixaY + 68);
  return canvas.toBuffer("image/png");
}

module.exports = { renderHoursCard };
