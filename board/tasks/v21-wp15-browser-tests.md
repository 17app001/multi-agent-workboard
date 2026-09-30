---
title: WP15 瀏覽器自動化測試(零依賴,CDP)
status: review
agent: agy
priority: p1
files: tests/e2e,tests/helpers/cdp.mjs,package.json
updated: 2026-09-30
---

# WP15 瀏覽器自動化測試(零依賴,CDP)

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§6、§8、§10、§11)、docs/review-codex-1.md(XSS/Host 規則)。**依賴**:WP5 已完成(與 WP7 平行進行,檔案不重疊:你只可新增 tests/e2e、tests/helpers/cdp.mjs 並在 package.json 加 test:e2e script;不要修改 web/、tools/)。

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

## agy 施工補充(Claude)
- 你是 agy;prompt 已由引擎組好。你的 shell 指令權限已由使用者開啟。**只能寫**:`tests/e2e/`、`tests/helpers/cdp.mjs`、`package.json` 的 scripts(只加 `test:e2e`)。不要修改 `web/`、`tools/`、既有測試檔(另有 agent 正在改它們)。
- 啟動 Chrome/Edge 時 user-data-dir 必須是 `os.tmpdir()` 下自己 mkdtemp 的目錄,結束時只刪這個目錄並殺掉自己啟動的瀏覽器行程(用 `taskkill /pid <pid> /T /F`,pid 必須是你自己啟動的那個,**禁止用 `taskkill /IM chrome.exe`**——會殺掉使用者正在用的瀏覽器)。
- 沙箱 server 請複製 `tools/`、`web/`、`pipelines/`、`agents.json` 到暫存目錄並用假 CLI(參考 `tests/engine.test.mjs`、`tests/fixtures/fake-cli.mjs`),絕不連線到 4173 的真實 server,絕不呼叫真實 claude/codex/agy。
- 完成後請在 Log 貼 `npm run test:e2e` 的實際輸出(通過/skip 數量與原因)。

- run run-1790777705591 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T14:19:44.357Z)

- run run-1790777705591 completed

### 2026-09-30 Claude 複核(施工:agy,首次以 agy 完成實作任務)
- `npm run test:e2e` 我另跑一次:6/6 通過、0 skip,測試前後 chrome.exe 行程數不變(21→21),只以自己啟動的 pid 執行 `taskkill /pid <pid> /T /F`;`npm test` 不受影響。
- 這同時驗證了 WP4/5/12 的前端在真實瀏覽器可渲染並可完成核准流程(先前只有自動化單元測試)。
- 限制:僅涵蓋主要流程;通知、收起 done、額度卡、回修介面尚無 e2e。
