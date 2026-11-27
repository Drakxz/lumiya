const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VoiceHoursStore } = require("../voice-hours/store");
const { formatDuration, weekStart, weekLabel, WEEK_MS } = require("../voice-hours/time");
const { renderHoursCard } = require("../voice-hours/render");
const { loadImage } = require("@napi-rs/canvas");
const MONDAY = Date.parse("2026-11-09T03:00:00Z");
function memory(t) {
  const store = new VoiceHoursStore(":memory:");
  t.after(() => store.db.close());
  return store;
}
const state = (muted = false, channelId = "voice", userId = "user", guildId = "guild") => ({ guildId, userId, channelId, muted });

test("duration formatting never displays milliseconds and handles zero", () => {
  assert.equal(formatDuration(0), "0h 0m 0s");
  assert.equal(formatDuration(5_109_000), "1h 25m 09s");
  assert.equal(formatDuration(43_472_999), "12h 4m 32s");
  assert.equal(formatDuration(-1), "0h 0m 0s");
});

test("week boundaries use Monday midnight in Brasilia, including year changes", () => {
  assert.equal(weekStart(MONDAY), MONDAY);
  assert.equal(weekStart(MONDAY - 1), MONDAY - WEEK_MS);
  assert.equal(weekLabel(MONDAY), "09/11 - 15/11");
  assert.equal(weekLabel(MONDAY - WEEK_MS), "02/11 - 08/11");
  assert.equal(weekLabel(weekStart(Date.parse("2027-01-01T15:00:00Z"))), "28/12 - 03/01");
});

test("unknown users have zero statistics, not invented history", t => {
  const s = memory(t); const result = s.stats("guild", "user", MONDAY);
  for (const key of ["totalCallMs", "totalMutedMs", "weekCallMs", "weekMutedMs", "lastWeekCallMs", "lastWeekMutedMs"]) assert.equal(result[key], 0);
  assert.equal(result.channelId, null);
});

test("live queries include active time without double counting", t => {
  const s = memory(t); s.update(state(), MONDAY);
  assert.equal(s.stats("guild", "user", MONDAY + 35 * 60_000).totalCallMs, 35 * 60_000);
  assert.equal(s.stats("guild", "user", MONDAY + 35 * 60_000).totalCallMs, 35 * 60_000);
  s.checkpoint(MONDAY + 35 * 60_000);
  s.update(state(false, null), MONDAY + 36 * 60_000);
  assert.equal(s.stats("guild", "user", MONDAY + 60 * 60_000).totalCallMs, 36 * 60_000);
});

test("multiple mute changes, rapid leave and channel moves are exact", t => {
  const s = memory(t);
  s.update(state(), MONDAY);
  s.update(state(true), MONDAY + 1000);
  s.update(state(true, "other-channel"), MONDAY + 2000);
  s.update(state(false, "other-channel"), MONDAY + 3000);
  s.update(state(true, "other-channel"), MONDAY + 3500);
  s.update(state(false, null), MONDAY + 4000);
  s.update(state(), MONDAY + 4000);
  s.update(state(false, null), MONDAY + 4001);
  const stats = s.stats("guild", "user", MONDAY + 5000);
  assert.equal(stats.totalCallMs, 4001);
  assert.equal(stats.totalMutedMs, 2500);
  assert.equal(stats.weekMutedMs, 2500);
});

test("one uninterrupted muted session is split at the weekly boundary", t => {
  const s = memory(t);
  s.update(state(true), MONDAY - 60_000);
  let result = s.stats("guild", "user", MONDAY + 120_000);
  assert.equal(result.totalCallMs, 180_000); assert.equal(result.totalMutedMs, 180_000);
  assert.equal(result.lastWeekCallMs, 60_000); assert.equal(result.lastWeekMutedMs, 60_000);
  assert.equal(result.weekCallMs, 120_000); assert.equal(result.weekMutedMs, 120_000);
  s.update(state(false, null), MONDAY + 120_000);
  result = s.stats("guild", "user", MONDAY + 3 * WEEK_MS);
  assert.equal(result.totalCallMs, 180_000);
  assert.equal(result.weekCallMs, 0); assert.equal(result.lastWeekCallMs, 0);
});

test("weekly checkpoint handles consecutive weeks, rather than resetting totals", t => {
  const s = memory(t); s.update(state(), MONDAY - WEEK_MS);
  s.checkpoint(MONDAY + 2 * WEEK_MS);
  const stats = s.stats("guild", "user", MONDAY + 2 * WEEK_MS);
  assert.equal(stats.totalCallMs, 3 * WEEK_MS);
  assert.equal(stats.weekCallMs, 0); assert.equal(stats.lastWeekCallMs, WEEK_MS);
  assert.equal(s.db.prepare("SELECT value FROM metadata WHERE key = 'currentWeekStart'").get().value, String(MONDAY + 2 * WEEK_MS));
});

test("guilds and users never share totals", t => {
  const s = memory(t);
  s.update(state(), MONDAY);
  s.update(state(true, "voice", "other"), MONDAY + 1000);
  s.update(state(true, "voice", "user", "other-guild"), MONDAY + 2000);
  assert.equal(s.stats("guild", "user", MONDAY + 4000).totalCallMs, 4000);
  assert.equal(s.stats("guild", "other", MONDAY + 4000).totalCallMs, 3000);
  assert.equal(s.stats("other-guild", "user", MONDAY + 4000).totalCallMs, 2000);
});

test("shutdown/restart preserves checkpointed time without inventing offline time", t => {
  const approvedTemp = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
  fs.mkdirSync(approvedTemp, { recursive: true });
  const directory = fs.mkdtempSync(path.join(approvedTemp, "call-hours-test-"));
  const file = path.join(directory, "calls.sqlite");
  const first = new VoiceHoursStore(file);
  first.update(state(true), MONDAY); first.checkpoint(MONDAY + 10_000); first.db.close();
  const second = new VoiceHoursStore(file);
  t.after(() => { second.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const restart = MONDAY + 3_600_000;
  assert.equal(second.stats("guild", "user", restart).totalCallMs, 10_000);
  second.reconcile("guild", [{ id: "user", channelId: "voice", selfMute: false, serverMute: true }], restart);
  const result = second.stats("guild", "user", restart + 5000);
  assert.equal(result.totalCallMs, 15_000); assert.equal(result.totalMutedMs, 15_000);
});

test("reconnect suspends sessions and resumes from the confirmed voice cache", t => {
  const s = memory(t);
  s.update(state(true), MONDAY); s.stopGuild("guild", MONDAY + 5000);
  assert.equal(s.stats("guild", "user", MONDAY + 60_000).totalCallMs, 5000);
  s.reconcile("guild", [{ id: "user", channelId: "new", selfMute: false, serverMute: false }], MONDAY + 60_000);
  const result = s.stats("guild", "user", MONDAY + 70_000);
  assert.equal(result.totalCallMs, 15_000); assert.equal(result.totalMutedMs, 5000);
  assert.equal(result.channelId, "new");
});

test("all totals roll back if a weekly write fails", t => {
  const s = memory(t); s.update(state(), MONDAY);
  s.db.exec("CREATE TRIGGER simulated_failure BEFORE INSERT ON weeks BEGIN SELECT RAISE(ABORT, 'test'); END;");
  assert.throws(() => s.stats("guild", "user", MONDAY + 1000));
  assert.equal(s.getTotals.get("guild", "user"), undefined);
  assert.equal(s.getActive.get("guild", "user").lastAt, MONDAY);
  s.db.exec("DROP TRIGGER simulated_failure;");
  assert.equal(s.stats("guild", "user", MONDAY + 1000).totalCallMs, 1000);
});

test("renderer creates real PNGs with current per-user data", async t => {
  const s = memory(t); s.update(state(), MONDAY);
  const first = await renderHoursCard({ name: "Teste de renderização", avatarURL: null,
    stats: s.stats("guild", "user", MONDAY + 60_000) });
  const second = await renderHoursCard({ name: "Outro usuário", avatarURL: null,
    stats: s.stats("guild", "other", MONDAY + 60_000) });
  assert.equal(first.subarray(1, 4).toString(), "PNG");
  assert.notDeepEqual(first, second);
  const image = await loadImage(first);
  assert.equal(image.width, 3200); assert.equal(image.height, 1800);
  assert.ok(first.length < 8_000_000);
  if (process.env.HOURS_TEST_PREVIEW) fs.writeFileSync(process.env.HOURS_TEST_PREVIEW, first);
});

test("renderer draws animated GIF avatars served through the Discord media proxy", async t => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const originalFetch = global.fetch;
  let fetched;
  global.fetch = async (url, options) => {
    fetched = { url: String(url), options };
    return {
      ok: true,
      url: "https://media.discordapp.net/avatars/1/a_hash.gif?size=256",
      headers: { get: name => name === "content-type" ? "image/gif" : null },
      arrayBuffer: async () => gif.buffer.slice(gif.byteOffset, gif.byteOffset + gif.byteLength)
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  const s = memory(t); s.update(state(), MONDAY);
  const image = await renderHoursCard({
    name: "Avatar animado",
    avatarURL: "https://cdn.discordapp.com/avatars/1/a_hash.gif?size=256",
    stats: s.stats("guild", "user", MONDAY + 60_000)
  });
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.match(fetched.url, /a_hash\.gif/);
  assert.equal(fetched.options.redirect, "follow");
});

test("rollup agrega semanas antigas sem alterar a elegibilidade", t => {
  const s = memory(t);
  const inicio = MONDAY - WEEK_MS - 60_000;
  s.update(state(), inicio);
  s.update(state(false, null), inicio + 60_000);
  assert.equal(s.eligible("guild", "user", {}, inicio + 60_000), 60_000);
  assert.equal(s.rollup(MONDAY), 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM voice_segments").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM voice_rollups").get().n, 1);
  assert.equal(s.eligible("guild", "user", {}, MONDAY), 60_000);
  assert.equal(s.eligible("guild", "user", { excluded: ["voice"] }, MONDAY), 0);
});
