# Claude Code Memory 机制上线状态分析

> 本文档基于源码分析，详细记录 Claude Code 中所有记忆（Memory）子系统的 **上线状态**、**门控条件** 和 **实现机制**。
>
> 生成时间：2026-04-07

---

## 目录

1. [总体架构与门控体系](#1-总体架构与门控体系)
2. [各子系统上线状态总览](#2-各子系统上线状态总览)
3. [已上线 — Auto Memory 基座层](#3-已上线--auto-memory-基座层)
4. [已上线 — CLAUDE.md 多层级记忆文件加载](#4-已上线--claudemd-多层级记忆文件加载)
5. [已上线 — 智能记忆召回（findRelevantMemories）](#5-已上线--智能记忆召回findrelevantmemories)
6. [已上线 — 记忆新鲜度检测](#6-已上线--记忆新鲜度检测)
7. [已上线 — Agent Memory（代理记忆）](#7-已上线--agent-memory代理记忆)
8. [已上线 — /memory 命令](#8-已上线--memory-命令)
9. [未上线（灰度中）— Extract Memories（后台记忆提取）](#9-未上线灰度中-extract-memories后台记忆提取)
10. [未上线（灰度中）— Session Memory（会话记忆）](#10-未上线灰度中-session-memory会话记忆)
11. [未上线（灰度中）— Auto Dream（自动记忆整合）](#11-未上线灰度中-auto-dream自动记忆整合)
12. [未上线（灰度中）— Team Memory（团队记忆）](#12-未上线灰度中-team-memory团队记忆)
13. [未上线（ANT Only）— /remember Skill](#13-未上线ant-only-remember-skill)
14. [GrowthBook Feature Flags 汇总](#14-growthbook-feature-flags-汇总)
15. [编译时开关汇总](#15-编译时开关汇总)
16. [环境变量汇总](#16-环境变量汇总)
17. [依赖关系图](#17-依赖关系图)

---

## 1. 总体架构与门控体系

Claude Code 的 Memory 机制采用 **三层门控架构**：

| 层级 | 机制 | 作用 | 说明 |
|------|------|------|------|
| **编译时** | `feature('FLAG')` | 代码是否包含在构建产物中 | Bun 打包时 DCE（Dead Code Elimination） |
| **运行时 GrowthBook** | `getFeatureValue_CACHED_MAY_BE_STALE()` | 功能是否实际生效 | 远程动态下发，支持灰度/A/B 测试 |
| **本地配置** | 环境变量 / settings.json | 用户侧控制 | 用户可主动启用/禁用 |

**关键判断原则**：
- 编译开关 `false` → 代码完全不存在，功能不可能启用
- GrowthBook gate `默认 false` → 即使代码存在，也需要服务端远程开启
- `isAutoMemoryEnabled()` 是唯一默认 `true` 的基座函数

---

## 2. 各子系统上线状态总览

| 子系统 | 上线状态 | 外部用户可用 | 关键门控 | 默认值 |
|--------|---------|-------------|---------|--------|
| **Auto Memory 基座层** | ✅ **已上线** | ✅ 是 | `isAutoMemoryEnabled()` | **默认启用** |
| **CLAUDE.md 文件加载** | ✅ **已上线** | ✅ 是 | 无额外门控 | 始终加载 |
| **智能记忆召回** | ✅ **已上线** | ✅ 是 | `tengu_moth_copse` (预取优化) | 基础召回始终可用 |
| **记忆新鲜度检测** | ✅ **已上线** | ✅ 是 | 无额外门控 | 始终生效 |
| **Agent Memory** | ✅ **已上线** | ✅ 是 | `isAutoMemoryEnabled()` | 随基座层 |
| **/memory 命令** | ✅ **已上线** | ✅ 是 | 无额外门控 | 始终可用 |
| **Extract Memories** | ❌ **未上线** | ❌ 否 | `feature('EXTRACT_MEMORIES')` + `tengu_passport_quail` (默认 false) | 灰度中 |
| **Session Memory** | ❌ **未上线** | ❌ 否 | `tengu_session_memory` (默认 false) | 灰度中 |
| **Auto Dream** | ❌ **未上线** | ❌ 否 | `tengu_onyx_plover.enabled` (默认 null) | 灰度中 |
| **Team Memory** | ❌ **未上线** | ❌ 否 | `feature('TEAMMEM')` + `tengu_herring_clock` (默认 false) | 灰度中 |
| **/remember Skill** | ❌ **未上线** | ❌ 否 | `USER_TYPE === 'ant'` 硬编码限制 | ANT 专用 |

---

## 3. 已上线 — Auto Memory 基座层

### 上线状态：✅ 已上线（默认启用）

Auto Memory 是整个记忆系统的基座，**默认对所有用户启用**，不依赖任何 GrowthBook gate。

### 实现机制

**控制函数**：`isAutoMemoryEnabled()`
**代码位置**：`src/memdir/paths.ts:30-55`

```typescript
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) return false      // 优先级 1: 环境变量强制关
  if (isEnvDefinedFalsy(envVal)) return true  // 优先级 2: 环境变量强制开
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return false  // 优先级 3: --bare 模式
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) && 
      !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) return false   // 优先级 4: 远程无持久化
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) return settings.autoMemoryEnabled  // 优先级 5: 用户设置
  return true  // 优先级 6: 默认启用
}
```

**启用条件链**（优先级从高到低）：

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/true` | **关闭** |
| 2 | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0/false` | **开启** |
| 3 | `CLAUDE_CODE_SIMPLE=1` (--bare 模式) | **关闭** |
| 4 | `CLAUDE_CODE_REMOTE=1` 且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` | **关闭** |
| 5 | settings.json 中 `autoMemoryEnabled` 字段 | 按设置值 |
| 6 | 默认 | **开启** |

### 提供的能力

当基座层启用时：
- 记忆目录 `~/.claude/projects/<path>/memory/` 可用
- MEMORY.md 索引文件被加载到系统提示词
- Agent 可以读写记忆文件
- 记忆提示词（存储/读取/类型分类指引）注入系统提示
- `/memory` 命令可用
- `/remember` skill 可用（还需 ANT 限制）

### 存储路径解析

**路径解析优先级**：

```
1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (环境变量完整路径覆盖)
     ↓
2. settings.json → autoMemoryDirectory (受限来源: policy/flag/local/user, 不含 project)
     ↓
3. <memoryBase>/projects/<sanitized-git-root>/memory/
   其中 memoryBase = CLAUDE_CODE_REMOTE_MEMORY_DIR 或 ~/.claude
```

**安全校验** (`validateMemoryPath()`)：
- 拒绝相对路径
- 拒绝根目录/近根路径 (长度 < 3)
- 拒绝 Windows 驱动器根 (C:)
- 拒绝 UNC 路径 (\\\\server\\share)
- 拒绝 null byte
- Settings 中 `projectSettings` 被排除，防止恶意仓库通过 `.claude/settings.json` 设置 `autoMemoryDirectory: "~/.ssh"` 获得写权限

### 核心文件

| 文件 | 说明 |
|------|------|
| `src/memdir/paths.ts` | 路径解析、安全校验、启用状态判断 |
| `src/memdir/memdir.ts` | Memory 提示词构建、MEMORY.md 加载 |
| `src/memdir/memoryTypes.ts` | 记忆内容类型分类法（user/feedback/project/reference） |
| `src/memdir/memoryScan.ts` | 扫描 memory 目录下 .md 文件 |

---

## 4. 已上线 — CLAUDE.md 多层级记忆文件加载

### 上线状态：✅ 已上线

### 实现机制

**代码位置**：`src/utils/claudemd.ts`

CLAUDE.md 系统按 **6 种文件层级类型** 加载，优先级从低到高：

| 层级 | 类型 | 路径示例 | 说明 | 上线状态 |
|------|------|----------|------|---------|
| 1 | **Managed** | 组织管理规则目录 | 管理员推送的规则 | ✅ |
| 2 | **User** | `~/.claude/CLAUDE.md` | 用户全局指令 | ✅ |
| 3 | **Project** | `./CLAUDE.md` / `./claude.md` | 项目级指令（提交到仓库） | ✅ |
| 4 | **Local** | `./.claude/CLAUDE.local.md` | 本地私有项目指令（gitignored） | ✅ |
| 5 | **AutoMem** | `~/.claude/projects/<path>/memory/MEMORY.md` | 自动记忆索引 | ✅ (需 `isAutoMemoryEnabled()`) |
| 6 | **TeamMem** | `~/.claude/projects/<path>/memory/team/MEMORY.md` | 团队共享记忆 | ❌ (需 `feature('TEAMMEM')` + `tengu_herring_clock`) |

**加载流程**：
1. 按层级依次发现和读取各层级的 CLAUDE.md 文件
2. 支持 `@include` 递归包含（最大深度 5 层）
3. `stripHtmlComments()` 去除 HTML 注释
4. `parseFrontmatterPaths()` 解析条件规则的 glob 匹配
5. 所有内容合并后注入系统提示词

**MEMORY.md 加载限制**：
- 最大行数：`MAX_ENTRYPOINT_LINES = 200`
- 最大字节：`MAX_ENTRYPOINT_BYTES = 25000`
- 超出限制时截断

---

## 5. 已上线 — 智能记忆召回（findRelevantMemories）

### 上线状态：✅ 已上线

### 实现机制

**代码位置**：`src/memdir/findRelevantMemories.ts`

使用 Sonnet 模型做 **侧查询（sideQuery）**，从 memory 目录中选择最多 5 个与当前查询最相关的记忆文件。

**工作流程**：
1. `memoryScan.ts` 扫描 memory 目录下所有 `.md` 文件（最多 200 个），解析 frontmatter，按 mtime 降序排列
2. 构建文件清单（标题 + 摘要）
3. 调用 Sonnet 模型，使用 `json_schema` structured output，返回最相关的文件列表
4. 过滤 `alreadySurfaced`（已展示文件）和 `recentTools`（避免重复选择工具文档）
5. 读取选中文件的完整内容返回

**预取优化**：通过 `tengu_moth_copse` gate 控制（默认 false），启用后在 attachments 阶段预取记忆。

---

## 6. 已上线 — 记忆新鲜度检测

### 上线状态：✅ 已上线

### 实现机制

**代码位置**：`src/memdir/memoryAge.ts`

计算记忆文件的年龄并生成人类可读的过时提示：
- 超过 **1 天** 的记忆附加过时警告
- 提示格式如："This memory was last updated X days ago and may be stale"

---

## 7. 已上线 — Agent Memory（代理记忆）

### 上线状态：✅ 已上线（需 `isAutoMemoryEnabled()`）

### 实现机制

**代码位置**：
- `src/tools/AgentTool/agentMemory.ts` — 核心逻辑
- `src/tools/AgentTool/agentMemorySnapshot.ts` — 快照机制

Agent 专属记忆支持三种 **scope**：

| Scope | 路径 | 说明 |
|-------|------|------|
| `user` | `~/.claude/agent-memory/<agent-name>/` | 用户级，跨项目 |
| `project` | `~/.claude/projects/<path>/memory/agents/<agent-name>/` | 项目级 |
| `local` | `~/.claude/projects/<path>/memory/agents/<agent-name>/local/` | 本地私有 |

**快照机制** (需 `feature('AGENT_MEMORY_SNAPSHOT')`)：
- `checkAgentMemorySnapshot()` → `initializeFromSnapshot()` / `replaceFromSnapshot()`
- 从项目快照初始化或更新 agent memory

**注入方式**：当 Agent 定义 `memory` 字段时，`getSystemPrompt()` 自动追加记忆内容：

```typescript
getSystemPrompt: () => {
  if (isAutoMemoryEnabled() && memory) {
    return systemPrompt + '\n\n' + loadAgentMemoryPrompt(agentType, memory)
  }
  return systemPrompt
}
```

---

## 8. 已上线 — /memory 命令

### 上线状态：✅ 已上线

### 实现机制

**代码位置**：`src/commands/memory/memory.tsx`

提供文件选择器 UI，供用户手动编辑 memory 文件。选项包括：
- 打开 auto memory 目录
- 打开团队 memory 目录（需 TEAMMEM 启用）
- 编辑现有 memory 文件

---

## 9. 未上线（灰度中）— Extract Memories（后台记忆提取）

### 上线状态：❌ 未上线

### 门控条件（全部须满足）

| 层级 | 机制 | 条件 | 默认值 | 说明 |
|------|------|------|--------|------|
| 编译时 | `feature('EXTRACT_MEMORIES')` | 构建时确定 | 外部构建可能关闭 | 代码是否包含 |
| 运行时 Gate | `tengu_passport_quail` | GrowthBook | **false** | 🔒 **核心阻塞点** |
| 运行时 | `isAutoMemoryEnabled()` | 环境变量/设置 | true | 基座层 |
| 运行时 | `!getIsRemoteMode()` | 远程模式检查 | - | 远程模式下不运行 |
| 节流控制 | `tengu_bramble_lintel` | GrowthBook | null → 1 | 每 N 轮执行一次 |
| 非交互扩展 | `tengu_slate_thimble` | GrowthBook | **false** | 非交互式会话也提取 |
| 索引跳过 | `tengu_moth_copse` | GrowthBook | **false** | 跳过 MEMORY.md 索引更新 |

**为什么未上线**：`tengu_passport_quail` 的默认值为 `false`，GrowthBook 服务端未对外部用户开启此 gate。

### 实现机制

**代码位置**：`src/services/extractMemories/extractMemories.ts`

**核心流程**：

```
每轮对话结束
    ↓
postSamplingHook 触发
    ↓
检查门控链（上表全部条件）
    ↓
hasMemoryWritesSince() 检查主 Agent 是否已写入记忆（互斥机制）
    ↓
扫描现有记忆文件 → 构建提取提示词
    ↓
runForkedAgent（最多 5 turn）
    ↓
复用父对话提示缓存，独立工具集
    ↓
写入 .md 文件 + 更新 MEMORY.md 索引
    ↓
appendSystemMessage 通知主线程
```

**关键特性**：
- **闭包状态管理**：`lastMemoryMessageUuid`、`inProgress`、`turnsSinceLastExtraction` 等状态通过闭包隔离
- **互斥机制**：`hasMemoryWritesSince()` 防止主 Agent 和后台 Agent 同时写入
- **工具权限限制**：`createAutoMemCanUseTool()` 只允许只读操作 + memory 目录写入
- **Trailing extraction**：支持 stash + 后续执行，处理已完成但未提取的对话
- **Team Memory 分支**：当 `feature('TEAMMEM')` 启用时，使用 `buildExtractCombinedPrompt()` 而非 `buildExtractAutoOnlyPrompt()`

### 核心文件

| 文件 | 说明 |
|------|------|
| `src/services/extractMemories/extractMemories.ts` | 核心逻辑（~590 行） |
| `src/services/extractMemories/prompts.ts` | 提取代理提示词模板 |

---

## 10. 未上线（灰度中）— Session Memory（会话记忆）

### 上线状态：❌ 未上线

### 门控条件

| 层级 | 机制 | 条件 | 默认值 | 说明 |
|------|------|------|--------|------|
| 运行时 Gate | `tengu_session_memory` | GrowthBook | **false** | 🔒 **核心阻塞点** |
| 前置依赖 | `isAutoCompactEnabled()` | 自动压缩 | - | Session Memory 依赖自动压缩 |
| 运行时 | `!getIsRemoteMode()` | 远程模式 | - | 远程模式不运行 |
| 配置 | `tengu_sm_config` | GrowthBook 动态配置 | {} | 参数微调 |

**为什么未上线**：`tengu_session_memory` 默认值为 `false`，GrowthBook 服务端未对外部用户开启。

### 实现机制

**代码位置**：`src/services/SessionMemory/sessionMemory.ts`

**核心功能**：自动维护当前会话的笔记文件，用于 compact/压缩时保留关键上下文。

**触发条件**（`shouldExtractMemory()`）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `minimumMessageTokensToInit` | 10000 | 初次提取的最小 token 阈值 |
| `minimumTokensBetweenUpdate` | 5000 | 两次提取间的最小 token 增长 |
| `toolCallsBetweenUpdates` | 3 | 两次提取间的最小工具调用次数 |

**工作流程**：

```
对话进行中
    ↓
postSamplingHook 触发 extractSessionMemory()
    ↓
isSessionMemoryGateEnabled() 检查 tengu_session_memory gate
    ↓
shouldExtractMemory() 基于 token/工具调用阈值判断
    ↓
runForkedAgent 执行提取
    ↓
createMemoryFileCanUseTool() 限制只能 Edit 特定会话记忆文件
    ↓
写入/更新 session memory 文件
```

**Session Memory 模板**（`DEFAULT_SESSION_MEMORY_TEMPLATE`）：

```markdown
# Session Memory
## Session Title
## Current State  
## Task specification
## Key Technical Context
## Important Decisions & Rationale
```

限制：`MAX_SECTION_LENGTH = 2000`，`MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000`

支持自定义模板：`~/.claude/session-memory/config/template.md`

### 核心文件

| 文件 | 说明 |
|------|------|
| `src/services/SessionMemory/sessionMemory.ts` | 核心逻辑 |
| `src/services/SessionMemory/sessionMemoryUtils.ts` | 配置管理和状态跟踪 |
| `src/services/SessionMemory/prompts.ts` | 模板和更新提示词 |

---

## 11. 未上线（灰度中）— Auto Dream（自动记忆整合）

### 上线状态：❌ 未上线

### 门控条件

| 层级 | 机制 | 条件 | 默认值 | 说明 |
|------|------|------|--------|------|
| 运行时 | `!getKairosActive()` | KAIROS 互斥 | - | KAIROS 模式使用自己的 /dream |
| 运行时 | `!getIsRemoteMode()` | 远程模式 | - | 远程模式不运行 |
| 运行时 | `isAutoMemoryEnabled()` | 基座层 | true | |
| 运行时 Gate | `tengu_onyx_plover.enabled` | GrowthBook | **null** | 🔒 **核心阻塞点** |
| 用户设置 | `settings.autoDreamEnabled` | 设置 | undefined | 优先于 GrowthBook |

**为什么未上线**：`tengu_onyx_plover` 默认返回 `null`，`gb?.enabled === true` 判断结果为 `false`。即使用户手动设置 `autoDreamEnabled: true`，如果 KAIROS 未启用，Dream 功能在实际体验上也有限。

### 实现机制

**代码位置**：
- `src/services/autoDream/config.ts` — 启用判断
- `src/services/autoDream/autoDream.ts` — 核心逻辑
- `src/services/autoDream/consolidationPrompt.ts` — 四阶段提示词
- `src/services/autoDream/consolidationLock.ts` — 防并发锁

**触发条件**（全部满足）：
1. 距上次整合 ≥ `minHours`（默认 24 小时，通过 `tengu_onyx_plover` 配置）
2. 新会话数 ≥ `minSessions`（默认 5 个，通过 `tengu_onyx_plover` 配置）
3. 排除当前 session

**四阶段整合流程**：

| 阶段 | 操作 |
|------|------|
| **Orient** | `ls` 记忆目录、读取 MEMORY.md、浏览现有主题文件 |
| **Gather** | 优先读取每日日志，检查代码库矛盾的漂移记忆，再 grep JSONL 转录 |
| **Consolidate** | 编写/更新记忆文件，合并到现有主题而非创建重复，使用绝对日期 |
| **Prune + Index** | 更新 MEMORY.md（上限 200 行/25KB），删除陈旧条目，解决矛盾 |

**防并发锁**：
- 锁文件：`{autoMemPath}/.consolidate-lock`
- 内容：持有者 PID
- 陈旧保护：1 小时后强制过期

---

## 12. 未上线（灰度中）— Team Memory（团队记忆）

### 上线状态：❌ 未上线

### 门控条件（最重层门控，全部须满足）

| 层级 | 机制 | 条件 | 默认值 | 说明 |
|------|------|------|--------|------|
| 编译时 | `feature('TEAMMEM')` | 构建时确定 | 外部构建可能关闭 | 代码是否包含 |
| 运行时 | `isAutoMemoryEnabled()` | 基座层 | true | |
| 运行时 Gate | `tengu_herring_clock` | GrowthBook | **false** | 🔒 **核心阻塞点** |
| 同步依赖 | `isTeamMemorySyncAvailable()` | OAuth | - | 需要 OAuth 认证 |
| 同步依赖 | `getGithubRepo()` | GitHub | - | 需要 GitHub.com 远程仓库 |

**为什么未上线**：
1. `feature('TEAMMEM')` 编译时开关在外部构建中可能为 `false`，代码完全不存在
2. 即使代码存在，`tengu_herring_clock` 默认 `false`
3. 还需要 OAuth 认证 + GitHub 仓库

### 实现机制

**代码位置**：
- `src/memdir/teamMemPaths.ts` — 路径管理和安全校验
- `src/memdir/teamMemPrompts.ts` — 提示词构建
- `src/services/teamMemorySync/index.ts` — 同步核心
- `src/services/teamMemorySync/watcher.ts` — 文件监视器
- `src/services/teamMemorySync/secretScanner.ts` — 密钥扫描
- `src/services/teamMemorySync/teamMemSecretGuard.ts` — 安全守卫

**存储路径**：`<autoMemPath>/team/` （auto memory 的子目录）

**同步机制**：

```
Pull (拉取):
  GET /api → 写入本地（服务器优先）
  支持 ETag 304 缓存（避免重复下载）

Push (推送):
  本地变更 → fs.watch 监测 → 2 秒防抖
  delta 计算 → PUT 上传
  支持 412 Precondition Failed 冲突重试（最多 2 次）
  批量分包（MAX_PUT_BODY_BYTES = 200KB）

安全:
  scanForSecrets() → gitleaks 规则扫描 → 跳过含密钥文件
  validateTeamMemKey() → 路径遍历防护
  validateTeamMemWritePath() → symlink 逃逸防护
```

**安全校验详细**：
- `PathTraversalError` 类 — 路径遍历错误
- `sanitizePathKey()` — 拒绝 null byte、URL 编码遍历、Unicode 正规化攻击、反斜杠、绝对路径
- `realpathDeepestExisting()` — 解析 symlink，防止符号链接逃逸
- `validateTeamMemKey()` + `validateTeamMemWritePath()` — 双重验证（字符串级 + 文件系统级）
- **gitleaks 密钥扫描**：扫描 38+ 种密钥模式（AWS、GitHub Token、Slack、SendGrid、私钥等），含密钥文件被跳过不同步

---

## 13. 未上线（ANT Only）— /remember Skill

### 上线状态：❌ 未上线（ANT 用户专用）

### 门控条件

```typescript
// src/skills/bundled/remember.ts
export function registerRememberSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return  // 🔒 硬编码限制：仅 Anthropic 内部用户
  }
  // ...
  isEnabled: () => isAutoMemoryEnabled(),
}
```

**为什么未上线**：`USER_TYPE !== 'ant'` 硬编码检查，外部用户完全不可见。

### 实现机制

**代码位置**：`src/skills/bundled/remember.ts`

**功能**：记忆审查与整理工具。

**工作流程**：
1. 收集所有记忆层（CLAUDE.md + Auto Memory + Team Memory）
2. 将条目分类到最佳目标文件
3. 识别重复、过时、冲突条目
4. 生成整理报告，建议提升/删除/合并操作

---

## 14. GrowthBook Feature Flags 汇总

### Memory 相关 Flags

| Flag 名称 | 类型 | 默认值 | 控制子系统 | 说明 |
|-----------|------|--------|------------|------|
| `tengu_passport_quail` | gate | **false** | Extract Memories | 记忆提取总开关 |
| `tengu_bramble_lintel` | value | null→1 | Extract Memories | 提取频率控制（每 N 轮执行一次） |
| `tengu_slate_thimble` | gate | **false** | Extract Memories | 非交互式会话也提取 |
| `tengu_moth_copse` | gate | **false** | Extract Memories / Attachments | 跳过索引 / 记忆预取 |
| `tengu_session_memory` | gate | **false** | Session Memory | 会话记忆总开关 |
| `tengu_sm_config` | config | {} | Session Memory | 会话记忆参数配置 |
| `tengu_onyx_plover` | config | null | Auto Dream | 做梦启用 + 阈值配置 |
| `tengu_herring_clock` | gate | **false** | Team Memory | 团队记忆总开关 |

> ⚠️ **关键发现**：所有 Memory 子系统的 GrowthBook 运行时 gate **默认都是 `false`/`null`**，必须由 GrowthBook 服务器远程开启才能生效。

---

## 15. 编译时开关汇总

| 开关 | 控制范围 | 外部构建状态 |
|------|----------|-------------|
| `EXTRACT_MEMORIES` | 后台记忆提取代码 | 可能关闭 |
| `TEAMMEM` | 团队记忆全部代码 | 可能关闭 |
| `MEMORY_SHAPE_TELEMETRY` | 记忆形状遥测代码 | 可能关闭 |
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照功能 | 可能关闭 |
| `KAIROS` | 持久助手模式（含 dream、日志） | 关闭 |
| `KAIROS_DREAM` | KAIROS 做梦功能子集 | 关闭 |

---

## 16. 环境变量汇总

| 环境变量 | 作用 | 默认 |
|----------|------|------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1/true` → 禁用全部自动记忆 | 未设置 (启用) |
| `CLAUDE_CODE_SIMPLE` | `1` → 精简模式，关闭记忆 | 未设置 |
| `CLAUDE_CODE_REMOTE` | 远程模式标志 | 未设置 |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 远程记忆目录覆盖 | 未设置 |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | 完整记忆路径覆盖 (Cowork 用) | 未设置 |

---

## 17. 依赖关系图

```
isAutoMemoryEnabled() [总开关, 默认 true] ← ✅ 已上线
│
├── CLAUDE.md 多层级加载 ← ✅ 已上线
│   ├── Managed → User → Project → Local → AutoMem (始终加载)
│   └── TeamMem (需 feature('TEAMMEM') + tengu_herring_clock) ← ❌
│
├── 智能记忆召回 (findRelevantMemories) ← ✅ 已上线
│   └── tengu_moth_copse (预取优化, 默认 false) ← 优化未上线
│
├── 记忆新鲜度检测 ← ✅ 已上线
│
├── Agent Memory ← ✅ 已上线
│   └── feature('AGENT_MEMORY_SNAPSHOT') ← 快照机制可能未上线
│
├── /memory 命令 ← ✅ 已上线
│
├── Extract Memories ← ❌ 未上线
│   ├── feature('EXTRACT_MEMORIES')  [编译时]
│   ├── tengu_passport_quail         [GrowthBook, 默认 false] 🔒
│   ├── tengu_bramble_lintel         [节流]
│   ├── tengu_slate_thimble          [非交互扩展]
│   └── tengu_moth_copse             [索引跳过]
│
├── Session Memory ← ❌ 未上线
│   ├── tengu_session_memory         [GrowthBook, 默认 false] 🔒
│   ├── isAutoCompactEnabled()       [前置依赖]
│   └── tengu_sm_config              [配置]
│
├── Auto Dream ← ❌ 未上线
│   ├── !getKairosActive()           [KAIROS 互斥]
│   ├── !getIsRemoteMode()
│   ├── tengu_onyx_plover.enabled    [GrowthBook, 默认 null] 🔒
│   └── settings.autoDreamEnabled    [用户设置优先]
│
├── Team Memory ← ❌ 未上线
│   ├── feature('TEAMMEM')           [编译时] 🔒
│   ├── tengu_herring_clock          [GrowthBook, 默认 false] 🔒
│   ├── isUsingOAuth()               [需要 OAuth]
│   └── getGithubRepo()              [需要 GitHub]
│
└── /remember Skill ← ❌ 未上线
    └── USER_TYPE === 'ant'          [硬编码限制] 🔒
```

---

## 总结

### 外部用户实际可用的记忆能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 手动写 CLAUDE.md | ✅ | 用户可以手动编辑各层级的 CLAUDE.md 文件存储指令 |
| MEMORY.md 加载 | ✅ | 系统提示词中包含 MEMORY.md 内容 |
| /memory 命令 | ✅ | 用户可手动管理记忆文件 |
| Agent Memory | ✅ | Agent 可以有自己的记忆空间 |
| 智能召回 | ✅ | Sonnet 模型自动选择相关记忆 |
| 新鲜度提示 | ✅ | 过时记忆附带警告 |
| **自动记忆提取** | ❌ | 需要 `tengu_passport_quail` gate 开启 |
| **会话记忆** | ❌ | 需要 `tengu_session_memory` gate 开启 |
| **自动整合/做梦** | ❌ | 需要 `tengu_onyx_plover` gate 开启 |
| **团队记忆同步** | ❌ | 需要 `feature('TEAMMEM')` + `tengu_herring_clock` |
| **/remember 审查** | ❌ | 硬编码限制 Anthropic 内部用户 |

**核心结论**：Claude Code 的记忆系统已经构建了一套完整且精密的基础设施，但其中最具价值的自动化能力（自动提取、会话记忆、做梦整合、团队同步）全部处于灰度阶段，通过 GrowthBook 远程 gate 控制，**默认对外部用户关闭**。外部用户当前只能使用手动记忆管理能力。

---

*文档生成时间：2026-04-07*
*分析来源：源码静态分析（src/memdir/、src/services/extractMemories/、src/services/SessionMemory/、src/services/autoDream/、src/services/teamMemorySync/、src/utils/claudemd.ts 等）*
