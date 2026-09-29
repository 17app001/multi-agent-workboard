---
title: WP2 Adapter 層與事件標準化
status: backlog
agent: claude
priority: p0
files: tools/adapters,tests
updated: 2026-09-30
---

# WP2 Adapter 層與事件標準化

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp1-project-model(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:claude(使用者可改派)。

## 內容與驗收
- 建 tools/adapters/{claude,codex,gemini}.mjs,介面見 spec §5.1(buildCommand、parseLine 純函式)。
- 先對三個 CLI 各實跑一次,驗證 spec §5.3 旗標表,把結果(含失敗的組合)回寫該表。
- 事件寫 events.jsonl,格式見 spec §5.2;未知行不丟例外。
- 偵測 headless 權限卡住並產生 needs-you 事件。
驗收:每個 adapter 有 buildCommand/parseLine 單元測試(用擷取的真實輸出樣本當 fixture);npm test 全過;§5.3 表已無「待驗證」。

## Log
