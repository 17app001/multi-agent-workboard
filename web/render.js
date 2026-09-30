// 看板前端的 HTML 樣板(純函式,不碰 DOM),由 index.html 以 <script src=render.js> 載入;
// tests/web.test.mjs 也會在 node vm 裡載入它,用惡意字串驗證輸出沒有未 escape 的內容(審查 #3,stored XSS)。
// 規則:凡是來自 task / project / config / run 狀態的字串,插進 HTML 前一律經過 esc();屬性值一律加引號。
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n);
const STATUS_LABEL = { running: '執行中', 'needs-you': '待你處理', exited: '已完成', failed: '失敗', error: '啟動失敗', stopped: '已停止', unknown: '狀態未知', none: '尚未派工過' };

function usageCardHtml(a) {
  const days = a.days || [];
  const mx = Math.max(1, ...days.map(d => d.total));
  const num = v => Number(v) || 0;
  return `<div class=card><b>${esc(a.label)}</b> <span class=mut>${esc(a.id)}</span>${a.found ? `
  <div class=big>${esc(fmt(num(a.today)))} <span class=mut>今日</span></div>
  <div class=mut>7日 ${esc(fmt(num(a.week)))} · 累計 ${esc(fmt(num(a.total)))}</div>
  <div class=mut>≈ $${num(a.costToday).toFixed(2)} 今日 · $${num(a.costWeek).toFixed(2)} 7日 · $${num(a.costTotal).toFixed(2)} 累計</div>
  <div class=mut>in ${esc(fmt(num(a.input)))} · cache ${esc(fmt(num(a.cached)))} · out ${esc(fmt(num(a.output)))}</div>
  <div class=bar>${days.map(d => `<i title="${esc(d.date)}: ${esc(fmt(num(d.total)))}" style="height:${num(d.total) / mx * 100}%"></i>`).join('')}</div>`
    : `<div class=mut>${a.enabled === false ? '未設定(已停用)' : '未設定 / 尚無使用記錄'}</div>`}</div>`;
}

function badgeHtml(t, runStatus) {
  const r = runStatus[t.id];
  if (!r || r.status === 'none') return '';
  return `<span class="badge b-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span>`;
}

function projLineHtml(t, projects) {
  if (!t.project) return '<div class=warn>⚠ 未綁定專案:會在看板 repo 內執行</div>';
  const p = projects.find(x => x.id === t.project);
  if (!p) return `<div class=warn>⚠ 專案「${esc(t.project)}」不存在,無法派工</div>`;
  const warn = p.valid ? '' : `<span class=warn>⚠ ${p.error ? esc(p.error) : '路徑失效,無法派工'}</span>`;
  return `<div class=row><span class=ptag>📂 ${esc(p.name || p.id)}</span>${warn}</div>`;
}

function taskCardHtml(t, cfg, projects, runStatus) {
  return `<div class="card t ${esc(t.priority)}" draggable=true data-id="${esc(t.id)}"><b>${esc(t.title)}</b>
 <div class=row><select data-id="${esc(t.id)}"><option value="">未指派</option>${cfg.agents.map(a => `<option value="${esc(a.id)}"${a.id == t.agent ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select>
 <span class=mut>${esc(t.priority)}</span> ${badgeHtml(t, runStatus)}</div>
 ${projLineHtml(t, projects)}
 ${t.goal ? `<div class=mut>🎯 ${esc(t.goal)}</div>` : ''}
 ${t.files ? `<div class=mut>📁 ${esc(t.files)}</div>` : ''}
 <div class=row>${t.agent && t.status != 'done' ? `<button data-run="${esc(t.id)}">▶ 派工</button>` : ''}
 ${runStatus[t.id]?.status === 'running' ? `<button class="iconbtn stop" data-stop="${esc(t.id)}">■ 停止</button>` : ''}
 <button class=iconbtn data-detail="${esc(t.id)}">Detail</button>
 <button class=iconbtn data-log="${esc(t.id)}">📜 log</button>
 <button class="iconbtn danger" data-del="${esc(t.id)}">🗑 刪除</button></div></div>`;
}

function columnsHtml(cfg, tasks, projects, runStatus) {
  return cfg.columns.map(c => `<div class=col data-c="${esc(c)}"><h3>${esc(c)} (${tasks.filter(t => t.status == c).length})</h3>${
    tasks.filter(t => t.status == c).map(t => taskCardHtml(t, cfg, projects, runStatus)).join('')}</div>`).join('');
}

function projectOptionsHtml(projects) {
  return '<option value="">(不綁定:在看板 repo 內執行)</option>' + projects.map(p =>
    `<option value="${esc(p.id)}"${p.valid ? '' : ' disabled'}>${esc(p.name || p.id)}${p.valid ? '' : '(無效)'}</option>`).join('');
}

function projectRowHtml(p) {
  return `<div class=row><span><b>${esc(p.name || p.id)}</b> <span class=mut>${esc(p.id)}${p.path ? ' · ' + esc(p.path) : ''}</span> ${p.valid ? '' : `<span class=warn>⚠ ${p.error ? esc(p.error) : '路徑失效'}</span>`}</span><button class="iconbtn danger" data-pdel="${esc(p.id)}">🗑 刪除</button></div>`;
}
