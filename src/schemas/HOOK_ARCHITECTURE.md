# Hook 系统架构文档

> 本文档面向初学者，帮助快速了解 Claude Code 的 Hook 系统实现、类别和用法。
> 所有代码出处均标注了文件路径和行号。

---

## 目录

1. [概述](#概述)
2. [Hook 如何出现在提示词中](#hook-如何出现在提示词中)
3. [Hook 事件类型（27 种）](#hook-事件类型27-种)
4. [Hook 类型（6 种）](#hook-类型6-种)
5. [Schema 定义](#schema-定义)
6. [核心执行引擎](#核心执行引擎)
7. [触发时机与处理流程](#触发时机与处理流程)
8. [Hook 结果如何影响执行](#hook-结果如何影响执行)
9. [配置示例](#配置示例)
10. [关键文件索引](#关键文件索引)

---

## 概述

Hook 是用户可自定义的命令/逻辑，在 Claude Code 生命周期的特定节点自动执行。它们可以：

- **在工具执行前/后**运行自定义命令（如自动格式化代码）
- **拦截或修改**工具调用（如阻止危险操作、修改输入参数）
- **在会话开始/结束时**执行初始化或清理
- **向 LLM 上下文注入额外信息**

Hook 的配置存储在 `settings.json` 中，通过 Zod schema 进行类型安全的校验。

---

## Hook 如何出现在提示词中

Hook schema 通过**两条路径**注入到 LLM 的提示词中：

### 路径 A：主 System Prompt（所有对话）

每次对话都会包含一段关于 Hook 的说明文字：

```
src/constants/prompts.ts（第 127-129 行）
```

```typescript
function getHooksSection(): string {
  return `Users may configure 'hooks', shell commands that execute in response
  to events like tool calls, in settings. Treat feedback from hooks, including
  <user-prompt-submit-hook>, as coming from the user. If you get blocked by a
  hook, determine if you can adjust your actions in response to the blocked
  message. If not, ask the user to check their hooks configuration.`
}
```

这段文字在 `getSimpleSystemSection()` 中被注入 system prompt：

```
src/constants/prompts.ts（第 192 行）
```

```typescript
getHooksSection(),  // 作为 # System 部分的一个条目
```

### 路径 B：`update-config` Skill Prompt（配置相关任务时）

当用户要求配置 Hook 时，`update-config` skill 会注入完整的 Hook 文档和 Settings JSON Schema：

```
src/skills/bundled/updateConfig.ts（第 110-267 行）
```

```typescript
const HOOKS_DOCS = `## Hooks Configuration
Hooks run commands at specific points in Claude Code's lifecycle.
...`
```

以及动态生成的完整 JSON Schema（包含 HooksSchema 的所有 `.describe()` 描述信息）：

```
src/skills/bundled/updateConfig.ts（第 462-466 行）
```

```typescript
const jsonSchema = generateSettingsSchema()  // toJSONSchema(SettingsSchema())
prompt += `\n\n## Full Settings JSON Schema\n\n\`\`\`json\n${jsonSchema}\n\`\`\``
```

**数据流链条：**

```
HookCommandSchema (.describe() 描述)
  └──> HookMatcherSchema
        └──> HooksSchema
              └──> SettingsSchema.hooks 字段  [types.ts 第 435 行]
                    └──> toJSONSchema(SettingsSchema())  [updateConfig.ts 第 11 行]
                          └──> 注入 update-config skill prompt  [updateConfig.ts 第 466 行]
```

---

## Hook 事件类型（27 种）

定义位置：`src/entrypoints/sdk/coreTypes.ts`（第 25-53 行）

```typescript
export const HOOK_EVENTS = [
  'PreToolUse',         // 工具执行前
  'PostToolUse',        // 工具执行后（成功）
  'PostToolUseFailure', // 工具执行后（失败）
  'Notification',       // 通知
  'UserPromptSubmit',   // 用户提交 prompt
  'SessionStart',       // 会话开始
  'SessionEnd',         // 会话结束
  'Stop',               // 模型停止生成
  'StopFailure',        // 停止失败
  'SubagentStart',      // 子 agent 启动
  'SubagentStop',       // 子 agent 停止
  'PreCompact',         // 上下文压缩前
  'PostCompact',        // 上下文压缩后
  'PermissionRequest',  // 权限请求
  'PermissionDenied',   // 权限拒绝
  'Setup',              // 初始化/维护
  'TeammateIdle',       // 队友空闲
  'TaskCreated',        // 任务创建
  'TaskCompleted',      // 任务完成
  'Elicitation',        // 引导提问
  'ElicitationResult',  // 引导结果
  'ConfigChange',       // 配置变更
  'WorktreeCreate',     // 工作树创建
  'WorktreeRemove',     // 工作树移除
  'InstructionsLoaded', // 指令加载
  'CwdChanged',         // 工作目录变更
  'FileChanged',        // 文件变更
] as const
```

### 常用事件速查表

| 事件 | Matcher 匹配目标 | 用途 | 典型场景 |
|------|-----------------|------|---------|
| `PreToolUse` | 工具名 | 工具执行前拦截 | 阻止危险操作、修改输入 |
| `PostToolUse` | 工具名 | 工具执行后处理 | 自动格式化、运行测试 |
| `Stop` | — | 模型停止时执行 | 验证计划完成度 |
| `UserPromptSubmit` | — | 用户提交消息时 | 注入上下文 |
| `SessionStart` | — | 会话开始时 | 初始化环境 |
| `Setup` | — | 初始化/维护触发 | 安装依赖 |

---

## Hook 类型（6 种）

Hook 分为两大类：**用户可配置（可持久化到 settings.json）** 和 **仅内部使用（运行时内存中）**。

### 用户可配置的 Hook 类型（4 种）

这些类型在 `src/schemas/hooks.ts`（第 31-171 行）中通过 Zod schema 定义，用户可以写入 `settings.json` 持久化。

#### 1. Command Hook（Shell 命令）

**type**: `"command"`

通过 `spawn` 子进程执行 shell 命令，stdin 传入 JSON 格式的 hookInput。

```
src/schemas/hooks.ts（第 32-65 行）
```

```typescript
const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),       // 要执行的 shell 命令
  if: IfConditionSchema(),   // 条件过滤（如 "Bash(git *)"）
  shell: z.enum(SHELL_TYPES).optional(),  // bash / powershell
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),       // 只执行一次
  async: z.boolean().optional(),      // 后台执行，不阻塞
  asyncRewake: z.boolean().optional() // 后台执行，退出码 2 时唤醒模型
})
```

**退出码约定：**
- `0` = 成功
- `2` = 阻塞错误（blocking error）
- 其他 = 非阻塞错误

**执行入口：** `src/utils/hooks.ts`（第 2446-2461 行）的 `execCommandHook()` 调用

#### 2. Prompt Hook（LLM 单轮查询）

**type**: `"prompt"`

使用小模型（默认 Haiku）进行**单轮** LLM 查询，返回 `{ok: true/false, reason?}` 结果。

```
src/schemas/hooks.ts（第 67-95 行）
```

```typescript
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string(),  // 要评估的 prompt（支持 $ARGUMENTS 占位符）
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  model: z.string().optional(),  // 使用的模型，默认 Haiku
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

**执行实现：** `src/utils/hooks/execPromptHook.ts`（第 21-211 行）

```typescript
// 系统提示要求返回 JSON：
// {ok: true} 或 {ok: false, reason: "..."}
const response = await queryModelWithoutStreaming({
  systemPrompt: asSystemPrompt([
    `You are evaluating a hook in Claude Code.
     Return: {"ok": true} or {"ok": false, "reason": "..."}`,
  ]),
  // ...
})
```

**限制：** 仅可用于工具相关事件（`PreToolUse`、`PostToolUse`、`PermissionRequest`）。

#### 3. Agent Hook（LLM 多轮查询）

**type**: `"agent"`

使用 `query()` 函数进行**多轮** LLM 交互（最多 50 轮），可使用工具验证条件。

```
src/schemas/hooks.ts（第 128-163 行）
```

```typescript
const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string(),  // 验证指令（如 "Verify that unit tests passed."）
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),  // 默认 60 秒
  model: z.string().optional(),  // 默认 Haiku
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

**执行实现：** `src/utils/hooks/execAgentHook.ts`（第 36-339 行）

核心特点：
- 创建独立的 `hookAgentId`，有自己的 abort controller
- 可使用**所有可用工具**（排除 agent 相关工具防止递归）
- 通过 `StructuredOutputTool` 强制返回 `{ok, reason}` 结构化结果
- 典型用途：Stop hook 验证 agent 是否完成了计划

```typescript
const MAX_AGENT_TURNS = 50
for await (const message of query({
  messages: agentMessages,
  systemPrompt,
  querySource: 'hook_agent',
})) {
  // 处理流式事件，检查 structured output...
}
```

**限制：** 同 Prompt Hook，仅可用于工具相关事件。

#### 4. HTTP Hook（HTTP POST）

**type**: `"http"`

向配置的 URL 发送 POST 请求，body 为 hook input JSON。

```
src/schemas/hooks.ts（第 97-126 行）
```

```typescript
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),       // POST 目标 URL
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),     // 自定义 headers
  allowedEnvVars: z.array(z.string()).optional(),           // 允许插值的环境变量
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

**执行实现：** `src/utils/hooks/execHttpHook.ts`（第 123-242 行）

安全特性：
- **URL 白名单**策略（`allowedHttpHookUrls`）
- **SSRF 防护**（`ssrfGuardedLookup`，阻止私有/链路本地 IP）
- Header 中的**环境变量插值**仅限 `allowedEnvVars` 中声明的变量
- **CRLF 注入防护**（`sanitizeHeaderValue`）

```typescript
// 安全检查链：
// 1. URL 白名单验证
// 2. SSRF guard（阻止私有 IP）
// 3. 环境变量白名单插值
// 4. Header 值清洗（防 CRLF 注入）
const response = await axios.post(hook.url, jsonInput, {
  headers,
  lookup: ssrfGuardedLookup,
})
```

### 仅内部使用的 Hook 类型（2 种）

这两种类型**无法写入 settings.json**，仅在运行时内存中存在。

#### 5. Callback Hook

定义位置：`src/types/hooks.ts`（第 211-226 行）

```typescript
export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    abort: AbortSignal | undefined,
    hookIndex?: number,
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean  // 内部 hook 不计入 metrics
}
```

用于内部功能，如 session file access analytics、attribution tracking 等。

#### 6. Function Hook

定义位置：`src/utils/hooks/sessionHooks.ts`（第 24-31 行）

```typescript
export type FunctionHook = {
  type: 'function'
  id?: string
  timeout?: number
  callback: (messages: Message[], signal?: AbortSignal) => boolean | Promise<boolean>
  errorMessage: string
  statusMessage?: string
}
```

会话级别的 TypeScript 回调，用于运行时验证。典型用途：`StructuredOutput` 强制执行。

```
src/utils/hooks/hookHelpers.ts（第 70-83 行）
```

```typescript
// 注册一个 Function Hook 强制 agent 使用 StructuredOutputTool
export function registerStructuredOutputEnforcement(
  setAppState: SetAppState,
  sessionId: string,
): void {
  addFunctionHook(
    setAppState, sessionId, 'Stop', '',
    messages => hasSuccessfulToolCall(messages, SYNTHETIC_OUTPUT_TOOL_NAME),
    `You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool to complete this request.`,
  )
}
```

---

## Schema 定义

### 层级结构

Schema 定义在 `src/schemas/hooks.ts` 中，采用**自底向上的组合**模式：

```
IfConditionSchema          （条件过滤）
    ↓
buildHookSchemas()         （4 种 Hook 类型的 Schema 工厂）
    ↓
HookCommandSchema          （判别联合，按 type 字段区分）  [第 176 行]
    ↓
HookMatcherSchema          （matcher + hooks 数组）       [第 194 行]
    ↓
HooksSchema                （事件名 → 匹配器数组）        [第 211 行]
    ↓
SettingsSchema.hooks       （settings.json 的 hooks 字段） [types.ts 第 435 行]
```

### HookCommandSchema —— 判别联合

```
src/schemas/hooks.ts（第 176-189 行）
```

```typescript
export const HookCommandSchema = lazySchema(() => {
  const { BashCommandHookSchema, PromptHookSchema, AgentHookSchema, HttpHookSchema } = buildHookSchemas()
  return z.discriminatedUnion('type', [
    BashCommandHookSchema,   // type: 'command'
    PromptHookSchema,        // type: 'prompt'
    AgentHookSchema,         // type: 'agent'
    HttpHookSchema,          // type: 'http'
  ])
})
```

### HookMatcherSchema —— 匹配器 + Hook 列表

```
src/schemas/hooks.ts（第 194-204 行）
```

```typescript
export const HookMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z.string().optional(),  // 匹配模式（如工具名 "Write"、"Bash"）
    hooks: z.array(HookCommandSchema()),  // 匹配时执行的 hook 列表
  }),
)
```

### HooksSchema —— 完整配置

```
src/schemas/hooks.ts（第 211-213 行）
```

```typescript
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)
```

### 打破循环依赖

这些 schema 原本在 `src/utils/settings/types.ts` 中，为了打破 `settings/types.ts` ↔ `plugins/schemas.ts` 的循环依赖，被提取到了独立的 `src/schemas/hooks.ts` 文件。使用 `lazySchema()` 工具实现延迟求值进一步避免循环。

### 导出的 TypeScript 类型

```
src/schemas/hooks.ts（第 216-222 行）
```

```typescript
export type HookCommand = z.infer<ReturnType<typeof HookCommandSchema>>
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>
export type PromptHook = Extract<HookCommand, { type: 'prompt' }>
export type AgentHook = Extract<HookCommand, { type: 'agent' }>
export type HttpHook = Extract<HookCommand, { type: 'http' }>
export type HookMatcher = z.infer<ReturnType<typeof HookMatcherSchema>>
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>
```

---

## 核心执行引擎

### `executeHooks()` —— 统一执行入口

```
src/utils/hooks.ts（第 1952 行起）
```

**所有 hook 的统一执行入口**，核心流程：

```
1. 安全检查
   ├── shouldDisableAllHooksIncludingManaged?
   ├── CLAUDE_CODE_SIMPLE 模式?
   └── 工作区信任检查 (shouldSkipHookDueToTrust)

2. 匹配 hook
   └── getMatchingHooks(appState, sessionId, hookEvent, hookInput, tools)

3. 快速路径（全是内部 callback）
   └── 跳过 span/progress，直接执行

4. 完整路径（有用户 hook）
   ├── yield progress messages（每个 hook 一条）
   └── 并行执行所有匹配的 hook：
       ├── callback  → executeHookCallback()
       ├── function  → executeFunctionHook()
       ├── prompt    → execPromptHook()      [execPromptHook.ts]
       ├── agent     → execAgentHook()        [execAgentHook.ts]
       ├── http      → execHttpHook()         [execHttpHook.ts]
       └── command   → execCommandHook()      [hooks.ts 内联]
```

### 按类型分发

```
src/utils/hooks.ts（第 2142-2461 行）
```

```typescript
// 并行执行所有 hook
const hookPromises = matchingHooks.map(async function*({ hook }) {
  if (hook.type === 'callback')  → executeHookCallback(...)     // 第 2147 行
  if (hook.type === 'function')  → executeFunctionHook(...)     // 第 2165 行
  if (hook.type === 'prompt')    → execPromptHook(...)          // 第 2224 行
  if (hook.type === 'agent')     → execAgentHook(...)           // 第 2256 行
  if (hook.type === 'http')      → execHttpHook(...)            // 第 2296 行
  // 默认：command
  → execCommandHook(...)                                        // 第 2448 行
})
```

---

## 触发时机与处理流程

### 1. 工具执行前后（PreToolUse / PostToolUse）

```
src/services/tools/toolHooks.ts
```

#### PreToolUse（第 435 行起）

```
用户/模型请求执行工具
  └── runPreToolUseHooks()
        └── executePreToolHooks()  [hooks.ts 第 3394 行]
              └── executeHooks({ hookEvent: 'PreToolUse', matchQuery: toolName })
                    └── Hook 结果可以：
                          ├── 阻塞工具执行（blockingError → deny）
                          ├── 控制权限（permissionBehavior = allow/deny/passthrough）
                          ├── 修改工具输入（updatedInput）
                          ├── 阻止继续（preventContinuation + stopReason）
                          └── 添加上下文（additionalContexts）
```

#### PostToolUse（第 39 行起）

```
工具执行完成
  └── runPostToolUseHooks()
        └── executePostToolHooks()  [hooks.ts 第 3450 行]
              └── executeHooks({ hookEvent: 'PostToolUse', matchQuery: toolName })
                    └── Hook 结果可以：
                          ├── 产生阻塞错误附件
                          ├── 阻止继续（preventContinuation）
                          ├── 添加附加上下文
                          └── 更新 MCP 工具输出（updatedMCPToolOutput）
```

### 2. 模型停止时（Stop）

```
src/query/stopHooks.ts（第 65 行起）
```

```
每个 query turn 结束
  └── handleStopHooks()
        ├── 保存 cache-safe params
        ├── 执行后台任务（prompt suggestion、memory extraction、auto-dream）
        └── executeStopHooks()  [hooks.ts 第 3639 行]
              └── executeHooks({ hookEvent: 'Stop' })
                    └── 根据 blockingError/preventContinuation 决定是否允许停止
```

### 3. 会话开始时（SessionStart）

```
src/utils/sessionStart.ts（第 35 行起）
```

```
会话启动/恢复/清除/压缩
  └── processSessionStartHooks(source)
        ├── 加载插件 hook（loadPluginHooks()）
        └── executeSessionStartHooks(source, ...)  [hooks.ts 第 3867 行]
              └── executeHooks({ hookEvent: 'SessionStart' })
                    └── 收集结果：
                          ├── hookMessages → 返回给调用方
                          ├── additionalContexts → hook_additional_context 附件
                          ├── initialUserMessage → 通过 side channel 传递
                          └── watchPaths → 注册文件监控
```

### 4. 初始化/维护时（Setup）

```
src/utils/sessionStart.ts（第 177 行起）
```

```
--init / --maintenance 参数
  └── processSetupHooks(trigger: 'init' | 'maintenance')
        └── executeSetupHooks(trigger)  [hooks.ts 第 3902 行]
```

---

## Hook 结果如何影响执行

### HookResult（单个 Hook）

```
src/types/hooks.ts（第 260-275 行）
```

```typescript
export type HookResult = {
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean           // 阻止后续执行
  stopReason?: string                     // 停止原因
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  updatedInput?: Record<string, unknown>  // 修改后的工具输入
  additionalContext?: string              // 注入到 LLM 上下文
  updatedMCPToolOutput?: unknown          // 更新 MCP 工具输出
  permissionRequestResult?: PermissionRequestResult
  // ...
}
```

### Hook JSON 输出格式

Hook 通过 stdout 输出 JSON 来控制行为：

```
src/types/hooks.ts（第 50-166 行）
```

```json
{
  "continue": false,
  "stopReason": "Message shown when blocking",
  "suppressOutput": false,
  "decision": "block",
  "reason": "Explanation",
  "systemMessage": "Warning shown to user",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "...",
    "updatedInput": { "..." },
    "additionalContext": "Context injected back to model"
  }
}
```

不同事件支持的 `hookSpecificOutput` 字段：

| hookEventName | 特有字段 |
|---|---|
| `PreToolUse` | `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext` |
| `PostToolUse` | `additionalContext`, `updatedMCPToolOutput` |
| `UserPromptSubmit` | `additionalContext` |
| `SessionStart` | `additionalContext`, `initialUserMessage`, `watchPaths` |
| `Setup` | `additionalContext` |
| `PermissionRequest` | `decision: {behavior: 'allow'|'deny', ...}` |
| `PermissionDenied` | `retry` |

---

## 配置示例

### 自动格式化写入的文件

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \"$f\"; } 2>/dev/null || true"
      }]
    }]
  }
}
```

### 记录所有 Bash 命令

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.command' >> ~/.claude/bash-log.txt"
      }]
    }]
  }
}
```

### 代码变更后运行测试

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.file_path // .tool_response.filePath' | grep -E '\\.(ts|js)$' && npm test || true"
      }]
    }]
  }
}
```

### 使用条件过滤（`if` 字段）

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "echo 'git command detected'",
        "if": "Bash(git *)"
      }]
    }]
  }
}
```

---

## 关键文件索引

### Schema 与类型定义

| 文件 | 作用 |
|------|------|
| `src/schemas/hooks.ts` | **Hook 配置 schema 定义**（4 种用户可配置类型） |
| `src/types/hooks.ts` | **Hook 类型定义**：HookResult、AggregatedHookResult、HookCallback、JSON 输出 schema |
| `src/entrypoints/sdk/coreTypes.ts` | HOOK_EVENTS 常量定义（27 种事件） |
| `src/utils/settings/types.ts` | SettingsSchema 中的 `hooks` 字段（第 435 行） |
| `src/utils/plugins/schemas.ts` | 插件 Hook schema（PluginHooksSchema） |

### 核心执行引擎

| 文件 | 作用 |
|------|------|
| `src/utils/hooks.ts` | **核心引擎**：`executeHooks()` 统一入口 + 各 `execute*Hooks()` 包装函数（5023 行） |
| `src/utils/hooks/execPromptHook.ts` | Prompt Hook 执行（LLM 单轮查询） |
| `src/utils/hooks/execAgentHook.ts` | Agent Hook 执行（LLM 多轮查询） |
| `src/utils/hooks/execHttpHook.ts` | HTTP Hook 执行（POST 请求 + SSRF 防护） |
| `src/utils/hooks/hookHelpers.ts` | 辅助工具：schema、参数替换、StructuredOutput |

### 触发入口

| 文件 | 作用 |
|------|------|
| `src/services/tools/toolHooks.ts` | 工具 Hook 处理：`runPreToolUseHooks()` / `runPostToolUseHooks()` |
| `src/query/stopHooks.ts` | Stop Hook 处理：`handleStopHooks()` |
| `src/utils/sessionStart.ts` | SessionStart / Setup Hook 入口 |

### Hook 管理与配置

| 文件 | 作用 |
|------|------|
| `src/utils/hooks/sessionHooks.ts` | Session Hook 管理（FunctionHook、SessionStore） |
| `src/utils/hooks/hookEvents.ts` | Hook 事件广播系统 |
| `src/utils/hooks/hooksConfigManager.ts` | Hook 配置管理 |
| `src/utils/hooks/hooksSettings.ts` | Hook 设置加载 |
| `src/utils/hooks/hooksConfigSnapshot.ts` | Hook 配置快照 |
| `src/utils/hooks/AsyncHookRegistry.ts` | 异步 Hook 注册表 |

### 安全

| 文件 | 作用 |
|------|------|
| `src/utils/hooks/ssrfGuard.ts` | HTTP Hook 的 SSRF 防护 |

### 提示词注入

| 文件 | 作用 |
|------|------|
| `src/constants/prompts.ts` | 主 system prompt 的 `getHooksSection()`（第 127 行） |
| `src/skills/bundled/updateConfig.ts` | `HOOKS_DOCS` + `HOOK_VERIFICATION_FLOW` + JSON Schema 注入（第 110-466 行） |
| `src/utils/settings/schemaOutput.ts` | Settings JSON Schema 生成 |

---

## 附录：Hook 输入数据格式

所有 Hook 接收的 stdin JSON 都包含以下基础字段：

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "agent_id": "optional-subagent-id",
  "agent_type": "optional-agent-type"
}
```

不同事件会附加额外字段：

- **PreToolUse / PostToolUse**: `tool_name`, `tool_input`, `tool_use_id`, `tool_response`（仅 Post）
- **SessionStart**: `source`（startup/resume/clear/compact）, `model`
- **Stop**: `stop_hook_active`, `last_assistant_message`
- **Setup**: `trigger`（init/maintenance）
