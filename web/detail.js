// Safe, pure Task Detail renderer: no untrusted value is inserted unescaped.
const detailEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const detailTime = value => value ? new Date(value).toLocaleString() : '—';
const detailDuration = (start, end) => { if (!start) return '—'; const ms = Math.max(0, new Date(end || Date.now()) - new Date(start)); return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms / 1000) % 60}s`; };
const detailText = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const DETAIL_STATUS = { running: '執行中', 'needs-you': '待你處理', completed: '已完成', done: '已完成', exited: '已完成', failed: '執行失敗', error: '啟動失敗', stopped: '已停止', cancelled: '已停止', queued: '排隊中', todo: '排隊中', draft: '草稿', backlog: '草稿', pending: '等候中', unknown: '狀態未知' };
const DETAIL_REASONS = { approval: '等待核准', 'revision-limit': '回修達上限', permission: '需要權限', timeout: '逾時終止', 'missing-input': '缺少輸入檔案', 'no-agent-available': '無可用 Agent', 'model-unavailable': '模型不可用' };

const usageNumber = value => Number(value) || 0;
const usageLine = usage => !usage?.available ? '<span class=mut>無資料</span>' : `in ${detailEsc(usageNumber(usage.input).toLocaleString())} · cache ${detailEsc(usageNumber(usage.cached).toLocaleString())} · out ${detailEsc(usageNumber(usage.output).toLocaleString())} · total ${detailEsc(usageNumber(usage.total).toLocaleString())} · $${detailEsc(usageNumber(usage.costEstimate).toFixed(4))}`;

function detailHtml(detail, task = {}, activity = [], artifactText = {}, raw = '') {
  const run = detail?.run || {}, steps = Array.isArray(run.steps) ? run.steps : [], artifacts = Array.isArray(detail?.artifacts) ? detail.artifacts : [], needs = run.needsYou || {};
  const statusLabel = DETAIL_STATUS[run.status] || run.status || 'unknown';
  const reasonLabel = DETAIL_REASONS[needs.reason] || needs.reason || '待處理';
  const reviewHistory = Array.isArray(run.reviewHistory) ? run.reviewHistory : [];
  const isRevisionLimit = run.status === 'needs-you' && needs.reason === 'revision-limit';
  const revisionDetail = !isRevisionLimit ? '' : `<section class=detail-section><h3>回修已達上限</h3><p>已回修 <b>${detailEsc(run.revisions || 0)}</b> 次。你可以提供補充後再試、保留變更自行處理，或忽略未完成步驟並完成。</p><details><summary>完整 review.md</summary><pre>${detailEsc(artifactText['review.md'] || '尚未取得 review.md')}</pre></details><h4>審查時間軸</h4><ol class=activity>${reviewHistory.length ? reviewHistory.map(item => `<li><b>${detailEsc(item.verdict || '')}</b> · ${detailEsc(detailTime(item.ts))} · 審查 #${detailEsc(item.attempt || '')} · 回修 #${detailEsc(item.revision || 0)}</li>`).join('') : '<li class=mut>尚無審查歷史</li>'}</ol></section>`;
  const isDecomposeNeedsYou = run.pipeline === 'decompose' && run.status === 'needs-you';
  const decomposeDraftBtn = !isDecomposeNeedsYou ? '' : `<div class=row style="margin-bottom:10px"><button class=primary data-open-decompose-draft="${detailEsc(task.id || run.taskId || '')}">📋 檢視並確認任務拆解草案</button></div>`;
  const controls = run.status !== 'needs-you' ? '' : needs.reason === 'approval'
    ? `<section class=detail-section><h3>需要核准</h3>${decomposeDraftBtn}<textarea data-approval-note placeholder="選填核准備註…"></textarea><div class=row><button data-detail-action="approve">核准並繼續</button><button data-detail-action="reject">退回並附意見</button></div></section>`
    : isRevisionLimit
      ? `${revisionDetail}<section class=detail-section><h3>需要你的指示</h3><p><b>${detailEsc(reasonLabel)}:</b> ${detailEsc(needs.message || needs.error || '')}</p><textarea data-step-note placeholder="補充給下次同一步的背景（不會自動重跑）"></textarea><div class=row><button data-detail-action="note">加入下次同一步</button><button data-detail-action="retry">讓 agent 再試一次</button><button data-detail-action="complete">忽略並完成</button><button class="danger" data-detail-action="abort">我自己處理</button></div></section>`
      : `<section class=detail-section><h3>需要你的指示</h3><p><b>${detailEsc(reasonLabel)}:</b> ${detailEsc(needs.message || needs.error || '')}</p><div class=row><button data-detail-action="retry">重試</button><button class="danger" data-detail-action="abort">中止</button></div></section>`;
  return `<div class=detail-head><div><button class=iconbtn data-detail-back>← 返回主頁</button><h2>${detailEsc(task.title || run.taskId || '')}</h2><p class=mut>${detailEsc(task.project || '無專案')} · ${detailEsc(run.pipeline || '')} · ${detailEsc(statusLabel)} · ${detailDuration(run.startedAt, run.endedAt)}${task.dependsOn ? ' · 依賴: ' + detailEsc(task.dependsOn) : ''}</p></div><span class="badge b-${detailEsc(run.status || 'unknown')}">${detailEsc(statusLabel)}</span></div>${controls}<section class=detail-section><h3>執行管線</h3><ol class=steps>${steps.map(step => `<li class="step step-${detailEsc(step.status || 'pending')}"><b>${detailEsc(step.id)}</b> <span>${detailEsc(step.agent || step.type || '')} · ${detailEsc(step.mode || '')}${step.model ? ` · model: ${detailEsc(step.model)}` : ''}</span><span class=mut>${detailEsc(DETAIL_STATUS[step.status] || step.status || 'pending')} · ${detailTime(step.startedAt)} → ${detailTime(step.endedAt)}</span></li>`).join('')}</ol></section><section class=detail-section><h3>活動動態</h3><div class=activity>${activity.length ? activity.map(event => `<div class=event><span class=mut>${detailEsc(event.ts || '')} · ${detailEsc(event.step || '')} · ${detailEsc(event.kind || '')}</span><div>${detailEsc(detailText(event.text ?? event.message ?? event))}</div></div>`).join('') : '<p class=mut>尚無活動記錄</p>'}</div></section><section class=detail-section><h3>產出成品</h3><div class=artifacts>${artifacts.length ? artifacts.map(a => `<article><button class=iconbtn data-artifact="${detailEsc(a.name)}">${detailEsc(a.name)}</button> <span class=mut>${detailEsc(a.size)} 位元組</span>${Object.hasOwn(artifactText, a.name) ? `<pre>${detailEsc(artifactText[a.name])}</pre>` : ''}</article>`).join('') : '<p class=mut>尚無產出成品</p>'}</div></section><section class=detail-section><h3>原始輸出</h3><pre class=raw>${detailEsc(raw || '尚無輸出記錄')}</pre></section>`;
}

// Keep the established detail layout intact while adding usage data supplied by
// the run API.  Values pass through detailEsc even though token values are
// expected numbers, so a malformed API response cannot become markup.
const detailHtmlBase = detailHtml;
detailHtml = function(detail, task = {}, activity = [], artifactText = {}, raw = '') {
  const html = detailHtmlBase(detail, task, activity, artifactText, raw);
  const run = detail?.run || {};
  const total = run.usage;
  const usageText = !total?.available ? '<span class=mut>無資料</span>' : usageLine(total);
  const section = `<section class=detail-section><h3>本次 Run 用量</h3><p>${usageText}</p><p class=mut>API 等值估算，非實際扣費。</p></section>`;
  const marker = '<section class=detail-section><h3>';
  const at = html.lastIndexOf(marker);
  const withTotal = at < 0 ? html + section : html.slice(0, at) + section + html.slice(at);
  let index = 0;
  return withTotal.replace(/(<li class="step [^"]+">[\s\S]*?<\/li>)/g, match => {
    const step = run.steps?.[index++];
    const text = step?.usage?.available ? usageLine(step.usage) : '<span class=mut>無資料</span>';
    return `${match}<div class=mut>用量：${text} · 耗時：${detailEsc(detailDuration(step?.startedAt, step?.endedAt))}</div>`;
  });
};
