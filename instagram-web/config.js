const path = require("node:path");
const { z } = require("zod");
const id = z.string().regex(/^\d{17,20}$/);
const roles = z.array(id).max(100);
const art=z.string().regex(/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s?#]+(?:\?[^\s]*)?$/).or(z.literal(""));
const settingsSchema = z.object({
  channelId: id, logChannelId: id.nullable().default(null),
  allowedRoles: roles.default([]), blockedRoles: roles.default([]),
  moderatorRoles: roles.default([]), vipRoles: roles.default([]),
  maxImages: z.number().int().min(1).max(5).default(5),
  maxBytes: z.number().int().min(1024).max(10*1024*1024).default(10*1024*1024),
  allowVideo: z.boolean().default(true),
  maxVideoBytes: z.number().int().min(1024).max(24*1024*1024).default(20*1024*1024),
  maxVideoSeconds: z.number().int().min(1).max(120).default(15),
  dailyLimit: z.number().int().min(1).max(100).default(10),
  cooldownSeconds: z.number().int().min(0).max(86400).default(300),
  vipDailyLimit: z.number().int().min(1).max(200).default(20),
  vipCooldownSeconds: z.number().int().min(0).max(86400).default(120),
  captionLimit: z.number().int().min(0).max(500).default(500),
  minMembershipHours: z.number().int().min(0).max(8760).default(0),
  allowDelete: z.boolean().default(true), allowEdit: z.boolean().default(true),
  allowInstagram: z.boolean().default(true), manualReview: z.boolean().default(false),
  maintenance: z.boolean().default(false),
  forbiddenWords: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  name: z.string().trim().min(1).max(80).default("Comunidade"),
  logo: art.default(""),banner:art.default(""),favicon:art.default(""),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#c6b5ff"),
  invite: z.string().regex(/^https:\/\/discord\.gg\/[a-zA-Z0-9-]+$/).or(z.literal("")).default(""),
  rules: z.string().max(6000).default("Compartilhe somente fotografias que você tem autorização para publicar. Respeite a comunidade. Não publique informações pessoais ou conteúdo sexual, violento ou ofensivo."),
  notice: z.string().max(1000).default("")
}).strict();
function config(env) {
  const required = ["DISCORD_CLIENT_ID","DISCORD_CLIENT_SECRET","DISCORD_GUILD_ID","DISCORD_REDIRECT_URI","APP_URL","SESSION_SECRET","OPENAI_API_KEY"];
  for(const key of required)if(!env[key]?.trim())throw new Error(`Instagram Web: configure ${key}.`);
  id.parse(env.DISCORD_GUILD_ID); id.parse(env.DISCORD_CLIENT_ID);
  if(Buffer.byteLength(env.SESSION_SECRET)<32)throw new Error("Instagram Web: SESSION_SECRET precisa de pelo menos 32 bytes aleatórios.");
  const app = new URL(env.APP_URL), redirect = new URL(env.DISCORD_REDIRECT_URI);
  if(!["http:","https:"].includes(app.protocol)||app.username||app.password||redirect.username||redirect.password)throw new Error("Instagram Web: APP_URL deve ser uma origem HTTP(S) válida.");
  if(app.origin!==redirect.origin||redirect.pathname!=="/api/auth/discord/callback")throw new Error("Instagram Web: redirect URI incompatível com APP_URL.");
  if(env.NODE_ENV==="production"&&app.protocol!=="https:")throw new Error("Instagram Web: HTTPS é obrigatório em produção.");
  if(env.OPENAI_MODERATION_MODEL && env.OPENAI_MODERATION_MODEL!=="omni-moderation-latest")throw new Error("Instagram Web exige omni-moderation-latest.");
  return {guildId:env.DISCORD_GUILD_ID,clientId:env.DISCORD_CLIENT_ID,secret:env.DISCORD_CLIENT_SECRET,
    redirect:redirect.href,origin:app.origin,sessionSecret:env.SESSION_SECRET,secure:app.protocol==="https:",
    host:env.WEB_HOST||"127.0.0.1",port:Number(env.PORT||3000),identifyPremium:env.DISCORD_IDENTIFY_PREMIUM_ENABLED==="true",
    storage:path.resolve(env.STORAGE_PATH||"database/instagram-web-private"),
    maxStorageBytes:Number(env.WEB_MAX_STORAGE_MB||512)*1024*1024,
    initialChannel:env.DISCORD_INSTAGRAM_CHANNEL_ID,initialLog:env.DISCORD_LOG_CHANNEL_ID||null,invite:env.DISCORD_SERVER_INVITE||""};
}
module.exports={config,settingsSchema,id};
