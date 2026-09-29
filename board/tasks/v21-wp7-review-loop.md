---
title: WP7 Review 迴圈與人工介入
status: backlog
agent: claude
priority: p1
files: tools/engine.mjs,web
updated: 2026-09-30
---

# WP7 Review 迴圈與人工介入

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp3-run-engine(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:claude(使用者可改派)。

## 內容與驗收
- review step 的 VERDICT 解析(spec §4.4)與回修迴圈整合;超限時三選項(再試一次/我自己處理/忽略並完成)的 API 與 UI。
驗收:假 CLI 測 PASS、FAIL→revise→PASS、連 FAIL 超限三種路徑。

## Log
