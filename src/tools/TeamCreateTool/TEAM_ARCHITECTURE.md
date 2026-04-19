# Team (Agent Swarms) 架构分析文档

> **分析范围**: `src/tools/TeamCreateTool/` 及所有相关的 team/swarm 功能  
> **代码版本**: 基于当前 `main` 分支

---

## 目录

1. [核心架构概览](#1-核心架构概览)
2. [组织方式：Team → Leader → Teammates](#2-组织方式team--leader--teammates)
3. [三种 Teammate 后端](#3-三种-teammate-后端)
4. [工具体系](#4-工具体系)
5. [提示词 (Prompts)](#5-提示词-prompts)
6. [沟通方式：Mailbox 消息系统](#6-沟通方式mailbox-消息系统)
7. [Teammate 生命周期：Spawn → Run → Idle → Shutdown](#7-teammate-生命周期spawn--run--idle--shutdown)
8. [Skill 共享与隔离](#8-skill-共享与隔离)
9. [MCP Server 共享与隔离](#9-mcp-server-共享与隔离)
10. [工具集共享与隔离](#10-工具集共享与隔离)
11. [权限同步机制](#11-权限同步机制)
12. [共享与隔离总结对比表](#12-共享与隔离总结对比表)

---

## 1. 核心架构概览

Team（内部称 Agent Swarms）是一个多 Agent 协作系统，采用 **Leader-Teammates** 的层级结构。核心设计理念是：

```
┌────────────────────────────────────────────────────────────────┐
│                        Team (Swarm)                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Team Lead (Leader)                                      │  │
│  │  - 创建/管理 Team                                         │  │
│  │  - 分配任务给 Teammates                                    │  │
│  │  - 接收 Teammate 消息和权限请求                              │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │ 通过 Agent Tool spawn                     │
│         ┌───────────┼───────────┐                               │
│  ┌──────▼────┐ ┌────▼──────┐ ┌──▼──────────┐                   │
│  │ Teammate A│ │ Teammate B│ │ Teammate C  │                   │
│  │ (tmux)    │ │ (iTerm2)  │ │ (in-process)│                   │
│  └──────┬────┘ └────┬──────┘ └──┬──────────┘                   │
│         │           │           │                               │
│  ┌──────▼───────────▼───────────▼──────────────────────────┐   │
│  │            Shared Task List (Team = TaskList)            │   │
│  │     ~/.claude/tasks/{team-name}/                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │            File-based Mailbox (Inboxes)                  │   │
│  │     ~/.claude/teams/{team}/inboxes/{agent}.json          │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

**核心数据结构**：

| 概念 | 存储位置 | 说明 |
|------|---------|------|
| Team 配置 | `~/.claude/teams/{team-name}/config.json` | `TeamFile` 类型，存储团队元信息和成员列表 |
| Task 列表 | `~/.claude/tasks/{team-name}/` | Team = TaskList，1:1 对应 |
| Agent 邮箱 | `~/.claude/teams/{team}/inboxes/{agent}.json` | 文件级消息队列 |
| Agent ID | `agentName@teamName` | 确定性 ID，可预测、可重连 |

> **代码出处**: `src/tools/TeamCreateTool/TeamCreateTool.ts` 第 157-175 行（TeamFile 创建）；`src/utils/agentId.ts`（确定性 ID 格式）

---

## 2. 组织方式：Team → Leader → Teammates

### 2.1 Team 创建流程

当 Leader 调用 `TeamCreate` 工具时，执行以下步骤：

1. **生成唯一 Team 名称** — 如果提供的名称已存在，自动生成新的 word slug
2. **生成 Leader 的确定性 Agent ID** — 格式 `team-lead@{teamName}`
3. **创建 `TeamFile` (config.json)** — 包含 team 描述、成员列表、leader 信息
4. **创建 Task List 目录** — `~/.claude/tasks/{team-name}/`，编号从 1 开始
5. **注册 Session 清理** — 确保 session 结束时清理 team 资源
6. **更新 AppState** — 设置 `teamContext`，包含 teammates 映射

```typescript
// src/tools/TeamCreateTool/TeamCreateTool.ts 第 157-175 行
const teamFile: TeamFile = {
  name: finalTeamName,
  description: _description,
  createdAt: Date.now(),
  leadAgentId,
  leadSessionId: getSessionId(),
  members: [
    {
      agentId: leadAgentId,
      name: TEAM_LEAD_NAME,       // 'team-lead'
      agentType: leadAgentType,
      model: leadModel,
      joinedAt: Date.now(),
      tmuxPaneId: '',
      cwd: getCwd(),
      subscriptions: [],
    },
  ],
}
```

> **代码出处**: `src/tools/TeamCreateTool/TeamCreateTool.ts` 第 128-236 行

### 2.2 Teammate 生成流程

Teammates 通过 **Agent Tool** 的 `team_name` + `name` 参数创建，由 `spawnMultiAgent.ts` 调度到三种后端之一。

> **代码出处**: `src/tools/AgentTool/AgentTool.tsx`、`src/tools/shared/spawnMultiAgent.ts`

### 2.3 Leader 的特殊身份

- Leader **不是** teammate：`isTeammate()` 对 leader 返回 `false`
- Leader 的 `CLAUDE_CODE_AGENT_ID` **不会**被设置为环境变量
- Leader 的 ID 可通过 `team-lead@{teamName}` 确定性推导

> **代码出处**: `src/tools/TeamCreateTool/TeamCreateTool.ts` 第 224-228 行注释

---

## 3. 三种 Teammate 后端

Team 系统支持三种 Teammate 执行后端，定义在 `BackendType` 类型中：

```typescript
// src/utils/swarm/backends/types.ts 第 9 行
export type BackendType = 'tmux' | 'iterm2' | 'in-process'
```

### 3.1 对比表

| 特性 | Tmux | iTerm2 | In-Process |
|------|------|--------|------------|
| **进程模型** | 独立进程（新 CLI 实例） | 独立进程（新 CLI 实例） | 同一 Node.js 进程 |
| **隔离方式** | 操作系统进程隔离 | 操作系统进程隔离 | `AsyncLocalStorage` 上下文隔离 |
| **MCP 连接** | 独立连接 | 独立连接 | **共享** Leader 的连接 |
| **API Client** | 独立 | 独立 | **共享** Leader 的 |
| **终止方式** | `killPane()` | `killPane()` | `AbortController` |
| **通信方式** | 文件 Mailbox | 文件 Mailbox | 文件 Mailbox（统一） |
| **外部依赖** | tmux 命令 | it2 CLI | 无 |
| **始终可用** | 需要 tmux 安装 | 需要 iTerm2 | ✅ 始终可用 |

### 3.2 In-Process 后端关键注释

```typescript
// src/utils/swarm/backends/InProcessBackend.ts 第 25-37 行
/**
 * InProcessBackend implements TeammateExecutor for in-process teammates.
 *
 * Unlike pane-based backends (tmux/iTerm2), in-process teammates run in the
 * same Node.js process with isolated context via AsyncLocalStorage. They:
 * - Share resources (API client, MCP connections) with the leader
 * - Communicate via file-based mailbox (same as pane-based teammates)
 * - Are terminated via AbortController (not kill-pane)
 */
```

### 3.3 TeammateContext（AsyncLocalStorage 隔离）

In-Process teammate 通过 `AsyncLocalStorage` 实现并发隔离：

```typescript
// src/utils/teammateContext.ts 第 22-39 行
export type TeammateContext = {
  agentId: string          // "researcher@my-team"
  agentName: string        // "researcher"
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string
  isInProcess: true        // 判别标志
  abortController: AbortController
}

const teammateContextStorage = new AsyncLocalStorage<TeammateContext>()
```

身份查询优先级链：
1. **AsyncLocalStorage**（In-Process teammate）
2. **dynamicTeamContext**（运行时加入的进程级 teammate）
3. **环境变量 `CLAUDE_CODE_AGENT_ID`**（tmux/iTerm2 spawned teammate）

> **代码出处**: `src/utils/teammateContext.ts` 第 1-96 行

### 3.4 TeammateExecutor 统一接口

所有后端实现统一的 `TeammateExecutor` 接口：

```typescript
// src/utils/swarm/backends/types.ts 第 279-300 行
export type TeammateExecutor = {
  readonly type: BackendType
  isAvailable(): Promise<boolean>
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>
  sendMessage(agentId: string, message: TeammateMessage): Promise<void>
  terminate(agentId: string, reason?: string): Promise<boolean>
  kill(agentId: string): Promise<boolean>
  isActive(agentId: string): Promise<boolean>
}
```

---

## 4. 工具体系

### 4.1 Team 相关工具列表

| 工具 | 文件位置 | 功能 |
|------|---------|------|
| **TeamCreate** | `src/tools/TeamCreateTool/TeamCreateTool.ts` | 创建 Team 和 Task List |
| **TeamDelete** | `src/tools/TeamDeleteTool/TeamDeleteTool.ts` | 删除 Team，清理成员和目录 |
| **SendMessage** | `src/tools/SendMessageTool/SendMessageTool.ts` | Agent 间消息通信（单播/广播/结构化） |
| **Agent** | `src/tools/AgentTool/AgentTool.tsx` | Spawn teammate 或 fork subagent |
| **TaskCreate** | `src/tools/TaskCreateTool/TaskCreateTool.ts` | 创建新任务 |
| **TaskGet** | `src/tools/TaskGetTool/TaskGetTool.ts` | 获取任务详情 |
| **TaskList** | `src/tools/TaskListTool/TaskListTool.ts` | 列出所有任务 |
| **TaskUpdate** | `src/tools/TaskUpdateTool/TaskUpdateTool.ts` | 更新任务状态、分配 owner |
| **TaskOutput** | `src/tools/TaskOutputTool/TaskOutputTool.tsx` | 获取后台任务输出 |
| **TaskStop** | `src/tools/TaskStopTool/TaskStopTool.ts` | 停止后台任务 |

**共享模块**: `src/tools/shared/spawnMultiAgent.ts` — teammate 生成调度器

### 4.2 工具过滤层次

工具集的可用性通过多层过滤器控制，定义在 `src/constants/tools.ts` 和 `src/tools/AgentTool/agentToolUtils.ts`：

```
ALL_AGENT_DISALLOWED_TOOLS        ← 所有 Agent 都禁止的工具
    ↓
CUSTOM_AGENT_DISALLOWED_TOOLS     ← 自定义 Agent 额外禁止的工具
    ↓
ASYNC_AGENT_ALLOWED_TOOLS         ← 异步 Agent 允许的工具（白名单模式）
    ↓
IN_PROCESS_TEAMMATE_ALLOWED_TOOLS ← In-Process Teammate 额外允许的工具
```

#### 全局禁止列表 (`ALL_AGENT_DISALLOWED_TOOLS`)

```typescript
// src/constants/tools.ts 第 36-46 行
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,       // TaskOutput
  EXIT_PLAN_MODE_V2_TOOL_NAME, // ExitPlanMode
  ENTER_PLAN_MODE_TOOL_NAME,   // EnterPlanMode
  AGENT_TOOL_NAME,             // Agent (除非 ant 用户)
  ASK_USER_QUESTION_TOOL_NAME, // AskUserQuestion
  TASK_STOP_TOOL_NAME,         // TaskStop
  WORKFLOW_TOOL_NAME,          // Workflow (条件性)
])
```

#### 异步 Agent 白名单 (`ASYNC_AGENT_ALLOWED_TOOLS`)

```typescript
// src/constants/tools.ts 第 55-71 行
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,    FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,   GREP_TOOL_NAME,
  GLOB_TOOL_NAME,         WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,    TODO_WRITE_TOOL_NAME,
  ...SHELL_TOOL_NAMES,    NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,        SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
```

#### In-Process Teammate 额外工具 (`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`)

```typescript
// src/constants/tools.ts 第 77-88 行
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  TASK_CREATE_TOOL_NAME,   TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,     TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  // Cron 工具（条件性开启）
  CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME, CRON_LIST_TOOL_NAME,
])
```

#### 过滤逻辑

```typescript
// src/tools/AgentTool/agentToolUtils.ts 第 80-116 行
export function filterToolsForAgent({ tools, isBuiltIn, isAsync, permissionMode }): Tools {
  return tools.filter(tool => {
    // ✅ MCP 工具始终允许
    if (tool.name.startsWith('mcp__')) return true
    // ❌ 全局禁止列表
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    // ❌ 自定义 Agent 额外禁止
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    // 异步 Agent 白名单模式
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // In-Process teammate 可使用 Agent Tool（但禁止 spawn 后台/teammate）
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) return true
        // 可使用 Task/SendMessage 等协调工具
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) return true
      }
      return false
    }
    return true
  })
}
```

---

## 5. 提示词 (Prompts)

### 5.1 TeamCreate 提示词

定义了团队的完整工作流程，包括：

- **何时使用 Team** — 复杂并行任务、用户明确要求
- **Agent 类型选择** — 只读 Agent vs 全能力 Agent vs 自定义 Agent
- **Team 工作流** — 创建 → 任务分配 → 执行 → 通知 → 关闭
- **任务所有权** — 通过 `TaskUpdate` 的 `owner` 参数分配
- **自动消息传递** — 消息自动送达，无需手动检查邮箱
- **Idle 状态** — Teammate 每次 turn 后自动进入 idle，这是正常行为

> **代码出处**: `src/tools/TeamCreateTool/prompt.ts` 第 1-113 行

### 5.2 Teammate 专用提示词附录

每个 Teammate 都会收到一个额外的系统提示附录，包含：

- 如何发现团队成员（读取 config.json）
- 任务列表协调规则
- 消息发送规范

> **代码出处**: `src/utils/swarm/teammatePromptAddendum.ts`

### 5.3 关键提示词规则摘要

| 规则 | 说明 |
|------|------|
| **禁止 JSON 状态消息** | 不要发送 `{"type":"idle",...}` 等结构化消息 |
| **用名称通信** | 始终用 name（如 "researcher"）而非 agentId |
| **自动 idle 通知** | 系统自动发送，无需 teammate 手动处理 |
| **按 ID 顺序处理** | 多任务可用时，优先处理 ID 较小的任务 |
| **必须用 SendMessage** | 团队成员听不到你"说的话"，必须使用工具 |

---

## 6. 沟通方式：Mailbox 消息系统

### 6.1 文件级邮箱

所有后端的 Teammate 统一使用文件级邮箱系统，邮箱位于：

```
~/.claude/teams/{team_name}/inboxes/{agent_name}.json
```

```typescript
// src/utils/teammateMailbox.ts 第 56-66 行
export function getInboxPath(agentName: string, teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const safeAgentName = sanitizePathComponent(agentName)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  return join(inboxDir, `${safeAgentName}.json`)
}
```

### 6.2 消息类型

邮箱支持多种消息类型：

```typescript
// src/utils/teammateMailbox.ts 第 43-50 行
export type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string    // 发送者颜色
  summary?: string  // 5-10 字预览摘要
}
```

### 6.3 结构化消息（SendMessage 工具）

`SendMessage` 工具支持三种结构化消息：

```typescript
// src/tools/SendMessageTool/SendMessageTool.ts 第 46-65 行
z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown_request'), reason: z.string().optional() }),
  z.object({ type: z.literal('shutdown_response'), request_id: z.string(), approve: boolean }),
  z.object({ type: z.literal('plan_approval_response'), request_id: z.string(), approve: boolean }),
])
```

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `shutdown_request` | Leader → Teammate | 请求 Teammate 关闭 |
| `shutdown_response` | Teammate → Leader | 批准/拒绝关闭请求 |
| `plan_approval_response` | Leader → Teammate | 批准/拒绝计划模式 |

### 6.4 文件锁与并发安全

邮箱系统使用文件锁保证并发安全：

```typescript
// src/utils/teammateMailbox.ts 第 35-41 行
const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}
```

### 6.5 广播

`SendMessage` 支持向所有 Teammate 广播（`to: "*"`），遍历 team 成员列表逐个写入邮箱。

---

## 7. Teammate 生命周期：Spawn → Run → Idle → Shutdown

本节详细描述 Teammate 从创建到退出的完整生命周期，包括 Leader 的等待行为、Prompt 派发方式、Idle 循环和终止流程。

### 7.1 Fire-and-Forget Spawn 模式

**核心结论：Leader spawn teammate 后立即返回，不会阻塞等待 teammate 执行完毕。**

#### Leader 端行为

当 Leader 调用 Agent Tool 的 `team_name` + `name` 参数时，`spawnTeammate()` 只等待创建和注册完成，然后立即返回 `status: 'teammate_spawned'`：

```typescript
// src/tools/AgentTool/AgentTool.tsx 第 290-316 行
const result = await spawnTeammate({
  name, prompt, description, team_name: teamName, ...
}, toolUseContext);

const spawnResult: TeammateSpawnedOutput = {
  status: 'teammate_spawned' as const,
  prompt,
  ...result.data
};
return { data: spawnResult } as unknown as { data: Output };
```

`spawnTeammate()` 的 `await` 只等到 teammate 的**创建和注册**完成（注册到 TeamFile、创建 task 状态、准备好 context），然后 Leader 立即继续自己的 model loop —— 可以继续 spawn 更多 teammate、执行其他工具、或与用户交互。

#### In-Process 后端的 Fire-and-Forget 实现

In-Process 后端的关键在于 `startInProcessTeammate()` 是一个 **`void` 函数**，通过 `void` 操作符忽略 Promise：

```typescript
// src/utils/swarm/inProcessRunner.ts 第 1536-1552 行
/**
 * Starts an in-process teammate in the background.
 * This is the main entry point called after spawn. It starts the agent
 * execution loop in a fire-and-forget manner.
 */
export function startInProcessTeammate(config: InProcessRunnerConfig): void {
  const agentId = config.identity.agentId
  void runInProcessTeammate(config).catch(error => {
    logForDebugging(`[inProcessRunner] Unhandled error in ${agentId}: ${error}`)
  })
}
```

调用端：

```typescript
// src/tools/shared/spawnMultiAgent.ts 第 910-912 行
// Start the agent execution loop (fire-and-forget)
if (result.taskId && result.teammateContext && result.abortController) {
  startInProcessTeammate({ identity: {...}, taskId: result.taskId, prompt, ... })
```

#### Pane-based 后端的 Fire-and-Forget 实现

Tmux/iTerm2 后端创建新的 terminal pane 后，CLI 进程在新 pane 中独立启动，Leader 端只需等到 pane 创建成功即可返回。

> **代码出处**: `src/tools/AgentTool/AgentTool.tsx` 第 284-316 行; `src/utils/swarm/inProcessRunner.ts` 第 1536-1552 行; `src/tools/shared/spawnMultiAgent.ts` 第 910-912 行

---

### 7.2 两种 Prompt 派发方式

根据后端类型不同，初始 prompt 的传递路径完全不同：

#### 方式一：In-Process — 直接参数传递

In-Process teammate 的初始 prompt 通过 `startInProcessTeammate()` 的 `config.prompt` 参数直接传入，**不通过 mailbox**：

```typescript
// src/tools/shared/spawnMultiAgent.ts 第 1011-1014 行
// Note: Do NOT send the prompt via mailbox for in-process teammates.
// In-process teammates receive the prompt directly via startInProcessTeammate().
// The mailbox is only needed for tmux-based teammates which poll for their initial message.
// Sending via both paths would cause duplicate welcome messages.
```

在 `runInProcessTeammate()` 中，`config.prompt` 直接作为第一轮对话的初始输入：

```typescript
// src/utils/swarm/inProcessRunner.ts 第 883-889 行
export async function runInProcessTeammate(config: InProcessRunnerConfig) {
  const { prompt, ... } = config
  // prompt 直接作为 currentPrompt 进入 while 循环
}
```

#### 方式二：Pane-based — 通过 Mailbox 文件传递

Tmux/iTerm2 teammate 在独立进程中运行，CLI 启动时**不携带 prompt 参数**。初始 prompt 通过 mailbox 写入，teammate 的 inbox poller 从中读取：

```typescript
// src/tools/shared/spawnMultiAgent.ts 第 511-521 行（Tmux）
// Send initial instructions to teammate via mailbox
// The teammate's inbox poller will pick this up and submit it as their first turn
await writeToMailbox(
  sanitizedName,
  { from: TEAM_LEAD_NAME, text: prompt, timestamp: new Date().toISOString() },
  teamName,
)
```

```typescript
// src/utils/swarm/backends/PaneBackendExecutor.ts 第 177-186 行
// Send initial instructions to teammate via mailbox
await writeToMailbox(
  config.name,
  { from: 'team-lead', text: config.prompt, timestamp: new Date().toISOString() },
  config.teamName,
)
```

#### 后续 Prompt 的派发

无论哪种后端，后续的 prompt/任务都通过**统一的 Mailbox** 传递。包括：

- Leader 通过 `SendMessage` 工具发送指令
- `TaskUpdate` 设置 owner 后自动通过 mailbox 发送 `task_assignment` 消息
- Peer teammate 通过 `SendMessage` 互发消息

```typescript
// src/tools/TaskUpdateTool/TaskUpdateTool.ts 第 277-298 行
// 设置 owner 后自动发送任务分配通知到 owner 的 mailbox
```

#### 对比总结

| 维度 | In-Process | Tmux / iTerm2 |
|------|-----------|---------------|
| **初始 prompt** | 函数参数直传 (`config.prompt`) | Mailbox 文件 (`writeToMailbox()`) |
| **原因** | 同一进程，直接访问 | 独立进程，需要文件 IPC |
| **后续 prompt** | Mailbox (统一) | Mailbox (统一) |
| **避免重复** | 不写 mailbox（否则 duplicate） | 不传函数参数（无法传） |

> **代码出处**: `src/tools/shared/spawnMultiAgent.ts` 第 511-521 行 & 第 1011-1014 行; `src/utils/swarm/backends/PaneBackendExecutor.ts` 第 177-186 行

---

### 7.3 系统提示词拼接

每个 Teammate 的系统提示词由两部分拼接而成：

1. **基础系统提示词** — 与 Leader 相同的标准系统提示
2. **Teammate 专用附录** (`TEAMMATE_SYSTEM_PROMPT_ADDENDUM`) — 告知 teammate 必须使用 SendMessage 工具通信

```typescript
// src/utils/swarm/inProcessRunner.ts 第 935-937 行
const systemPromptParts = [
  ...fullSystemPromptParts,
  TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
]
```

附录内容：告知 teammate 如何发现团队成员、任务列表协调规则、以及**必须使用 SendMessage 工具**（团队成员听不到"说的话"）。

> **代码出处**: `src/utils/swarm/inProcessRunner.ts` 第 923-937 行; `src/utils/swarm/teammatePromptAddendum.ts`

---

### 7.4 Teammate 运行主循环

In-Process teammate 的运行由 `runInProcessTeammate()` 函数控制，核心是一个 `while` 循环：

```
while (!aborted && !shouldExit) {
    1. 调用 model loop 处理当前 prompt
    2. 标记为 idle + 发送 idle_notification
    3. 调用 waitForNextPromptOrShutdown() 进入等待
    4. 根据 waitResult 类型决定下一步
}
```

**关键点：Teammate 每完成一轮工作后不会自动退出，而是进入 idle 状态等待下一个指令。**

#### 7.4.1 Idle 状态标记与通知

每轮 model loop 结束后，teammate 会：

1. 在 AppState 中标记 `isIdle: true`
2. 仅在**首次进入 idle** 时发送 idle notification（避免重复通知）

```typescript
// src/utils/swarm/inProcessRunner.ts 第 1317-1347 行
// Mark task as idle (NOT completed) and notify any waiters
updateTaskState(taskId, task => {
  task.onIdleCallbacks?.forEach(cb => cb())
  return { ...task, isIdle: true, onIdleCallbacks: [] }
}, setAppState)

// Only send idle notification on transition to idle (not if already idle)
if (!wasAlreadyIdle) {
  await sendIdleNotification(
    identity.agentName, identity.color, identity.teamName,
    { idleReason: workWasAborted ? 'interrupted' : 'available',
      summary: getLastPeerDmSummary(allMessages) },
  )
}
```

Idle 通知发送到 **Leader 的 mailbox**，Leader 据此知道 teammate 已空闲可接受新任务。

> **代码出处**: `src/utils/swarm/inProcessRunner.ts` 第 1311-1347 行; `src/utils/teammateMailbox.ts` 第 410-430 行 (`createIdleNotification()`)

---

### 7.5 waitForNextPromptOrShutdown — Idle 等待循环

进入 idle 后，teammate 通过 `waitForNextPromptOrShutdown()` 函数进入 **500ms 轮询循环**，按优先级检查多个消息来源：

```
┌──────────────────────────────────────────────────────────────┐
│         waitForNextPromptOrShutdown 轮询优先级                 │
│                                                              │
│  1️⃣  pendingUserMessages (内存队列)     ← 用户直接消息         │
│        ↓ 无消息                                               │
│  2️⃣  sleep(500ms)                      ← 每轮间隔            │
│        ↓                                                     │
│  3️⃣  abort check                       ← AbortController     │
│        ↓ 未中止                                               │
│  4️⃣  Mailbox: shutdown_request         ← Leader 关闭请求      │
│        ↓ 无 shutdown                                         │
│  5️⃣  Mailbox: team-lead message        ← Leader 指令（优先）  │
│        ↓ 无 leader 消息                                       │
│  6️⃣  Mailbox: any peer message         ← 同伴消息 (FIFO)     │
│        ↓ 无消息                                               │
│  7️⃣  tryClaimNextTask()                ← 自动认领未分配任务    │
│        ↓ 无可认领任务                                         │
│  └── 回到步骤 2️⃣，继续轮询                                    │
└──────────────────────────────────────────────────────────────┘
```

#### 关键代码引用

```typescript
// src/utils/swarm/inProcessRunner.ts 第 689-697 行
async function waitForNextPromptOrShutdown(
  identity, abortController, taskId, getAppState, setAppState, taskListId,
): Promise<WaitResult> {
  const POLL_INTERVAL_MS = 500
  // ...
  while (!abortController.signal.aborted) {
```

#### Team-Lead 消息优先于 Peer 消息

```typescript
// src/utils/swarm/inProcessRunner.ts 第 806-824 行
// Prioritize team-lead messages over peer messages —
// the leader represents user intent and coordination, so
// their messages should not be starved behind peer-to-peer chatter.
let selectedIndex = -1
// Check for unread team-lead messages first
for (let i = 0; i < allMessages.length; i++) {
  if (m && !m.read && m.from === TEAM_LEAD_NAME) {
    selectedIndex = i; break
  }
}
// Fall back to first unread message (any sender)
if (selectedIndex === -1) {
  selectedIndex = allMessages.findIndex(m => !m.read)
}
```

#### 自动任务认领 (`tryClaimNextTask`)

当 mailbox 中没有消息时，teammate 会自动检查团队任务列表中是否有未认领的任务：

```typescript
// src/utils/swarm/inProcessRunner.ts 第 624-657 行
async function tryClaimNextTask(taskListId, agentName): Promise<string | undefined> {
  const tasks = await listTasks(taskListId)
  const availableTask = findAvailableTask(tasks)
  if (!availableTask) return undefined

  const result = await claimTask(taskListId, availableTask.id, agentName)
  if (!result.success) return undefined

  await updateTask(taskListId, availableTask.id, { status: 'in_progress' })
  return formatTaskAsPrompt(availableTask)
}
```

这意味着 Leader 可以通过 `TaskCreate` 创建任务，空闲的 teammate 会**自动**从任务列表中认领并开始执行，无需 Leader 显式分配。

> **代码出处**: `src/utils/swarm/inProcessRunner.ts` 第 624-868 行（完整的等待循环）

---

### 7.6 Teammate 终止流程

Teammate 有两种终止方式：**Graceful Shutdown** 和 **Force Kill**。

#### 7.6.1 Graceful Shutdown — 通过 Mailbox 协商

```
Leader 发送 shutdown_request (via SendMessage)
    ↓
写入 Teammate 的 Mailbox
    ↓
waitForNextPromptOrShutdown() 在轮询中检测到
    ↓ 优先级最高（高于普通消息）
返回 WaitResult.type = 'shutdown_request'
    ↓
formatAsTeammateMessage() 包装为对话消息
    ↓
送入 Model 让模型决策是否同意关闭
    ↓
模型调用 approveShutdown / rejectShutdown 工具
```

```typescript
// src/utils/swarm/inProcessRunner.ts 第 1363-1381 行
case 'shutdown_request':
  // Pass shutdown request to model for decision
  logForDebugging(
    `${identity.agentId} received shutdown request - passing to model`,
  )
  currentPrompt = formatAsTeammateMessage(
    waitResult.request?.from || 'team-lead',
    waitResult.originalMessage,
  )
  break
```

**重要**：Graceful Shutdown 不是强制的 — 模型可以**拒绝**关闭请求（例如当前有未完成的重要工作）。

#### 7.6.2 Force Kill — 立即终止

对于 In-Process teammate，通过 `killInProcessTeammate()` 强制终止：

```typescript
// src/utils/swarm/spawnInProcess.ts 第 227-328 行
export function killInProcessTeammate(taskId, setAppState): boolean {
  // 1. 调用 abortController.abort() 中止执行
  teammateTask.abortController?.abort()
  // 2. 调用 cleanup handler
  teammateTask.unregisterCleanup?.()
  // 3. 更新状态为 'killed'
  // 4. 从 teamContext.teammates 中移除
  // 5. 从 TeamFile 中移除成员记录
  removeMemberByAgentId(teamName, agentId)
  // 6. 发出 SDK terminated 事件
  emitTaskTerminatedSdk(taskId, 'stopped', { toolUseId, summary: description })
}
```

对于 Pane-based teammate，通过 `killPane()` 直接杀死 terminal pane 中的进程。

#### 7.6.3 正常退出清理

当 teammate 正常退出 while 循环（`shouldExit = true`）时的清理流程：

```typescript
// src/utils/swarm/inProcessRunner.ts 第 1419-1461 行
// Mark as completed when exiting the loop
updateTaskState(taskId, task => {
  if (task.status !== 'running') { alreadyTerminal = true; return task }
  task.onIdleCallbacks?.forEach(cb => cb())
  task.unregisterCleanup?.()
  return {
    ...task,
    status: 'completed',
    notified: true,
    endTime: Date.now(),
    messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
    pendingUserMessages: [],
    abortController: undefined,
    // ... 清理所有引用
  }
}, setAppState)
void evictTaskOutput(taskId)
evictTerminalTask(taskId, setAppState)
emitTaskTerminatedSdk(taskId, 'completed', { toolUseId, summary: identity.agentId })
unregisterPerfettoAgent(identity.agentId)
```

#### 7.6.4 Pane-based Teammate 的退出

Tmux/iTerm2 teammate 在 CLI 进程退出时，通过 `teammateInit.ts` 注册的 Stop hook 发送 idle 通知给 Leader：

> **代码出处**: `src/utils/swarm/teammateInit.ts` — 注册 Stop hook

---

### 7.7 完整生命周期流程图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Teammate 完整生命周期                                  │
│                                                                         │
│  ┌──────────┐     ┌──────────────┐     ┌───────────────────────────┐   │
│  │  Leader   │────▶│ Agent Tool   │────▶│ spawnTeammate()           │   │
│  │ (await    │     │ teamName +   │     │ 创建 + 注册 + 启动        │   │
│  │  spawn)   │     │ name         │     │                           │   │
│  └──────────┘     └──────────────┘     └──────────┬────────────────┘   │
│       │                                           │                     │
│       │ ← return 'teammate_spawned'               │ fire-and-forget     │
│       │   (Leader 继续执行)                         ▼                    │
│       │                                 ┌───────────────────────┐       │
│       │                                 │ Teammate 主循环        │       │
│       │                                 │ while(!aborted)       │       │
│  ┌────▼─────┐                           │                       │       │
│  │ Leader   │                           │  ┌─── 执行 prompt ──┐ │       │
│  │ 继续工作  │    ← SendMessage ←       │  │ model loop       │ │       │
│  │ 或 spawn │    → SendMessage →        │  └────────┬─────────┘ │       │
│  │ 更多成员  │                           │           │           │       │
│  └──────────┘                           │  ┌────────▼─────────┐ │       │
│                                         │  │ 标记 idle        │ │       │
│  ┌──────────┐  ← idle_notification ←   │  │ 发送 idle 通知   │ │       │
│  │ Leader   │                           │  └────────┬─────────┘ │       │
│  │ 收到通知  │                           │           │           │       │
│  └──────────┘                           │  ┌────────▼─────────┐ │       │
│                                         │  │ 500ms 轮询等待   │ │       │
│       │                                 │  │ (优先级排序)     │ │       │
│       │ → shutdown_request →            │  └────────┬─────────┘ │       │
│       │                                 │           │           │       │
│       │                                 │  new_message → 回到顶部│       │
│       │                                 │  shutdown  → 交给 model│       │
│       │                                 │  aborted   → 退出循环  │       │
│       │                                 └───────────────────────┘       │
│       │                                           │                     │
│       │                                 ┌─────────▼─────────────┐       │
│       │                                 │ 清理: status→completed│       │
│       │                                 │ evictTask + SDK event │       │
│       │                                 └───────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

> **代码出处**: `src/utils/swarm/inProcessRunner.ts` 第 883-1534 行（完整主循环）; `src/utils/swarm/spawnInProcess.ts` 第 227-328 行（killInProcessTeammate）

---

## 8. Skill 共享与隔离

### 8.1 Skill 加载机制

Skill 在 Agent 定义的 frontmatter 中通过 `skills` 字段声明，在 `runAgent()` 中按需加载：

```typescript
// src/tools/AgentTool/runAgent.ts 第 577-641 行
// Preload skills from agent frontmatter
const skillsToPreload = agentDefinition.skills ?? []
if (skillsToPreload.length > 0) {
  const allSkills = await getSkillToolCommands(getProjectRoot())
  // ... 逐个解析并加载 skill 内容
  const loaded = await Promise.all(
    validSkills.map(async ({ skillName, skill }) => ({
      skillName, skill,
      content: await skill.getPromptForCommand('', toolUseContext),
    })),
  )
  // 将加载的 skill 内容作为 initialMessages 注入到 Agent 的对话中
}
```

### 8.2 Skill 隔离结论

| 维度 | 说明 |
|------|------|
| **配置来源** | 所有 Agent 共享同一份 skill 配置文件（`.claude/agents/` 定义） |
| **加载实例** | 每个 Agent **独立加载**，skill 内容作为消息注入各自的对话上下文 |
| **运行时隔离** | ✅ 完全隔离 — 每个 Agent 有独立的消息历史，skill 内容互不影响 |
| **Skill Tool** | 包含在 `ASYNC_AGENT_ALLOWED_TOOLS` 中，所有 Agent 均可使用 |

**结论**: Skill 的**配置是共享的**（来自同一文件系统），但**加载后的实例是隔离的**（各自注入到不同的 Agent 对话上下文中）。

> **代码出处**: `src/tools/AgentTool/runAgent.ts` 第 577-641 行；`src/tools/AgentTool/loadAgentsDir.ts`（AgentDefinition.skills 字段）；`src/constants/tools.ts` 第 66 行（`SKILL_TOOL_NAME` 在白名单中）

---

## 9. MCP Server 共享与隔离

### 9.1 MCP 初始化架构

Agent 的 MCP 连接通过 `initializeAgentMcpServers()` 初始化：

```typescript
// src/tools/AgentTool/runAgent.ts 第 95-218 行
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],  // 从 parent 继承
): Promise<{
  clients: MCPServerConnection[]  // 合并后的 clients
  tools: Tools                    // agent 特有的 MCP tools
  cleanup: () => Promise<void>    // 清理函数
}>
```

**核心逻辑**：
1. 如果 Agent 没有定义 `mcpServers`，**直接返回 parent 的 clients**（共享）
2. 如果有定义，通过两种方式获取连接：
   - **按名称引用**（`string`）→ 使用 `getMcpConfigByName()` 查找，`connectToServer()` 可能**返回已缓存的共享 client**
   - **内联定义**（`{ name: config }`）→ 创建**新的独立连接**，Agent 结束时清理

```typescript
// src/tools/AgentTool/runAgent.ts 第 140-142 行
if (typeof spec === 'string') {
  // Reference by name - look up in existing MCP configs
  // This uses the memoized connectToServer, so we may get a shared client
```

### 9.2 三种后端的 MCP 隔离差异

| 后端 | MCP 行为 | 原因 |
|------|---------|------|
| **Tmux** | ❌ **独立连接** | 独立进程，各自初始化自己的 MCP client |
| **iTerm2** | ❌ **独立连接** | 独立进程，同上 |
| **In-Process** | ✅ **共享 Leader 的连接** | 同一进程，通过 `toolUseContext` 传递 |

In-Process 的关键注释：

```typescript
// src/utils/swarm/backends/InProcessBackend.ts 第 28-30 行
// Unlike pane-based backends (tmux/iTerm2), in-process teammates run in the
// same Node.js process with isolated context via AsyncLocalStorage. They:
// - Share resources (API client, MCP connections) with the leader
```

In-Process 启动时传递 leader 的 context：

```typescript
// src/utils/swarm/backends/InProcessBackend.ts 第 122 行
toolUseContext: { ...this.context, messages: [] },
// 注意：messages 被清空（避免 pin 住 leader 的对话历史），
// 但 options.mcpClients 等资源被共享
```

### 9.3 MCP 工具过滤

**关键规则**：所有 `mcp__` 前缀的工具始终允许通过过滤：

```typescript
// src/tools/AgentTool/agentToolUtils.ts 第 82-85 行
// Allow MCP tools for all agents
if (tool.name.startsWith('mcp__')) {
  return true
}
```

但 MCP Tool（本身的管理工具）和 ListMcpResources / ReadMcpResource 等被标记为 **TODO — 暂不支持**：

```typescript
// src/constants/tools.ts 第 97-101 行 注释
// ENABLE LATER (NEED WORK):
// - MCPTool: TBD
// - ListMcpResourcesTool: TBD
// - ReadMcpResourceTool: TBD
```

---

## 10. 工具集共享与隔离

### 10.1 工具解析流程

```
AgentDefinition.tools (frontmatter)
    ↓
resolveAgentTools()          ← 验证/解析 agent 声明的工具
    ↓
filterToolsForAgent()        ← 应用禁止列表/白名单
    ↓
+ agentMcpTools              ← 合并 MCP 工具
    ↓
最终工具集 (allTools)
```

### 10.2 工具集隔离方式

每个 Agent 都有**独立的工具集**，通过以下参数组合决定：

1. **Agent 定义中的 `tools` 字段** — 声明可用工具（支持通配符 `*`）
2. **Agent 定义中的 `disallowedTools` 字段** — 声明禁止工具
3. **`isBuiltIn` 标志** — 内置 Agent vs 自定义 Agent 有不同的过滤
4. **`isAsync` 标志** — 异步 Agent（包括 teammate）使用白名单模式
5. **`isInProcessTeammate()` 检测** — In-Process teammate 获得额外工具

### 10.3 In-Process Teammate 的额外能力

In-Process Teammate 除了标准异步 Agent 工具外，还可以：

- ✅ 使用 `Agent Tool`（但仅限 spawn 同步子 agent，禁止 spawn 后台/teammate）
- ✅ 使用 `TaskCreate/Get/List/Update`（协调共享任务列表）
- ✅ 使用 `SendMessage`（与团队成员通信）

> **代码出处**: `src/tools/AgentTool/agentToolUtils.ts` 第 100-111 行

---

## 11. 权限同步机制

### 11.1 Worker-Leader 权限协调

当 Teammate（Worker）遇到需要权限的工具调用时，权限请求会被转发给 Leader：

```
Worker Agent 需要权限
    ↓
创建 SwarmPermissionRequest
    ↓
写入 Leader 的 Mailbox
    ↓
Leader UI 展示权限请求
    ↓
用户 批准/拒绝
    ↓
写入 Worker 的 Mailbox (permission_response)
    ↓
Worker 继续执行
```

```typescript
// src/utils/swarm/permissionSync.ts 第 1-19 行注释
/**
 * Synchronized Permission Prompts for Agent Swarms
 * 
 * Flow:
 * 1. Worker agent encounters a permission prompt
 * 2. Worker sends a permission_request message to the leader's mailbox
 * 3. Leader polls for mailbox messages and detects permission requests
 * 4. User approves/denies via the leader's UI
 * 5. Leader sends a permission_response message to the worker's mailbox
 * 6. Worker polls mailbox for responses and continues execution
 */
```

### 11.2 权限请求结构

```typescript
// src/utils/swarm/permissionSync.ts 第 49-80 行
SwarmPermissionRequestSchema = z.object({
  id: z.string(),
  workerId: z.string(),
  workerName: z.string(),
  workerColor: z.string().optional(),
  teamName: z.string(),
  toolName: z.string(),           // 需要权限的工具名
  toolUseId: z.string(),
  description: z.string(),        // 人类可读描述
  input: z.record(z.unknown()),   // 工具输入
  permissionSuggestions: z.array(z.unknown()),
  status: z.enum(['pending', 'approved', 'rejected']),
  resolvedBy: z.enum(['worker', 'leader']).optional(),
  // ...
})
```

---

## 12. 共享与隔离总结对比表

### 按资源维度

| 资源 | Tmux Teammate | iTerm2 Teammate | In-Process Teammate |
|------|:------------:|:---------------:|:-------------------:|
| **Node.js 进程** | 独立 | 独立 | 共享（同一进程） |
| **API Client** | 独立 | 独立 | ⚠️ 共享 Leader 的 |
| **MCP 连接** | 独立 | 独立 | ⚠️ 共享 Leader 的 |
| **MCP 工具 (`mcp__*`)** | 独立加载 | 独立加载 | 共享（通过 context 传递） |
| **Skill 配置** | 共享（文件系统） | 共享（文件系统） | 共享（文件系统） |
| **Skill 实例** | 独立加载 | 独立加载 | 独立加载（注入消息） |
| **工具集** | 独立过滤 | 独立过滤 | 独立过滤 + 额外工具 |
| **对话历史** | 独立 | 独立 | 独立（`messages: []`） |
| **File State Cache** | 独立 | 独立 | 独立（`cloneFileStateCache()`） |
| **Task List** | ✅ 共享 | ✅ 共享 | ✅ 共享 |
| **Mailbox** | ✅ 统一文件系统 | ✅ 统一文件系统 | ✅ 统一文件系统 |
| **权限** | 独立 + Leader 同步 | 独立 + Leader 同步 | 独立 + Leader 同步 |
| **环境变量** | 独立进程环境 | 独立进程环境 | 共享（靠 AsyncLocalStorage 覆盖） |

### 按功能维度

| 功能 | 是否共享 | 隔离机制 | 代码出处 |
|------|---------|---------|---------|
| **Team 配置** | ✅ 共享 | 统一的 `config.json` | `src/utils/swarm/teamHelpers.ts` |
| **Task 列表** | ✅ 共享 | 统一的 `~/.claude/tasks/{team}/` | `src/utils/tasks.ts` |
| **消息通信** | ✅ 统一 | 文件级 Mailbox + 锁 | `src/utils/teammateMailbox.ts` |
| **Skill** | 配置共享, 实例隔离 | 各自注入消息上下文 | `src/tools/AgentTool/runAgent.ts:577` |
| **MCP (In-Process)** | ⚠️ 连接共享 | 无隔离 | `InProcessBackend.ts:28-30` |
| **MCP (Pane-based)** | 独立 | 进程隔离 | 各自 CLI 初始化 |
| **工具过滤** | 配置共享, 过滤独立 | 多层过滤器 | `agentToolUtils.ts:80-116` |
| **权限请求** | 独立发起, Leader 统一处理 | Mailbox 消息 | `permissionSync.ts` |

---

## 附录：关键文件索引

| 文件路径 | 行数 | 核心职责 |
|---------|------|---------|
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | 241 | Team 创建主逻辑 |
| `src/tools/TeamCreateTool/prompt.ts` | 113 | TeamCreate 完整提示词 |
| `src/tools/TeamDeleteTool/TeamDeleteTool.ts` | — | Team 删除与清理 |
| `src/tools/SendMessageTool/SendMessageTool.ts` | 918 | Agent 间消息通信 |
| `src/tools/AgentTool/AgentTool.tsx` | ~1800 | Agent spawn 主入口 |
| `src/tools/AgentTool/runAgent.ts` | 974 | Agent 执行引擎 |
| `src/tools/AgentTool/agentToolUtils.ts` | ~200 | 工具过滤与解析 |
| `src/tools/AgentTool/loadAgentsDir.ts` | ~400 | Agent 定义加载 |
| `src/tools/shared/spawnMultiAgent.ts` | 1094 | Teammate spawn 调度 |
| `src/utils/swarm/teamHelpers.ts` | 684 | TeamFile CRUD |
| `src/utils/swarm/permissionSync.ts` | 929 | 权限协调系统 |
| `src/utils/swarm/inProcessRunner.ts` | 1553 | In-process 运行器 |
| `src/utils/swarm/backends/types.ts` | 312 | 核心类型定义 |
| `src/utils/swarm/backends/InProcessBackend.ts` | 340 | In-process 后端 |
| `src/utils/swarm/backends/TmuxBackend.ts` | — | Tmux 后端 |
| `src/utils/swarm/backends/ITermBackend.ts` | — | iTerm2 后端 |
| `src/utils/swarm/backends/registry.ts` | — | 后端注册与检测 |
| `src/utils/teammateContext.ts` | 97 | AsyncLocalStorage 隔离 |
| `src/utils/teammateMailbox.ts` | 1184 | 文件级邮箱系统 |
| `src/utils/teammate.ts` | — | Teammate 身份工具集 |
| `src/utils/agentId.ts` | — | 确定性 Agent ID |
| `src/constants/tools.ts` | 113 | 工具白/黑名单定义 |
