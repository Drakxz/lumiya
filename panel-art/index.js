// Arte dos painéis adaptada ao servidor que publicou o painel.
// As artes canônicas trazem a marca "mds" como texto; aqui essa marca é
// detectada e substituída pelo nome do servidor antes de gerar o PNG final.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const { serverName } = require("../brand");

// URLs usadas diretamente nos painéis do servidor sla (sem PNG gerado).
const SLA_SUPPORT_ART = "https://cdn.discordapp.com/attachments/1570868736926425190/1572050502722519060/file_00000000cde0820e900ded3f6647c07d.png";
const SLA_MIGRATION_ART = "https://cdn.discordapp.com/attachments/1570868736926425190/1572056151334592662/file_000000008e48820ea3d0856052e2f3ae.png";

const FONT_PATH = path.join(__dirname, "font.ttf");
if (fs.existsSync(FONT_PATH)) GlobalFonts.registerFromPath(FONT_PATH, "ArtSerif");
const FONT = GlobalFonts.families.some(f => f.family === "ArtSerif") ? "ArtSerif" : "Georgia";

const BRAND = /\bmds\b/i;
const TEMPLATES = {
  support: {
    file: "support.png",
    label: "suporte",
    // Região da marca na arte original (x, y, largura, altura).
    brand: { x: 902, y: 476, w: 170, h: 66 },
    size: 38
  },
  migration: {
    file: "migration.jpg",
    label: "migração",
    brand: { x: 998, y: 412, w: 180, h: 70 },
    size: 38
  }
};

function replaceBrand(text, guild) {
  const name = serverName(guild);
  return BRAND.test(String(text ?? "")) ? String(text).replace(BRAND, name) : String(text ?? "");
}

async function maskBuffer(width, height, region) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const cx = region.x + region.w / 2, cy = region.y + region.h / 2;
  const radius = Math.max(region.w, region.h) * 0.72;
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.25, cx, cy, radius);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.65, "rgba(255,255,255,0.95)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(region.x, region.y, region.w, region.h);
  return canvas.toBuffer("image/png");
}

async function fitFont(ctx, text, maxWidth, size) {
  let current = size;
  ctx.font = `italic ${current}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && current > 14) {
    current -= 2;
    ctx.font = `italic ${current}px ${FONT}`;
  }
  return current;
}

const cache = new Map();

async function renderPanelArt(kind, guild) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`Arte desconhecida: ${kind}`);
  const guildId = typeof guild === "string" ? guild : guild?.id;
  const key = `${kind}:${guildId || "sem-id"}:${serverName(guild)}`;
  if (cache.has(key)) return cache.get(key);

  const source = fs.readFileSync(path.join(__dirname, template.file));
  const meta = await sharp(source).metadata();
  const blurred = await sharp(source).blur(16).toBuffer();
  const patch = await sharp(blurred)
    .composite([{ input: await maskBuffer(meta.width, meta.height, template.brand), blend: "dest-in" }])
    .png()
    .toBuffer();
  const cleaned = await sharp(source)
    .composite([{ input: patch, blend: "over" }])
    .png()
    .toBuffer();

  const image = await loadImage(cleaned);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  // Substitui a marca detectada ("mds") pelo nome do servidor.
  const brand = replaceBrand("mds", guild);
  const centerX = template.brand.x + template.brand.w / 2;
  const centerY = template.brand.y + template.brand.h / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.shadowColor = "rgba(10,14,40,0.55)";
  ctx.shadowBlur = 10;
  await fitFont(ctx, brand, template.brand.w + 260, template.size);
  ctx.fillText(brand, centerX, centerY, template.brand.w + 260);

  const output = canvas.toBuffer("image/png");
  if (cache.size > 200) cache.clear();
  cache.set(key, output);
  return output;
}

module.exports = { renderPanelArt, replaceBrand, BRAND, TEMPLATES, SLA_SUPPORT_ART, SLA_MIGRATION_ART };
