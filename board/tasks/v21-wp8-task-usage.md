---
title: WP8 任務級用量與 Analytics
status: backlog
agent: gemini
priority: p2
files: web,tools/usage.mjs
updated: 2026-09-30
---

# WP8 任務級用量與 Analytics

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp4-sse-detail(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:gemini(使用者可改派)。

## 內容與驗收
- Task Detail 顯示該任務用量/耗時(沿用 usageInRange);Analytics 頁顯示 Today/7d/月與各 agent 分佈。
驗收:數字與 /api/usage 一致;npm test 全過。

## Log
