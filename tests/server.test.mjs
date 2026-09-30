// server.mjs 的 HTTP 層測試。為了絕不碰真實的 board/tasks,把 tools/ 與 agents.json 複製到暫存目錄,
// 在那裡起一個獨立 server(root 由檔案位置推算,所以資料都落在暫存目錄)。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
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
  fs.mkdirSync(path.join(sandbox, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'docs/worklog-2026-09-30.md'), '# Worklog\n\n## Today completed\n- fixture\n');
  fs.writeFileSync(path.join(sandbox, 'next-session-handoff.md'), 'Before\n<!-- AUTO:BEGIN -->\nold\n<!-- AUTO:END -->\nAfter\n');
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

// ------------------------------------------------------------------ 審查 #2:控制 API 保護
const port = () => new URL(base).port;
const rawReq = (method, p, { headers = {}, body } = {}) => new Promise((ok, no) => {
  const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, headers }, res => {
    let s = ''; res.on('data', c => (s += c)); res.on('end', () => ok({ status: res.statusCode, text: s, headers: res.headers }));
  });
  req.on('error', no);
  if (body !== undefined) req.write(body);
  req.end();
});
const JSON_H = { 'content-type': 'application/json' };
const taskExists = id => fs.existsSync(path.join(sandbox, 'board/tasks', id + '.md'));

test('session API follows Host protection and preview does not write a worklog', async () => {
  assert.equal((await rawReq('GET', '/api/session/briefing', { headers: { host: 'evil.com' } })).status, 403);
  const preview = await api('/api/session/wrapup', { method: 'POST', body: {} });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.preview, true);
  assert.ok(preview.json.fileName);
  assert.ok(!fs.existsSync(path.join(sandbox, 'docs', preview.json.fileName)));
});

test('session wrapup confirmation writes a worklog and updates only the AUTO block', async () => {
  const before = fs.readFileSync(path.join(sandbox, 'next-session-handoff.md'), 'utf8');
  const response = await api('/api/session/wrapup', { method: 'POST', body: { confirm: true } });
  assert.equal(response.status, 200);
  assert.equal(response.json.preview, false);
  assert.ok(fs.existsSync(path.join(sandbox, 'docs', response.json.writtenFileName)));
  const after = fs.readFileSync(path.join(sandbox, 'next-session-handoff.md'), 'utf8');
  assert.equal(after.slice(0, after.indexOf('<!-- AUTO:BEGIN -->')), before.slice(0, before.indexOf('<!-- AUTO:BEGIN -->')));
  assert.equal(after.slice(after.indexOf('<!-- AUTO:END -->') + '<!-- AUTO:END -->'.length), before.slice(before.indexOf('<!-- AUTO:END -->') + '<!-- AUTO:END -->'.length));
});

test('server 只綁 127.0.0.1(::1 連不上;原始碼 listen 有指定 host)', async () => {
  const src = fs.readFileSync(path.join(repo, 'tools/server.mjs'), 'utf8');
  assert.match(src, /\.listen\(PORT, '127\.0\.0\.1'/);
  const v6 = await new Promise(r => { const s = net.connect({ host: '::1', port: +port() }); s.on('connect', () => { s.destroy(); r('connected'); }); s.on('error', e => r('error:' + e.code)); });
  assert.notEqual(v6, 'connected', '不可在 IPv6 loopback(或任何非 127.0.0.1 位址)上接受連線');
  assert.equal((await rawReq('GET', '/api/config')).status, 200);
});

test('Host 標頭必須是 localhost/127.0.0.1 且含本 server 的 port,否則 403(變更請求與 /api GET);靜態頁不受影響', async () => {
  const body = JSON.stringify({ id: 'host-x', title: 'x' });
  for (const host of ['evil.com', `evil.com:${port()}`, 'localhost', '127.0.0.1', `localhost:${+port() + 1}`, `localhost.evil.com:${port()}`]) {
    const r = await rawReq('POST', '/api/tasks', { headers: { ...JSON_H, host, 'content-length': Buffer.byteLength(body) }, body });
    assert.equal(r.status, 403, `Host ${host}`);
  }
  assert.ok(!taskExists('host-x'));
  assert.equal((await rawReq('GET', '/api/tasks', { headers: { host: 'evil.com' } })).status, 403, 'DNS rebinding:/api GET 也驗 Host');
  assert.notEqual((await rawReq('GET', '/', { headers: { host: 'evil.com' } })).status, 403, '靜態頁不受影響(sandbox 的 web/ 是空的所以是 404)');
  for (const host of [`localhost:${port()}`, `127.0.0.1:${port()}`]) {
    const r = await rawReq('POST', '/api/tasks', { headers: { ...JSON_H, host, 'content-length': Buffer.byteLength(body) }, body });
    assert.equal(r.status, 200, `Host ${host}`);
  }
  assert.ok(taskExists('host-x'));
});

test('Origin 若存在必須是 http://localhost:<port> 或 http://127.0.0.1:<port>,否則 403(POST 與 DELETE);沒有 Origin 的請求放行', async () => {
  const mk = id => JSON.stringify({ id, title: id });
  const send = (id, origin) => rawReq('POST', '/api/tasks', { headers: { ...JSON_H, ...(origin === undefined ? {} : { origin }), 'content-length': Buffer.byteLength(mk(id)) }, body: mk(id) });
  for (const [i, origin] of ['http://evil.com', 'null', 'https://localhost:' + port(), `http://localhost:${+port() + 1}`, 'http://localhost.evil.com:' + port()].entries()) {
    assert.equal((await send('org-bad-' + i, origin)).status, 403, origin);
    assert.ok(!taskExists('org-bad-' + i));
  }
  assert.equal((await send('org-ok-1', `http://localhost:${port()}`)).status, 200);
  assert.equal((await send('org-ok-2', `http://127.0.0.1:${port()}`)).status, 200);
  assert.equal((await send('org-ok-3', undefined)).status, 200);
  // DELETE 也一樣
  assert.equal((await rawReq('DELETE', '/api/tasks/org-ok-1', { headers: { origin: 'http://evil.com' } })).status, 403);
  assert.ok(taskExists('org-ok-1'), '被擋的 DELETE 不能動到檔案');
  assert.equal((await rawReq('DELETE', '/api/tasks/org-ok-1', { headers: { origin: `http://localhost:${port()}` } })).status, 200);
  // 派工 API 與 run 動作 API 也受保護
  assert.equal((await rawReq('POST', '/api/dispatch', { headers: { ...JSON_H, origin: 'http://evil.com', 'content-length': 2 }, body: '{}' })).status, 403);
  assert.equal((await rawReq('POST', '/api/runs/org-ok-2/approve', { headers: { origin: 'http://evil.com' } })).status, 403);
});

test('POST 有 body 時 Content-Type 必須是 application/json(text/plain 的簡單跨站請求被擋);壞 JSON 回 400 不會讓 server 掛掉', async () => {
  const body = JSON.stringify({ id: 'ct-x', title: 'x' });
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const h = { 'content-length': Buffer.byteLength(body), ...(ct ? { 'content-type': ct } : {}) };
    assert.equal((await rawReq('POST', '/api/tasks', { headers: h, body })).status, 415, String(ct));
  }
  assert.ok(!taskExists('ct-x'));
  assert.equal((await rawReq('POST', '/api/tasks', { headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }, body })).status, 200);
  // 無 body 的 POST(前端的 stop/retry)不需要 content-type,不會被 415
  assert.notEqual((await rawReq('POST', '/api/tasks/ct-x/stop', { headers: { 'content-length': 0 } })).status, 415);
  // 壞 JSON
  const bad = await rawReq('POST', '/api/tasks', { headers: { ...JSON_H, 'content-length': 5 }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await rawReq('GET', '/api/config')).status, 200, 'server 仍活著');
});

// ------------------------------------------------------------------ 審查 #13:frontmatter 換行注入
test('frontmatter scalar:單獨的 CR、CRLF、LF、U+2028 都被壓成空白,不能注入額外欄位', async () => {
  const cases = {
    'inj-cr': 'hello\rstatus: done\rpriority: p0',
    'inj-crlf': 'hello\r\nstatus: done\r\nagent: evil',
    'inj-lf': 'hello\nstatus: done',
    'inj-ls': 'hello\u2028status: done\u2029agent: evil',
  };
  for (const [id, evil] of Object.entries(cases)) {
    const r = await api('/api/tasks', { method: 'POST', body: { id, title: evil, goal: 'g\rstatus: done', files: 'a\r\nstatus: done', acceptance: 'x\ry', project: 'p\rq', pipeline: 'single\rstatus: done', agent: 'a\rb', priority: 'p1\rstatus: done' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'backlog', `${id}: status 不能被注入`);
    assert.equal(r.json.title, evil.replace(/[\r\n\u2028\u2029]+/g, ' '));
    const raw = fs.readFileSync(path.join(sandbox, 'board/tasks', id + '.md'), 'utf8');
    const fm = raw.slice(0, raw.indexOf('\n---\n', 4));
    assert.ok(!/[\r\u2028\u2029]/.test(fm), `${id}: frontmatter 內沒有 CR/LS/PS`);
    assert.deepEqual(fm.split('\n').filter(l => /^[a-z]+:/.test(l)).map(l => l.split(':')[0]), ['title', 'status', 'agent', 'priority', 'files', 'project', 'pipeline', 'goal', 'acceptance', 'updated'], `${id}: 欄位數不變`);
    assert.equal(fm.split('\n').filter(l => /^status:/.test(l)).length, 1);
    // 後續更新別的欄位時,已寫入的值也不會變形
    const u = await api('/api/tasks', { method: 'POST', body: { id, priority: 'p2' } });
    assert.equal(u.json.status, 'backlog');
    assert.equal(u.json.priority, 'p2');
  }
});

// ------------------------------------------------------------------ 審查 #11:壞 JSON 的 project 檔要看得見
test('GET /api/projects:壞 JSON 檔回 {id, valid:false, error},不再悄悄消失', async () => {
  fs.mkdirSync(path.join(sandbox, 'board/projects'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'board/projects/broken.json'), '{ this is not json');
  fs.writeFileSync(path.join(sandbox, 'board/projects/fine.json'), JSON.stringify({ name: 'Fine', path: sandbox }));
  const l = (await api('/api/projects')).json;
  const b = l.find(p => p.id === 'broken');
  assert.ok(b, '壞檔不可被略過');
  assert.equal(b.valid, false);
  assert.match(b.error, /JSON/);
  assert.equal(l.find(p => p.id === 'fine').valid, true);
  fs.unlinkSync(path.join(sandbox, 'board/projects/broken.json'));
  fs.unlinkSync(path.join(sandbox, 'board/projects/fine.json'));
});

test('SSE stream sends snapshot, resumed activity, and terminal end from an isolated run fixture', async () => {
  const taskId = 'sse-fixture', runId = 'run-1';
  const dir = path.join(sandbox, 'board/runs', taskId, runId);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts', 'plan.md'), '<script>not executed</script>');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId, taskId, pipeline: 'single', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', cursor: 1, steps: [{ id: 'plan', status: 'done' }] }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', step: 'plan', kind: 'message', text: 'first' }), JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', step: 'plan', kind: 'end', text: 'second' })].join('\n') + '\n');
  const all = await rawReq('GET', `/api/runs/${taskId}/stream`);
  assert.match(all.headers['content-type'], /^text\/event-stream/);
  assert.match(all.text, /event: snapshot/);
  assert.match(all.text, /id: 1\nevent: activity[\s\S]*first/);
  assert.match(all.text, /id: 2\nevent: activity[\s\S]*second/);
  assert.match(all.text, /event: end/);
  const resumed = await rawReq('GET', `/api/runs/${taskId}/stream?since=1`);
  assert.doesNotMatch(resumed.text, /first/);
  assert.match(resumed.text, /second/);
  const lastId = await rawReq('GET', `/api/runs/${taskId}/stream`, { headers: { 'last-event-id': '1' } });
  assert.doesNotMatch(lastId.text, /first/);
  assert.equal((await rawReq('GET', `/api/runs/${taskId}/stream`, { headers: { host: 'evil.com' } })).status, 403);
});
