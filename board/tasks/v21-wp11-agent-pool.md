---
title: WP11 Agent 池與額度耗盡自動換手
status: done
agent: codex-b
priority: p1
files: tools/engine.mjs,tools/adapters,agents.json,tests/engine.test.mjs
updated: 2026-09-30
---

# WP11 Agent 池與自動換手

**依賴**:WP12 完成後開工(兩者都可能動 server.mjs,先後進行避免衝突)。**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§4.4、§10、§11)、`docs/review-codex-1.md`。

## 目標
pipeline step 可寫 `pool: "codex"`(agent 類型或自訂池名)而不是固定 agent id;引擎挑「未被標記為額度用盡」的成員。step 因額度耗盡失敗時,自動標記該 agent 冷卻(依 CLI 訊息中的重置時間,解析不到就 60 分鐘),並改用池內下一個 agent **從該 step 重跑**。

## 要做
1. agents.json 支援 `pools:{ "codex": ["codex-b","codex-a"] }`;pipeline step 的 `pool` 與既有 `agent` 二選一。冷卻狀態存 `board/runs/agent-cooldown.json`(原子寫入)。
2. 額度耗盡偵測:各 adapter 匯出 `detectQuotaExhausted(text)`,以真實樣本為準(codex 訊息含 "usage limit"、"try again at <時間>";claude/agy 未知則只回 false,不要憑空猜)。
3. 換手不得放寬不變式:換手只發生在同一 step 的重跑,核准關卡與 execute 前置 gate 完全不變;換手事件寫入 events.jsonl(`kind:error`→`phase:'failover'`,含原 agent、新 agent、原因)。
4. 池內全部冷卻中 → run 進 needs-you(原因 `no-agent-available`,列出各自重置時間)。
5. 測試(假 CLI):第一個 agent 輸出 usage limit → 自動換第二個並完成;全部耗盡 → needs-you;冷卻期間新 run 直接跳過該 agent;核准關卡在換手後仍有效。

## 硬性規則
同 WP12(零依賴、不呼叫真實 CLI、沙箱測試、不 commit、完成改 review 並寫 Log)。

## Log

## 補充(派工前,Claude)
- **審查重點(我會逐項檢查,請先自查)**:① `tools/engine.mjs` 的 `validatePipeline`/`assertGatesCleared` 不變式不可放寬:任何 execute step 前仍必須有 human-gate 的 plan step,換手後也一樣;② 換手只重跑「同一個 step」,不得跳過 step 或重用別人的 gate 核准;③ 冷卻檔用原子寫入,壞檔要容錯(當作沒有冷卻);④ quota 偵測只信真實樣本(codex 的 "usage limit" 字樣在 `board/runs/v21-wp4-sse-detail/` 較舊的 run 的 `raw/execute.log` 可找到原文),claude/agy 沒樣本就回 false,不要猜;⑤ 測試全用假 CLI(可擴充 `tests/fixtures/fake-cli.mjs`)。
- 現有 `npm test` 為 88 個全過,完成後不得減少。

- run run-1790730661787 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T01:12:50.749Z)

- run run-1790730661787 completed

## 返工要求(Claude 複核,2026-09-30 10:25)—— 請 codex-b 接續,只補測試與必要修正,不要重寫
複核:`npm test` 89/89;`tools/engine.mjs` 的 gate/`assertGatesCleared`/`validatePipeline` 不變式**未被修改**(通過);failover + gate 保留 + 冷卻檔落地已有測試。**缺口(實作在 `tools/engine.mjs` 有寫,但沒有任何測試驗證):**
1. **池內全部冷卻/耗盡 → run 進 needs-you,原因 `no-agent-available`**,且訊息列出各 agent 的冷卻到期時間。要有測試(例如兩個 agent 都輸出 usage limit),並驗證 run 狀態、reason、訊息,以及 `resolve retry` 在冷卻未過時的行為(要有明確結果,不可卡死或無限循環)。
2. **冷卻期間新 run 直接跳過該 agent**:先讓 codex-b 進冷卻,再開一個新 run(同 pool),驗證第一次就是 codex-a 執行、codex-b 一次都沒被呼叫。
3. **冷卻檔壞掉(非 JSON)時容錯**:視為沒有冷卻,不 crash,並有測試。
4. quota 偵測邊界:`detectQuotaExhaustion` 對「沒有 usage limit 字樣」回 exhausted:false、對有字樣但沒有 try again 時間回 exhausted:true 且用引擎預設 60 分鐘冷卻——請各補一個小單元測試。
若補測試時發現實作有 bug,請修並在 Log 說明。完成後 `npm test` 不得少於 89,改 `review`,寫 Log,不要 commit。

- run run-1790734807121 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T02:21:45.987Z)

- run run-1790734807121 completed

### 2026-09-30 Claude 複核結論
- `npm test` 92/92;`tools/engine.mjs` 的 gate/assertGatesCleared/validatePipeline 不變式未被放寬(validatePipeline 只新增 pools 參數);failover 保留 human gate、全員耗盡進 needs-you、冷卻期間新 run 跳過、非 quota 失敗不換手、detectQuotaExhaustion 邊界皆有測試。
- 殘留:冷卻檔「壞 JSON」容錯的程式碼有(loadCooldowns try/catch → {}),但**沒有專屬測試**;claude/agy/gemini 的 quota 偵測只回 false(無真實樣本);尚未接上 codex 官方 rate_limits 百分比(可作為 WP13:看板顯示各帳號 5h/週額度並提前換手)。
