---
title: WP8 任務級用量與 Analytics
status: done
agent: codex-b
priority: p2
files: web/index.html,web/render.js,web/detail.js,tools/usage.mjs,tools/server.mjs,tests
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

- run run-1790779084268 failed: agent 結束碼 55

- run run-1790779124582 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- run run-1790779124582 cancelled: 使用者停止(等待中)

## 施工補充(Claude,2026-09-30 深夜;改派 codex-b/Mika,原 agy 的 run 已取消)
現況:`tools/usage.mjs` 已有 `collectUsage(agents)`(依日聚合,claude/codex/gemini 解析器)與 `usageInRange(agent, fromMs, toMs)`(任務時間窗估算);`GET /api/usage` 與 `GET /api/tasks/:id/log` 回傳的 `usage` 欄位已存在;首頁(WP5)只顯示一行用量摘要,完整統計在「用量」分頁(目前是舊版用量卡)。
## 要做
1. **任務級用量**:Task Detail 頁顯示該任務(整個 run 的所有 step)的 token(輸入/快取/輸出)、估算費用、耗時;依 step 拆分(每個 step 用其實際 agent 與時間窗呼叫 `usageInRange`;step 若有記錄實際 model 也顯示)。無資料(agent 停用/home 不存在/type 無解析器)顯示「無資料」,不可顯示假的 0。
2. **agy 用量解析器**(目前 agy 是「有設定但無資料」):agy 的 stream-json 最終 `result.usage`(input_tokens/output_tokens/cache_read_tokens)已存在於每個 run 的 `raw/<step>.log`;請新增 agy 的解析——**優先讀 board/runs 內 agy step 的 raw log 統計**(可靠),而不是猜測 agy 自己的 log 目錄格式(未查證,不要憑空實作)。`usageInRange`/`collectUsage` 對 agy 用此來源;無 agy run 時回空。
3. **用量分析頁**(首頁「用量」分頁):今日/7 天/累計的 token 與費用,依 agent 分列並有簡單長條圖(沿用現有 CSS,不引入圖表套件);另列「最耗資源的前 5 個任務」(依 run 內各 step 用量加總)。
4. 一律標示「API 等值估算,非實際扣費」。
## 驗收
tools/usage 與 server 新增測試(假 log fixture、假 run 目錄,暫存沙箱);web.test.mjs 惡意字串;引擎 gate 零改動;`npm test` 不得少於 117、`npm run test:e2e` 仍 6/6。不要 commit;完成改 review 並寫 Log。

- run run-1790782440149 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T15:35:40.172Z)

- run run-1790782440149 completed

### 2026-09-30 Claude 複核(施工:codex-b/Mika)
- `npm test` 122(含 Claude 補的 1 個)、`npm run test:e2e` 6/6;engine.mjs 零改動;`/api/usage` 對 agy 改由 run 目錄 raw log 統計。
- **複核發現並修正一個真實資料 bug**:agy 解析器只認 `type`/`kind === 'result'`,但 agy 真實輸出是 `{"event":"result"}`,導致真實資料永遠「無資料」(合成 fixture 測試沒抓到)。Claude 已修一行並補「用真實樣本 fixture」的測試;修後 `/api/usage` agy 顯示約 44M tokens / 約 $23.7(API 等值估算)。
- 教訓:解析器測試必須用真實輸出樣本(tests/fixtures/*-sample.jsonl),不可只用手寫的合成資料。
- 未驗證:用量分析頁與任務用量區塊的畫面(未經瀏覽器渲染)。
