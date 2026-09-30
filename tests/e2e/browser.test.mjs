// 端到端瀏覽器測試 (零依賴, CDP)
// 透過 Node 內建 WebSocket 與本機 Chrome/Edge (CDP) 通訊。
// 全沙箱隔離執行：暫存目錄、假 CLI、隔離 port 與 user-data-dir，不觸碰正式環境或外部網路。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser, launchBrowser } from '../helpers/cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserPath = findBrowser();
const skipMsg = !browserPath ? '本機未偵測到可用之 Chrome 或 Edge 瀏覽器，自動跳過 E2E 測試' : false;

let sandbox, fakeLog, fakeCli, serverProc, baseUrl, page, projDir;
let createdTaskId = null;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
  s.on('error', reject);
});

before(async () => {
  if (!browserPath) return;

  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-test-'));
  fakeLog = path.join(sandbox, 'fake-log.jsonl');
  fakeCli = path.join(sandbox, 'fake-cli.mjs');

  fs.cpSync(path.join(repo, 'tools'), path.join(sandbox, 'tools'), { recursive: true });
  fs.cpSync(path.join(repo, 'web'), path.join(sandbox, 'web'), { recursive: true });
  fs.cpSync(path.join(repo, 'pipelines'), path.join(sandbox, 'pipelines'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tests/fixtures/fake-cli.mjs'), fakeCli);

  fs.mkdirSync(path.join(sandbox, 'board/tasks'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'board/projects'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'docs/worklog-2026-09-30.md'), '# Worklog\n\n## Today completed\n- E2E 測試項目準備完畢\n');
  fs.writeFileSync(path.join(sandbox, 'next-session-handoff.md'), 'Before\n<!-- AUTO:BEGIN -->\n- 待接手事項清單\n<!-- AUTO:END -->\nAfter\n');

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

  projDir = path.join(sandbox, 'proj-e2e');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ name: 'proj-e2e', scripts: { test: 'node -e "process.exit(0)"' } }));

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProc = spawn(process.execPath, [path.join(sandbox, 'tools/server.mjs'), String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, FAKE_LOG: fakeLog }
  });

  await new Promise((ok, bad) => {
    serverProc.stdout.on('data', d => String(d).includes('workboard on') && ok());
    serverProc.on('exit', c => bad(new Error('server exited early: ' + c)));
    setTimeout(() => bad(new Error('server start timeout')), 10000);
  });

  page = await launchBrowser({ browserPath });
});

after(async () => {
  if (page) {
    try { await page.close(); } catch {}
  }
  if (serverProc) {
    try {
      const done = new Promise(r => serverProc.once('exit', r));
      serverProc.kill();
      await done;
    } catch {}
  }
  if (sandbox) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});

test('(a) 首頁載入無 console error', { skip: skipMsg }, async () => {
  page.clearConsoleErrors();
  await page.navigate(baseUrl);
  await page.waitFor('#dashboardView');
  await page.waitFor('#agentsList');
  const errors = page.getConsoleErrors();
  assert.equal(errors.length, 0, `預期首頁載入無 console 錯誤，但發現: ${errors.join('; ')}`);
});

test('(b) 建 project、建任務', { skip: skipMsg }, async () => {
  // 開啟專案對話框並新增專案
  await page.click('#projBtn');
  await page.waitFor('#projModal:not([hidden])');
  await page.type('#pId', 'proj-e2e');
  await page.type('#pName', 'E2E Project');
  await page.type('#pPath', projDir);
  await page.click('#projSave');
  await page.waitFor(() => {
    const list = document.querySelector('#projList');
    return list && list.textContent.includes('E2E Project');
  });
  await page.click('#projClose');
  await page.waitFor('#projModal[hidden]');

  // 開啟任務對話框並新增任務
  await page.click('#add');
  await page.waitFor('#taskModal:not([hidden])');
  await page.type('#fTitle', 'WP15 瀏覽器測試任務');
  await page.type('#fGoal', '端到端驗證');
  await page.type('#fAcc', '通過自動化測試');
  await page.selectOption('#fProject', 'proj-e2e');
  await page.selectOption('#fAgent', 'codex-a');
  await page.click('#taskSave');
  await page.waitFor('#taskModal[hidden]');

  // 驗證任務出現在畫面上
  await page.waitFor(() => {
    return document.body && document.body.textContent.includes('WP15 瀏覽器測試任務');
  });

  // 記錄生成的任務 ID
  createdTaskId = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card.t'));
    const target = cards.find(c => c.textContent.includes('WP15 瀏覽器測試任務'));
    return target?.dataset?.id || null;
  });
  assert.ok(createdTaskId, '應能取得新建立的任務 ID');
});

test('(c) 派工 → 出現「等你核准」→ 點「核准並繼續」→ 完成, 期間 Detail 事件即時出現', { skip: skipMsg }, async () => {
  assert.ok(createdTaskId, '前置任務 ID 必須存在');

  // 點擊派工按鈕
  await page.click(`button[data-run="${createdTaskId}"]`);

  // 關閉自動彈出的日誌視窗
  await page.waitFor('#logModal:not([hidden])');
  await page.click('#logClose');
  await page.waitFor('#logModal[hidden]');

  // 開啟 Detail 頁面，即時透過 SSE stream 接收活動事件
  await page.evaluate((id) => window.openDetail(id), createdTaskId);
  await page.waitFor('#detailPage:not([hidden])');

  // 驗證 SSE stream 即時推送的活動事件與核准按鈕
  await page.waitFor('.activity .event', { timeout: 15000 });
  await page.waitFor('button[data-detail-action="approve"]', { timeout: 15000 });

  // 點擊「核准並繼續」
  await page.click('button[data-detail-action="approve"]');

  // 等待執行完成，Detail 狀態徽章變更為已完成
  await page.waitFor(() => {
    const badge = document.querySelector('#detailPage .badge');
    return badge && (badge.textContent.includes('已完成') || badge.classList.contains('b-completed') || badge.classList.contains('b-exited'));
  }, { timeout: 15000 });

  // 返回主頁
  await page.click('[data-detail-back]');
  await page.waitFor('#detailPage[hidden]');
  await page.evaluate(() => window.load());

  // 切換至「已完成」分頁確認任務存在
  await page.click('#tabCompleted');
  await page.waitFor(() => {
    const content = document.querySelector('#tasksPaneContent');
    return content && content.textContent.includes('WP15 瀏覽器測試任務');
  });
});

test('(d) 退回沒填意見會被擋', { skip: skipMsg }, async () => {
  // 建立另一筆任務並派工
  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'task-reject-gate',
      title: '退回測試任務',
      agent: 'codex-a',
      project: 'proj-e2e',
      goal: '驗證退回阻擋',
      acceptance: '未填意見被拒'
    })
  });
  assert.equal(taskRes.status, 200);

  const dispatchRes = await fetch(`${baseUrl}/api/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'task-reject-gate' })
  });
  assert.equal(dispatchRes.status, 200);

  // 開啟 Task Detail 頁面並等待核准控制項出現
  await page.evaluate((id) => window.openDetail(id), 'task-reject-gate');
  await page.waitFor('#detailPage:not([hidden])');
  await page.waitFor('button[data-detail-action="reject"]', { timeout: 15000 });

  // 清空審查意見輸入框
  await page.evaluate(() => {
    const note = document.querySelector('[data-approval-note]');
    if (note) note.value = '';
  });

  // 點擊「退回並附意見」
  await page.click('button[data-detail-action="reject"]');

  // 驗證畫面上跳出 Toast 錯誤提示
  await page.waitFor('.toast.toast-error');
  const toastText = await page.evaluate(() => document.querySelector('.toast.toast-error')?.textContent);
  assert.match(toastText, /退回必須填寫具體意見/);

  // 驗證任務未被退回，核准按鈕仍然可見
  const hasApprove = await page.evaluate(() => Boolean(document.querySelector('button[data-detail-action="approve"]')));
  assert.equal(hasApprove, true, '退回被擋後核准按鈕仍應保持可見');

  // 返回主頁
  await page.click('[data-detail-back]');
  await page.waitFor('#detailPage[hidden]');
});

test('(e) 開工按鈕顯示簡報', { skip: skipMsg }, async () => {
  // 點擊開工按鈕
  await page.click('#sessionBriefing');
  await page.waitFor('#sessionModal:not([hidden])');

  // 驗證簡報標題
  const titleText = await page.evaluate(() => document.querySelector('#sessionTitle')?.textContent);
  assert.equal(titleText, '開工簡報');

  // 等待簡報內容載入完成
  await page.waitFor(() => {
    const content = document.querySelector('#sessionContent');
    return content && content.textContent.trim().length > 0 && !content.textContent.includes('讀取中');
  });

  const contentText = await page.evaluate(() => document.querySelector('#sessionContent')?.textContent);
  assert.ok(contentText.length > 0, '簡報內容不應為空');
  assert.match(contentText, /worklog-2026-09-30\.md|E2E 測試項目準備完畢/);

  // 關閉簡報對話框
  await page.click('#sessionClose');
  await page.waitFor('#sessionModal[hidden]');
});

test('(f) XSS 防護：任務標題含 <img onerror> 不會執行', { skip: skipMsg }, async () => {
  // 設置全域測試標記
  await page.evaluate(() => { window.__xss_fired = false; });

  // 建立帶有惡意 script/img onerror 的任務
  const xssRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'task-xss-attack',
      title: '<img src=x onerror="window.__xss_fired=true">',
      agent: 'codex-a'
    })
  });
  assert.equal(xssRes.status, 200);

  // 切換看板視圖促使 DOM 重新載入渲染
  await page.click('#navBoard');
  await page.waitFor('#boardPage:not([hidden])');
  await page.click('#navDashboard');
  await page.waitFor('#dashboardView:not([hidden])');

  // 驗證 window.__xss_fired 依然為 false
  const xssFired = await page.evaluate(() => window.__xss_fired);
  assert.equal(xssFired, false, '惡意 onerror 不應在瀏覽器中執行');

  // 驗證 DOM 中不存在注入的 img[onerror]
  const hasInjectedImg = await page.evaluate(() => Boolean(document.querySelector('img[onerror]')));
  assert.equal(hasInjectedImg, false, 'DOM 中不應存在未跳脫之 img[onerror]');
});

// ---- 回歸測試:真實資料量大時才會出現的問題(乾淨沙箱不易重現,所以在瀏覽器端刻意製造) ----

test('(g) 慢速/卡住的用量、活動、額度、分析 API 不可阻塞首頁顯示任務', { skip: skipMsg }, async () => {
  // 曾因 load() 用 Promise.all 綁住所有 API,真實資料下 /api/analytics 要數秒,首頁空白。
  await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'task-slow-heavy', title: '慢速API回歸任務', agent: 'codex-a', status: 'todo' }),
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const __f = window.fetch.bind(window);
    window.fetch = (u, o) => /\/api\/(usage|activity|quota|analytics)/.test(String(u)) ? new Promise(() => {}) : __f(u, o);
  ` });
  await page.navigate(baseUrl);
  // 重運算的 API 永遠不回應,任務仍必須在數秒內顯示(queued 分頁計數 ≥ 1)
  await page.waitFor(() => Number(document.querySelector('#countQueued')?.textContent) >= 1, { timeout: 5000 });
  const n = await page.evaluate(() => Number(document.querySelector('#countQueued').textContent));
  assert.ok(n >= 1);
});

test('(h) 舊式 review 狀態(沒有進行中的 run)不可標成「待核准計畫」', { skip: skipMsg }, async () => {
  await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'task-legacy-review', title: '舊式待驗收任務', agent: 'codex-a', status: 'review' }),
  });
  await page.navigate(baseUrl);
  await page.waitFor(() => document.body.textContent.includes('舊式待驗收任務'), { timeout: 8000 });
  const banner = await page.evaluate(() => (document.querySelector('.pinned-needs-you') || document.body).textContent);
  assert.ok(banner.includes('待你驗收'), '舊式 review 應標為「已完成・待你驗收」');
  const fakeApproval = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.pinned-item')].filter(x => x.textContent.includes('舊式待驗收任務'));
    return items.some(x => x.textContent.includes('待核准計畫'));
  });
  assert.equal(fakeApproval, false, '沒有等核准的計畫時,不可顯示「待核准計畫」');
});

test('(i) 新任務表單可選「流程」(pipeline),並存進任務', { skip: skipMsg }, async () => {
  await page.navigate(baseUrl);
  await page.waitFor('#add');
  await page.click('#add');
  await page.waitFor('#taskModal:not([hidden])');
  await page.waitFor(() => document.querySelectorAll('#fPipeline option').length >= 3, { timeout: 5000 });
  const opts = await page.evaluate(() => [...document.querySelectorAll('#fPipeline option')].map(o => o.value));
  assert.ok(opts.includes('standard') && opts.includes('single'), `流程選項應含 standard 與 single,實際: ${opts}`);
  assert.ok(!opts.includes('decompose'), 'decompose 是給需求拆解用的內部流程,不該出現在一般任務的流程選單');
  await page.type('#fTitle', '選流程的任務');
  await page.selectOption('#fPipeline', 'standard');
  await page.click('#taskSave');
  await page.waitFor('#taskModal[hidden]');
  const tasks = await (await fetch(`${baseUrl}/api/tasks`)).json();
  const t = tasks.find(x => x.title === '選流程的任務');
  assert.ok(t, '任務應已建立');
  assert.equal(t.pipeline, 'standard');
});

test('(j) worktree 專案:完成後 Detail 出現「合併到專案」,按下後變更進主目錄', { skip: skipMsg }, async () => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wt-'));
  const g = (...a) => execFileSync('git', a, { cwd: gitDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(gitDir, 'work.txt'), 'base\n');
  g('init'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 'T'); g('add', '.'); g('commit', '-m', 'base');
  const post = (p, body) => fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/projects', { id: 'wt-proj', name: 'wt', path: gitDir, worktrees: true })).status, 200);
    assert.equal((await post('/api/tasks', { id: 'task-wt-e2e', title: 'worktree 任務', agent: 'codex-a', project: 'wt-proj', pipeline: 'single', status: 'todo' })).status, 200);
    assert.equal((await post('/api/dispatch', { id: 'task-wt-e2e' })).status, 200);
    await page.navigate(baseUrl);
    await page.waitFor(() => typeof window.openDetail === 'function');
    await page.evaluate(() => { window.confirm = () => true; });
    await page.evaluate(() => window.openDetail('task-wt-e2e'));
    await page.waitFor('button[data-detail-action="approve"]', { timeout: 15000 });
    await page.click('button[data-detail-action="approve"]');
    await page.waitFor('button[data-detail-action="merge"]', { timeout: 20000 });
    assert.ok(await page.evaluate(() => document.body.textContent.includes('隔離分支')), '應顯示隔離分支區塊');
    assert.ok(!fs.existsSync(path.join(gitDir, 'executed.marker')), '合併前,施工結果不可出現在專案主目錄');
    await page.click('button[data-detail-action="merge"]');
    await page.waitFor(() => !document.querySelector('button[data-detail-action="merge"]'), { timeout: 15000 });
    assert.ok(fs.existsSync(path.join(gitDir, 'executed.marker')), '合併後,施工結果應進入專案主目錄');
  } finally { fs.rmSync(gitDir, { recursive: true, force: true }); }
});
