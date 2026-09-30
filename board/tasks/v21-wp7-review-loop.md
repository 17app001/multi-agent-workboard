---
title: WP7 回修迴圈介面(再試一次/我自己處理/忽略)
status: review
agent: codex-b
priority: p1
files: web/detail.js,tools/engine.mjs,tools/server.mjs,tests
updated: 2026-09-30
---

# WP7 回修迴圈介面(再試一次/我自己處理/忽略)

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§6、§8、§10、§11)、docs/review-codex-1.md(XSS/Host 規則)。**依賴**:WP5 完成後開工。

## 背景
引擎已支援 review 的 VERDICT 迴圈與 `/api/runs/:id/resolve`(retry/complete/abort;complete 只限 revision-limit)。目前 Task Detail 的按鈕很陽春。
## 要做
1. 回修上限(revision-limit)時,Detail 頁顯示:review.md 的主要問題摘要(取 review.md 全文顯示,可折疊)、已回修次數、三個明確按鈕:「讓 agent 再試一次」(resolve retry)、「我自己處理」(abort 並保留變更,任務標記需人工)、「忽略並完成」(complete,需二次確認,並註明會把未完成步驟標為 waived)。
2. 每次回修顯示第幾輪、review 的 VERDICT 歷史(時間軸)。
3. 補一個 `POST /api/runs/:id/note` 讓使用者在 needs-you 時附加指示,下次重跑該 step 時併入 prompt(注意 prompt 信任邊界:標為 untrusted 使用者備註,不可覆寫引擎紀律)。
驗收:引擎 gate 不變式不動;假 CLI 測 三種 resolve 路徑與 note 併入 prompt;web.test.mjs 惡意字串。

## 共同硬性規則
- 零依賴;不放寬核准關卡不變式(`tools/engine.mjs` 的 gate 驗證);所有動態字串 escape;測試用假 CLI + 暫存沙箱,不碰真實 board/;你的沙箱若跑不了 spawn 測試請註明,由 Claude 補跑;不要 git commit;完成改 `review` 並在 Log 寫摘要與未驗證項;`npm test` 不得少於目前數量(95)。

## Log

- run run-1790777195782 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T14:08:26.621Z)

- run run-1790777195782 completed

### 2026-09-30 Claude 複核
- `npm test` 105/105;gate 不變式零改動;`POST /api/runs/:id/note` 限非 approval 的 needs-you、≤4000 字、以「不可信的使用者補充」段併入下次同 step prompt;review 歷史存 run.reviewHistory;abort 於 revision-limit 時任務標 needs-you(人工接手)。
- 未驗證:回修介面畫面(未經瀏覽器渲染)。
