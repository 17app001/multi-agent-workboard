// WP3 Run 引擎測試。全部在 os.tmpdir 的沙箱:複製 tools/ 與 pipelines/,agents.json 指向假 CLI(tests/fixtures/fake-cli.mjs),
// 起獨立 server(隨機 port)。不碰真實 board/,不呼叫真實 claude/codex/gemini。清理只刪本檔明確建立的路徑。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
const projDirs = []; // 本檔建立的 project 資料夾(清理時逐一明確刪除)
const fakeLog = path.join(sandbox, 'fake-log.jsonl');
const fakeCli = path.join(sandbox, 'fake-cli.mjs');
let proc, base, engineMod;

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const api = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text/plain */ }
  return { status: res.status, json, text };
};
const post = (p, body = {}) => api(p, { method: 'POST', body });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, what = '') => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(100); }
  throw new Error('waitFor timeout ' + what);
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const getRun = async id => (await api('/api/runs/' + id)).json?.run;
const waitStatus = (id, status, ms) => waitFor(async () => { const r = await getRun(id); return r && r.status === status ? r : null; }, ms, `${id} -> ${status}`);
const calls = id => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
  .filter(c => c.prompt.includes(`標題: ${id}\n`));
const callsOf = (id, mode) => calls(id).filter(c => c.mode === mode);

const startServer = async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(sandbox, 'tools/server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_LOG: fakeLog } });
  await new Promise((ok, bad) => {
    proc.stdout.on('data', d => String(d).includes('workboard on') && ok());
    proc.on('exit', c => bad(new Error('server exited early: ' + c)));
    setTimeout(() => bad(new Error('server start timeout')), 8000);
  });
};
const killServer = async () => { const p = proc; const done = new Promise(r => p.once('exit', r)); p.kill(); await done; };

// 每個測試一個獨立的 project 資料夾:t.js 依 fake-control.json 的 testExits 決定 npm test / node t.js 的結果
function mkProject(id, control = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-proj-'));
  projDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p-' + id, scripts: { test: 'node t.js' } }));
  fs.writeFileSync(path.join(dir, 't.js'), `const fs=require('fs');let c={};try{c=JSON.parse(fs.readFileSync('fake-control.json','utf8'))}catch{}
let n=0;try{n=+fs.readFileSync('.test-count','utf8')}catch{}fs.writeFileSync('.test-count',String(++n));
const ex=(c.testExits||[0]);process.exit(ex[Math.min(n-1,ex.length-1)]);`);
  fs.writeFileSync(path.join(dir, 'fake-control.json'), JSON.stringify(control));
  return dir;
}
async function mkTask(id, { pipeline, control = {}, agent = 'codex-a', extra = {} } = {}) {
  const dir = mkProject(id, control);
  const pj = 'proj-' + id;
  assert.equal((await post('/api/projects', { id: pj, name: pj, path: dir })).status, 200);
  const r = await post('/api/tasks', { id, title: id, agent, status: 'todo', project: pj, pipeline, goal: '目標 ' + id, acceptance: '驗收甲;驗收乙', ...extra });
  assert.equal(r.status, 200);
  return dir;
}
function initGitProject(id, control = {}) {
  const dir = mkProject(id, { noRuntimeFiles: true, ...control });
  fs.writeFileSync(path.join(dir, 'work.txt'), 'base\n');
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: dir });
  return dir;
}
const dispatch = (id, body = {}) => post('/api/dispatch', { id, ...body });
const waitNeeds = (id, reason, ms) => waitFor(async () => { const r = await getRun(id); return r && r.status === 'needs-you' && r.needsYou?.reason === reason ? r : null; }, ms, `${id} needs-you/${reason}`);
// 派工 → 等到 plan 關卡 → 核准(所有 pipeline 都有 human gate,測 execute 行為的測試都要先過關)
async function startApproved(id, body = {}) {
  const d = await dispatch(id, body);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  await waitNeeds(id, 'approval');
  const a = await post(`/api/runs/${id}/approve`);
  assert.equal(a.status, 200, JSON.stringify(a.json));
}

before(async () => {
  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.cpSync(path.join(repo, 'pipelines'), path.join(sandbox, 'pipelines'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tests/fixtures/fake-cli.mjs'), fakeCli);
  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'web'), { recursive: true });
  const price = { input: 0, cached: 0, output: 0 };
  fs.writeFileSync(path.join(sandbox, 'agents.json'), JSON.stringify({
    columns: ['backlog', 'todo', 'doing', 'review', 'done'],
    pools: { codex: ['codex-b', 'codex-a'] },
    agents: [
      { id: 'claude', type: 'claude', label: 'Fake Claude', home: path.join(sandbox, 'h1'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
      { id: 'codex-a', type: 'codex', label: 'Fake Codex', home: path.join(sandbox, 'h2'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
      { id: 'codex-b', type: 'codex', label: 'Fake Codex B', home: path.join(sandbox, 'h4'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
      { id: 'agy-a', type: 'agy', label: 'Fake Agy', home: path.join(sandbox, 'h3'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
    ],
  }));
  // 測試用 pipeline:由真實 standard.json 衍生(只把 test 指令換成 node t.js,避免每次跑 npm),以及幾個小型的
  const std = JSON.parse(fs.readFileSync(path.join(repo, 'pipelines/standard.json'), 'utf8'));
  const wp = (o) => fs.writeFileSync(path.join(sandbox, 'pipelines', o.id + '.json'), JSON.stringify(o));
  wp({ ...std, id: 'stdfast', steps: std.steps.map(s => (s.type === 'command' ? { ...s, command: 'node t.js' } : s)) });
  const gatedPlan = { id: 'plan', agent: 'claude', mode: 'plan', output: 'plan.md', gate: 'human' };
  const loopSteps = [
    gatedPlan,
    { id: 'code', agent: 'codex-a', mode: 'execute', input: ['plan.md'] },
    { id: 'test', type: 'command', command: 'node t.js' },
    { id: 'review', agent: 'claude', mode: 'review', input: ['test.txt'], output: 'review.md' },
    { id: 'revise', agent: 'codex-a', mode: 'execute', when: 'review.failed', input: ['review.md'], loopTo: 'test' },
  ];
  wp({ id: 'lim', maxRevisions: 2, steps: loopSteps });
  wp({ id: 'nrev', maxRevisions: 0, steps: loopSteps });
  const work = extra => ({ id: 'work', agent: 'codex-a', mode: 'execute', input: ['plan.md'], ...extra });
  wp({ id: 'hang', steps: [gatedPlan, work()] });
  wp({ id: 'perm', steps: [gatedPlan, work()] });
  wp({ id: 'tmo', steps: [gatedPlan, work({ timeoutMs: 800 })] });
  wp({ id: 'poolplan', steps: [{ id: 'plan', pool: 'codex', mode: 'plan', output: 'plan.md', gate: 'human' }, { id: 'code', pool: 'codex', mode: 'execute', input: ['plan.md'] }] });
  // 安全測試用:第一步就是 execute、沒有 human gate(必須被驗證器拒絕)
  wp({ id: 'unsafe', steps: [{ id: 'code', agent: 'codex-a', mode: 'execute' }] });
  wp({ id: 'agyflow', maxRevisions: 0, steps: [
    { id: 'plan', agent: 'agy-a', mode: 'plan', output: 'plan.md', gate: 'human' },
    { id: 'code', agent: 'codex-a', mode: 'execute', input: ['plan.md'] },
    { id: 'review', agent: 'agy-a', mode: 'review', input: ['plan.md'], output: 'review.md' },
  ] }); // agy 串流測試:plan / review 由 agy 擔任(fake CLI 把文字切成多段 text_delta)
  await startServer();
  engineMod = await import(pathToFileURL(path.join(sandbox, 'tools/engine.mjs')).href + '?t=' + Date.now());
});

test('model validation and prompt use the selected model', () => {
  const agents = [
    { id: 'a', type: 'codex', models: [{ id: 'fast', label: 'Fast' }], defaultModel: 'fast' },
    { id: 'b', type: 'codex', models: [{ id: 'slow', label: 'Slow' }], defaultModel: 'slow' },
  ];
  const valid = { id: 'models', steps: [{ id: 'plan', agent: 'a', mode: 'plan', model: 'fast' }] };
  assert.equal(engineMod.validatePipeline(valid, agents).ok, true);
  assert.match(engineMod.validatePipeline({ ...valid, steps: [{ ...valid.steps[0], model: 'bad model' }] }, agents).errors.join('|'), /invalid model/);
  assert.match(engineMod.validatePipeline({ ...valid, steps: [{ ...valid.steps[0], model: 'slow' }] }, agents).errors.join('|'), /unavailable/);
  const prompt = engineMod.buildPrompt({ pipeline: 'single', cwd: sandbox, feedback: {}, approvalNotes: [], taskId: 'x', runId: 'r' }, valid.steps[0], { agent: 'a', model: 'fast' }, { id: 'x' });
  assert.match(prompt, /Final selected model: fast/);
});

test('worktree runs use an isolated cwd, create diff.patch, then merge or discard safely', async () => {
  const dir = initGitProject('worktree', { writeTracked: true });
  const project = 'proj-worktree';
  assert.equal((await post('/api/projects', { id: project, name: project, path: dir, worktrees: true })).status, 200);
  assert.equal((await post('/api/tasks', { id: 't-wt', title: 't-wt', agent: 'codex-a', status: 'todo', project, pipeline: 'single' })).status, 200);
  await startApproved('t-wt');
  const run = await waitStatus('t-wt', 'completed');
  assert.equal(run.worktree.status, 'ready');
  assert.notEqual(run.cwd, dir);
  assert.ok(fs.existsSync(path.join(sandbox, 'board/runs/t-wt', run.runId, 'artifacts/diff.patch')));
  assert.equal(fs.readFileSync(path.join(dir, 'work.txt'), 'utf8'), 'base\n');
  assert.equal((await post('/api/runs/t-wt/merge')).status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'work.txt'), 'utf8'), /execute 1/);
  assert.ok(!fs.existsSync(run.worktree.path));

  assert.equal((await post('/api/tasks', { id: 't-wt-discard', title: 't-wt-discard', agent: 'codex-a', status: 'todo', project, pipeline: 'single' })).status, 200);
  await dispatch('t-wt-discard'); await waitNeeds('t-wt-discard', 'approval');
  assert.equal((await post('/api/runs/t-wt-discard/discard')).status, 409);
  assert.equal((await post('/api/runs/t-wt-discard/stop')).status, 200);
  const discarded = await post('/api/runs/t-wt-discard/discard');
  assert.equal(discarded.status, 200, JSON.stringify(discarded.json));
  const discardedRun = await getRun('t-wt-discard');
  assert.equal(discardedRun.worktree.status, 'discarded');
  assert.ok(!fs.existsSync(discardedRun.worktree.path));
  assert.equal(execFileSync('git', ['branch', '--list', discardedRun.worktree.branch], { cwd: dir, encoding: 'utf8' }).trim(), '');
});

test('worktree merge refuses a moved base or dirty main checkout and preserves the isolated run', async () => {
  const makeRun = async (id) => {
    const dir = initGitProject(id, { writeTracked: true });
    const project = 'proj-' + id;
    assert.equal((await post('/api/projects', { id: project, name: project, path: dir, worktrees: true })).status, 200);
    assert.equal((await post('/api/tasks', { id, title: id, agent: 'codex-a', status: 'todo', project, pipeline: 'single' })).status, 200);
    await startApproved(id);
    return { dir, run: await waitStatus(id, 'completed') };
  };

  const moved = await makeRun('t-wt-moved');
  fs.writeFileSync(path.join(moved.dir, 'advance.txt'), 'advance\n');
  execFileSync('git', ['add', 'advance.txt'], { cwd: moved.dir });
  execFileSync('git', ['commit', '-m', 'advance base'], { cwd: moved.dir });
  const movedMerge = await post('/api/runs/t-wt-moved/merge');
  assert.equal(movedMerge.status, 409);
  assert.ok(fs.existsSync(moved.run.worktree.path));
  assert.match(fs.readFileSync(path.join(moved.run.worktree.path, 'work.txt'), 'utf8'), /execute 1/);
  assert.equal(fs.readFileSync(path.join(moved.dir, 'work.txt'), 'utf8'), 'base\n');
  assert.equal((await getRun('t-wt-moved')).worktree.status, 'ready');
  assert.equal((await post('/api/runs/t-wt-moved/discard')).status, 200);

  const dirty = await makeRun('t-wt-dirty');
  fs.appendFileSync(path.join(dirty.dir, 'work.txt'), 'local uncommitted change\n');
  const dirtyMerge = await post('/api/runs/t-wt-dirty/merge');
  assert.equal(dirtyMerge.status, 409);
  assert.ok(fs.existsSync(dirty.run.worktree.path));
  assert.match(fs.readFileSync(path.join(dirty.run.worktree.path, 'work.txt'), 'utf8'), /execute 1/);
  assert.match(fs.readFileSync(path.join(dirty.dir, 'work.txt'), 'utf8'), /local uncommitted change/);
  assert.equal((await getRun('t-wt-dirty')).worktree.status, 'ready');
  assert.equal((await post('/api/runs/t-wt-dirty/discard')).status, 200);
});

test('worktree dispatch rejects a non-Git project before starting an agent', async () => {
  const id = 't-wt-not-git';
  const dir = mkProject(id, { noRuntimeFiles: true });
  const project = 'proj-' + id;
  assert.equal((await post('/api/projects', { id: project, name: project, path: dir, worktrees: true })).status, 200);
  assert.equal((await post('/api/tasks', { id, title: id, agent: 'codex-a', status: 'todo', project, pipeline: 'single' })).status, 200);
  const result = await dispatch(id);
  assert.equal(result.status, 409);
  assert.equal(calls(id).length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')));
  assert.equal((await api('/api/runs/' + id)).status, 404);
});

test('worktree diff and merge include untracked non-ignored files', async () => {
  const id = 't-wt-untracked';
  const dir = initGitProject(id, { writeUntracked: 'created by fake CLI\n', writeIgnored: 'must stay ignored\n' });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'ignore fixture'], { cwd: dir });
  const project = 'proj-' + id;
  assert.equal((await post('/api/projects', { id: project, name: project, path: dir, worktrees: true })).status, 200);
  assert.equal((await post('/api/tasks', { id, title: id, agent: 'codex-a', status: 'todo', project, pipeline: 'single' })).status, 200);
  await startApproved(id);
  const run = await waitStatus(id, 'completed');
  const patch = fs.readFileSync(path.join(sandbox, 'board/runs', id, run.runId, 'artifacts/diff.patch'), 'utf8');
  assert.match(patch, /new-file\.txt/);
  assert.match(patch, /created by fake CLI/);
  assert.doesNotMatch(patch, /ignored\.txt|must stay ignored/);
  assert.equal((await post('/api/runs/' + id + '/merge')).status, 200);
  // Windows autocrlf 可能把 LF 轉成 CRLF,所以先正規化再比對
  assert.equal(fs.readFileSync(path.join(dir, 'new-file.txt'), 'utf8').split('\r\n').join('\n'), 'created by fake CLI\n');
  assert.ok(!fs.existsSync(path.join(dir, 'ignored.txt')));
});

after(async () => {
  try { if (proc && proc.exitCode === null) await killServer(); } catch { /* ignore */ }
  // 殘留的假 CLI 卡住行程:逐一用記錄的 hang.pid 收掉(只殺本檔自己啟動的)
  for (const d of projDirs) {
    try { const pid = +fs.readFileSync(path.join(d, 'hang.pid'), 'utf8'); if (alive(pid)) process.kill(pid); } catch { /* 沒有 */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ------------------------------------------------------------------ (a) pipeline 驗證
test('(a) 內建 standard / single 驗證通過,review 不是 gemini', () => {
  const agents = JSON.parse(fs.readFileSync(path.join(sandbox, 'agents.json'), 'utf8')).agents;
  for (const id of ['standard', 'single']) {
    const def = engineMod.loadPipeline(id, agents);
    assert.equal(def.id, id);
  }
  const std = engineMod.loadPipeline('standard', agents);
  assert.equal(std.maxRevisions, 3);
  assert.deepEqual(std.steps.map(s => s.id), ['plan', 'code', 'test', 'review', 'revise']);
  assert.equal(std.steps[0].gate, 'human');
  assert.ok(!std.steps.some(s => s.agent === 'gemini'));
  assert.equal(engineMod.loadPipeline('single', agents).allowNoGate, undefined, 'allowNoGate 已整個移除');
  assert.equal(engineMod.loadPipeline('single', agents).steps[0].gate, 'human');
});

test('(a) 安全不變式:execute 之前必須有無條件的 human-gate plan(execute-only / 無 gate / gate 在後 / gate 帶 when 全部被拒)', () => {
  const agents = JSON.parse(fs.readFileSync(path.join(sandbox, 'agents.json'), 'utf8')).agents;
  const errs = def => engineMod.validatePipeline(def, agents).errors.join('|');
  const RE = /gate:"human" 的 plan step/;
  const P = { id: 'p', agent: 'claude', mode: 'plan', gate: 'human' };
  const X = { id: 'a', agent: 'claude', mode: 'execute' };
  assert.match(errs({ id: 'x', steps: [X] }), RE, 'execute-only');
  assert.match(errs({ id: 'x', steps: [{ ...P, gate: undefined }, X] }), RE, 'plan 沒有 gate');
  assert.match(errs({ id: 'x', steps: [X, P] }), RE, 'gate 在 execute 之後');
  assert.match(errs({ id: 'x', steps: [{ ...P, mode: 'review' }, X] }), RE, 'gate 不在 plan 類 step');
  assert.match(errs({ id: 'x', steps: [{ id: 'p0', agent: 'claude', mode: 'plan', output: 'p0.md' }, { ...P, when: 'p0.failed' }, X] }), RE, '帶 when 的 gate 會被略過');
  assert.match(errs({ id: 'x', steps: [{ id: 'c', type: 'command', command: 'x', gate: 'human' }, X] }), RE, 'command step 不算 plan');
  assert.equal(engineMod.validatePipeline({ id: 'x', steps: [P, X] }, agents).ok, true);
  // 由檔案載入也一樣被拒(pipelines/unsafe.json 第一步就是 execute)
  assert.throws(() => engineMod.loadPipeline('unsafe', agents), /驗證失敗.*gate:"human" 的 plan step/);
  const pl = engineMod.listPipelines().find(p => p.id === 'unsafe');
  assert.equal(pl.valid, false);
});

test('(a) artifact input 必須由「更早的 step」的 output 產生', () => {
  const agents = JSON.parse(fs.readFileSync(path.join(sandbox, 'agents.json'), 'utf8')).agents;
  const errs = def => engineMod.validatePipeline(def, agents).errors.join('|');
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', input: ['nope.md'] }] }), /input "nope\.md" 不是任何「更早的 step」的 output/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', input: ['b.md'] }, { id: 'b', agent: 'claude', mode: 'plan', output: 'b.md' }] }), /input "b\.md"/, '產出者在後面不算');
  assert.equal(engineMod.validatePipeline({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', output: 'a.md' }, { id: 'c', type: 'command', command: 'x' }, { id: 'b', agent: 'claude', mode: 'plan', input: ['a.md', 'c.txt'] }] }, agents).ok, true, 'command 未宣告 output 時預設 <id>.txt 也算產出');
});

test('(a) pool 驗證與 Codex quota failover 會保留 human gate', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(sandbox, 'agents.json'), 'utf8'));
  const agents = config.agents;
  const P = { id: 'plan', pool: 'codex', mode: 'plan', output: 'plan.md', gate: 'human' };
  const X = { id: 'code', pool: 'codex', mode: 'execute', input: ['plan.md'] };
  assert.equal(engineMod.validatePipeline({ id: 'pool-ok', steps: [P, X] }, agents, config.pools).ok, true);
  assert.match(engineMod.validatePipeline({ id: 'bad', steps: [{ ...P, agent: 'codex-a' }] }, agents, config.pools).errors.join('|'), /只能指定 agent 或 pool/);
  assert.match(engineMod.validatePipeline({ id: 'bad', steps: [{ ...P, pool: 'missing' }] }, agents, config.pools).errors.join('|'), /不存在或是空/);
  const id = 't-pool-failover';
  await mkTask(id, { pipeline: 'poolplan', control: { quotaOnce: 'plan' } });
  const d = await dispatch(id);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const waiting = await waitNeeds(id, 'approval');
  assert.equal(waiting.steps[0].agent, 'codex-a');
  assert.equal(waiting.steps[0].attempts, 2);
  assert.equal(callsOf(id, 'execute').length, 0, 'plan gate 前不得開始 execute');
  const events = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(events.some(e => e.kind === 'error' && e.phase === 'failover' && e.oldAgent === 'codex-b' && e.newAgent === 'codex-a'));
  const cooldowns = JSON.parse(fs.readFileSync(path.join(sandbox, 'board/runs/agent-cooldown.json'), 'utf8'));
  assert.ok(cooldowns['codex-b'].until > Date.now());
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 200);
  await waitStatus(id, 'completed');
});

test('(a) pool 全員額度耗盡會 blocked 並進 needs-you；冷卻到期後 retry 可再次選人', async () => {
  const id = 't-pool-exhausted';
  fs.mkdirSync(path.join(sandbox, 'board/runs'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'board/runs/agent-cooldown.json'), '{}');
  await mkTask(id, { pipeline: 'poolplan', control: { quota: 'plan' } });
  assert.equal((await dispatch(id)).status, 200);
  const run = await waitNeeds(id, 'no-agent-available');
  assert.equal(run.steps[0].status, 'blocked');
  assert.match(run.needsYou.message, /codex-b: cooldown until/);
  assert.match(run.needsYou.message, /codex-a: cooldown until/);
  const events = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(events.some(e => e.phase === 'failover' && e.oldAgent === 'codex-a' && e.newAgent === null));

  // Simulate both reset times passing. The retry must not retain stale
  // same-step attempts as a permanent exclusion.
  fs.writeFileSync(path.join(sandbox, 'board/runs/agent-cooldown.json'), JSON.stringify({
    'codex-b': { until: Date.now() - 1 }, 'codex-a': { until: Date.now() - 1 },
  }));
  fs.writeFileSync(path.join(run.cwd, 'fake-control.json'), JSON.stringify({}));
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'retry' })).status, 200);
  const approved = await waitNeeds(id, 'approval');
  assert.equal(approved.steps[0].agent, 'codex-b');
});

test('(a) 新 run 略過未到期 cooldown；非 quota 失敗不會換手', async () => {
  fs.writeFileSync(path.join(sandbox, 'board/runs/agent-cooldown.json'), JSON.stringify({
    'codex-b': { until: Date.now() + 60_000, reason: 'quota-exhausted' },
  }));
  await mkTask('t-pool-cooldown', { pipeline: 'poolplan' });
  assert.equal((await dispatch('t-pool-cooldown')).status, 200);
  const cooled = await waitNeeds('t-pool-cooldown', 'approval');
  assert.equal(cooled.steps[0].agent, 'codex-a');

  fs.writeFileSync(path.join(sandbox, 'board/runs/agent-cooldown.json'), '{}');
  await mkTask('t-pool-error', { pipeline: 'poolplan', control: { exit: { plan: 7 } } });
  assert.equal((await dispatch('t-pool-error')).status, 200);
  const failed = await waitStatus('t-pool-error', 'failed');
  assert.equal(failed.steps[0].agent, 'codex-b');
  assert.equal(failed.steps[0].attempts, 1);
  assert.ok(!(await api('/api/runs/t-pool-error/events')).json.some(e => e.phase === 'failover'));
});

test('(a) 各種非法 pipeline 都有明確錯誤訊息', () => {
  const agents = JSON.parse(fs.readFileSync(path.join(sandbox, 'agents.json'), 'utf8')).agents;
  const errs = def => engineMod.validatePipeline(def, agents).errors.join('|');
  const ok = { id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan' }] };
  assert.equal(engineMod.validatePipeline(ok, agents).ok, true);
  assert.match(errs(null), /JSON 物件/);
  assert.match(errs({ steps: ok.steps }), /缺少 id/);
  assert.match(errs({ ...ok, id: 'bad id!' }), /id 不合法/);
  assert.match(errs({ id: 'x', steps: [] }), /非空陣列/);
  assert.match(errs({ ...ok, maxRevisions: -1 }), /maxRevisions/);
  assert.match(errs({ id: 'x', steps: [{ agent: 'claude', mode: 'plan' }] }), /缺少 id/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'nobody', mode: 'plan' }] }), /未知 agent "nobody"/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'fly' }] }), /mode/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan' }, { id: 'a', agent: 'claude', mode: 'plan' }] }), /step id 重複/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', type: 'command' }] }), /command/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', type: 'shell' }] }), /type/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', output: '../evil' }] }), /output/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', input: ['a/b'] }] }), /input/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', gate: 'auto' }] }), /gate/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', loopTo: 'zzz', when: 'a.failed' }] }), /loopTo 指向不存在的 step/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan' }, { id: 'b', agent: 'claude', mode: 'plan', loopTo: 'a' }] }), /必須有 when/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', when: 'zzz.failed' }] }), /when 指向不存在的 step/);
  assert.match(errs({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan', when: 'oops' }] }), /when 格式/);
  assert.match(engineMod.validatePipeline({ id: 'x', steps: [{ id: 'a', agent: 'claude', mode: 'plan' }] }, [{ id: 'claude', type: 'mystery' }]).errors.join('|'), /沒有對應 adapter/);
  assert.throws(() => engineMod.loadPipeline('nope-not-here', agents), /找不到 pipeline/);
  assert.throws(() => engineMod.loadPipeline('../x', agents), /不合法/);
});

// ------------------------------------------------------------------ (b) 完整流程(真實 standard.json,npm test)
test('(b) standard:plan → gate → 核准 → code → test → review PASS → completed;task 狀態對映', async () => {
  const id = 't-full';
  const dir = await mkTask(id, { pipeline: 'standard' });
  const d = await dispatch(id);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.engine, true);
  const r1 = await waitStatus(id, 'needs-you');
  assert.equal(r1.needsYou.reason, 'approval');
  assert.equal(r1.steps[0].status, 'awaiting-approval');
  // task 狀態:檔案是 needs-you,API 的 status 對映到 review 欄,state 為 v2 值
  let t = (await api('/api/tasks')).json.find(x => x.id === id);
  assert.equal(t.status, 'review');
  assert.equal(t.state, 'needs-you');
  assert.match(fs.readFileSync(path.join(sandbox, 'board/tasks', id + '.md'), 'utf8'), /^status: needs-you$/m);
  // plan.md 已存成 artifact
  const plan = await api(`/api/runs/${id}/artifacts/plan.md`);
  assert.equal(plan.status, 200);
  assert.match(plan.text, /# Plan/);
  // plan 的呼叫用唯讀旗標,prompt 含 goal/acceptance
  const pc = callsOf(id, 'plan');
  assert.equal(pc.length, 1);
  assert.equal(pc[0].flagMode, 'readonly');
  assert.equal(pc[0].flavor, 'claude');
  assert.match(pc[0].prompt, /目標 t-full/);
  assert.match(pc[0].prompt, /- 驗收甲/);
  const ap = await post(`/api/runs/${id}/approve`, { note: '請小心 X' });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const done = await waitStatus(id, 'completed');
  assert.deepEqual(done.steps.map(s => s.status), ['done', 'done', 'done', 'done', 'skipped']);
  assert.equal(done.steps[3].verdict, 'PASS');
  const ec = callsOf(id, 'execute');
  assert.equal(ec.length, 1);
  assert.equal(ec[0].flavor, 'codex');
  assert.equal(ec[0].flagMode, 'write');
  assert.match(ec[0].prompt, /# Plan/, 'execute 的 prompt 帶入 plan.md');
  assert.match(ec[0].prompt, /請小心 X/, '核准附註併入 execute prompt');
  assert.match(ec[0].prompt, /- cwd: |工作目錄: /);
  assert.equal(fs.readFileSync(path.join(dir, 'executed.marker'), 'utf8'), '1');
  assert.match((await api(`/api/runs/${id}/artifacts/test.txt`)).text, /\[exit 0\]/);
  assert.match((await api(`/api/runs/${id}/artifacts/review.md`)).text, /^VERDICT: PASS/);
  const detail = (await api('/api/runs/' + id)).json;
  assert.ok(detail.artifacts.map(a => a.name).includes('plan.md'));
  assert.ok(detail.artifacts.map(a => a.name).includes('review.md'));
  t = (await api('/api/tasks')).json.find(x => x.id === id);
  assert.equal(t.status, 'done');
  assert.equal(t.state, 'completed');
  // run 目錄結構(spec §4.5)
  const rd = path.join(sandbox, 'board/runs', id, done.runId);
  for (const f of ['run.json', 'events.jsonl', 'artifacts/plan.md', 'raw/plan.log', 'raw/code.log']) assert.ok(fs.existsSync(path.join(rd, f)), f);
  // 舊的 log viewer 端點也讀得到新引擎的 run
  const lg = (await api(`/api/tasks/${id}/log`)).json;
  assert.equal(lg.status, 'exited');
  assert.match(lg.content, /step plan/);
  assert.match(lg.content, /step code/);
  assert.match(lg.content, /VERDICT: PASS/);
});

// ------------------------------------------------------------------ (c) gate 未核准前絕不啟動 execute
test('(c) gate 未核准:execute 類 step 完全不會被啟動(標記檔/呼叫紀錄/step 狀態都證明)', async () => {
  const id = 't-gate';
  const dir = await mkTask(id, { pipeline: 'stdfast' });
  assert.equal((await dispatch(id)).status, 200);
  const r = await waitStatus(id, 'needs-you');
  await sleep(1500); // 給引擎足夠時間「錯誤地」往下跑
  assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')), 'execute 假 CLI 寫的標記檔不應存在');
  assert.equal(callsOf(id, 'execute').length, 0);
  assert.equal(callsOf(id, 'review').length, 0);
  const r2 = await getRun(id);
  assert.equal(r2.status, 'needs-you');
  assert.deepEqual(r2.steps.map(s => s.status), ['awaiting-approval', 'pending', 'pending', 'pending', 'pending']);
  assert.ok(!fs.existsSync(path.join(sandbox, 'board/runs', id, r.runId, 'raw/code.log')));
  // 不能對非等待中的狀態亂核准 / 沒 run 的任務
  assert.equal((await post('/api/runs/no-such-task/approve')).status, 404);
  // 同一任務已有 active run:再 dispatch 被擋
  const again = await dispatch(id);
  assert.equal(again.status, 409);
  // 核准後才會動
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 200);
  await waitStatus(id, 'completed');
  assert.equal(callsOf(id, 'execute').length, 1);
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 409, '已完成的 run 不能再核准');
});

// ------------------------------------------------------------------ (d) reject 帶意見重跑 plan
test('(d) reject 帶意見:重跑 plan、意見與上一版計畫出現在 prompt、期間 execute 不啟動', async () => {
  const id = 't-reject';
  const dir = await mkTask(id, { pipeline: 'stdfast' });
  await dispatch(id);
  await waitStatus(id, 'needs-you');
  assert.equal((await post(`/api/runs/${id}/reject`, {})).status, 400, '沒帶意見不可退回');
  const rj = await post(`/api/runs/${id}/reject`, { feedback: '請改用方案 Z,不要動 config' });
  assert.equal(rj.status, 200, JSON.stringify(rj.json));
  await waitFor(() => callsOf(id, 'plan').length === 2);
  await waitStatus(id, 'needs-you');
  const p2 = callsOf(id, 'plan')[1];
  assert.match(p2.prompt, /請改用方案 Z,不要動 config/);
  assert.match(p2.prompt, /上一版 plan\.md/);
  assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')), '退回期間 execute 不可啟動');
  assert.equal(callsOf(id, 'execute').length, 0);
  assert.match((await api(`/api/runs/${id}/artifacts/plan.md`)).text, /plan #2/);
  await post(`/api/runs/${id}/approve`);
  await waitStatus(id, 'completed');
  assert.equal(callsOf(id, 'plan').length, 2);
});

// ------------------------------------------------------------------ (e) 回修迴圈
test('(e) review FAIL → revise → PASS(revise 的 prompt 帶 review.md)', async () => {
  const id = 't-revise';
  await mkTask(id, { pipeline: 'stdfast', control: { verdicts: ['FAIL', 'PASS'] } });
  await dispatch(id);
  await waitStatus(id, 'needs-you');
  await post(`/api/runs/${id}/approve`);
  const done = await waitStatus(id, 'completed', 30000);
  assert.equal(done.revisions, 1);
  assert.equal(callsOf(id, 'review').length, 2);
  const ex = callsOf(id, 'execute');
  assert.equal(ex.length, 2, 'code + revise');
  assert.match(ex[1].prompt, /VERDICT: FAIL/);
  assert.match(ex[1].prompt, /審查第 1 次的理由/);
  assert.equal(done.steps[3].verdict, 'PASS');
  assert.equal(done.steps[4].status, 'skipped', '最後一輪 review PASS,revise 略過');
  const evs = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(evs.some(e => e.phase === 'revision'));
});

test('(e) 測試指令失敗時,即使 review 回 PASS 也判 FAIL 並回修', async () => {
  const id = 't-testfail';
  await mkTask(id, { pipeline: 'stdfast', control: { testExits: [1, 0], verdicts: ['PASS'] } });
  await dispatch(id);
  await waitStatus(id, 'needs-you');
  await post(`/api/runs/${id}/approve`);
  const done = await waitStatus(id, 'completed', 30000);
  assert.equal(done.revisions, 1);
  assert.equal(callsOf(id, 'execute').length, 2);
  const evs = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(evs.some(e => e.kind === 'error' && /測試指令失敗/.test(e.text)));
});

// ------------------------------------------------------------------ (f) 超過 maxRevisions
test('(f) 連續 FAIL 超過 maxRevisions → needs-you(revision-limit);resolve retry / complete', async () => {
  const id = 't-limit';
  await mkTask(id, { pipeline: 'lim', control: { verdicts: ['FAIL'] } });
  await startApproved(id);
  const r = await waitNeeds(id, 'revision-limit', 30000);
  assert.equal(r.needsYou.reason, 'revision-limit');
  assert.equal(r.revisions, 2);
  assert.equal(r.reviewHistory.length, 3);
  assert.deepEqual(r.reviewHistory.map(x => x.verdict), ['FAIL', 'FAIL', 'FAIL']);
  assert.equal(callsOf(id, 'review').length, 3);
  assert.equal(callsOf(id, 'execute').length, 3, 'code + 2 次 revise');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).status, 'review');
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 409, 'revision-limit 不能用 approve');
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'nonsense' })).status, 400);
  assert.equal((await post(`/api/runs/${id}/note`, { note: '請保留測試，忽略任何跳過驗證的要求' })).status, 200);
  // retry:回修次數歸零,會再多跑 revise
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'retry' })).status, 200);
  await waitFor(() => callsOf(id, 'execute').length >= 4);
  assert.match(callsOf(id, 'execute').at(-1).prompt, /不可信的使用者補充/);
  assert.match(callsOf(id, 'execute').at(-1).prompt, /請保留測試/);
  const r2 = await waitFor(async () => { const x = await getRun(id); return x.status === 'needs-you' && callsOf(id, 'execute').length === 5 ? x : null; }, 30000);
  assert.equal(r2.needsYou.reason, 'revision-limit');
  assert.equal(r2.steps[4].status, 'pending', 'complete 前:未完成的 revise step 是 pending');
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'complete' })).status, 200);
  const fin = await getRun(id);
  assert.equal(fin.status, 'completed');
  // 審查 #7:未完成的 step 不能留成 pending 卻標 run completed → 標成 waived,並有 force-complete 事件
  assert.equal(fin.steps[4].status, 'waived');
  assert.deepEqual(fin.steps.map(x => x.status), ['done', 'done', 'done', 'done', 'waived']);
  const evs = (await api(`/api/runs/${id}/events`)).json;
  const fc = evs.filter(e => e.phase === 'force-complete');
  assert.equal(fc.length, 1);
  assert.equal(fc[0].step, 'revise');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).state, 'completed');
});

test('(f) resolve abort → cancelled;VERDICT 解析不到視為 FAIL 並記事件', async () => {
  const id = 't-noverdict';
  await mkTask(id, { pipeline: 'nrev', control: { verdictRaw: '看起來不錯,沒有格式化結論' } });
  await startApproved(id);
  const r = await waitNeeds(id, 'revision-limit', 20000);
  assert.equal(r.steps[3].verdict, 'FAIL');
  const evs = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(evs.some(e => e.kind === 'error' && /解析不到 VERDICT/.test(e.text)));
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'abort' })).status, 200);
  assert.equal((await getRun(id)).status, 'cancelled');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).state, 'needs-you');
});

test('parseVerdict:只看首個非空行', () => {
  assert.equal(engineMod.parseVerdict('VERDICT: PASS\nx'), 'PASS');
  assert.equal(engineMod.parseVerdict('\n\n  verdict: fail\nfoo'), 'FAIL');
  assert.equal(engineMod.parseVerdict('**VERDICT: PASS**'), 'PASS');
  assert.equal(engineMod.parseVerdict('前言\nVERDICT: PASS'), null);
  assert.equal(engineMod.parseVerdict(''), null);
});

// ------------------------------------------------------------------ (g) stop
test('(g) stop 能砍掉卡住的行程(pid 不再存活),之後 retry 從該 step 重跑', async () => {
  const id = 't-stop';
  const dir = await mkTask(id, { pipeline: 'hang', control: { hang: 'execute' } });
  await startApproved(id);
  await waitFor(() => fs.existsSync(path.join(dir, 'hang.pid')));
  const pid = +fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8');
  const r = await getRun(id);
  assert.equal(r.status, 'running');
  assert.equal(r.steps[1].pid, pid, 'run.json 記的 pid 就是實際行程');
  assert.ok(alive(pid));
  const st = await post(`/api/runs/${id}/stop`);
  assert.equal(st.status, 200, JSON.stringify(st.json));
  await waitFor(() => !alive(pid), 8000, 'pid 死亡');
  const r2 = await getRun(id);
  assert.equal(r2.status, 'cancelled');
  assert.equal(r2.steps[1].status, 'stopped');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).state, 'cancelled');
  assert.equal((await post(`/api/runs/${id}/stop`)).status, 400, '沒有進行中的 run 不能再停');
  // 續跑:換成不卡住的設定,retry 從被停的 step 重跑
  fs.writeFileSync(path.join(dir, 'fake-control.json'), '{}');
  assert.equal((await post(`/api/runs/${id}/retry`)).status, 200);
  const fin = await waitStatus(id, 'completed');
  assert.equal(fin.steps[1].attempts, 2);
});

test('(g) 舊的 /api/tasks/:id/stop 也能停新引擎的 run;逾時(timeoutMs)→ needs-you 並砍行程', async () => {
  const id = 't-stop2';
  const dir = await mkTask(id, { pipeline: 'hang', control: { hang: 'execute' } });
  await startApproved(id);
  await waitFor(() => fs.existsSync(path.join(dir, 'hang.pid')));
  const pid = +fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8');
  const lg = (await api(`/api/tasks/${id}/log`)).json;
  assert.equal(lg.status, 'running');
  assert.equal(lg.pid, pid);
  assert.equal((await post(`/api/tasks/${id}/stop`)).status, 200);
  await waitFor(() => !alive(pid), 8000);
  assert.equal((await getRun(id)).status, 'cancelled');

  const id2 = 't-timeout';
  const dir2 = await mkTask(id2, { pipeline: 'tmo', control: { hang: 'execute' } });
  await startApproved(id2);
  const r = await waitNeeds(id2, 'timeout', 15000);
  assert.equal(r.needsYou.reason, 'timeout');
  // 審查 #7:timeout 類不能 complete(只能 retry/abort),step 狀態與 run 都不變
  const cc = await post(`/api/runs/${id2}/resolve`, { action: 'complete' });
  assert.equal(cc.status, 409);
  assert.match(cc.json.error, /timeout/);
  const still = await getRun(id2);
  assert.equal(still.status, 'needs-you');
  assert.equal(still.steps[1].status, 'blocked');
  const pid2 = +fs.readFileSync(path.join(dir2, 'hang.pid'), 'utf8');
  await waitFor(() => !alive(pid2), 8000);
});

// ------------------------------------------------------------------ (h) events / artifacts
test('(h) events.jsonl 有標準化事件、since 可分段;artifacts 端點防路徑穿越', async () => {
  const id = 't-full'; // 沿用 (b) 已完成的 run
  const run = await getRun(id);
  const file = path.join(sandbox, 'board/runs', id, run.runId, 'events.jsonl');
  const disk = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(disk.length >= 8);
  for (const e of disk) { assert.equal(e.runId, run.runId); assert.ok(e.ts); assert.ok(['start', 'message', 'tool', 'file-edit', 'command', 'test', 'error', 'end'].includes(e.kind), e.kind); }
  assert.ok(disk.some(e => e.step === 'plan' && e.kind === 'message' && /# Plan/.test(e.text)), 'adapter 解析出的訊息事件');
  assert.ok(disk.some(e => e.step === 'test' && e.kind === 'test'));
  assert.ok(disk.some(e => e.step === 'code' && e.kind === 'end' && !e.engine), 'adapter 的 end 事件');
  const all = (await api(`/api/runs/${id}/events`)).json;
  assert.equal(all.length, disk.length);
  const part = (await api(`/api/runs/${id}/events?since=3`)).json;
  assert.equal(part.length, disk.length - 3);
  assert.deepEqual(part[0], disk[3]);
  assert.equal((await api(`/api/runs/${id}/events?since=99999`)).json.length, 0);
  // 路徑穿越
  for (const bad of ['..', '../agents.json', '..%2fagents.json', '..%5cagents.json', '%2e%2e%2fagents.json', 'a..b', 'x%00.md', '.', 'plan.md%20']) {
    const r = await api(`/api/runs/${id}/artifacts/${bad}`);
    assert.ok([400, 404].includes(r.status), `${bad} → ${r.status}`);
    assert.ok(!/"agents"/.test(r.text), bad + ' 不可洩漏 agents.json');
  }
  assert.equal((await api(`/api/runs/${id}/artifacts/agents.json`)).status, 404);
  assert.equal((await api(`/api/runs/${id}/artifacts/plan.md`)).status, 200);
  assert.equal((await api('/api/runs/no-such-task')).status, 404);
});

// ------------------------------------------------------------------ 權限被拒 / 核准關卡不可繞過
test('execute 遇到權限被拒訊號 → needs-you(permission),不無限等待;permission 類不能 complete(只能 retry/abort)', async () => {
  const id = 't-perm';
  await mkTask(id, { pipeline: 'perm', control: { denyExecute: true } });
  await startApproved(id);
  const r = await waitNeeds(id, 'permission', 15000);
  assert.equal(r.needsYou.reason, 'permission');
  assert.equal(r.steps[1].status, 'blocked');
  assert.ok(r.steps[1].blocked.length >= 1);
  // 審查 #7:permission 類 complete 回 409,run 與 step 狀態都不變
  const cc = await post(`/api/runs/${id}/resolve`, { action: 'complete' });
  assert.equal(cc.status, 409);
  assert.match(cc.json.error, /permission/);
  const still = await getRun(id);
  assert.equal(still.status, 'needs-you');
  assert.equal(still.steps[1].status, 'blocked');
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'abort' })).status, 200);
});

test('single pipeline:@task agent;plan 先 gate;request 帶 noGate 被完全忽略,仍必須核准才 execute(含 standard)', async () => {
  const id = 't-single';
  await mkTask(id, { pipeline: 'single', agent: 'claude' });
  await dispatch(id);
  const r = await waitNeeds(id, 'approval');
  assert.equal(r.steps[0].agent, 'claude');
  assert.equal(callsOf(id, 'execute').length, 0);
  await post(`/api/runs/${id}/approve`);
  await waitStatus(id, 'completed');
  assert.equal(callsOf(id, 'execute')[0].flavor, 'claude');

  // 舊的 noGate:仍回 200(參數被忽略),但 execute 在核准前絕不啟動
  for (const [tid, pipeline] of [['t-nogate', 'single'], ['t-nogate-std', 'stdfast']]) {
    const dir = await mkTask(tid, { pipeline, agent: 'codex-a' });
    const d = await dispatch(tid, { noGate: true, allowNoGate: true });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    await waitNeeds(tid, 'approval');
    await sleep(1200); // 給引擎足夠時間「錯誤地」往下跑
    const run = await getRun(tid);
    assert.equal(run.noGate, undefined, 'run 不再有 noGate 欄位');
    assert.equal(run.steps[0].status, 'awaiting-approval');
    assert.equal(run.steps[1].status, 'pending');
    assert.equal(callsOf(tid, 'execute').length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')), `${tid}: 未核准前 execute 假 CLI 不可被啟動`);
    assert.equal((await post(`/api/runs/${tid}/approve`)).status, 200);
    await waitStatus(tid, 'completed');
    assert.equal(callsOf(tid, 'execute').length, 1);
  }
  // single 沒指派 agent → 拒絕
  await mkTask('t-noagent', { pipeline: 'single', agent: '' });
  assert.equal((await dispatch('t-noagent')).status, 400);
});

test('沒有 pipeline 欄位的任務一律預設 single(有 plan + gate),舊單發派工不可達;指定不存在的 pipeline → 400', async () => {
  const dir = await mkTask('old-1', { agent: 'claude' }); // 不帶 pipeline、project 也沒有 defaultPipeline 覆寫(POST 預設 standard)
  const d = await dispatch('old-1');
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.engine, true);
  assert.equal(d.json.pid, null);
  await waitNeeds('old-1', 'approval');
  await sleep(800);
  const run = await getRun('old-1');
  assert.equal(run.pipeline, 'standard', '專案預設 standard(POST /api/projects 的預設值)');
  assert.equal(callsOf('old-1', 'execute').length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')));
  const lg = (await api('/api/tasks/old-1/log')).json;
  assert.ok(lg.runId, 'log viewer 回的是引擎 run,不是舊單發派工的 log');
  assert.equal((await post('/api/runs/old-1/stop')).status, 200);

  // 完全沒有 project 也沒有 pipeline 的任務 → 預設 single
  await post('/api/tasks', { id: 'old-nop', title: 'old-nop', agent: 'claude', status: 'todo' });
  const d2 = await dispatch('old-nop');
  assert.equal(d2.status, 200, JSON.stringify(d2.json));
  assert.equal(d2.json.pipeline, 'single');
  await waitNeeds('old-nop', 'approval');
  assert.equal(callsOf('old-nop', 'execute').length, 0);
  assert.equal((await post('/api/runs/old-nop/stop')).status, 200);

  // 明確指定卻不存在的 pipeline:報錯,不退回舊路徑,任務狀態不變、不建 run
  await mkTask('old-2', { pipeline: 'ghost' });
  const g = await dispatch('old-2');
  assert.equal(g.status, 400);
  assert.match(g.json.error, /pipeline「ghost」不存在/);
  assert.equal((await api('/api/runs/old-2')).status, 404);
  assert.equal((await api('/api/tasks')).json.find(x => x.id === 'old-2').status, 'todo');
  // GET /api/pipelines
  const pl = (await api('/api/pipelines')).json;
  assert.ok(pl.find(p => p.id === 'standard' && p.valid));
});

test('execute-only pipeline(沒有 human-gate plan)被拒:dispatch 回 400,agent 完全不啟動', async () => {
  const dir = await mkTask('t-unsafe', { pipeline: 'unsafe' });
  const d = await dispatch('t-unsafe');
  assert.equal(d.status, 400);
  assert.match(d.json.error, /gate:"human" 的 plan step/);
  await sleep(500);
  assert.equal(calls('t-unsafe').length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')));
  assert.equal((await api('/api/runs/t-unsafe')).status, 404);
  assert.equal((await api('/api/tasks')).json.find(x => x.id === 't-unsafe').status, 'todo');
  // 執行期防線:即使 run.json 被手改成沒有 gate 的 pipelineDef,引擎也不會啟動 execute(assertGatesCleared)
  const id = 't-tamper';
  const tdir = await mkTask(id, { pipeline: 'single', agent: 'claude' });
  await dispatch(id);
  const r = await waitNeeds(id, 'approval');
  await killServer();
  const rj = path.join(sandbox, 'board/runs', id, r.runId, 'run.json');
  const j = JSON.parse(fs.readFileSync(rj, 'utf8'));
  j.pipelineDef.steps[0].gate = undefined; // 拿掉 gate
  j.steps[0].status = 'pending'; j.cursor = 1; j.status = 'running'; j.needsYou = null; // 假裝 plan 已過,直接跳到 execute
  fs.writeFileSync(rj, JSON.stringify(j));
  await startServer();
  const bad = await waitStatus(id, 'failed', 10000);
  assert.match(bad.error, /gate 違規/);
  assert.equal(callsOf(id, 'execute').length, 0);
  assert.ok(!fs.existsSync(path.join(tdir, 'executed.marker')));
});

// ------------------------------------------------------------------ 缺 input artifact 硬失敗(審查 #5)
test('缺 input artifact → step 失敗並進 needs-you(missing-input,寫明缺哪個檔),不啟動 agent;不能 complete;補檔後 retry 可繼續', async () => {
  const id = 't-noinput';
  const dir = await mkTask(id, { pipeline: 'stdfast' });
  await dispatch(id);
  const r0 = await waitNeeds(id, 'approval');
  const planFile = path.join(sandbox, 'board/runs', id, r0.runId, 'artifacts/plan.md');
  fs.rmSync(planFile); // 模擬檔案遺失
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 200);
  const r = await waitNeeds(id, 'missing-input', 10000);
  assert.match(r.needsYou.message, /plan\.md/);
  assert.equal(r.steps[1].status, 'failed');
  assert.match(r.steps[1].error, /缺少 input artifact: plan\.md/);
  await sleep(500);
  assert.equal(callsOf(id, 'execute').length, 0, 'execute agent 不可在缺 plan.md 時被啟動');
  assert.ok(!fs.existsSync(path.join(dir, 'executed.marker')));
  const evs = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(evs.some(e => e.kind === 'error' && /缺少 input artifact/.test(e.text)));
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'complete' })).status, 409, 'missing-input 不能強制完成');
  // 補檔 → retry 從失敗的 step 繼續,prompt 帶到真正的 plan 內容
  fs.writeFileSync(planFile, '# Plan\n補回來的計畫 RESTORED');
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'retry' })).status, 200);
  await waitStatus(id, 'completed');
  assert.match(callsOf(id, 'execute')[0].prompt, /補回來的計畫 RESTORED/);
  assert.ok(!callsOf(id, 'execute')[0].prompt.includes('(尚未產生)'));
});

// ------------------------------------------------------------------ agy 串流(審查 #4)
test('agy 串流:plan.md / review.md 取 result.response 的完整文字,不是最後一個 delta;VERDICT 首行正確', async () => {
  const id = 't-agy';
  const dir = await mkTask(id, { pipeline: 'agyflow', agent: 'claude' });
  await dispatch(id);
  const r = await waitNeeds(id, 'approval');
  const planText = '# Plan\n- step A (plan #1)\n- 預計動到 src/a.js';
  assert.equal((await api(`/api/runs/${id}/artifacts/plan.md`)).text, planText);
  const raw = fs.readFileSync(path.join(sandbox, 'board/runs', id, r.runId, 'raw/plan.log'), 'utf8');
  assert.ok(raw.split('\n').filter(l => l.includes('text_delta')).length >= 3, 'fixture 確實把回覆切成 3 段以上 delta');
  assert.ok(raw.includes('"response"'), 'result 帶有完整 response');
  assert.equal(callsOf(id, 'plan')[0].flavor, 'agy');
  assert.equal(callsOf(id, 'plan')[0].flagMode, 'readonly');
  await post(`/api/runs/${id}/approve`);
  const done = await waitStatus(id, 'completed');
  const review = (await api(`/api/runs/${id}/artifacts/review.md`)).text;
  assert.equal(review, 'VERDICT: PASS\n審查第 1 次的理由');
  assert.equal(done.steps[2].verdict, 'PASS', '首個 delta 只有 "VERDICT:" 一小段,只取最後一段會被誤判 FAIL');
  assert.equal(fs.readFileSync(path.join(dir, 'executed.marker'), 'utf8'), '1');
});

test('agy 串流:result 沒有 response 時,依序串接所有 text_delta(不是只取最後一段)', async () => {
  const id = 't-agy-nores';
  await mkTask(id, { pipeline: 'agyflow', agent: 'claude', control: { agyNoResponse: true } });
  await dispatch(id);
  await waitNeeds(id, 'approval');
  assert.equal((await api(`/api/runs/${id}/artifacts/plan.md`)).text, '# Plan\n- step A (plan #1)\n- 預計動到 src/a.js');
  assert.equal((await post(`/api/runs/${id}/stop`)).status, 200);
});

// ------------------------------------------------------------------ 耐久性(審查 #6)
test('run.json 用暫存檔 + rename 原子寫入:完成的 run 目錄沒有殘留暫存檔,run.json 是完整 JSON', async () => {
  const run = await getRun('t-full');
  const rd = path.join(sandbox, 'board/runs/t-full', run.runId);
  assert.deepEqual(fs.readdirSync(rd).filter(f => /\.tmp-/.test(f)), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8')).runId, run.runId);
  assert.ok(/writeFileAtomic/.test(fs.readFileSync(path.join(repo, 'tools/engine.mjs'), 'utf8')));
});

test('startRun 初始 run.json 寫入失敗 → 中止:丟錯誤、不啟動 agent、不建 run、任務狀態不變', async () => {
  const id = 't-persist-fail';
  await mkTask(id, { pipeline: 'single', agent: 'claude' });
  const FIXED = 1700000000123;
  const runDir = path.join(sandbox, 'board/runs', id, 'run-' + FIXED);
  fs.mkdirSync(path.join(runDir, 'run.json'), { recursive: true }); // run.json 是資料夾 → rename 覆蓋必失敗
  const origNow = Date.now; Date.now = () => FIXED;
  try { assert.throws(() => engineMod.startRun(id), err => /run\.json 寫入失敗/.test(err.message) && err.status === 500); }
  finally { Date.now = origNow; }
  await sleep(800);
  assert.equal(calls(id).length, 0, '沒有任何 agent 被啟動');
  assert.ok(!fs.existsSync(runDir), '失敗的 run 目錄被清掉');
  assert.equal(engineMod.getLatestRun(id), null);
  assert.equal((await api('/api/runs/' + id)).status, 404);
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).status, 'todo');
});

test('執行中寫入失敗不靜默:events.jsonl append 失敗 → console.error + run.persistError(並落到 run.json)', async () => {
  const id = 't-persist-ev';
  await mkTask(id, { pipeline: 'single', agent: 'claude' });
  const FIXED = 1700000000456;
  const runDir = path.join(sandbox, 'board/runs', id, 'run-' + FIXED);
  fs.mkdirSync(path.join(runDir, 'events.jsonl'), { recursive: true }); // events.jsonl 是資料夾 → append 必失敗
  const errs = []; const origErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  const origNow = Date.now; Date.now = () => FIXED;
  try {
    engineMod.startRun(id);
    Date.now = origNow;
    await waitFor(() => engineMod.getLatestRun(id)?.status === 'needs-you', 15000, 'in-process run needs-you');
    const run = engineMod.getLatestRun(id);
    assert.match(run.persistError, /^events\.jsonl:/);
    assert.ok(errs.some(e => /events\.jsonl 寫入失敗/.test(e)));
    assert.match(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).persistError, /events\.jsonl/);
    await engineMod.stopRun(id);
  } finally { Date.now = origNow; console.error = origErr; }
});

// ------------------------------------------------------------------ taskkill(審查 #8)
test('killTree:pid 必須是正整數,否則不執行;engine/dispatch 不再用 exec 字串插值 taskkill', async () => {
  for (const bad of ['1; calc', '123', '1 & calc', 1.5, -1, 0, NaN, null, undefined, {}, [1]]) {
    const r = await engineMod.killTree(bad);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /pid/);
  }
  const dispatchMod = await import(pathToFileURL(path.join(sandbox, 'tools/dispatch.mjs')).href + '?t=' + Date.now());
  assert.equal(dispatchMod.isPidRunning('1 & calc'), false);
  assert.equal(dispatchMod.isPidRunning(-5), false);
  for (const f of ['engine.mjs', 'dispatch.mjs']) {
    const src = fs.readFileSync(path.join(repo, 'tools', f), 'utf8');
    assert.ok(!/[^\w.]exec\(/.test(src), `${f} 不可再用 exec(...)`);
    assert.ok(/execFile\('taskkill', \['\/pid', String\(/.test(src), `${f} 用 execFile('taskkill', [...])`);
  }
});

// ------------------------------------------------------------------ server 重啟後的持久化
test('重啟:等待核准中的 run 不需要行程,重啟後仍可核准並完成', async () => {
  const id = 't-restart-gate';
  await mkTask(id, { pipeline: 'stdfast' });
  await dispatch(id);
  await waitStatus(id, 'needs-you');
  await killServer();
  await startServer();
  const r = await getRun(id);
  assert.equal(r.status, 'needs-you');
  assert.equal(callsOf(id, 'execute').length, 0);
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 200);
  await waitStatus(id, 'completed');
  assert.equal(callsOf(id, 'execute').length, 1);
});

test('重啟:running 中的 run 以 pid 存活檢查接手,之後仍可 stop', async () => {
  const id = 't-restart-run';
  const dir = await mkTask(id, { pipeline: 'hang', control: { hang: 'execute' } });
  await startApproved(id);
  await waitFor(() => fs.existsSync(path.join(dir, 'hang.pid')));
  const pid = +fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8');
  await killServer(); // 只殺 server,假 CLI(detached)還活著
  assert.ok(alive(pid), '重啟前行程仍在');
  await startServer();
  await sleep(600);
  const r = await getRun(id);
  assert.equal(r.status, 'running');
  assert.ok(alive(pid));
  assert.equal((await post(`/api/runs/${id}/stop`)).status, 200);
  await waitFor(() => !alive(pid), 8000);
  assert.equal((await getRun(id)).status, 'cancelled');
});

test('重啟:running 的 run 若行程已在 server 關閉期間結束,接手時依 raw log 的 end 事件判定完成', async () => {
  const id = 't-restart-done';
  const dir = await mkTask(id, { pipeline: 'hang', control: { hang: 'execute' } });
  await startApproved(id);
  await waitFor(() => fs.existsSync(path.join(dir, 'hang.pid')));
  const pid = +fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8');
  await killServer();
  // 模擬:行程在 server 掛掉期間自己結束,且已印出 end 事件
  const rawLog = path.join(sandbox, 'board/runs', id, fs.readdirSync(path.join(sandbox, 'board/runs', id))[0], 'raw/work.log');
  fs.appendFileSync(rawLog, JSON.stringify({ type: 'turn.completed' }) + '\n');
  process.kill(pid);
  await waitFor(() => !alive(pid), 8000);
  await startServer();
  const r = await waitStatus(id, 'completed', 15000);
  assert.equal(r.steps[1].status, 'done');
});

test('pool selection proactively skips fresh Codex quota but allows stale observations', async () => {
  const quotaFile = agentId => path.join(sandbox, agentId === 'codex-b' ? 'h4' : 'h2', 'sessions', 'x', `rollout-${agentId}.jsonl`);
  const writeQuota = (agentId, percent, timestamp) => {
    const file = quotaFile(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: percent, resets_at: Math.floor(Date.now() / 1000) + 3600 }, secondary: { used_percent: 10, resets_at: Math.floor(Date.now() / 1000) + 86400 } } } }) + '\n');
  };
  try { fs.unlinkSync(path.join(sandbox, 'board/runs/agent-cooldown.json')); } catch {}
  writeQuota('codex-b', 95, new Date().toISOString());
  writeQuota('codex-a', 10, new Date().toISOString());
  await mkTask('t-proactive-fresh', { pipeline: 'poolplan' });
  assert.equal((await dispatch('t-proactive-fresh')).status, 200);
  assert.equal((await waitNeeds('t-proactive-fresh', 'approval')).steps[0].agent, 'codex-a');

  writeQuota('codex-b', 95, new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString());
  await mkTask('t-proactive-stale', { pipeline: 'poolplan' });
  assert.equal((await dispatch('t-proactive-stale')).status, 200);
  assert.equal((await waitNeeds('t-proactive-stale', 'approval')).steps[0].agent, 'codex-b');
});

// ---- {{test}} 佔位:測試指令隨專案而不同(不同語言的專案不該硬跑 npm test) ----
async function runTestVarPipeline(id, { testCommand, removePackageJson } = {}) {
  fs.writeFileSync(path.join(sandbox, 'pipelines', 'testvar.json'), JSON.stringify({ id: 'testvar', steps: [
    { id: 'plan', agent: 'claude', mode: 'plan', output: 'plan.md', gate: 'human' },
    { id: 'test', type: 'command', command: '{{test}}', output: 'test.txt' },
  ] }));
  const dir = mkProject(id, {});
  if (removePackageJson) fs.rmSync(path.join(dir, 'package.json'));
  const pj = 'proj-' + id;
  assert.equal((await post('/api/projects', { id: pj, name: pj, path: dir, ...(testCommand ? { testCommand } : {}) })).status, 200);
  assert.equal((await post('/api/tasks', { id, title: id, agent: 'claude', status: 'todo', project: pj, pipeline: 'testvar', goal: 'g', acceptance: 'a' })).status, 200);
  assert.equal((await dispatch(id)).status, 200);
  await waitNeeds(id, 'approval');
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 200);
  const run = await waitStatus(id, 'completed');
  return (await api(`/api/runs/${id}/artifacts/test.txt`)).text;
}

test('{{test}} 用專案的 testCommand', async () => {
  const out = await runTestVarPipeline('t-testvar-custom', { testCommand: 'node -e "console.log(\'CUSTOM-TEST-OK\')"' });
  assert.match(out, /CUSTOM-TEST-OK/);
});

test('{{test}} 沒設定 testCommand 但專案有 npm test 時用 npm test', async () => {
  const out = await runTestVarPipeline('t-testvar-npm');
  assert.match(out, /\$ npm test/);
  assert.match(out, /\[exit 0\]/);
});

test('{{test}} 沒有 testCommand 也沒有 package.json 時略過(不失敗)', async () => {
  const out = await runTestVarPipeline('t-testvar-skip', { removePackageJson: true });
  assert.match(out, /略過/);
});
