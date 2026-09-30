import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexQuota, STALE_AFTER_MS } from '../tools/quota.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
const write = (name, records) => {
  const file = path.join(root, 'sessions', '2026', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.join('\n') + '\n');
};
const record = (timestamp, primary = 40, secondary = 20) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: primary, resets_at: 2000000000 }, secondary: { used_percent: secondary, resets_at: 2000100000 } } } });

test('reads the last complete rate-limit event and normalizes seconds', () => {
  write('rollout-a.jsonl', ['{broken', record('2026-01-01T00:00:00.000Z', 10, 11), record('2026-01-01T01:00:00.000Z', 91, 22)]);
  const quota = readCodexQuota(root, { now: Date.parse('2026-01-01T01:01:00.000Z') });
  assert.deepEqual(quota.primary, { usedPercent: 91, resetsAt: 2000000000000 });
  assert.deepEqual(quota.secondary, { usedPercent: 22, resetsAt: 2000100000000 });
  assert.equal(quota.stale, false);
});

test('returns null for missing or invalid rate-limit data', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-empty-'));
  assert.equal(readCodexQuota(empty), null);
  const invalid = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-invalid-'));
  const file = path.join(invalid, 'sessions', 'x', 'rollout-b.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ timestamp: 'bad', payload: { type: 'token_count', rate_limits: { primary: {}, secondary: {} } } }));
  assert.equal(readCodexQuota(invalid), null);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(invalid, { recursive: true, force: true });
});

test('marks observations older than six hours as stale', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-stale-'));
  const file = path.join(isolated, 'sessions', 'x', 'rollout-stale.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const asOf = Date.parse('2026-02-01T00:00:00.000Z');
  fs.writeFileSync(file, record('2026-02-01T00:00:00.000Z'));
  assert.equal(readCodexQuota(isolated, { now: asOf + STALE_AFTER_MS }).stale, false);
  assert.equal(readCodexQuota(isolated, { now: asOf + STALE_AFTER_MS + 1 }).stale, true);
  fs.rmSync(isolated, { recursive: true, force: true });
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
