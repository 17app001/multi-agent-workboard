# v2.1 WP1/2/3/9 獨立審查

## 結論

不建議目前就把 WP1/2/3 視為已通過品質關卡並直接全面進入 WP4～8。`standard` 的正常流程確實做到 plan → human gate → execute，但「先核准才執行」不是引擎層的全域不變式，舊 dispatch、`single + noGate`、自訂 pipeline 都能繞過。先修完下列嚴重問題，再進 WP4/6/7；否則 UI 會把不安全的後端路徑包裝得更容易操作。

## 嚴重問題（必修）

### 1. FAIL：execute 前的人工核准可以由多條正式路徑繞過

- 證據：`tools/server.mjs:95-118` 在 `resolvePipelineId()` 回傳空值時直接呼叫舊 `dispatch()`；`tools/engine.mjs:130-141` 在任務沒寫 pipeline、project 的 default pipeline 不存在時回傳 `null`；舊路徑於 `tools/dispatch.mjs:240-262` 直接把任務改成 doing 並以 agent 的可寫參數啟動。
- 證據：`pipelines/single.json:3-8` 宣告 `allowNoGate:true`；`tools/server.mjs:96,113-115` 接受 request body 的 `noGate`；`tools/engine.mjs:199,247-254` 只檢查 pipeline 自己宣告的 gate。`POST /api/dispatch {"id":"...","noGate":true}` 可讓 single 的 execute 在沒有核准下執行。
- 證據：`tools/engine.mjs:35-83` 的 pipeline 驗證只驗 schema，不要求 execute 之前必須有 plan/human gate。本次以目前 `agents.json` 呼叫 `validatePipeline({id:'unsafe',steps:[{id:'code',agent:'codex-a',mode:'execute'}]})`，結果是 `{"ok":true,"errors":[]}`。
- 測試反而固定了繞過行為：`tests/engine.test.mjs:436-451` 把 noGate execute 當成功案例；`tests/engine.test.mjs:464-478` 把無 pipeline 的直接派工當相容性成功案例。因此即使 suite 全綠，也不能證明 spec §0 的承諾。
- 重現：建立沒有 project/pipeline 的任務後呼叫 `/api/dispatch`；或指定 `pipeline: single` 並帶 `noGate:true`；或放入第一步就是 execute 的新 pipeline。
- 建議修法：把「每一條到 execute 的路徑都必須被已核准 human gate 支配」做成 engine validator/runtime invariant。舊任務應自動走 `single` 或 `standard`，project 明示了不存在的 default pipeline 應報錯而不是退回 legacy。若產品真的要保留 noGate，必須先修改 spec §0 的絕對承諾，並讓它成為明確、可稽核的高風險設定，不能只靠 request body。

### 2. FAIL：控制平面沒有來源驗證，且 server 預設不只綁 loopback

- 證據：`tools/server.mjs:73-150` 的專案、任務、派工、approve/reject/retry/resolve/stop API 都沒有 authentication、CSRF token、Origin/Host 或 Content-Type 檢查；`tools/server.mjs:213` 只傳 port 給 `listen()`，Node 會在未指定 host 時監聽 unspecified address，而不只是 `127.0.0.1`。
- 影響：同網段客戶端可直接讀寫 task/project 並啟動 agent；惡意網頁也可用不需 CORS preflight 的 `text/plain` POST 觸發有副作用的 localhost API。結合問題 1，可在未經人核准下啟動 workspace-write agent。approve API 也可被偽造，human gate 並不等同「真的由使用者核准」。
- 建議修法：預設只 listen `127.0.0.1`（如要 IPv6，再明確處理 `::1`）；啟動時產生 session secret，所有 mutation 與 approve 都要求 token；拒絕未知 Origin/Host 與非 JSON request。若未來要 LAN 使用，另做明確開關與認證，不要沿用無保護模式。

### 3. FAIL：任務欄位可造成 stored XSS，進而呼叫同源控制 API

- 證據：`tools/server.mjs:121-130` 允許 API 寫入 title/files；`web/index.html:135` 直接插入 `${t.title}`，`web/index.html:140` 直接插入 `${t.files}`，兩者都沒有經過 `esc()`。同一區的 goal 已在 `web/index.html:139` 正確 escape，證明這不是模板限制。
- 重現/推理：title 設成 `<img src=x onerror="fetch('/api/dispatch',...)\">` 後開看板即可在 workboard origin 執行腳本；這能讀取 API 回應、核准 gate、派工或刪除任務。
- 建議修法：所有來自 task/project/config 的字串一律走 context-aware escaping；attribute 值一律加引號。加一個含 `<img onerror>`、引號與 `&` 的渲染測試，驗證輸出只顯示文字。

## 中等問題

### 4. PARTIAL：agy 的串流回覆沒有真正累積，artifact 可能只剩最後一個 delta

- 證據：`tools/adapters/agy.mjs:29-34` 把每個 `text_delta` 都各自產生一個 message；`tools/adapters/agy.mjs:37-43` 的 result 同時提供完整 `response`。但 `tools/engine.mjs:449-463` 只保留最後一個 message，`tools/engine.mjs:521-524` 又優先使用 `lastMessage` 而不是完整的 `endText`。
- 影響：多段 agy 回覆的 plan.md/review.md 可能只含最後一小段；review 的 `VERDICT:` 也可能因此被誤判 FAIL。現有 fixture 只有一個非空 delta（`tests/fixtures/agy-plan-sample.jsonl:3-5`），`tests/adapters.test.mjs:122-133` 只測單段解析，抓不到這個整合錯誤。
- 建議修法：定義 adapter 的 final-text contract；agy 優先使用 result.response，或由 parser 依 conversation/step 累積 delta。新增「兩個以上 delta + 完整 result.response」的 engine artifact 測試。

### 5. PARTIAL：宣告的 artifact input 遺失時仍會繼續執行

- 證據：`tools/engine.mjs:400-415` 讀不到 input 時只把 `(尚未產生)` 填進 prompt；`tools/engine.mjs:67-68` 只驗檔名格式，不驗 input 是否有先前 producer；step 啟動前也沒有 hard fail。
- 影響：自訂 pipeline、檔案損毀或錯誤 loop 設定可讓 execute/review 在缺 plan.md/review.md 時繼續，交接表面存在、實際失效。
- 建議修法：載入 pipeline 時驗證每個必要 input 都由可到達的先前 step 產出；runtime 啟動 step 前再次檢查檔案存在。若需要 optional input，新增明確欄位，不能把缺檔默默轉成普通文字。

### 6. PARTIAL：run/events 的落地失敗與 crash consistency 被靜默忽略

- 證據：`tools/engine.mjs:147-149` 直接覆寫 run.json 並吞掉所有錯誤；`tools/engine.mjs:158-162` 吞掉 events.jsonl append 錯誤；`tools/engine.mjs:119-127` 也吞掉 task status 寫入失敗。`startRun()` 仍會在這些狀態未可靠落地後 spawn agent（`tools/engine.mjs:227-234,479-505`）。
- 影響：磁碟滿、檔案鎖或寫入中 crash 時，agent 可能已在改檔，但 UI/API 沒有可靠 run/event；非原子覆寫也可能留下截斷 JSON，重啟後 `loadRunFile()` 只回 null（`tools/engine.mjs:155-156`）。這直接傷害「不黑箱」與檔案即資料庫的耐久性。
- 建議修法：run.json 用同目錄 temp + fsync/rename 原子替換；spawn 前的初始 save 失敗必須中止；執行中的 persistence 失敗至少轉 needs-you/stop 並保留可見錯誤，不能全吞。

### 7. PARTIAL：`resolve complete` 會把未完成 step 留成 pending/blocked，卻把整個 run 標 completed

- 證據：`tools/engine.mjs:653-668` 對任何非 approval 的 needs-you 都允許 complete，直接呼叫 `finishRun()`；`tools/engine.mjs:281-287` 不更新當前 step。revision-limit 時 revise 仍是 pending；permission/timeout 時 step 仍是 blocked。
- 影響：未來 Task Detail 會同時顯示「run completed」與「step 未完成」，而且 timeout/permission 未成功也可被當成成功完成。`tests/engine.test.mjs:303-324` 只斷言 run/task completed，沒有驗 step 最終狀態。
- 建議修法：只允許 revision-limit 使用 ignore-and-complete；將當前 step 標成 `waived`/`skipped` 並記錄操作者與理由。permission/timeout 應提供 retry/abort，若仍允許強制完成，API 名稱與事件要明確寫 `force-complete`。

### 8. PARTIAL：shell 執行邊界過寬，且 Windows shell 包裝缺少注入測試

- 證據：command step 在 `tools/engine.mjs:539-567` 將 pipeline 的整段 command 交給 `spawn(...,{shell:true})`；taskkill 在 `tools/engine.mjs:358-365`、`tools/dispatch.mjs:188-201` 用 `exec()` 字串插值 pid，重啟後 pid 來自未驗型別的 run.json/state.json；Windows `.cmd/.bat` 包裝在 `tools/dispatch.mjs:126-137` 手工拼接 `cmd.exe /c` 字串，prompt 內含 title/goal/acceptance/artifact 等使用者或 LLM 文字。
- 判定：目前內建 command 是固定的 `npm test`，pid 正常由 spawn 產生，沒有看到可由 HTTP 直接寫 pipeline/run JSON 的路徑，所以不把它定為已證實的遠端命令注入；但這些都是控制平面的 shell trust boundary，不能只靠「檔案通常可信」。本 sandbox 禁止 Node 再 spawn 子行程，未能動態驗證 `.cmd` 特殊字元。
- 建議修法：D3 先定案。command step 改成 `{command,args}` 並以 `shell:false` 執行，或把 shell pipeline 標成明確 trusted-only；taskkill 改 `execFile('taskkill',['/pid',String(pid),'/T','/F'])` 並要求正整數 pid；為 `.cmd` 加 `% ! ^ & | < > "` 的 Windows argv 測試。

### 9. PARTIAL：engine 實際依賴未寫進 spec 的 `parseLineEvents` 介面

- 證據：spec `docs/v2.1-spec.md:93-100` 定義 adapter 只需 `buildCommand` 與 `parseLine`；engine 卻在 `tools/engine.mjs:428-463` 直接呼叫 `adapter.parseLineEvents()`。目前四個內建 adapter 恰好都有它，但符合 spec 的第三方 adapter 會在 runtime 被 catch 成空事件，失去可觀測性與 artifact。
- 建議修法：二選一：把 `parseLineEvents` 正式加入 spec/validator，或 engine 只依賴 `parseLine` 並以標準方式展開多事件。不要讓介面文件與真正的 runtime contract 分裂。

### 10. PARTIAL：使用者文字與 LLM artifact 沒有可靠的 prompt trust boundary

- 證據：`tools/engine.mjs:406-424` 直接把 title/goal/acceptance、artifact、feedback、approval note 串成同一層指令；execute 的「只做核准範圍」只是自然語言（`tools/engine.mjs:394-397`），引擎沒有比較實際 diff 與核准計畫。舊 dispatch 也直接把欄位插進 prompt（`tools/dispatch.mjs:241-249`）。
- 影響：惡意/誤導的 task 欄位或 plan/review artifact 能指示 execute agent 忽略紀律。對單機本人輸入風險較低，但問題 2 讓輸入不再能假設只來自本人。
- 建議修法：把資料區塊明確標為 untrusted content，固定優先序「engine discipline > approved plan > task data > review text」；approval 對 plan 內容記 hash；WP6 產出 diff 後檢查改動路徑是否落在核准範圍，超出就 needs-you。

## 輕微問題

### 11. Project 驗證時機與錯誤呈現跟 spec 不完全一致

- 證據：spec `docs/v2.1-spec.md:50-55` 說 server 啟動時驗證；實作在 GET/dispatch 即時驗證（`tools/server.mjs:40-46`、`tools/engine.mjs:201-207`）。壞 JSON 在 `tools/server.mjs:43-45` 被直接略過，UI 看不到「無效 project」與原因。
- 建議修法：即時驗證可以保留（比只在啟動更好），但應將 parse error 也回傳成 `{valid:false,error}`，並更新 spec 說明實際時機。

### 12. WP9 adapter 已註冊，但目前沒有可被 pipeline 指派的 agy agent

- 證據：`tools/adapters/index.mjs:1-10` 已有 agy；`agents.json:2-67` 仍只有 claude/codex/gemini，沒有 type=agy。spec `docs/v2.1-spec.md:157-162` 說 agy 取代 gemini。
- 建議修法：在安全完成 artifact 修正與真實 plan/execute smoke test 後，再由獨立設定/WP 將 agy 加入 agents.json；在此前不要把它放進必要 pipeline。

### 13. 任務欄位只移除 `\n`，沒有移除單獨的 `\r`

- 證據：`tools/server.mjs:128` 使用 `.replace(/\n/g,' ')`；JS multiline regex 會把單獨 `\r` 視為行界，因此後續像 `tools/dispatch.mjs:224` 的 frontmatter regex 可能把欄位值內的 CR 當成新 frontmatter 行。現有 `tests/projects.test.mjs:97-105` 只測 `\n`。
- 建議修法：所有 frontmatter scalar 先用 `.replace(/[\r\n]+/g,' ')`；新增 lone-CR 與 CRLF 注入測試。

## 八項檢查點判定

| # | 判定 | 證據摘要 |
|---|---|---|
| 1. 先計畫、核准後執行 | **FAIL** | `standard` 正常路徑有 gate（`pipelines/standard.json:6-10`、`tools/engine.mjs:304-350`），但 legacy、single noGate、自訂無 gate pipeline 都可繞過；重啟等待核准本身的設計正確（`tools/engine.mjs:729-742`、`tests/engine.test.mjs:493-507`）。 |
| 2. 不黑箱 | **部分** | run.json/events/raw/artifacts 與 API 已能交代 step、pid、事件、錯誤（`tools/engine.mjs:144-186,672-725`）；但 persistence 錯誤全吞，且 SSE/Task Detail 尚待 WP4。 |
| 3. 交互與協調 | **部分** | standard 的 plan/test/review/revise 交接與上限邏輯成立（`tools/engine.mjs:289-354`）；缺 input 不阻擋、agy final text 錯誤、force complete 狀態不一致。 |
| 4. 安全 | **FAIL** | artifact 名稱與 task/project id 有基本防穿越（`tools/engine.mjs:25-27,678-685`；`tools/server.mjs:80-84,124-129`），runtime 沒有 dangerous flag；但控制 API 無保護、stored XSS、shell trust boundary 與 prompt injection 未封。 |
| 5. 零依賴/檔案即資料庫 | **PASS（耐久性有缺口）** | `package.json:1-2` 沒有 dependencies；run/task/project/pipeline 都是可讀檔案。沒有資料庫、Python、React 或 WebSocket。run.json 非原子與吞錯另列問題 6。 |
| 6. Windows 相容 | **部分** | CRLF parse、數字 PID 判活、`taskkill /T /F`、`.cmd` 包裝都有實作（`tools/server.mjs:15-20`、`tools/dispatch.mjs:46-61,76-139`、`tools/engine.mjs:358-370`）；`.cmd` 特殊字元與重啟 command step 未測。 |
| 7. 測試品質 | **部分** | happy path、gate、reject、revision、stop、restart、path traversal 都有針對性測試；但 suite 明確把 gate bypass 當相容性，且缺少本文列出的安全、durability、missing artifact、agy 多 delta、force-complete 狀態測試。 |
| 8. spec 對齊 | **部分** | Node 零依賴、檔案模型、adapter 分層、事件與 run 結構大致一致；gate 絕對承諾、adapter contract、project 驗證時機、agy 替換仍有偏離/矛盾。 |

## 測試品質細查

- `tests/engine.test.mjs:221-245` 對 standard gate 的負向驗證很實在：marker、呼叫紀錄、step 狀態與 raw log 四層都檢查；不是只看 HTTP 200。
- `tests/engine.test.mjs:436-491` 同時說明最大盲點：noGate 與 legacy 直接 execute 被測成預期功能，跟 spec §0 的產品承諾相反。
- `tests/projects.test.mjs:31-44` 只複製 tools，沒有複製 pipelines；`tests/projects.test.mjs:115-138` 所謂 project dispatch 因 default pipeline 檔不存在而實際走 legacy。它驗到 cwd，沒有驗到「project.defaultPipeline 自動進 engine」。
- `tests/adapters.test.mjs:75-87` 主要逐行呼叫單事件 `parseLine()`，沒有驗 engine 使用的 `parseLineEvents()` 完整 contract；agy 也沒有多 delta 聚合案例。
- 缺少：HTTP Origin/Host/CSRF、server bind address、title/files XSS、execute-only pipeline 拒絕、defaultPipeline typo 拒絕、run.json 原子/寫入失敗、缺 artifact、command failure 遇到 conditional review、`.cmd` argv 特殊字元、多 run 併發、resolve complete 的 step 終態。

## spec 與實作偏離清單

1. `docs/v2.1-spec.md:9` 的「一定先核准」與 `docs/v2.1-spec.md:81,154` 允許 single 關 gate 互相矛盾；實作選擇允許 noGate，且另保留 legacy/custom bypass。這要先由 owner 決策，不能同時宣稱兩者都成立。
2. spec §5.1 只定義 `parseLine`，engine 實際需要 `parseLineEvents`。
3. spec §4.1 說啟動時驗證 project；實作改為 GET/dispatch 時驗證，壞 JSON 直接消失。
4. spec §5.3/WP2 要求三 CLI execute 組合實測；`tools/adapters/{claude,codex,gemini,agy}.mjs` 檔頭都仍明記 execute 未實跑。這是已揭露但未完成的驗收項。
5. spec §10 說 agy 取代 gemini；目前只有 adapter，agents.json/pipeline 尚未整合。
6. spec §4.5 的 diff.patch 交接尚未出現在 standard pipeline；這可視為 WP6 的預定工作，但在 WP6 前 review 仍依賴 agent 自己讀 working tree，尚未形成可攜的審查 artifact。

## 我沒能驗證的事

- 完整 `npm test`：本環境的 Node test runner 在載入每個 test file 前 spawn worker 即回 `EPERM`，結果為 5 個檔案級失敗、0 個 assertion 執行。改用 `--test-isolation=none` 後，adapter + usage 純函式測試 24/24 通過；engine 的 19 個測試仍在 before hook 啟動隔離 server 時統一 `spawn EPERM`，沒有進入各案例。所有 `tools/*.mjs` 與 adapter 的 `node --check` 通過，且測試前後 `board/tasks` 檔名清單一致。
- 真實 claude/codex/agy 的 execute 模式；依規則本次沒有呼叫真實 CLI。WP log 也承認這些組合尚未煙霧測試。
- Windows `.cmd/.bat` 包裝對 `% ! ^ & | < > "` 的真實 argv 行為；嘗試以 Node 子行程做無害測試時同樣被 sandbox 的 `spawn EPERM` 擋住。
- 實際 LAN/瀏覽器 CSRF exploit 與 server bind socket；判定來自 HTTP 程式碼與 Node listen 語意，沒有在本環境另起真 server。
- 重啟接手、taskkill 行程樹與 command step 的本次動態結果；只能審查實作與測試碼，無法在此 sandbox 執行那些 child-process 案例。
