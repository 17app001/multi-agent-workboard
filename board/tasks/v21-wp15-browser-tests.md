---
title: WP15 瀏覽器自動化測試(零依賴,CDP)
status: backlog
agent: codex-b
priority: p1
files: tests/e2e,tests/helpers/cdp.mjs,package.json
updated: 2026-09-30
---

# WP15 瀏覽器自動化測試(零依賴,CDP)

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§6、§8、§10、§11)、docs/review-codex-1.md(XSS/Host 規則)。**依賴**:WP5 完成後開工(畫面穩定後)。

## 目標
讓前端也有自動驗收。**不可引入 playwright/puppeteer 等 npm 套件**;Node 24 有內建全域 `WebSocket`,可用 Chrome DevTools Protocol(CDP)直接驅動本機 Chrome/Edge(Windows 常見路徑:`C:/Program Files/Google/Chrome/Application/chrome.exe`、`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`,先偵測,找不到就 skip 並清楚說明)。
## 要做
1. `tests/helpers/cdp.mjs`:啟動 headless 瀏覽器(隨機 remote-debugging-port、暫存 user-data-dir,測完必殺行程樹並刪暫存目錄——只刪自己建立的路徑),提供 navigate、evaluate、click、waitFor(selector)、截圖存暫存。
2. `tests/e2e/*.test.mjs`:對「暫存沙箱 server + 假 CLI」跑:(a) 首頁載入無 console error;(b) 建 project、建任務;(c) 派工 → 出現「等你核准」→ 點「核准並繼續」→ 完成,期間 Detail 事件即時出現;(d) 退回沒填意見會被擋;(e) 開工按鈕顯示簡報;(f) XSS:任務標題含 `<img onerror>` 不會執行(檢查 window 旗標)。
3. 找不到瀏覽器時整批 skip(不算失敗),`npm test` 仍可用;新增 `npm run test:e2e`。
驗收:在本機實際執行通過並貼輸出;Claude 複核時會另跑一次。

## 共同硬性規則
- 零依賴;不放寬核准關卡不變式(`tools/engine.mjs` 的 gate 驗證);所有動態字串 escape;測試用假 CLI + 暫存沙箱,不碰真實 board/;你的沙箱若跑不了 spawn 測試請註明,由 Claude 補跑;不要 git commit;完成改 `review` 並在 Log 寫摘要與未驗證項;`npm test` 不得少於目前數量(95)。

## Log
