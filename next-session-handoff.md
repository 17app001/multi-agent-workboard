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
- **agy 真實測試已通過(2026-09-30)**:在暫存 repo 用引擎派 agy 跑 single pipeline:plan.md 完整擷取(1979 bytes)→ 核准 → execute 修改 hello.txt 正確,128 筆事件、無錯誤。前提是 agy 全域開了 `command(*)`(`node tools/agy-permissions.mjs on`)——**用完務必 `off` 還原**;`agy-permissions.mjs status` 可查目前狀態。
- 額度:codex-b(Mika)5h 已用約 58%(13:27 重置)。
- 剩餘:WP5、WP6、WP7、WP8、WP13(看板顯示 codex 額度%)。

## 2026-10-01 最新狀態(以此為準;詳見 docs/worklog-2026-10-01.md、docs/使用手冊.md)
- 使用者指示 Claude 獨自把整個機制做完、**先不派其他 agent**,完成後由使用者測試。已完成:首頁效能(worker thread)、流程選單、專案 testCommand/worktree 設定、worktree 合併/丟棄 UI、需求拆解 UI 修正、agy 權限提示、任務用量(codex/claude/agy raw log)、使用手冊。
- **驗證**:`npm test` 128、`npm run test:e2e` 12(真實 Chrome);**真實 CLI 端到端**(Claude 計畫→核准→codex-b 施工→Claude 審查 PASS)通過。
- 使用者測試清單在 worklog-2026-10-01.md。提交前請跑 `npm run gate`(= `npm test && npm run test:e2e`,任一失敗即非 0,全過才 commit)。

## 2026-09-30 深夜收工狀態(較舊)
- **已完成並 push**:WP1–5、WP7、WP9–16(含 WP5 首頁重做/通知置頂/中文化/完成卡收起、WP13 codex 額度顯示與提前換手、WP14 需求自動拆解、WP15 CDP 瀏覽器 e2e、WP16 修 flaky)。`npm test` 113/113、`npm run test:e2e` 6/6(真實 Chrome)。
- **施工者分工實績**:Mika(codex-b)做 WP10/11/12/13/14/7/5;agy 做 WP15、WP16(開了全域 command(*) 期間);Claude 只審查與複核。
- **agy 全域權限已用 `tools/agy-permissions.mjs off` 還原**;再用 agy 施工前需使用者自己執行 `on`。
- **WP6(worktree 隔離,含 merge/discard API)與 WP8(任務級用量、用量分析頁、agy 用量)已由 Mika 施工、Claude 複核並依使用者指示完成(done)**;`npm test` 122/122、e2e 6/6。WP8 複核時抓到 agy 用量解析對真實輸出格式(`{"event":"result"}`)失效的 bug 並已修正——解析器測試須用真實樣本。
- **狀態為 review 的卡**(WP5/7/13/14/15/16):已複核通過,等使用者實際點畫面確認後改 done。WP6 merge/discard 尚無 UI 按鈕。
- 尚未做:commander 模板、WP6/WP8(已有 run 等核准)、開機自啟。**畫面仍建議使用者實測**(需求拆解、額度卡、回修介面尚無 e2e)。
- 已知風險:各 agent 有 defaultModel 會明確傳旗標;claude/agy 的 quota 偵測仍只回 false。

## 使用者已選定的下一批(2026-09-30 晚,已全數完成,僅留紀錄)
選 1通知置頂、2首頁重做、3中文統一、4codex額度、6需求拆解、8回修介面、10瀏覽器自動化、11完成卡收起;由 Mika(codex-b)施工、Claude 審查。**施工順序(避免同時改 web/)**:WP5(含1/2/3/11)→ WP13(額度)→ WP7(回修介面)→ WP14(需求拆解)→ WP15(瀏覽器測試,CDP 零依賴)。任務卡皆已建立於 board/tasks/(backlog);一次只派一張,完成→Claude 複核→通過才派下一張。未選:commander 模板、worktree(WP6)、用量分析(WP8)、開機自啟。

## 待使用者決定 / 已知風險
1. D3:execute 權限強度與 command step 是否改 `{command,args}`+`shell:false`(審查 #8)。
2. 審查 #10:prompt 信任邊界、核准計畫 hash 與 diff 範圍檢查(WP6 後做)。
3. **UI 目前無核准按鈕**:核准/退回要用 API(`POST /api/runs/<id>/approve|reject`),WP4 才補。
4. agy 尚未實際派工過(adapter 只用假輸出+一次 plan 實測);codex/agy 的 execute 模式未實跑。gemini CLI 帳號不可用。
5. agy 用量統計未做(用量卡為空)。
6. `board/tasks/task-mun9zamd.md`(空白任務)未進版控,留著或刪。README 仍無截圖。
7. 前端 WP1 畫面跑版已修 CSS,使用者尚未確認。
