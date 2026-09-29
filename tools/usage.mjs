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
// 用本機時區切日期(YYYY-MM-DD)。toISOString() 是 UTC,在 UTC+8 這種機器上,午夜到早上 8 點之間
// 的紀錄會被切到「昨天」,導致「今日」用量算成 0。改用 Date 的 local getter 組字串。
const pad2 = n => String(n).padStart(2, '0');
const day = ts => {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d)) return 'unknown';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const todayLocal = () => day(new Date());
const empty = () => ({ input: 0, output: 0, cached: 0, total: 0 });
// price = {input,cached,output}(每 1M tokens 美金,估算用),跟 collectUsage 的每日費用估算共用同一條公式。
const costOf = (pr, d) => ((d.input * (pr.input || 0)) + (d.cached * (pr.cached || 0)) + (d.output * (pr.output || 0))) / 1e6;

// --- 掃描層:每種 agent 類型各自負責「找出本機 log 裡帶時間戳記的原始用量條目」,
// 回傳 [{ts, input, cached, output}, ...],不做任何依日期/時間範圍的聚合。
// 聚合交給下面兩個呼叫端(byDayFromEntries 依日聚合給 collectUsage、usageInRange 依時間範圍加總),
// 這樣同一套解析邏輯(含所有已知坑的修正)只維護一份,不會日聚合跟範圍聚合各修一次。

// Claude Code: ~/.claude/projects/**/*.jsonl,assistant 訊息帶 message.usage;以 message.id 去重
function claudeEntries(home) {
  const out = [], seen = new Set();
  for (const f of walk(path.join(home, 'projects'), '.jsonl')) for (const l of lines(f)) {
    const o = j(l); const u = o?.message?.usage; if (!u) continue;
    const id = o.message.id + ':' + (o.requestId || ''); if (seen.has(id)) continue; seen.add(id);
    out.push({
      ts: o.timestamp,
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    });
  }
  return out;
}

// Codex: ~/.codex/sessions/**/rollout-*.jsonl,token_count 事件的 total_token_usage 為累計值,取每個檔案最後一筆
function codexEntries(home) {
  const out = [];
  for (const f of walk(path.join(home, 'sessions'), '.jsonl')) {
    let last = null, ts = null;
    for (const l of lines(f)) {
      const o = j(l); const p = o?.payload;
      if (p?.type === 'token_count' && p.info?.total_token_usage) { last = p.info.total_token_usage; ts = o.timestamp; }
    }
    if (!last) continue;
    out.push({
      ts: ts || fs.statSync(f).mtime,
      // 已核對 ~/.codex/sessions 原始資料:total_tokens = input_tokens + output_tokens,
      // reasoning_output_tokens 是 output_tokens 的子集,原本再加一次會重複計算(灌水)。
      // cached_input_tokens 則確認是 input_tokens 的子集,從 input 減掉、另計是對的,不用改。
      input: (last.input_tokens || 0) - (last.cached_input_tokens || 0),
      cached: last.cached_input_tokens || 0,
      output: last.output_tokens || 0,
    });
  }
  return out;
}

// Gemini CLI: ~/.gemini/tmp/*/chats/session-*.jsonl —— 每行一筆 JSON(不是單一 JSON 檔包 messages 陣列,
// 且副檔名是 .jsonl 不是 .json,原本的 walk(home,'.json') 用 endsWith 比對永遠比對不到任何檔案)。
// 第一行是 session meta({sessionId,startTime,...}),之後每行是一筆事件,type:"gemini" 的訊息帶
// tokens:{input,output,cached,thoughts,tool,total}。實測驗證:total === input + output + thoughts + tool
// (cached 不併入 total,代表 input 欄位本身已是「非快取」的新 token 數,不能再減一次 cached)。
// 同一個訊息 id 會因後續補上 toolCalls 而重複出現一行、tokens 值相同,需以 id 去重避免重複計入。
function geminiEntries(home) {
  const out = [], seen = new Set();
  for (const f of walk(path.join(home, 'tmp'), '.jsonl')) {
    if (!f.includes(`${path.sep}chats${path.sep}`)) continue;
    for (const l of lines(f)) {
      const o = j(l); const t = o?.tokens;
      if (!o?.id || !t) continue;
      if (seen.has(o.id)) continue; seen.add(o.id);
      out.push({
        ts: o.timestamp,
        input: t.input || 0,
        cached: t.cached || 0,
        output: (t.output || 0) + (t.thoughts || 0) + (t.tool || 0),
      });
    }
  }
  return out;
}

const entryParsers = { claude: claudeEntries, codex: codexEntries, gemini: geminiEntries };

function byDayFromEntries(entries) {
  const byDay = {};
  for (const e of entries) {
    const d = (byDay[day(e.ts)] ??= empty());
    d.input += e.input; d.cached += e.cached; d.output += e.output;
  }
  return byDay;
}

const parsers = Object.fromEntries(
  Object.entries(entryParsers).map(([type, fn]) => [type, home => byDayFromEntries(fn(home))])
);

export function collectUsage(agents) {
  return agents.map(a => {
    // enabled:false = 使用者主動停用這個 agent(例如 home 目錄還沒建立/不打算用),
    // 不嘗試解析、也不當成錯誤。home 目錄不存在(未設定)本身也不是錯誤,一樣回傳 found:false。
    const enabled = a.enabled !== false;
    const home = expand(a.home);
    const homeExists = enabled && fs.existsSync(home);
    const byDay = homeExists ? parsers[a.type](home) : null;
    const days = Object.entries(byDay || {}).sort().map(([date, v]) => ({ date, ...v, total: v.input + v.cached + v.output }));
    const sum = k => days.reduce((s, d) => s + d[k], 0);
    const pr = a.price || {};
    for (const d of days) d.cost = costOf(pr, d);
    // 用本機時區(不是 UTC)判斷「今天」與「近 7 日」的日期邊界。
    const today = todayLocal();
    const weekAgo = day(Date.now() - 6 * 864e5);
    return {
      id: a.id, label: a.label, type: a.type, found: !!byDay,
      enabled, configured: homeExists,
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

// 給單筆派工任務用的「時間窗用量估算」:對某個 agent(完整設定物件,含 type/home/enabled/price),
// 把它本機 log 裡時間戳落在 [fromMs, toMs] 範圍內的原始條目加總。toMs 省略時用「現在」
// (行程還在跑、還沒有結束時間時,用這個估算目前為止用了多少)。
// 已知限制:這是「同一個 agent 在這段時間內的所有活動」,不是精確的任務歸因——如果使用者在
// 派工的同時手動跟同一個 agent 互動,那部分用量也會被算進來,無法區分。
// agent 停用/home 不存在/type 未知 → 回傳 null(呼叫端不用硬湊出一個假的零值)。
export function usageInRange(agent, fromMs, toMs) {
  if (!agent) return null;
  const enabled = agent.enabled !== false;
  const home = expand(agent.home || '');
  const fn = entryParsers[agent.type];
  if (!enabled || !fn || !home || !fs.existsSync(home)) return null;
  const from = fromMs;
  const to = toMs ?? Date.now();
  const sum = empty();
  for (const e of fn(home)) {
    const t = e.ts ? +new Date(e.ts) : NaN;
    if (Number.isNaN(t) || t < from || t > to) continue;
    sum.input += e.input; sum.cached += e.cached; sum.output += e.output;
  }
  sum.total = sum.input + sum.cached + sum.output;
  sum.costEstimate = costOf(agent.price || {}, sum);
  return sum;
}
