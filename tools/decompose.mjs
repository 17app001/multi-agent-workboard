// 需求自動拆解(WP14):容錯解析、嚴格欄位型別驗證、長度限制、循環依賴檢查、安全建卡。
// 只用 Node 內建模組,零依賴。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTasksDir = path.join(root, 'board/tasks');

export class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const bad = (msg, status = 400) => new HttpError(status, msg);

// frontmatter scalar 一律壓成單行:\r、\n(以及 JS 視為行界的 U+2028/2029)換成空白
const oneLine = v => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

// 容錯提取 JSON 陣列:支援直接 JSON、Markdown 程式碼區塊、外層中括號尋找
export function extractJsonArray(text) {
  if (Array.isArray(text)) return text;
  if (typeof text !== 'string' || !text.trim()) {
    throw bad('拆解草案內容為空');
  }
  const trimmed = text.trim();

  // 1. 直接嘗試 JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // 2. 尋找 ```json ... ``` 或 ``` ... ``` 區塊
  const codeBlockRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRe.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  // 3. 尋找最外層的 [ 與 ]
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      const slice = trimmed.slice(firstBracket, lastBracket + 1);
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  throw bad('無法從輸出中解析出 JSON 任務拆解陣列');
}

// 嚴格校驗拆解草案內容
export function parseDecomposition(input, agents = [], pools = {}) {
  const arr = extractJsonArray(input);
  if (!Array.isArray(arr)) throw bad('任務拆解結果必須為陣列');
  if (arr.length === 0) throw bad('任務拆解草案不可為空');
  if (arr.length > 12) throw bad(`任務拆解草案最多允許 12 張任務卡（目前: ${arr.length}）`);

  const validAgents = new Set();
  if (Array.isArray(agents)) {
    for (const a of agents) {
      if (typeof a === 'string') validAgents.add(a);
      else if (a && typeof a.id === 'string') validAgents.add(a.id);
    }
  }
  if (pools && typeof pools === 'object') {
    for (const k of Object.keys(pools)) validAgents.add(k);
  }

  const sanitized = [];

  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw bad(`任務卡 #${i + 1} 格式錯誤，必須是物件`);
    }

    // 標題 (title): 必填，1-150 字元
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw bad(`任務卡 #${i + 1} 缺少標題 (title)`);
    }
    const title = raw.title.trim();
    if (title.length > 150) {
      throw bad(`任務卡 #${i + 1} 標題過長（上限 150 字元，目前: ${title.length}）`);
    }

    // 目標 (goal): 字串，上限 1500 字元
    const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
    if (goal.length > 1500) {
      throw bad(`任務卡 #${i + 1} 目標過長（上限 1500 字元，目前: ${goal.length}）`);
    }

    // 驗收條件 (acceptance): 字串，上限 1500 字元
    let acceptance = '';
    if (typeof raw.acceptance === 'string') {
      acceptance = raw.acceptance.trim();
    } else if (Array.isArray(raw.acceptance)) {
      acceptance = raw.acceptance.map(s => String(s).trim()).filter(Boolean).join('; ');
    }
    if (acceptance.length > 1500) {
      throw bad(`任務卡 #${i + 1} 驗收條件過長（上限 1500 字元，目前: ${acceptance.length}）`);
    }

    // 預計動用檔案 (files): 字串，上限 500 字元
    let files = '';
    if (typeof raw.files === 'string') {
      files = raw.files.trim();
    } else if (Array.isArray(raw.files)) {
      files = raw.files.map(s => String(s).trim()).filter(Boolean).join(',');
    }
    if (files.length > 500) {
      throw bad(`任務卡 #${i + 1} 預計動用檔案長度過長（上限 500 字元，目前: ${files.length}）`);
    }

    // 建議 Agent (agentSuggestion): 需為合法 agent / pool 或空值
    let agentSuggestion = '';
    if (raw.agentSuggestion !== undefined && raw.agentSuggestion !== null && raw.agentSuggestion !== '') {
      if (typeof raw.agentSuggestion !== 'string') {
        throw bad(`任務卡 #${i + 1} 的 agentSuggestion 必須是字串`);
      }
      const sug = raw.agentSuggestion.trim();
      if (sug) {
        if (validAgents.size > 0 && !validAgents.has(sug)) {
          throw bad(`任務卡 #${i + 1} 建議的 agent/pool「${sug}」不存在於設定中`);
        }
        agentSuggestion = sug;
      }
    }

    // 依賴項 (dependsOn): 0-based 整數索引陣列
    let rawDeps = [];
    if (Array.isArray(raw.dependsOn)) {
      rawDeps = raw.dependsOn;
    } else if (typeof raw.dependsOn === 'string' && raw.dependsOn.trim()) {
      rawDeps = raw.dependsOn.split(',').map(s => s.trim()).filter(Boolean);
    } else if (raw.dependsOn === null || raw.dependsOn === undefined || raw.dependsOn === '') {
      rawDeps = [];
    } else {
      throw bad(`任務卡 #${i + 1} 的 dependsOn 格式錯誤`);
    }

    const cleanDeps = [];
    for (const d of rawDeps) {
      const idx = typeof d === 'number' ? d : Number(String(d).trim());
      if (!Number.isInteger(idx)) {
        throw bad(`任務卡 #${i + 1} 的依賴索引「${d}」不是有效整數`);
      }
      if (idx < 0 || idx >= arr.length) {
        throw bad(`任務卡 #${i + 1} 的依賴索引「${idx}」超出範圍（有效範圍: 0 ~ ${arr.length - 1}）`);
      }
      if (idx === i) {
        throw bad(`任務卡 #${i + 1} 不可自我依賴`);
      }
      cleanDeps.push(idx);
    }

    sanitized.push({
      index: i,
      title,
      goal,
      acceptance,
      files,
      agentSuggestion,
      dependsOn: [...new Set(cleanDeps)],
    });
  }

  // 循環依賴檢查 (DFS cycle detection)
  const adj = Array.from({ length: sanitized.length }, () => []);
  for (let i = 0; i < sanitized.length; i++) {
    for (const dep of sanitized[i].dependsOn) {
      adj[i].push(dep);
    }
  }

  const visited = new Array(sanitized.length).fill(0); // 0: unvisited, 1: visiting, 2: visited
  function dfs(u, pathStack) {
    visited[u] = 1;
    pathStack.push(u);
    for (const v of adj[u]) {
      if (visited[v] === 1) {
        const cycleIdx = pathStack.indexOf(v);
        const cycle = pathStack.slice(cycleIdx).concat(v).map(x => `#${x + 1} (${sanitized[x].title})`).join(' -> ');
        throw bad(`任務草案存在循環依賴: ${cycle}`);
      }
      if (visited[v] === 0) {
        dfs(v, [...pathStack]);
      }
    }
    visited[u] = 2;
  }

  for (let i = 0; i < sanitized.length; i++) {
    if (visited[i] === 0) {
      dfs(i, []);
    }
  }

  return sanitized;
}

// 建立任務卡:將草案寫入 board/tasks/*.md，並將同批依賴索引轉換為任務 ID
export function createTasksFromDraft(draft, project = '', options = {}) {
  const tasks = parseDecomposition(draft, options.agents, options.pools);
  const tasksDir = options.tasksDir || defaultTasksDir;
  fs.mkdirSync(tasksDir, { recursive: true });

  // 預先為每個草案項目產生唯一的任務 ID
  const idMap = new Map();
  const baseTime = Date.now().toString(36);
  for (let i = 0; i < tasks.length; i++) {
    let id;
    let attempts = 0;
    do {
      const rand = Math.random().toString(36).slice(2, 6);
      id = `task-${baseTime}-${rand}-${i + 1}`;
      attempts++;
      if (attempts > 100) throw bad('無法產生唯一的任務 ID', 500);
    } while (fs.existsSync(path.join(tasksDir, id + '.md')));
    idMap.set(i, id);
  }

  const createdTasks = [];

  for (let i = 0; i < tasks.length; i++) {
    const item = tasks[i];
    const taskId = idMap.get(i);
    const realDepIds = item.dependsOn.map(idx => idMap.get(idx)).filter(Boolean);
    const dependsOnStr = realDepIds.join(',');

    const meta = {
      title: item.title,
      status: 'backlog',
      agent: item.agentSuggestion || '',
      priority: 'p1',
      updated: new Date().toISOString().slice(0, 10),
    };
    if (project) meta.project = project;
    if (item.goal) meta.goal = item.goal;
    if (item.acceptance) meta.acceptance = item.acceptance;
    if (item.files) meta.files = item.files;
    if (dependsOnStr) meta.dependsOn = dependsOnStr;

    const fields = ['title', 'status', 'agent', 'priority'];
    for (const k of ['files', 'project', 'pipeline', 'goal', 'acceptance', 'dependsOn']) {
      if (meta[k]) fields.push(k);
    }
    fields.push('updated');

    const fm = fields.map(k => `${k}: ${oneLine(meta[k] ?? '')}`).join('\n');
    const body = `\n\n## 任務目標\n${item.goal || ''}\n\n## 驗收條件\n${item.acceptance || ''}\n\n## Log\n`;
    fs.writeFileSync(path.join(tasksDir, taskId + '.md'), `---\n${fm}\n---\n${body}`);

    createdTasks.push({
      id: taskId,
      title: item.title,
      status: 'backlog',
      agent: meta.agent,
      project: meta.project || '',
      priority: 'p1',
      dependsOn: dependsOnStr,
    });
  }

  return createdTasks;
}

// 解析 dependsOn 欄位（逗號分隔字串）
export const parseDependsOn = str =>
  String(str || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => /^[\w-]+$/.test(s));

// 檢查依賴的前置任務是否均已完成
export function findUnfinishedDependencies(id, dependsOnList, tasksDir, parseTaskFn) {
  if (!Array.isArray(dependsOnList) || dependsOnList.length === 0) return null;

  for (const depId of dependsOnList) {
    if (depId === id) continue;
    const depFile = path.join(tasksDir, depId + '.md');
    if (!fs.existsSync(depFile)) {
      return { id: depId, title: '(不存在或已被刪除)', status: 'missing' };
    }
    const depTask = parseTaskFn(depId + '.md');
    const isDone = depTask.status === 'done' || depTask.status === 'completed' || depTask.state === 'completed';
    if (!isDone) {
      return { id: depId, title: depTask.title || depId, status: depTask.status || 'unknown' };
    }
  }

  return null;
}
