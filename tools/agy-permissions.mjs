// 手動工具:暫時開啟/還原 agy headless 的指令權限。由使用者自己執行,Claude 不會代跑。
//   node tools/agy-permissions.mjs on       備份 settings.json,加入 permissions.allow ["command(*)"]
//   node tools/agy-permissions.mjs off      用備份還原(或移除 permissions 區塊)
//   node tools/agy-permissions.mjs status
// 作用範圍是 agy 全域設定(所有 agy session),用完務必 off。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const backup = file + '.pre-workboard.bak';
const cmd = process.argv[2];
const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));

if (cmd === 'on') {
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const j = load();
  j.permissions = { ...(j.permissions || {}), allow: ['command(*)'] };
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  console.log('已開啟 agy 指令權限 command(*)。原設定備份在', backup, '。用完請執行: node tools/agy-permissions.mjs off');
} else if (cmd === 'off') {
  if (fs.existsSync(backup)) { fs.copyFileSync(backup, file); fs.unlinkSync(backup); console.log('已用備份還原 agy 設定。'); }
  else { const j = load(); delete j.permissions; fs.writeFileSync(file, JSON.stringify(j, null, 2)); console.log('沒有備份,已移除 permissions 區塊。'); }
} else {
  const j = load();
  console.log('permissions =', JSON.stringify(j.permissions || null), '| 備份存在:', fs.existsSync(backup));
}
