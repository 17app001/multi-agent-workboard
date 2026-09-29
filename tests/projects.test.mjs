// Project 模型 + 任務新欄位 + dispatch cwd 選擇的測試。
// 一律在 os.tmpdir 的暫存目錄起獨立 server(複製 tools/),agents.json 指向假 CLI,不碰真實 board/ 也不呼叫真實 claude/codex/gemini。
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
const fakeOut = path.join(sandbox, 'fake-out.json');
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
const readFake = () => JSON.parse(fs.readFileSync(fakeOut, 'utf8'));

before(async () => {
  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'web'), { recursive: true });
  // 假 CLI:把 cwd 與收到的 prompt 寫進檔案後結束
  fs.writeFileSync(path.join(sandbox, 'fake-agent.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(fakeOut)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`);
  fs.writeFileSync(path.join(sandbox, 'agents.json'), JSON.stringify({
    columns: ['backlog', 'todo', 'doing', 'review', 'done'],
    agents: [{ id: 'fake', type: 'claude', label: 'Fake', home: path.join(sandbox, 'fakehome'), cmd: process.execPath, args: [path.join(sandbox, 'fake-agent.mjs')], price: { input: 0, cached: 0, output: 0 } }],
  }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(sandbox, 'tools/server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
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

test('dispatch:有 project 時 cwd = project.path,prompt 帶 goal/acceptance 與任務檔絕對路徑', async () => {
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'p2', name: 'P2', path: projDir } })).status, 200);
  await api('/api/tasks', { method: 'POST', body: { id: 'run-proj', title: '專案任務', agent: 'fake', status: 'todo', project: 'p2', goal: '目標G', acceptance: '驗收A;驗收B' } });
  fs.rmSync(fakeOut, { force: true });
  const d = await api('/api/dispatch', { method: 'POST', body: { id: 'run-proj' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  await waitFor(() => fs.existsSync(fakeOut) && fs.statSync(fakeOut).size > 0);
  const out = readFake();
  assert.equal(real(out.cwd), real(projDir));
  const prompt = out.args.at(-1);
  assert.match(prompt, /目標G/);
  assert.match(prompt, /驗收A;驗收B/);
  assert.ok(prompt.includes(path.join(sandbox, 'board/tasks', 'run-proj.md')));
});

test('dispatch:沒有 project 時維持 cwd = 看板 root(舊行為)', async () => {
  await api('/api/tasks', { method: 'POST', body: { id: 'run-legacy', title: '舊任務', agent: 'fake', status: 'todo' } });
  fs.rmSync(fakeOut, { force: true });
  const d = await api('/api/dispatch', { method: 'POST', body: { id: 'run-legacy' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  await waitFor(() => fs.existsSync(fakeOut) && fs.statSync(fakeOut).size > 0);
  const out = readFake();
  assert.equal(real(out.cwd), real(sandbox));
  assert.match(out.args.at(-1), /先閱讀 AGENTS\.md/);
});

test('dispatch:project 不存在或 path 失效時拒絕派工,不退回舊 cwd,任務狀態不變', async () => {
  await api('/api/tasks', { method: 'POST', body: { id: 'run-missing', agent: 'fake', status: 'todo', project: 'no-such' } });
  fs.rmSync(fakeOut, { force: true });
  const d1 = await api('/api/dispatch', { method: 'POST', body: { id: 'run-missing' } });
  assert.equal(d1.status, 400);
  assert.match(d1.json.error, /no-such/);

  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-gone-'));
  assert.equal((await api('/api/projects', { method: 'POST', body: { id: 'p3', path: gone } })).status, 200);
  fs.rmdirSync(gone);
  await api('/api/tasks', { method: 'POST', body: { id: 'run-broken', agent: 'fake', status: 'todo', project: 'p3' } });
  const d2 = await api('/api/dispatch', { method: 'POST', body: { id: 'run-broken' } });
  assert.equal(d2.status, 400);
  assert.match(d2.json.error, /p3/);

  await new Promise(r => setTimeout(r, 500));
  assert.ok(!fs.existsSync(fakeOut), '假 CLI 不應被啟動');
  const t = (await api('/api/tasks')).json;
  assert.equal(t.find(x => x.id === 'run-missing').status, 'todo');
  assert.equal(t.find(x => x.id === 'run-broken').status, 'todo');
});
