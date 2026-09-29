---
title: WP1 Project 模型與任務欄位
status: backlog
agent: claude
priority: p0
files: tools/server.mjs,tools/dispatch.mjs,web/index.html,board/projects
updated: 2026-09-30
---

# WP1 Project 模型與任務欄位

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:無(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:claude(使用者可改派)。

## 內容與驗收
- 新增 board/projects/<id>.json(欄位見 spec §4.1),server 提供 GET/POST/DELETE /api/projects,啟動時驗證 path 存在。
- 任務 frontmatter 支援 project/pipeline/goal/acceptance(向下相容,舊任務不壞)。
- dispatch 的 cwd 改用 project.path;未指定 project 的舊任務仍在看板 repo 跑,但 UI 顯示警告。
- dispatch prompt 帶入 goal/acceptance。
- 新任務表單可選 project、填目標與驗收條件。
驗收:npm test 全過並新增 projects API 與 cwd 選擇的測試;手動:建 project 指向另一資料夾,派工後 agent 確實在該資料夾執行。

## Log
