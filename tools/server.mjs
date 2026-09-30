// 用法: node tools/server.mjs [port]   → http://localhost:4173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUsage, usageInRange } from './usage.mjs';
import { getRun, stopRun, listRuns, readLog, listActiveRuns, projectValid } from './dispatch.mjs';
import * as engine from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tasksDir = path.join(root, 'board/tasks');
const projectsDir = path.join(root, 'board/projects');
const cfg = () => JSON.parse(fs.readFileSync(path.join(root, 'agents.json'), 'utf8'));

function parse(file) {
  const raw = fs.readFileSync(path.join(tasksDir, file), 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  for (const l of (m?.[1] || '').split('\n')) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { id: file.replace(/\.md$/, ''), ...meta, body: m?.[2] || raw };
}
// frontmatter scalar 一律壓成單行:\r、\n(以及 JS 也視為行界的 U+2028/2029)都換成空白,避免注入額外欄位
const oneLine = v => String(v).replace(/[\r\n\u2028\u2029]+/g, ' ');
function save(t) {
  const { id, body, ...meta } = t;
  meta.updated = new Date().toISOString().slice(0, 10);
  // files 是可選欄位:只有真的有值時才寫進 frontmatter,避免幫從沒填過 files
  // 的舊任務憑空多出一行空的 `files: `。
  const fields = ['title', 'status', 'agent', 'priority'];
  for (const k of ['files', 'project', 'pipeline', 'goal', 'acceptance']) if (meta[k]) fields.push(k);
  fields.push('updated');
  const fm = fields.map(k => `${k}: ${oneLine(meta[k] ?? '')}`).join('\n');
  fs.writeFileSync(path.join(tasksDir, id + '.md'), `---\n${fm}\n---\n${body}`);
}
// task 狀態:v2 值(draft/queued/running/needs-you/completed/failed/cancelled)與舊欄位值(backlog/todo/doing/review/done)並存。
// 檔案裡存什麼就是什麼(舊任務不必改寫);對外輸出時 status 一律對映成看板欄位(needs-you 顯示在 review 欄),
// 另附 state = v2 值。failed/cancelled 顯示在 todo 欄(可重新派工,同舊版失敗退回 todo 的行為)。
const TO_COLUMN = { draft: 'backlog', queued: 'todo', running: 'doing', 'needs-you': 'review', completed: 'done', failed: 'todo', cancelled: 'todo' };
const TO_STATE = { backlog: 'draft', todo: 'queued', doing: 'running', review: 'needs-you', done: 'completed' };
const view = t => ({ ...t, status: TO_COLUMN[t.status] || t.status, state: TO_STATE[t.status] || t.status });
const list = () => fs.readdirSync(tasksDir).filter(f => f.endsWith('.md')).map(parse).map(view);
const listProjects = () => {
  if (!fs.existsSync(projectsDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(projectsDir).filter(f => f.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '');
    try { const p = JSON.parse(fs.readFileSync(path.join(projectsDir, f), 'utf8')); out.push({ ...p, id, valid: projectValid(p) }); }
    catch (e) { out.push({ id, valid: false, error: '專案檔讀取/JSON 解析失敗: ' + e.message }); } // 壞檔不能消失,UI 要看得到
  }
  return out;
};
const send = (res, code, data, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
const terminalRun = run => ['completed', 'failed', 'cancelled'].includes(run?.status);
const sseCursor = (url, req) => {
  const raw = url.searchParams.has('since') ? url.searchParams.get('since') : req.headers['last-event-id'];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};
const sseWrite = (res, event, data, id) => {
  if (res.destroyed || res.writableEnded) return false;
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  // JSON.stringify 目前不會產生實體換行；仍逐行加 data:，避免未來 payload 格式改動破壞 SSE framing。
  for (const line of JSON.stringify(data).split(/\r?\n/)) res.write(`data: ${line}\n`);
  res.write('\n');
  return true;
};

function streamRun(req, res, taskId, url) {
  const first = engine.runDetail(taskId);
  if (!first) return send(res, 404, { error: '這個任務沒有 run' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let cursor = sseCursor(url, req);
  let lastDetail = '';
  let pumping = false;
  let closed = false;
  let poll;
  let heartbeat;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  req.once('close', close);
  res.once('close', close);

  sseWrite(res, 'snapshot', { ...first, cursor });
  const pump = () => {
    if (closed || pumping) return;
    pumping = true;
    try {
      // cursor = 已消費的 activity 數；SSE id 採一基底，剛好等於消費後的 cursor。
      for (const activity of engine.readEvents(taskId, cursor)) {
        cursor++;
        if (!sseWrite(res, 'activity', activity, cursor)) return close();
      }
      const detail = engine.runDetail(taskId);
      if (!detail) return close();
      const current = JSON.stringify(detail);
      if (current !== lastDetail) {
        lastDetail = current;
        if (!sseWrite(res, 'run', { ...detail, cursor })) return close();
      }
      // 最後一批 activity 一定先送完，terminal end 才關閉連線。
      if (terminalRun(detail.run)) {
        sseWrite(res, 'end', { status: detail.run.status, runId: detail.run.runId, cursor });
        return close();
      }
    } catch (e) {
      sseWrite(res, 'stream-error', { error: String(e.message || e), cursor });
      close();
    } finally { pumping = false; }
  };
  pump();
  if (!closed) {
    poll = setInterval(pump, 250);
    heartbeat = setInterval(() => {
      if (!closed && !res.destroyed && !res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15000);
  }
}
const readBody = req => new Promise((ok, no) => {
  let s = ''; req.on('data', c => (s += c)); req.on('error', no);
  req.on('end', () => { try { const o = JSON.parse(s || '{}'); ok(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch { no(Object.assign(new Error('請求 body 不是合法 JSON'), { status: 400 })); } });
});

// --- 控制 API 保護(審查 #2):只綁 127.0.0.1;所有改變狀態的請求(非 GET/HEAD/OPTIONS)與 /api/* 都驗 Host,
// 變更請求另驗 Origin(若有)與 Content-Type(有 body 時必須是 application/json,擋掉 text/plain 的 CSRF)。
const PORT = +process.argv[2] || 4173;
const okHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const okOrigins = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function guard(req, pathname) {
  const mutating = !SAFE_METHODS.has(req.method);
  if (!mutating && !pathname.startsWith('/api/')) return null; // 靜態頁不受影響
  if (!okHosts.has(String(req.headers.host || '').toLowerCase())) return { code: 403, error: 'Host 不合法(只接受 localhost / 127.0.0.1 加上本 server 的 port)' };
  if (!mutating) return null;
  if (req.headers.origin !== undefined && !okOrigins.has(req.headers.origin)) return { code: 403, error: 'Origin 不合法(拒絕跨站請求)' };
  const hasBody = (Number(req.headers['content-length']) > 0) || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return { code: 415, error: 'Content-Type 必須是 application/json' };
  return null;
}

// --- 任務衝突防呆:任務可選填 files(逗號分隔的相對路徑/目錄前綴),派工前
// 檢查是否跟目前「執行中」的其他任務宣告的 files 重疊。比對規則簡單:正規化後
// 完全相同,或其中一個是另一個的目錄前綴,就算衝突。沒填 files 的任務不受影響。
const normPath = p => String(p).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
const parseFiles = str => String(str || '').split(',').map(normPath).filter(Boolean);
const filesConflict = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
function findFileConflict(id, files) {
  if (!files.length) return null;
  for (const r of [...listActiveRuns(), ...engine.listActiveRuns()]) {
    if (r.id === id) continue;
    const otherFilePath = path.join(tasksDir, r.id + '.md');
    if (!fs.existsSync(otherFilePath)) continue;
    const other = parse(r.id + '.md');
    const otherFiles = parseFiles(other.files);
    for (const f of files) for (const of_ of otherFiles) {
      if (filesConflict(f, of_)) return { id: r.id, title: other.title, file: f };
    }
  }
  return null;
}

engine.init(); // 接手上次 server 留下的 running run(needs-you 的 run 不需要行程,呼叫 API 時才載入)
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const denied = guard(req, url.pathname);
    if (denied) return send(res, denied.code, { error: denied.error });
    if (url.pathname === '/api/config') return send(res, 200, cfg());
    if (url.pathname === '/api/projects' && req.method === 'GET') return send(res, 200, listProjects());
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req);
      if (!/^[\w-]+$/.test(b.id || '')) return send(res, 400, { error: 'bad id' });
      if (typeof b.path !== 'string' || !projectValid({ path: b.path })) return send(res, 400, { error: 'path 必須是存在的絕對路徑資料夾' });
      const p = { id: b.id, name: String(b.name || b.id), path: b.path, defaultBranch: String(b.defaultBranch || 'main'), defaultPipeline: String(b.defaultPipeline || 'standard'), worktrees: !!b.worktrees };
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, p.id + '.json'), JSON.stringify(p, null, 2));
      return send(res, 200, { ...p, valid: true });
    }
    const mProj = url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
    if (mProj && req.method === 'DELETE') {
      const f = path.join(projectsDir, mProj[1] + '.json');
      if (!fs.existsSync(f)) return send(res, 404, { error: '找不到專案' });
      fs.unlinkSync(f);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, list());
    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      const { id, force } = await readBody(req); // 沒有任何關閉核准關卡的參數(舊的 noGate 已移除,傳了也會被忽略)
      if (!/^[\w-]+$/.test(id || '')) return send(res, 400, { error: 'bad id' });
      if (!force) {
        const file = path.join(tasksDir, id + '.md');
        if (fs.existsSync(file)) {
          const task = parse(id + '.md');
          const conflict = findFileConflict(id, parseFiles(task.files));
          if (conflict) {
            return send(res, 409, {
              error: `檔案衝突:「${task.title}」跟正在執行中的任務「${conflict.title}」(${conflict.id}) 都會動到 ${conflict.file}。要照樣派工請帶 force。`,
              conflict,
            });
          }
        }
      }
      try {
        // 一律走引擎:task.pipeline → project.defaultPipeline → 預設 single(都有 plan + 人工核准關卡)。
        // 舊的單發派工(tools/dispatch.mjs 的 dispatch())不再從這裡呼叫。
        const r = engine.startRun(id);
        return send(res, 200, { ...r, engine: true, agent: null, log: null, pid: null });
      } catch (e) { return send(res, e.status || 400, { error: e.message }); }
    }
    if (url.pathname === '/api/usage') return send(res, 200, collectUsage(cfg().agents));
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const id = b.id || 'task-' + Date.now().toString(36);
      if (!/^[\w-]+$/.test(id)) return send(res, 400, { error: 'bad id' });
      const file = path.join(tasksDir, id + '.md');
      const cur = fs.existsSync(file) ? parse(id + '.md') : { id, title: 'Untitled', status: 'backlog', agent: '', priority: 'p1', body: '\n\n## Log\n' };
      const next = { ...cur };
      for (const k of ['title', 'status', 'agent', 'priority', 'files', 'project', 'pipeline', 'goal', 'acceptance']) if (b[k] !== undefined) next[k] = oneLine(b[k]);
      save(next);
      return send(res, 200, view(parse(id + '.md')));
    }
    // --- v2.1 run 引擎 API ---
    if (url.pathname === '/api/pipelines' && req.method === 'GET') return send(res, 200, engine.listPipelines());
    const mRun = url.pathname.match(/^\/api\/runs\/([\w-]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/);
    if (mRun) {
      const [, taskId, sub, name] = mRun;
      if (sub === 'stream' && !name && req.method === 'GET') return streamRun(req, res, taskId, url);
      if (!sub && req.method === 'GET') {
        const d = engine.runDetail(taskId);
        return d ? send(res, 200, d) : send(res, 404, { error: '這個任務沒有 run' });
      }
      if (sub === 'artifacts' && name && req.method === 'GET') return send(res, 200, engine.readArtifactFile(taskId, name), 'text/plain; charset=utf-8');
      if (sub === 'events' && !name && req.method === 'GET') return send(res, 200, engine.readEvents(taskId, url.searchParams.get('since')));
      if (req.method === 'POST' && !name) {
        if (sub === 'approve') { const b = await readBody(req); return send(res, 200, engine.approve(taskId, b.note)); }
        if (sub === 'reject') { const b = await readBody(req); return send(res, 200, engine.reject(taskId, b.feedback ?? b.note ?? b.comment)); }
        if (sub === 'retry') return send(res, 200, engine.retry(taskId));
        if (sub === 'resolve') { const b = await readBody(req); return send(res, 200, engine.resolveRun(taskId, b.action)); }
        if (sub === 'stop') { const r = await engine.stopRun(taskId); return send(res, r.ok ? 200 : 400, r); }
      }
      return send(res, 404, { error: 'not found' });
    }
    // 派工狀態 + 完整 log(任一任務都可查,不限剛派工的;會回目前這個 id 底下
    // board/runs/ 最新一次派工的完整內容,並附上歷史所有次數的檔名清單)
    const mLog = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/log$/);
    if (mLog && req.method === 'GET') {
      const id = mLog[1];
      const all = listRuns(id);
      // 新引擎的 run 比舊單發派工的最新 log 新時,回引擎的 run(各 step raw log 串接)
      const engStart = engine.latestRunStartedAt(id);
      if (engStart && (all.length === 0 || engStart > all[0].ts)) {
        const v = engine.logView(id);
        const agentCfg = cfg().agents.find(a => a.id === v.agent);
        const usage = agentCfg ? usageInRange(agentCfg, v.startedAt, v.endedAt || Date.now()) : null;
        return send(res, 200, { ...v, usage });
      }
      if (all.length === 0) return send(res, 200, { status: 'none', agent: null, pid: null, exitCode: null, log: null, content: '', truncated: false, runs: [], usage: null });
      const latest = all[0];
      const { content, truncated } = readLog(latest.file);
      const live = getRun(id);
      const usingLive = live && live.log === latest.file;
      // 這次派工大概花了多少用量:用 run 的 startedAt~(endedAt 或現在)當時間窗,
      // 去對應 agent 的本機 log 抓這段時間內的用量加總(見 usage.mjs 的 usageInRange)。
      // 這是時間窗估算,不是精確歸因——同時間若使用者手動用同一個 agent 也會被算進來。
      let usage = null;
      if (usingLive) {
        const agentCfg = cfg().agents.find(a => a.id === live.agent);
        if (agentCfg) usage = usageInRange(agentCfg, live.startedAt, live.endedAt || Date.now());
      }
      return send(res, 200, {
        status: usingLive ? live.status : 'unknown',
        agent: usingLive ? live.agent : null,
        pid: usingLive ? live.pid : null,
        exitCode: usingLive ? live.exitCode : null,
        log: latest.file,
        content, truncated,
        runs: all.map(r => r.file),
        usage,
      });
    }
    // 停止某任務目前的派工行程(整棵行程樹一起砍),成功後任務退回 todo
    const mStop = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/stop$/);
    if (mStop && req.method === 'POST') {
      if (engine.hasActiveRun(mStop[1])) { const r = await engine.stopRun(mStop[1]); return send(res, r.ok ? 200 : 400, r); }
      const r = await stopRun(mStop[1]);
      return send(res, r.ok ? 200 : 400, r);
    }
    // 刪除任務;若該任務正在派工中,先停止行程再刪除檔案
    const mDel = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (mDel && req.method === 'DELETE') {
      const id = mDel[1];
      const run = getRun(id);
      if (engine.hasActiveRun(id)) await engine.stopRun(id);
      if (run && run.status === 'running') await stopRun(id);
      const file = path.join(tasksDir, id + '.md');
      if (!fs.existsSync(file)) return send(res, 404, { error: '找不到任務' });
      fs.unlinkSync(file);
      return send(res, 200, { ok: true });
    }
    const f = path.join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (f.startsWith(path.join(root, 'web')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }[path.extname(f)] || 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff' });
      return res.end(fs.readFileSync(f));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 500, { error: e.status ? e.message : String(e) }); }
}).listen(PORT, '127.0.0.1', () => console.log('workboard on http://localhost:' + PORT));
