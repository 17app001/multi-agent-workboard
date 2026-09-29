---
title: WP10 每個 agent 可選模型(任務/agent 層級)
status: backlog
agent: codex-a
priority: p1
files: tools/adapters,agents.json,tools/server.mjs,web/index.html,tests
updated: 2026-09-30
---

# WP10 可選擇各 agent CLI 的模型

**依賴**:v21-wp3-run-engine、v21-wp9-agy-adapter 完成後開工。**先讀**:AGENTS.md、docs/v2.1-spec.md §5、§10。

## 目標
每個 agent 可在 agents.json 宣告 `models`(可選模型清單與預設),任務(或 pipeline step)可指定 `model`;派工時由 adapter 轉成該 CLI 的旗標。使用者要能在 UI 選(例如 codex 的不同 GPT 模型、claude 的 sonnet/opus、agy 的 gemini-3.x 各檔位)。

## 要做
1. agents.json 每個 agent 新增可選 `models:[{id,label}]` 與 `defaultModel`;任務 frontmatter 新增可選 `model`;pipeline step 可覆寫 `model`。優先序:step > task > agent.defaultModel > CLI 自己的預設(不傳旗標)。
2. adapters 的 `buildCommand` 接受 `model` 並轉旗標——**旗標以各 CLI `--help` 實查為準,不要憑記憶**:claude `--model`、codex `-m/--model`(或 `-c model=`)、agy `--model`(`agy models` 可列出可用 id)、gemini `-m`。沒給 model 就不加旗標。
3. server 提供 `GET /api/agents/:id/models`(回 agents.json 宣告的清單;agy 可額外嘗試 `agy models` 動態列出,失敗時退回宣告清單);UI 新任務表單與任務卡可選模型。
4. 單元測試 buildCommand 的 model 旗標(不呼叫真實 CLI)。

## 驗收
npm test 全過;各 adapter 有帶/不帶 model 兩種測試;UI 可選模型並在派工 prompt/事件中留下所用模型紀錄。完成改 `review` 並在 Log 寫摘要,不要自己改 done、不要 commit。

## Log
