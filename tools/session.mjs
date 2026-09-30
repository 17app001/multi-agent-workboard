import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dayOf = now => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const names = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const parseTask = (id, raw) => {
  const match = String(raw).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const task = { id };
  for (const line of (match?.[1] || '').split('\n')) { const i = line.indexOf(':'); if (i > 0) task[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return task;
};
const tasks = root => names(path.join(root, 'board/tasks')).filter(f => f.endsWith('.md')).map(f => parseTask(f.slice(0, -3), read(path.join(root, 'board/tasks', f)) || ''));
const latestRuns = root => {
  const result = new Map(), base = path.join(root, 'board/runs');
  for (const taskId of names(base)) for (const runId of names(path.join(base, taskId))) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(base, taskId, runId, 'run.json'), 'utf8'));
      run.taskId ||= taskId; run.runId ||= runId;
      if (!result.has(run.taskId) || Number(run.startedAt || 0) > Number(result.get(run.taskId).startedAt || 0)) result.set(run.taskId, run);
    } catch {}
  }
  return result;
};
const logs = root => names(path.join(root, 'docs')).filter(f => /^worklog-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(f)).sort().map(name => ({ name, text: read(path.join(root, 'docs', name)) || '' }));
const truncate = (value, length) => { const chars = Array.from(String(value || '')); return chars.length > length ? `${chars.slice(0, Math.max(0, length - 1)).join('')}\u2026` : chars.join(''); };
const plainText = value => String(value || '').replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, '$1').replace(/[*_`~]+/g, '').replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim();
const heading = value => plainText(value).replace(/[\uff1a:]+$/, '').replace(/\s*[（(].*?[)）]\s*/g, '').replace(/(?:\u8a18\u9304|\u4e8b\u9805)$/, '').toLowerCase();
const sectionLines = (text, sectionNames) => {
  const wanted = new Set(sectionNames.map(heading)), values = [];
  let active = false;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) { const value = heading(match[1]); active = [...wanted].some(name => value === name || value.endsWith(name)); continue; }
    if (active) { const value = plainText(line); if (value) values.push(value); }
  }
  return values;
};
const sectionItems = (text, sectionNames, count = 2, length = 100) => sectionLines(text, sectionNames).slice(0, count).map(value => truncate(value, length));
const briefingLine = (label, values) => truncate(`${label}\uff1a${values.join('\uff1b')}`, 120);

export function buildBriefing({ root, now = new Date() } = {}) {
  const handoff = read(path.join(root, 'next-session-handoff.md')), allLogs = logs(root), latestLog = allLogs.at(-1), runs = latestRuns(root);
  const sections = { completed: [], needsYou: [], doing: [], review: [], todo: [], decisions: [], risks: [] };
  for (const task of tasks(root)) {
    const run = runs.get(task.id), label = task.title || task.id;
    if (task.status === 'needs-you' || run?.status === 'needs-you') sections.needsYou.push(label);
    else if (task.status === 'running' || task.status === 'doing' || run?.status === 'running') sections.doing.push(label);
    else if (task.status === 'review') sections.review.push(label);
    else if (['todo', 'queued', 'backlog', 'draft'].includes(task.status)) sections.todo.push(label);
  }
  sections.completed.push(...sectionItems(handoff, ['\u76ee\u524d\u72c0\u614b', '\u73fe\u6cc1', 'current status'], 1));
  if (!sections.completed.length) sections.completed.push(...sectionItems(latestLog?.text, ['\u4eca\u65e5\u5b8c\u6210', 'today completed'], 1));
  sections.decisions.push(...sectionItems(handoff, ['\u6c7a\u7b56', 'decisions'], 2));
  if (sections.decisions.length < 2) sections.decisions.push(...sectionItems(latestLog?.text, ['\u6c7a\u7b56', 'decisions'], 2 - sections.decisions.length));
  sections.risks.push(...sectionItems(handoff, ['\u98a8\u96aa', 'risks', '\u963b\u585e'], 2));
  if (sections.risks.length < 2) sections.risks.push(...sectionItems(latestLog?.text, ['\u98a8\u96aa', 'risks', '\u963b\u585e'], 2 - sections.risks.length));
  for (const key of ['needsYou', 'doing', 'review', 'todo']) sections[key] = sections[key].slice(0, 2).map(value => truncate(plainText(value), 100));
  const lines = [latestLog ? `\u6700\u8fd1\u5de5\u4f5c\u65e5\u8a8c\uff1a${plainText(latestLog.name)}` : '\u6700\u8fd1\u5de5\u4f5c\u65e5\u8a8c\uff1a\u627e\u4e0d\u5230'];
  if (sections.completed.length) lines.push(briefingLine('\u4e0a\u6b21\u5b8c\u6210', sections.completed));
  if (!handoff) lines.push('\u4ea4\u63a5\u8a18\u9304\uff1a\u627e\u4e0d\u5230\u4ea4\u63a5\u8a18\u9304');
  for (const [label, key] of [['\u9700\u6c7a\u5b9a', 'needsYou'], ['\u9032\u884c\u4e2d', 'doing'], ['\u5f85\u8907\u6838', 'review'], ['\u5f85\u8fa6', 'todo'], ['\u6c7a\u7b56', 'decisions'], ['\u98a8\u96aa', 'risks']]) if (sections[key].length) lines.push(briefingLine(label, sections[key]));
  return { generatedAt: new Date(now).toISOString(), lines: lines.map(line => truncate(plainText(line), 120)).slice(0, 10), sections };
}

async function gitSummary(root, sinceRef) {
  try { const { stdout } = await execFileAsync('git', ['log', `--since=${sinceRef}`, '--pretty=format:%h %s'], { cwd: root, windowsHide: true }); return stdout.split(/\r?\n/).filter(Boolean).slice(0, 20); } catch { return []; }
}
const availableName = (root, day) => { let n = 1; while (fs.existsSync(path.join(root, 'docs', `worklog-${day}${n === 1 ? '' : `-${n}`}.md`))) n++; return `worklog-${day}${n === 1 ? '' : `-${n}`}.md`; };

export async function buildWrapUp({ root, now = new Date() } = {}) {
  const day = dayOf(now), latest = logs(root).at(-1), latestDay = latest?.name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || day;
  const sinceRef = `${latestDay}T00:00:00`;
  const commits = await gitSummary(root, sinceRef);
  const todayTasks = tasks(root).filter(t => t.updated === day).map(t => `${t.id}\uff1a${t.title || t.id}\uff08${t.status || 'unknown'}\uff09`);
  const recentRuns = [...latestRuns(root).values()].sort((a, b) => Number(b.endedAt || b.startedAt || 0) - Number(a.endedAt || a.startedAt || 0)).slice(0, 5).map(r => `${r.taskId}\uff1a${r.status || 'unknown'}`);
  const fileName = availableName(root, day);
  const markdown = [`# Worklog ${day}`, '', '## \u4eca\u65e5\u5b8c\u6210', ...(commits.length ? commits.map(x => `- ${x}`) : ['- \u672a\u53d6\u5f97 Git \u63d0\u4ea4']), '', '## \u4eca\u65e5\u66f4\u65b0\u4efb\u52d9', ...(todayTasks.length ? todayTasks.map(x => `- ${x}`) : ['- \u7121']), '', '## \u6700\u8fd1 Run', ...(recentRuns.length ? recentRuns.map(x => `- ${x}`) : ['- \u7121']), '', `> \u7522\u751f\u6642\u9593\uff1a${new Date(now).toISOString()}`, ''].join('\n');
  return { day, sinceRef, fileName, markdown, commits, todayTasks, recentRuns };
}

export function writeWrapUp({ root, wrapUp }) {
  if (!wrapUp?.fileName || !wrapUp?.markdown) throw new Error('\u7f3a\u5c11\u6536\u5de5\u8cc7\u6599');
  const docs = path.join(root, 'docs'), target = path.join(docs, wrapUp.fileName); fs.mkdirSync(docs, { recursive: true });
  if (fs.existsSync(target)) throw new Error('\u5de5\u4f5c\u65e5\u8a8c\u5df2\u5b58\u5728\uff0c\u8acb\u5148\u91cd\u65b0\u9810\u89bd');
  const handoffFile = path.join(root, 'next-session-handoff.md'), before = read(handoffFile) || '', begin = '<!-- AUTO:BEGIN -->', end = '<!-- AUTO:END -->';
  const bi = before.indexOf(begin), ei = before.indexOf(end), auto = `${begin}\n\u6700\u5f8c\u6536\u5de5\u8a18\u9304\uff1a${wrapUp.fileName}\n${end}`;
  let after;
  if (bi < 0 && ei < 0) after = before + (before && !before.endsWith('\n') ? '\n' : '') + auto + '\n';
  else if (bi >= 0 && ei > bi && before.indexOf(begin, bi + begin.length) < 0 && before.indexOf(end, ei + end.length) < 0) after = before.slice(0, bi) + auto + before.slice(ei + end.length);
  else throw new Error('\u4ea4\u63a5\u6a94 AUTO \u5340\u584a\u683c\u5f0f\u4e0d\u6b63\u78ba\uff0c\u8acb\u624b\u52d5\u4fee\u6b63');
  fs.writeFileSync(target, wrapUp.markdown, 'utf8'); fs.writeFileSync(handoffFile, after, 'utf8');
  return { ...wrapUp, writtenFileName: wrapUp.fileName };
}
