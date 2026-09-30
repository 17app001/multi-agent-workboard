(() => {
  const $ = s => document.querySelector(s);
  const modal = $('#sessionModal'), content = $('#sessionContent'), meta = $('#sessionMeta'), title = $('#sessionTitle'), confirm = $('#sessionConfirm');
  const call = async (path, options = {}) => {
    const res = await fetch('/api/session/' + path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };
  const open = () => { modal.hidden = false; };
  const close = () => { modal.hidden = true; confirm.hidden = true; confirm.onclick = null; };
  $('#sessionClose').onclick = close;
  $('#sessionBriefing').onclick = async () => {
    open(); title.textContent = '開工簡報'; meta.textContent = '讀取中…'; content.textContent = '';
    try { const data = await call('briefing'); meta.textContent = `共 ${data.lines.length} 行`; content.textContent = data.lines.map(x => `- ${x}`).join('\n'); }
    catch (e) { meta.textContent = '錯誤'; content.textContent = e.message; }
  };
  $('#sessionWrapup').onclick = async () => {
    open(); title.textContent = '收工預覽'; meta.textContent = '產生草稿中…'; content.textContent = ''; confirm.hidden = true;
    try {
      const data = await call('wrapup', { method: 'POST', body: '{}' });
      meta.textContent = `預定檔名：${data.fileName}（尚未寫入）`; content.textContent = data.markdown; confirm.hidden = false;
      confirm.textContent = '確認寫入'; confirm.onclick = async () => {
        confirm.disabled = true;
        try { const saved = await call('wrapup', { method: 'POST', body: JSON.stringify({ confirm: true }) }); meta.textContent = `已寫入：${saved.writtenFileName}`; content.textContent = saved.markdown; confirm.hidden = true; }
        catch (e) { meta.textContent = '寫入失敗'; content.textContent = e.message; }
        finally { confirm.disabled = false; }
      };
    } catch (e) { meta.textContent = '錯誤'; content.textContent = e.message; }
  };
})();
