// 看板前端的 HTML 樣板(純函式,不碰 DOM),由 index.html 以 <script src=render.js> 載入;
// tests/web.test.mjs 也會在 node vm 裡載入它,用惡意字串驗證輸出沒有未 escape 的內容(審查 #3,stored XSS)。
// 規則:凡是來自 task / project / config / run 狀態的字串,插進 HTML 前一律經過 esc();屬性值一律加引號。
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n);
const num = v => Number(v) || 0;

const STATUS_LABEL = {
  running: '執行中',
  'needs-you': '待你處理',
  completed: '已完成',
  done: '已完成',
  exited: '已完成',
  failed: '執行失敗',
  error: '啟動失敗',
  stopped: '已停止',
  cancelled: '已停止',
  queued: '排隊中',
  todo: '排隊中',
  draft: '草稿',
  backlog: '草稿',
  pending: '等候中',
  none: '尚未派工',
  unknown: '狀態未知'
};

const isOldDone = t => {
  const isDone = t.status === 'done' || t.state === 'completed' || t.status === 'completed';
  if (!isDone) return false;
  if (!t.updated) return false;
  const d = new Date(t.updated).getTime();
  return Number.isFinite(d) && (Date.now() - d > 3 * 86400000);
};

let currentShowOldDone = false;
const setShowOldDoneState = v => { currentShowOldDone = Boolean(v); };

function usageCardHtml(a) {
  const days = a.days || [];
  const mx = Math.max(1, ...days.map(d => num(d.total)));
  return `<div class=card><b>${esc(a.label)}</b> <span class=mut>${esc(a.id)}</span>${a.found ? `
  <div class=big>${esc(fmt(num(a.today)))} <span class=mut>今日</span></div>
  <div class=mut>7日 ${esc(fmt(num(a.week)))} · 累計 ${esc(fmt(num(a.total)))}</div>
  <div class=mut>≈ $${esc(num(a.costToday).toFixed(2))} 今日 · $${esc(num(a.costWeek).toFixed(2))} 7日 · $${esc(num(a.costTotal).toFixed(2))} 累計</div>
  <div class=mut>in ${esc(fmt(num(a.input)))} · cache ${esc(fmt(num(a.cached)))} · out ${esc(fmt(num(a.output)))}</div>
  <div class=bar>${days.map(d => `<i title="${esc(d.date)}: ${esc(fmt(num(d.total)))}" style="height:${esc((num(d.total) / mx * 100).toFixed(1))}%"></i>`).join('')}</div>`
    : `<div class=mut>${a.enabled === false ? '未設定(已停用)' : '未設定 / 尚無使用記錄'}</div>`}</div>`;
}

function usageSummaryHtml(usageList = []) {
  let todayTokens = 0, costToday = 0;
  for (const u of usageList) {
    if (u && u.found) {
      todayTokens += num(u.today);
      costToday += num(u.costToday);
    }
  }
  return `<div class="usage-summary-bar"><span>📊 <b>今日用量:</b> ${esc(fmt(todayTokens))} tokens · 約 $${esc(costToday.toFixed(2))} (API 估算)</span><button class=iconbtn data-view="analytics">查看詳細用量 →</button></div>`;
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
  const r = runStatus[t.id];
  const isNeedsYou = t.status === 'review' || t.state === 'needs-you' || r?.status === 'needs-you';
  const isRunning = r?.status === 'running' || t.status === 'doing';
  return `<div class="card t ${esc(t.priority)}" draggable=true data-id="${esc(t.id)}"><b>${esc(t.title)}</b>
 <div class=row><select data-id="${esc(t.id)}"><option value="">未指派</option>${cfg.agents.map(a => `<option value="${esc(a.id)}"${a.id == t.agent ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select>
 <span class=mut>${esc(t.priority)}</span> ${badgeHtml(t, runStatus)}</div>
 ${projLineHtml(t, projects)}
 ${t.goal ? `<div class=mut>🎯 ${esc(t.goal)}</div>` : ''}
 ${t.model ? `<div class=mut>Model: ${esc(t.model)}</div>` : ''}
 ${t.files ? `<div class=mut>📁 ${esc(t.files)}</div>` : ''}
 <div class=row>${isNeedsYou ? `<button class=primary data-detail="${esc(t.id)}">審查 / 處理</button>` : ''}
 ${t.agent && t.status != 'done' && !isRunning ? `<button data-run="${esc(t.id)}">▶ 派工</button>` : ''}
 ${isRunning ? `<button class="iconbtn stop" data-stop="${esc(t.id)}">■ 停止</button>` : ''}
 <button class=iconbtn data-detail="${esc(t.id)}">詳情</button>
 <button class=iconbtn data-log="${esc(t.id)}">📜 日誌</button>
 <button class="iconbtn danger" data-del="${esc(t.id)}">🗑 刪除</button></div></div>`;
}

function columnsHtml(cfg, tasks, projects, runStatus, showOldDone = currentShowOldDone) {
  return cfg.columns.map(c => {
    let colTasks = tasks.filter(t => t.status == c);
    let hiddenCount = 0;
    if (c === 'done' && !showOldDone) {
      const activeDone = colTasks.filter(t => !isOldDone(t));
      hiddenCount = colTasks.length - activeDone.length;
      colTasks = activeDone;
    }
    const toggleBtn = c === 'done'
      ? ` <button class=iconbtn data-action="toggle-old-done">${showOldDone ? '收合3天前任務' : (hiddenCount > 0 ? `展開3天前 (${esc(hiddenCount)})` : '展開3天前')}</button>`
      : '';
    return `<div class=col data-c="${esc(c)}"><h3>${esc(c)} (${esc(colTasks.length)}${hiddenCount > 0 ? ` / 隱藏 ${esc(hiddenCount)}` : ''})${toggleBtn}</h3>${
      colTasks.map(t => taskCardHtml(t, cfg, projects, runStatus)).join('')}</div>`;
  }).join('');
}

function legacyAgentsListHtml(agents = [], activeAgents = [], usageList = [], cooldowns = {}) {
  const now = Date.now();
  return agents.map(a => {
    const active = activeAgents.find(x => x && x.agent === a.id);
    const cd = cooldowns && cooldowns[a.id];
    const isCooldown = cd && Number.isFinite(cd.until) && cd.until > now;
    const isRunning = Boolean(active);
    const isDisabled = a.enabled === false;
    let lamp = '<span class="lamp lamp-idle">⚪</span> <span class=agent-status-text>閒置</span>';
    let activityText = '';
    if (isRunning) {
      lamp = '<span class="lamp lamp-running">🟢</span> <span class="agent-status-text b-running">執行中</span>';
      activityText = `<div class=agent-activity>任務: <b>${esc(active.taskTitle || active.taskId)}</b>${active.step ? ` (${esc(active.step)})` : ''}</div>`;
    } else if (isCooldown) {
      lamp = '<span class="lamp lamp-cooldown">🟡</span> <span class="agent-status-text b-stopped">冷卻中</span>';
      const untilStr = new Date(cd.until).toLocaleTimeString();
      activityText = `<div class="agent-activity warn">冷卻至 ${esc(untilStr)} (${esc(cd.reason || 'quota')})</div>`;
    } else if (isDisabled) {
      lamp = '<span class="lamp lamp-disabled">⚫</span> <span class="agent-status-text mut">已停用</span>';
    }
    const u = usageList.find(x => x && x.id === a.id);
    const todayTokens = u && u.found ? num(u.today) : 0;
    const todayCost = u && u.found ? num(u.costToday) : 0;
    const isCodex = String(a.type || '').includes('codex') || String(a.id || '').includes('codex');
    return `<div class="agent-card card${isRunning ? ' is-running' : ''}"><div class=row><b>${esc(a.label || a.id)}</b> <span class=mut>${esc(a.id)}</span> <span class=agent-lamp-wrap>${lamp}</span></div>${activityText}<div class=mut>今日用量: ${esc(fmt(todayTokens))} · $${esc(todayCost.toFixed(2))}</div>${isCodex ? '<div class=codex-quota><span class=ptag>Codex 額度</span> <span class=mut>訂閱制預留位</span></div>' : ''}</div>`;
  }).join('');
}

function quotaHtml(quota) {
  if (!quota || !quota.primary || !quota.secondary) return '<div class=codex-quota><span class=ptag>Codex \u984d\u5ea6</span> <span class=mut>\u5c1a\u7121\u984d\u5ea6\u8cc7\u6599</span></div>';
  const line = (label, item, showReset) => {
    const used = Math.max(0, Math.min(100, num(item.usedPercent)));
    const level = used > 95 ? ' quota-danger' : used > 80 ? ' quota-warn' : '';
    const reset = Number.isFinite(item.resetsAt) ? new Date(item.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    return `<div class="quota-line${level}"><span>${esc(label)} ${esc(used)}%${showReset ? ` (${esc(reset)} \u91cd\u7f6e)` : ''}</span><span class=quota-track><i style="width:${esc(used.toFixed(1))}%"></i></span></div>`;
  };
  return `<div class=codex-quota><span class=ptag>Codex \u984d\u5ea6</span>${quota.stale ? '<span class="mut quota-stale">\u8cc7\u6599\u53ef\u80fd\u904e\u671f</span>' : ''}${line('5 \u5c0f\u6642', quota.primary, true)}${line('\u6bcf\u9031', quota.secondary, false)}</div>`;
}

// Kept separate from the activity renderer so quota data can fail independently.
function agentsListHtml(agents = [], activeAgents = [], usageList = [], cooldowns = {}, quotaList = []) {
  const now = Date.now();
  return agents.map(a => {
    const active = activeAgents.find(x => x && x.agent === a.id);
    const cd = cooldowns && cooldowns[a.id];
    const isCooldown = cd && Number.isFinite(cd.until) && cd.until > now;
    const isRunning = Boolean(active);
    const isDisabled = a.enabled === false;
    let lamp = '<span class="lamp lamp-idle">idle</span>';
    let activityText = '';
    if (isRunning) activityText = `<div class=agent-activity>Task: <b>${esc(active.taskTitle || active.taskId)}</b>${active.step ? ` (${esc(active.step)})` : ''}</div>`;
    else if (isCooldown) activityText = `<div class="agent-activity warn">Cooldown until ${esc(new Date(cd.until).toLocaleTimeString())} (${esc(cd.reason || 'quota')})</div>`;
    else if (isDisabled) lamp = '<span class="lamp lamp-disabled">disabled</span>';
    const u = usageList.find(x => x && x.id === a.id);
    const quota = quotaList.find(x => x && x.id === a.id)?.quota;
    const isCodex = a.type === 'codex';
    const tokenText = u && u.found ? `${esc(fmt(num(u.today)))} · $${esc(num(u.costToday).toFixed(2))}` : '—';
    return `<div class="agent-card card${isRunning ? ' is-running' : ''}"><div class=row><b>${esc(a.label || a.id)}</b> <span class=mut>${esc(a.id)}</span> <span class=agent-lamp-wrap>${lamp}</span></div>${activityText}<div class=mut>Today: ${tokenText}</div>${isCodex ? quotaHtml(quota) : ''}</div>`;
  }).join('');
}

function tasksPaneHtml(tasks = [], activeTab = 'needs-you', cfg = { agents: [] }, projects = [], runStatus = {}, showOldDone = currentShowOldDone) {
  let list = [];
  if (activeTab === 'needs-you') {
    list = tasks.filter(t => t.status === 'review' || t.state === 'needs-you' || runStatus[t.id]?.status === 'needs-you');
  } else if (activeTab === 'running') {
    list = tasks.filter(t => (t.status === 'doing' || t.state === 'running' || runStatus[t.id]?.status === 'running') && t.status !== 'review' && t.state !== 'needs-you');
  } else if (activeTab === 'queued') {
    list = tasks.filter(t => (t.status === 'todo' || t.status === 'backlog' || t.state === 'queued' || t.state === 'draft') && runStatus[t.id]?.status !== 'running' && runStatus[t.id]?.status !== 'needs-you');
  } else if (activeTab === 'completed') {
    list = tasks.filter(t => t.status === 'done' || t.state === 'completed');
  } else {
    list = tasks;
  }
  let hiddenOldDoneCount = 0;
  if (activeTab === 'completed') {
    const totalDone = list.length;
    if (!showOldDone) {
      list = list.filter(t => !isOldDone(t));
      hiddenOldDoneCount = totalDone - list.length;
    }
  }
  const emptyMsgs = {
    'needs-you': '🎉 目前沒有需要你處理的任務！所有 Agent 都正常運作中。',
    running: '目前沒有正在執行的任務。點擊「▶ 派工」開始新任務。',
    queued: '排隊清單目前是空的。點擊右上角「+ 新任務」新增。',
    completed: '尚無已完成的任務記錄。',
  };
  const toggleBar = activeTab === 'completed'
    ? `<div class=tab-toggle-bar><label><input type=checkbox data-action="toggle-old-done"${showOldDone ? ' checked' : ''}> 顯示 3 天前完成的任務${hiddenOldDoneCount > 0 ? ` (已隱藏 ${esc(hiddenOldDoneCount)} 張)` : ''}</label></div>`
    : '';
  if (list.length === 0) {
    return `${toggleBar}<div class="empty-state card"><p class=mut>${esc(emptyMsgs[activeTab] || '尚無任務')}</p></div>`;
  }
  return `${toggleBar}<div class=tasks-grid>${list.map(t => taskCardHtml(t, cfg, projects, runStatus)).join('')}</div>`;
}

function needsYouPinnedHtml(needsYouTasks = [], runStatus = {}, isExpanded = true) {
  const count = needsYouTasks.length;
  if (count === 0) return '';
  const header = `<div class=pinned-header><div class=row><span class=pinned-icon>🚨</span><b>需要你處理 (${esc(count)})</b><span class=mut>有任務等待核准、需要指示或發生錯誤</span></div><div class=row><button class=iconbtn data-action="open-big-counter">🔍 巨幕提示</button><button class=iconbtn data-action="toggle-pinned">${isExpanded ? '▲ 收合' : '▼ 展開'}</button></div></div>`;
  if (!isExpanded) {
    return `<div class="pinned-needs-you is-collapsed card">${header}</div>`;
  }
  const items = needsYouTasks.map(t => {
    const r = runStatus[t.id];
    const reason = r?.needsYou?.reason || 'approval';
    const reasonText = reason === 'approval' ? '待核准計畫' : (reason === 'revision-limit' ? '回修達上限' : (reason === 'permission' ? '需要權限' : (reason === 'timeout' ? '執行逾時' : '需要指示')));
    return `<div class="pinned-item row"><div class=pinned-item-info><span class="badge b-failed">${esc(reasonText)}</span><b>${esc(t.title || t.id)}</b><span class=mut>${esc(t.agent ? 'agent: ' + t.agent : '')}</span></div><div class=row><button class=primary data-detail="${esc(t.id)}">👉 立即審查 / 處理</button></div></div>`;
  }).join('');
  return `<div class="pinned-needs-you card">${header}<div class=pinned-items>${items}</div></div>`;
}

function activityListHtml(events = []) {
  if (!events || events.length === 0) {
    return '<div class="mut empty-activity">尚無近期活動記錄</div>';
  }
  return `<div class=activity-timeline>${events.map(e => {
    let timeStr = '—';
    if (e.ts) {
      try { timeStr = new Date(e.ts).toLocaleTimeString(); } catch {}
    }
    const textStr = typeof e.text === 'string' ? e.text : JSON.stringify(e.text ?? '');
    return `<div class=activity-item data-detail="${esc(e.taskId)}"><div class=activity-meta><span class=activity-time>${esc(timeStr)}</span><b class=activity-task title="${esc(e.taskTitle || e.taskId)}">${esc(e.taskTitle || e.taskId)}</b>${e.step ? `<span class=ptag>${esc(e.step)}</span>` : ''}<span class="activity-kind mut">${esc(e.kind || '')}</span></div><div class=activity-desc>${esc(textStr)}</div></div>`;
  }).join('')}</div>`;
}

function bigCounterOverlayHtml(count = 0, tasks = []) {
  const needsList = tasks.filter(t => t.status === 'review' || t.state === 'needs-you');
  return `<div class=big-counter-box><button class=big-counter-close data-action="close-big-counter">✕ 關閉 (ESC)</button><div class=big-counter-number>${esc(count)}</div><div class=big-counter-label>${count > 0 ? '待你處理' : '所有任務正常'}</div><div class="big-counter-sub mut">${count > 0 ? '有任務需要人工核准、指示或遇到錯誤' : '目前沒有阻塞中的任務'}</div>${needsList.length > 0 ? `<div class=big-counter-list>${needsList.map(t => `<div class=big-counter-item data-detail="${esc(t.id)}"><b>${esc(t.title || t.id)}</b> <span class=mut>${esc(t.agent || '')}</span> <button class=iconbtn data-detail="${esc(t.id)}">前往處理 →</button></div>`).join('')}</div>` : ''}</div>`;
}

function agentOptionsHtml(agents) {
  return '<option value="">(未指派)</option>' + agents.map(a => `<option value="${esc(a.id)}">${esc(a.label || a.id)}</option>`).join('');
}
function modelOptionsHtml(models, selected = '') {
  return '<option value="">使用 Agent / CLI 預設</option>' + (models || []).map(m => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.label || m.id)}</option>`).join('');
}

function projectFilterOptionsHtml(projects, selected = '') {
  return '<option value="">全部專案</option>' + (projects || []).map(p =>
    `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name || p.id)}</option>`).join('');
}

function projectOptionsHtml(projects) {
  return '<option value="">(不綁定:在看板 repo 內執行)</option>' + projects.map(p =>
    `<option value="${esc(p.id)}"${p.valid ? '' : ' disabled'}>${esc(p.name || p.id)}${p.valid ? '' : '(無效)'}</option>`).join('');
}

function projectRowHtml(p) {
  return `<div class=row><span><b>${esc(p.name || p.id)}</b> <span class=mut>${esc(p.id)}${p.path ? ' · ' + esc(p.path) : ''}</span> ${p.valid ? '' : `<span class=warn>⚠ ${p.error ? esc(p.error) : '路徑失效'}</span>`}</span><button class="iconbtn danger" data-pdel="${esc(p.id)}">🗑 刪除</button></div>`;
}
