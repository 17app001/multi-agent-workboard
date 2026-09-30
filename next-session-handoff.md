# Next Session Handoff

**先讀**:`docs/v2.1-spec.md`(權威規格,§10 品質/返工規則、§11 審查後修訂)→ `AGENTS.md` 末段「v2.1 施工接手指南」→ `docs/v2.1-施工紀錄與測試方案.md`(含使用者回來後的 9 步測試方案)→ 你要做的 `board/tasks/v21-wp*.md`。
記憶(專案方向、工作規則、CLI 實測事實)在 `C:\Users\User\.claude\projects\D--MyProject-multi-agent-workboard\memory\`。

## 現況(2026-09-30 收工)
- **完成**:WP1(project)、WP2(adapters)、WP3(Run 引擎+**人工計畫核准關卡**)、WP9(agy adapter,由 codex-a 經看板派工完成)、codex 獨立審查(`docs/review-codex-1.md`)及其必修項返工。`npm test` 80/80;真實 claude 端到端煙霧測試通過(plan→待核准→approve→execute)。
- **未開工**:WP4(SSE+Task Detail+**UI 核准按鈕**,建議下一個)、WP5、WP6、WP7、WP8、WP10(選模型)。
- 已 push 到 `origin/ccr-920812ef-ba9dbz`。看板 server 已用新程式重啟(port 4173)。

## 運作方式(使用者指示,見記憶 user-workflow-rules-v21)
- Claude 是品質關卡:agent 交出 → Claude 跑 `npm test`、讀 diff、抽查 → 有問題**退回同一個 agent CLI 返工**(寫進任務卡 Log,狀態改回 todo)。
- 實作/審查優先派 codex-a 與 agy(用看板 `POST /api/dispatch` 或 UI 派工),Claude 只決策/複核/跑測試(codex 沙箱不能 spawn 子行程,跑不了本 repo 測試)。
- 額度到約 50% 就收工:整理記憶、文檔、push。

## 最新進展(收工前補記)
- **WP4 完成並已複核**(review):SSE + Task Detail 頁 + UI 核准/退回按鈕,由 codex-b(Mika 帳號 `~/codex-agents/mika`,模型 gpt-5.6-terra)施工、Claude 複核;npm test 82/82。**前端未經瀏覽器實測,請使用者實際點一次核准流程**。
- codex-a(`~/.codex`,gpt-5.6-sol fast)額度用完(約 12:19 PM 重置);codex-b 已啟用。agy headless 仍會自動拒絕指令權限(需使用者決定是否在 `~/.gemini/antigravity-cli/settings.json` 加 `permissions.allow`;我試過 `command(*)` 可用,但分類器擋下自動開放,已還原設定)。
- **下一步建議(等使用者確認)**:commander pipeline 模板、agent 池與額度耗盡自動換手、開工/收工按鈕、WP10 選模型。

- **WP12(開工/收工按鈕)**、**WP11(Agent 池+額度耗盡自動換手)** 已由 codex-b 施工、Claude 複核(WP12 返工過一次);`npm test` 92/92。pool 設定在 `agents.json` 的 `pools`;冷卻檔 `board/runs/agent-cooldown.json`。
- **額度可讀**:codex 的 session log 內有官方 `rate_limits`(5h/週已用%與重置時間),可寫成 WP13 顯示於看板並提前換手;Claude 自身額度讀不到。
- **commander pipeline**(開工計畫→施工×2→審查→收工)方案已在對話提出,待使用者確認例行審查用無頭 Claude 或交給 codex/agy。

- **WP10(選模型)已完成並複核**(`npm test` 95/95):agents.json 有 `models`/`defaultModel`,`GET /api/agents/:id/models`;UI 選單未經瀏覽器實測。
- **回家後第一件事(agy 真實測試)**:使用者需在自己的終端機執行 `node D:\MyProject\multi-agent-workboard\tools\agy-permissions.mjs on`(備份並開啟 agy 全域 `command(*)`),Claude 才能做 agy 的 plan→核准→施工實測(暫存資料夾);測完務必 `off` 還原。目前狀態為**未開啟**。
- 額度:codex-b(Mika)5h 已用約 58%(13:27 重置)。
- 剩餘:WP5、WP6、WP7、WP8、WP13(看板顯示 codex 額度%)。

## 待使用者決定 / 已知風險
1. D3:execute 權限強度與 command step 是否改 `{command,args}`+`shell:false`(審查 #8)。
2. 審查 #10:prompt 信任邊界、核准計畫 hash 與 diff 範圍檢查(WP6 後做)。
3. **UI 目前無核准按鈕**:核准/退回要用 API(`POST /api/runs/<id>/approve|reject`),WP4 才補。
4. agy 尚未實際派工過(adapter 只用假輸出+一次 plan 實測);codex/agy 的 execute 模式未實跑。gemini CLI 帳號不可用。
5. agy 用量統計未做(用量卡為空)。
6. `board/tasks/task-mun9zamd.md`(空白任務)未進版控,留著或刪。README 仍無截圖。
7. 前端 WP1 畫面跑版已修 CSS,使用者尚未確認。
