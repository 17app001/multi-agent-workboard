# Next Session Handoff

**先讀**:`docs/v2.1-spec.md`(權威規格)→ `AGENTS.md` 末段「v2.1 施工接手指南」→ `board/tasks/v21-wp*.md`。
舊日誌:[docs/worklog-2026-09-30.md](docs/worklog-2026-09-30.md)(v1 完成內容與事故記錄)。

## 現況(2026-09-30)
- v1 功能完整(派工、用量、log viewer、停止、衝突防呆…),`npm test` 12 個測試全過。
- 已完成 v2.1 規劃:spec + 8 張 WP 任務卡(`board/tasks/v21-wp1~wp8`,目前全在 `backlog`,**尚未開工**)。
- 動機:v1 是「任務檔管理器」,缺 project 概念(agent 永遠在看板 repo 跑)、缺計畫核准關卡、黑箱、無 agent 間交接。

## 待使用者決定(開工前,見 spec §9)
1. D1 確認不換 Python/FastAPI,維持 Node 零依賴。
2. D2 standard pipeline 的 plan gate 是否永遠開啟(建議是)。
3. D3 execute 模式權限強度與是否允許跑 shell。
4. 各 WP 的 owner 是否照建議(WP1-3、7 claude;WP4-5 codex-a;WP6 codex-b;WP8 gemini),確認後把該卡 `status` 改 `todo`。

## 關鍵路徑
WP1 → WP2 → WP3(做完即達成「先計畫、核准後才執行」與「不黑箱」),WP4 起是體驗層。

## 其他待辦/風險
- README 沒有截圖(瀏覽器擴充套件先前沒連上)。
- `board/tasks/task-mun9zamd.md`(測試agent多協作模式)是空白任務,沒規格,留著或刪。
- 兩個本機 server(4173 看板、4174 todoapp)可能還在跑,改 `tools/` 後要重啟。
- 尚無測試涵蓋:派工衝突 409、停止行程。
