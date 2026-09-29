// Codex CLI adapter。旗標經 2026-09-30 實測(codex 0.157.x):
//   codex exec -s read-only --json --skip-git-repo-check -C <dir> "<prompt>" → exit 0,JSONL。
// execute 模式(-s workspace-write)未實跑,僅單元測試驗證 args。
// 注意:codex exec 會印 "Reading additional input from stdin..." 到 stderr;spawn 時 stdin 用 'ignore'。
import { expandHome, assertMode, isReadOnly, parseJsonLine, ev, cmdKind, permissionError, PERMISSION_RE } from './_util.mjs';

export const id = 'codex';

export function buildCommand({ mode, prompt, cwd, agentCfg = {} }) {
  assertMode(mode);
  const args = ['exec', '-s', isReadOnly(mode) ? 'read-only' : 'workspace-write', '--json', '--skip-git-repo-check'];
  if (cwd) args.push('-C', cwd);
  args.push(prompt);
  const env = {};
  if (agentCfg.home) env.CODEX_HOME = expandHome(agentCfg.home);
  return { cmd: agentCfg.cmd || 'codex', args, env, cwd };
}

export function parseLineEvents(line) {
  const o = parseJsonLine(line);
  if (!o) return [];
  try {
    const it = o.item || {};
    switch (o.type) {
      case 'thread.started': return [ev('start', { sessionId: o.thread_id })];
      case 'item.completed':
        if (it.type === 'agent_message' && it.text) return [ev('message', { text: it.text })];
        if (it.type === 'command_execution') {
          const out = [];
          if (it.status === 'declined') out.push(permissionError('command declined: ' + (it.command || '')));
          out.push(ev(cmdKind(it.command), { tool: 'shell', text: it.command, exitCode: it.exit_code }));
          return out;
        }
        if (it.type === 'file_change') {
          const ch = Array.isArray(it.changes) ? it.changes : [];
          return ch.length ? ch.map(c => ev('file-edit', { tool: 'apply_patch', file: c.path })) : [ev('file-edit', { tool: 'apply_patch' })];
        }
        if (it.type === 'error') return [ev('error', { text: String(it.message || '').slice(0, 500) })];
        return [];
      case 'turn.completed': return [ev('end', { exitCode: 0 })];
      case 'turn.failed': case 'error': {
        const t = String((o.error && o.error.message) || o.message || '').slice(0, 500);
        return PERMISSION_RE.test(t) ? [permissionError(t)] : [ev('error', { text: t })];
      }
      default: return [];
    }
  } catch { return []; }
}

export function parseLine(line) { return parseLineEvents(line)[0] || null; }
