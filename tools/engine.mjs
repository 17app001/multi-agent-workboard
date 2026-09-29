// Run 引擎(WP3):pipeline 載入/驗證、run 目錄、step 依序執行、human gate、回修迴圈、停止/重試/續跑。
// 只用 Node 內建模組。引擎只透過 adapters 的 buildCommand / parseLineEvents 與各 CLI 互動,不依 agent type 分支。
//
// Run 目錄(spec §4.5):board/runs/<taskId>/<runId>/{run.json, events.jsonl, artifacts/, raw/<stepId>.log}
// 安全不變式(human gate):有 gate:'human' 的 step 完成後 step.status='awaiting-approval'、run.status='needs-you';
//   只有 approve() 會把它改成 'done' 並前進 cursor。drive() 每次啟動 step 前都會 assertGatesCleared(),
//   任何前置 gate 未核准就丟例外,不會 spawn 任何行程。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAdapter } from './adapters/index.mjs';
import { MODES } from './adapters/_util.mjs';
import { spawnCli, isPidRunning, getProject, projectValid } from './dispatch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runsDir = path.join(root, 'board/runs');
const tasksDir = path.join(root, 'board/tasks');
const pipelinesDir = path.join(root, 'pipelines');
const agentsFile = path.join(root, 'agents.json');

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => new HttpError(status, msg);

const ID_RE = /^[\w-]+$/;
const NAME_RE = /^[\w.-]+$/;
export const safeName = n => typeof n === 'string' && NAME_RE.test(n) && !/^\.+$/.test(n) && !n.includes('..');
const loadAgents = () => JSON.parse(fs.readFileSync(agentsFile, 'utf8')).agents || [];
const now = () => Date.now();

// ---------------------------------------------------------------- pipeline
const WHEN_RE = /^([\w-]+)\.(failed|passed)$/;

// 回傳 { ok, errors[] };agents 為 agents.json 的 agents 陣列
export function validatePipeline(def, agents = []) {
  const errors = [];
  const err = m => errors.push(m);
  if (!def || typeof def !== 'object' || Array.isArray(def)) return { ok: false, errors: ['pipeline 必須是 JSON 物件'] };
  if (typeof def.id !== 'string' || !ID_RE.test(def.id)) err('缺少 id,或 id 不合法(需為 [\\w-]+)');
  if (def.maxRevisions !== undefined && !(Number.isInteger(def.maxRevisions) && def.maxRevisions >= 0 && def.maxRevisions <= 20)) err('maxRevisions 需為 0-20 的整數');
  if (!Array.isArray(def.steps) || def.steps.length === 0) { err('steps 必須是非空陣列'); return { ok: false, errors }; }
  const idx = new Map();
  def.steps.forEach((s, i) => {
    if (s && typeof s.id === 'string' && ID_RE.test(s.id)) {
      if (idx.has(s.id)) err(`step id 重複: "${s.id}"`);
      else idx.set(s.id, i);
    }
  });
  const agentIds = new Map(agents.map(a => [a.id, a]));
  def.steps.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) { err(`steps[${i}] 必須是物件`); return; }
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) { err(`steps[${i}] 缺少 id,或 id 不合法`); return; }
    const L = `step "${s.id}"`;
    const type = s.type === undefined ? 'agent' : s.type;
    if (type !== 'agent' && type !== 'command') err(`${L}: type 只能是 agent 或 command(目前: ${JSON.stringify(s.type)})`);
    if (type === 'command') {
      if (typeof s.command !== 'string' || !s.command.trim()) err(`${L}: command 類 step 必須有 command 字串`);
    } else if (type === 'agent') {
      if (typeof s.agent !== 'string' || !s.agent) err(`${L}: 缺少 agent`);
      else if (s.agent !== '@task') {
        const a = agentIds.get(s.agent);
        if (!a) err(`${L}: 未知 agent "${s.agent}"(agents.json 沒有這個 id;可用: ${[...agentIds.keys()].join(', ')} 或 @task)`);
        else if (!getAdapter(a.type)) err(`${L}: agent "${s.agent}" 的 type "${a.type}" 沒有對應 adapter`);
      }
      if (!MODES.includes(s.mode)) err(`${L}: mode 必須是 ${MODES.join('|')}(目前: ${JSON.stringify(s.mode)})`);
    }
    if (s.input !== undefined && !(Array.isArray(s.input) && s.input.every(safeName))) err(`${L}: input 必須是 artifact 檔名陣列(只允許 [\\w.-]+)`);
    if (s.output !== undefined && !safeName(s.output)) err(`${L}: output 不是合法檔名(只允許 [\\w.-]+)`);
    if (s.gate !== undefined && s.gate !== 'human') err(`${L}: gate 目前只支援 "human"`);
    if (s.timeoutMs !== undefined && !(Number.isFinite(s.timeoutMs) && s.timeoutMs > 0)) err(`${L}: timeoutMs 需為正數`);
    if (s.when !== undefined) {
      const m = typeof s.when === 'string' && s.when.match(WHEN_RE);
      if (!m) err(`${L}: when 格式需為 "<stepId>.failed" 或 "<stepId>.passed"(目前: ${JSON.stringify(s.when)})`);
      else if (!idx.has(m[1])) err(`${L}: when 指向不存在的 step "${m[1]}"`);
      else if (idx.get(m[1]) >= i) err(`${L}: when 只能指向在它之前的 step("${m[1]}")`);
    }
    if (s.loopTo !== undefined) {
      if (typeof s.loopTo !== 'string' || !idx.has(s.loopTo)) err(`${L}: loopTo 指向不存在的 step ${JSON.stringify(s.loopTo)}`);
      else if (idx.get(s.loopTo) >= i) err(`${L}: loopTo 必須指向在它之前的 step("${s.loopTo}")`);
      if (s.when === undefined) err(`${L}: 有 loopTo 的 step 必須有 when 條件(否則會無條件迴圈)`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function loadPipeline(id, agents = loadAgents()) {
  if (!ID_RE.test(id || '')) throw bad(`不合法的 pipeline id: ${id}`);
  const file = path.join(pipelinesDir, id + '.json');
  if (!fs.existsSync(file)) throw bad(`找不到 pipeline「${id}」(pipelines/${id}.json)`);
  let def;
  try { def = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw bad(`pipeline「${id}」JSON 解析失敗: ${e.message}`); }
  const v = validatePipeline(def, agents);
  if (def && def.id !== id) v.errors.push(`檔名是 ${id}.json 但 id 是 ${JSON.stringify(def.id)}`);
  if (v.errors.length) throw bad(`pipeline「${id}」驗證失敗: ` + v.errors.join(';'));
  return { ...def, maxRevisions: def.maxRevisions ?? 3, allowNoGate: !!def.allowNoGate };
}

export function listPipelines() {
  if (!fs.existsSync(pipelinesDir)) return [];
  const agents = loadAgents();
  return fs.readdirSync(pipelinesDir).filter(f => f.endsWith('.json')).map(f => {
    const id = f.replace(/\.json$/, '');
    try { const d = loadPipeline(id, agents); return { id, description: d.description || '', steps: d.steps.map(s => s.id), valid: true }; }
    catch (e) { return { id, valid: false, error: e.message }; }
  });
}
const pipelineExists = id => ID_RE.test(id || '') && fs.existsSync(path.join(pipelinesDir, id + '.json'));

// ---------------------------------------------------------------- task 檔
function readTask(id) {
  const file = path.join(tasksDir, id + '.md');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  for (const l of (m?.[1] || '').split('\n')) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { id, ...meta };
}
function setTaskStatus(taskId, status, note) {
  const file = path.join(tasksDir, taskId + '.md');
  try {
    let raw = fs.readFileSync(file, 'utf8');
    raw = /^status:/m.test(raw) ? raw.replace(/^status:.*$/m, 'status: ' + status) : raw;
    raw = raw.replace(/^updated:.*$/m, 'updated: ' + new Date().toISOString().slice(0, 10));
    if (note) raw += `\n- ${note}\n`;
    fs.writeFileSync(file, raw);
  } catch { /* 任務檔不存在(例如已被刪除)不影響 run */ }
}

// 這張任務(+其 project)該走哪個 pipeline;null = 走舊的單發派工。
// 規則:任務明確寫了 pipeline → 用它(檔案不存在會在 startRun 報錯,不悄悄退回舊路徑);
//       否則 project.defaultPipeline 存在「而且 pipelines/ 裡真的有這個檔」才用,否則舊路徑。
export function resolvePipelineId(taskId) {
  const task = readTask(taskId);
  if (!task) return null;
  if (task.pipeline) return task.pipeline;
  if (task.project) {
    const p = getProject(task.project);
    if (p && p.defaultPipeline && pipelineExists(p.defaultPipeline)) return p.defaultPipeline;
  }
  return null;
}

// ---------------------------------------------------------------- run 檔案
const runPath = (taskId, runId, ...rest) => path.join(runsDir, taskId, runId, ...rest);
const RUNID_RE = /^run-\d+$/;
function saveRun(run) {
  try { fs.writeFileSync(runPath(run.taskId, run.runId, 'run.json'), JSON.stringify(run, null, 2)); } catch { /* 落地失敗不中斷 */ }
}
function listRunIds(taskId) {
  if (!ID_RE.test(taskId)) return [];
  const d = path.join(runsDir, taskId);
  try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && RUNID_RE.test(e.name)).map(e => e.name).sort(); } catch { return []; }
}
function loadRunFile(taskId, runId) {
  try { return JSON.parse(fs.readFileSync(runPath(taskId, runId, 'run.json'), 'utf8')); } catch { return null; }
}
function emit(ctxOrRun, e) {
  const run = ctxOrRun.run || ctxOrRun;
  const line = JSON.stringify({ ts: now(), ...e, runId: run.runId });
  try { fs.appendFileSync(runPath(run.taskId, run.runId, 'events.jsonl'), line + '\n'); } catch { /* ignore */ }
}
const engineEv = (ctx, step, kind, text, extra = {}) => emit(ctx, { kind, step, text, engine: true, ...extra });

// ---------------------------------------------------------------- 記憶體 ctx
const ctxs = new Map(); // taskId -> { run, child, driving, drivePromise, stopping }
function makeCtx(run) { const c = { run, driving: false, drivePromise: null, stopping: false }; ctxs.set(run.taskId, c); return c; }
function getCtx(taskId) {
  if (!ID_RE.test(taskId || '')) return null;
  const c = ctxs.get(taskId);
  if (c) return c;
  const ids = listRunIds(taskId);
  if (!ids.length) return null;
  const run = loadRunFile(taskId, ids[ids.length - 1]);
  return run ? makeCtx(run) : null;
}
const isActive = run => run && (run.status === 'running' || run.status === 'needs-you');

export function getLatestRun(taskId) { const c = getCtx(taskId); return c ? c.run : null; }
export function listActiveRuns() {
  const out = [];
  for (const [id, c] of ctxs) if (c.run.status === 'running') out.push({ id, agent: currentAgent(c.run), startedAt: c.run.startedAt });
  return out;
}
export function hasActiveRun(taskId) { const r = getLatestRun(taskId); return isActive(r); }
function currentAgent(run) { const s = run.steps.find(x => x.status === 'running') || run.steps[Math.min(run.cursor, run.steps.length - 1)]; return s?.agent || null; }

// ---------------------------------------------------------------- 建立 run
export function startRun(taskId, { noGate = false } = {}) {
  if (!ID_RE.test(taskId || '')) throw bad('bad id');
  const task = readTask(taskId);
  if (!task) throw bad('找不到任務 ' + taskId);
  const cur = getLatestRun(taskId);
  if (isActive(cur)) throw bad(`任務 ${taskId} 已有進行中的 run(${cur.runId},狀態 ${cur.status}),同一任務同時只能有一個 active run`, 409);
  const pid = resolvePipelineId(taskId);
  if (!pid) throw bad('這張任務沒有指定 pipeline');
  const agents = loadAgents();
  const def = loadPipeline(pid, agents);
  if (noGate && !def.allowNoGate) throw bad(`pipeline「${pid}」不允許關閉人工核准關卡(noGate)`);

  let cwd = root;
  if (task.project) {
    const proj = getProject(task.project);
    if (!proj) throw bad(`任務綁定的專案「${task.project}」不存在(board/projects/${task.project}.json 找不到),拒絕派工`);
    if (!projectValid(proj)) throw bad(`專案「${task.project}」的路徑無效或不存在: ${proj.path},拒絕派工`);
    cwd = proj.path;
  }
  const steps = def.steps.map(s => {
    const type = s.type || 'agent';
    let agent = null;
    if (type === 'agent') {
      agent = s.agent === '@task' ? task.agent : s.agent;
      if (!agent) throw bad(`step「${s.id}」使用 @task,但任務沒有指派 agent`);
      const a = agents.find(x => x.id === agent);
      if (!a) throw bad(`step「${s.id}」的 agent「${agent}」不存在於 agents.json`);
      if (a.enabled === false) throw bad(`step「${s.id}」的 agent「${agent}」已停用(enabled:false)`);
      if (!getAdapter(a.type)) throw bad(`agent「${agent}」的 type「${a.type}」沒有對應 adapter`);
    }
    return { id: s.id, type, agent, mode: s.mode || null, status: 'pending', attempts: 0, startedAt: null, endedAt: null, exitCode: null, pid: null };
  });
  const runId = 'run-' + now();
  const run = {
    runId, taskId, pipeline: pid, pipelineDef: def, status: 'running', needsYou: null, cursor: 0, revisions: 0,
    noGate: !!noGate, cwd, projectId: task.project || null, startedAt: now(), endedAt: null,
    lastCommandFailed: false, approvalNotes: [], feedback: {}, error: null, steps,
  };
  fs.mkdirSync(runPath(taskId, runId, 'artifacts'), { recursive: true });
  fs.mkdirSync(runPath(taskId, runId, 'raw'), { recursive: true });
  saveRun(run);
  const ctx = makeCtx(run);
  setTaskStatus(taskId, 'running');
  engineEv(ctx, null, 'start', `run ${runId} 開始(pipeline ${pid}${noGate ? ',noGate' : ''})`);
  setImmediate(() => drive(ctx));
  return { runId, pipeline: pid, status: run.status, steps: steps.map(s => s.id) };
}

// ---------------------------------------------------------------- drive:依序執行 step
function idxOfStep(run, id) { return run.steps.findIndex(s => s.id === id); }
function evalWhen(run, when) {
  const m = String(when).match(WHEN_RE);
  if (!m) return false;
  const s = run.steps[idxOfStep(run, m[1])];
  if (!s) return false;
  const failed = s.status === 'failed' || s.verdict === 'FAIL';
  return m[2] === 'failed' ? failed : (s.status === 'done' && !failed);
}
const gateActive = (run, def) => def.gate === 'human' && !run.noGate;
function assertGatesCleared(run, idx) {
  for (let i = 0; i < idx; i++) {
    const d = run.pipelineDef.steps[i], s = run.steps[i];
    if (gateActive(run, d) && s.status !== 'done' && s.status !== 'skipped') {
      throw new Error(`gate 違規:step「${d.id}」的人工核准尚未完成(${s.status}),拒絕啟動「${run.steps[idx].id}」`);
    }
  }
}

function drive(ctx) {
  if (ctx.driving) return ctx.drivePromise;
  ctx.driving = true;
  ctx.drivePromise = (async () => {
    try { await driveLoop(ctx); }
    catch (e) {
      const run = ctx.run;
      run.status = 'failed'; run.error = String(e.message || e); run.endedAt = now(); run.needsYou = null;
      saveRun(run);
      engineEv(ctx, null, 'error', run.error);
      setTaskStatus(run.taskId, 'failed', `run ${run.runId} 失敗: ${run.error}`);
    } finally { ctx.driving = false; }
  })();
  return ctx.drivePromise;
}

function toNeedsYou(ctx, reason, message, step) {
  const run = ctx.run;
  run.status = 'needs-you';
  run.needsYou = { reason, step: step || null, message, since: now() };
  saveRun(run);
  engineEv(ctx, step || null, 'message', `等待你處理:${message}`, { phase: 'needs-you', reason });
  setTaskStatus(run.taskId, 'needs-you', `run ${run.runId} 需要你處理(${reason}): ${message}`);
}
function finishRun(ctx, status, note) {
  const run = ctx.run;
  run.status = status; run.needsYou = null; run.endedAt = now();
  saveRun(run);
  engineEv(ctx, null, 'end', note || status, { exitCode: status === 'completed' ? 0 : 1, phase: 'run-' + status });
  setTaskStatus(run.taskId, status, `run ${run.runId} ${status}${note ? ': ' + note : ''}`);
}

async function driveLoop(ctx) {
  const run = ctx.run;
  while (run.status === 'running') {
    const idx = run.cursor;
    if (idx >= run.steps.length) { finishRun(ctx, 'completed'); return; }
    const def = run.pipelineDef.steps[idx];
    const st = run.steps[idx];

    if (st.status !== 'running') { // 'running' = server 重啟後接手
      if (def.when && !evalWhen(run, def.when)) { st.status = 'skipped'; run.cursor++; saveRun(run); engineEv(ctx, def.id, 'message', `略過(條件 ${def.when} 不成立)`); continue; }
      if (def.loopTo && run.revisions >= run.pipelineDef.maxRevisions) {
        toNeedsYou(ctx, 'revision-limit', `回修已達上限 ${run.pipelineDef.maxRevisions} 次仍未通過審查`, def.id);
        return;
      }
    }
    assertGatesCleared(run, idx);

    const resume = st.status === 'running';
    const out = def.type === 'command' || st.type === 'command' ? await runCommandStep(ctx, idx, resume) : await runAgentStep(ctx, idx, resume);
    if (ctx.stopping) {
      st.status = 'stopped'; st.endedAt = now(); ctx.stopping = false; saveRun(run);
      finishRun(ctx, 'cancelled', '使用者停止');
      return;
    }
    if (out.kind === 'failed') {
      st.status = 'failed'; st.endedAt = now(); saveRun(run);
      engineEv(ctx, def.id, 'error', out.message);
      // command(測試)失敗:若後面還有 review step,交給 review/回修處理;否則 run 失敗
      const laterReview = run.pipelineDef.steps.some((d, i) => i > idx && d.mode === 'review');
      if (st.type === 'command' && laterReview) { run.lastCommandFailed = true; run.cursor++; saveRun(run); continue; }
      run.error = out.message;
      finishRun(ctx, 'failed', out.message);
      return;
    }
    if (out.kind === 'needs-you') {
      st.status = 'blocked'; st.endedAt = now(); saveRun(run);
      toNeedsYou(ctx, out.reason, out.message, def.id);
      return;
    }
    // done
    st.status = 'done'; st.endedAt = now();
    if (st.type === 'command') run.lastCommandFailed = false;
    if (def.mode === 'review') {
      let v = out.verdict;
      if (v === 'PASS' && run.lastCommandFailed) { v = 'FAIL'; engineEv(ctx, def.id, 'error', '審查回 PASS,但測試指令失敗,判為 FAIL'); }
      st.verdict = v;
    }
    saveRun(run);
    if (def.loopTo) {
      run.revisions++;
      const to = idxOfStep(run, def.loopTo);
      for (let i = to; i <= idx; i++) { run.steps[i].status = 'pending'; run.steps[i].verdict = undefined; run.steps[i].pid = null; }
      run.cursor = to;
      saveRun(run);
      engineEv(ctx, def.id, 'message', `回修 #${run.revisions},回到 step「${def.loopTo}」`, { phase: 'revision', revisions: run.revisions });
      continue;
    }
    if (gateActive(run, def)) {
      st.status = 'awaiting-approval';
      saveRun(run);
      toNeedsYou(ctx, 'approval', `step「${def.id}」已完成,需要你核准(或退回並附意見)後才會繼續`, def.id);
      return;
    }
    run.cursor = idx + 1;
    saveRun(run);
  }
}

// ---------------------------------------------------------------- 行程等待(agent 與 command 共用)
export function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve({ ok: false, error: '沒有 pid' });
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, (err, so, se) => {
        if (err && isPidRunning(pid)) resolve({ ok: false, error: (se || err.message || '').trim() || 'taskkill 失敗' });
        else resolve({ ok: true }); // 不比對輸出文字(中文系統);行程已不在也視為成功
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已不存在 */ } }
      resolve({ ok: !isPidRunning(pid) });
    }
  });
}

// child 為 null 時(server 重啟後接手)以 pid 存活檢查判斷結束。tick 每 200ms 與結束時各呼叫一次。
function waitProcess({ child, pid, timeoutMs, tick }) {
  return new Promise(resolve => {
    let done = false, exitCode = null, error = null, timedOut = false;
    let iv, to;
    const finish = () => {
      if (done) return; done = true;
      clearInterval(iv); clearTimeout(to);
      try { tick(true); } catch { /* ignore */ }
      resolve({ exitCode, error, timedOut });
    };
    iv = setInterval(() => { try { tick(false); } catch { /* ignore */ } if (!child && !isPidRunning(pid)) finish(); }, 200);
    if (timeoutMs) to = setTimeout(() => { timedOut = true; killTree(pid); }, timeoutMs);
    if (child) {
      child.on('error', e => { error = e.message; finish(); });
      child.on('exit', code => { exitCode = code; finish(); });
    }
  });
}

// ---------------------------------------------------------------- prompt
const DISCIPLINE = {
  plan: '本步驟為【計畫模式(唯讀)】:不得修改、建立或刪除任何檔案,也不要執行會改動專案的指令。請以 Markdown 輸出完整計畫作為你的最後一則回覆(引擎會把它存成 {OUT}),內容包含:1. 目標理解 2. 預計動到的檔案 3. 實作步驟 4. 風險與注意事項 5. 如何驗證。計畫經人核准後才會有 agent 動手。',
  execute: '本步驟為【執行模式】:依輸入文件(計畫/審查意見)實作,只做被核准範圍內的事;完成後用簡短文字回報改了哪些檔案與結果。不要修改看板的任務檔(board/tasks)。若某個動作被權限拒絕,不要繞過,直接在回覆中說明。',
  review: '本步驟為【審查模式(唯讀)】:不得修改任何檔案。請對照任務的目標、驗收條件、計畫與測試結果審查實作(可自行用 git status / git diff 檢視變更)。你的回覆第一行必須且只能是 `VERDICT: PASS` 或 `VERDICT: FAIL`,其後條列具體理由;FAIL 時列出必須修正的項目。',
};
const MAX_INPUT_CHARS = 40000;
function readArtifact(run, name) {
  try {
    const t = fs.readFileSync(runPath(run.taskId, run.runId, 'artifacts', name), 'utf8');
    return t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) + `\n...(已截斷,原長 ${t.length} 字元)` : t;
  } catch { return null; }
}
export function buildPrompt(run, def, st, task) {
  const P = [];
  P.push(`你是 agent「${st.agent}」,正在執行 pipeline「${run.pipeline}」的步驟「${def.id}」(mode: ${def.mode})。`);
  P.push(`工作目錄: ${run.cwd}。若專案內有 AGENTS.md 或 CLAUDE.md 請先閱讀並遵守。`);
  const acc = String(task.acceptance || '').split(';').map(s => s.trim()).filter(Boolean);
  P.push(['## 任務', `標題: ${task.title || task.id}`, `目標: ${task.goal || '(未填,請依標題判斷)'}`,
    acc.length ? '驗收條件:\n' + acc.map(a => '- ' + a).join('\n') : '驗收條件: (未填)'].join('\n'));
  const inputs = (def.input || []).map(n => ({ n, t: readArtifact(run, n) }));
  if (inputs.length) {
    P.push('## 輸入文件(上一步的產出,請以此為準)\n' + inputs.map(({ n, t }) => `### ${n}\n${t === null ? '(尚未產生)' : t}`).join('\n\n'));
  }
  const fb = run.feedback[def.id] || [];
  if (fb.length) {
    const prev = def.output ? readArtifact(run, def.output) : null;
    P.push('## 人工退回意見(必須處理)\n' + (prev ? `上一版 ${def.output}(被退回):\n${prev}\n\n` : '') + fb.map((t, i) => `意見 ${i + 1}: ${t}`).join('\n'));
  }
  if (run.approvalNotes.length && def.mode === 'execute') P.push('## 核准時的補充意見\n' + run.approvalNotes.map(n => `- ${n.note}`).join('\n'));
  P.push('## 本步驟紀律\n' + DISCIPLINE[def.mode].replace('{OUT}', def.output || '文件'));
  return P.join('\n\n');
}

// ---------------------------------------------------------------- 讀 raw log → 事件
function tailRaw(ctx, st, def, adapter, rawFile, flush) {
  let size;
  try { size = fs.statSync(rawFile).size; } catch { return; }
  if (size <= st.tailOffset) return;
  const len = size - st.tailOffset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(rawFile, 'r');
  try { fs.readSync(fd, buf, 0, len, st.tailOffset); } finally { fs.closeSync(fd); }
  let end = buf.lastIndexOf(0x0a) + 1;
  if (flush) end = len; // 結束時把最後沒有換行的殘行也處理
  if (end === 0) return;
  const text = buf.subarray(0, end).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evs = [];
    try { evs = adapter.parseLineEvents(line.replace(/\r$/, '')) || []; } catch { evs = []; }
    for (const e of evs) emit(ctx, { ...e, step: def.id });
  }
  st.tailOffset += end;
  saveRun(ctx.run);
}
function analyzeRaw(adapter, rawFile, from) {
  const r = { lastMessage: null, endText: null, needsHuman: [], endExit: null };
  let text = '';
  try { const b = fs.readFileSync(rawFile); text = b.subarray(from || 0).toString('utf8'); } catch { return r; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evs = [];
    try { evs = adapter.parseLineEvents(line.replace(/\r$/, '')) || []; } catch { evs = []; }
    for (const e of evs) {
      if (e.kind === 'message' && e.text) r.lastMessage = e.text;
      if (e.kind === 'end') { r.endExit = e.exitCode ?? null; if (typeof e.text === 'string' && e.text) r.endText = e.text; }
      if (e.needsHuman) r.needsHuman.push(e.text || '');
    }
  }
  return r;
}
export function parseVerdict(text) {
  const first = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const m = first.replace(/^[*_`#>\s]+/, '').match(/^VERDICT:\s*(PASS|FAIL)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------- agent step
async function runAgentStep(ctx, idx, resume) {
  const run = ctx.run, def = run.pipelineDef.steps[idx], st = run.steps[idx];
  const agentCfg = loadAgents().find(a => a.id === st.agent);
  const adapter = agentCfg && getAdapter(agentCfg.type);
  if (!adapter) return { kind: 'failed', message: `agent「${st.agent}」找不到或沒有 adapter` };
  const rawFile = runPath(run.taskId, run.runId, 'raw', def.id + '.log');
  let child = null;
  if (!resume) {
    const task = readTask(run.taskId) || { id: run.taskId };
    const prompt = buildPrompt(run, def, st, task);
    st.attempts = (st.attempts || 0) + 1;
    st.status = 'running'; st.startedAt = now(); st.endedAt = null; st.exitCode = null; st.blocked = null; st.pid = null;
    let size = 0; try { size = fs.statSync(rawFile).size; } catch { /* 新檔 */ }
    fs.appendFileSync(rawFile, `${size ? '\n' : ''}===== step ${def.id} (${st.agent}) attempt ${st.attempts} @ ${new Date().toISOString()} =====\n`);
    st.rawStart = fs.statSync(rawFile).size; st.tailOffset = st.rawStart;
    try { fs.writeFileSync(runPath(run.taskId, run.runId, 'raw', def.id + '.prompt.md'), prompt); } catch { /* ignore */ }
    saveRun(run);
    engineEv(ctx, def.id, 'start', `step ${def.id} 開始(${st.agent}, ${def.mode})`);
    try {
      const built = adapter.buildCommand({ mode: def.mode, prompt, cwd: run.cwd, agentCfg });
      const fd = fs.openSync(rawFile, 'a');
      try {
        child = spawnCli(built.cmd, [...(agentCfg.cmdPrefix || []), ...built.args], {
          cwd: run.cwd, env: { ...process.env, ...(built.env || {}) }, stdio: ['ignore', fd, fd], detached: true, windowsHide: true,
        });
      } finally { fs.closeSync(fd); }
    } catch (e) {
      fs.appendFileSync(rawFile, `\n[engine] 無法啟動: ${e.message}\n`);
      return { kind: 'failed', message: `無法啟動 ${agentCfg.cmd}: ${e.message}` };
    }
    ctx.child = child;
    st.pid = child.pid; saveRun(run);
    child.unref();
  }
  const res = await waitProcess({ child, pid: st.pid, timeoutMs: def.timeoutMs, tick: flush => tailRaw(ctx, st, def, adapter, rawFile, flush) });
  ctx.child = null;
  st.exitCode = res.exitCode;
  fs.appendFileSync(rawFile, `\n[engine] exit ${res.exitCode}${res.timedOut ? ' (逾時)' : ''}${res.error ? ' error: ' + res.error : ''}\n`);
  if (ctx.stopping) return { kind: 'stopped' };
  const an = analyzeRaw(adapter, rawFile, st.rawStart);
  if (res.timedOut) return { kind: 'needs-you', reason: 'timeout', message: `step「${def.id}」超過 ${def.timeoutMs}ms 未結束,已終止` };
  if (res.error) return { kind: 'failed', message: `行程錯誤: ${res.error}` };
  const code = res.exitCode ?? an.endExit; // 接手模式拿不到 exit code,用 adapter 的 end 事件推斷
  if (def.mode === 'execute' && an.needsHuman.length) {
    st.blocked = an.needsHuman.slice(0, 3);
    return { kind: 'needs-you', reason: 'permission', message: `step「${def.id}」執行時遇到權限被拒/需要人工:${an.needsHuman[0]}` };
  }
  if (code !== 0) return { kind: 'failed', message: `agent 結束碼 ${code === null ? '未知' : code}` };
  const out = { kind: 'done' };
  if (def.output) {
    const text = an.lastMessage || an.endText;
    if (!text) return { kind: 'failed', message: `agent 沒有產生可存成 ${def.output} 的回覆文字` };
    fs.writeFileSync(runPath(run.taskId, run.runId, 'artifacts', def.output), text);
    engineEv(ctx, def.id, 'message', `已存 artifact ${def.output}(${text.length} 字元)`, { phase: 'artifact', file: def.output });
    if (def.mode === 'review') {
      out.verdict = parseVerdict(text);
      if (!out.verdict) { out.verdict = 'FAIL'; engineEv(ctx, def.id, 'error', `${def.output} 首行解析不到 VERDICT: PASS|FAIL,視為 FAIL`); }
      else engineEv(ctx, def.id, 'message', `審查結論 ${out.verdict}`, { phase: 'verdict', verdict: out.verdict });
    }
  } else if (def.mode === 'review') {
    out.verdict = parseVerdict(an.lastMessage || an.endText);
    if (!out.verdict) { out.verdict = 'FAIL'; engineEv(ctx, def.id, 'error', '審查回覆首行解析不到 VERDICT,視為 FAIL'); }
  }
  return out;
}

// ---------------------------------------------------------------- command step(測試等)
async function runCommandStep(ctx, idx, resume) {
  const run = ctx.run, def = run.pipelineDef.steps[idx], st = run.steps[idx];
  const file = runPath(run.taskId, run.runId, 'artifacts', def.output || def.id + '.txt');
  let child = null;
  if (!resume) {
    st.attempts = (st.attempts || 0) + 1;
    st.status = 'running'; st.startedAt = now(); st.endedAt = null; st.exitCode = null; st.pid = null;
    fs.writeFileSync(file, `$ ${def.command}\n(cwd: ${run.cwd})\n\n`);
    saveRun(run);
    engineEv(ctx, def.id, 'start', `step ${def.id} 開始(command: ${def.command})`);
    try {
      const fd = fs.openSync(file, 'a');
      try { child = spawn(def.command, { shell: true, cwd: run.cwd, stdio: ['ignore', fd, fd], windowsHide: true }); }
      finally { fs.closeSync(fd); }
    } catch (e) { return { kind: 'failed', message: `無法執行指令: ${e.message}` }; }
    ctx.child = child;
    st.pid = child.pid; saveRun(run);
    child.unref();
  }
  const res = await waitProcess({ child, pid: st.pid, timeoutMs: def.timeoutMs, tick: () => {} });
  ctx.child = null;
  st.exitCode = res.exitCode;
  fs.appendFileSync(file, `\n[exit ${res.exitCode === null ? 'unknown' : res.exitCode}]${res.timedOut ? ' (逾時被終止)' : ''}\n`);
  emit(ctx, { kind: 'test', step: def.id, text: def.command, exitCode: res.exitCode, engine: true });
  if (ctx.stopping) return { kind: 'stopped' };
  if (res.timedOut) return { kind: 'needs-you', reason: 'timeout', message: `指令「${def.command}」超過 ${def.timeoutMs}ms 未結束,已終止` };
  if (res.error) return { kind: 'failed', message: `指令錯誤: ${res.error}` };
  if (res.exitCode !== 0) return { kind: 'failed', message: `指令結束碼 ${res.exitCode === null ? '未知(server 重啟後接手,視為失敗)' : res.exitCode}` };
  return { kind: 'done' };
}

// ---------------------------------------------------------------- 使用者動作
function needCtx(taskId) {
  const c = getCtx(taskId);
  if (!c) throw bad(`任務 ${taskId} 沒有 run`, 404);
  return c;
}
function summary(run) { return { runId: run.runId, status: run.status, needsYou: run.needsYou, cursor: run.cursor, revisions: run.revisions }; }

export function approve(taskId, note) {
  const ctx = needCtx(taskId), run = ctx.run;
  if (run.status !== 'needs-you' || run.needsYou?.reason !== 'approval') throw bad(`目前沒有等待核准的計畫(run 狀態 ${run.status}${run.needsYou ? '/' + run.needsYou.reason : ''})`, 409);
  const idx = run.cursor, st = run.steps[idx];
  if (st.status !== 'awaiting-approval') throw bad(`step「${st.id}」不在等待核准狀態(${st.status})`, 409);
  st.status = 'done'; st.approvedAt = now();
  if (note && String(note).trim()) run.approvalNotes.push({ step: st.id, note: String(note).trim(), ts: now() });
  run.cursor = idx + 1; run.status = 'running'; run.needsYou = null;
  saveRun(run);
  engineEv(ctx, st.id, 'message', '已核准' + (note ? `(附註: ${note})` : ''), { phase: 'approved' });
  setTaskStatus(taskId, 'running', `計畫已核准 (${new Date().toISOString()})`);
  drive(ctx);
  return summary(run);
}

export function reject(taskId, feedback) {
  const text = String(feedback || '').trim();
  if (!text) throw bad('退回必須附上意見(feedback)');
  const ctx = needCtx(taskId), run = ctx.run;
  if (run.status !== 'needs-you' || run.needsYou?.reason !== 'approval') throw bad(`目前沒有等待核准的計畫(run 狀態 ${run.status})`, 409);
  const idx = run.cursor, st = run.steps[idx], def = run.pipelineDef.steps[idx];
  (run.feedback[def.id] ||= []).push(text);
  st.status = 'pending'; st.endedAt = null;
  run.status = 'running'; run.needsYou = null;
  saveRun(run);
  engineEv(ctx, def.id, 'message', `已退回,意見: ${text}`, { phase: 'rejected' });
  setTaskStatus(taskId, 'running', `計畫被退回並附意見,重新產出 (${new Date().toISOString()})`);
  drive(ctx);
  return summary(run);
}

export async function stopRun(taskId) {
  const ctx = getCtx(taskId);
  if (!ctx || !isActive(ctx.run)) return { ok: false, error: '這個任務目前沒有進行中的 run' };
  const run = ctx.run;
  if (run.status === 'needs-you') {
    const st = run.steps[run.cursor]; if (st && st.status !== 'done') { st.status = 'stopped'; st.endedAt = now(); }
    finishRun(ctx, 'cancelled', '使用者停止(等待中)');
    return { ok: true, status: run.status };
  }
  const st = run.steps.find(s => s.status === 'running');
  ctx.stopping = true;
  if (st && st.pid) {
    const k = await killTree(st.pid);
    if (!k.ok) { ctx.stopping = false; return { ok: false, error: k.error }; }
  }
  if (ctx.driving) {
    await Promise.race([ctx.drivePromise, new Promise(r => setTimeout(r, 8000))]);
  }
  if (run.status === 'running') { // 沒有 driver 在接(異常情形):直接標記
    if (st) { st.status = 'stopped'; st.endedAt = now(); }
    ctx.stopping = false;
    finishRun(ctx, 'cancelled', '使用者停止');
  }
  return { ok: true, status: run.status };
}

// 從失敗/被停止的 step 重跑(同一個 run)
export function retry(taskId) {
  const ctx = needCtx(taskId), run = ctx.run;
  if (run.status === 'running') throw bad('run 仍在進行中', 409);
  if (run.status === 'needs-you') throw bad('run 正在等你處理,請用 approve/reject/resolve', 409);
  if (run.status === 'completed') throw bad('run 已完成,沒有需要重試的 step');
  const st = run.steps[Math.min(run.cursor, run.steps.length - 1)];
  st.status = 'pending'; st.pid = null; st.endedAt = null;
  run.status = 'running'; run.error = null; run.endedAt = null; run.needsYou = null;
  ctx.stopping = false;
  saveRun(run);
  engineEv(ctx, st.id, 'message', `重試 step「${st.id}」`, { phase: 'retry' });
  setTaskStatus(taskId, 'running', `重試 step ${st.id} (${new Date().toISOString()})`);
  drive(ctx);
  return summary(run);
}

// needs-you(核准以外的原因:回修上限/權限/逾時)的最簡處理:retry | complete | abort
export function resolveRun(taskId, action) {
  const ctx = needCtx(taskId), run = ctx.run;
  if (run.status !== 'needs-you' || run.needsYou?.reason === 'approval') throw bad('目前不是需要 resolve 的狀態(核准請用 approve/reject)', 409);
  if (action === 'retry') {
    const st = run.steps[run.cursor];
    if (run.needsYou.reason === 'revision-limit') run.revisions = 0;
    st.status = 'pending'; st.pid = null; st.endedAt = null;
    run.status = 'running'; run.needsYou = null; saveRun(run);
    engineEv(ctx, st.id, 'message', `resolve: retry(${st.id})`, { phase: 'resolve' });
    setTaskStatus(taskId, 'running', `使用者選擇再試一次 (${new Date().toISOString()})`);
    drive(ctx);
  } else if (action === 'complete') {
    finishRun(ctx, 'completed', '使用者選擇忽略問題並完成');
  } else if (action === 'abort') {
    finishRun(ctx, 'cancelled', '使用者選擇中止');
  } else throw bad("action 必須是 'retry' | 'complete' | 'abort'");
  return summary(run);
}

// ---------------------------------------------------------------- 讀取 API
export function listArtifacts(taskId) {
  const run = getLatestRun(taskId); if (!run) return [];
  const d = runPath(taskId, run.runId, 'artifacts');
  try { return fs.readdirSync(d).map(name => { const s = fs.statSync(path.join(d, name)); return { name, size: s.size, mtime: s.mtimeMs }; }); } catch { return []; }
}
export function readArtifactFile(taskId, name) {
  if (!safeName(name)) throw bad('artifact 名稱不合法(只允許 [\\w.-]+)');
  const run = getLatestRun(taskId); if (!run) throw bad('找不到 run', 404);
  const dir = runPath(taskId, run.runId, 'artifacts');
  const f = path.join(dir, name);
  if (path.dirname(f) !== dir) throw bad('artifact 名稱不合法');
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw bad('找不到 artifact ' + name, 404);
  return fs.readFileSync(f, 'utf8');
}
export function readEvents(taskId, since = 0) {
  const run = getLatestRun(taskId); if (!run) return [];
  let raw = '';
  try { raw = fs.readFileSync(runPath(taskId, run.runId, 'events.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* 壞行略過 */ } }
  return out.slice(Math.max(0, Number(since) || 0));
}
export function runDetail(taskId) {
  const run = getLatestRun(taskId);
  if (!run) return null;
  return { run, artifacts: listArtifacts(taskId), runs: listRunIds(taskId) };
}

// 給 /api/tasks/:id/log 相容用:回傳跟舊格式相近的內容(各 step raw log 串接)
const LEGACY_STATUS = { running: 'running', 'needs-you': 'needs-you', completed: 'exited', failed: 'failed', cancelled: 'stopped' };
export function logView(taskId, maxChars = 300000) {
  const run = getLatestRun(taskId);
  if (!run) return null;
  let content = '';
  for (const s of run.steps) {
    const f = runPath(taskId, run.runId, 'raw', s.id + '.log');
    if (fs.existsSync(f)) content += `\n########## step ${s.id} (${s.agent || 'command'}) [${s.status}] ##########\n` + fs.readFileSync(f, 'utf8');
    else if (s.type === 'command') {
      const a = runPath(taskId, run.runId, 'artifacts', run.pipelineDef.steps.find(d => d.id === s.id)?.output || s.id + '.txt');
      if (fs.existsSync(a)) content += `\n########## step ${s.id} (command) [${s.status}] ##########\n` + fs.readFileSync(a, 'utf8');
    }
  }
  const truncated = content.length > maxChars;
  const runningStep = run.steps.find(s => s.status === 'running');
  return {
    status: LEGACY_STATUS[run.status] || run.status,
    agent: currentAgent(run), pid: runningStep?.pid ?? null,
    exitCode: run.status === 'completed' ? 0 : (run.status === 'failed' ? 1 : null),
    log: path.relative(root, runPath(taskId, run.runId, 'run.json')),
    content: truncated ? content.slice(-maxChars) : content, truncated,
    runs: listRunIds(taskId).map(id => path.relative(root, runPath(taskId, id, 'run.json'))),
    startedAt: run.startedAt, endedAt: run.endedAt, runId: run.runId, runStatus: run.status, needsYou: run.needsYou,
  };
}
export const latestRunStartedAt = taskId => getLatestRun(taskId)?.startedAt ?? null;

// ---------------------------------------------------------------- server 啟動時:接手 running 的 run
// needs-you / 完成 / 失敗的 run 不需要行程,不在這裡處理(API 被呼叫時才從檔案載入)。
export function init() {
  let dirs = [];
  try { dirs = fs.readdirSync(runsDir, { withFileTypes: true }).filter(e => e.isDirectory() && ID_RE.test(e.name)).map(e => e.name); } catch { return; }
  for (const taskId of dirs) {
    const ids = listRunIds(taskId);
    if (!ids.length) continue;
    const run = loadRunFile(taskId, ids[ids.length - 1]);
    if (!run || run.status !== 'running') continue;
    const ctx = makeCtx(run);
    engineEv(ctx, null, 'message', 'server 重啟,接手進行中的 run', { phase: 'recover' });
    drive(ctx);
  }
}
