// Project 模型 + 任務新欄位 + dispatch cwd 選擇的測試。
// 一律在 os.tmpdir 的暫存目錄起獨立 server(複製 tools/ 與 pipelines/,所以 dispatch 會真實走引擎),agents.json 指向假 CLI
// (tests/fixtures/fake-cli.mjs),不碰真實 board/ 也不呼叫真實 claude/codex/agy。舊的單發派工已不可達,cwd 由引擎的 plan step 驗證。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-target-'));
const fakeLog = path.join(sandbox, 'fake-log.jsonl');
const fakeCli = path.join(sandbox, 'fake-cli.mjs');
let proc, base;

const real = p => fs.realpathSync.native(p);
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const api = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  return { status: res.status, json: await res.json() };
};
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('waitFor timeout');
};
const fakeCalls = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const callsFor = title => fakeCalls().filter(c => c.prompt.includes(`標題: ${title}\n`));

before(async () => {
  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.cpSync(path.join(repo, 'pipelines'), path.join(sandbox, 'pipelines'), { recursive: true }); // 沒有它 dispatch 會找不到 pipeline
  fs.copyFileSync(path.join(repo, 'tests/fixtures/fake-cli.mjs'), fakeCli);
  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'web'), { recursive: true });
  const price = { input: 0, cached: 0, output: 0 };
  fs.writeFileSync(path.join(sandbox, 'agents.json'), JSON.stringify({
    columns: ['backlog', 'todo', 'doing', 'review', 'done'],
    pools: { codex: ['codex-a'] },
    agents: [
      { id: 'claude', type: 'claude', label: 'Fake Claude', home: path.join(sandbox, 'h1'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
      { id: 'codex-a', type: 'codex', label: 'Fake Codex', home: path.join(sandbox, 'h2'), cmd: process.execPath, cmdPrefix: [fakeCli], price },
    ],
  }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(sandbox, 'tools/server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_LOG: fakeLog } });
  await new Promise((ok, bad) => {
    proc.stdout.on('data', d => String(d).includes('workboard on') && ok());
    proc.on('exit', c => bad(new Error('server exited early: ' + c)));
    setTimeout(() => bad(new Error('server start timeout')), 8000);
  });
});

after(() => {
  proc?.kill();
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});

test('board/projects 不存在時 GET 回空清單', async () => {
  assert.ok(!fs.existsSync(path.join(sandbox, 'board/projects')));
  const r = await api('/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});

test('projects CRUD:建立、列出(附 valid)、刪除', async () => {
  const c = await api('/api/projects', { method: 'POST', body: { id: 'p1', name: 'P One', path: projDir } });
  assert.equal(c.status, 200);
  assert.equal(c.json.id, 'p1');
  assert.equal(c.json.defaultBranch, 'main');
  assert.equal(c.json.defaultPipeline, 'standard');
  assert.equal(c.json.worktrees, false);
  const l = await api('/api/projects');
  assert.equal(l.json.length, 1);
  assert.equal(l.json[0].valid, true);
  assert.equal(l.json[0].name, 'P One');
  const d = await api('/api/projects/p1', { method: 'DELETE' });
  assert.equal(d.status, 200);
  assert.deepEqual((await api('/api/projects')).json, []);
  assert.equal((await api('/api/projects/p1', { method: 'DELETE' })).status, 404);
});

test('projects POST 驗證:壞 id、path 不存在、相對路徑都回 400', async () => {
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: '../x', path: projDir } })).status, 400);
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'nopath', path: path.join(projDir, 'not-exist') } })).status, 400);
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'rel', path: 'some/relative' } })).status, 400);
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'nopath2' } })).status, 400);
  assert.ok(!fs.existsSync(path.join(sandbox, 'board/projects/nopath.json')));
});

test('GET 時 path 已消失的 project 標 valid:false', async () => {
  fs.writeFileSync(path.join(sandbox, 'board/projects/ghost.json'), JSON.stringify({ id: 'ghost', name: 'Ghost', path: path.join(projDir, 'gone') }));
  const l = await api('/api/projects');
  assert.equal(l.json.find(p => p.id === 'ghost').valid, false);
  fs.unlinkSync(path.join(sandbox, 'board/projects/ghost.json'));
});

test('任務新欄位可讀寫,沒值不寫進 frontmatter,舊任務不壞', async () => {
  await api('/api/tasks', { method: 'POST', body: { id: 'old-1', title: '舊任務' } });
  const raw = fs.readFileSync(path.join(sandbox, 'board/tasks/old-1.md'), 'utf8');
  for (const k of ['project', 'pipeline', 'goal', 'acceptance']) assert.ok(!new RegExp('^' + k + ':', 'm').test(raw), k);
  const r = await api('/api/tasks', { method: 'POST', body: { id: 'new-f', title: 'T', project: 'p1', pipeline: 'standard', goal: '做 X\n再做 Y', acceptance: 'a;b' } });
  assert.equal(r.json.project, 'p1');
  assert.equal(r.json.pipeline, 'standard');
  assert.equal(r.json.goal, '做 X 再做 Y');
  assert.equal(r.json.acceptance, 'a;b');
  // 只更新別的欄位,新欄位保留
  const u = await api('/api/tasks', { method: 'POST', body: { id: 'new-f', status: 'todo' } });
  assert.equal(u.json.project, 'p1');
  assert.equal(u.json.goal, '做 X 再做 Y');
  // 舊任務仍可讀
  const list = (await api('/api/tasks')).json;
  assert.equal(list.find(t => t.id === 'old-1').title, '舊任務');
});

test('dispatch:有 project 時走引擎(project.defaultPipeline=standard),plan step 的 cwd = project.path,prompt 帶 goal/acceptance,execute 在核准前不啟動', async () => {
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'p2', name: 'P2', path: projDir } })).status, 200);
  await api('/api/tasks', { method: 'POST', body: { id: 'run-proj', title: 'run-proj', agent: 'claude', status: 'todo', project: 'p2', goal: '目標G', acceptance: '驗收A;驗收B' } });
  const d = await api('/api/dispatch', { method: 'POST', body: { id: 'run-proj' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.engine, true);
  assert.equal(d.json.pipeline, 'standard', 'project.defaultPipeline 真的進了引擎');
  await waitFor(() => callsFor('run-proj').length >= 1);
  const c = callsFor('run-proj')[0];
  assert.equal(c.mode, 'plan');
  assert.equal(c.flagMode, 'readonly');
  assert.equal(real(c.cwd), real(projDir));
  assert.match(c.prompt, /目標G/);
  assert.match(c.prompt, /- 驗收A/);
  assert.match(c.prompt, /- 驗收B/);
  for (let i = 0; i < 150; i++) { if ((await api('/api/runs/run-proj')).json?.run?.status === 'needs-you') break; await new Promise(r => setTimeout(r, 100)); }
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(callsFor('run-proj').filter(x => x.mode === 'execute').length, 0, '沒核准不可 execute');
  assert.equal((await api('/api/runs/run-proj/stop', { method: 'POST' })).status, 200);
});

test('dispatch:沒有 project、沒有 pipeline → 預設 single(有 plan + gate),cwd = 看板 root;舊單發派工不可達', async () => {
  await api('/api/tasks', { method: 'POST', body: { id: 'run-legacy', title: 'run-legacy', agent: 'claude', status: 'todo' } });
  const d = await api('/api/dispatch', { method: 'POST', body: { id: 'run-legacy' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.engine, true);
  assert.equal(d.json.pipeline, 'single');
  assert.equal(d.json.pid, null, '不是舊派工(舊派工會回 pid/log)');
  await waitFor(() => callsFor('run-legacy').length >= 1);
  const c = callsFor('run-legacy')[0];
  assert.equal(c.mode, 'plan');
  assert.equal(real(c.cwd), real(sandbox));
  await new Promise(r => setTimeout(r, 800));
  assert.equal(callsFor('run-legacy').filter(x => x.mode === 'execute').length, 0);
  assert.ok(fs.existsSync(path.join(sandbox, 'board/runs/run-legacy')), '有 run 目錄');
  assert.equal((await api('/api/runs/run-legacy/stop', { method: 'POST' })).status, 200);
});

test('dispatch:project.defaultPipeline 指到不存在的 pipeline(typo)→ 400,不悄悄退回,不啟動任何 agent', async () => {
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'p-typo', path: projDir, defaultPipeline: 'standrad' } })).status, 200);
  await api('/api/tasks', { method: 'POST', body: { id: 'run-typo', title: 'run-typo', agent: 'claude', status: 'todo', project: 'p-typo' } });
  const d = await api('/api/dispatch', { method: 'POST', body: { id: 'run-typo' } });
  assert.equal(d.status, 400);
  assert.match(d.json.error, /defaultPipeline「standrad」不存在/);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(callsFor('run-typo').length, 0);
  assert.ok(!fs.existsSync(path.join(sandbox, 'board/runs/run-typo')));
  assert.equal((await api('/api/tasks')).json.find(x => x.id === 'run-typo').status, 'todo');
  // task 自己指定不存在的 pipeline 也一樣
  await api('/api/tasks', { method: 'POST', body: { id: 'run-typo2', title: 'run-typo2', agent: 'claude', status: 'todo', pipeline: 'nope' } });
  const d2 = await api('/api/dispatch', { method: 'POST', body: { id: 'run-typo2' } });
  assert.equal(d2.status, 400);
  assert.match(d2.json.error, /pipeline「nope」不存在/);
});

test('dispatch:project 不存在或 path 失效時拒絕派工,不退回舊 cwd,任務狀態不變', async () => {
  await api('/api/tasks', { method: 'POST', body: { id: 'run-missing', agent: 'claude', status: 'todo', project: 'no-such' } });
  const before = fakeCalls().length;
  const d1 = await api('/api/dispatch', { method: 'POST', body: { id: 'run-missing' } });
  assert.equal(d1.status, 400);
  assert.match(d1.json.error, /no-such/);

  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-gone-'));
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'p3', path: gone } })).status, 200);
  fs.rmdirSync(gone);
  await api('/api/tasks', { method: 'POST', body: { id: 'run-broken', agent: 'claude', status: 'todo', project: 'p3' } });
  const d2 = await api('/api/dispatch', { method: 'POST', body: { id: 'run-broken' } });
  assert.equal(d2.status, 400);
  assert.match(d2.json.error, /p3/);

  await new Promise(r => setTimeout(r, 500));
  assert.equal(fakeCalls().length, before, '假 CLI 不應被啟動');
  const t = (await api('/api/tasks')).json;
  assert.equal(t.find(x => x.id === 'run-missing').status, 'todo');
  assert.equal(t.find(x => x.id === 'run-broken').status, 'todo');
});
