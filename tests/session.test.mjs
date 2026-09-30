import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBriefing, buildWrapUp, writeWrapUp } from '../tools/session.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
const now = new Date('2026-09-30T09:00:00.000Z');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const task = (id, status, title) => write(path.join(root, 'board/tasks', `${id}.md`), `---\r\ntitle: ${title}\r\nstatus: ${status}\r\nupdated: 2026-09-30\r\n---\r\n`);

test.before(() => {
  task('waiting', 'needs-you', '\u9700\u8981\u6c7a\u5b9a\u7684\u4e8b'); task('active', 'todo', 'run \u8b8a\u6210\u9032\u884c\u4e2d'); task('reviewing', 'review', '\u5f85\u8907\u6838\u4efb\u52d9');
  write(path.join(root, 'board/runs/active/r1/run.json'), JSON.stringify({ taskId: 'active', runId: 'r1', status: 'running', startedAt: 2 }));
  write(path.join(root, 'docs/worklog-2026-09-29.md'), '# Worklog\n\n## \u4eca\u65e5\u5b8c\u6210\n- \u5de5\u4f5c\u65e5\u8a8c fallback\n\n## \u6c7a\u7b56\n- \u65e5\u8a8c\u6c7a\u7b56\n');
  write(path.join(root, 'next-session-handoff.md'), '# Handoff\n\n## \u73fe\u6cc1\n- **\u4ea4\u63a5\u6a94\u512a\u5148\u5b8c\u6210\u4e8b\u9805**\n\n## \u6c7a\u7b56\n- **\u4f7f\u7528 Node**\n- \u4e0d\u5f15\u5165\u5957\u4ef6\n- \u7b2c\u4e09\u9805\u4e0d\u61c9\u51fa\u73fe\n\n## \u98a8\u96aa\n- \u6e2c\u8a66 sandbox\n- **\u6642\u5340\u5dee\u7570**\n\n<!-- AUTO:BEGIN -->\nold\n<!-- AUTO:END -->\n\n\u7d50\u5c3e\u4e0d\u80fd\u8b8a\n');
  execFileSync('git', ['init'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  write(path.join(root, 'commit.txt'), 'x'); execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'today fixture'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-30T08:00:00', GIT_COMMITTER_DATE: '2026-09-30T08:00:00' } });
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('briefing prefers handoff status, removes Markdown, and has bounded sections', () => {
  const result = buildBriefing({ root, now });
  assert.equal(result.sections.completed[0], '\u4ea4\u63a5\u6a94\u512a\u5148\u5b8c\u6210\u4e8b\u9805');
  assert.deepEqual(result.sections.decisions, ['\u4f7f\u7528 Node', '\u4e0d\u5f15\u5165\u5957\u4ef6']);
  assert.deepEqual(result.sections.risks, ['\u6e2c\u8a66 sandbox', '\u6642\u5340\u5dee\u7570']);
  assert.deepEqual(result.sections.needsYou, ['\u9700\u8981\u6c7a\u5b9a\u7684\u4e8b']);
  assert.deepEqual(result.sections.doing, ['run \u8b8a\u6210\u9032\u884c\u4e2d']);
  assert.ok(result.lines.length <= 10);
  assert.ok(result.lines.every(line => Array.from(line).length <= 120 && !line.includes('**')));
});

test('briefing falls back to latest worklog completed section', () => {
  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fallback-'));
  try {
    write(path.join(fallback, 'next-session-handoff.md'), '# Handoff\n\n## \u6c7a\u7b56\n- no status\n');
    write(path.join(fallback, 'docs/worklog-2026-09-30.md'), '## \u4eca\u65e5\u5b8c\u6210\n- **fallback \u5b8c\u6210**\n');
    assert.deepEqual(buildBriefing({ root: fallback, now }).sections.completed, ['fallback \u5b8c\u6210']);
  } finally { fs.rmSync(fallback, { recursive: true, force: true }); }
});

test('real handoff and worklog fixture remain concise and plain text', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'session-real-copy-'));
  try {
    fs.mkdirSync(path.join(fixture, 'docs'), { recursive: true });
    for (const file of ['next-session-handoff.md', 'docs/worklog-2026-09-30.md']) fs.copyFileSync(path.join(repo, file), path.join(fixture, file));
    const result = buildBriefing({ root: fixture, now });
    assert.ok(result.lines.length <= 10);
    assert.ok(result.lines.every(line => Array.from(line).length <= 120 && !line.includes('**')));
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('wrapup uses local midnight from newest worklog and preserves handoff outside AUTO', async () => {
  const preview = await buildWrapUp({ root, now });
  assert.equal(preview.sinceRef, '2026-09-29T00:00:00');
  assert.equal(preview.fileName, 'worklog-2026-09-30.md');
  assert.match(preview.markdown, /today fixture/);
  const before = fs.readFileSync(path.join(root, 'next-session-handoff.md'), 'utf8');
  const saved = writeWrapUp({ root, wrapUp: preview });
  assert.equal(saved.writtenFileName, 'worklog-2026-09-30.md');
  assert.ok(fs.existsSync(path.join(root, 'docs', saved.writtenFileName)));
  const after = fs.readFileSync(path.join(root, 'next-session-handoff.md'), 'utf8');
  assert.equal(after.slice(0, after.indexOf('<!-- AUTO:BEGIN -->')), before.slice(0, before.indexOf('<!-- AUTO:BEGIN -->')));
  assert.equal(after.slice(after.indexOf('<!-- AUTO:END -->') + '<!-- AUTO:END -->'.length), before.slice(before.indexOf('<!-- AUTO:END -->') + '<!-- AUTO:END -->'.length));
  const second = await buildWrapUp({ root, now });
  assert.equal(second.fileName, 'worklog-2026-09-30-2.md');
});
