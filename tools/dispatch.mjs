// 用法: node tools/dispatch.mjs <task-id>
// 依任務的 agent 欄位,用對應 CLI 的非互動模式啟動它去做這張任務。輸出寫到 board/runs/<id>-<時間>.log
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runsDir = path.join(root, 'board/runs');
const stateFile = path.join(runsDir, 'state.json');
const expand = p => p.replace(/^~/, os.homedir());

// id -> { pid, log(相對路徑), agent, startedAt, endedAt, status, exitCode, error, live }
// endedAt: 行程結束的時間戳(exit/error/stop 時補上);還在跑(status:'running')時是 null,
// 給用量估算(usageInRange)拿來當時間範圍的結尾——行程還沒結束就用 Date.now() 頂替。
// status: 'running' | 'exited' | 'failed' | 'error' | 'stopped'
// live: 只存在記憶體,不落地。true 表示這個 run 是本次 server 行程親自 spawn 的,
// 掛了 exit/error listener,狀態變化會即時反映;false 表示是從 board/runs/state.json
// 讀回來的紀錄(可能是上一次 server 行程留下的),沒有 listener 可用,狀態需要在
// 查詢時(getRun/stopRun)當場用 isPidRunning() 問一次 OS 才能確認是否還在跑。
//
// 持久化策略:每次 runs 有變動就整份寫回 state.json(不開背景輪詢/定時器,只在
// dispatch/exit/error/stop 這些事件發生、或 API 被呼叫時順手存檔或核對一次)。
const runs = new Map();

function saveState() {
  const obj = {};
  for (const [id, r] of runs) {
    obj[id] = { pid: r.pid, log: r.log, agent: r.agent, startedAt: r.startedAt, endedAt: r.endedAt ?? null, status: r.status, exitCode: r.exitCode, error: r.error };
  }
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(obj, null, 2));
  } catch { /* 落地失敗不影響派工本身,忽略即可 */ }
}

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const [id, r] of Object.entries(obj)) runs.set(id, { ...r, live: false });
  } catch { /* 檔案不存在或損毀,當作沒有任何歷史紀錄 */ }
}
loadState();

// 問 OS 這個 pid 是否還存在(不看記憶體狀態,直接查行程表,server 重啟後
// 靠這個分辨「真的還在跑」跟「其實已經結束但沒人記錄到」)。
export function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false; // pid 來自 state.json/run.json,不信任型別(也避免插進 shell 指令)
  if (process.platform === 'win32') {
    try {
      // 不能用「找不到」訊息的英文字串比對(這台機器 Windows 語系是中文,
      // tasklist 的「查無此工作」訊息是中文,不會出現 "No tasks";已實測撞過
      // 這個坑:比對英文字串會導致所有已結束的行程被誤判成還在跑)。
      // 改成看輸出裡有沒有出現這個 pid 本身當作獨立數字 token:找到時該行會
      // 印出這個 pid;查無此工作的訊息裡不含任何數字,不會誤判。
      const out = execSync(`tasklist /fi "PID eq ${pid}" /nh`, { encoding: 'utf8', windowsHide: true });
      return new RegExp('\\b' + pid + '\\b').test(out);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 對於「不是本次行程親自 spawn」的 running 紀錄(live:false,從 state.json 讀回來的),
// 每次被查詢時當場核對一次 pid 是否還存在,避免重啟後誤判成還在跑。
function refreshRunStatus(run) {
  if (run && run.status === 'running' && !run.live) {
    if (!isPidRunning(run.pid)) {
      run.status = 'exited';
      saveState();
    }
  }
  return run;
}

// --- Windows 上安全啟動 .cmd/.bat CLI(claude/codex/gemini 若用 npm 全域安裝,
// 實際執行檔常常只有 gemini.cmd 這種殼,沒有 .exe)---
//
// 已實測驗證(2026-09-29):
// 1. Node 的 spawn() 在 shell:false 時不會走 PATHEXT 解析:spawn('gemini',...)
//    找不到 gemini.cmd 會直接丟 ENOENT;若把副檔名寫死成 spawn('gemini.cmd',...)
//    甚至會同步丟出 EINVAL 例外(不是透過 'error' 事件)。
// 2. shell:true 可以繞過,但 Node 對此有安全性 deprecation 警告,而且參數只是
//    直接串接、不會逐個 escape,遇到中文/特殊字元會亂碼或整個指令被拆開,不安全。
// 3. 正確做法:自己找出 .cmd 的絕對路徑,透過 cmd.exe /d /s /c 執行,並手動幫
//    每個參數加雙引號、再把整條命令字串整體多包一層引號(cmd.exe 的已知規則:
//    命令字串本身也要被引號包住,否則第一個 token 的引號會被誤判為引用整條字串
//    的邊界),搭配 windowsVerbatimArguments:true 讓 Node 不要再疊加自己的引號。
// 4. 額外發現:這條 cmd.exe 包一層的路徑,如果同時設定 detached:true,子行程
//    (cmd.exe 再往下叫用的 node.exe/實際 CLI)完全收不到我們用 fs.openSync 開的
//    log 檔案 fd,log 檔會永遠是空的(用一個每 0.5 秒印一次時間戳的測試腳本，
//    包成跟 gemini.cmd 完全一樣的殼腳本反覆驗證過:detached:false 時 log 會正常
//    寫入,detached:true 時完全空白)。原因未深究,但兩次獨立測試結果一致,因此
//    .cmd/.bat 這條路徑不使用 detached。直接執行 .exe(claude/codex 在這台機器
//    上都是 .exe)不受影響,維持原本 detached:true 的行為。
//    已知取捨:不 detached 代表如果之後在終端機用 Ctrl+C 關掉 server,派工中的
//    gemini(.cmd 類)行程可能被一起中斷;claude/codex(.exe)不受影響。

function findOnPath(cmd) {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  // 先照 PATHEXT 順序找(這才是 Windows 實際的解析順序)。npm 全域安裝在 Windows
  // 上常常同一個名字裝兩份:一個沒副檔名的 Unix shell shim(給 Git Bash/WSL 用,
  // 內容是 #!/bin/sh,Windows 沒辦法直接執行)、一個 xxx.cmd(真正給 Windows 用的)。
  // 如果先比對「檔名完全一樣、不管副檔名」,會先撞到那個 Unix shim 導致 ENOENT
  // (已實測撞過:agents.json 的 "gemini" 在這台機器上就是這樣,PATH 上 gemini 和
  // gemini.cmd 在同一個資料夾都存在,先比對沒副檔名版本就會選錯)。所以一定要讓
  // 副檔名比對贏過純檔名比對。
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  // 都沒找到才退回試純檔名本身(例如 cmd 本來就帶副檔名,或非 Windows 平台)
  for (const dir of dirs) {
    const exact = path.join(dir, cmd);
    if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
  }
  return null;
}

export function spawnCli(cmd, args, opts) {
  if (process.platform !== 'win32') return spawn(cmd, args, opts);
  const resolved = findOnPath(cmd) || cmd;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const quote = s => '"' + String(s).replace(/"/g, '""') + '"';
    const inner = [quote(resolved), ...args.map(quote)].join(' ');
    const cmdline = '"' + inner + '"';
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdline], {
      ...opts,
      windowsVerbatimArguments: true,
      detached: false, // 見上方說明:這條路徑 detached:true 會讓 log fd 收不到
    });
  }
  return spawn(resolved, args, opts);
}

export function getRun(id) {
  const run = runs.get(id);
  if (!run) return null;
  return refreshRunStatus(run);
}

// 列出目前記憶體 runs 裡狀態是 running 的所有任務(給任務衝突防呆用:要知道
// 「現在有哪些任務正在執行中」才能檢查 files 是否重疊)。會先對每筆紀錄核對一次
// pid 是否還活著(refreshRunStatus),避免把已經結束、只是狀態沒更新的紀錄也算進去。
export function listActiveRuns() {
  const out = [];
  for (const [id, run] of runs) {
    const r = refreshRunStatus(run);
    if (r && r.status === 'running') out.push({ id, pid: r.pid, agent: r.agent, log: r.log, startedAt: r.startedAt });
  }
  return out;
}

// 列出某任務所有派工紀錄的 log 檔(board/runs/<id>-<timestamp>.log),新到舊排序
export function listRuns(id) {
  if (!fs.existsSync(runsDir)) return [];
  const re = new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)\\.log$');
  return fs.readdirSync(runsDir)
    .map(f => { const m = f.match(re); return m ? { file: path.relative(root, path.join(runsDir, f)), ts: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
}

export function readLog(relFile, maxChars = 300000) {
  try {
    const full = path.isAbsolute(relFile) ? relFile : path.join(root, relFile);
    const buf = fs.readFileSync(full, 'utf8');
    if (buf.length > maxChars) return { content: buf.slice(-maxChars), truncated: true };
    return { content: buf, truncated: false };
  } catch (e) {
    return { content: '', truncated: false };
  }
}

function revertToTodo(file, note) {
  try {
    const cur = fs.readFileSync(file, 'utf8');
    if (/^status: doing/m.test(cur)) fs.writeFileSync(file, cur.replace(/^status:.*$/m, 'status: todo') + `\n- ${note}\n`);
  } catch {}
}

export function stopRun(id) {
  const run = runs.get(id);
  if (!run || !run.pid) return Promise.resolve({ ok: false, error: '找不到這個任務目前的執行紀錄(可能是 server 重啟後遺失,或本來就沒在跑)' });
  refreshRunStatus(run); // server 重啟後 run 是從 state.json 讀回來的,先當場核對一次 pid 是否還存在
  if (run.status !== 'running') return Promise.resolve({ ok: false, error: '行程已經結束(狀態: ' + run.status + ')' });
  if (!Number.isInteger(run.pid) || run.pid <= 0) return Promise.resolve({ ok: false, error: '不合法的 pid(需為正整數),不執行 taskkill' });
  return new Promise(resolve => {
    execFile('taskkill', ['/pid', String(run.pid), '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, error: (stderr || err.message || '').trim() || 'taskkill 失敗' }); return; }
      run.status = 'stopped';
      run.endedAt = Date.now();
      saveState();
      const file = path.join(root, 'board/tasks', id + '.md');
      revertToTodo(file, `使用者手動停止 (${new Date().toISOString()})`);
      resolve({ ok: true });
    });
  });
}

// --- Project(board/projects/<id>.json)---
const projectsDir = path.join(root, 'board/projects');
export function getProject(pid) {
  if (!/^[\w-]+$/.test(pid || '')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(projectsDir, pid + '.json'), 'utf8')); } catch { return null; }
}
export function projectValid(p) {
  try { return !!p && typeof p.path === 'string' && path.isAbsolute(p.path) && fs.statSync(p.path).isDirectory(); } catch { return false; }
}
const fmGet = (raw, key) => {
  const fm = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  return fm.match(new RegExp('^' + key + ':[ \t]*(.*)$', 'm'))?.[1].trim() || '';
};

export function dispatch(id) {
  const file = path.join(root, 'board/tasks', id + '.md');
  if (!fs.existsSync(file)) throw new Error('找不到任務 ' + id);
  const raw = fs.readFileSync(file, 'utf8');
  const agentId = raw.match(/^agent:\s*(.+)$/m)?.[1].trim();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents.json'), 'utf8'));
  const agent = cfg.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('任務沒有指派有效的 agent(目前: ' + (agentId || '空') + ')');

  // 有綁定 project 就在 project.path 執行;project 不存在或 path 失效一律拒絕,不退回看板 root。
  const title = fmGet(raw, 'title'), goal = fmGet(raw, 'goal'), acceptance = fmGet(raw, 'acceptance');
  const projectId = fmGet(raw, 'project');
  let cwd = root;
  if (projectId) {
    const proj = getProject(projectId);
    if (!proj) throw new Error(`任務綁定的專案「${projectId}」不存在(board/projects/${projectId}.json 找不到),拒絕派工`);
    if (!projectValid(proj)) throw new Error(`專案「${projectId}」的路徑無效或不存在: ${proj.path},拒絕派工`);
    cwd = proj.path;
  }

  fs.writeFileSync(file, raw.replace(/^status:.*$/m, 'status: doing').replace(/^updated:.*$/m, 'updated: ' + new Date().toISOString().slice(0, 10)));
  let prompt;
  if (projectId) {
    prompt = `你是 agent「${agent.id}」。工作目錄是專案「${projectId}」;若專案內有 AGENTS.md 或 CLAUDE.md 請先閱讀。任務內容如下(標題: ${title}` +
      (goal ? `;目標: ${goal}` : '') + (acceptance ? `;驗收: ${acceptance}` : '') +
      `)。任務檔在看板 repo,絕對路徑: ${file}。完成後請更新該絕對路徑檔案:把 status 改成 review,並在 ## Log 追加結果摘要。不要修改其他 agent 的任務。`;
  } else {
    prompt = `你是 agent「${agent.id}」。先閱讀 AGENTS.md,然後完成 board/tasks/${id}.md 這張任務。` +
      (goal ? `目標: ${goal}。` : '') + (acceptance ? `驗收: ${acceptance}。` : '') +
      `完成後把 status 改成 review,並在該檔 ## Log 追加結果摘要。不要修改其他 agent 的任務。`;
  }

  fs.mkdirSync(runsDir, { recursive: true });
  const log = path.join(runsDir, `${id}-${Date.now()}.log`);
  const relLog = path.relative(root, log);
  const out = fs.openSync(log, 'a');
  const env = { ...process.env };
  if (agent.type === 'codex') env.CODEX_HOME = expand(agent.home);
  if (agent.type === 'claude' && agent.home !== '~/.claude') env.CLAUDE_CONFIG_DIR = expand(agent.home);

  let child;
  try {
    child = spawnCli(agent.cmd, [...(agent.args || []), prompt], { cwd, env, stdio: ['ignore', out, out], detached: true });
  } catch (e) {
    fs.appendFileSync(log, '\n[dispatch] 無法啟動 ' + agent.cmd + ': ' + e.message + '\n');
    revertToTodo(file, `dispatch 失敗(啟動錯誤): ${e.message},見 ${relLog}`);
    runs.set(id, { pid: null, log: relLog, agent: agent.id, startedAt: Date.now(), endedAt: Date.now(), status: 'error', exitCode: null, error: e.message, live: true });
    saveState();
    throw new Error('啟動 ' + agent.cmd + ' 失敗: ' + e.message);
  }

  runs.set(id, { pid: child.pid, log: relLog, agent: agent.id, startedAt: Date.now(), endedAt: null, status: 'running', exitCode: null, error: null, live: true });
  saveState();

  child.on('error', e => {
    fs.appendFileSync(log, '\n[dispatch] 無法啟動 ' + agent.cmd + ': ' + e.message + '\n');
    const run = runs.get(id); if (run) { run.status = 'error'; run.error = e.message; run.endedAt = Date.now(); saveState(); }
    revertToTodo(file, `dispatch 失敗: ${e.message},見 ${relLog}`);
  });
  child.on('exit', code => {
    fs.appendFileSync(log, `\n[dispatch] exit ${code}\n`);
    const run = runs.get(id);
    if (run && run.status === 'running') { run.status = code === 0 ? 'exited' : 'failed'; run.exitCode = code; run.endedAt = Date.now(); saveState(); }
    if (code !== 0) revertToTodo(file, `dispatch 失敗 (exit ${code}),見 ${relLog}`);
  });
  child.unref();
  return { agent: agent.id, log: relLog, pid: child.pid };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(dispatch(process.argv[2])); } catch (e) { console.error(e.message); process.exit(1); }
}
