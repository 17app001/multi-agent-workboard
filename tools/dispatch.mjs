// 用法: node tools/dispatch.mjs <task-id>
// 依任務的 agent 欄位,用對應 CLI 的非互動模式啟動它去做這張任務。輸出寫到 board/runs/<id>-<時間>.log
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expand = p => p.replace(/^~/, os.homedir());

export function dispatch(id) {
  const file = path.join(root, 'board/tasks', id + '.md');
  if (!fs.existsSync(file)) throw new Error('找不到任務 ' + id);
  const raw = fs.readFileSync(file, 'utf8');
  const agentId = raw.match(/^agent:\s*(.+)$/m)?.[1].trim();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents.json'), 'utf8'));
  const agent = cfg.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('任務沒有指派有效的 agent(目前: ' + (agentId || '空') + ')');

  fs.writeFileSync(file, raw.replace(/^status:.*$/m, 'status: doing').replace(/^updated:.*$/m, 'updated: ' + new Date().toISOString().slice(0, 10)));
  const prompt = `你是 agent「${agent.id}」。先閱讀 AGENTS.md,然後完成 board/tasks/${id}.md 這張任務。` +
    `完成後把 status 改成 review,並在該檔 ## Log 追加結果摘要。不要修改其他 agent 的任務。`;

  fs.mkdirSync(path.join(root, 'board/runs'), { recursive: true });
  const log = path.join(root, 'board/runs', `${id}-${Date.now()}.log`);
  const out = fs.openSync(log, 'a');
  const env = { ...process.env };
  if (agent.type === 'codex') env.CODEX_HOME = expand(agent.home);
  if (agent.type === 'claude' && agent.home !== '~/.claude') env.CLAUDE_CONFIG_DIR = expand(agent.home);
  const child = spawn(agent.cmd, [...(agent.args || []), prompt], { cwd: root, env, stdio: ['ignore', out, out], detached: true });
  child.on('error', e => fs.appendFileSync(log, '\n[dispatch] 無法啟動 ' + agent.cmd + ': ' + e.message + '\n'));
  child.on('exit', code => {
    fs.appendFileSync(log, `\n[dispatch] exit ${code}\n`);
    if (code !== 0) { // 失敗時退回 todo,並記錄
      const cur = fs.readFileSync(file, 'utf8');
      if (/^status: doing/m.test(cur)) fs.writeFileSync(file, cur.replace(/^status:.*$/m, 'status: todo') + `\n- dispatch 失敗 (exit ${code}),見 ${path.relative(root, log)}\n`);
    }
  });
  child.unref();
  return { agent: agent.id, log: path.relative(root, log) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(dispatch(process.argv[2])); } catch (e) { console.error(e.message); process.exit(1); }
}
