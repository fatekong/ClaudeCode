# Agent 和 Tool 相关 GrowthBook Flags 文档

**版本**: 1.0  
**基于源码分析**: ClaudeCode 项目  
**分析日期**: 2026-04-03  

---

## 目录

1. [概述](#概述)
2. [Agent 相关 Flags](#agent-相关-flags)
   - [2.1 tengu_agent_list_attach](#21-tengu_agent_list_attach)
   - [2.2 tengu_auto_background_agents](#22-tengu_auto_background_agents)
   - [2.3 tengu_amber_stoat](#23-tengu_amber_stoat)
   - [2.4 tengu_slim_subagent_claudemd](#24-tengu_slim_subagent_claudemd)
   - [2.5 tengu_hive_evidence](#25-tengu_hive_evidence)
3. [Tool 相关 Flags](#tool-相关-flags)
   - [3.1 tengu_tool_pear](#31-tengu_tool_pear)
   - [3.2 tengu_surreal_dali](#32-tengu_surreal_dali)
   - [3.3 tengu_cobalt_lantern](#33-tengu_cobalt_lantern)
4. [Flag 分类汇总](#flag-分类汇总)
5. [Flag 间关联关系](#flag-间关联关系)
6. [启用/禁用影响分析](#启用禁用影响分析)
7. [已知限制/待验证](#已知限制待验证)

---

## 概述

本文档详细记录 Claude Code 中与 Agent 和 Tool 相关的 GrowthBook feature flags。这些 flags 控制着子代理行为、工具执行模式和各种实验性功能。

**核心文件:**
- `src/tools/AgentTool/AgentTool.tsx` - Agent Tool 主实现
- `src/tools/AgentTool/prompt.ts` - Agent 提示生成
- `src/tools/AgentTool/builtInAgents.ts` - 内置 Agent 配置
- `src/tools/AgentTool/runAgent.ts` - Agent 运行逻辑
- `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts` - 远程触发工具
- `src/Tool.ts` - Tool 基类定义
- `src/utils/api.ts` - API 工具序列化
- `src/utils/betas.ts` - Beta 功能管理

---

## Agent 相关 Flags

### 2.1 `tengu_agent_list_attach`

**Flag 名称**: `tengu_agent_list_attach`

**类型**: `boolean`

**默认值**: `false`

**功能描述**: 控制 Agent 列表是嵌入在工具描述中还是作为独立的 attachment 消息注入。

**检查位置**: `src/tools/AgentTool/prompt.ts:59-64`

```typescript
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **关闭** (默认) | Agent 列表嵌入在 `getPrompt()` 返回的工具描述中 |
| **开启** | Agent 列表作为 `agent_listing_delta` attachment 消息单独注入 |

**优化目的**:
- 动态 Agent 列表曾占 fleet 约 10.2% 的 `cache_creation` tokens
- MCP 异步连接、`/reload-plugins` 或权限模式变化都会导致列表变化
- 列表变化 → 工具描述变化 → 完整工具 schema cache bust
- 将列表移到 attachment 后，工具描述保持静态，cache 更稳定

**环境变量覆盖**: `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false`

---

### 2.2 `tengu_auto_background_agents`

**Flag 名称**: `tengu_auto_background_agents`

**类型**: `boolean`

**默认值**: `false`

**功能描述**: 控制是否自动将长时间运行的 Agent 任务转为后台执行。

**检查位置**: `src/tools/AgentTool/AgentTool.tsx:72-77`

```typescript
function getAutoBackgroundMs(): number {
  if (isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS) || 
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_auto_background_agents', false)) {
    return 120_000  // 2 分钟
  }
  return 0
}
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **关闭** (默认) | Agent 任务按用户指定的方式运行（前台或后台） |
| **开启** | 运行超过 120 秒的 Agent 任务自动转为后台 |

**环境变量覆盖**: `CLAUDE_AUTO_BACKGROUND_TASKS=1`

**使用场景**:
- 长时间研究任务自动后台化
- 避免阻塞用户交互

---

### 2.3 `tengu_amber_stoat`

**Flag 名称**: `tengu_amber_stoat`

**类型**: `boolean`

**默认值**: `true` (3P 默认)

**功能描述**: 控制 Explore 和 Plan 内置 Agent 是否可用。

**检查位置**: `src/tools/AgentTool/builtInAgents.ts:13-19`

```typescript
export function areExplorePlanAgentsEnabled(): boolean {
  if (feature('BUILTIN_EXPLORE_PLAN_AGENTS')) {
    // 3P default: true — Bedrock/Vertex keep agents enabled
    // A/B test treatment sets false to measure impact of removal
    return getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_stoat', true)
  }
  return false
}
```

**使用位置**: `src/tools/AgentTool/builtInAgents.ts:50-52`

```typescript
if (areExplorePlanAgentsEnabled()) {
  agents.push(EXPLORE_AGENT, PLAN_AGENT)
}
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **开启** (默认) | Explore 和 Plan Agent 在内置 Agent 列表中可用 |
| **关闭** | 这些 Agent 不可用，只剩 General Purpose 等基础 Agent |

**编译时依赖**: 需要 `feature('BUILTIN_EXPLORE_PLAN_AGENTS')` 为 true

---

### 2.4 `tengu_slim_subagent_claudemd`

**Flag 名称**: `tengu_slim_subagent_claudemd`

**类型**: `boolean`

**默认值**: `true`

**功能描述**: 控制只读子 Agent（如 Explore、Plan）是否省略 CLAUDE.md 上下文。

**检查位置**: `src/tools/AgentTool/runAgent.ts`

```typescript
// Kill-switch defaults true; flip tengu_slim_subagent_claudemd=false to revert.
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd &&
  !override?.userContext &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
```

**Agent 定义中的标记**: `src/tools/AgentTool/loadAgentsDir.ts:145-150`

```typescript
/** Omit CLAUDE.md hierarchy from the agent's userContext. Read-only agents
 * (Explore, Plan) don't need commit/PR/lint guidelines — the main agent has
 * full CLAUDE.md and interprets their output. Saves ~5-15 Gtok/week across
 * 34M+ Explore spawns. Kill-switch: tengu_slim_subagent_claudemd. */
omitClaudeMd?: boolean
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **开启** (默认) | 标记为 `omitClaudeMd: true` 的子 Agent 不加载 CLAUDE.md |
| **关闭** | 所有子 Agent 都加载完整 CLAUDE.md 层级 |

**优化效果**: 每周节省约 5-15 Gtok（across 34M+ Explore spawns）

---

### 2.5 `tengu_hive_evidence`

**Flag 名称**: `tengu_hive_evidence`

**类型**: `boolean`

**默认值**: `false`

**功能描述**: 控制 Verification Agent 和 "证据" 功能的可用性。

**检查位置 1**: `src/tools/AgentTool/builtInAgents.ts:64-68`

```typescript
if (
  feature('VERIFICATION_AGENT') &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)
) {
  agents.push(VERIFICATION_AGENT)
}
```

**检查位置 2**: `src/tools/TaskUpdateTool/TaskUpdateTool.ts`

```typescript
getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
// ... 启用证据相关功能
```

**检查位置 3**: `src/tools/TodoWriteTool/TodoWriteTool.ts`

```typescript
getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
// ... 启用证据相关功能
```

**检查位置 4**: `src/constants/prompts.ts`

```typescript
getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)
// 控制系统提示中的证据相关内容
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **关闭** (默认) | Verification Agent 不可用，证据功能禁用 |
| **开启** | Verification Agent 加入内置列表，TaskUpdate/TodoWrite 启用证据跟踪 |

**编译时依赖**: 需要 `feature('VERIFICATION_AGENT')` 为 true

---

## Tool 相关 Flags

### 3.1 `tengu_tool_pear`

**Flag 名称**: `tengu_tool_pear`

**类型**: `boolean`（通过 Statsig gate 检查）

**默认值**: `false`

**功能描述**: 启用工具的 "strict" 模式，使 API 更严格地遵循工具指令和参数 schema。

**检查位置 1**: `src/utils/api.ts:154-155`

```typescript
const strictToolsEnabled =
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_tool_pear')
```

**检查位置 2**: `src/utils/betas.ts:319-320`

```typescript
const strictToolsEnabled =
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_tool_pear')
// 3P default: false. API rejects strict + token-efficient-tools together
```

**Tool 定义**: `src/Tool.ts:467-472`

```typescript
/**
 * When true, enables strict mode for this tool, which causes the API to
 * more strictly adhere to tool instructions and parameter schemas.
 * Only applied when the tengu_tool_pear is enabled.
 */
readonly strict?: boolean
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **关闭** (默认) | 工具使用标准模式，可启用 token-efficient-tools |
| **开启** | 工具的 `strict: true` 属性生效，API 返回更严格的结构化输出 |

**互斥关系**: 与 `tengu_amber_json_tools`（token-efficient-tools）互斥，API 拒绝同时使用。

**缓存机制**: 使用 `toolSchemaCache.ts` 缓存，避免 mid-session GB flips 导致的 cache bust。

---

### 3.2 `tengu_surreal_dali`

**Flag 名称**: `tengu_surreal_dali`

**类型**: `boolean`

**默认值**: `false`

**功能描述**: 启用 RemoteTriggerTool，允许管理远程 Agent 触发器（定时任务）。

**检查位置**: `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:57-62`

```typescript
isEnabled() {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_surreal_dali', false) &&
    isPolicyAllowed('allow_remote_sessions')
  )
},
```

**工具定义**: `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:18-31`

```typescript
const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['list', 'get', 'create', 'update', 'run']),
    trigger_id: z.string().regex(/^[\w-]+$/).optional()
      .describe('Required for get, update, and run'),
    body: z.record(z.string(), z.unknown()).optional()
      .describe('JSON body for create and update'),
  }),
)
```

**支持的操作**:

| Action | 描述 |
|--------|------|
| `list` | 列出所有触发器 |
| `get` | 获取特定触发器详情 |
| `create` | 创建新触发器 |
| `update` | 更新现有触发器 |
| `run` | 立即运行触发器 |

**API 端点**: `${baseUrl}/v1/code/triggers`

**Beta Header**: `ccr-triggers-2026-01-30`

**实际效果**:

| 状态 | 行为 |
|------|------|
| **关闭** (默认) | RemoteTriggerTool 不可用 |
| **开启** | RemoteTriggerTool 可用（还需 `allow_remote_sessions` policy） |

**关联**: 在 `src/skills/bundled/scheduleRemoteAgents.ts` 中与 `tengu_cobalt_lantern` 配合使用。

---

### 3.3 `tengu_cobalt_lantern`

**Flag 名称**: `tengu_cobalt_lantern`

**类型**: `boolean`

**默认值**: `false`

**功能描述**: 启用 GitHub 网页 setup 流程，允许通过 `/web-setup` 命令连接 GitHub 账户。

**检查位置 1**: `src/commands/remote-setup/index.ts`

```typescript
getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) &&
// 控制 /web-setup 命令可用性
```

**检查位置 2**: `src/utils/background/remote/preconditions.ts`

```typescript
getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) &&
// 控制远程 Agent 的 GitHub 访问提示
```

**检查位置 3**: `src/skills/bundled/scheduleRemoteAgents.ts`

```typescript
${needsGitHubAccessReminder ? `- If the user's request seems to require GitHub repo access, remind them that ${
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) 
    ? "they should run /web-setup to connect their GitHub account..." 
    : "they need the Claude GitHub App installed on the repo..."
}.` : ''}
```

**实际效果**:

| 状态 | 行为 |
|------|------|
| **关闭** (默认) | 需要安装 Claude GitHub App 来访问 GitHub |
| **开启** | 可使用 `/web-setup` 命令直接连接 GitHub 账户 |

**关联**: 与 `tengu_surreal_dali` 配合，影响远程 Agent 的 GitHub 访问方式提示。

---

## Flag 分类汇总

### Agent 配置类

| Flag 名称 | 功能 | 默认值 |
|-----------|------|--------|
| `tengu_amber_stoat` | Explore/Plan Agent 可用性 | `true` |
| `tengu_slim_subagent_claudemd` | 省略子 Agent CLAUDE.md | `true` |
| `tengu_hive_evidence` | Verification Agent | `false` |

### 性能优化类

| Flag 名称 | 功能 | 默认值 |
|-----------|------|--------|
| `tengu_agent_list_attach` | 优化 prompt cache | `false` |
| `tengu_auto_background_agents` | 自动后台化长任务 | `false` |
| `tengu_slim_subagent_claudemd` | 减少 context 使用 | `true` |

### 工具模式类

| Flag 名称 | 功能 | 默认值 |
|-----------|------|--------|
| `tengu_tool_pear` | 严格工具模式 | `false` |

### 实验性功能类

| Flag 名称 | 功能 | 默认值 |
|-----------|------|--------|
| `tengu_surreal_dali` | RemoteTriggerTool | `false` |
| `tengu_cobalt_lantern` | GitHub 网页 setup | `false` |

---

## Flag 间关联关系

### 互斥关系

- `tengu_tool_pear` 和 `tengu_amber_json_tools`（token-efficient-tools）互斥
  - API 拒绝同时使用 strict 和 token-efficient-tools
  - 当 `tengu_tool_pear` 启用时，`tengu_amber_json_tools` 被忽略

### 配合使用关系

- `tengu_hive_evidence` + `VERIFICATION_AGENT` 编译 flag
  - 两者都启用才会添加 Verification Agent

- `tengu_surreal_dali` + `tengu_cobalt_lantern`
  - 远程 Agent 调度场景下配合使用
  - `tengu_cobalt_lantern` 影响 GitHub 访问提示方式

- `tengu_amber_stoat` + `BUILTIN_EXPLORE_PLAN_AGENTS` 编译 flag
  - 两者都启用才会添加 Explore/Plan Agent

### 依赖图

```
编译时 Feature Flags
       │
       ├── BUILTIN_EXPLORE_PLAN_AGENTS
       │         │
       │         └──→ tengu_amber_stoat
       │
       ├── VERIFICATION_AGENT
       │         │
       │         └──→ tengu_hive_evidence
       │
运行时 GrowthBook Flags
       │
       ├── tengu_agent_list_attach (独立)
       │
       ├── tengu_auto_background_agents (独立)
       │
       ├── tengu_slim_subagent_claudemd (独立)
       │
       ├── tengu_tool_pear ←──互斥──→ tengu_amber_json_tools
       │
       └── tengu_surreal_dali ←──关联──→ tengu_cobalt_lantern
```

---

## 启用/禁用影响分析

### `tengu_agent_list_attach`

| 状态 | 影响 |
|------|------|
| 启用 | Agent 列表通过 attachment 注入，工具描述保持静态，prompt cache 更稳定 |
| 禁用 | Agent 列表嵌入工具描述，每次 MCP/plugin 变化都可能 bust cache |

### `tengu_auto_background_agents`

| 状态 | 影响 |
|------|------|
| 启用 | 超过 2 分钟的 Agent 任务自动转后台，避免阻塞 |
| 禁用 | 用户需手动指定 `run_in_background: true` |

### `tengu_amber_stoat`

| 状态 | 影响 |
|------|------|
| 启用 | Explore 和 Plan Agent 可用，支持代码探索和规划功能 |
| 禁用 | 这些内置 Agent 不可用，用户需使用其他方式探索代码 |

### `tengu_slim_subagent_claudemd`

| 状态 | 影响 |
|------|------|
| 启用 | 只读子 Agent 不加载 CLAUDE.md，节省约 5-15 Gtok/week |
| 禁用 | 所有子 Agent 都加载完整 CLAUDE.md，增加 context 使用 |

### `tengu_hive_evidence`

| 状态 | 影响 |
|------|------|
| 启用 | 非平凡实现后需要 Verification Agent 确认，增加代码质量保证 |
| 禁用 | 没有强制验证流程，依赖用户自行检查 |

### `tengu_tool_pear`

| 状态 | 影响 |
|------|------|
| 启用 | 工具可使用 strict 模式，API 返回更严格的结构化输出 |
| 禁用 | 工具使用标准模式，可启用 token-efficient-tools |

### `tengu_surreal_dali`

| 状态 | 影响 |
|------|------|
| 启用 | RemoteTriggerTool 可用，支持创建/管理/运行远程 Agent 触发器 |
| 禁用 | 无法使用定时触发远程 Agent 的功能 |

### `tengu_cobalt_lantern`

| 状态 | 影响 |
|------|------|
| 启用 | 可使用 `/web-setup` 连接 GitHub，远程 Agent 提示更新 |
| 禁用 | 需要安装 Claude GitHub App，提示使用旧方式 |

---

## 已知限制/待验证

### 待验证的行为

1. **`tengu_agent_list_attach` 的 attachment 格式**: 具体的 `agent_listing_delta` attachment 结构需要追踪 `attachments.ts`

2. **`tengu_auto_background_agents` 的转换时机**: 2 分钟后的具体转换逻辑和用户通知机制

3. **`tengu_tool_pear` 的 strict 模式细节**: 具体的 API 行为差异和错误处理

4. **`tengu_hive_evidence` 的证据格式**: TaskUpdate 和 TodoWrite 中记录的证据具体格式

### 相关但未深入分析的 Flags

- `tengu_amber_json_tools` - Token-efficient tools 功能，与 `tengu_tool_pear` 互斥

- `tengu_streaming_tool_execution2` - 流式工具执行

- `tengu_fgts` - Fine-grained tool streaming

---

## 代码引用索引

| 功能 | 文件:行号 |
|------|-----------|
| shouldInjectAgentListInMessages() | `prompt.ts:59-64` |
| getAutoBackgroundMs() | `AgentTool.tsx:72-77` |
| areExplorePlanAgentsEnabled() | `builtInAgents.ts:13-19` |
| tengu_slim_subagent_claudemd 检查 | `runAgent.ts:389-393` |
| omitClaudeMd 定义 | `loadAgentsDir.ts:145-150` |
| VERIFICATION_AGENT 条件 | `builtInAgents.ts:64-68` |
| tengu_tool_pear 检查 (api) | `api.ts:154-155` |
| tengu_tool_pear 检查 (betas) | `betas.ts:319-320` |
| Tool.strict 定义 | `Tool.ts:467-472` |
| RemoteTriggerTool.isEnabled() | `RemoteTriggerTool.ts:57-62` |
| tengu_cobalt_lantern (remote-setup) | `remote-setup/index.ts` |
| tengu_cobalt_lantern (提示) | `scheduleRemoteAgents.ts` |

---

*文档结束*
