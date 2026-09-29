// adapters 共用小工具(純函式,零依賴)
import os from 'node:os';

export const expandHome = p => String(p || '').replace(/^~/, os.homedir());
export const MODES = ['plan', 'execute', 'review'];
export function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error('未知 mode: ' + mode + '(需為 plan|execute|review)');
  return mode;
}
// plan 與 review 都是唯讀
export const isReadOnly = mode => mode !== 'execute';

// 寬鬆 JSON 解析:空行/非 JSON/非物件 一律回 null,不丟例外
export function parseJsonLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!s || s[0] !== '{') return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

export const ev = (kind, extra = {}) => ({ ts: Date.now(), kind, ...extra });

// 「等待權限/被拒絕」的文字訊號(寬鬆,英文為主)
export const PERMISSION_RE = /permission|requires? approval|not allowed|denied|declined|not permitted|blocked by/i;
export const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bjest\b|\bvitest\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b/i;
export const cmdKind = cmd => (TEST_RE.test(String(cmd || '')) ? 'test' : 'command');
export const permissionError = text => ev('error', { text: String(text || '').slice(0, 500), needsHuman: true });
