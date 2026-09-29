---
title: WP9 新增 agy(Antigravity) adapter
status: done
agent: codex-a
priority: p1
files: tools/adapters/agy.mjs,tools/adapters/index.mjs,tests/adapters.test.mjs,tests/fixtures
updated: 2026-09-30
---

# WP9 新增 agy (Antigravity CLI) adapter

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§5、§8)、`tools/adapters/claude.mjs` 與 `codex.mjs`(照它們的結構寫)、`tests/adapters.test.mjs`。

## 背景
Gemini CLI 帳號已不可用(UNSUPPORTED_CLIENT),改用 Google 的 Antigravity CLI:執行檔 `agy`(v1.2.7,`C:\Users\User\AppData\Local\agy\bin\agy.exe`)。

## 已實測事實(不要重測、不要呼叫真實 agy)
- 非互動:`agy -p='<prompt>'`。**prompt 必須用 `-p='...'` 綁在旗標上**,否則 `-p` 會把下一個旗標當成 prompt 而報錯。
- 模式:`--mode plan`(唯讀計畫)/ `--mode accept-edits`(可改檔)。輸出:`--output-format stream-json`(NDJSON)。工作目錄:以 spawn 的 cwd(另有 `--add-dir`)。`--dangerously-skip-permissions` **禁止使用**。
- stream-json 事件範例:見 `tests/fixtures/agy-plan-sample.jsonl`(真實輸出,已脫敏):
  - `{"event":"init","conversation_id":...,"init":{cwd,tools,permission_mode,...}}`
  - `{"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"READY OK"}}`,之後 `state:"DONE"`;`step_type:"user_input"` 是使用者輸入。其餘 step_type(工具呼叫等)這份樣本沒有,遇到未知一律回 null,不要猜格式。

## 要做的
1. 新增 `tools/adapters/agy.mjs`:匯出 `id='agy'`、`buildCommand({mode,prompt,cwd,agentCfg})`(plan/review→`--mode plan`,execute→`--mode accept-edits`,皆加 `--output-format stream-json`,prompt 用 `-p=<prompt>` 單一 arg;回傳格式同其他 adapter)、`parseLine(line)`、`parseLineEvents(line)`。text_delta 可累積成 message 事件,init→start,DONE 的最終回覆→end/message;壞行/空行回 null 不丟例外。
2. `tools/adapters/index.mjs` 註冊 `agy`。
3. `tests/adapters.test.mjs` 新增 agy 的測試(buildCommand 各 mode、parseLine 用 fixture)。**測試不得呼叫真實 agy/claude/codex。**
4. **不要動** agents.json、tools/server.mjs、tools/dispatch.mjs、tools/engine.mjs(有另一個 agent 正在改)。

## 驗收
`npm test` 全過;`node --check tools/adapters/agy.mjs`;完成後把 status 改成 `review`,並在下方 `## Log` 追加:改了哪些檔、npm test 輸出摘要、未涵蓋/風險。**不要自己改 done、不要 git commit。**

## Log

- dispatch 失敗 (exit 2),見 board\runs\v21-wp9-agy-adapter-1790724363773.log
- 2026-09-30 codex-a：新增 `tools/adapters/agy.mjs`，支援 plan/review/execute 的安全旗標、綁定式 `-p=<prompt>` argv，以及實測 stream-json 的 init/agent_response/result 事件；在 `tools/adapters/index.mjs` 註冊 agy，並擴充 `tests/adapters.test.mjs` 的 mode、fixture、壞行與未知事件測試。沿用既有 `tests/fixtures/agy-plan-sample.jsonl`，未修改真實 CLI log。
- 驗證：`node --check tools/adapters/agy.mjs`、index 與測試檔皆通過；adapter suite 17/17 通過，連同無子行程測試共 24/24 通過。`npm test` 在此受限執行環境中於 Node test runner/測試 server 呼叫 `child_process.spawn` 時統一遭 `EPERM`，未進入測試斷言，需由一般本機環境複跑完整 suite。
- 未涵蓋/風險：依任務指示未呼叫真實 agy，execute 模式未煙霧測試；fixture 未出現的工具事件一律回 null，待取得真實 schema 後再擴充。
