---
title: WP4 SSE 事件流與 Task Detail 頁(含 UI 核准按鈕)
status: review
agent: codex-b
priority: p1
files: tools/server.mjs,web/index.html,web/render.js,web/detail.js,tests/web.test.mjs,tests/server.test.mjs
updated: 2026-09-30
---

# WP4 SSE 事件流與 Task Detail 頁

**先讀**:AGENTS.md、docs/v2.1-spec.md(§0、§3、§4.3-4.5、§6、§10、§11)、docs/review-codex-1.md(尤其 XSS 與 Host/Origin 規則)、`tools/engine.mjs` 的 run/事件結構、`web/render.js`(所有插入 HTML 的字串必須經其 `esc()`)、`tests/web.test.mjs`(有靜態掃描,新程式碼要通過)。

## 現況
後端已有 `/api/runs/:taskId`(run+artifacts)、`/artifacts/:name`、`/events?since=n`、`/approve`、`/reject`、`/stop`、`/retry`、`/resolve`。**前端完全沒有核准按鈕與 run 檢視**,使用者只能用 API 核准。

## 要做
1. **SSE**:`GET /api/runs/:taskId/stream`(text/event-stream),推送 events.jsonl 新事件與 run 狀態變化;支援 `Last-Event-ID`/`?since=` 斷線重連補送;run 結束後送 `end` 事件並關閉。受既有 Host 檢查保護。前端用 EventSource,失敗時退回每 3 秒輪詢 `/events?since=`。
2. **Task Detail 頁(面板或 modal 均可,點卡片開啟)**:
   - 上方:任務標題、project、目前 run 狀態、耗時。
   - **Pipeline 進度**:每個 step 顯示 完成/進行中/待處理/失敗/waived,以及 agent 與 mode。
   - **目前正在做的事**:最近事件(訊息、工具、指令、錯誤)時間軸,新事件自動捲動。
   - **Artifacts**:列出 plan.md、review.md、test.txt 等,點擊在頁內顯示內容(純文字或簡單 markdown,**一律 esc 後再顯示**)。
   - 原始輸出:可折疊區塊。
   - **計畫核准區(最重要)**:run 狀態為 needs-you 且原因是 approval 時,顯示計畫全文與按鈕「✅ 核准執行」「↩ 退回並附意見」(意見必填);按鈕呼叫 `/approve`、`/reject`。其他 needs-you 原因(revision-limit/permission/timeout/missing-input)顯示原因與可用的 `/resolve` 動作(retry/complete(僅 revision-limit)/abort)。執行中顯示「■ 停止」。
3. 看板卡片:needs-you 的任務顯眼標示(例如「⚠ 等你核准」),點卡片直接進 Task Detail。維持現有暖色風格與既有功能不退化。
4. 所有來自 run/事件/artifact 的字串都必須 escape;新增的渲染函式放 `web/render.js` 或新檔 `web/detail.js` 並讓 `tests/web.test.mjs` 的惡意字串測試涵蓋(事件文字含 `<img onerror>`、artifact 內容含 `<script>`)。
5. 測試:SSE 端點(用假 CLI/沙箱,參考 `tests/engine.test.mjs`:連線→收到事件→run 結束收到 end;`since` 補送;Host 非法 403)。

## 硬性規則
- 零依賴、不動 `tools/engine.mjs` 的核准/驗證邏輯(gate 不變式不可放寬);若需要引擎小改動(例如事件 hook)先在 Log 說明理由。
- 測試不得呼叫真實 claude/codex/agy;不得碰真實 `board/tasks` 與 `board/runs`(用暫存沙箱)。
- 你的沙箱可能無法 spawn 子行程,導致 `npm test` 跑不了——這時只跑 `node --check` 與不需 spawn 的測試,並在 Log 註明**哪些測試你沒能執行**,由 Claude 複核時補跑。
- 不要 git commit。完成把 status 改 `review`,在 `## Log` 寫:改了哪些檔、做了什麼、沒能驗證的事、風險。

## 驗收(Claude 複核時逐項檢查)
- 在真實 server 上派一個 single pipeline 任務:UI 能看到計畫、按「核准」後開始執行、時間軸即時更新,完成後 artifacts 可看;按「退回」必須附意見。
- `npm test` 全過(含新增),XSS 靜態掃描通過。

## Log

- run run-1790726770942 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T00:10:13.584Z)

- run run-1790726770942 failed: agent 結束碼 1

## 接手說明(2026-09-30,Claude)
前一位施工者 codex-a(額度用完) 因**額度用完**中斷(非品質問題)。它已在 `tools/server.mjs` 加了一段 SSE 傳輸層(`terminalRun`/`sseCursor`/`sseWrite`/`streamRun`,約 80 行,語法通過但**未複核、未測試**)。請先 `git diff tools/server.mjs` 看清楚並在此基礎上繼續(可修正它),不要整段重寫;其餘項目(前端 Task Detail、核准按鈕、web/detail.js、render.js、測試)尚未動工。你(codex-b,CODEX_HOME=~/codex-agents/mika,模型 gpt-5.6-terra)接手;遇到權限/工具問題請在 Log 明確記下。

- run run-1790727120906 failed: agent 沒有產生可存成 plan.md 的回覆文字

### 2026-09-30 中斷紀錄(Claude)
- codex-a 額度用完(重置約 12:19 PM),已寫入 `tools/server.mjs` 的 SSE 傳輸層(未複核);改派 agy 失敗:**agy headless 會自動拒絕所有 command 權限(連 `Get-ChildItem` 都被拒),plan 步驟得不到回覆**——需要使用者決定:在 agy 的 settings.json `permissions.allow` 加唯讀指令白名單,才能讓 agy 施工。
- 因此本卡退回 backlog、agent 改回 codex-a;codex 額度恢復後重新派工(先 `git diff tools/server.mjs` 接續),或由 Claude 用 subagent 接手。

- run run-1790728034578 failed: agent 結束碼 1

- run run-1790728041484 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T00:28:44.641Z)

- run run-1790728041484 completed

### 2026-09-30 Claude 複核(施工:codex-b/Mika,接續 codex-a 的 SSE WIP)
- `npm test` 82/82;`tools/engine.mjs` 未被修改(核准不變式未動);真實 server 上對已完成的 WP4 run 呼叫 `/api/runs/<id>/stream`:snapshot、51 筆 activity(遞增 id)、run、end 皆正確;非法 Host → 403;`/detail.js` 200。
- `web/detail.js` 所有動態字串經 `detailEsc`;reject 前端強制必填意見(後端亦要求)。
- **未驗證**:前端未經瀏覽器實際點擊(無自動化);Detail 介面文字為英文,與看板中文不一致(輕微,待統一);核准按鈕的實際流程請使用者在瀏覽器實測一次。
