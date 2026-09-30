// Read Codex's local rollout logs without changing them.  The format is not a
// public API, so malformed or incomplete records deliberately mean "unknown".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const expandHome = value => {
  if (typeof value !== 'string' || !value) return null;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
};

function rolloutFiles(home) {
  const sessions = path.join(expandHome(home) || '', 'sessions');
  const found = [];
  const visit = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        try { found.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* raced with CLI */ }
      }
    }
  };
  visit(sessions);
  return found.sort((a, b) => b.mtime - a.mtime);
}

const validPercent = value => Number.isFinite(value) && value >= 0 && value <= 100;
const epochMs = value => {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
};
function normalize(event, checkedAt) {
  const limits = event?.payload?.type === 'token_count' && event.payload.rate_limits;
  const primary = limits?.primary, secondary = limits?.secondary;
  const primaryReset = epochMs(primary?.resets_at);
  const secondaryReset = epochMs(secondary?.resets_at);
  const asOf = Date.parse(event?.timestamp);
  if (!validPercent(primary?.used_percent) || !validPercent(secondary?.used_percent) || !primaryReset || !secondaryReset || !Number.isFinite(asOf)) return null;
  return {
    primary: { usedPercent: primary.used_percent, resetsAt: primaryReset },
    secondary: { usedPercent: secondary.used_percent, resetsAt: secondaryReset },
    asOf,
    stale: checkedAt - asOf > STALE_AFTER_MS,
  };
}

export function readCodexQuota(home, { now = Date.now() } = {}) {
  try {
    for (const { file } of rolloutFiles(home)) {
      let lines;
      try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
      let latest = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = normalize(JSON.parse(line), now);
          if (value) latest = value;
        } catch { /* JSONL is append-only and can end halfway through a line */ }
      }
      if (latest) return latest;
    }
  } catch { /* quota observation must never stop dispatch or the dashboard */ }
  return null;
}
