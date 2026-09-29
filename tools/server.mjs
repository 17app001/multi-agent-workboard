// 用法: node tools/server.mjs [port]   → http://localhost:4173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUsage } from './usage.mjs';
import { dispatch, getRun, stopRun, listRuns, readLog } from './dispatch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tasksDir = path.join(root, 'board/tasks');
const cfg = () => JSON.parse(fs.readFileSync(path.join(root, 'agents.json'), 'utf8'));

function parse(file) {
  const raw = fs.readFileSync(path.join(tasksDir, file), 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  for (const l of (m?.[1] || '').split('\n')) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { id: file.replace(/\.md$/, ''), ...meta, body: m?.[2] || raw };
}
function save(t) {
  const { id, body, ...meta } = t;
  meta.updated = new Date().toISOString().slice(0, 10);
  const fm = ['title', 'status', 'agent', 'priority', 'updated'].map(k => `${k}: ${meta[k] ?? ''}`).join('\n');
  fs.writeFileSync(path.join(tasksDir, id + '.md'), `---\n${fm}\n---\n${body}`);
}
const list = () => fs.readdirSync(tasksDir).filter(f => f.endsWith('.md')).map(parse);
const send = (res, code, data, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => (s += c)); req.on('end', () => r(JSON.parse(s || '{}'))); });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/config') return send(res, 200, cfg());
    if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, list());
    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      const { id } = await readBody(req);
      if (!/^[\w-]+$/.test(id || '')) return send(res, 400, { error: 'bad id' });
      try { return send(res, 200, dispatch(id)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/usage') return send(res, 200, collectUsage(cfg().agents));
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const id = b.id || 'task-' + Date.now().toString(36);
      if (!/^[\w-]+$/.test(id)) return send(res, 400, { error: 'bad id' });
      const file = path.join(tasksDir, id + '.md');
      const cur = fs.existsSync(file) ? parse(id + '.md') : { id, title: 'Untitled', status: 'backlog', agent: '', priority: 'p1', body: '\n\n## Log\n' };
      const next = { ...cur };
      for (const k of ['title', 'status', 'agent', 'priority']) if (b[k] !== undefined) next[k] = String(b[k]).replace(/\n/g, ' ');
      save(next);
      return send(res, 200, parse(id + '.md'));
    }
    // 派工狀態 + 完整 log(任一任務都可查,不限剛派工的;會回目前這個 id 底下
    // board/runs/ 最新一次派工的完整內容,並附上歷史所有次數的檔名清單)
    const mLog = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/log$/);
    if (mLog && req.method === 'GET') {
      const id = mLog[1];
      const all = listRuns(id);
      if (all.length === 0) return send(res, 200, { status: 'none', agent: null, pid: null, exitCode: null, log: null, content: '', truncated: false, runs: [] });
      const latest = all[0];
      const { content, truncated } = readLog(latest.file);
      const live = getRun(id);
      const usingLive = live && live.log === latest.file;
      return send(res, 200, {
        status: usingLive ? live.status : 'unknown',
        agent: usingLive ? live.agent : null,
        pid: usingLive ? live.pid : null,
        exitCode: usingLive ? live.exitCode : null,
        log: latest.file,
        content, truncated,
        runs: all.map(r => r.file),
      });
    }
    // 停止某任務目前的派工行程(整棵行程樹一起砍),成功後任務退回 todo
    const mStop = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/stop$/);
    if (mStop && req.method === 'POST') {
      const r = await stopRun(mStop[1]);
      return send(res, r.ok ? 200 : 400, r);
    }
    // 刪除任務;若該任務正在派工中,先停止行程再刪除檔案
    const mDel = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (mDel && req.method === 'DELETE') {
      const id = mDel[1];
      const run = getRun(id);
      if (run && run.status === 'running') await stopRun(id);
      const file = path.join(tasksDir, id + '.md');
      if (!fs.existsSync(file)) return send(res, 404, { error: '找不到任務' });
      fs.unlinkSync(file);
      return send(res, 200, { ok: true });
    }
    const f = path.join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (f.startsWith(path.join(root, 'web')) && fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), 'text/html; charset=utf-8');
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e) }); }
}).listen(+process.argv[2] || 4173, () => console.log('workboard on http://localhost:' + (+process.argv[2] || 4173)));
