// 從各 CLI 的本機 log 統計 token 用量。格式可能隨版本變動,解析盡量寬鬆。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const expand = p => p.replace(/^~/, os.homedir());
function* walk(dir, ext) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f, ext);
    else if (f.endsWith(ext)) yield f;
  }
}
const lines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const j = s => { try { return JSON.parse(s); } catch { return null; } };
const day = ts => (ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown');
const empty = () => ({ input: 0, output: 0, cached: 0, total: 0 });

// Claude Code: ~/.claude/projects/**/*.jsonl,assistant 訊息帶 message.usage;以 message.id 去重
function claude(home) {
  const byDay = {}, seen = new Set();
  for (const f of walk(path.join(home, 'projects'), '.jsonl')) for (const l of lines(f)) {
    const o = j(l); const u = o?.message?.usage; if (!u) continue;
    const id = o.message.id + ':' + (o.requestId || ''); if (seen.has(id)) continue; seen.add(id);
    const d = (byDay[day(o.timestamp)] ??= empty());
    d.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    d.cached += u.cache_read_input_tokens || 0;
    d.output += u.output_tokens || 0;
  }
  return byDay;
}

// Codex: ~/.codex/sessions/**/rollout-*.jsonl,token_count 事件的 total_token_usage 為累計值,取每個檔案最後一筆
function codex(home) {
  const byDay = {};
  for (const f of walk(path.join(home, 'sessions'), '.jsonl')) {
    let last = null, ts = null;
    for (const l of lines(f)) {
      const o = j(l); const p = o?.payload;
      if (p?.type === 'token_count' && p.info?.total_token_usage) { last = p.info.total_token_usage; ts = o.timestamp; }
    }
    if (!last) continue;
    const d = (byDay[day(ts || fs.statSync(f).mtime)] ??= empty());
    // 已核對 ~/.codex/sessions 原始資料:total_tokens = input_tokens + output_tokens,
    // reasoning_output_tokens 是 output_tokens 的子集,原本再加一次會重複計算(灌水)。
    // cached_input_tokens 則確認是 input_tokens 的子集,從 input 減掉、另計是對的,不用改。
    d.input += (last.input_tokens || 0) - (last.cached_input_tokens || 0);
    d.cached += last.cached_input_tokens || 0;
    d.output += last.output_tokens || 0;
  }
  return byDay;
}

// Gemini CLI: ~/.gemini/tmp/*/chats/session-*.jsonl —— 每行一筆 JSON(不是單一 JSON 檔包 messages 陣列,
// 且副檔名是 .jsonl 不是 .json,原本的 walk(home,'.json') 用 endsWith 比對永遠比對不到任何檔案)。
// 第一行是 session meta({sessionId,startTime,...}),之後每行是一筆事件,type:"gemini" 的訊息帶
// tokens:{input,output,cached,thoughts,tool,total}。實測驗證:total === input + output + thoughts + tool
// (cached 不併入 total,代表 input 欄位本身已是「非快取」的新 token 數,不能再減一次 cached)。
// 同一個訊息 id 會因後續補上 toolCalls 而重複出現一行、tokens 值相同,需以 id 去重避免重複計入。
function gemini(home) {
  const byDay = {}, seen = new Set();
  for (const f of walk(path.join(home, 'tmp'), '.jsonl')) {
    if (!f.includes(`${path.sep}chats${path.sep}`)) continue;
    for (const l of lines(f)) {
      const o = j(l); const t = o?.tokens;
      if (!o?.id || !t) continue;
      if (seen.has(o.id)) continue; seen.add(o.id);
      const d = (byDay[day(o.timestamp)] ??= empty());
      d.input += t.input || 0;
      d.cached += t.cached || 0;
      d.output += (t.output || 0) + (t.thoughts || 0) + (t.tool || 0);
    }
  }
  return byDay;
}

const parsers = { claude, codex, gemini };

export function collectUsage(agents) {
  return agents.map(a => {
    const home = expand(a.home);
    const byDay = fs.existsSync(home) ? parsers[a.type](home) : null;
    const days = Object.entries(byDay || {}).sort().map(([date, v]) => ({ date, ...v, total: v.input + v.cached + v.output }));
    const sum = k => days.reduce((s, d) => s + d[k], 0);
    const pr = a.price || {};
    const cost = d => ((d.input * (pr.input || 0)) + (d.cached * (pr.cached || 0)) + (d.output * (pr.output || 0))) / 1e6;
    for (const d of days) d.cost = cost(d);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    return {
      id: a.id, label: a.label, type: a.type, found: !!byDay,
      today: days.filter(d => d.date === today).reduce((s, d) => s + d.total, 0),
      week: days.filter(d => d.date >= weekAgo).reduce((s, d) => s + d.total, 0),
      costToday: days.filter(d => d.date === today).reduce((s, d) => s + d.cost, 0),
      costWeek: days.filter(d => d.date >= weekAgo).reduce((s, d) => s + d.cost, 0),
      costTotal: days.reduce((s, d) => s + d.cost, 0),
      total: sum('total'), input: sum('input'), cached: sum('cached'), output: sum('output'),
      days: days.slice(-14),
    };
  });
}
