---
title: WP3 Run 引擎、Pipeline 與計畫核准關卡
status: review
agent: claude
priority: p0
files: tools/engine.mjs,tools/dispatch.mjs,tools/server.mjs,pipelines
updated: 2026-09-30
---

# WP3 Run 引擎、Pipeline 與計畫核准關卡

**先讀**:AGENTS.md、docs/v2.1-spec.md(§3 架構決策不可擅改、§8 驗收總則)。
**依賴**:v21-wp2-adapters(依賴的任務卡未到 review/done 前不要開工)。
**建議 owner**:claude(使用者可改派)。

## 內容與驗收
- pipelines/*.json 載入與驗證(spec §4.4),內建 standard 與 single。
- Run 目錄結構(spec §4.5)、step 之間以 artifacts 交接。
- human gate:plan step 完成後進 needs-you;新增 POST /api/runs/:id/approve 與 /reject(帶意見)。核准前不得啟動 execute 類 step。
- 回修迴圈 maxRevisions;超限進 needs-you。
- 停止/重試/續跑。舊 board/runs 的 log 與 state.json 相容或遷移。
驗收:用假 CLI 腳本測完整流程(plan→gate→execute→test→review FAIL→revise→PASS)、gate 未核准時 execute 不會啟動、超限進 needs-you、stop 砍整棵行程樹;npm test 全過。

## Log

### 2026-09-30 WP3 完成(sonnet subagent 實作,指揮官複核)
- 新增 `tools/engine.mjs`、`pipelines/{standard,single}.json`、`tests/engine.test.mjs`(19)、`tests/fixtures/fake-cli.mjs`;改 `tools/server.mjs`(/api/runs/*、/api/pipelines、status 對映)、`tools/dispatch.mjs`(僅 export 兩個函式)。`npm test` 56/56。
- 已知未涵蓋:.cmd 包裝路徑、重啟後接手 command step、loopTo 回更早 step、併發多 run、posix 分支、真實 CLI execute 模式;plan.md 取「最後一則 message」對真實 CLI 是否完整未驗證(下一步用真實 claude 煙霧測試)。
