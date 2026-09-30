// 需求自動拆解(WP14)單元測試與 API 整合測試。
// 嚴格遵守測試隔離:不碰真實 board/tasks,使用暫存目錄與假 CLI 腳本。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  extractJsonArray,
  parseDecomposition,
  createTasksFromDraft,
  parseDependsOn,
  findUnfinishedDependencies,
} from '../tools/decompose.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ================================================================ 單元測試
test('extractJsonArray: 支援直接 JSON、Markdown 程式碼區塊、外圍對話文字', () => {
  // 直接 JSON
  const a1 = extractJsonArray('[{"title":"Task 1"}]');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].title, 'Task 1');

  // Markdown code block
  const a2 = extractJsonArray('Here is the plan:\n```json\n[{"title":"Task 2"}]\n```\nHope it helps!');
  assert.equal(a2.length, 1);
  assert.equal(a2[0].title, 'Task 2');

  // 最外層中括號
  const a3 = extractJsonArray('好的，以下是拆解出的任務：\n[{"title":"Task 3"}]\n請查閱。');
  assert.equal(a3.length, 1);
  assert.equal(a3[0].title, 'Task 3');

  // 錯誤處理
  assert.throws(() => extractJsonArray(''), /為空/);
  assert.throws(() => extractJsonArray('不是 JSON'), /無法從輸出中解析/);
  assert.throws(() => extractJsonArray('{"title":"not array"}'), /無法從輸出中解析/);
});

test('parseDecomposition: 嚴格校驗任務數量 (1-12 張) 與欄位邊界', () => {
  const agents = [{ id: 'claude' }, { id: 'codex-a' }];
  const pools = { dev: ['codex-a'] };

  // 正常解析
  const valid = parseDecomposition(
    JSON.stringify([
      { title: '任務 1', goal: '目標 1', acceptance: '條件 1', files: 'a.js', agentSuggestion: 'claude', dependsOn: [] },
      { title: '任務 2', goal: '目標 2', acceptance: '條件 2', files: 'b.js', agentSuggestion: 'codex-a', dependsOn: [0] },
    ]),
    agents,
    pools
  );
  assert.equal(valid.length, 2);
  assert.equal(valid[0].title, '任務 1');
  assert.deepEqual(valid[1].dependsOn, [0]);

  // 空陣列
  assert.throws(() => parseDecomposition('[]', agents, pools), /不可為空/);

  // 超過 12 張
  const over12 = Array.from({ length: 13 }, (_, i) => ({ title: `T${i}` }));
  assert.throws(() => parseDecomposition(JSON.stringify(over12), agents, pools), /最多允許 12 張/);

  // 缺少標題
  assert.throws(() => parseDecomposition(JSON.stringify([{ goal: '沒有標題' }]), agents, pools), /缺少標題/);

  // 標題過長 (> 150)
  assert.throws(() => parseDecomposition(JSON.stringify([{ title: 'A'.repeat(151) }]), agents, pools), /標題過長/);

  // 目標過長 (> 1500)
  assert.throws(() => parseDecomposition(JSON.stringify([{ title: 'T', goal: 'G'.repeat(1501) }]), agents, pools), /目標過長/);

  // 驗收條件過長 (> 1500)
  assert.throws(() => parseDecomposition(JSON.stringify([{ title: 'T', acceptance: 'X'.repeat(1501) }]), agents, pools), /驗收條件過長/);

  // 未知 agent / pool
  assert.throws(() => parseDecomposition(JSON.stringify([{ title: 'T', agentSuggestion: 'unknown-agent' }]), agents, pools), /不存在於設定中/);
});

test('parseDecomposition: dependsOn 索引檢查、自我依賴與循環依賴檢測', () => {
  // 自我依賴
  assert.throws(
    () => parseDecomposition(JSON.stringify([{ title: 'T1', dependsOn: [0] }])),
    /不可自我依賴/
  );

  // 索引超出範圍
  assert.throws(
    () => parseDecomposition(JSON.stringify([{ title: 'T1', dependsOn: [1] }])),
    /超出範圍/
  );

  // 循環依賴 (A 依賴 B, B 依賴 A)
  const cycle2 = [
    { title: 'A', dependsOn: [1] },
    { title: 'B', dependsOn: [0] },
  ];
  assert.throws(() => parseDecomposition(JSON.stringify(cycle2)), /存在循環依賴/);

  // 三方循環 (0 -> 1 -> 2 -> 0)
  const cycle3 = [
    { title: 'A', dependsOn: [2] },
    { title: 'B', dependsOn: [0] },
    { title: 'C', dependsOn: [1] },
  ];
  assert.throws(() => parseDecomposition(JSON.stringify(cycle3)), /存在循環依賴/);

  // 合法 DAG (2 依賴 1, 1 依賴 0)
  const dag = [
    { title: 'A', dependsOn: [] },
    { title: 'B', dependsOn: [0] },
    { title: 'C', dependsOn: [0, 1] },
  ];
  const res = parseDecomposition(JSON.stringify(dag));
  assert.equal(res.length, 3);
  assert.deepEqual(res[2].dependsOn, [0, 1]);
});

test('createTasksFromDraft: 建立任務卡、索引轉換為真實 ID、預設 backlog 且不覆寫既有檔案', () => {
  const tmpTasks = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-tasks-'));
  try {
    const draft = [
      { title: '模組基礎結構', goal: '建構基礎資料型態', acceptance: '測試通過', files: 'src/base.js', agentSuggestion: 'claude', dependsOn: [] },
      { title: '功能實作', goal: '串接商業邏輯', acceptance: '驗收完整', files: 'src/feature.js', agentSuggestion: 'codex-a', dependsOn: [0] },
    ];

    const created = createTasksFromDraft(draft, 'test-project', { tasksDir: tmpTasks });
    assert.equal(created.length, 2);

    // 檢查第一張
    const t0 = created[0];
    assert.equal(t0.status, 'backlog');
    assert.equal(t0.dependsOn, '');
    assert.equal(t0.project, 'test-project');
    const f0 = path.join(tmpTasks, t0.id + '.md');
    assert.ok(fs.existsSync(f0));
    const c0 = fs.readFileSync(f0, 'utf8');
    assert.match(c0, /title: 模組基礎結構/);
    assert.match(c0, /status: backlog/);
    assert.match(c0, /project: test-project/);

    // 檢查第二張 (dependsOn 應轉換為第一張的 task ID)
    const t1 = created[1];
    assert.equal(t1.status, 'backlog');
    assert.equal(t1.dependsOn, t0.id);
    const f1 = path.join(tmpTasks, t1.id + '.md');
    assert.ok(fs.existsSync(f1));
    const c1 = fs.readFileSync(f1, 'utf8');
    assert.match(c1, new RegExp(`dependsOn: ${t0.id}`));
  } finally {
    fs.rmSync(tmpTasks, { recursive: true, force: true });
  }
});

test('findUnfinishedDependencies: 正確偵測未完成依賴與缺失檔案', () => {
  const tmpTasks = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-deps-'));
  try {
    const dummyParse = file => {
      const raw = fs.readFileSync(path.join(tmpTasks, file), 'utf8');
      const titleMatch = raw.match(/title:\s*(.*)/);
      const statusMatch = raw.match(/status:\s*(.*)/);
      return {
        id: file.replace(/\.md$/, ''),
        title: titleMatch ? titleMatch[1].trim() : file,
        status: statusMatch ? statusMatch[1].trim() : 'todo',
      };
    };

    // 建立 task-a (todo) 與 task-b (done)
    fs.writeFileSync(path.join(tmpTasks, 'task-a.md'), '---\ntitle: 任務 A\nstatus: todo\n---\n');
    fs.writeFileSync(path.join(tmpTasks, 'task-b.md'), '---\ntitle: 任務 B\nstatus: done\n---\n');

    // 依賴已完成的 task-b -> 無衝突 (null)
    const conflict1 = findUnfinishedDependencies('task-c', ['task-b'], tmpTasks, dummyParse);
    assert.equal(conflict1, null);

    // 依賴尚未完成的 task-a -> 回報衝突
    const conflict2 = findUnfinishedDependencies('task-c', ['task-a'], tmpTasks, dummyParse);
    assert.ok(conflict2);
    assert.equal(conflict2.id, 'task-a');
    assert.equal(conflict2.status, 'todo');

    // 依賴不存在的任務 -> 回報 missing
    const conflict3 = findUnfinishedDependencies('task-c', ['task-missing'], tmpTasks, dummyParse);
    assert.ok(conflict3);
    assert.equal(conflict3.id, 'task-missing');
    assert.equal(conflict3.status, 'missing');
  } finally {
    fs.rmSync(tmpTasks, { recursive: true, force: true });
  }
});

// ================================================================ API 整合測試
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-server-test-'));
let proc, base, fakeClaudeCmd;

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = () => new URL(base).port;
const rawReq = (method, p, { headers = {}, body } = {}) => new Promise((ok, no) => {
  const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, headers }, res => {
    let s = ''; res.on('data', c => (s += c)); res.on('end', () => ok({ status: res.statusCode, text: s, headers: res.headers }));
  });
  req.on('error', no);
  if (body !== undefined) req.write(body);
  req.end();
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

before(async () => {
  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.cpSync(path.join(repo, 'pipelines'), path.join(sandbox, 'pipelines'), { recursive: true });

  // 假 CLI: 使用 node 執行獨立腳本輸出 UTF-8 JSON，避免 Windows batch 碼頁編碼問題
  const fakeBin = path.join(sandbox, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });

  const fakeRunner = path.join(fakeBin, 'fake-claude-runner.mjs');
  fs.writeFileSync(
    fakeRunner,
    `const sample = [
      { title: "Task 1: Database Design", goal: "Design database schema", acceptance: "Schema approved", files: "db/schema.sql", agentSuggestion: "claude", dependsOn: [] },
      { title: "Task 2: API Endpoints", goal: "Implement CRUD endpoints", acceptance: "Unit tests pass", files: "src/api.js", agentSuggestion: "codex-a", dependsOn: [0] },
    ];
    console.log(JSON.stringify({ type: "result", result: JSON.stringify(sample) }));
    `
  );

  if (process.platform === 'win32') {
    fakeClaudeCmd = path.join(fakeBin, 'fake-claude.cmd');
    fs.writeFileSync(fakeClaudeCmd, `@echo off\r\n"${process.execPath}" "${fakeRunner}"\r\n`);
  } else {
    fakeClaudeCmd = path.join(fakeBin, 'fake-claude');
    fs.writeFileSync(fakeClaudeCmd, `#!/bin/sh\n"${process.execPath}" "${fakeRunner}"\n`);
    fs.chmodSync(fakeClaudeCmd, 0o755);
  }

  const config = JSON.parse(fs.readFileSync(path.join(repo, 'agents.json'), 'utf8'));
  const claudeAgent = config.agents.find(a => a.id === 'claude');
  if (claudeAgent) {
    claudeAgent.cmd = fakeClaudeCmd;
    claudeAgent.home = path.join(sandbox, 'agent-homes', 'claude');
  }
  fs.writeFileSync(path.join(sandbox, 'agents.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'board/projects'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'web'), { recursive: true });

  const p = await freePort();
  base = `http://127.0.0.1:${p}`;
  proc = spawn(process.execPath, [path.join(sandbox, 'tools/server.mjs'), String(p)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  await new Promise((ok, bad) => {
    proc.stdout.on('data', d => String(d).includes('workboard on') && ok());
    proc.on('exit', c => bad(new Error('server exited early: ' + c)));
    setTimeout(() => bad(new Error('server start timeout')), 8000);
  });
});

after(async () => {
  if (proc?.pid) {
    if (process.platform === 'win32') {
      await new Promise(r => execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => r()));
    } else {
      try { proc.kill(); } catch {}
    }
  }
  await new Promise(r => setTimeout(r, 200));
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {}
});

test('API 安全防護: Host / Origin / Content-Type 保護 /api/decompose 系列', async () => {
  const body = JSON.stringify({ requirement: 'test' });
  const JSON_H = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };

  // 偽造外部 Host
  const r1 = await rawReq('POST', '/api/decompose', {
    headers: { ...JSON_H, host: 'evil.com' },
    body,
  });
  assert.equal(r1.status, 403);

  // 跨站 Origin
  const r2 = await rawReq('POST', '/api/decompose', {
    headers: { ...JSON_H, origin: 'http://evil.com' },
    body,
  });
  assert.equal(r2.status, 403);

  // 缺少 / 錯誤 Content-Type
  const r3 = await rawReq('POST', '/api/decompose', {
    headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength('plain') },
    body: 'plain',
  });
  assert.equal(r3.status, 415);
});

test('完整需求拆解流程: POST /api/decompose → gate approval → GET draft → confirm 建立任務卡', async () => {
  // 1. 發起拆解請求
  const rDecomp = await api('/api/decompose', {
    method: 'POST',
    body: {
      requirement: '重構認證模組並支援 OAuth2 第三方登入與 JWT 驗證',
      agent: 'claude',
    },
  });
  assert.equal(rDecomp.status, 200);
  assert.ok(rDecomp.json.taskId);
  const taskId = rDecomp.json.taskId;

  // 2. 等待假 CLI 完成並進入 needs-you (approval) 關卡
  let runStatus = '';
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    const rRun = await api(`/api/runs/${taskId}`);
    if (rRun.status === 200 && rRun.json.run) {
      runStatus = rRun.json.run.status;
      if (runStatus === 'needs-you') break;
    }
  }
  assert.equal(runStatus, 'needs-you', '拆解完成後應停留於 needs-you 關卡等待人工審查');

  // 3. 取得拆解草案
  const rDraft = await api(`/api/decompose/${taskId}/draft`);
  assert.equal(rDraft.status, 200);
  assert.ok(Array.isArray(rDraft.json.draft));
  assert.equal(rDraft.json.draft.length, 2);
  assert.equal(rDraft.json.draft[0].title, 'Task 1: Database Design');
  assert.equal(rDraft.json.draft[1].title, 'Task 2: API Endpoints');
  assert.deepEqual(rDraft.json.draft[1].dependsOn, [0]);

  // 4. 使用者在前端編輯草案並確認建立任務卡
  const editedDraft = [
    { title: 'Custom 1: Spec Definition', goal: 'Define spec', acceptance: 'Spec approved', files: 'docs/auth.md', agentSuggestion: 'claude', dependsOn: [] },
    { title: 'Custom 2: Implement OAuth2', goal: 'Implement login', acceptance: 'Login works', files: 'src/auth.js', agentSuggestion: 'claude', dependsOn: [0] },
  ];

  const rConfirm = await api(`/api/decompose/${taskId}/confirm`, {
    method: 'POST',
    body: { tasks: editedDraft },
  });
  assert.equal(rConfirm.status, 200);
  assert.equal(rConfirm.json.createdCount, 2);
  const created = rConfirm.json.createdTasks;
  assert.equal(created.length, 2);

  const task1Id = created[0].id;
  const task2Id = created[1].id;
  assert.equal(created[0].status, 'backlog');
  assert.equal(created[1].status, 'backlog');
  assert.equal(created[1].dependsOn, task1Id);

  // 5. 原拆解 run 應被核准並結束
  const rAfter = await api(`/api/runs/${taskId}`);
  assert.equal(rAfter.json.run.status, 'completed');

  // 6. 派工防呆: task2 依賴 task1，在 task1 尚未 done 時嘗試派工 task2
  const rDispatchFail = await api('/api/dispatch', {
    method: 'POST',
    body: { id: task2Id },
  });
  assert.equal(rDispatchFail.status, 409);
  assert.ok(rDispatchFail.json.dependencyConflict);
  assert.equal(rDispatchFail.json.dependencyConflict.id, task1Id);
  assert.match(rDispatchFail.json.error, /依賴尚未完成/);

  // 7. 使用 force: true 派工 task2 應成功繞過依賴檢查
  const rDispatchForce = await api('/api/dispatch', {
    method: 'POST',
    body: { id: task2Id, force: true },
  });
  assert.equal(rDispatchForce.status, 200);

  // 8. 將 task1 標記為 done 後，不帶 force 派工應成功
  await api('/api/tasks', {
    method: 'POST',
    body: { id: task1Id, status: 'done' },
  });
  // 建立 task3 依賴 task1
  const tmpTask3 = await api('/api/tasks', {
    method: 'POST',
    body: { id: 'task-test-3', title: 'Task 3', agent: 'claude', dependsOn: task1Id },
  });
  assert.equal(tmpTask3.status, 200);

  const rDispatchOk = await api('/api/dispatch', {
    method: 'POST',
    body: { id: 'task-test-3' },
  });
  assert.equal(rDispatchOk.status, 200);
});
