import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as gemini from './gemini.mjs';

export const registry = { claude, codex, gemini };

// type 是 agents.json 的 agent.type;未知回 null(呼叫端決定如何報錯)
export function getAdapter(type) {
  return Object.prototype.hasOwnProperty.call(registry, type) ? registry[type] : null;
}
