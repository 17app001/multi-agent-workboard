// 假 CLI:模擬 claude / codex 的結構化輸出,給 tests/engine.test.mjs 用(不呼叫真實 CLI)。
// flavor 由旗標判斷:有 --permission-mode → claude(stream-json);第一個參數是 -p=<prompt> → agy(stream-json,text_delta 串流);否則 codex(--json JSONL)。
// agy 的文字會被切成 3 段 text_delta,最後的 result.response 才是完整文字;control.agyNoResponse=true 時 result 不帶 response。
// mode 由 prompt 裡的「(mode: plan|execute|review)」判斷(引擎組的 prompt 一定有)。
// 行為由 cwd 底下的 fake-control.json 控制(缺省=成功):
//   { "verdicts": ["FAIL","PASS"],   // review 第 n 次呼叫的結論(超出用最後一個)
//     "verdictRaw": "沒有 VERDICT",   // 若有,review 回覆改用這段文字(測解析不到 VERDICT)
//     "hang": "execute",             // 該 mode 寫 hang.pid 後卡住不結束
//     "denyExecute": true,           // execute 時回報 permission_denials(權限被拒)
//     "exit": { "plan": 3 } }        // 該 mode 印完後以此 exit code 結束
// 每次呼叫附加一行到 process.env.FAKE_LOG:{ flavor, flagMode, mode, cwd, prompt, n, args }。
// execute 會在 cwd 寫 executed.marker(內容=呼叫次數),用來證明「execute 有/沒有被啟動」。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const isAgy = typeof args[0] === 'string' && args[0].startsWith('-p=');
const prompt = isAgy ? args[0].slice(3) : (args[args.length - 1] || '');
const flavor = isAgy ? 'agy' : (args.includes('--permission-mode') ? 'claude' : 'codex');
const flagVal = flavor === 'claude' ? args[args.indexOf('--permission-mode') + 1] : flavor === 'agy' ? args[args.indexOf('--mode') + 1] : args[args.indexOf('-s') + 1];
const flagMode = flagVal === 'plan' || flagVal === 'read-only' ? 'readonly' : 'write';
const mode = (/\(mode: (plan|execute|review)\)/.exec(prompt) || [])[1] || 'unknown';
const cwd = process.cwd();

let control = {};
try { control = JSON.parse(fs.readFileSync(path.join(cwd, 'fake-control.json'), 'utf8')); } catch { /* 缺省 */ }
const countsFile = path.join(cwd, '.fake-counts.json');
let counts = {};
try { counts = JSON.parse(fs.readFileSync(countsFile, 'utf8')); } catch { /* 第一次 */ }
const n = (counts[mode] = (counts[mode] || 0) + 1);
if (!control.noRuntimeFiles) fs.writeFileSync(countsFile, JSON.stringify(counts));
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ flavor, flagMode, mode, cwd, prompt, n, codexHome: process.env.CODEX_HOME, args: isAgy ? args.slice(1) : args.slice(0, -1) }) + '\n');

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const init = () => (flavor === 'claude'
  ? out({ type: 'system', subtype: 'init', model: 'fake', session_id: 's1' })
  : flavor === 'agy' ? out({ event: 'init', conversation_id: 'c1', init: { permission_mode: 'request-review' } })
  : out({ type: 'thread.started', thread_id: 't1' }));
const message = t => {
  if (flavor === 'agy') { // 切成 3 段 delta(在非空白處切,避免被 adapter 丟掉純空白 delta)
    const a = Math.ceil(t.length / 3), b = Math.ceil(t.length * 2 / 3);
    for (const piece of [t.slice(0, a), t.slice(a, b), t.slice(b)]) if (piece) out({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: piece } });
    return;
  }
  return flavor === 'claude'
    ? out({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
    : out({ type: 'item.completed', item: { type: 'agent_message', text: t } });
};
const end = (t, denied) => {
  if (flavor === 'agy') return out({ event: 'result', result: control.agyNoResponse ? { status: 'SUCCESS' } : { status: 'SUCCESS', response: t } });
  if (flavor === 'claude') return out({ type: 'result', subtype: 'success', is_error: false, result: t, permission_denials: denied ? [{ tool_name: 'Bash' }] : [] });
  if (denied) out({ type: 'item.completed', item: { type: 'command_execution', status: 'declined', command: 'rm -rf x' } });
  return out({ type: 'turn.completed' });
};

init();
if (control.hang === mode) {
  fs.writeFileSync(path.join(cwd, 'hang.pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (flavor === 'codex' && (control.quota === mode || (control.quotaOnce === mode && n === 1))) {
    out({ type: 'error', message: 'You’ve hit your usage limit. Try again at 11:59 PM.' });
    process.exitCode = 1;
  } else {
  let text;
  if (mode === 'plan') text = `# Plan\n- step A (plan #${n})\n- 預計動到 src/a.js`;
  else if (mode === 'review') {
    const vs = control.verdicts || ['PASS'];
    text = control.verdictRaw || `VERDICT: ${vs[Math.min(n - 1, vs.length - 1)]}\n審查第 ${n} 次的理由`;
  } else {
    if (control.writeTracked) fs.appendFileSync(path.join(cwd, 'work.txt'), `execute ${n}\n`);
    if (control.writeUntracked) fs.writeFileSync(path.join(cwd, 'new-file.txt'), control.writeUntracked === true ? `new file ${n}\n` : String(control.writeUntracked));
    if (control.writeIgnored) fs.writeFileSync(path.join(cwd, 'ignored.txt'), control.writeIgnored === true ? `ignored file ${n}\n` : String(control.writeIgnored));
    else fs.writeFileSync(path.join(cwd, 'executed.marker'), String(n));
    text = `已完成實作 (execute #${n})`;
  }
  message(text);
  end(text, control.denyExecute && mode === 'execute');
  const code = control.exit && control.exit[mode];
  if (code) process.exitCode = code;
  }
}
