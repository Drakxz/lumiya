const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
const MAX_JSON_BYTES = 9 * 1024 * 1024;

function wantsAudio(content) {
  const text = String(content || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(?:nao|sem)\b[^.!?\n]{0,30}\b(?:audio|voz)\b/.test(text)) return false;
  return /\b(?:manda|mande|envia|envie|responde|responda|responder|fala|fale|falar|grava|grave)\b[^.!?\n]{0,40}\b(?:audio|voz)\b/.test(text);
}

function speechText(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_`#~]/g, "")
    .replace(/\bkkk+\b/gi, "<chuckle>")
    .trim().slice(0, 600);
}

async function boundedJson(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Resposta de áudio excede o limite");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

function validateWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.length > MAX_AUDIO_BYTES ||
      audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Formato de áudio inválido");
  }
  return audio;
}

async function readAudio(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error("Resposta de áudio excede o limite");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return validateWav(Buffer.concat(chunks));
}

function createSpeech({
  apiKey,
  provider = "gemini",
  model = "gemini-3.8-flash-lite-tts",
  voice = "Sulafat",
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000
}) {
  const selected = String(provider || "gemini").toLowerCase();
  return {
    provider: selected,
    async generate(text) {
      const transcript = speechText(text);
      if (!transcript) throw new Error("Texto de áudio vazio");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        if (selected === "openai") {
          const response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
            body: JSON.stringify({
              model: model || "gpt-4o-mini-tts",
              voice: voice || "coral",
              input: transcript,
              response_format: "wav"
            })
          });
          if (!response.ok) {
            // Não repasse o corpo: pode conter dados privados ou credenciais.
            throw Object.assign(new Error(`OpenAI TTS HTTP ${response.status}`), { status: response.status });
          }
          return await readAudio(response);
        }
        const response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            store: false,
            input: [{
              type: "user_input",
              content: [{
                type: "text",
                text: transcript,
                annotations: [{
                  type: "speech_metadata",
                  style: "Português brasileiro, conversa casual e natural, pausas suaves, sem voz de locutor. Respeite a emoção do texto, sem forçar deboche."
                }]
              }]
            }],
            response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
            generation_config: { speech_config: [{ voice }] }
          })
        });
        const body = await boundedJson(response);
        if (!response.ok) {
          // Não repasse mensagens da API: podem conter texto privado ou credenciais.
          throw Object.assign(new Error(`Gemini TTS HTTP ${response.status}`), { status: response.status });
        }
        const part = body.steps?.filter(step => step.type === "model_output")
          .flatMap(step => step.content || []).filter(item => item.type === "audio").at(-1);
        const data = part?.data;
        if (typeof data !== "string" || !data || data.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
          throw new Error("Áudio ausente ou grande demais");
        }
        return validateWav(Buffer.from(data, "base64"));
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

module.exports = { createSpeech, wantsAudio, speechText };
