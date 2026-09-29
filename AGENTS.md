# Multi-Agent Workboard — 共用規則

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
