// 用量解析的 fixture 測試(零依賴:node:test)。執行:node --test tests/
// 每個測試在暫存目錄建假 log,不碰使用者真實的 ~/.claude ~/.codex ~/.gemini。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectUsage, usageInRange } from '../tools/usage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};
// 本機時區的正中午,避免 UTC/本機日期切換造成測試在不同時區跑出不同結果
const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

test('claude: 加總 input(含 cache_creation)/cached/output,並以 message.id+requestId 去重', () => {
  const home = tmp();
  const ts = noon(2026, 1, 15).toISOString();
  const msg = (id, req, u) => ({ timestamp: ts, requestId: req, message: { id, usage: u } });
  write(path.join(home, 'projects', 'p1', 's.jsonl'), [
    msg('m1', 'r1', { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 }),
    msg('m1', 'r1', { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 }), // 重複
    msg('m2', 'r2', { input_tokens: 1, output_tokens: 2 }),
    { timestamp: ts, message: { id: 'no-usage' } }, // 沒 usage,略過
    'not json at all', // 壞行不能丟例外
  ]);
  const [r] = collectUsage([{ id: 'c', type: 'claude', home, price: { input: 1, cached: 0.1, output: 2 } }]);
  assert.equal(r.found, true);
  assert.equal(r.input, 16);
  assert.equal(r.cached, 100);
  assert.equal(r.output, 22);
  assert.equal(r.total, 138);
  assert.equal(r.days.length, 1);
  assert.equal(r.days[0].date, ymd(2026, 1, 15));
  // (16*1 + 100*0.1 + 22*2) / 1e6
  assert.ok(Math.abs(r.costTotal - 70 / 1e6) < 1e-12);
});

test('codex: 取每檔最後一筆累計值;cached 從 input 扣除;reasoning 不重複計入 output', () => {
  const home = tmp();
  const tok = (input, cached, output, reasoning) => ({
    timestamp: noon(2026, 2, 3).toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } } },
  });
  write(path.join(home, 'sessions', '2026', '02', '03', 'rollout-a.jsonl'), [
    tok(100, 40, 10, 5),
    tok(300, 100, 50, 30), // 最後一筆才算
  ]);
  write(path.join(home, 'sessions', 'rollout-empty.jsonl'), [{ payload: { type: 'other' } }]); // 無 token_count,略過
  const [r] = collectUsage([{ id: 'x', type: 'codex', home }]);
  assert.equal(r.input, 200);  // 300 - 100
  assert.equal(r.cached, 100);
  assert.equal(r.output, 50);  // 不含 reasoning 再加一次
  assert.equal(r.total, 350);
});

test('gemini: 只讀 chats 底下的 .jsonl、以 id 去重、output=output+thoughts+tool', () => {
  const home = tmp();
  const ts = noon(2026, 3, 9).toISOString();
  const m = (id, t) => ({ id, timestamp: ts, type: 'gemini', tokens: t });
  write(path.join(home, 'tmp', 'proj', 'chats', 'session-1.jsonl'), [
    { sessionId: 's', startTime: ts }, // meta 行,無 tokens
    m('a', { input: 10, output: 5, cached: 3, thoughts: 2, tool: 1, total: 18 }),
    m('a', { input: 10, output: 5, cached: 3, thoughts: 2, tool: 1, total: 18 }), // 補 toolCalls 後重複
  ]);
  write(path.join(home, 'tmp', 'proj', 'logs', 'other.jsonl'), [m('z', { input: 999, output: 999 })]); // 非 chats,忽略
  write(path.join(home, 'tmp', 'proj', 'chats', 'old.json'), [m('y', { input: 999, output: 999 })]); // 副檔名不對,忽略
  const [r] = collectUsage([{ id: 'g', type: 'gemini', home }]);
  assert.equal(r.input, 10);
  assert.equal(r.cached, 3);
  assert.equal(r.output, 8);
  assert.equal(r.total, 21);
});

test('collectUsage: enabled:false 與不存在的 home 不報錯,found:false', () => {
  const disabled = collectUsage([{ id: 'd', type: 'claude', home: tmp(), enabled: false }])[0];
  assert.equal(disabled.found, false);
  assert.equal(disabled.enabled, false);
  const missing = collectUsage([{ id: 'm', type: 'codex', home: path.join(os.tmpdir(), 'no-such-dir-' + Date.now()) }])[0];
  assert.equal(missing.found, false);
  assert.equal(missing.configured, false);
  assert.equal(missing.total, 0);
});

test('collectUsage: 「今日」用本機日期,不是 UTC', () => {
  const home = tmp();
  const now = new Date();
  write(path.join(home, 'projects', 'p', 's.jsonl'), [
    { timestamp: now.toISOString(), requestId: 'r', message: { id: 'm', usage: { input_tokens: 7, output_tokens: 3 } } },
  ]);
  const [r] = collectUsage([{ id: 'c', type: 'claude', home }]);
  assert.equal(r.today, 10);
  assert.equal(r.week, 10);
});

test('usageInRange: 只加總時間窗內條目,並回傳費用估算', () => {
  const home = tmp();
  const at = (h) => new Date(2026, 4, 1, h, 0, 0);
  const e = (h, id, out) => ({ timestamp: at(h).toISOString(), requestId: id, message: { id, usage: { input_tokens: 1, output_tokens: out } } });
  write(path.join(home, 'projects', 'p', 's.jsonl'), [e(8, 'a', 10), e(10, 'b', 20), e(12, 'c', 40)]);
  const agent = { type: 'claude', home, price: { input: 1, cached: 0, output: 1 } };
  const r = usageInRange(agent, +at(9), +at(11));
  assert.equal(r.input, 1);
  assert.equal(r.output, 20);
  assert.equal(r.total, 21);
  assert.ok(Math.abs(r.costEstimate - 21 / 1e6) < 1e-12);
});

test('usageInRange: agent 停用 / home 不存在 / type 未知 → null', () => {
  const home = tmp();
  assert.equal(usageInRange(null, 0, 1), null);
  assert.equal(usageInRange({ type: 'claude', home, enabled: false }, 0, 1), null);
  assert.equal(usageInRange({ type: 'claude', home: path.join(home, 'nope') }, 0, 1), null);
  assert.equal(usageInRange({ type: 'unknown', home }, 0, 1), null);
});
