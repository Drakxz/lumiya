const { spawn } = require("node:child_process");
const ffmpeg = require("ffmpeg-static");

// Gemini TTS: WAV PCM mono, 16 bits. Derive real duration and waveform from PCM,
// rather than inventing voice-message metadata.
function wavMetadata(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 ||
      wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV inválido");
  }
  let format;
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("WAV truncado");
    if (name === "fmt " && size >= 16) {
      format = {
        type: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14)
      };
    }
    if (name === "data") pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || format.type !== 1 || format.channels !== 1 || format.bits !== 16 ||
      !format.rate || !pcm?.length || pcm.length % 2) throw new Error("PCM de voz inválido");
  const samples = pcm.length / 2;
  const duration = samples / format.rate;
  if (duration > 120) throw new Error("Áudio longo demais");
  const waveform = Buffer.alloc(Math.min(256, samples));
  for (let i = 0; i < waveform.length; i++) {
    const start = Math.floor(i * samples / waveform.length);
    const end = Math.floor((i + 1) * samples / waveform.length);
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(j * 2)));
    waveform[i] = Math.min(255, Math.round(peak / 32768 * 255));
  }
  return { duration, waveform: waveform.toString("base64") };
}

async function encodeVoiceMessage(wav) {
  const metadata = wavMetadata(wav);
  const attachment = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus",
      "-b:a", "48k", "-f", "ogg", "pipe:1"
    ], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Timeout na conversão de voz")), 15000);
    timer.unref?.();
    child.on("error", () => finish(new Error("FFmpeg indisponível")));
    child.stdin.on("error", () => finish(new Error("Falha ao converter voz")));
    child.stdout.on("error", () => finish(new Error("Falha ao ler voz convertida")));
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return finish(new Error("Voz convertida grande demais"));
      chunks.push(chunk);
    });
    child.on("close", code => {
      if (code !== 0 || !size) return finish(new Error("Falha na conversão de voz"));
      finish(null, Buffer.concat(chunks));
    });
    child.stdin.end(wav);
  });
  return { attachment, name: "voice-message.ogg", ...metadata };
}

module.exports = { encodeVoiceMessage, wavMetadata };
