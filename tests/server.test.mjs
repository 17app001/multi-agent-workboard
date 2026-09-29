// server.mjs 的 HTTP 層測試。為了絕不碰真實的 board/tasks,把 tools/ 與 agents.json 複製到暫存目錄,
// 在那裡起一個獨立 server(root 由檔案位置推算,所以資料都落在暫存目錄)。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
let proc, base;

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const api = async (p, opts = {}) => {
  const res = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'agents.json'), path.join(sandbox, 'agents.json'));
  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'web'), { recursive: true });
  // Windows 編輯器存的 CRLF 任務檔
  fs.writeFileSync(path.join(sandbox, 'board/tasks/crlf-1.md'),
    '---\r\ntitle: CRLF 任務\r\nstatus: todo\r\nagent: claude\r\npriority: p0\r\nupdated: 2026-01-01\r\n---\r\n\r\n## Log\r\n');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(sandbox, 'tools/server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, bad) => {
    proc.stdout.on('data', d => String(d).includes('workboard on') && ok());
    proc.on('exit', c => bad(new Error('server exited early: ' + c)));
    setTimeout(() => bad(new Error('server start timeout')), 8000);
  });
});

after(() => { proc?.kill(); fs.rmSync(sandbox, { recursive: true, force: true }); });

test('CRLF 的任務檔能被正確解析(frontmatter 不會整個失敗)', async () => {
  const { json } = await api('/api/tasks');
  const t = json.find(x => x.id === 'crlf-1');
  assert.equal(t.title, 'CRLF 任務');
  assert.equal(t.status, 'todo');
  assert.equal(t.agent, 'claude');
  assert.equal(t.priority, 'p0');
});

test('POST /api/tasks 建立新任務,預設 backlog;更新只改有帶的欄位', async () => {
  const c = await api('/api/tasks', { method: 'POST', body: { id: 'new-1', title: '新任務' } });
  assert.equal(c.status, 200);
  assert.equal(c.json.status, 'backlog');
  assert.equal(c.json.title, '新任務');
  const u = await api('/api/tasks', { method: 'POST', body: { id: 'new-1', status: 'doing' } });
  assert.equal(u.json.status, 'doing');
  assert.equal(u.json.title, '新任務');
});

test('files 欄位有值才寫進 frontmatter', async () => {
  await api('/api/tasks', { method: 'POST', body: { id: 'nofiles' } });
  const raw = fs.readFileSync(path.join(sandbox, 'board/tasks/nofiles.md'), 'utf8');
  assert.ok(!/^files:/m.test(raw));
  const r = await api('/api/tasks', { method: 'POST', body: { id: 'withfiles', files: 'tools/usage.mjs,web/' } });
  assert.equal(r.json.files, 'tools/usage.mjs,web/');
});

test('不合法的 id 回 400(擋路徑穿越)', async () => {
  const r = await api('/api/tasks', { method: 'POST', body: { id: '../evil' } });
  assert.equal(r.status, 400);
  const d = await api('/api/dispatch', { method: 'POST', body: { id: '../evil' } });
  assert.equal(d.status, 400);
});

test('/api/config 與 /api/usage 可回應', async () => {
  const c = await api('/api/config');
  assert.ok(Array.isArray(c.json.agents));
  const u = await api('/api/usage');
  assert.equal(u.status, 200);
  assert.ok(Array.isArray(u.json));
});
