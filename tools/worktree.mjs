// Parameterized Git worktree wrapper. Never invokes a shell.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const branchFor = taskId => `agent/${taskId}`;
const git = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(String(error.stderr || error.stdout || error.message || '').trim() || `git ${args[0]} failed`); }
};
const inside = (parent, child) => { const rel = path.relative(path.resolve(parent), path.resolve(child)); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
export function isGitRepository(cwd) { try { return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } }
export function createWorktree(projectPath, taskId) {
  if (!/^[\w-]+$/.test(taskId || '')) throw new Error('invalid task id for worktree');
  if (!isGitRepository(projectPath)) throw new Error(`project is not a Git repository: ${projectPath}`);
  const baseCommit = git(projectPath, ['rev-parse', 'HEAD']).trim(), branch = branchFor(taskId);
  // Keep these beside, rather than inside, the main checkout.  An untracked
  // container inside the project would make its clean-tree merge precondition
  // fail and would itself be visible to the user's normal Git status.
  const container = path.resolve(projectPath, '..', '.workboard-worktrees', path.basename(path.resolve(projectPath))), worktreePath = path.resolve(container, taskId);
  if (!inside(container, worktreePath)) throw new Error('unsafe worktree path');
  if (fs.existsSync(worktreePath)) throw new Error(`worktree already exists: ${worktreePath}; merge or discard its previous run first`);
  try { git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); throw new Error(`branch ${branch} already exists; merge or discard its previous run first`); } catch (e) { if (/already exists/.test(e.message)) throw e; }
  fs.mkdirSync(container, { recursive: true });
  try { git(projectPath, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]); } catch (e) { throw new Error(`cannot create worktree: ${e.message}`); }
  return { enabled: true, path: worktreePath, branch, baseCommit, status: 'active' };
}
export const status = cwd => git(cwd, ['status', '--porcelain=v1']).trim();
// `git diff <base>` does not include untracked files.  Mark only unignored
// untracked paths as intent-to-add in this worktree's index, so the normal
// binary diff contains their full additions without staging their contents.
export function intentToAddUntracked(cwd) {
  const output = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = output.split('\0').filter(Boolean);
  if (files.length) git(cwd, ['add', '--intent-to-add', '--', ...files]);
  return files;
}
export const diffFromBase = (cwd, base) => git(cwd, ['diff', '--binary', base]);
export const removeWorktree = (cwd, wt) => git(cwd, ['worktree', 'remove', '--force', wt]);
export const deleteBranch = (cwd, branch) => git(cwd, ['branch', '-D', branch]);
export const head = cwd => git(cwd, ['rev-parse', 'HEAD']).trim();
export const checkApply = (cwd, patch) => git(cwd, ['apply', '--check', '--binary', patch]);
export const applyPatch = (cwd, patch) => git(cwd, ['apply', '--binary', patch]);
