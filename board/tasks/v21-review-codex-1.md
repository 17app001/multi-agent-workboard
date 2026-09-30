---
title: 審查 v2.1 已完成工作(WP1/2/3/9)是否符合 workboard 理念
status: done
agent: codex-a
priority: p1
files: docs/review-codex-1.md
updated: 2026-09-30
---

# 獨立審查(只讀程式碼,只寫一份報告)

**你是審查者,不是實作者。不要修改任何程式碼、不要 git commit。只新增 `docs/review-codex-1.md`。**

**先讀**:AGENTS.md、docs/v2.1-spec.md(尤其 §0 目標、§3 架構決策、§4、§5、§10)。
**審查範圍**:tools/engine.mjs、tools/dispatch.mjs、tools/server.mjs、tools/adapters/*.mjs、pipelines/*.json、web/index.html(WP1 新增部分)、tests/。

## 「workboard 理念」的檢查點(逐條給 PASS/FAIL/部分 + 證據 file:line)
1. **先計畫、核准後才執行**:任何路徑(含 retry、resolve、舊 dispatch、server 重啟後接手)是否有辦法在 plan gate 未核准時啟動 execute 類 step?請主動找繞過方法。
2. **不黑箱**:使用者能否從 API/事件看出誰在做什麼、做到哪、失敗原因?events.jsonl 是否涵蓋關鍵轉折?
3. **交互與協調**:step 之間的交接(artifacts)是否真的傳給下一個 agent?回修迴圈與上限是否正確?
4. **安全**:路徑穿越、命令注入(command step 的 shell 執行、prompt 內含使用者輸入)、是否有任何 `--dangerously-*`、是否會誤寫真實 board/。
5. **零依賴/檔案即資料庫**原則是否被違反。
6. **Windows 相容**(taskkill 行程樹、.cmd、中文系統輸出、CRLF)。
7. **測試品質**:哪些關鍵行為沒被測到?有沒有「測試通過但其實沒驗到東西」的測試?
8. spec 與實作的偏離清單。

## 報告格式(docs/review-codex-1.md)
最上面一段「結論」(是否建議進入 WP4~8,3 行內)。接著:嚴重問題(必修)、中等、輕微;每項含 file:line、重現/推理、建議修法。最後列「你沒能驗證的事」。誠實優先,不要客套。

## Log

- 2026-09-30 codex-a：完成 WP1/2/3/9 獨立唯讀審查，新增 `docs/review-codex-1.md`。結論是不建議先把 WP1～3 視為通過品質關卡：確認 legacy dispatch、`single + noGate` 與自訂無 gate pipeline 都能繞過「先核准才 execute」；另發現控制 API 未限制 loopback/未做來源驗證、task title/files stored XSS、agy 多段 delta artifact 可能截斷、missing artifact 仍繼續、run/events 寫入吞錯、force-complete step 狀態不一致等問題。未修改任何程式碼、其他 agent 任務或 CLI 設定。
- 驗證：`node --check` 對 engine/dispatch/server/全部 adapters 通過；`node --test --test-isolation=none tests/adapters.test.mjs tests/usage.test.mjs` 24/24 通過；測試前後 `board/tasks` 檔名清單一致。完整 `npm test` 在本 sandbox 由 Node test runner spawn worker 時 5 個 test file 全部 `EPERM`、未進入 assertion；engine isolation=none 的 19 個案例也都在 before hook spawn 隔離 server 時被 `EPERM` 擋住。
- 未完成/風險：未呼叫真實 CLI；未能動態驗證 server 重啟、Windows `.cmd` 特殊字元、taskkill、LAN/CSRF。完整證據、重現推理、建議修法與 spec 偏離見報告。
