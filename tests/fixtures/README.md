# fixtures:CLI 實測樣本(WP2,2026-09-30)

測試條件:cwd 為空的暫存目錄;prompt =「只回覆這三個字:READY OK。不要使用任何工具。」;唯讀模式;每個 CLI 最多 2 次。
使用者路徑與暫存目錄名已脫敏為 `<REDACTED>`。

| CLI | 指令 | 結果 | 樣本 |
|---|---|---|---|
| claude 2.1.x | `claude -p --permission-mode plan --output-format stream-json --verbose "<p>"` | 成功 exit 0;NDJSON:`system`(hook_started/hook_response/init)、`assistant`(message.content[] 含 text/tool_use)、`rate_limit_event`、`result`(subtype success、usage、total_cost_usd)。init 顯示 permissionMode=plan。 | `claude-plan-sample.jsonl`(真實) |
| codex 0.157.x | `codex exec -s read-only --json --skip-git-repo-check -C <tmp> "<p>"` | 成功 exit 0;JSONL:`thread.started`、`turn.started`、`item.completed`(item.type=agent_message,text)、`turn.completed`(usage)。stderr 有 "Reading additional input from stdin..."。 | `codex-plan-sample.jsonl`(真實) |
| gemini 0.58.0 | `gemini -p "<p>" --approval-mode plan -o stream-json` | **失敗 2 次**(exit 55、exit 1),stdout 空。原因:`IneligibleTierError: UNSUPPORTED_CLIENT`(Gemini Code Assist for individuals 不再支援此 client,需遷移 Antigravity)——帳號/服務層問題,非旗標問題。另:未信任資料夾會把 approval mode 覆寫為 default,並要求 `--skip-trust` 或 `GEMINI_CLI_TRUST_WORKSPACE=true`;第 2 次加 `--skip-trust` 後旗標被接受,但仍卡在認證。 | `gemini-plan-sample.jsonl`(**合成**,依文件 schema 手寫,未經真實驗證) |

未實跑:三個 CLI 的 execute 模式(claude acceptEdits / codex workspace-write / gemini auto_edit)、review 模式(與 plan 同旗標)、claude 不帶 --verbose 的 stream-json、權限被拒/等待的真實輸出樣本。
CLI 升級後須重驗。
