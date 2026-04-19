# Query Loop 结构文档

> 源文件：`src/query.ts`  
> 核心入口：`query()` → `queryLoop()`

---

## 一、总体架构

```
query(params)                          src/query.ts:219
  └── queryLoop(params, consumedUuids) src/query.ts:241
        └── while (true)               src/query.ts:307
              ├── [阶段1] 消息预处理
              ├── [阶段2] API 调用 + 流式响应
              ├── [阶段3] 工具执行
              ├── [阶段4] 附件注入
              └── [阶段5] 继续/终止判断
```

`query()` 是对外暴露的异步生成器，`queryLoop()` 是真正的循环体。每次循环代表一个「模型回复 → 工具执行」轮次（turn）。

---

## 二、QueryParams 入参

`src/query.ts:181`

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 历史对话消息 |
| `systemPrompt` | `SystemPrompt` | 系统提示词 |
| `userContext` | `{ [k: string]: string }` | 用户上下文（CODEBUDDY.md 等），以 `<system-reminder>` 包裹注入到首条消息 |
| `systemContext` | `{ [k: string]: string }` | 系统上下文（git status 等），追加到 systemPrompt 末尾 |
| `canUseTool` | `CanUseToolFn` | 工具权限检查函数 |
| `toolUseContext` | `ToolUseContext` | 工具执行上下文（含 appState、options、abortController 等） |
| `fallbackModel` | `string?` | 备用模型（高负载时切换） |
| `querySource` | `QuerySource` | 来源标识（`repl_main_thread`、`agent:xxx`、`compact` 等） |
| `maxTurns` | `number?` | 最大轮次限制（子代理常用） |
| `taskBudget` | `{ total: number }?` | API task_budget token 预算 |

---

## 三、循环内可变状态（State）

`src/query.ts:204`

```typescript
type State = {
  messages: Message[]                           // 当前消息列表
  toolUseContext: ToolUseContext                 // 工具上下文（每轮可更新）
  autoCompactTracking: AutoCompactTrackingState  // 自动压缩跟踪
  maxOutputTokensRecoveryCount: number           // max_output_tokens 恢复次数（上限3次）
  hasAttemptedReactiveCompact: boolean           // 是否已尝试 reactive compact
  maxOutputTokensOverride: number | undefined    // 覆盖 max_output_tokens（escalate 用）
  pendingToolUseSummary: Promise<...> | undefined // 上一轮 tool use summary（异步预生成）
  stopHookActive: boolean | undefined            // stop hook 是否在运行
  turnCount: number                              // 当前轮次计数
  transition: Continue | undefined               // 上一次循环继续的原因
}
```

---

## 四、每轮循环的执行阶段

### 阶段 1：消息预处理（`:307`–`:648`）

按顺序执行以下步骤，每步都在 `messagesForQuery` 上就地更新：

| 步骤 | 函数 | 作用 |
|------|------|------|
| 1. 截取 compact 边界后的消息 | `getMessagesAfterCompactBoundary()` | 只保留最近一次 compact 之后的消息 |
| 2. Tool result 预算裁剪 | `applyToolResultBudget()` | 对超大 tool result 内容做截断/替换 |
| 3. History Snip | `snipModule.snipCompactIfNeeded()` | 按 token 上限删除中间历史（feature: `HISTORY_SNIP`） |
| 4. Microcompact | `deps.microcompact()` | 对重复 tool result 做缓存压缩（减少 prompt cache miss） |
| 5. Context Collapse | `contextCollapse.applyCollapsesIfNeeded()` | 折叠已归档的上下文（feature: `CONTEXT_COLLAPSE`） |
| 6. Auto Compact | `deps.autocompact()` | 超过 token 阈值时触发全局压缩（生成摘要替换历史） |
| 7. Token 阻塞检查 | `calculateTokenWarningState()` | 超过硬限制时直接返回 `blocking_limit` |

预处理后构建发送给 API 的完整系统提示：
```typescript
// src/query.ts:449
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext)  // systemContext 追加到 systemPrompt 末尾
)
```

---

### 阶段 2：API 调用 + 流式响应（`:650`–`:997`）

#### 2.1 发送给 Claude API 的完整内容

```typescript
// src/query.ts:659
deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext), // ← 消息 + userContext
  systemPrompt: fullSystemPrompt,                              // ← systemPrompt + systemContext
  tools: toolUseContext.options.tools,                         // ← 工具列表
  thinkingConfig: ...,
  signal: abortController.signal,
  options: { model, fallbackModel, querySource, ... }
})
```

**`prependUserContext()`**（`src/utils/api.ts:449`）：  
在 `messagesForQuery` 首位插入一条 `isMeta: true` 的 user 消息，内容为：
```xml
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
{CODEBUDDY.md 内容}
# gitStatus
{git status}
...
IMPORTANT: this context may or may not be relevant to your tasks...
</system-reminder>
```

**`appendSystemContext()`**（`src/utils/api.ts:437`）：  
将 `systemContext` 的键值对以 `key: value` 格式追加到 `systemPrompt` 数组末尾。

#### 2.2 流式响应处理

```
for await (const message of deps.callModel({...})) {
  ├── 如果 message.type === 'assistant'
  │     ├── push 到 assistantMessages[]
  │     ├── 提取 tool_use blocks → toolUseBlocks[]
  │     └── 如启用 streamingToolExecutor → 立即开始并行执行工具
  └── yield message（透传给上游消费者）
}
```

**错误处理：**
- `FallbackTriggeredError` → 切换到 `fallbackModel`，清空 assistantMessages，重试
- `PromptTooLong` / `max_output_tokens` → 暂时 withhold（不 yield），等后续恢复逻辑处理
- 其他错误 → yield 错误消息，返回 `{ reason: 'model_error' }`

---

### 阶段 3：工具执行（`:1360`–`:1520`）

```typescript
// src/query.ts:1380
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()          // 流式并行执行（已在阶段2中启动）
  : runTools(toolUseBlocks, assistantMessages, ...)      // 顺序执行

for await (const update of toolUpdates) {
  yield update.message        // 透传工具结果给上游
  toolResults.push(...)       // 收集 tool_result blocks
}
```

工具执行后生成 `ToolUseSummary`（用 Haiku 模型异步生成，下一轮开始时 yield）。

---

### 阶段 4：附件注入（`:1580`–`:1628`）

这是**每次工具执行后、下一次 API 调用前**注入额外上下文的关键阶段。

```typescript
// src/query.ts:1580
for await (const attachment of getAttachmentMessages(
  null,
  updatedToolUseContext,
  null,
  queuedCommandsSnapshot,    // ← 队列中待处理的 slash command / task-notification
  [...messagesForQuery, ...assistantMessages, ...toolResults],
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)   // ← 作为 tool_result 随下一次 API 请求发出
}
```

附件被 push 进 `toolResults`，在下一轮循环开始时随 `messagesForQuery` 一起发送给 API。

#### getAttachments() 注入的所有附件类型

`src/utils/attachments.ts:743`

**用户输入触发（仅首轮，有 input 时）：**

| 附件类型 | 函数 | 说明 |
|---------|------|------|
| `at_mentioned_files` | `processAtMentionedFiles()` | `@文件路径` 提及的文件内容 |
| `mcp_resources` | `processMcpResourceAttachments()` | `@mcp://` 提及的 MCP 资源 |
| `agent_mentions` | `processAgentMentions()` | `@AgentName` 提及的子代理定义 |
| `skill_discovery` | `getTurnZeroSkillDiscovery()` | 首轮 skill 搜索（feature: `EXPERIMENTAL_SKILL_SEARCH`） |

**所有线程通用附件（每轮评估，有变化才注入）：**

| 附件类型 | 函数 | 说明 |
|---------|------|------|
| `queued_commands` | `getQueuedCommandAttachments()` | 队列中的 prompt / task-notification 命令 |
| `date_change` | `getDateChangeAttachments()` | 日期跨天变化提醒 |
| `ultrathink_effort` | `getUltrathinkEffortAttachment()` | ultrathink 关键词触发的 effort 提示 |
| `deferred_tools_delta` | `getDeferredToolsDeltaAttachment()` | 工具列表变化增量通知 |
| `agent_listing_delta` | `getAgentListingDeltaAttachment()` | 可用子代理列表变化 |
| `mcp_instructions_delta` | `getMcpInstructionsDeltaAttachment()` | MCP 服务器指令变化 |
| `changed_files` | `getChangedFiles()` | 文件系统变化监听结果 |
| `nested_memory` | `getNestedMemoryAttachments()` | 嵌套目录下的 CODEBUDDY.md 内容 |
| `dynamic_skill` | `getDynamicSkillAttachments()` | 动态 skill 注入 |
| `skill_listing` | `getSkillListingAttachments()` | skill 列表 |
| `plan_mode` | `getPlanModeAttachments()` | Plan 模式状态提示 |
| `todo_reminders` | `getTodoReminderAttachments()` | Todo 列表提醒 |
| `teammate_mailbox` | `getTeammateMailboxAttachments()` | **Agent Team 消息**（来自 teammate SendMessage） |
| `team_context` | `getTeamContextAttachment()` | Agent Team 上下文信息 |
| `agent_pending_messages` | `getAgentPendingMessageAttachments()` | 子代理待处理消息 |
| `critical_system_reminder` | `getCriticalSystemReminderAttachment()` | 关键系统提醒 |

**仅主线程附件（subagent 不注入）：**

| 附件类型 | 函数 | 说明 |
|---------|------|------|
| `ide_selection` | `getSelectedLinesFromIDE()` | IDE 中选中的代码行 |
| `ide_opened_file` | `getOpenedFileFromIDE()` | IDE 当前打开的文件 |
| `output_style` | `getOutputStyleAttachment()` | 输出风格设置 |
| `diagnostics` | `getDiagnosticAttachments()` | 代码诊断错误（如 TypeScript 错误） |
| `lsp_diagnostics` | `getLSPDiagnosticAttachments()` | LSP 诊断信息 |
| `token_usage` | `getTokenUsageAttachment()` | Token 使用量提醒（接近上限时） |
| `budget_usd` | `getMaxBudgetUsdAttachment()` | USD 预算限制提醒 |
| `verify_plan_reminder` | `getVerifyPlanReminderAttachment()` | Plan 验证提醒 |

**异步预加载附件（在循环外提前启动，工具执行完后 await）：**

| 附件 | 启动位置 | 消费位置 | 说明 |
|------|---------|---------|------|
| `relevant_memories` | `startRelevantMemoryPrefetch()` `:301` | `:1604` | 相关 Memory 文件内容（并发 sideQuery 搜索） |
| `skill_discovery` | `skillPrefetch.startSkillDiscoveryPrefetch()` `:331` | `:1620` | 工具写入触发的 skill 搜索（inter-turn） |

---

### 阶段 5：继续/终止判断（`:1062`–`:1728`）

#### 5.1 无 tool_use 时（模型已完成回复）的终止路径

| 条件 | 处理 | 返回原因 |
|------|------|---------|
| `isWithheld413` + collapse 可恢复 | 触发 context collapse drain，`continue` | `collapse_drain_retry` |
| `isWithheld413` + reactive compact 可恢复 | 触发 reactive compact，`continue` | `reactive_compact_retry` |
| `isWithheldMaxOutputTokens` + 未超恢复限制 | 注入 meta 消息"Output token limit hit..."，`continue` | `max_output_tokens_recovery` |
| `isWithheldMaxOutputTokens` + capEnabled + 无 override | 将 maxOutputTokens 提升到 64k，`continue` | `max_output_tokens_escalate` |
| Stop Hook 有阻断错误 | 注入 hook 错误消息，`continue` | `stop_hook_blocking` |
| Token Budget 需要继续 | 注入 nudge 消息，`continue` | `token_budget_continuation` |
| 正常完成 | **return** | `completed` |

#### 5.2 有 tool_use 时的继续路径

工具执行完毕后，将结果拼入 state 进入下一轮：

```typescript
// src/query.ts:1715
state = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  // ↑ 当前轮次的：历史消息 + 模型回复 + 工具结果 + 附件
  toolUseContext: toolUseContextWithQueryTracking,
  turnCount: nextTurnCount,
  pendingToolUseSummary: nextPendingToolUseSummary,
  transition: { reason: 'next_turn' },
  ...
}
// → while(true) 继续下一轮
```

#### 5.3 其他终止条件

| 条件 | 返回原因 |
|------|---------|
| abort 信号（流式中） | `aborted_streaming` |
| abort 信号（工具执行中） | `aborted_tools` |
| Stop Hook 阻断 | `hook_stopped` |
| 超过 `maxTurns` | `max_turns` |
| Token 阻塞限制 | `blocking_limit` |
| 模型错误 | `model_error` |

---

## 五、完整数据流示意图

```
用户输入 (UserMessage)
    │
    ▼
[queryLoop 入口]
    │
    ├─ systemPrompt + appendSystemContext(systemContext)
    │      → 作为 API system 字段发出
    │
    ├─ prependUserContext(messages, userContext)
    │      → 在 messages[0] 前插入 <system-reminder> meta 消息
    │
    │  while (true)
    │  ┌────────────────────────────────────────────────┐
    │  │  阶段1: 消息预处理                              │
    │  │    getMessagesAfterCompactBoundary              │
    │  │    applyToolResultBudget                        │
    │  │    snipCompact → microcompact → autocompact     │
    │  │                                                 │
    │  │  阶段2: callModel({                             │
    │  │    messages: [userContext meta, ...history],    │
    │  │    systemPrompt: [...prompt, systemContext],    │
    │  │    tools: [...allTools]                         │
    │  │  })                                             │
    │  │    → 流式 yield AssistantMessage               │
    │  │    → 收集 toolUseBlocks                        │
    │  │                                                 │
    │  │  阶段3: 执行工具                                │
    │  │    runTools / StreamingToolExecutor             │
    │  │    → yield ToolResultMessage                   │
    │  │    → 收集 toolResults                          │
    │  │                                                 │
    │  │  阶段4: 注入附件                                │
    │  │    getAttachmentMessages()                      │
    │  │    → @文件、IDE选区、memory、teammate消息...   │
    │  │    → push 到 toolResults                       │
    │  │                                                 │
    │  │  阶段5: 判断是否继续                            │
    │  │    有 tool_use → state = next → continue       │
    │  │    无 tool_use → return { reason: 'completed' }│
    │  └────────────────────────────────────────────────┘
```

---

## 六、与 Agent Team 的集成点

### Teammate → Leader 消息注入

见附件类型 `teammate_mailbox`，注入路径：

```
Teammate.SendMessage()
  └── writeToMailbox(leaderName, message)          (teammateMailbox.ts)
        └── ~/.claude/teams/{team}/inboxes/{leader}.json

每轮 getAttachmentMessages() 调用
  └── getTeammateMailboxAttachments()              (attachments.ts:3532)
        └── readUnreadMessages(leaderName)
              → 格式化为 XML:
                <teammate_message teammate_id="alice" color="blue">
                  消息内容
                </teammate_message>
              → push 到 toolResults
              → 随下一次 callModel() 发出
```

### 交互式会话的并发路径（useInboxPoller）

当 session 空闲（非 loading）时，`useInboxPoller`（每 1s）也会将 teammate 消息作为新的 user turn 提交给 `query()`，绕过 `getAttachmentMessages` 路径直接触发新一轮循环。

---

## 七、关键函数速查

| 函数 | 文件 | 作用 |
|------|------|------|
| `query()` | `src/query.ts:219` | 对外入口，包装 queryLoop，处理命令生命周期 |
| `queryLoop()` | `src/query.ts:241` | 主循环体 |
| `getAttachments()` | `src/utils/attachments.ts:743` | 收集所有附件类型 |
| `getAttachmentMessages()` | `src/utils/attachments.ts:2937` | 将附件转为 AttachmentMessage 并 yield |
| `prependUserContext()` | `src/utils/api.ts:449` | 将 userContext 注入为首条 meta 消息 |
| `appendSystemContext()` | `src/utils/api.ts:437` | 将 systemContext 追加到 systemPrompt |
| `applyToolResultBudget()` | `src/utils/toolResultStorage.ts` | 裁剪超大 tool result |
| `runTools()` | `src/services/tools/toolOrchestration.ts` | 顺序执行工具 |
| `StreamingToolExecutor` | `src/services/tools/StreamingToolExecutor.ts` | 流式并行执行工具 |
| `handleStopHooks()` | `src/query/stopHooks.ts` | 处理 stop hook 逻辑 |
| `buildPostCompactMessages()` | `src/services/compact/compact.ts` | 构建压缩后的消息列表 |
| `startRelevantMemoryPrefetch()` | `src/utils/attachments.ts` | 异步预加载相关 Memory |
