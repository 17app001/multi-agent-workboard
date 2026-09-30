---
title: WP5 首頁重做+通知置頂+中文統一+完成卡收起
status: backlog
agent: codex-b
priority: p1
files: web/index.html,web/render.js,web/detail.js,web/session.js,tests/web.test.mjs
updated: 2026-09-30
---

# WP5 首頁重做+通知置頂+中文統一+完成卡收起

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§6、§8、§10、§11)、docs/review-codex-1.md(XSS/Host 規則)。**依賴**:WP4 完成(已完成)。

## 目標(使用者選定:通知置頂、首頁重做、統一中文+走查、完成卡自動收起)
1. **首頁三區**:左 Agents(狀態燈 idle/running、目前任務、codex 額度預留位置)、中 任務列表分頁(需要你處理 / 執行中 / 排隊 / 已完成)、右 Activity(最近事件)。頂部:Project 選擇、「＋新任務」、開工/收工。原五欄看板保留為「看板」分頁。用量統計移到「用量」分頁,首頁只留一行摘要。
2. **通知+置頂**:任務進入 needs-you(等核准/審查上限/權限/逾時)或 failed 時跳瀏覽器桌面通知+提示音(沿用既有通知機制,先讀 web/index.html 現有實作;要有開關);「需要你處理」永遠置頂並顯眼;分頁籤標題顯示待處理數字,例如 `(2) Workboard`。
3. **統一中文**:web/detail.js 與所有按鈕/標題/狀態文字改為繁體中文(核准並繼續、退回並附意見、重試、強制完成、中止…),狀態名稱一致對照;做一次整體 UX 走查(空狀態文案、錯誤提示不要用 alert 阻塞,改頁內提示),把走查發現寫在 Log。
4. **完成卡自動收起**:done 超過 3 天的任務預設收起,並提供「顯示已完成」開關(記在 localStorage,壞掉要容錯)。
驗收:web.test.mjs 覆蓋新渲染函式的惡意字串測試;首頁各分頁資料來源正確(用假資料函式測試);Claude 會用真實 server 檢查 API 與靜態檔。

## 共同硬性規則
- 零依賴;不放寬核准關卡不變式(`tools/engine.mjs` 的 gate 驗證);所有動態字串 escape;測試用假 CLI + 暫存沙箱,不碰真實 board/;你的沙箱若跑不了 spawn 測試請註明,由 Claude 補跑;不要 git commit;完成改 `review` 並在 Log 寫摘要與未驗證項;`npm test` 不得少於目前數量(95)。

## Log
