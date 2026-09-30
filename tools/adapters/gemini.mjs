// Gemini CLI adapter。
// 2026-09-30 實測【失敗】(gemini 0.58.0,2 次):兩次皆因帳號層 IneligibleTierError
// (UNSUPPORTED_CLIENT,Gemini Code Assist for individuals 不再支援此 client)在認證階段結束,
// stdout 為空、exit 55/1。另發現:未信任資料夾會把 approval mode 強制降為 "default"(唯讀承諾失效),
// 且 headless 會要求 --skip-trust 或 GEMINI_CLI_TRUST_WORKSPACE=true。
// 因此 parseLine 依據 Gemini CLI 文件的 stream-json 事件 schema(init/message/tool_use/
// tool_result/error/result)撰寫,fixture 為「合成樣本」,**未經真實輸出驗證**。
// execute 模式(auto_edit)未實跑。
import { expandHome, assertMode, isReadOnly, parseJsonLine, ev, cmdKind, permissionError, PERMISSION_RE } from './_util.mjs';

export const id = 'gemini';

export function buildCommand({ mode, prompt, cwd, agentCfg = {} }) {
  assertMode(mode);
  const args = ['-p', prompt, '--approval-mode', isReadOnly(mode) ? 'plan' : 'auto_edit', '-o', 'stream-json'];
  // 未信任資料夾 headless 需要此旗標(否則 approval mode 被降為 default)。預設不加,由 agentCfg.skipTrust 明確開啟。
  if (agentCfg.skipTrust) args.push('--skip-trust');
  const env = {};
  if (agentCfg.home && agentCfg.home !== '~/.gemini') env.GEMINI_CLI_HOME = expandHome(agentCfg.home); // 未查證此變數在 0.58 是否生效
  return { cmd: agentCfg.cmd || 'gemini', args, env, cwd };
}

const EDIT_TOOLS = /^(write_file|replace|edit)$/i;
const SHELL_TOOLS = /^(run_shell_command|shell)$/i;

export function parseLineEvents(line) {
  const o = parseJsonLine(line);
  if (!o) return [];
  try {
    switch (o.type) {
      case 'init': return [ev('start', { text: o.model || '', sessionId: o.session_id })];
      case 'message':
        return o.role === 'assistant' && o.content ? [ev('message', { text: String(o.content) })] : [];
      case 'tool_use': {
        const p = o.parameters || {};
        const name = o.tool_name || '';
        if (EDIT_TOOLS.test(name)) return [ev('file-edit', { tool: name, file: p.file_path || p.path })];
        if (SHELL_TOOLS.test(name)) return [ev(cmdKind(p.command), { tool: name, text: p.command })];
        return [ev('tool', { tool: name, file: p.file_path || p.path })];
      }
      case 'tool_result':
        if (o.status === 'error') {
          const t = String((o.error && o.error.message) || o.output || '').slice(0, 500);
          return [PERMISSION_RE.test(t) ? permissionError(t) : ev('error', { text: t })];
        }
        return [];
      case 'error': {
        const t = String(o.message || '').slice(0, 500);
        return [PERMISSION_RE.test(t) ? permissionError(t) : ev('error', { text: t })];
      }
      case 'result': return [ev('end', { exitCode: o.status === 'success' ? 0 : 1 })];
      default: return [];
    }
  } catch { return []; }
}

export function parseLine(line) { return parseLineEvents(line)[0] || null; }
export const detectQuotaExhaustion = () => ({ exhausted: false });
