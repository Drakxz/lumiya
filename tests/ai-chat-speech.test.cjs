const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpeech, wantsAudio, speechText } = require("../ai-chat/speech");
const { wavMetadata } = require("../ai-chat/voice-message");

function wav() {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(40, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

test("metadados de voz vêm do PCM real e rejeitam WAV corrompido", () => {
  const metadata = wavMetadata(wav());
  assert.equal(metadata.duration, 2 / 24000);
  assert.equal(Buffer.from(metadata.waveform, "base64").length, 2);
  assert.throws(() => wavMetadata(Buffer.from("lixo")), /WAV inválido/);
  const truncated = wav();
  truncated.writeUInt32LE(1000, 40);
  assert.throws(() => wavMetadata(truncated), /truncado/);
  const stereo = wav();
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => wavMetadata(stereo), /PCM/);
});

test("detecção de pedido explícito de voz e preparação da fala", () => {
  for (const text of ["manda áudio", "me responde por voz", "envie um audio", "fala em áudio"]) {
    assert.equal(wantsAudio(text), true, text);
  }
  for (const text of ["oi", "esse áudio ficou bom", "não manda áudio", "responde sem voz"]) {
    assert.equal(wantsAudio(text), false, text);
  }
  assert.equal(speechText("**oi** KKKKK <@123> https://exemplo.com"), "oi <chuckle>");
});

test("Gemini TTS usa transcrição separada do estilo e retorna WAV sem arquivo em disco", async () => {
  const audio = wav();
  const speech = createSpeech({
    apiKey: "segredo",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      assert.equal(options.headers["x-goog-api-key"], "segredo");
      assert.equal(options.signal.aborted, false);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gemini-3.8-flash-lite-tts");
      assert.equal(body.store, false);
      assert.equal(body.input[0].content[0].text, "e aí");
      assert.match(body.input[0].content[0].annotations[0].style, /Português brasileiro/);
      assert.equal(body.generation_config.speech_config[0].voice, "Sulafat");
      return Response.json({
        steps: [{ type: "model_output", content: [{ type: "audio", data: audio.toString("base64") }] }]
      });
    }
  });
  assert.deepEqual(await speech.generate("e aí"), audio);
});

test("TTS rejeita áudio vazio, inválido, grande demais e erro HTTP sem expor segredos", async () => {
  for (const body of [
    {},
    { steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.from("não é wav").toString("base64") }] }] }
  ]) {
    await assert.rejects(createSpeech({ apiKey: "test", fetchImpl: async () => Response.json(body) }).generate("oi"));
  }
  const large = createSpeech({
    apiKey: "test",
    fetchImpl: async () => new Response("x".repeat(9 * 1024 * 1024 + 1))
  });
  await assert.rejects(large.generate("oi"), /excede o limite/);
  const fail = createSpeech({
    apiKey: "test",
    fetchImpl: async () => Response.json({ error: { message: "segredo texto privado" } }, { status: 429 })
  });
  await assert.rejects(fail.generate("oi"), error => {
    assert.equal(error.status, 429);
    assert.doesNotMatch(error.message, /segredo|privado/);
    return true;
  });
});

test("OpenAI TTS usa OPENAI_API_KEY, WAV e valida o áudio sem expor a chave", async () => {
  const audio = wav();
  const speech = createSpeech({
    provider: "openai",
    apiKey: "segredo-openai",
    model: "gpt-4o-mini-tts",
    voice: "coral",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/audio/speech");
      assert.equal(options.headers.Authorization, "Bearer segredo-openai");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-4o-mini-tts");
      assert.equal(body.voice, "coral");
      assert.equal(body.input, "e aí");
      assert.equal(body.response_format, "wav");
      return new Response(audio);
    }
  });
  assert.equal(speech.provider, "openai");
  assert.deepEqual(await speech.generate("e aí"), audio);
});
test("OpenAI TTS falha fechado em HTTP, WAV inválido e limite de tamanho", async () => {
  const fail = createSpeech({
    provider: "openai",
    apiKey: "segredo",
    fetchImpl: async () => Response.json({ error: { message: "segredo vazou" } }, { status: 401 })
  });
  await assert.rejects(fail.generate("oi"), error => {
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /segredo|vazou/);
    return true;
  });
  const invalid = createSpeech({
    provider: "openai",
    apiKey: "segredo",
    fetchImpl: async () => new Response("lixo")
  });
  await assert.rejects(invalid.generate("oi"), /inválido/);
  const large = createSpeech({
    provider: "openai",
    apiKey: "segredo",
    fetchImpl: async () => new Response(Buffer.alloc(6 * 1024 * 1024 + 1))
  });
  await assert.rejects(large.generate("oi"), /excede o limite/);
});
test("timeout de TTS aborta requisição", async () => {
  const speech = createSpeech({
    apiKey: "test",
    timeoutMs: 10,
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      // Mantém o event loop ativo apenas neste mock.
      const timer = setTimeout(resolve, 1000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("abortado"));
      }, { once: true });
    })
  });
  await assert.rejects(speech.generate("oi"), /abortado/);
});
