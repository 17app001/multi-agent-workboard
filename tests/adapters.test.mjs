import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { registry, getAdapter } from '../tools/adapters/index.mjs';

const fx = name => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8').split(/\r?\n/);
const P = 'do it';
const CWD = path.join(os.tmpdir(), 'proj');

test('getAdapter / registry', () => {
  for (const t of ['claude', 'codex', 'gemini', 'agy']) assert.equal(getAdapter(t).id, t);
  assert.equal(getAdapter('nope'), null);
  assert.equal(getAdapter('toString'), null);
});

test('buildCommand:未知 mode 丟錯', () => {
  for (const a of Object.values(registry)) assert.throws(() => a.buildCommand({ mode: 'x', prompt: P, cwd: CWD }));
});

test('claude buildCommand', () => {
  const c = registry.claude;
  for (const mode of ['plan', 'review']) {
    const r = c.buildCommand({ mode, prompt: P, cwd: CWD, agentCfg: { cmd: 'claude', args: ['-p'], home: '~/.claude' } });
    assert.deepEqual(r.args, ['-p', '--permission-mode', 'plan', '--output-format', 'stream-json', '--verbose', P]);
    assert.equal(r.cmd, 'claude'); assert.equal(r.cwd, CWD); assert.deepEqual(r.env, {});
  }
  // execute 未實跑,僅驗證組出的 args
  const e = c.buildCommand({ mode: 'execute', prompt: P, cwd: CWD, agentCfg: { home: '~/.claude-b' } });
  assert.deepEqual(e.args, ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose', P]);
  assert.equal(e.env.CLAUDE_CONFIG_DIR, os.homedir() + '/.claude-b');
  assert.ok(!e.args.some(a => a.startsWith('--dangerously')));
});

test('codex buildCommand', () => {
  const c = registry.codex;
  for (const mode of ['plan', 'review']) {
    const r = c.buildCommand({ mode, prompt: P, cwd: CWD, agentCfg: { args: ['exec', '--full-auto'], home: '~/.codex-b' } });
    assert.deepEqual(r.args, ['exec', '-s', 'read-only', '--json', '--skip-git-repo-check', '-C', CWD, P]);
    assert.equal(r.env.CODEX_HOME, os.homedir() + '/.codex-b');
    assert.ok(!r.args.includes('--full-auto'));
  }
  const e = c.buildCommand({ mode: 'execute', prompt: P, cwd: CWD, agentCfg: {} }); // 未實跑
  assert.deepEqual(e.args, ['exec', '-s', 'workspace-write', '--json', '--skip-git-repo-check', '-C', CWD, P]);
  assert.deepEqual(e.env, {});
});

test('gemini buildCommand', () => {
  const c = registry.gemini;
  for (const mode of ['plan', 'review']) {
    const r = c.buildCommand({ mode, prompt: P, cwd: CWD, agentCfg: { args: ['-p'] } });
    assert.deepEqual(r.args, ['-p', P, '--approval-mode', 'plan', '-o', 'stream-json']);
    assert.equal(r.cwd, CWD);
  }
  const e = c.buildCommand({ mode: 'execute', prompt: P, cwd: CWD, agentCfg: { skipTrust: true } }); // 未實跑
  assert.deepEqual(e.args, ['-p', P, '--approval-mode', 'auto_edit', '-o', 'stream-json', '--skip-trust']);
});

test('agy buildCommand', () => {
  const a = registry.agy;
  for (const mode of ['plan', 'review']) {
    const r = a.buildCommand({ mode, prompt: P, cwd: CWD, agentCfg: { cmd: 'agy-custom', args: ['--dangerously-skip-permissions'] } });
    assert.deepEqual(r.args, [`-p=${P}`, '--mode', 'plan', '--output-format', 'stream-json']);
    assert.equal(r.cmd, 'agy-custom'); assert.equal(r.cwd, CWD); assert.deepEqual(r.env, {});
    assert.ok(!r.args.some(arg => arg.startsWith('--dangerously')));
  }
  const e = a.buildCommand({ mode: 'execute', prompt: P, cwd: CWD }); // 未實跑
  assert.deepEqual(e.args, [`-p=${P}`, '--mode', 'accept-edits', '--output-format', 'stream-json']);
  assert.equal(e.cmd, 'agy');
});

const samples = { claude: 'claude-plan-sample.jsonl', codex: 'codex-plan-sample.jsonl', gemini: 'gemini-plan-sample.jsonl', agy: 'agy-plan-sample.jsonl' };
for (const [type, file] of Object.entries(samples)) {
  test(`${type} parseLine:樣本逐行餵入(${file})`, () => {
    const a = registry[type];
    const evs = fx(file).map(l => a.parseLine(l)).filter(Boolean);
    assert.ok(evs.length > 0);
    for (const e of evs) {
      assert.ok(['start', 'message', 'tool', 'file-edit', 'command', 'test', 'error', 'end'].includes(e.kind));
      assert.equal(typeof e.ts, 'number');
    }
    assert.ok(evs.some(e => e.kind === 'message' && e.text.includes('READY OK')));
    assert.ok(evs.some(e => e.kind === 'end' && e.exitCode === 0));
    if (type !== 'gemini') assert.equal(evs[0].kind, 'start');
  });

  test(`${type} parseLine:壞行/空行不丟例外`, () => {
    const a = registry[type];
    for (const l of ['', '   ', 'not json', '{bad', '[]', '123', 'null', '{"type":', '{"type":"zzz"}', '{}', '{"type":"assistant"}', '{"type":"item.completed"}', undefined, null, 42]) {
      assert.equal(a.parseLine(l), null);
    }
  });
}

test('claude parseLine:工具/權限/測試事件(合成行)', () => {
  const a = registry.claude;
  const asst = blocks => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  assert.deepEqual(a.parseLineEvents(asst([{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } }])).map(e => [e.kind, e.file]), [['file-edit', 'a.js']]);
  assert.equal(a.parseLine(asst([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }])).kind, 'test');
  assert.equal(a.parseLine(asst([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }])).kind, 'command');
  assert.equal(a.parseLine(asst([{ type: 'tool_use', name: 'Read', input: { file_path: 'b' } }])).kind, 'tool');
  const denied = a.parseLineEvents(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Write' }] }));
  assert.equal(denied[0].kind, 'error'); assert.equal(denied[0].needsHuman, true); assert.equal(denied[1].kind, 'end');
  const ur = a.parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission to use Write has been denied' }] } }));
  assert.equal(ur.needsHuman, true);
  assert.equal(a.parseLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })).exitCode, 1);
});

test('codex/gemini parseLine:命令、檔案、錯誤(合成行)', () => {
  const c = registry.codex, g = registry.gemini;
  const cmd = c.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed' } }));
  assert.equal(cmd.kind, 'test'); assert.equal(cmd.exitCode, 0);
  assert.equal(c.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'x.js' }] } })).file, 'x.js');
  assert.equal(c.parseLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })).kind, 'error');
  assert.equal(g.parseLine(JSON.stringify({ type: 'tool_use', tool_name: 'write_file', parameters: { file_path: 'y' } })).kind, 'file-edit');
  const ge = g.parseLine(JSON.stringify({ type: 'tool_result', status: 'error', output: 'Tool execution denied by policy' }));
  assert.equal(ge.needsHuman, true);
});

test('agy parseLine:只解析已實測事件', () => {
  const a = registry.agy;
  const start = a.parseLine(JSON.stringify({ event: 'init', conversation_id: 'c1', init: { permission_mode: 'request-review' } }));
  assert.equal(start.kind, 'start'); assert.equal(start.sessionId, 'c1');
  const active = a.parseLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'part' } }));
  assert.equal(active.kind, 'message'); assert.equal(active.text, 'part');
  assert.equal(a.parseLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } })), null);
  assert.equal(a.parseLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool_call', state: 'DONE' } })), null);
  assert.equal(a.parseLine(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: '\n' } })), null);
  const ok = a.parseLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }));
  assert.equal(ok.kind, 'end'); assert.equal(ok.exitCode, 0); assert.equal(ok.text, 'done');
  assert.equal(a.parseLine(JSON.stringify({ event: 'result', result: { status: 'FAILED' } })).exitCode, 1);
});
