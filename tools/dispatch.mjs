// 用法: node tools/dispatch.mjs <task-id>
// 依任務的 agent 欄位,用對應 CLI 的非互動模式啟動它去做這張任務。輸出寫到 board/runs/<id>-<時間>.log
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runsDir = path.join(root, 'board/runs');
const expand = p => p.replace(/^~/, os.homedir());

// id -> { pid, log(相對路徑), agent, startedAt, status, exitCode, error }
// status: 'running' | 'exited' | 'failed' | 'error' | 'stopped'
// 只存在記憶體裡,server 重啟就會遺失(重啟後該任務的即時狀態會顯示 unknown,
// 但 log 檔本身還在,仍可讀取內容)。
const runs = new Map();

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

function spawnCli(cmd, args, opts) {
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
  return runs.get(id) || null;
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
  if (run.status !== 'running') return Promise.resolve({ ok: false, error: '行程已經結束(狀態: ' + run.status + ')' });
  return new Promise(resolve => {
    exec(`taskkill /pid ${run.pid} /T /F`, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, error: (stderr || err.message || '').trim() || 'taskkill 失敗' }); return; }
      run.status = 'stopped';
      const file = path.join(root, 'board/tasks', id + '.md');
      revertToTodo(file, `使用者手動停止 (${new Date().toISOString()})`);
      resolve({ ok: true });
    });
  });
}

export function dispatch(id) {
  const file = path.join(root, 'board/tasks', id + '.md');
  if (!fs.existsSync(file)) throw new Error('找不到任務 ' + id);
  const raw = fs.readFileSync(file, 'utf8');
  const agentId = raw.match(/^agent:\s*(.+)$/m)?.[1].trim();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents.json'), 'utf8'));
  const agent = cfg.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('任務沒有指派有效的 agent(目前: ' + (agentId || '空') + ')');

  fs.writeFileSync(file, raw.replace(/^status:.*$/m, 'status: doing').replace(/^updated:.*$/m, 'updated: ' + new Date().toISOString().slice(0, 10)));
  const prompt = `你是 agent「${agent.id}」。先閱讀 AGENTS.md,然後完成 board/tasks/${id}.md 這張任務。` +
    `完成後把 status 改成 review,並在該檔 ## Log 追加結果摘要。不要修改其他 agent 的任務。`;

  fs.mkdirSync(runsDir, { recursive: true });
  const log = path.join(runsDir, `${id}-${Date.now()}.log`);
  const relLog = path.relative(root, log);
  const out = fs.openSync(log, 'a');
  const env = { ...process.env };
  if (agent.type === 'codex') env.CODEX_HOME = expand(agent.home);
  if (agent.type === 'claude' && agent.home !== '~/.claude') env.CLAUDE_CONFIG_DIR = expand(agent.home);

  let child;
  try {
    child = spawnCli(agent.cmd, [...(agent.args || []), prompt], { cwd: root, env, stdio: ['ignore', out, out], detached: true });
  } catch (e) {
    fs.appendFileSync(log, '\n[dispatch] 無法啟動 ' + agent.cmd + ': ' + e.message + '\n');
    revertToTodo(file, `dispatch 失敗(啟動錯誤): ${e.message},見 ${relLog}`);
    runs.set(id, { pid: null, log: relLog, agent: agent.id, startedAt: Date.now(), status: 'error', exitCode: null, error: e.message });
    throw new Error('啟動 ' + agent.cmd + ' 失敗: ' + e.message);
  }

  runs.set(id, { pid: child.pid, log: relLog, agent: agent.id, startedAt: Date.now(), status: 'running', exitCode: null, error: null });

  child.on('error', e => {
    fs.appendFileSync(log, '\n[dispatch] 無法啟動 ' + agent.cmd + ': ' + e.message + '\n');
    const run = runs.get(id); if (run) { run.status = 'error'; run.error = e.message; }
    revertToTodo(file, `dispatch 失敗: ${e.message},見 ${relLog}`);
  });
  child.on('exit', code => {
    fs.appendFileSync(log, `\n[dispatch] exit ${code}\n`);
    const run = runs.get(id);
    if (run && run.status === 'running') { run.status = code === 0 ? 'exited' : 'failed'; run.exitCode = code; }
    if (code !== 0) revertToTodo(file, `dispatch 失敗 (exit ${code}),見 ${relLog}`);
  });
  child.unref();
  return { agent: agent.id, log: relLog, pid: child.pid };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(dispatch(process.argv[2])); } catch (e) { console.error(e.message); process.exit(1); }
}
