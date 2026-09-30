---
title: WP13 看板顯示 codex 額度並提前換手
status: review
agent: codex-b
priority: p1
files: tools/quota.mjs,tools/server.mjs,tools/engine.mjs,web,tests/quota.test.mjs
updated: 2026-09-30
---

# WP13 看板顯示 codex 額度並提前換手

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§6、§8、§10、§11)、docs/review-codex-1.md(XSS/Host 規則)。**依賴**:WP5 完成後開工(WP5 已完成)。

## 背景(已查證)
codex 的 session 檔(`<CODEX_HOME>/sessions/**/rollout-*.jsonl`)內 `token_count` 事件帶官方 `payload.rate_limits`:`primary`(window_minutes=300,即 5 小時)與 `secondary`(10080=每週)各有 `used_percent`、`resets_at`(秒級 epoch)。範例解析腳本:Claude 曾以 node 找最新 rollout 檔逐行解析取最後一筆有 primary 的事件(可自行實作)。**Claude 自身額度沒有本機來源,不要做。**
## 要做
1. `tools/quota.mjs`:`readCodexQuota(home)` → `{primary:{usedPercent,resetsAt},secondary:{...},asOf}` 或 null(找不到/壞檔容錯,不丟例外);資料超過 6 小時視為過期並標記 stale。只讀,不改任何 codex 檔案。
2. `GET /api/quota`:對 agents.json 中 type=codex 且 enabled 的 agent 回傳;UI 在 Agents 區顯示「5 小時 X%(HH:MM 重置)/ 週 Y%」與進度條,>80% 橘色、>95% 紅色,stale 灰色標註。
3. 提前換手:pool 選人時,若某 codex agent 的 primary.usedPercent ≥ 門檻(agents.json 的 `quotaThreshold`,預設 90)且資料不是 stale,視同冷卻中(冷卻到 resetsAt),池內其他人優先;全部超標仍照 WP11 的 needs-you 邏輯。門檻與選人邏輯要有單元測試(假 rollout 檔在暫存目錄)。
驗收:tests/quota.test.mjs 用假 rollout fixture;Claude 用真實 ~/codex-agents/mika 資料核對數字與 CLI 一致。

## 共同硬性規則
- 零依賴;不放寬核准關卡不變式(`tools/engine.mjs` 的 gate 驗證);所有動態字串 escape;測試用假 CLI + 暫存沙箱,不碰真實 board/;你的沙箱若跑不了 spawn 測試請註明,由 Claude 補跑;不要 git commit;完成改 `review` 並在 Log 寫摘要與未驗證項;`npm test` 不得少於目前數量(95)。

## Log

- run run-1790776607543 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T13:58:26.630Z)

- run run-1790776607543 failed: agent 結束碼 未知

- run run-1790776607543 completed

### 2026-09-30 Claude 複核
- `npm test` 104/104;engine.mjs 只在 pool 選人加入額度門檻(stale 不擋、不建立冷卻),gate 相關零改動。真實資料核對:`/api/quota` codex-b 12%(重置 10/1 02:57)、週 34%,與 codex rollout 內的 rate_limits 一致;codex-a 99% 標 stale。
- 未驗證:額度卡的畫面(未經瀏覽器渲染);「快滿時實際換手」只有假 rollout 單元測試,未用真實額度耗盡驗證。
