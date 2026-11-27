// Brasília: UTC-03:00, semanas de segunda-feira 00:00 a domingo 23:59:59.
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const OFFSET_MS = -3 * 60 * 60 * 1000;

function weekStart(timestamp) {
  const local = new Date(timestamp + OFFSET_MS);
  const day = (local.getUTCDay() + 6) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day) - OFFSET_MS;
}

function weekLabel(start) {
  const dayMonth = timestamp => {
    const date = new Date(timestamp + OFFSET_MS);
    return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return `${dayMonth(start)} - ${dayMonth(start + 6 * DAY_MS)}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000);
  if (!seconds) return "0h 0m 0s";
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${String(seconds % 60).padStart(2, "0")}s`;
}

module.exports = { DAY_MS, WEEK_MS, weekStart, weekLabel, formatDuration };
