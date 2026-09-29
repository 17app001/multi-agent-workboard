// WP3 Run 引擎測試。全部在 os.tmpdir 的沙箱:複製 tools/ 與 pipelines/,agents.json 指向假 CLI(tests/fixtures/fake-cli.mjs),
// 起獨立 server(隨機 port)。不碰真實 board/,不呼叫真實 claude/codex/gemini。清理只刪本檔明確建立的路徑。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
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
const dispatch = (id, body = {}) => post('/api/dispatch', { id, ...body });

before(async () => {
  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.cpSync(path.join(repo, 'pipelines'), path.join(sandbox, 'pipelines'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tests/fixtures/fake-cli.mjs'), fakeCli);
  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'web'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'legacy-agent.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(sandbox, 'legacy-out.json'))}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`);
  const price = { input: 0, cached: 0, output: 0 };
  fs.writeFileSync(path.join(sandbox, 'agents.json'), JSON.stringify({
    columns: ['backlog', 'todo', 'doing', 'review', 'done'],
    agents: [
      { id: 'claude', type: 'claude', label: 'Fake Claude', home: path.join(sandbox, 'h1'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
      { id: 'codex-a', type: 'codex', label: 'Fake Codex', home: path.join(sandbox, 'h2'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
      { id: 'legacy', type: 'claude', label: 'Legacy', home: path.join(sandbox, 'h3'), cmd: process.execPath, args: [path.join(sandbox, 'legacy-agent.mjs')], price },
    ],
  }));
  // 測試用 pipeline:由真實 standard.json 衍生(只把 test 指令換成 node t.js,避免每次跑 npm),以及幾個小型的
  const std = JSON.parse(fs.readFileSync(path.join(repo, 'pipelines/standard.json'), 'utf8'));
  const wp = (o) => fs.writeFileSync(path.join(sandbox, 'pipelines', o.id + '.json'), JSON.stringify(o));
  wp({ ...std, id: 'stdfast', steps: std.steps.map(s => (s.type === 'command' ? { ...s, command: 'node t.js' } : s)) });
  const loopSteps = [
    { id: 'code', agent: 'codex-a', mode: 'execute' },
    { id: 'test', type: 'command', command: 'node t.js' },
    { id: 'review', agent: 'claude', mode: 'review', input: ['test.txt'], output: 'review.md' },
    { id: 'revise', agent: 'codex-a', mode: 'execute', when: 'review.failed', input: ['review.md'], loopTo: 'test' },
  ];
  wp({ id: 'lim', maxRevisions: 2, steps: loopSteps });
  wp({ id: 'nrev', maxRevisions: 0, steps: loopSteps });
  wp({ id: 'hang', steps: [{ id: 'work', agent: 'codex-a', mode: 'execute' }] });
  wp({ id: 'perm', steps: [{ id: 'work', agent: 'codex-a', mode: 'execute' }] });
  wp({ id: 'tmo', steps: [{ id: 'work', agent: 'codex-a', mode: 'execute', timeoutMs: 800 }] });
  await startServer();
  engineMod = await import(pathToFileURL(path.join(sandbox, 'tools/engine.mjs')).href + '?t=' + Date.now());
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
  assert.equal(engineMod.loadPipeline('single', agents).allowNoGate, true);
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
  await dispatch(id);
  const r = await waitStatus(id, 'needs-you', 30000);
  assert.equal(r.needsYou.reason, 'revision-limit');
  assert.equal(r.revisions, 2);
  assert.equal(callsOf(id, 'review').length, 3);
  assert.equal(callsOf(id, 'execute').length, 3, 'code + 2 次 revise');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).status, 'review');
  assert.equal((await post(`/api/runs/${id}/approve`)).status, 409, 'revision-limit 不能用 approve');
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'nonsense' })).status, 400);
  // retry:回修次數歸零,會再多跑 revise
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'retry' })).status, 200);
  await waitFor(() => callsOf(id, 'execute').length >= 4);
  const r2 = await waitFor(async () => { const x = await getRun(id); return x.status === 'needs-you' && callsOf(id, 'execute').length === 5 ? x : null; }, 30000);
  assert.equal(r2.needsYou.reason, 'revision-limit');
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'complete' })).status, 200);
  const fin = await getRun(id);
  assert.equal(fin.status, 'completed');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).state, 'completed');
});

test('(f) resolve abort → cancelled;VERDICT 解析不到視為 FAIL 並記事件', async () => {
  const id = 't-noverdict';
  await mkTask(id, { pipeline: 'nrev', control: { verdictRaw: '看起來不錯,沒有格式化結論' } });
  await dispatch(id);
  const r = await waitStatus(id, 'needs-you', 20000);
  assert.equal(r.needsYou.reason, 'revision-limit');
  assert.equal(r.steps[2].verdict, 'FAIL');
  const evs = (await api(`/api/runs/${id}/events`)).json;
  assert.ok(evs.some(e => e.kind === 'error' && /解析不到 VERDICT/.test(e.text)));
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'abort' })).status, 200);
  assert.equal((await getRun(id)).status, 'cancelled');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).state, 'cancelled');
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
  assert.equal((await dispatch(id)).status, 200);
  await waitFor(() => fs.existsSync(path.join(dir, 'hang.pid')));
  const pid = +fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8');
  const r = await getRun(id);
  assert.equal(r.status, 'running');
  assert.equal(r.steps[0].pid, pid, 'run.json 記的 pid 就是實際行程');
  assert.ok(alive(pid));
  const st = await post(`/api/runs/${id}/stop`);
  assert.equal(st.status, 200, JSON.stringify(st.json));
  await waitFor(() => !alive(pid), 8000, 'pid 死亡');
  const r2 = await getRun(id);
  assert.equal(r2.status, 'cancelled');
  assert.equal(r2.steps[0].status, 'stopped');
  assert.equal((await api('/api/tasks')).json.find(x => x.id === id).state, 'cancelled');
  assert.equal((await post(`/api/runs/${id}/stop`)).status, 400, '沒有進行中的 run 不能再停');
  // 續跑:換成不卡住的設定,retry 從被停的 step 重跑
  fs.writeFileSync(path.join(dir, 'fake-control.json'), '{}');
  assert.equal((await post(`/api/runs/${id}/retry`)).status, 200);
  const fin = await waitStatus(id, 'completed');
  assert.equal(fin.steps[0].attempts, 2);
});

test('(g) 舊的 /api/tasks/:id/stop 也能停新引擎的 run;逾時(timeoutMs)→ needs-you 並砍行程', async () => {
  const id = 't-stop2';
  const dir = await mkTask(id, { pipeline: 'hang', control: { hang: 'execute' } });
  await dispatch(id);
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
  await dispatch(id2);
  const r = await waitStatus(id2, 'needs-you', 15000);
  assert.equal(r.needsYou.reason, 'timeout');
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

// ------------------------------------------------------------------ 權限被拒 / noGate / 相容
test('execute 遇到權限被拒訊號 → needs-you(permission),不無限等待;plan 模式的拒絕不算', async () => {
  const id = 't-perm';
  await mkTask(id, { pipeline: 'perm', control: { denyExecute: true } });
  await dispatch(id);
  const r = await waitStatus(id, 'needs-you', 15000);
  assert.equal(r.needsYou.reason, 'permission');
  assert.equal(r.steps[0].status, 'blocked');
  assert.ok(r.steps[0].blocked.length >= 1);
  assert.equal((await post(`/api/runs/${id}/resolve`, { action: 'abort' })).status, 200);
});

test('single pipeline:@task agent;plan 先 gate,noGate 可關(standard 不可)', async () => {
  const id = 't-single';
  await mkTask(id, { pipeline: 'single', agent: 'claude' });
  await dispatch(id);
  const r = await waitStatus(id, 'needs-you');
  assert.equal(r.steps[0].agent, 'claude');
  assert.equal(callsOf(id, 'execute').length, 0);
  await post(`/api/runs/${id}/approve`);
  await waitStatus(id, 'completed');
  assert.equal(callsOf(id, 'execute')[0].flavor, 'claude');

  const id2 = 't-nogate';
  await mkTask(id2, { pipeline: 'single', agent: 'codex-a' });
  assert.equal((await dispatch(id2, { noGate: true })).status, 200);
  await waitStatus(id2, 'completed');
  assert.equal(callsOf(id2, 'execute').length, 1);

  const id3 = 't-nogate-std';
  await mkTask(id3, { pipeline: 'stdfast' });
  const bad = await dispatch(id3, { noGate: true });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /noGate/);
  assert.equal(callsOf(id3, 'plan').length, 0);
  // single 沒指派 agent → 拒絕
  await mkTask('t-noagent', { pipeline: 'single', agent: '' });
  assert.equal((await dispatch('t-noagent')).status, 400);
});

test('(i) 沒有 pipeline 的舊任務仍走原本單發派工;pipeline 檔不存在會報錯而非悄悄退回', async () => {
  await post('/api/tasks', { id: 'old-1', title: '舊任務', agent: 'legacy', status: 'todo' });
  fs.rmSync(path.join(sandbox, 'legacy-out.json'), { force: true });
  const d = await dispatch('old-1');
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.ok(!d.json.engine);
  assert.ok(d.json.log && d.json.pid);
  await waitFor(() => fs.existsSync(path.join(sandbox, 'legacy-out.json')) && fs.statSync(path.join(sandbox, 'legacy-out.json')).size > 0);
  const out = JSON.parse(fs.readFileSync(path.join(sandbox, 'legacy-out.json'), 'utf8'));
  assert.equal(fs.realpathSync.native(out.cwd), fs.realpathSync.native(sandbox));
  assert.match(out.args.at(-1), /先閱讀 AGENTS\.md/);
  const lg = (await api('/api/tasks/old-1/log')).json;
  assert.ok(lg.log && !lg.runId, '舊任務的 log viewer 仍回舊格式');
  assert.equal((await api('/api/runs/old-1')).status, 404);
  assert.ok(!fs.existsSync(path.join(sandbox, 'board/runs', 'old-1')), '舊派工不建 run 目錄');
  // 舊狀態值仍可用,並附 v2 對映
  const t = (await api('/api/tasks')).json.find(x => x.id === 'old-1');
  assert.equal(t.status, 'doing');
  assert.equal(t.state, 'running');
  // 明確指定卻不存在的 pipeline
  await post('/api/tasks', { id: 'old-2', title: 'x', agent: 'legacy', status: 'todo', pipeline: 'ghost' });
  const g = await dispatch('old-2');
  assert.equal(g.status, 400);
  assert.match(g.json.error, /找不到 pipeline/);
  // GET /api/pipelines
  const pl = (await api('/api/pipelines')).json;
  assert.ok(pl.find(p => p.id === 'standard' && p.valid));
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
  await dispatch(id);
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
  await dispatch(id);
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
  assert.equal(r.steps[0].status, 'done');
});
