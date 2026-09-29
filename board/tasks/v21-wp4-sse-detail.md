---
title: WP4 SSE 事件流與 Task Detail 頁
status: backlog
agent: codex-a
priority: p1
files: tools/server.mjs,web
updated: 2026-09-30
---

# WP4 SSE 事件流與 Task Detail 頁

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp3-run-engine(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:codex-a(使用者可改派)。

## 內容與驗收
- GET /api/runs/:id/events 以 SSE 推送 events.jsonl 新事件(含斷線重連補送)。
- Task Detail 頁:pipeline 進度、目前事件、artifacts 檢視、原始輸出可折疊、核准/退回/停止/重試按鈕、計畫核准畫面(spec §6)。
驗收:server 測試涵蓋 SSE;手動:跑一個 run,不重新整理即可看到事件逐步出現並能核准計畫。

## Log
