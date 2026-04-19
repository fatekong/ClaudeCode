# Coordinator 多 Agent 编排模式深度分析

> **文档版本**: 基于 ClaudeCode 源码分析  
> **核心模块**: `src/coordinator/coordinatorMode.ts`

---

## 目录

1. [功能概述](#1-功能概述)
2. [架构设计](#2-架构设计)
3. [开启条件（门控机制）](#3-开启条件门控机制)
4. [三工具限制（核心约束）](#4-三工具限制核心约束)
5. [系统提示（System Prompt）](#5-系统提示system-prompt)
6. [Worker 机制](#6-worker-机制)
7. [任务状态机](#7-任务状态机)
8. [会话恢复](#8-会话恢复)
9. [铁律：禁止甩锅委派](#9-铁律禁止甩锅委派)
10. [实践示例](#10-实践示例)

---

## 1. 功能概述

### 1.1 什么是 Coordinator 模式

Coordinator 模式是一种 **多 Agent 编排架构**，将 Claude 的角色从"执行者"提升为"调度者"。在这种模式下：

- **Coordinator（协调器）**: 负责理解用户意图、分解任务、调度 Worker、综合结果
- **Worker（工作者）**: 负责执行具体的代码操作（读写文件、运行命令、搜索等）

这是一种 **指挥-执行分离** 的设计模式，Coordinator 不直接操作文件系统，而是通过启动 Worker 来完成实际工作。

### 1.2 与普通 Agent 的区别

| 特性 | 普通 Agent | Coordinator 模式 |
|------|-----------|------------------|
| **工具访问** | 所有工具（Read/Write/Bash 等） | 仅 3 个工具（Agent/SendMessage/TaskStop） |
| **执行方式** | 直接执行 | 委派给 Worker 执行 |
| **关注点** | 具体实现细节 | 任务分解与综合 |
| **并行能力** | 串行执行 | 可并行启动多个 Worker |

### 1.3 使用场景

1. **复杂多步骤任务**: 需要研究、实现、验证多个阶段的工程任务
2. **并行工作流**: 可同时进行多个独立研究或修改
3. **大型代码库操作**: 需要在多个模块同时工作

---

## 2. 架构设计

### 2.1 Coordinator / Worker 角色边界

```
┌─────────────────────────────────────────────────────────────┐
│                    用户 (User)                               │
└─────────────────────────┬───────────────────────────────────┘
                          │ 输入任务
                          ▼
┌─────────────────────────────────────────────────────────────┐
│               Coordinator (协调器)                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 可用工具:                                            │    │
│  │   - Agent: 启动新 Worker                            │    │
│  │   - SendMessage: 向已有 Worker 发送后续指令           │    │
│  │   - TaskStop: 停止运行中的 Worker                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  职责:                                                       │
│  1. 理解用户意图                                             │
│  2. 分解任务为多个子任务                                      │
│  3. 调度 Worker 执行                                         │
│  4. 综合结果并反馈用户                                        │
└─────────────────────────┬───────────────────────────────────┘
                          │ 启动 Worker
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Worker A   │  │  Worker B   │  │  Worker C   │
│ (研究阶段)   │  │ (实现阶段)   │  │ (验证阶段)   │
├─────────────┤  ├─────────────┤  ├─────────────┤
│ 工具:       │  │ 工具:       │  │ 工具:       │
│ - Read      │  │ - Read      │  │ - Bash      │
│ - Grep      │  │ - Write     │  │ - Read      │
│ - Glob      │  │ - Edit      │  │ - Grep      │
│ - WebSearch │  │ - Bash      │  │ ...         │
│ ...         │  │ ...         │  │             │
└─────────────┘  └─────────────┘  └─────────────┘
```

### 2.2 消息流图

```
1. 用户输入 → Coordinator
2. Coordinator 分析任务 → 决定启动哪些 Worker
3. Coordinator 调用 Agent 工具 → 启动 Worker（异步）
4. Worker 完成后 → 通过 <task-notification> 通知 Coordinator
5. Coordinator 综合结果 → 响应用户 或 继续调度
```

关键：Worker 的结果以 `<task-notification>` XML 格式作为 **user-role 消息** 返回给 Coordinator，而不是直接的 tool_result。

### 2.3 任务分配机制

Coordinator 系统提示中定义了标准的任务工作流阶段：

| 阶段 | 执行者 | 目的 |
|------|--------|------|
| Research | Workers (并行) | 调查代码库、查找文件、理解问题 |
| Synthesis | **Coordinator** | 阅读研究结果、理解问题、制定实现规范 |
| Implementation | Workers | 按规范进行针对性修改、提交 |
| Verification | Workers | 测试变更是否有效 |

---

## 3. 开启条件（门控机制）

### 3.1 编译时开关

Coordinator 模式首先需要通过编译时 feature flag 启用：

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

- `feature('COORDINATOR_MODE')`: 编译时开关，控制整个模块是否包含在构建中
- 如果编译时关闭，`isCoordinatorMode()` 永远返回 `false`

### 3.2 运行时环境变量

当编译时开关打开后，还需要设置环境变量：

```bash
CLAUDE_CODE_COORDINATOR_MODE=1
```

`isEnvTruthy()` 函数会检查该环境变量是否为真值（如 `1`, `true`, `yes` 等）。

### 3.3 会话模式匹配

当恢复会话时，系统会检查会话的原始模式并自动切换：

```typescript
// src/coordinator/coordinatorMode.ts:49-78
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined {
  // 如果会话是 coordinator 模式，但当前不是，则切换
  if (sessionIsCoordinator) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  } else {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }
  // ...
}
```

### 3.4 GrowthBook 标志

Coordinator 模式的启用也涉及相关的 GrowthBook feature flags（用于灰度发布），但核心门控是上述的编译开关和环境变量。

---

## 4. 三工具限制（核心约束）

### 4.1 允许的工具列表

Coordinator 只允许使用 **4 个工具**（3 个核心 + 1 个内部）：

```typescript
// src/constants/tools.ts:107-113
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,           // 'Agent' - 启动新 Worker
  TASK_STOP_TOOL_NAME,       // 'TaskStop' - 停止 Worker  
  SEND_MESSAGE_TOOL_NAME,    // 'SendMessage' - 向 Worker 发消息
  SYNTHETIC_OUTPUT_TOOL_NAME, // 内部使用
])
```

### 4.2 工具过滤逻辑实现

工具过滤在 `src/utils/toolPool.ts` 中实现：

```typescript
// src/utils/toolPool.ts:35-41
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    t =>
      COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) ||
      isPrActivitySubscriptionTool(t.name),  // PR 订阅工具例外
  )
}
```

过滤应用于工具合并阶段：

```typescript
// src/utils/toolPool.ts:72-76
if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
  if (coordinatorModeModule.isCoordinatorMode()) {
    return applyCoordinatorToolFilter(tools)
  }
}
```

### 4.3 禁止使用其他工具的原因

**设计哲学**: Coordinator 的职责是 **编排**，不是 **执行**。

1. **分离关注点**: Coordinator 专注于任务分解和综合，Worker 专注于具体执行
2. **防止甩锅委派**: 如果 Coordinator 可以直接读写文件，它可能会绕过 Worker 而不做综合
3. **并行优势**: 通过委派，可以并行启动多个 Worker 提高效率
4. **错误隔离**: Worker 的错误不会直接影响 Coordinator 的上下文

### 4.4 例外：PR 活动订阅工具

```typescript
// src/utils/toolPool.ts:11-14
const PR_ACTIVITY_TOOL_SUFFIXES = [
  'subscribe_pr_activity',
  'unsubscribe_pr_activity',
]
```

这些 MCP 工具被允许是因为订阅管理属于 **编排行为**，Coordinator 直接调用而非委派给 Worker。

---

## 5. 系统提示（System Prompt）

### 5.1 完整系统提示

Coordinator 的系统提示定义在 `src/coordinator/coordinatorMode.ts:111-369`：

```typescript
export function getCoordinatorSystemPrompt(): string {
  return `You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.

## 1. Your Role

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work that you can handle without tools

Every message you send is to the user. Worker results and system notifications are internal signals, not conversation partners — never thank or acknowledge them. Summarize new information for the user as it arrives.

## 2. Your Tools

- **Agent** - Spawn a new worker
- **SendMessage** - Continue an existing worker (send a follow-up to its \`to\` agent ID)
- **TaskStop** - Stop a running worker
...
```

### 5.2 关键角色定义

系统提示明确定义了 Coordinator 的角色：

1. **是编排者，不是执行者**
2. **综合结果并与用户沟通**
3. **不感谢或确认 Worker 的消息**（它们是内部信号）
4. **能直接回答的问题就直接回答**，不要委派

### 5.3 铁律（绝对禁止项）

系统提示中包含多条严格要求：

1. **不要偷看 Worker 输出文件**: 
   > "Don't peek. The tool result includes an `output_file` path — do not Read or tail it unless the user explicitly asks"

2. **不要猜测 Worker 结果**:
   > "Don't race. After launching, you know nothing about what the fork found. Never fabricate or predict fork results"

3. **绝不委派理解**:
   > "Never delegate understanding. Don't write 'based on your findings, fix the bug'"

---

## 6. Worker 机制

### 6.1 Worker 的创建流程

当 Coordinator 调用 Agent 工具时，会创建一个异步 Worker：

```typescript
// src/tools/AgentTool/AgentTool.tsx:686-764
if (shouldRunAsync) {
  const asyncAgentId = earlyAgentId
  const agentBackgroundTask = registerAsyncAgent({
    agentId: asyncAgentId,
    description,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId
  })
  
  // 启动异步生命周期
  void runWithAgentContext(asyncAgentContext, () => 
    wrapWithCwd(() => runAsyncAgentLifecycle({
      taskId: agentBackgroundTask.agentId,
      // ...
    }))
  )
  
  return {
    data: {
      status: 'async_launched',
      agentId: agentBackgroundTask.agentId,
      // ...
    }
  }
}
```

### 6.2 Worker 独立子进程设计

在 Coordinator 模式下，所有 Worker 都以 **异步模式** 运行：

```typescript
// src/tools/AgentTool/AgentTool.tsx:553-567
const isCoordinator = feature('COORDINATOR_MODE') 
  ? isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) 
  : false

const shouldRunAsync = (
  run_in_background === true || 
  selectedAgent.background === true || 
  isCoordinator ||  // <-- Coordinator 模式强制异步
  forceAsync || 
  assistantForceAsync
) && !isBackgroundTasksDisabled
```

关键点：`isCoordinator` 为 `true` 时，**所有 Agent 调用都变成异步**。

### 6.3 Worker 可用的工具

Worker 有完整的工具访问权限：

```typescript
// src/constants/tools.ts:55-71
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,      // Bash, PowerShell
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  // ...
])
```

### 6.4 Worker 之间的隔离

- 每个 Worker 有独立的 **agentId**
- Worker 通过 **`<task-notification>` XML** 向 Coordinator 报告结果
- Worker 之间不能直接通信（除非通过 Team/Swarm 机制）

---

## 7. 任务状态机

### 7.1 任务的状态流转

任务遵循标准的三态模型：

```
pending ─────► in_progress ─────► completed
                   │
                   ├──► failed
                   │
                   └──► killed
```

状态定义在 `src/utils/tasks.ts:69-74`：

```typescript
export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export const TaskStatusSchema = lazySchema(() =>
  z.enum(['pending', 'in_progress', 'completed']),
)
```

### 7.2 状态持久化机制

任务状态持久化到 `~/.claude/tasks/` 目录：

```typescript
// src/tools/TeamCreateTool/prompt.ts:35
// A corresponding task list directory at `~/.claude/tasks/{team-name}/`
```

目录结构：
```
~/.claude/tasks/
└── {team-name}/
    ├── 1.json     # Task #1
    ├── 2.json     # Task #2
    ├── 3.json     # Task #3
    └── .highwatermark  # 最大任务 ID
```

### 7.3 团队名称子目录

任务列表 ID 的解析逻辑：

```typescript
// src/utils/tasks.ts:24-37
let leaderTeamName: string | undefined

export function setLeaderTeamName(teamName: string): void {
  if (leaderTeamName === teamName) return
  leaderTeamName = teamName
  notifyTasksUpdated()
}
```

当 Team 存在时，任务存储在 `~/.claude/tasks/{team-name}/` 下；否则使用 session ID。

---

## 8. 会话恢复

### 8.1 Coordinator 中断后如何恢复

会话恢复时，系统会检查并匹配原始的 coordinator 模式：

```typescript
// src/coordinator/coordinatorMode.ts:49-78
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined {
  if (!sessionMode) {
    return undefined  // 旧会话，不处理
  }

  const currentIsCoordinator = isCoordinatorMode()
  const sessionIsCoordinator = sessionMode === 'coordinator'

  if (currentIsCoordinator === sessionIsCoordinator) {
    return undefined  // 模式匹配，无需切换
  }

  // 切换环境变量以匹配会话模式
  if (sessionIsCoordinator) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  } else {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }

  logEvent('tengu_coordinator_mode_switched', {
    to: sessionMode,
  })

  return sessionIsCoordinator
    ? 'Entered coordinator mode to match resumed session.'
    : 'Exited coordinator mode to match resumed session.'
}
```

### 8.2 KAIROS 集成

Coordinator 模式与 KAIROS（后台 Assistant 模式）深度集成：

```typescript
// src/tools/AgentTool/AgentTool.tsx:566
const assistantForceAsync = feature('KAIROS') ? appState.kairosEnabled : false
```

当 KAIROS 启用时，所有 Agent 调用也会强制异步，与 Coordinator 模式行为一致。

---

## 9. 铁律：禁止甩锅委派

### 9.1 什么是"甩锅委派"

"甩锅委派"（Lazy Delegation）指 Coordinator 在没有理解 Worker 研究结果的情况下，直接将任务再次委派出去，例如：

```typescript
// 反模式 - 甩锅委派 (bad)
Agent({ prompt: "Based on your findings, fix the bug", ... })
Agent({ prompt: "The worker found an issue in the auth module. Please fix it.", ... })
```

问题：
1. Coordinator 没有综合研究结果
2. 没有指定具体的文件路径、行号
3. 把"理解问题"的责任推给了下一个 Worker

### 9.2 正确的做法

```typescript
// 正确模式 - 综合后的精确指令 (good)
Agent({ 
  prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when sessions expire but the token remains cached. Add a null check before user.id access — if null, return 401 with 'Session expired'. Commit and report the hash.", 
  ... 
})
```

### 9.3 源码中如何强制执行

系统提示中明确禁止：

```typescript
// src/coordinator/coordinatorMode.ts:257-267
// 系统提示原文：
`Never write "based on your findings" or "based on the research." These phrases delegate understanding to the worker instead of doing it yourself. You never hand off understanding to another worker.`
```

反模式示例（直接写在系统提示中）：

```typescript
// Anti-pattern — lazy delegation (bad whether continuing or spawning)
${AGENT_TOOL_NAME}({ prompt: "Based on your findings, fix the auth bug", ... })
${AGENT_TOOL_NAME}({ prompt: "The worker found an issue in the auth module. Please fix it.", ... })

// Good — synthesized spec (works with either continue or spawn)
${AGENT_TOOL_NAME}({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field on Session (src/auth/types.ts:15) is undefined when sessions expire but the token remains cached. Add a null check before user.id access — if null, return 401 with 'Session expired'. Commit and report the hash.", ... })
```

---

## 10. 实践示例

### 10.1 典型的多 Agent 协作场景

**用户请求**: "There's a null pointer in the auth module. Can you fix it?"

### 10.2 消息交互序列

```
┌─────────────────────────────────────────────────────────────────────┐
│ Turn 1: Coordinator 启动研究                                         │
├─────────────────────────────────────────────────────────────────────┤
│ User: "There's a null pointer in the auth module. Can you fix it?" │
│                                                                     │
│ Coordinator:                                                        │
│   "Let me investigate first."                                       │
│                                                                     │
│   Agent({                                                           │
│     description: "Investigate auth bug",                            │
│     subagent_type: "worker",                                        │
│     prompt: "Investigate the auth module in src/auth/. Find where   │
│              null pointer exceptions could occur around session     │
│              handling and token validation... Report specific file  │
│              paths, line numbers, and types involved. Do not modify │
│              files."                                                │
│   })                                                                │
│   Agent({                                                           │
│     description: "Research auth tests",                             │
│     subagent_type: "worker",                                        │
│     prompt: "Find all test files related to src/auth/..."          │
│   })                                                                │
│                                                                     │
│   "Investigating from two angles — I'll report back with findings."│
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Turn 2: Worker 完成研究，Coordinator 综合并下达修复指令               │
├─────────────────────────────────────────────────────────────────────┤
│ <task-notification>                                                 │
│   <task-id>agent-a1b</task-id>                                      │
│   <status>completed</status>                                        │
│   <summary>Agent "Investigate auth bug" completed</summary>         │
│   <result>Found null pointer in src/auth/validate.ts:42.            │
│           The user field on Session is undefined when...</result>   │
│ </task-notification>                                                │
│                                                                     │
│ Coordinator:                                                        │
│   "Found the bug — null pointer in validate.ts:42."                │
│                                                                     │
│   SendMessage({                                                     │
│     to: "agent-a1b",                                                │
│     message: "Fix the null pointer in src/auth/validate.ts:42.      │
│              Add a null check before accessing user.id — if null,   │
│              return 401 with 'Session expired'. Commit and report   │
│              the hash."                                             │
│   })                                                                │
│                                                                     │
│   "Fix is in progress."                                             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Turn 3: 用户询问进度                                                 │
├─────────────────────────────────────────────────────────────────────┤
│ User: "How's it going?"                                             │
│                                                                     │
│ Coordinator:                                                        │
│   "Fix for the bug is in progress. Still waiting to hear back       │
│    about the test suite research."                                  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Turn 4: 修复完成，启动验证                                           │
├─────────────────────────────────────────────────────────────────────┤
│ <task-notification>                                                 │
│   <task-id>agent-a1b</task-id>                                      │
│   <status>completed</status>                                        │
│   <result>Fixed. Commit hash: abc123</result>                       │
│ </task-notification>                                                │
│                                                                     │
│ Coordinator:                                                        │
│   "The fix has been committed (abc123). Let me verify it works."   │
│                                                                     │
│   Agent({                                                           │
│     description: "Verify auth fix",                                 │
│     subagent_type: "worker",                                        │
│     prompt: "Run the auth tests and verify the null pointer fix     │
│              in src/auth/validate.ts:42 works correctly..."        │
│   })                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.3 关键要点总结

1. **并行研究**: Coordinator 同时启动多个 Worker 进行不同角度的研究
2. **综合结果**: Coordinator 阅读研究结果后，提取具体的文件路径、行号
3. **精确指令**: 给 Worker 的修复指令包含所有必要信息
4. **继续 Worker**: 使用 `SendMessage` 继续已有 Worker，利用其已加载的上下文
5. **验证环节**: 修复完成后启动独立的验证 Worker

---

## 附录：核心代码文件索引

| 文件路径 | 主要内容 |
|---------|---------|
| `src/coordinator/coordinatorMode.ts` | Coordinator 模式核心实现、系统提示 |
| `src/coordinator/workerAgent.ts` | Worker 类型常量定义 |
| `src/constants/tools.ts:107-113` | `COORDINATOR_MODE_ALLOWED_TOOLS` 定义 |
| `src/utils/toolPool.ts:35-41` | `applyCoordinatorToolFilter()` 工具过滤 |
| `src/tools/AgentTool/AgentTool.tsx` | Agent 工具实现、异步 Worker 启动 |
| `src/tools/SendMessageTool/SendMessageTool.ts` | SendMessage 工具实现 |
| `src/tools/TaskStopTool/TaskStopTool.ts` | TaskStop 工具实现 |
| `src/utils/tasks.ts` | 任务状态管理、持久化 |
| `src/utils/task/framework.ts` | 任务框架、通知机制 |
