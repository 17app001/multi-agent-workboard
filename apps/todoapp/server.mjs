// 用法: node apps/todoapp/server.mjs [port]   → http://localhost:4174
// 零依賴 Todo App:Node 內建 http 模組 + 存到 JSON 檔案。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'data');
const dataFile = path.join(dataDir, 'todos.json');
const publicDir = path.join(root, 'public');

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]');
}
function loadTodos() {
  ensureDataFile();
  try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { return []; }
}
function saveTodos(todos) {
  ensureDataFile();
  fs.writeFileSync(dataFile, JSON.stringify(todos, null, 2));
}

const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};
const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => (s += c));
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
});

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/todos' && req.method === 'GET') {
      return send(res, 200, loadTodos());
    }

    if (url.pathname === '/api/todos' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'text is required' });
      const todos = loadTodos();
      const todo = { id: 'todo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false, createdAt: new Date().toISOString() };
      todos.push(todo);
      saveTodos(todos);
      return send(res, 201, todo);
    }

    const idMatch = url.pathname.match(/^\/api\/todos\/([\w-]+)$/);
    if (idMatch && req.method === 'PATCH') {
      const id = idMatch[1];
      const body = await readBody(req);
      const todos = loadTodos();
      const idx = todos.findIndex(t => t.id === id);
      if (idx === -1) return send(res, 404, { error: 'not found' });
      if (body.done !== undefined) todos[idx].done = Boolean(body.done);
      if (body.text !== undefined) todos[idx].text = String(body.text).trim();
      saveTodos(todos);
      return send(res, 200, todos[idx]);
    }

    if (idMatch && req.method === 'DELETE') {
      const id = idMatch[1];
      const todos = loadTodos();
      const next = todos.filter(t => t.id !== id);
      if (next.length === todos.length) return send(res, 404, { error: 'not found' });
      saveTodos(next);
      return send(res, 200, { ok: true });
    }

    // 靜態檔案(單頁前端)
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const f = path.join(publicDir, rel);
    if (f.startsWith(publicDir) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f);
      return send(res, 200, fs.readFileSync(f), MIME[ext] || 'application/octet-stream');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
}).listen(+process.argv[2] || 4174, () => console.log('todoapp on http://localhost:' + (+process.argv[2] || 4174)));
