---
title: 開發todoapp
status: review
agent: claude
priority: p1
updated: 2026-09-29
---


## Log

- 原本指派給 gemini 的派工卡住(status: doing 但 log 是空的、dispatch 沒真的跑),由 claude 直接接手完成,不透過派工機制。
- 新增 `apps/todoapp/` 獨立小專案:
  - `server.mjs`:Node 內建 `http` 模組寫後端,零 npm 依賴,資料存到 `data/todos.json`。
  - `public/index.html`:單頁前端,原生 JS + fetch,無框架。
  - `package.json`:只設定 `"type": "module"`,沒有 dependencies。
  - `.gitignore`:忽略 `data/`(執行後產生的使用者資料不進版控)。
  - 風格參考 `tools/server.mjs`(未修改該檔或本 repo 其他既有檔案)。
- 功能:新增待辦(POST /api/todos)、列出全部(GET /api/todos)、標記完成/取消完成(PATCH /api/todos/:id)、刪除(DELETE /api/todos/:id),單人使用無登入。
- 啟動方式:`node apps/todoapp/server.mjs [port]`,預設 port 4174(可用 argv 覆蓋,不佔用主看板的 4173)。開瀏覽器打開 http://localhost:4174 即可用。
- 驗證方式(PowerShell,實際執行過):
  1. 啟動 server → log 印出 `todoapp on http://localhost:4174`。
  2. `Invoke-RestMethod` 打 API 跑一輪:新增一筆 → 列表看到它 → PATCH 標記 done:true → DELETE 刪除 → 列表確認消失,每步都拿到對應 JSON 回應確認。
  3. 直接讀 `apps/todoapp/data/todos.json` 內容,確認寫入的是實際檔案而非只在記憶體。
  4. 用 `Stop-Process` 關掉 server、再重新啟動,GET /api/todos 確認先前未刪除的資料(`buy milk`)還在 → 證明真的落地存檔。
  5. 驗證後清掉測試用的 process/log 檔,確認 `apps/todoapp/` 底下只留程式碼與 `.gitignore`,沒有殘留除錯產物。
