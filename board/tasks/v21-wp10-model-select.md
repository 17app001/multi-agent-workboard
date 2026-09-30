---
title: WP10 每個 agent 可選模型(任務/agent 層級)
status: review
agent: codex-b
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

## 補充(派工前,Claude)
- 依賴 WP3/WP9/WP11 已完成。旗標已查證:codex `exec -m/--model <MODEL>`(也可 `-c model=`);claude `--model <alias|id>`;agy `--model <id>`(`agy models` 列出,格式如 `gemini-3.8-flash-high`)。codex 各帳號的預設模型由其 `CODEX_HOME/config.toml` 決定(codex-a=`gpt-5.6-sol` fast、codex-b/Mika=`gpt-5.6-terra`);**不傳 model 就必須維持現有行為**。
- agents.json 的 `models` 清單請先寫入:codex-a/codex-b:`gpt-5.6-terra`、`gpt-5.6-sol`(標註「耗額度快」);claude:`sonnet`、`opus`、`haiku`;agy:`gemini-3.8-flash-high`、`gemini-3.8-flash-medium`、`gemini-3.8-flash-low`(以 `agy models` 實際輸出為準,執行時可呼叫一次確認,這是唯讀查詢)。
- 審查重點:① 引擎 gate 不變式不可動;② `buildCommand` 的 model 值必須驗證為 `[\w.:-]+`(防注入,不合法拒絕);③ model 優先序 step > task > agent.defaultModel > CLI 預設有單元測試;④ UI 選單來自 `/api/agents/:id/models`,所有字串 escape;⑤ 事件/run.json 要記錄實際使用的 model;⑥ `npm test` 不得少於 92。
- 你的沙箱可能跑不了 spawn 測試:註明沒能執行的部分,我補跑。不要 commit。

- run run-1790744515499 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T05:03:40.898Z)

- run run-1790744515499 failed: agent 結束碼 未知

- run run-1790744515499 completed

### 2026-09-30 Claude 複核
- `npm test` 95/95;engine 的 gate 不變式未動;model 值以 `[\w.:-]+` 驗證(不合法丟錯);`/api/agents/:id/models` 實測 codex-b、agy 皆正確(agy 為宣告清單)。
- 注意:agents.json 現在為每個 agent 宣告 `defaultModel`(codex-a=sol、codex-b=terra、claude=sonnet 別名、agy=gemini-3.8-flash-high),派工時會**明確傳** `--model/-m`,不再只靠 CLI 預設;若想完全維持 CLI 預設請移除該 agent 的 defaultModel。gemini 的 2.5 模型清單為未驗證(該 CLI 帳號不可用)。
- 未驗證:UI 模型選單未經瀏覽器實測;優先序 step>task>agent.default 只有部分測試(prompt/驗證),完整優先序矩陣測試待補;真實 CLI 帶 `-m` 的實跑未做。
