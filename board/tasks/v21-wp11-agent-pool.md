---
title: WP11 Agent 池與額度耗盡自動換手
status: backlog
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
