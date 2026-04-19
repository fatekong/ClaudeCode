# Agent Tool 系统架构文档

> 本文档记录了 `src/tools/AgentTool/` 目录下完整的子代理（Sub-agent）生成与管理系统的核心设计、架构和功能。

---

## 目录

- [一、系统概述](#一系统概述)
- [二、文件模块职责](#二文件模块职责)
- [三、核心架构流程](#三核心架构流程)
- [四、代理类型体系](#四代理类型体系)
- [五、三种运行模式](#五三种运行模式)
- [六、Fork 分叉机制](#六fork-分叉机制)
- [七、工具过滤与权限控制](#七工具过滤与权限控制)
- [八、子代理执行引擎](#八子代理执行引擎)
- [九、持久记忆系统](#九持久记忆系统)
- [十、代理恢复机制](#十代理恢复机制)
- [十一、安全分类与审查](#十一安全分类与审查)
- [十二、UI 渲染层](#十二ui-渲染层)
- [十三、设计亮点](#十三设计亮点)

---

## 一、系统概述

Agent Tool 是一个完整的 **子代理生成与管理系统**，允许主 AI 代理（parent agent）动态地启动、运行、监控和管理多个专用子代理来并行或串行处理复杂任务。

### 核心目标

让一个主代理能够将复杂的多步骤任务**拆分委派**给多个专门化的子代理，每个子代理拥有独立的：

- 工具集（可用工具白名单/黑名单）
- 权限模式（bubble / plan / acceptEdits 等）
- LLM 模型配置
- 上下文与消息历史
- 生命周期管理

可类比为一个 **"AI 进程管理器"**。

---

## 二、文件模块职责

| 文件 | 职责 | 关键导出 |
|------|------|----------|
| `AgentTool.tsx` | **核心入口** — Tool 定义、`call()` 调度、I/O schema | `AgentTool`, `inputSchema`, `outputSchema` |
| `UI.tsx` | **UI 渲染** — 终端中展示子代理进度/结果/错误 | `renderToolUseMessage`, `renderToolResultMessage` 等 |
| `runAgent.ts` | **执行引擎** — 构造上下文、query 循环、资源清理 | `runAgent()`, `filterIncompleteToolCalls()` |
| `forkSubagent.ts` | **Fork 机制** — 代理分叉，继承父对话上下文 | `isForkSubagentEnabled()`, `buildForkedMessages()`, `FORK_AGENT` |
| `prompt.ts` | **提示词生成** — 动态生成使用说明和代理列表 | `getPrompt()`, `formatAgentLine()` |
| `constants.ts` | **常量定义** — 工具名称、内建代理类型集合 | `AGENT_TOOL_NAME`, `ONE_SHOT_BUILTIN_AGENT_TYPES` |
| `agentToolUtils.ts` | **工具辅助** — 工具过滤/解析、结果封装、异步生命周期 | `resolveAgentTools()`, `runAsyncAgentLifecycle()`, `finalizeAgentTool()` |
| `builtInAgents.ts` | **内建代理注册** — 注册所有内建代理类型 | `getBuiltInAgents()` |
| `loadAgentsDir.ts` | **代理加载** — 从 Markdown/JSON/插件加载代理定义 | `getAgentDefinitionsWithOverrides()`, `AgentDefinition` |
| `agentDisplay.ts` | **展示辅助** — 代理信息格式化、覆盖检测 | `resolveAgentOverrides()`, `AGENT_SOURCE_GROUPS` |
| `agentColorManager.ts` | **颜色管理** — 为代理类型分配独特颜色 | `getAgentColor()`, `setAgentColor()` |
| `agentMemory.ts` | **持久记忆** — 跨会话持久化记忆 | `loadAgentMemoryPrompt()`, `getAgentMemoryDir()` |
| `agentMemorySnapshot.ts` | **记忆快照** — 项目级记忆快照同步 | `checkAgentMemorySnapshot()`, `initializeFromSnapshot()` |
| `resumeAgent.ts` | **代理恢复** — 从磁盘 transcript 恢复中断的代理 | `resumeAgentBackground()` |

### `built-in/` 子目录

| 文件 | 代理类型 | 用途 |
|------|----------|------|
| `exploreAgent.ts` | `Explore` | 只读代码探索，不修改文件 |
| `planAgent.ts` | `Plan` | 任务规划与方案设计 |
| `generalPurposeAgent.ts` | `general-purpose` | 通用代理，默认选项 |
| `verificationAgent.ts` | `verification` | 结果验证代理 |
| `claudeCodeGuideAgent.ts` | `claude-code-guide` | Claude Code 使用指南 |
| `statuslineSetup.ts` | `statusline-setup` | 状态栏配置代理 |

---

## 三、核心架构流程

```
用户请求 → 主代理决策 → 调用 AgentTool.call()
                              │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        同步子代理         异步后台代理       Fork 分叉
        (前台阻塞)        (后台运行)       (继承上下文)
              │                │                │
              └────── runAgent() ───────────────┘
                         │
                         ▼
                ┌─ 1. 解析模型
                ├─ 2. 构建系统提示
                ├─ 3. 过滤/组装工具集
                ├─ 4. 设置权限模式
                ├─ 5. 预加载 Skills
                ├─ 6. 初始化 MCP 服务器
                ├─ 7. 执行 SubagentStart Hooks
                └─ 8. 创建子代理上下文
                         │
                         ▼
                  query() 消息循环
                (LLM 调用 + 工具执行)
                         │
                    ┌────┴────┐
                    ▼         ▼
              Yield 消息   记录 Transcript
                    │
                    ▼
             结果返回 → 通知父代理
             资源清理 (MCP/Hooks/Cache/Shell/Perfetto)
```

### `call()` 方法主流程（AgentTool.tsx）

1. **参数解析**：提取 prompt、subagent_type、model、isolation 等
2. **团队模式判断**：如果提供了 `team_name + name`，走 `spawnTeammate()` 路径
3. **代理类型路由**：
   - 有 `subagent_type` → 查找对应代理定义
   - 无 `subagent_type` + Fork 开启 → Fork 路径
   - 无 `subagent_type` + Fork 关闭 → 默认 `general-purpose`
4. **权限检查**：`filterDeniedAgents()` 过滤被拒绝的代理
5. **MCP 要求检查**：`hasRequiredMcpServers()` 验证 MCP 服务器可用性
6. **隔离模式处理**：worktree / remote
7. **工具池组装**：`assembleToolPool()` 根据权限构建工具集
8. **运行模式分发**：
   - 同步 → 直接 `runAgent()` 并等待
   - 异步 → `runAsyncAgentLifecycle()` 后台运行
   - Fork → 使用 `buildForkedMessages()` 构造上下文后运行
9. **结果封装**：`finalizeAgentTool()` 构造标准化返回值

---

## 四、代理类型体系

### 类型定义层次

```typescript
// 基础类型 — 所有代理共享的字段
type BaseAgentDefinition = {
  agentType: string           // 代理名称标识
  whenToUse: string           // 使用场景描述
  tools?: string[]            // 可用工具白名单
  disallowedTools?: string[]  // 工具黑名单
  skills?: string[]           // 预加载的 Skills
  mcpServers?: AgentMcpServerSpec[] // 专属 MCP 服务器
  hooks?: HooksSettings       // 生命周期钩子
  model?: string              // LLM 模型
  effort?: EffortValue        // 输出精细度
  permissionMode?: PermissionMode // 权限模式
  maxTurns?: number           // 最大对话轮次
  memory?: AgentMemoryScope   // 持久记忆作用域
  isolation?: 'worktree' | 'remote' // 隔离模式
  background?: boolean        // 是否强制后台运行
  initialPrompt?: string      // 首轮追加提示
  // ...更多字段
}

// 内建代理
type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  getSystemPrompt: (params) => string  // 动态系统提示
  callback?: () => void
}

// 自定义代理（Markdown / JSON）
type CustomAgentDefinition = BaseAgentDefinition & {
  source: SettingSource  // userSettings / projectSettings / policySettings 等
  getSystemPrompt: () => string
}

// 插件代理
type PluginAgentDefinition = BaseAgentDefinition & {
  source: 'plugin'
  plugin: string
  getSystemPrompt: () => string
}
```

### 代理来源与优先级

代理定义来自多个来源，高优先级覆盖低优先级（同名代理取最高优先级的定义）：

```
Built-in → Plugin → User → Project → Flag → Managed(Policy)
   低优先级 ────────────────────────────────── 高优先级
```

`getActiveAgentsFromList()` 按此顺序合并，后出现的覆盖先前的。

### 代理加载流程

```
loadMarkdownFilesForSubdir('agents', cwd)
    ↓
parseAgentFromMarkdown() × N      ← Markdown 前端元数据解析
    ↓
loadPluginAgents()                 ← 插件代理加载
    ↓
getBuiltInAgents()                 ← 内建代理注册
    ↓
合并去重 → activeAgents + allAgents
    ↓
initializeAgentMemorySnapshots()   ← 记忆快照初始化（如启用）
```

---

## 五、三种运行模式

### 1. 同步前台模式

```
父代理 ─── call() ──→ runAgent() ──→ yield 消息 ──→ 等待完成 ──→ 返回结果
         (阻塞)                                                (继续执行)
```

- 父代理阻塞等待子代理完成
- 子代理共享父代理的 `abortController`（可一起取消）
- 共享 `setAppState` 回调
- 适用于需要结果才能继续的场景

### 2. 异步后台模式

```
父代理 ─── call() ──→ registerAsyncAgent() ──→ 立即返回
                              ↓
                    runAsyncAgentLifecycle()  ← 独立后台运行
                              ↓
                    完成/失败/终止 → 通知父代理
```

- 通过 `run_in_background=true` 或代理定义 `background: true` 触发
- 子代理获得独立的 `AbortController`
- 注册为 `LocalAgentTask`，可通过任务系统管理
- 完成后通过 `enqueueAgentNotification()` 通知父代理
- 支持 `ProgressTracker` 实时进度更新
- 适用于长时间运行的独立任务

### 3. Fork 分叉模式

```
父代理 ─── call() ──→ 继承上下文 + buildForkedMessages()
                              ↓
                    runAgent(useExactTools=true)  ← 共享 prompt cache
                              ↓
                    独立工作 → 通知父代理
```

- 省略 `subagent_type` 时触发（需 feature gate 开启）
- 子代理完整继承父对话上下文和系统提示
- 使用 `useExactTools=true`，保持与父代理相同的工具集
- **字节相同的 API 前缀**，最大化 prompt cache 命中
- `permissionMode: 'bubble'` 将权限提示冒泡到父终端
- 防递归保护：检测 `<fork_boilerplate>` 标签防止 Fork 中再 Fork
- 适用于研究型、探索型任务

---

## 六、Fork 分叉机制

Fork 是整个系统中最精巧的设计，核心在于 **prompt cache 共享**。

### 工作原理

1. 父代理发起 Fork 时，`buildForkedMessages()` 构造消息：
   - 保留父代理的完整 assistant 消息（含所有 tool_use 块）
   - 为每个 tool_use 生成**统一占位符** tool_result
   - 仅在最后附加一个**特定于该子代理的指令文本**

2. 结果消息结构：
   ```
   [...历史消息, assistant(所有tool_uses), user(占位符results... + 指令)]
   ```

3. 所有 Fork 子代理共享相同的前缀，仅最后一个文本块不同 → **最大化 cache 命中**

### Fork 子代理指令模板

子代理收到的指令包含严格的行为规范：

- **不能再次 Fork**（你已经是 Fork）
- **不要对话**，直接使用工具执行
- **修改文件后必须 commit**
- **工具调用之间不输出文本**
- **严格限定在指令范围内**
- **报告格式**：Scope → Result → Key files → Files changed → Issues

### 安全防护

```typescript
// 递归 Fork 检测
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    return content.some(block =>
      block.type === 'text' && block.text.includes(`<fork_boilerplate>`)
    )
  })
}
```

- 主要检查：`querySource === 'agent:builtin:fork'`（抗 autocompact）
- 备用检查：消息中包含 `<fork_boilerplate>` 标签
- 与 coordinator 模式互斥

---

## 七、工具过滤与权限控制

### 多层过滤策略

```
全部可用工具 (availableTools)
       ↓
filterToolsForAgent()          ← 第一层：按代理类型/运行模式过滤
       ↓
resolveAgentTools()            ← 第二层：按代理定义的白名单/黑名单过滤
       ↓
initializeAgentMcpServers()    ← 第三层：合并代理专属 MCP 工具
       ↓
最终工具集 (allTools)
```

### filterToolsForAgent — 按运行模式过滤

```typescript
function filterToolsForAgent({ tools, isBuiltIn, isAsync, permissionMode }): Tools {
  return tools.filter(tool => {
    // MCP 工具始终可用
    if (tool.name.startsWith('mcp__')) return true
    // 全局禁止列表
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    // 自定义代理额外限制
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    // 异步代理只允许白名单工具
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) return false
    return true
  })
}
```

### resolveAgentTools — 按代理定义过滤

- `tools: ['*']` 或 `undefined` → 获得全部（过滤后的）工具
- `tools: ['Read', 'Bash', ...]` → 只获得列出的工具
- `disallowedTools: ['Write']` → 从结果中移除指定工具
- 支持 `Agent(worker, researcher)` 语法限制可用代理类型

### 权限模式覆盖

```typescript
// 代理定义的 permissionMode 覆盖父级，除非父级更严格
if (agentPermissionMode &&
    parentMode !== 'bypassPermissions' &&
    parentMode !== 'acceptEdits' &&
    parentMode !== 'auto') {
  toolPermissionContext.mode = agentPermissionMode
}

// 异步代理自动跳过交互式权限提示
if (isAsync) {
  toolPermissionContext.shouldAvoidPermissionPrompts = true
}
```

### allowedTools 参数

当提供 `allowedTools` 时：
- 替换所有 session 级别的 allow rules
- 保留 CLI 参数级别的权限（SDK 的 `--allowedTools`）
- 防止父代理权限泄漏给子代理

---

## 八、子代理执行引擎

### runAgent() 核心流程

`runAgent()` 是一个 `AsyncGenerator<Message, void>`，主要步骤：

#### 1. 模型解析

```typescript
const resolvedAgentModel = getAgentModel(
  agentDefinition.model,      // 代理定义的模型
  toolUseContext.options.mainLoopModel,  // 父级主模型
  model,                       // 参数指定的模型
  permissionMode,
)
```

优先级：参数 > 代理定义 > 父级默认

#### 2. 上下文裁剪优化

```typescript
// Explore/Plan 代理跳过 CLAUDE.md（节省 ~5-15 Gtok/week）
const shouldOmitClaudeMd = agentDefinition.omitClaudeMd && !override?.userContext

// Explore/Plan 代理跳过 gitStatus（节省 ~1-3 Gtok/week）
const resolvedSystemContext =
  agentType === 'Explore' || agentType === 'Plan'
    ? systemContextNoGit : baseSystemContext
```

#### 3. 消息上下文构建

```typescript
// Fork 继承上下文 → 过滤不完整的工具调用
const contextMessages = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)
  : []

// 合并：上下文消息 + Prompt 消息 + Hook 附加上下文 + Skill 内容
const initialMessages = [...contextMessages, ...promptMessages]
```

#### 4. Skill 预加载

从代理 frontmatter 声明的 `skills` 字段：
- 解析 Skill 名称（支持精确匹配、插件前缀、后缀匹配）
- 并发加载所有 Skill 内容
- 作为 `isMeta` 用户消息注入初始消息

#### 5. MCP 服务器初始化

```typescript
const { clients, tools, cleanup } = await initializeAgentMcpServers(
  agentDefinition,
  toolUseContext.options.mcpClients,  // 继承父级 MCP 客户端
)
```

- 支持按名称引用已有 MCP 服务器
- 支持内联定义新 MCP 服务器
- 新建的客户端在代理结束时清理
- 引用的共享客户端不清理

#### 6. query() 消息循环

```typescript
for await (const message of query({
  messages: initialMessages,
  systemPrompt: agentSystemPrompt,
  userContext, systemContext,
  canUseTool, toolUseContext,
  querySource, maxTurns,
})) {
  // 转发 API metrics
  // 记录 sidechain transcript
  // yield 可记录的消息
}
```

#### 7. 资源清理 (finally)

```typescript
finally {
  await mcpCleanup()                    // MCP 服务器清理
  clearSessionHooks(agentId)            // 会话钩子清理
  cleanupAgentTracking(agentId)         // Prompt cache 追踪清理
  agentToolUseContext.readFileState.clear() // 文件状态缓存释放
  initialMessages.length = 0            // Fork 上下文内存释放
  unregisterPerfettoAgent(agentId)      // Perfetto 追踪释放
  clearAgentTranscriptSubdir(agentId)   // Transcript 子目录映射释放
  rootSetAppState(/* 清理 todos */)     // 孤立 todos 清理
  killShellTasksForAgent(agentId)       // 后台 Shell 任务清理
  killMonitorMcpTasksForAgent(agentId)  // Monitor MCP 任务清理
}
```

---

## 九、持久记忆系统

### 三种记忆作用域

| 作用域 | 存储位置 | 用途 | VCS |
|--------|----------|------|-----|
| `user` | `~/.claude/agent-memory/<agentType>/` | 跨项目通用记忆 | 否 |
| `project` | `.claude/agent-memory/<agentType>/` | 项目级共享记忆 | 是 |
| `local` | `.claude/agent-memory-local/<agentType>/` | 本机本项目记忆 | 否 |

### 记忆加载

当代理定义 `memory` 字段时，`getSystemPrompt()` 自动追加记忆内容：

```typescript
getSystemPrompt: () => {
  if (isAutoMemoryEnabled() && memory) {
    return systemPrompt + '\n\n' + loadAgentMemoryPrompt(agentType, memory)
  }
  return systemPrompt
}
```

如果代理的工具白名单不含文件读写工具，会自动注入 `FileWrite`、`FileEdit`、`FileRead` 以便代理能更新自己的记忆文件。

### 记忆快照同步

项目可在 `.claude/agent-memory-snapshots/<agentType>/` 中存放记忆快照：

```
检查快照 → checkAgentMemorySnapshot()
   │
   ├── 无快照 → 跳过
   ├── 无本地记忆 → initializeFromSnapshot() 复制快照
   └── 有更新快照 → 标记 pendingSnapshotUpdate（提示用户更新）
```

---

## 十、代理恢复机制

`resumeAgentBackground()` 实现了从磁盘 transcript 恢复中断代理的完整流程：

### 恢复步骤

1. **读取 Transcript**：`getAgentTranscript(agentId)` 从磁盘加载消息历史
2. **读取 Metadata**：`readAgentMetadata(agentId)` 获取代理类型、worktree 路径等
3. **消息清洗**：
   - `filterUnresolvedToolUses()` — 移除未完成的工具调用
   - `filterOrphanedThinkingOnlyMessages()` — 移除孤立的思考消息
   - `filterWhitespaceOnlyAssistantMessages()` — 移除空白助手消息
4. **重建替换状态**：`reconstructForSubagentResume()` 恢复 content replacement state
5. **Worktree 恢复**：检查 worktree 目录是否仍存在，更新 mtime 防止被清理
6. **代理类型识别**：
   - Fork 代理 → 使用 `FORK_AGENT` 定义，重建父系统提示
   - 其他代理 → 从活跃代理列表查找，找不到则回退到 `general-purpose`
7. **注册并运行**：`registerAsyncAgent()` + `runAsyncAgentLifecycle()`

---

## 十一、安全分类与审查

### Handoff 安全分类

在 `auto` 权限模式下，子代理完成后经过安全分类器审查：

```typescript
async function classifyHandoffIfNeeded({ agentMessages, tools, ... }) {
  if (toolPermissionContext.mode !== 'auto') return null

  const classifierResult = await classifyYoloAction(
    agentMessages,
    { content: "Review the sub-agent's work..." },
    tools, toolPermissionContext, abortSignal,
  )

  if (classifierResult.shouldBlock) {
    if (classifierResult.unavailable) {
      return '安全分类器不可用，请人工验证'
    }
    return `SECURITY WARNING: ${classifierResult.reason}`
  }
  return null
}
```

### 安全策略

- 分类器审查子代理的所有操作是否违反安全规则
- 被标记时在结果前附加安全警告
- 分类器不可用时附加提示让父代理自行验证
- 记录分类决策到 analytics（decision: allowed/blocked/unavailable）

---

## 十二、UI 渲染层

### 进度展示

`UI.tsx` 负责在终端中渲染子代理的实时状态：

- **Tool Use 消息**：显示正在启动的代理类型、描述、模型
- **进度消息**：显示子代理的工具调用进度（搜索/读取操作自动折叠为摘要）
- **结果消息**：显示最终结果、token 使用量、耗时
- **错误/拒绝消息**：显示错误详情或权限拒绝原因

### 颜色管理

每个代理类型分配独特颜色，便于在 UI 中区分：

```typescript
const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']
```

- `general-purpose` 代理不分配颜色（使用默认）
- 颜色通过全局 Map 管理，避免重复分配

### 搜索/读取操作折叠

连续的搜索和文件读取操作会被折叠为摘要行：

```
🔍 Searched 3 files, read 2 files
```

---

## 十三、设计亮点

### 1. Prompt Cache 优化

Fork 机制精心设计**字节相同的 API 请求前缀**：
- 所有 Fork 子代理共享相同的系统提示、上下文消息、工具定义
- 工具结果使用统一占位符，仅最后的指令文本不同
- 据代码注释，可节省 **~5-15 Gtok/周**
- Agent 列表从 tool description 移至 attachment message，避免 MCP 变化导致 cache bust

### 2. 多层权限隔离

- 每个子代理有独立的权限模式
- 异步代理自动跳过交互式权限提示
- `allowedTools` 参数防止父代理权限泄漏
- `bubble` 模式将权限提示冒泡到父终端
- SDK 级别权限（`--allowedTools`）始终保留

### 3. 优雅的资源管理

`finally` 块中对 **10+ 种资源**进行全面清理：
- MCP 服务器连接
- 会话钩子
- Prompt cache 追踪
- 文件状态缓存
- Perfetto 追踪条目
- Transcript 子目录映射
- 孤立 todos
- 后台 Shell 任务
- Monitor MCP 任务
- Dump 状态
- Invoked Skills

### 4. 灵活的代理来源

支持 5 种来源定义代理，有清晰的优先级覆盖：
- **Built-in**：代码中硬编码
- **Plugin**：通过插件系统加载
- **Markdown**：带 frontmatter 的 `.md` 文件
- **JSON**：配置文件中定义
- **CLI Flag**：命令行参数传入

### 5. 生产级可观测性

- **Perfetto 追踪**：注册代理层级关系，可视化调用链
- **Analytics 事件**：记录启动、完成、终止、错误等关键事件
- **Sidechain Transcript**：每条消息写入磁盘，支持恢复
- **Progress Tracker**：实时追踪 token 使用、工具调用次数
- **SDK Event Queue**：向 SDK 消费者推送进度事件

### 6. 防护与容错

- **递归 Fork 防护**：双重检测防止 Fork 中再 Fork
- **不完整工具调用过滤**：`filterIncompleteToolCalls()` 防止 API 错误
- **Worktree 恢复验证**：检查目录是否存在，不存在则回退
- **MCP 连接失败容错**：连接失败记录警告但不中断
- **代理加载失败容错**：解析错误时仍返回内建代理

---

## 附录：输入/输出 Schema

### 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string` | ✅ | 子代理的任务描述 |
| `description` | `string` | ✅ | 3-5 词的任务摘要 |
| `subagent_type` | `string` | 否 | 代理类型（省略则 Fork 或 general-purpose）|
| `model` | `'sonnet' \| 'opus' \| 'haiku'` | 否 | 模型覆盖 |
| `run_in_background` | `boolean` | 否 | 是否后台运行 |
| `name` | `string` | 否 | 团队模式下的成员名称 |
| `team_name` | `string` | 否 | 团队名称 |
| `mode` | `PermissionMode` | 否 | 权限模式 |
| `isolation` | `'worktree' \| 'remote'` | 否 | 隔离模式 |
| `cwd` | `string` | 否 | 工作目录覆盖 |

### 输出结构

**同步完成**：
```typescript
{
  status: 'completed',
  agentId: string,
  agentType: string,
  content: [{ type: 'text', text: string }],
  totalToolUseCount: number,
  totalDurationMs: number,
  totalTokens: number,
  usage: { input_tokens, output_tokens, cache_*, ... },
  prompt: string,
}
```

**异步启动**：
```typescript
{
  status: 'async_launched',
  agentId: string,
  description: string,
  prompt: string,
  outputFile: string,
  canReadOutputFile?: boolean,
}
```

---

*文档生成时间：2026-04-01*
