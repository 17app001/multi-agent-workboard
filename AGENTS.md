# Multi-Agent Workboard — 共用規則

## 這個專案是什麼
給「一個人同時使用多個 AI 編碼 agent」的本機任務看板。使用者有 Claude Code、Codex(兩個帳號)、Gemini CLI,且都是**訂閱版**(不是 API 計費)。目標:
1. **看板**:把開發任務集中管理,分派給不同 agent,看到誰在做什麼。
2. **用量**:從各 CLI 的本機 log 統計 token 用量,知道每個 agent 用了多少。
3. **派工**:從看板一鍵用對應 CLI 的非互動模式啟動 agent 去做某張任務。

設計原則:**零依賴**(只用 Node 內建模組,不要引入 npm 套件)、**檔案即資料庫**(任務就是 Markdown 檔,agent 和網頁操作同一份資料)、**唯讀解析 log**(絕不修改各 CLI 的 log 或設定)。

## 架構與檔案分工
| 檔案 | 用途 |
|---|---|
| `agents.json` | agent 清單(id、type、log 目錄 `home`、派工用 `cmd`/`args`、`price`)與看板欄位。 |
| `board/tasks/*.md` | 一件任務一個檔,frontmatter 為 title/status/agent/priority/updated,底部有 `## Log`。 |
| `board/runs/` | 派工時各 agent 的輸出 log(已 gitignore)。 |
| `tools/server.mjs` | 本機 HTTP 伺服器(預設 4173):`/api/tasks`、`/api/config`、`/api/usage`、`/api/dispatch`,並提供 `web/`。 |
| `tools/usage.mjs` | 依 agent type 解析 claude / codex / gemini 的 log,回傳每日 token 與估算費用。 |
| `tools/dispatch.mjs` | 依任務的 `agent` 欄位,spawn 對應 CLI 執行該任務。 |
| `web/index.html` | 單頁前端:用量卡 + 五欄看板(可拖曳、指派、派工)。 |

## 開發這個 repo
- 啟動:`node tools/server.mjs [port]`,開 `http://localhost:4173`。改 `tools/*.mjs` 後要重啟;改 `web/` 重新整理即可。
- 語法檢查:`node --check tools/<file>.mjs`。
- 用量解析注意:各 CLI 的 log 格式會隨版本變動,解析要寬鬆(缺欄位不要丟例外)。修改前先看本機實際的 log 檔確認格式。
- 費用是「API 等值估算」,使用者是訂閱制,UI 上僅供參考,不代表實際扣費。
- 環境可能是 Windows,處理路徑與啟動 CLI(.cmd)時要相容。
- 每個獨立修改各自 commit。

# 任務板規則(所有 agent 遵守)

所有 agent(Claude / Codex / Gemini)開工前都先讀這份。`CLAUDE.md`、`GEMINI.md` 只是指向本檔。

## 任務板
- 一件任務 = `board/tasks/<id>.md`,狀態寫在 frontmatter,不要另外維護清單。
- frontmatter 欄位:`title` `status` `agent` `priority`(p0-p2) `updated`
- `status` 只能是 `agents.json` 的 columns:backlog / todo / doing / review / done

## 工作流程
1. 只領 `agent:` 是自己 id、且 `status: todo` 的任務,領取後改為 `doing`。
2. 做完改成 `review`,並在任務檔底部 `## Log` 追加結果摘要。不要自己改成 `done`,由人確認。
3. 需要動外部資源(部署、發文、刪資料)先寫草稿到任務檔,等人確認。
4. 不要修改其他 agent 的任務;需要協作就新增一張任務並指定 `agent`。

## 路由建議(可自行調整)
- 大範圍重構、複雜除錯 → claude
- 平行的獨立功能、批次改動 → codex-a / codex-b
- 長文件閱讀、需要大 context 的分析 → gemini
