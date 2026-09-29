# Multi-Agent Workboard v2 — 實作與功能建議

## 1. 產品重新定位

目前這個 App 最大的問題不是功能太少，而是操作邏輯仍然偏向一般 Kanban，看不出「AI 團隊正在幫你工作」。

建議把產品定位為：

> **Multi-Agent Control Center = AI 開發團隊的任務調度中心、執行監控台與協作平台**

首頁第一眼應該回答四個問題：

- 現在誰在做什麼？
- 做到哪裡？
- 有沒有卡住？
- 需要我介入嗎？

而不是優先顯示大量 Token、成本與統計資訊。

---

# 2. 首頁重新設計

建議把首頁從「大面積 Agent Token 卡 + Kanban」改成：

```text
┌────────────────────────────────────────────────────────────────────┐
│ AI Workboard     Project: AI-Orchestrator         ＋ 建立任務       │
├───────────────┬────────────────────────────────────┬───────────────┤
│ AGENTS        │ 任務                               │ ACTIVITY      │
│               │                                    │               │
│ ● Claude      │ [RUNNING] 建立會員登入 API         │ Claude        │
│   Planner     │ Planner ✓ → Coding ● → Review ○   │ 完成 spec     │
│               │                                    │ 09:41         │
│ ● Codex A     │ Codex A 正在修改 4 個檔案           │               │
│   Coding      │ ███████████░░░  68%                │ Codex A       │
│               │                                    │ pytest 18/20 │
│ ○ Codex B     │ [TODO] 重構資料庫                   │               │
│   Standby     │                                    │ Gemini        │
│               │ [REVIEW] Dashboard bug fix         │ 等待 review   │
│ ● Gemini      │                                    │               │
│   Reviewer    │                                    │               │
├───────────────┴────────────────────────────────────┴───────────────┤
│ 今日 $3.81 │ Tokens 31.4M │ 3 Running │ 1 Waiting │ 0 Failed      │
└────────────────────────────────────────────────────────────────────┘
```

### 首頁資訊優先順序

1. 執行中的任務
2. 需要人工介入的任務
3. Agent 狀態
4. 最近 Activity
5. 今日成本 / Token

Token 與成本仍然保留，但不要佔據主畫面主要空間。

---

# 3. 新任務流程簡化

目前建立 Task 後還需要手動：

```text
建立 Task
→ 未指派
→ 選 Agent
→ 開 Log
→ 自己改狀態
```

操作成本太高。

建議改成：

```text
＋ 新任務

任務
────────────────────────────
我要建立會員登入 API

工作目錄
/home/merdury/project-a

工作模式
● 自動開發
○ 單一 Agent
○ 自訂流程

Pipeline
Claude Planner
      ↓
Codex A Coding
      ↓
Gemini Review
      ↓
Codex 修正
      ↓
Done

                [開始執行]
```

使用者最基本只需要填：

- 我要做什麼
- 哪一個 Project

然後按：

> **▶ 開始執行**

剩下交給系統。

---

# 4. 任務狀態重新設計

目前：

```text
backlog → todo → doing → review → done
```

對 Multi-Agent 系統不夠。

建議內部狀態改為：

```text
draft
queued
planning
coding
testing
reviewing
revising
completed

blocked
failed
cancelled
```

但 UI 不需要全部攤開。

首頁只需要顯示：

```text
待執行
執行中
需要你處理
完成
```

使用者真正需要知道的是：

- 還在跑嗎？
- 卡住了嗎？
- 要不要我決定？
- 做完了嗎？

---

# 5. Task Card 重做

目前卡片資訊：

```text
測試agent多協作模式

[未指派 ▼] P1

📜 log  🗑刪除
```

資訊量太少。

建議改成：

```text
┌────────────────────────────────────────────┐
│ ● RUNNING                                  │
│                                            │
│ 測試 Agent 多協作模式                       │
│                                            │
│ Claude → Codex A → Gemini                  │
│          ↑ 現在                            │
│                                            │
│ 正在執行                                   │
│ pytest tests/test_api.py                   │
│                                            │
│ ████████████░░  Coding                     │
│                                            │
│ 12m 31s   $0.42   1.8M tokens              │
│                                            │
│ [查看]   [暫停]   [停止]                   │
└────────────────────────────────────────────┘
```

重點：

- 顯示目前 Agent
- 顯示 Pipeline
- 顯示目前正在做的事情
- 顯示時間
- 顯示成本
- 顯示 Token
- 可直接暫停 / 停止

Log 不應該只是一顆小按鈕。

---

# 6. Task Detail 頁面

Task Detail 應該成為整個 App 最重要的頁面。

範例：

```text
建立 Login API
RUNNING                                    Stop ■
──────────────────────────────────────────────

Pipeline

✓ Claude — Planning                 2m 14s
│
● Codex A — Implementation          8m 43s
│
○ Tests
│
○ Gemini — Review
│
○ Complete


目前執行
──────────────────────────────────────────────

$ pytest

tests/test_login.py ............... 15 passed
tests/test_auth.py ....F

Fixing:
src/auth/login.py


Artifacts
──────────────────────────────────────────────

📄 spec.md
📝 implementation_plan.md
🔀 Git Diff · 5 files
🧪 Tests · 15 / 16
📋 review.md


▾ Agent output
──────────────────────────────────────────────
Codex:
I found an issue in JWT expiration...
```

目標：

> 不需要一直開 Terminal，也能知道 AI 做到哪裡。

---

# 7. Agent 架構

不要把 Claude、Codex、Gemini 的邏輯直接寫死在 orchestrator。

建議抽象成：

```python
class AgentAdapter:
    async def run(
        self,
        prompt: str,
        workspace: str,
        context: dict,
    ) -> AgentResult:
        ...
```

然後：

```python
class ClaudeAdapter(AgentAdapter):
    ...

class CodexAdapter(AgentAdapter):
    ...

class GeminiAdapter(AgentAdapter):
    ...
```

Workflow Engine 只需要：

```python
await agent.run(...)
```

不需要知道底層是：

```bash
claude
codex
gemini
```

未來才能方便加入：

```text
Codex B
Gemini 2
Local Llama
OpenAI API
Claude API
```

---

# 8. Pipeline 不應寫死

不要這樣：

```python
run_claude()
run_codex()
run_gemini()
```

建議改成 YAML / JSON 定義。

例如：

```yaml
name: standard-development

steps:

  - id: planning
    agent: claude
    role: architect
    output:
      - spec.md

  - id: coding
    agent: codex-a
    role: developer
    input:
      - spec.md

  - id: testing
    type: command
    command: pytest

  - id: review
    agent: gemini
    role: reviewer

  - id: revise
    agent: codex-a
    when: review.failed

  - id: finish
    when: review.passed
```

未來 UI 可以視覺化成：

```text
Claude
  ↓
Codex
  ↓
Test
  ↓
Gemini
  ├── PASS → Done
  │
  └── FAIL
        ↓
      Codex
        ↓
      Gemini
```

這才是真正的 Multi-Agent Workflow。

---

# 9. Review Loop 必須限制次數

不能讓：

```text
Gemini 說不好
↓
Codex 改
↓
Gemini 說不好
↓
Codex 改
↓
...
```

無限循環。

建議：

```python
max_revision_cycles = 3
```

超過三次後：

```text
⚠ Needs Human

Gemini review failed 3 times.

主要問題：
1. API authentication test failed
2. Missing validation
3. Database migration incomplete

[讓 Codex 再試一次]
[我自己處理]
[忽略並完成]
```

這就是 Human-in-the-loop。

---

# 10. Project / Workspace

不要只有 Task。

建議加入 Project 層：

```text
Projects

AI-Orchestrator
Company-RAG
Tablet-3D
Experiment
```

每個 Project 綁定：

```text
workspace path
git repository
default branch
agent permissions
pipeline
environment
```

例如：

```text
Project
AI-Orchestrator

Path
/home/merdury/AI-Orchestrator

Git
main

Default pipeline
Claude → Codex → Gemini
```

建立 Task 時就不用每次重新設定。

---

# 11. Git 整合

每個 Task 自動建立 branch：

```bash
git checkout -b agent/task-104
```

更推薦使用：

```text
git worktree
```

例如：

```text
/worktrees/task-104
/worktrees/task-105
/worktrees/task-106
```

這樣：

```text
Codex A → task 104
Codex B → task 105
```

可以真正平行開發，而且不會互相踩檔案。

這也是 Codex A / Codex B 存在的主要價值之一。

---

# 12. Usage Dashboard

目前 Token / Cost 統計可以保留，但建議移到 Analytics。

首頁只顯示：

```text
Claude   ● Running
Codex A  ● Running
Codex B  ○ Idle
Gemini   ○ Idle
```

Analytics 頁面才顯示：

```text
        Today    7 Days    Month

Claude   21.8M    64.5M     521M
Codex     5.8M    38.2M
Gemini    0.9M    9.8M

Estimated Cost
$3.81 today
$27.42 7 days
```

另外建議加入：

## Token / Task

```text
Login API
Claude      148K
Codex       832K
Gemini      96K

Total       1.07M
Cost        $0.31
Duration    18m
```

這樣才知道哪個任務最燒資源。

---

# 13. 資料庫設計

建議至少有以下主表：

| Table | 用途 |
|---|---|
| `projects` | Project / Repo |
| `agents` | Claude、Codex、Gemini |
| `tasks` | 任務 |
| `task_runs` | 每一次任務執行 |
| `agent_runs` | 每個 Agent 執行紀錄 |
| `artifacts` | spec、diff、review、test |

另外加入：

```text
usage_events
task_events
```

用途：

- Token 統計
- 成本統計
- Activity Timeline
- Agent 執行歷史
- Debug

---

# 14. Backend 架構

既然現有 orchestrator 已經是 Python，不建議為了 Web UI 把後端改成 Node。

推薦：

```text
Frontend
React / TypeScript

        ↓ REST
        ↓ SSE / WebSocket

FastAPI
        │
        ├─ Task API
        ├─ Agent API
        ├─ Pipeline Engine
        ├─ Usage Service
        └─ Event Stream
             │
             ▼
       Agent Runner
       ├ Claude CLI
       ├ Codex CLI
       └ Gemini CLI
```

第一階段不必急著加入：

- Redis
- Celery
- Kafka

先用：

```python
asyncio.create_subprocess_exec()
```

就足夠。

等未來真的需要：

- 多機器
- 多 Worker
- 大量 Queue
- 分散式 Agent

再加入 Redis / Celery。

---

# 15. 第一批應該實作的 10 個功能

1. Project / Workspace 管理
2. 超簡單 New Task
3. Pipeline Template
4. Run / Stop / Retry
5. 即時 Terminal Output
6. Claude → Codex → Gemini Handoff
7. Review → Revision Loop
8. Artifacts / Git Diff
9. Human Intervention
10. Task 級 Token / Cost / Duration

---

# 16. Kanban 降級成第二視圖

首頁不要再把 Kanban 當唯一操作模式。

建議首頁：

```text
Tasks

All   Running 3   Need you 1   Completed 18
────────────────────────────────────────────

● Login API
  Codex A · Coding
  68% · 8m

⚠ Database migration
  Gemini Review
  Needs decision

○ README refactor
  Queued

✓ Calculator CLI
  Completed · 13m
```

Kanban 保留成：

> **Board View**

即可。

---

# 17. 最重要的 UX 原則

這個 App 的核心不應該是：

> Drag & Drop 看板

而應該是：

> **按下「開始」後，我可以離開；回來時立刻知道 AI 做到哪裡、有沒有卡住、需要我做什麼。**

這才是 Multi-Agent Workboard 真正的產品價值。

---

# 18. 建議實作順序

```text
STEP 1
Task / Run / Agent Run 資料模型

        ↓

STEP 2
統一 AgentAdapter

        ↓

STEP 3
Execution Engine

        ↓

STEP 4
Claude → Codex → Gemini Pipeline

        ↓

STEP 5
SSE 即時 Log

        ↓

STEP 6
新的 Task Detail UI

        ↓

STEP 7
重新做 Dashboard

        ↓

STEP 8
Git worktree / parallel Agents
```

---

# 19. 核心結論

目前版本已有：

- Agent 監控
- Token / Cost 統計
- Kanban 任務管理
- 基本 Agent 指派

但真正缺少的是：

```text
建立任務
↓
自動拆解
↓
Agent 執行
↓
Agent Handoff
↓
測試
↓
Review
↓
自動回修
↓
Human Intervention
↓
Done
```

下一版應優先強化 Backend Workflow，而不是繼續美化 Kanban。

目標應該是：

> **一個真的可以把工作交出去的 Multi-Agent 工作系統，而不只是 AI 看板。**
