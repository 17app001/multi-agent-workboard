// Claude Code adapter。旗標經 2026-09-30 實測(claude 2.1.x):
//   claude -p --permission-mode plan --output-format stream-json --verbose "<prompt>"  → exit 0,NDJSON。
// stream-json 在 -p 下需要 --verbose(spec 原記載;本次以帶 --verbose 實跑成功,未單獨測不帶的組合)。
// execute 模式(acceptEdits)未實跑,僅單元測試驗證 args。
import { expandHome, assertMode, isReadOnly, parseJsonLine, ev, cmdKind, permissionError, PERMISSION_RE } from './_util.mjs';

export const id = 'claude';

export function buildCommand({ mode, prompt, cwd, agentCfg = {} }) {
  assertMode(mode);
  const args = ['-p', '--permission-mode', isReadOnly(mode) ? 'plan' : 'acceptEdits', '--output-format', 'stream-json', '--verbose', prompt];
  const env = {};
  if (agentCfg.home && agentCfg.home !== '~/.claude') env.CLAUDE_CONFIG_DIR = expandHome(agentCfg.home);
  return { cmd: agentCfg.cmd || 'claude', args, env, cwd };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const blockText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && b.text) || '').join('') : '');

// 一行可能含多個事件(assistant 訊息內有多個 content block)
export function parseLineEvents(line) {
  const o = parseJsonLine(line);
  if (!o) return [];
  try {
    switch (o.type) {
      case 'system':
        return o.subtype === 'init' ? [ev('start', { text: o.model || '', sessionId: o.session_id })] : [];
      case 'assistant': {
        const out = [];
        for (const b of (o.message && o.message.content) || []) {
          if (!b) continue;
          if (b.type === 'text' && b.text) out.push(ev('message', { text: b.text }));
          else if (b.type === 'tool_use') {
            const inp = b.input || {};
            if (EDIT_TOOLS.has(b.name)) out.push(ev('file-edit', { tool: b.name, file: inp.file_path || inp.notebook_path }));
            else if (b.name === 'Bash') out.push(ev(cmdKind(inp.command), { tool: b.name, text: inp.command }));
            else out.push(ev('tool', { tool: b.name, file: inp.file_path || inp.path }));
          }
        }
        return out;
      }
      case 'user': {
        const out = [];
        for (const b of (o.message && Array.isArray(o.message.content) ? o.message.content : [])) {
          if (b && b.type === 'tool_result' && b.is_error) {
            const t = blockText(b.content);
            out.push(PERMISSION_RE.test(t) ? permissionError(t) : ev('error', { text: t.slice(0, 500) }));
          }
        }
        return out;
      }
      case 'result': {
        const out = [];
        const denials = Array.isArray(o.permission_denials) ? o.permission_denials : [];
        if (denials.length) out.push(permissionError('permission denied: ' + denials.map(d => d && d.tool_name).filter(Boolean).join(', ')));
        out.push(ev('end', { exitCode: o.is_error || (o.subtype && o.subtype !== 'success') ? 1 : 0, text: typeof o.result === 'string' ? o.result : undefined }));
        return out;
      }
      default: return []; // rate_limit_event 等
    }
  } catch { return []; }
}

export function parseLine(line) { return parseLineEvents(line)[0] || null; }
