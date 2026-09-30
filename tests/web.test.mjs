// 前端 XSS 防護測試(審查 #3)。做法:web/render.js 是不碰 DOM 的純樣板函式,這裡在 node vm 沙箱載入它,
// 餵入惡意的 task/project/agent/usage/run 字串,斷言輸出的 HTML 裡沒有任何可執行的標籤/屬性注入;
// 另外靜態掃描 index.html 與 render.js,確認沒有把 task/project/agent 欄位直接插進模板(`${t.title}` 這類)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderSrc = fs.readFileSync(path.join(repo, 'web/render.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(repo, 'web/index.html'), 'utf8');
const detailSrc = fs.readFileSync(path.join(repo, 'web/detail.js'), 'utf8');

const ctx = vm.createContext({});
vm.runInContext(renderSrc + '\n;this.api = { esc, fmt, isOldDone, usageCardHtml, usageSummaryHtml, badgeHtml, projLineHtml, taskCardHtml, columnsHtml, agentsListHtml, tasksPaneHtml, needsYouPinnedHtml, activityListHtml, bigCounterOverlayHtml, agentOptionsHtml, modelOptionsHtml, projectFilterOptionsHtml, projectOptionsHtml, projectRowHtml };', ctx);
const R = ctx.api;
const detailCtx = vm.createContext({ Date, Object });
vm.runInContext(detailSrc + '\n;this.api = { detailHtml, detailEsc };', detailCtx);
const D = detailCtx.api;

const IMG = '<img src=x onerror="fetch(\'/api/dispatch\',{method:\'POST\'})">';
const QUOTE = '" onmouseover="alert(1)" x="';
const EVIL = `${IMG}${QUOTE}'&<script>alert(1)</script>`;

// 把輸出當 HTML 粗略解析:回傳所有標籤名稱與屬性名稱。惡意輸入若逃出文字/屬性值,就會多出 img/script 標籤或 onerror/onmouseover 屬性。
function scan(html) {
  const tags = [], attrs = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>"'/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    tags.push(m[1].toLowerCase());
    const attrRe = /\s+([^\s=>"'/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) attrs.push(a[1].toLowerCase());
  }
  return { tags, attrs };
}
const assertSafe = (html, what) => {
  const { tags, attrs } = scan(html);
  for (const bad of ['img', 'script', 'iframe', 'svg', 'a']) assert.ok(!tags.includes(bad), `${what}: 出現注入的 <${bad}>`);
  for (const a of attrs) assert.ok(!/^on/.test(a) && a !== 'x' && a !== 'src', `${what}: 出現注入的屬性 ${a}`);
  assert.ok(!html.includes('<img') && !html.includes('<script'), `${what}: 含未 escape 的標籤字串`);
  assert.ok(html.includes('&lt;img') || html.includes('&lt;script'), `${what}: 惡意文字應以 escape 後的文字出現`);
};

const cfg = { columns: ['todo', EVIL], agents: [{ id: 'a1', label: EVIL }, { id: EVIL, label: 'ok' }] };
const evilTask = { id: EVIL, title: EVIL, status: 'todo', agent: 'a1', priority: EVIL, project: EVIL, goal: EVIL, files: EVIL };
const evilProject = { id: EVIL, name: EVIL, path: EVIL, valid: false, error: EVIL };

test('esc:跳脫 & < > " \'', () => {
  assert.equal(R.esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(R.esc(null), '');
  assert.equal(R.esc(undefined), '');
  assert.equal(R.esc(123), '123');
});

test('任務卡片:title / files / goal / priority / project / id / agent label 帶惡意字串時輸出安全', () => {
  const html = R.taskCardHtml(evilTask, cfg, [evilProject], { [EVIL]: { status: EVIL } });
  assertSafe(html, 'taskCard');
  // 只剩我們自己的樣板標籤
  const { tags } = scan(html);
  for (const t of tags) assert.ok(['div', 'b', 'select', 'option', 'span', 'button'].includes(t), '意外的標籤 ' + t);
  // 個別欄位(專案存在/不存在兩種路徑都測)
  assertSafe(R.taskCardHtml({ ...evilTask, project: 'missing' , title: EVIL}, cfg, [], {}), 'taskCard 專案不存在');
  assertSafe(R.taskCardHtml({ ...evilTask, project: EVIL }, cfg, [{ ...evilProject, valid: true }], {}), 'taskCard 專案有效');
  assertSafe(R.taskCardHtml({ ...evilTask, project: '' , files: EVIL, goal: '', title: 'plain'}, cfg, [], {}), 'files 欄位');
  assertSafe(R.taskCardHtml({ ...evilTask, project: '', files: '', goal: EVIL, title: 'plain' }, cfg, [], {}), 'goal 欄位');
});

test('看板欄位、專案下拉、專案清單、專案警告、run 狀態徽章都 escape', () => {
  assertSafe(R.columnsHtml(cfg, [evilTask], [evilProject], {}), 'columns');
  assertSafe(R.projectOptionsHtml([evilProject, { ...evilProject, valid: true }]), 'project options');
  assertSafe(R.projectRowHtml(evilProject), 'project row');
  assertSafe(R.projectRowHtml({ ...evilProject, valid: true, error: undefined }), 'project row valid');
  assertSafe(R.badgeHtml({ id: 't' }, { t: { status: EVIL } }), 'badge');
  assert.equal(R.badgeHtml({ id: 't' }, {}), '');
});

test('用量卡片:label / id / 日期帶惡意字串時輸出安全,數字欄位被強制成數字', () => {
  const a = { label: EVIL, id: EVIL, found: true, today: '<b>1</b>', week: 2, total: 3, costToday: '<i>', costWeek: 0, costTotal: 0, input: 1, cached: 1, output: 1, days: [{ date: EVIL, total: 5 }] };
  assertSafe(R.usageCardHtml(a), 'usage');
  assert.ok(!R.usageCardHtml(a).includes('<b>1</b>'));
  assertSafe(R.usageCardHtml({ label: EVIL, id: EVIL, found: false, enabled: false, days: [] }), 'usage not found');
});

test('正常資料仍正確渲染(escape 不破壞顯示)', () => {
  const html = R.taskCardHtml({ id: 'a-1', title: 'A & B <ok>', status: 'todo', agent: 'a1', priority: 'p0', project: '', goal: 'g', files: 'tools/x.mjs,web/' }, { columns: ['todo'], agents: [{ id: 'a1', label: 'Agent 1' }] }, [], {});
  assert.match(html, /<b>A &amp; B &lt;ok&gt;<\/b>/);
  assert.match(html, /data-id="a-1"/);
  assert.match(html, /<option value="a1" selected>Agent 1<\/option>/);
  assert.match(html, /📁 tools\/x\.mjs,web\//);
  assert.match(html, /data-run="a-1"/);
  assert.match(html, /class="card t p0"/);
});

test('Task Detail escapes malicious run, event, artifact, and raw-log data', () => {
  const html = D.detailHtml({ run: { taskId: EVIL, status: 'needs-you', needsYou: { reason: 'approval', message: EVIL }, steps: [{ id: EVIL, status: EVIL, agent: EVIL }] }, artifacts: [{ name: EVIL, size: EVIL }] }, { title: EVIL, project: EVIL }, [{ ts: EVIL, step: EVIL, kind: EVIL, text: EVIL }], { [EVIL]: EVIL }, EVIL);
  assertSafe(html, 'detail');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /data-detail-action="approve"/);
});

test('revision-limit Detail has explicit recovery controls, timeline, folded review, and escapes notes', () => {
  const html = D.detailHtml({ run: { taskId: 't', status: 'needs-you', revisions: 3, needsYou: { reason: 'revision-limit', message: EVIL }, reviewHistory: [{ ts: Date.now(), verdict: EVIL, attempt: EVIL, revision: EVIL }] }, artifacts: [] }, { title: EVIL }, [{ text: EVIL }], { 'review.md': EVIL }, EVIL);
  assertSafe(html, 'revision detail');
  assert.match(html, /<details>/);
  assert.match(html, /data-detail-action="note"/);
  assert.match(html, /data-detail-action="retry"/);
  assert.match(html, /data-detail-action="complete"/);
  assert.match(html, /data-detail-action="abort"/);
  assert.match(html, /讓 agent 再試一次/);
  assert.match(html, /我自己處理/);
  assert.match(html, /忽略並完成/);
});

test('WP5 新增樣板函式 XSS 防護與 escape 安全性', () => {
  const sumHtml = R.usageSummaryHtml([{ found: true, today: EVIL, costToday: 1.5 }]);
  assert.ok(!sumHtml.includes('<img') && !sumHtml.includes('<script'));
  assertSafe(R.agentsListHtml(cfg.agents, [{ taskId: EVIL, taskTitle: EVIL, agent: 'a1', step: EVIL }], [], { a1: { until: Date.now() + 10000, reason: EVIL } }), 'agentsList');
  assertSafe(R.tasksPaneHtml([{ ...evilTask, status: 'review' }], 'needs-you', cfg, [evilProject], {}), 'tasksPane needs-you');
  assertSafe(R.tasksPaneHtml([{ ...evilTask, status: 'doing' }], 'running', cfg, [evilProject], {}), 'tasksPane running');
  assertSafe(R.tasksPaneHtml([{ ...evilTask, status: 'todo' }], 'queued', cfg, [evilProject], {}), 'tasksPane queued');
  assertSafe(R.tasksPaneHtml([{ ...evilTask, status: 'done' }], 'completed', cfg, [evilProject], {}, true), 'tasksPane completed');
  assertSafe(R.needsYouPinnedHtml([{ ...evilTask, status: 'review' }], {}, true), 'needsYouPinned expanded');
  const collapsed = R.needsYouPinnedHtml([{ ...evilTask, status: 'review' }], {}, false);
  assert.ok(!collapsed.includes('<img') && !collapsed.includes('<script'));
  assertSafe(R.activityListHtml([{ ts: Date.now(), taskId: EVIL, taskTitle: EVIL, step: EVIL, kind: EVIL, text: EVIL }]), 'activityList');
  assertSafe(R.bigCounterOverlayHtml(2, [{ ...evilTask, status: 'review' }]), 'bigCounterOverlay');
  assertSafe(R.projectFilterOptionsHtml([evilProject], EVIL), 'projectFilterOptions');
  assertSafe(R.modelOptionsHtml([{ id: EVIL, label: EVIL }]), 'modelOptions');
  assertSafe(R.agentOptionsHtml([{ id: EVIL, label: EVIL }]), 'agentOptions');
});

test('isOldDone: 3天前完成的任務判斷與容錯', () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const oneDayAgo = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
  assert.equal(R.isOldDone({ status: 'done', updated: fourDaysAgo }), true);
  assert.equal(R.isOldDone({ status: 'completed', updated: fourDaysAgo }), true);
  assert.equal(R.isOldDone({ status: 'done', updated: oneDayAgo }), false);
  assert.equal(R.isOldDone({ status: 'todo', updated: fourDaysAgo }), false);
  assert.equal(R.isOldDone({ status: 'done', updated: 'invalid-date' }), false);
  assert.equal(R.isOldDone({ status: 'done' }), false);
});

test('靜態掃描:index.html / render.js 沒有把 task/project/agent/usage 欄位未經 esc 直接插進模板,index.html 用 render.js 的樣板', () => {
  for (const [name, src] of [['render.js', renderSrc], ['index.html', indexSrc]]) {
    const raw = [...src.matchAll(/\$\{\s*(?:t|a|p|c|d|r|x|cfg|task|proj)\.[\w.]+\s*\}/g)].map(m => m[0]);
    assert.deepEqual(raw, [], `${name}: 有未 escape 的 \${欄位} 插值: ${raw.join(' ')}`);
  }
  assert.ok(indexSrc.includes('<script src=render.js></script>'));
  assert.ok(!/const esc\s*=/.test(indexSrc), 'esc 只定義在 render.js');
  assert.match(indexSrc, /columnsHtml\(cfg,tasks,projects,runStatus\)/);
  // 所有 innerHTML 賦值都必須來自 render.js 的樣板函式或固定字串
  const inner = [...indexSrc.matchAll(/innerHTML\s*=\s*([^;\n]+)/g)].map(m => m[1].trim());
  assert.ok(inner.length >= 4);
  for (const rhs of inner) assert.ok(/^(columnsHtml|projectOptionsHtml|projectFilterOptionsHtml|agentOptionsHtml|modelOptionsHtml|usageSummaryHtml|agentsListHtml|tasksPaneHtml|needsYouPinnedHtml|activityListHtml|bigCounterOverlayHtml|usageData\.map\(usageCardHtml\)|u\.map\(usageCardHtml\)|projects\.length\?projects\.map\(projectRowHtml\)|detailHtml)/.test(rhs), 'innerHTML 來源不明: ' + rhs);
  // index.html 的內嵌腳本語法正確,且所有 fetch 都經過帶 JSON content-type 的 api()
  const scripts = [...indexSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]); // 語法檢查(不執行)
  assert.equal([...scripts[0].matchAll(/\bfetch\(/g)].length, 1, '只有 api() 自己呼叫 fetch');
  assert.match(scripts[0], /headers:\{'content-type':'application\/json'/);
});

test('Codex quota card escapes API data and renders warning, stale, and missing states', () => {
  const agent = [{ id: 'codex-a', type: 'codex', label: EVIL }];
  const quota = { id: 'codex-a', quota: { primary: { usedPercent: 81, resetsAt: Date.now() + 1000 }, secondary: { usedPercent: 96, resetsAt: Date.now() + 2000 }, stale: true } };
  const html = R.agentsListHtml(agent, [], [], {}, [quota]);
  assertSafe(html, 'quota card');
  assert.match(html, /quota-warn/);
  assert.match(html, /quota-danger/);
  assert.match(html, /quota-stale/);
  assert.match(R.agentsListHtml(agent, [], [], {}, []), /\u5c1a\u7121\u984d\u5ea6\u8cc7\u6599/);
});
