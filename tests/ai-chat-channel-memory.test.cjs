const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createChannelMemory } = require("../ai-chat/channel-memory");

function entry(overrides = {}) {
  return {
    guildId: "g1",
    channelId: "c1",
    messageId: null,
    authorId: "u1",
    authorName: "Ana",
    role: "user",
    content: "mensagem",
    mentions: [],
    referenceId: null,
    referenceAuthorId: null,
    referenceAuthorName: null,
    referenceContent: null,
    source: "text",
    createdAt: Date.now(),
    ...overrides
  };
}

test("registra e recupera mensagens somente no escopo do canal", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  memory.record(entry({ guildId: "g1", channelId: "c1", content: "canal 1 do servidor 1" }));
  memory.record(entry({ guildId: "g1", channelId: "c2", content: "canal 2 do servidor 1" }));
  memory.record(entry({ guildId: "g2", channelId: "c1", content: "canal 1 do servidor 2" }));

  assert.deepEqual(memory.recent("g1", "c1").map(row => row.content), ["canal 1 do servidor 1"]);
  assert.deepEqual(memory.recent("g1", "c2").map(row => row.content), ["canal 2 do servidor 1"]);
  assert.deepEqual(memory.recent("g2", "c1").map(row => row.content), ["canal 1 do servidor 2"]);
  assert.deepEqual(memory.recent("g1", "desconhecido"), []);
  assert.deepEqual(memory.recent("desconhecido", "c1"), []);
});

test("normaliza autor, menções, referência e origem de voz", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  memory.record(entry({
    messageId: "m1",
    authorId: "u9",
    authorName: "  Bia  ",
    role: "user",
    content: "  olha isso  ",
    mentions: [{ id: "u2", name: "Caio" }, { name: "sem id" }],
    referenceId: "m0",
    referenceAuthorId: "u2",
    referenceAuthorName: "Caio",
    referenceContent: "a mensagem original",
    source: "voice"
  }));

  const [row] = memory.recent("g1", "c1");
  assert.equal(row.authorName, "Bia");
  assert.equal(row.content, "olha isso");
  assert.deepEqual(row.mentions, [{ id: "u2", name: "Caio" }]);
  assert.equal(row.referenceId, "m0");
  assert.equal(row.referenceAuthorId, "u2");
  assert.equal(row.referenceAuthorName, "Caio");
  assert.equal(row.referenceContent, "a mensagem original");
  assert.equal(row.source, "voice");
});

test("aplica limite de mensagens por canal, mantendo as mais recentes", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db, { maxMessages: 10 });

  for (let index = 0; index < 15; index++) {
    memory.record(entry({ content: `msg ${index}`, createdAt: Date.now() + index }));
  }

  const rows = memory.recent("g1", "c1", 50);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].content, "msg 5");
  assert.equal(rows.at(-1).content, "msg 14");
  assert.equal(memory.count("g1", "c1"), 10);
});

test("purga mensagens antigas por retenção sem tocar em outros servidores", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db, { retentionDays: 365 });
  const now = Date.now();
  const old = now - 30 * 86400000;

  memory.record(entry({ guildId: "g1", channelId: "c1", content: "antiga", createdAt: old }));
  memory.record(entry({ guildId: "g1", channelId: "c1", content: "recente", createdAt: now }));
  memory.record(entry({ guildId: "g2", channelId: "c1", content: "antiga de outro", createdAt: old }));

  assert.equal(memory.purge(14, "g1"), 1);
  assert.deepEqual(memory.recent("g1", "c1").map(row => row.content), ["recente"]);
  assert.equal(memory.recent("g2", "c1").length, 1);

  assert.equal(memory.purge(14), 1);
  assert.equal(memory.recent("g2", "c1").length, 0);
});

test("deduplica mensagens pelo ID do Discord dentro do mesmo canal", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  assert.ok(memory.record(entry({ messageId: "m1", content: "primeira" })));
  assert.equal(memory.record(entry({ messageId: "m1", content: "duplicada" })), null);
  assert.equal(memory.count("g1", "c1"), 1);

  memory.record(entry({ guildId: "g2", messageId: "m1", content: "mesmo id, outro servidor" }));
  assert.equal(memory.count("g2", "c1"), 1);
});

test("guarda, atualiza e remove resumo do canal sem misturar escopos", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  assert.equal(memory.summary("g1", "c1"), null);

  memory.setSummary("g1", "c1", "primeiro resumo", 5, 5);
  const first = memory.summary("g1", "c1");
  assert.equal(first.summary, "primeiro resumo");
  assert.equal(first.coveredUntilId, 5);
  assert.equal(first.messageCount, 5);

  memory.setSummary("g1", "c1", "resumo atualizado", 9, 12);
  assert.equal(memory.summary("g1", "c1").summary, "resumo atualizado");

  memory.setSummary("g1", "c2", "resumo de outro canal", 3, 3);
  assert.equal(memory.summary("g1", "c1").summary, "resumo atualizado");
  assert.equal(memory.summary("g1", "c2").summary, "resumo de outro canal");

  memory.clearChannel("g1", "c1");
  assert.equal(memory.summary("g1", "c1"), null);
  assert.equal(memory.summary("g1", "c2").summary, "resumo de outro canal");
});

test("lista mensagens anteriores por janela de IDs", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  const ids = [];
  for (let index = 0; index < 8; index++) {
    ids.push(memory.record(entry({ content: `msg ${index}`, createdAt: Date.now() + index })));
  }

  const older = memory.olderThan("g1", "c1", ids[5], ids[1], 10);
  assert.deepEqual(older.map(row => row.content), ["msg 2", "msg 3", "msg 4"]);
  assert.deepEqual(memory.olderThan("g1", "c1", ids[5], ids[1], 2).map(row => row.content),
    ["msg 2", "msg 3"]);
});

test("conta mensagens e canais por servidor", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  memory.record(entry({ guildId: "g1", channelId: "c1" }));
  memory.record(entry({ guildId: "g1", channelId: "c1" }));
  memory.record(entry({ guildId: "g1", channelId: "c2" }));
  memory.record(entry({ guildId: "g2", channelId: "c1" }));

  assert.equal(memory.count("g1", "c1"), 2);
  assert.equal(memory.channelCount("g1"), 2);
  assert.equal(memory.guildCount("g1"), 3);
  assert.equal(memory.guildCount("g2"), 1);
  assert.equal(memory.guildCount("g3"), 0);
});

test("limpa a memória de um canal e de um servidor inteiro", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  memory.record(entry({ guildId: "g1", channelId: "c1" }));
  memory.record(entry({ guildId: "g1", channelId: "c2" }));
  memory.record(entry({ guildId: "g2", channelId: "c1" }));
  memory.setSummary("g1", "c1", "resumo", 1, 1);

  assert.equal(memory.clearChannel("g1", "c1"), 1);
  assert.equal(memory.count("g1", "c1"), 0);
  assert.equal(memory.count("g1", "c2"), 1);

  assert.equal(memory.clearGuild("g1"), 1);
  assert.equal(memory.guildCount("g1"), 0);
  assert.equal(memory.guildCount("g2"), 1);
  assert.equal(memory.summary("g1", "c1"), null);
});

test("funciona em memória quando não há banco disponível", t => {
  const memory = createChannelMemory(null, { maxMessages: 10 });

  memory.record(entry({ messageId: "m1", content: "primeira" }));
  memory.record(entry({ messageId: "m2", content: "segunda" }));
  assert.deepEqual(memory.recent("g1", "c1").map(row => row.content), ["primeira", "segunda"]);
  assert.equal(memory.count("g1", "c1"), 2);

  memory.record(entry({ guildId: "g2", channelId: "c1", content: "outro servidor" }));
  assert.deepEqual(memory.recent("g1", "c1").map(row => row.content), ["primeira", "segunda"]);

  assert.equal(memory.record(entry({ messageId: "m1", content: "duplicada" })), null);
  assert.equal(memory.count("g1", "c1"), 2);

  memory.setSummary("g1", "c1", "resumo em memória", 2, 2);
  assert.equal(memory.summary("g1", "c1").summary, "resumo em memória");

  assert.equal(memory.clearChannel("g1", "c1"), 2);
  assert.equal(memory.count("g1", "c1"), 0);
  assert.equal(memory.summary("g1", "c1"), null);
  assert.equal(memory.count("g2", "c1"), 1);

  memory.record(entry({ guildId: "g2", channelId: "c2", content: "outro canal" }));
  assert.equal(memory.clearGuild("g2"), 2);
  assert.equal(memory.guildCount("g2"), 0);
});

test("descarta entradas inválidas sem gravar lixo", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const memory = createChannelMemory(db);

  assert.equal(memory.record(null), null);
  assert.equal(memory.record(entry({ guildId: "" })), null);
  assert.equal(memory.record(entry({ channelId: "" })), null);
  assert.equal(memory.record(entry({ authorId: "" })), null);
  assert.equal(memory.record(entry({ content: "   " })), null);
  assert.equal(memory.count("g1", "c1"), 0);
});
