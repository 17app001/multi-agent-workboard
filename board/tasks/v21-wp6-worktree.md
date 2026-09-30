---
title: WP6 git worktree 隔離
status: done
agent: codex-b
priority: p2
files: tools/engine.mjs,tools/worktree.mjs
updated: 2026-09-30
---

# WP6 git worktree 隔離

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp3-run-engine(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:codex-b(使用者可改派)。

## 內容與驗收
- project.worktrees=true 時,每個 run 在 worktree 執行(分支 agent/<taskId>);完成產出 diff.patch artifact;提供合併/丟棄操作。
驗收:兩個 run 同時在同 project 跑互不干擾(用測試 repo,不碰真實專案);npm test 全過。

## Log

- run run-1790779048761 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T15:20:59.832Z)

- run run-1790779048761 completed

## 返工要求(Claude 複核,2026-09-30 深夜)—— 請 codex-b 接續,只補測試與必要修正
複核:`npm test` 114/114、gate 零改動、實作含關鍵防護(HEAD 變動拒絕合併、主目錄不乾淨拒絕、啟動失敗 409)。**缺口:測試只覆蓋 happy path(執行→merge/discard)**。請在 `tests/engine.test.mjs`(或 `tests/worktree.test.mjs`)補:
1. **base 已移動**:run 完成後,在主 repo 另外 commit 一次,`POST /merge` 必須 409,且 worktree 與主目錄檔案都保持原狀(驗證主目錄沒被改)。
2. **主目錄不乾淨**:run 完成後在主 repo 留一個未 commit 的修改,merge 必須 409、worktree 保留。
3. **專案不是 git repo 但 `worktrees:true`**:派工必須失敗(409),**agent 一次都沒被呼叫**(用假 CLI 的呼叫紀錄證明),且不可退回在主目錄執行。
4. **untracked 新檔**:agent 在 worktree 新增一個全新檔案,diff.patch 必須包含它(不可悄悄省略),merge 後主目錄有該檔。
5. **discard 執行中被拒**已測;請補「discard 後分支與 worktree 目錄都已移除」的斷言。
若補測試發現實作有 bug 請修並在 Log 說明。`npm test` 不得少於 114;不要 commit;完成改 review 並寫 Log。

- run run-1790781960284 需要你處理(approval): step「plan」已完成,需要你核准(或退回並附意見)後才會繼續

- 計畫已核准 (2026-09-30T15:27:19.502Z)

- run run-1790781960284 completed

### 2026-09-30 Claude 複核(第二輪通過)
- 返工補齊:base 已移動/主目錄不乾淨拒絕合併且保留 worktree、非 git 專案 `worktrees:true` 拒絕啟動且 agent 未被呼叫、untracked 新檔納入 diff.patch 並合併(Mika 同時修掉「遇 untracked 直接拒絕」的實作缺陷)、discard 後分支與目錄皆移除。
- Claude 修一處測試:untracked 測試的斷言在 Windows autocrlf 下期待 LF 卻得 CRLF,改為正規化換行再比對(功能本身正確)。
- `npm test` 117/117(連跑 2 次)、`npm run test:e2e` 6/6;engine.mjs gate/validatePipeline 零改動。
- 未驗證:merge/discard 尚無 UI 按鈕(只有 API);真實專案上的 worktree 未實測(僅暫存 repo)。
