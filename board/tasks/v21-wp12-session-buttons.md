---
title: WP12 開工/收工按鈕(自動簡報與收工紀錄)
status: review
agent: codex-b
priority: p1
files: tools/session.mjs,tools/server.mjs,web/index.html,web/session.js,tests/session.test.mjs
updated: 2026-09-30
---

# WP12 開工/收工按鈕

**先讀**:AGENTS.md、docs/v2.1-spec.md(§0、§3、§8、§10、§11)、`next-session-handoff.md`、`docs/worklog-2026-09-30.md`、`tools/server.mjs`(路由與 Host/Origin 保護寫法)、`web/render.js`(所有動態字串必須 escape)。

## 目標
使用者(主導者)用兩顆按鈕代替手動流程:
- **「開工」**:產生 ≤10 行簡報:上次完成什麼、目前有哪些任務在各狀態(needs-you / doing / review / todo)、待使用者決定事項與風險。
- **「收工」**:產生當日工作日誌草稿與交接檔更新,**只寫新檔或標記區塊,絕不覆寫使用者手寫內容**。

## 要做
1. `tools/session.mjs`(零依賴、純函式為主,便於測試):
   - `buildBriefing({root, now})`:讀 `next-session-handoff.md`、最新的 `docs/worklog-*.md`、`board/tasks/*.md`(用既有 frontmatter 解析,容忍 CRLF)、最近的 run 狀態(`board/runs/`),回傳 `{lines:[...≤10], sections:{needsYou:[],doing:[],review:[],todo:[]}}`。找不到交接檔要如實回報「找不到交接記錄」,不可編造。
   - `buildWrapUp({root, now, sinceRef})`:彙整今日 `git log`(自上一份 worklog 日期起,用 `git log --since` 以 execFile 呼叫 git,**不得用 shell 字串插值**)、今日狀態有變化的任務、run 結果摘要;輸出 markdown 草稿。
   - `writeWrapUp(...)`:寫入 `docs/worklog-YYYY-MM-DD.md`;若當日檔已存在則寫成 `worklog-YYYY-MM-DD-2.md`(不覆寫);並只更新 `next-session-handoff.md` 內 `<!-- AUTO:BEGIN -->` 與 `<!-- AUTO:END -->` 之間的內容(若檔內沒有標記則在檔尾新增該區塊),標記區塊外一個字都不動。
2. `tools/server.mjs`:`GET /api/session/briefing`、`POST /api/session/wrapup`(受既有 Host/Origin/Content-Type 保護;回傳寫入的檔名與草稿內容)。
3. 前端:頂部新增「開工」「收工」按鈕(新檔 `web/session.js` 或放進既有檔皆可),點「開工」以 modal 顯示簡報;點「收工」先顯示草稿預覽與將寫入的檔名,使用者按確認才呼叫 wrapup。所有動態內容經 escape。
4. 測試 `tests/session.test.mjs`:在 os.tmpdir 沙箱建立假 repo(git init、假任務、假 handoff/worklog)測 briefing(含找不到交接檔)、wrapup(不覆寫既有檔、AUTO 區塊外內容不變、同日第二次寫入用 -2)、以及 server 路由被 Host 保護。**測試不得呼叫真實 CLI,不得碰真實 `board/`、`docs/`。**

## 硬性規則
- 零依賴;不動 `tools/engine.mjs`;不放寬任何核准/安全檢查。
- 你的沙箱若無法 spawn 子行程而跑不了 `npm test`,只跑 `node --check` 與不需 spawn 的測試,並在 Log 註明哪些沒能執行,由 Claude 複核補跑。
- 不要 git commit。完成把 status 改 `review`,在 `## Log` 寫:改了哪些檔、做了什麼、沒能驗證的事、風險。

## 驗收(Claude 複核)
`npm test` 全過;在真實 repo 上呼叫 `/api/session/briefing` 得到合理簡報;wrapup 預覽不覆寫既有檔。

## Log

- run run-1790728677268 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T00:39:18.167Z)

- run run-1790728677268 completed

## 返工要求(Claude 複核不通過,2026-09-30)—— 請 codex-b 接續修正,不要重寫
複核結果:`npm test` 86/86、核准不變式未動、不覆寫/AUTO 區塊/execFile 都對。**但用真實 repo 實測有 2 個缺陷:**
1. **簡報品質不合格**:`GET /api/session/briefing` 的「上次工作日誌」行抓到舊日誌裡一條無關待辦(`3. board/tasks/task-mumqn14s.md ...`);「決策」那行是把一大段(含 markdown `**`、多個 WP 名稱)整段貼上。要求:每行 ≤120 字元(超過截斷加 …)、不含 markdown 強調符號;「上次完成」取交接檔「現況」段落的第一句摘要(找不到才退回日誌「今日完成」段首項);「決策」「風險」各最多 2 項、每項 ≤100 字元;總行數 ≤10。
2. **收工「今日提交」錯誤顯示「無可取得的提交」**,但今天實際有多筆 commit。請查明 `--since=${sinceRef}` 的格式問題(建議以 `YYYY-MM-DDT00:00:00` 本機時間,且 sinceRef 若是 worklog 日期要用該日 00:00);**測試要在暫存 repo 用「今天日期的真實 commit」驗證會被列出**(現有測試沒抓到這個 bug,要補)。
3. 補測試:用本 repo 真實的 `next-session-handoff.md` 與 `docs/worklog-2026-09-30.md` 內容(複製成 fixture)餵 `buildBriefing`,斷言行數 ≤10、每行 ≤120、不含 `**`。
4. `tests/server.test.mjs` 需涵蓋 `GET /api/session/briefing` 與 `POST /api/session/wrapup`(預覽 preview:true 不寫檔;確認時寫檔)。
其他不動。完成後改 `review`,在 Log 寫修正摘要與沒能執行的測試。不要 git commit。

- run run-1790729085985 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T00:45:54.219Z)

- run run-1790729085985 completed

### 2026-09-30 Claude 第二次複核
- 返工修好:簡報 6 行、每行 ≤120 字、無 markdown;收工「今日提交」列出 20 筆(bug 已修)。Mika 新增的 fixture 測試本身漏 `mkdir docs`(ENOENT),由 Claude 補一行修正;`npm test` 88/88。
- 殘留(輕微):「決策」欄目前抓的是舊日誌(UI 配色)決策,與當下工作無關——建議之後只取「最新日誌的決策」且限當日。前端按鈕未經瀏覽器實測。
