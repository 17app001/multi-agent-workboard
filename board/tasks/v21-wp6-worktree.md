---
title: WP6 git worktree 隔離
status: backlog
agent: codex-b
priority: p2
files: tools/engine.mjs,tools/worktree.mjs
updated: 2026-09-30
---

# WP6 git worktree 隔離

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp3-run-engine(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:codex-b(使用者可改派)。

## 內容與驗收
- project.worktrees=true 時,每個 run 在 worktree 執行(分支 agent/<taskId>);完成產出 diff.patch artifact;提供合併/丟棄操作。
驗收:兩個 run 同時在同 project 跑互不干擾(用測試 repo,不碰真實專案);npm test 全過。

## Log
