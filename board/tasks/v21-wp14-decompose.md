---
title: WP14 需求自動拆解(規劃者拆成多張任務卡)
status: backlog
agent: agy
priority: p1
files: tools/decompose.mjs,tools/server.mjs,pipelines,web,tests
updated: 2026-09-30
---

# WP14 需求自動拆解(規劃者拆成多張任務卡)

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3、§6、§8、§10、§11)、docs/review-codex-1.md(XSS/Host 規則)。**依賴**:WP5 完成後開工。

## 目標
使用者丟一句大需求 + 選 project,由「規劃者」(預設 claude,plan 唯讀模式)產出任務拆解草案,**使用者在畫面上確認/編輯後才真正建立任務卡**。
## 要做
1. `pipelines/decompose.json`:單一 plan step(唯讀)+ human gate;要求輸出格式固定:JSON 陣列 `[{title,goal,acceptance,files,agentSuggestion,dependsOn}]`,agentSuggestion 只能是 agents.json 存在的 id 或 pool;引擎沿用現有機制(gate 不變式不動)。
2. `tools/decompose.mjs`:`parseDecomposition(text)` 嚴格驗證 JSON(欄位型別、長度上限、id 字元、dependsOn 只能指向同批的 index、最多 12 張),不合法回明確錯誤,**絕不執行輸出內容**;`createTasksFromDraft(draft, project)` 只在使用者確認後建立 board/tasks/*.md(id 用安全產生規則,不覆寫既有檔)。
3. API:`POST /api/decompose`(建 run)、`POST /api/decompose/:runId/confirm`(帶使用者編輯後的清單)。UI:「＋需求拆解」入口,顯示草案表格可編輯/刪除列,按確認才建卡。
4. 建好的卡預設 status=backlog(不自動派工),dependsOn 寫進任務 frontmatter `dependsOn`(僅記錄與顯示,派工時若依賴未 done 則提示)。
驗收:parseDecomposition 對惡意/畸形輸入的單元測試;假 CLI 走完整流程(產草案→gate→確認→建卡);不會建立超過上限的卡;Host/Origin 保護沿用。

## 共同硬性規則
- 零依賴;不放寬核准關卡不變式(`tools/engine.mjs` 的 gate 驗證);所有動態字串 escape;測試用假 CLI + 暫存沙箱,不碰真實 board/;你的沙箱若跑不了 spawn 測試請註明,由 Claude 補跑;不要 git commit;完成改 `review` 並在 Log 寫摘要與未驗證項;`npm test` 不得少於目前數量(95)。

## Log
