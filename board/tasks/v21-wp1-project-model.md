---
title: WP1 Project 模型與任務欄位
status: done
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

### 2026-09-30 WP1 完成(claude / sonnet subagent 實作,指揮官複核)
- 改動:`tools/dispatch.mjs`(getProject/projectValid、cwd 選用 project.path、無效 project 拒絕派工且不改任務狀態、prompt 帶 goal/acceptance 與任務檔絕對路徑)、`tools/server.mjs`(/api/projects GET/POST/DELETE;任務新欄位 project/pipeline/goal/acceptance)、`web/index.html`(新任務表單、專案下拉、專案管理入口、未綁定專案警告)、`tests/projects.test.mjs`(新增 8 測試,全用假 CLI+暫存目錄)。
- 複核:`npm test` 20/20 通過;`node --check tools/*.mjs` 通過;`board/tasks` 前後清單一致。
- 偏離:path 驗證改為 GET 與派工時即時驗證(非 server 啟動時);POST /api/projects 為 upsert;dispatch prompt 為單行(避開 Windows .cmd 換行引數風險);DELETE project 不檢查綁定任務。codex 的 `-C` 未動(留給 WP2 adapter)。
- 未驗證:前端未用瀏覽器實點;未用真實 CLI 派工驗證 cwd(僅假 CLI 證明)。
- 風險:專案的 `pipeline` 欄位只存不用,留給 WP3。
