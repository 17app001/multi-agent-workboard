// Antigravity CLI adapter。旗標與 stream-json schema 經 2026-09-30 以 agy 1.2.7 實測:
//   agy -p=<prompt> --mode plan --output-format stream-json -> exit 0,NDJSON。
// prompt 必須和 -p 綁在同一個 argv 項目；execute 模式(accept-edits)未實跑。
import { assertMode, isReadOnly, parseJsonLine, ev } from './_util.mjs';

export const id = 'agy';

export function buildCommand({ mode, prompt, cwd, agentCfg = {} }) {
  assertMode(mode);
  const args = [
    `-p=${String(prompt ?? '')}`,
    '--mode', isReadOnly(mode) ? 'plan' : 'accept-edits',
    '--output-format', 'stream-json'
  ];
  return { cmd: agentCfg.cmd || 'agy', args, env: {}, cwd };
}

export function parseLineEvents(line) {
  const o = parseJsonLine(line);
  if (!o) return [];
  try {
    if (o.event === 'init') {
      return [ev('start', {
        sessionId: o.conversation_id,
        text: o.init && o.init.permission_mode ? String(o.init.permission_mode) : undefined
      })];
    }

    if (o.event === 'step_update') {
      const update = o.step_update;
      if (!update || update.step_type !== 'agent_response') return [];
      return typeof update.text_delta === 'string' && update.text_delta.trim()
        ? [ev('message', { text: update.text_delta, delta: true })] // delta:true → engine 依序串接;完整文字以 result.response(end.text)為準
        : [];
    }

    if (o.event === 'result') {
      const result = o.result || {};
      const success = String(result.status || '').toUpperCase() === 'SUCCESS';
      return [ev('end', {
        exitCode: success ? 0 : 1,
        text: typeof result.response === 'string' ? result.response : undefined
      })];
    }

    return [];
  } catch { return []; }
}

export function parseLine(line) { return parseLineEvents(line)[0] || null; }
