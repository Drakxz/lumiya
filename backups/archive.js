const crypto = require("node:crypto");
const zlib = require("node:zlib");

const MAGIC = Buffer.from("MDSBACKUP1\0", "ascii");
function keyFrom(value) {
  if (!value) return null;
  const raw = Buffer.from(value, "base64");
  if (raw.length === 32) return raw;
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
  throw new Error("BACKUP_ENCRYPTION_KEY deve conter 32 bytes em base64 ou 64 caracteres hex.");
}
function encode(data, secret) {
  const zipped = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9, mtime: 0 });
  const key = keyFrom(secret);
  if (!key) return Buffer.concat([MAGIC, Buffer.from([0]), zipped]);
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(zipped), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
function decode(input, secret) {
  const data = Buffer.from(input);
  if (data.length < MAGIC.length + 1 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Arquivo de backup inválido ou incompatível.");
  const encrypted = data[MAGIC.length];let zipped;
  if (encrypted === 0) zipped = data.subarray(MAGIC.length + 1);
  else if (encrypted === 1) {
    const key = keyFrom(secret);
    if (!key) throw new Error("Este backup está criptografado. Configure BACKUP_ENCRYPTION_KEY para restaurá-lo.");
    const offset = MAGIC.length + 1, iv = data.subarray(offset, offset + 12), tag = data.subarray(offset + 12, offset + 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);decipher.setAuthTag(tag);
    zipped = Buffer.concat([decipher.update(data.subarray(offset + 28)), decipher.final()]);
  } else throw new Error("Formato de backup desconhecido.");
  return JSON.parse(zlib.gunzipSync(zipped).toString("utf8"));
}
module.exports = { encode, decode, MAGIC };
