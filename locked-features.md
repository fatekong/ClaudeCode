# Locked Features 分析文档

> 本文档由多个探索 Agent（bridge-agent、policy-agent、growthbook-agent、computeruse-agent）对 ClaudeCode 源码的分析结果整合而成，记录了项目中所有受 Feature Flag、构建时开关、运行时 Gate 等机制锁定的功能及其完整技术细节。

---

## 目录

1. [概述](#1-概述)
2. [GrowthBook Feature Flag 系统](#2-growthbook-feature-flag-系统)
3. [Bridge / Remote Control 功能](#3-bridge--remote-control-功能)
4. [Computer Use 功能](#4-computer-use-功能)
5. [Policy Limits 系统](#5-policy-limits-系统)
6. [工具权限系统](#6-工具权限系统)
7. [BUDDY 宠物伴侣系统](#7-buddy-宠物伴侣系统)
8. [KAIROS 持久助手模式](#8-kairos-持久助手模式)
9. [ULTRAPLAN 云端深度规划](#9-ultraplan-云端深度规划)
10. [Coordinator 多 Agent 编排模式](#10-coordinator-多-agent-编排模式)
11. [Voice 语音功能](#11-voice-语音功能)
12. [隐藏命令与系统开关](#12-隐藏命令与系统开关)
13. [代码路径索引](#13-代码路径索引)

---

## 1. 概述

### 项目背景

ClaudeCode 是 Anthropic 开发的 AI 编码助手 CLI 工具，其部分高级功能通过多层机制进行访问控制，防止未授权用户或不符合条件的环境使用敏感能力。

### Feature 锁定机制总览

项目采用 **三层锁定架构**：

| 层级 | 机制 | 作用范围 | 说明 |
|------|------|----------|------|
| 构建时 | `feature('FLAG_NAME')` 编译时开关 | 二进制级别 | 不满足则代码路径完全不存在 |
| 运行时 | GrowthBook Feature Gate / Flag | 用户级别 | 远程动态下发，支持 A/B 测试和灰度 |
| 组织级 | Policy Limits API | 组织/团队级别 | 由管理员通过后台配置，强制执行 |

**完整锁定条件** 通常需要以上所有层级全部满足，任何一层不满足均无法开启功能。

---

## 2. GrowthBook Feature Flag 系统

### 2.1 架构概览

```
优先级（从高到低）：
CLAUDE_INTERNAL_FC_OVERRIDES（环境变量）
    ↓
growthBookOverrides（本地覆盖，ANT only）
    ↓
remoteEvalFeatureValues（内存缓存，从GrowthBook远程API获取）
    ↓
cachedGrowthBookFeatures（磁盘缓存，~/.claude.json）
    ↓
默认值（代码内硬编码）
```

### 2.2 三层缓存机制

| 层级 | 存储位置 | 类型 | 说明 |
|------|----------|------|------|
| 磁盘缓存 | `~/.claude.json` | 持久化 | 跨进程保留，冷启动使用 |
| 内存缓存 | 进程内存 | 运行时 | 从磁盘加载或远程API刷新 |
| 远程 API | GrowthBook 服务 | 动态 | 定期后台拉取最新配置 |

**刷新周期：**
- ANT 内部用户：**20 分钟**
- 外部普通用户：**6 小时**

### 2.3 核心检查函数

| 函数名 | 类型 | 延迟 | 使用场景 |
|--------|------|------|----------|
| `getFeatureValue_CACHED_MAY_BE_STALE` | 同步 | <1ms | 最常用，92+ flags 使用（允许返回略过期数据） |
| `checkGate_CACHED_OR_BLOCKING` | 异步 | 0–5s | 用户触发操作，需要最新状态时 |
| `getDynamicConfig_CACHED_MAY_BE_STALE` | 同步 | <1ms | 读取配置对象（非布尔值） |
| `getDynamicConfig_BLOCKS_ON_INIT` | 异步 | - | **已弃用** |

### 2.4 Feature Flags 完整分类列表（共 900+）

#### 1. Bridge / Remote Control 相关

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_ccr_bridge` | gate | false | Bridge 功能总开关 |
| `tengu_ccr_bridge_multi_session` | gate | false | 多会话生成模式 |
| `tengu_bridge_repl_v2` | gate | false | Bridge v2（无环境变量路径） |
| `tengu_bridge_poll_interval_config` | config | - | 轮询间隔和心跳配置 |
| `tengu_cobalt_harbor` | gate | false | CCR 自动连接 |
| `tengu_ccr_mirror` | gate | false | CCR 镜像模式 |

#### 2. Agent 和 Tool 相关

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_agent_list_attach` | gate | false | Agent 列表附加功能 |
| `tengu_auto_background_agents` | gate | false | 自动后台 Agent |
| `tengu_amber_stoat` | gate | **true** | - |
| `tengu_slim_subagent_claudemd` | gate | **true** | 精简子Agent的 claude.md |
| `tengu_hive_evidence` | gate | false | Hive 证据功能 |
| `tengu_surreal_dali` | gate | false | RemoteTriggerTool 相关 |
| `tengu_tool_pear` | gate | false | 工具严格模式 |

#### 3. Auto Mode / 自动模式

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_auto_mode_config` | config object | - | Auto 模式详细配置 |
| `tengu_kairos` | gate | false | Kairos 会话恢复 |
| `tengu_kairos_brief` | gate | false | Kairos 简短模式 |
| `tengu_kairos_cron_config` | config | - | Kairos Cron 调度配置 |

#### 4. 内存和会话管理

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_session_memory` | gate | false | 会话记忆功能 |
| `tengu_coral_fern` | gate | false | - |
| `tengu_herring_clock` | gate | false | - |
| `tengu_passport_quail` | gate | false | - |
| `tengu_slate_thimble` | gate | false | - |
| `tengu_bramble_lintel` | gate | false | - |

#### 5. MCP / Channel 权限

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_harbor` | gate | false | Harbor MCP 功能 |
| `tengu_harbor_permissions` | gate | false | Harbor 权限系统 |
| `tengu_quiet_fern` | gate | false | - |
| `tengu_vscode_cc_auth` | gate | false | VS Code 认证集成 |

#### 6. 分析和事件

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_event_sampling_config` | config object | - | 事件采样配置 |
| `tengu_1p_event_batch_config` | config object | - | 一方事件批处理配置 |
| `tengu_streaming_tool_execution2` | gate | false | 流式工具执行 v2 |

#### 7. 文件和编辑

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_quartz_lantern` | gate | false | - |
| `tengu_moth_copse` | gate | false | - |
| `tengu_marble_fox` | gate | false | - |
| `tengu_collage_kaleidoscope` | gate | **true** | - |
| `tengu_pebble_leaf_prune` | gate | false | - |

#### 8. UI 和显示

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_terminal_sidebar` | gate | false | 终端侧边栏 |
| `tengu_terminal_panel` | gate | false | 终端面板 |
| `tengu_willow_mode` | string | `'off'` | Willow 显示模式 |
| `tengu_chomp_inflection` | gate | false | - |

#### 9. 模型和 API

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_ant_model_override` | config | - | ANT 模型覆盖 |
| `tengu_otk_slot_v1` | gate | false | OTK 插槽 v1 |
| `tengu_fgts` | gate | false | - |
| `tengu_turtle_carbon` | gate | **true** | Thinking 功能开关 |

#### 10. 权限和安全

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_birch_trellis` | gate | **true** | Bash 权限默认值 |
| `tengu_destructive_command_warning` | gate | false | 危险命令警告 |
| `tengu_sessions_elevated_auth_enforcement` | gate | false | 信任设备令牌强制实施 |

#### 11. 快速模式和优化

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_miraculo_the_bard` | gate | false | 快速模式禁用 |
| `tengu_cicada_nap_ms` | config | - | 后台刷新节流（毫秒） |
| `tengu_marble_sandcastle` | gate | false | - |

#### 12. 深链接和导航

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_lodestone_enabled` | gate | false | Lodestone 深链接 |
| `tengu_remote_backend` | gate | false | 远程后端连接 |

#### 13. Keybinding

| Flag 名称 | 类型 | 默认值 | 说明 |
|-----------|------|--------|------|
| `tengu_keybinding_customization_release` | gate | false | 自定义快捷键 |

#### 14. 其他实验性功能（20+ 个）

包含色系功能（coral/amber/marble 等前缀）、工具相关、集成测试、配置实验等，均默认关闭。

---

## 3. Bridge / Remote Control 功能

### 3.1 功能描述

Bridge（又称 Remote Control，代码别名 CCR）是一个**云端远程控制**功能，允许用户通过 `claude.ai/code` 网页应用远程操控本地 Claude Code CLI 环境中运行的会话。用户可在网页端发送指令，本地 CLI 执行并将结果同步回网页。

### 3.2 所有 Feature Flags

| Flag 名称 | 类型 | 所在文件 | 说明 |
|-----------|------|----------|------|
| `BRIDGE_MODE` | 构建时 | `bridgeEnabled.ts:1-36` | 编译时总开关 |
| `tengu_ccr_bridge` | GrowthBook gate | `bridgeEnabled.ts:28-36` | 运行时总开关 |
| `tengu_bridge_repl_v2` | GrowthBook gate | `bridgeEnabled.ts:126-130` | Bridge v2（无环境变量路径） |
| `tengu_bridge_repl_v2_cse_shim_enabled` | GrowthBook gate | `bridgeEnabled.ts:141-148` | cse_* → session_* 兼容性垫片 |
| `tengu_ccr_bridge_multi_session` | GrowthBook gate | `bridgeMain.ts:96-98` | 多会话生成模式 |
| `tengu_cobalt_harbor` | GrowthBook gate | `bridgeEnabled.ts:185-189` | CCR 自动连接 |
| `CCR_AUTO_CONNECT` | 构建时 | `bridgeEnabled.ts:185-189` | 与 `tengu_cobalt_harbor` 配合使用 |
| `tengu_ccr_mirror` | GrowthBook gate | `bridgeEnabled.ts:197-202` | CCR 镜像模式（单向事件转发） |
| `CCR_MIRROR` | 构建时 | `bridgeEnabled.ts:197-202` | 与 `tengu_ccr_mirror` 配合使用 |
| `KAIROS` | 构建时 | `bridgeMain.ts:1779-1793` | 会话恢复（--session-id / --continue） |
| `tengu_bridge_min_version` | GrowthBook config | `bridgeEnabled.ts:160-173` | CLI 最低版本要求（v1 路径） |
| `tengu_bridge_poll_interval_config` | GrowthBook config | `pollConfig.ts` | 轮询间隔和心跳配置 |
| `tengu_bridge_repl_v2_config` | GrowthBook config | `envLessBridgeConfig.ts` | v2 Bridge 详细配置 |
| `tengu_bridge_initial_history_cap` | GrowthBook config | `replBridge.ts:169` | 初始消息重放历史上限（默认 200） |
| `tengu_bridge_system_init` | GrowthBook gate | `useReplBridge.tsx` | 系统初始化消息自动发送（默认 false） |
| `tengu_sessions_elevated_auth_enforcement` | GrowthBook gate | `trustedDevice.ts:33-36` | 信任设备令牌强制实施（默认 false） |

### 3.3 开启 Bridge 的完整条件（全部必须满足）

```
1. 编译时：feature('BRIDGE_MODE') === true
2. 用户类型：isClaudeAISubscriber() === true
   （必须是 claude.ai 有效订阅用户，不支持 API Key / Bedrock / Vertex）
3. OAuth 范围：hasProfileScope() === true
   （OAuth token 必须包含 user:profile scope）
4. 组织信息：getOauthAccountInfo()?.organizationUuid 存在（非空）
5. GrowthBook：tengu_ccr_bridge gate === true（远程下发开启）
```

### 3.4 子功能详情

#### 基础 Remote Control
- 命令：`/remote-control` 或 `/rc`
- 依赖：满足 3.3 中所有基础条件

#### Multi-Session 模式
- 依赖：额外需要 `tengu_ccr_bridge_multi_session` gate
- 支持三种隔离模式：
  - `worktree`：Git worktree 隔离
  - `same-dir`：同目录多会话
  - `session`：纯会话隔离

#### Session 恢复（Kairos）
- 依赖：编译时 `KAIROS` 构建标志
- 参数：`--session-id <id>` 和 `--continue`
- 代码位置：`bridgeMain.ts:1779-1793`

#### CCR v2 无环境变量路径
- 依赖：`tengu_bridge_repl_v2` gate
- 配置：通过 `tengu_bridge_repl_v2_config` 动态配置

#### CCR 镜像模式
- 依赖：构建时 `CCR_MIRROR` + `tengu_ccr_mirror` gate
- 功能：单向事件转发（只读镜像）

#### CCR 自动连接
- 依赖：构建时 `CCR_AUTO_CONNECT` + `tengu_cobalt_harbor` gate
- 功能：启动时自动建立 CCR 连接

#### 信任设备验证
- 依赖：`tengu_sessions_elevated_auth_enforcement` gate
- 功能：强制验证设备信任令牌

---

## 4. Computer Use 功能

### 4.1 功能描述

Computer Use（代号 **Chicago / Malort / Pedway**）允许 Claude 在 **macOS** 上直接控制计算机，包含屏幕截图捕获、鼠标键盘控制、以及应用程序权限管理，使 Claude 能够像人类一样操作桌面环境。

### 4.2 启用条件（全部必须满足）

```
1. 编译时：feature('CHICAGO_MCP') === true
2. 平台：macOS（不支持 Linux/Windows）
3. 会话类型：交互式会话（--print 模式下不可用）
4. GrowthBook：tengu_malort_pedway.enabled === true
   （getDynamicConfig_CACHED_MAY_BE_STALE，默认值为 false，必须远程开启）
5. 订阅：Max 或 Pro（ANT 用户可 bypass 此检查）
```

#### ANT 开发者特殊条件

| 条件 | 说明 |
|------|------|
| `USER_TYPE=ant` | 跳过订阅等级检查 |
| 存在 `MONOREPO_ROOT_DIR` | 需要额外设置 `ALLOW_ANT_COMPUTER_USE_MCP=1` 才能使用 |

### 4.3 工具列表

所有工具名前缀：`mcp__computer-use__`

| 类别 | 工具名 | 说明 |
|------|--------|------|
| **屏幕** | `screenshot` | 截取当前屏幕 |
| | `zoom` | 局部放大截图 |
| **点击** | `left_click` | 左键单击 |
| | `right_click` | 右键单击 |
| | `middle_click` | 中键单击 |
| | `double_click` | 双击 |
| | `triple_click` | 三击（选中文本） |
| **鼠标** | `mouse_move` | 移动鼠标 |
| | `left_click_drag` | 左键拖拽 |
| | `left_mouse_down` | 按下左键 |
| | `left_mouse_up` | 释放左键 |
| **键盘** | `type` | 输入文字 |
| | `key` | 按下特定按键 |
| | `hold_key` | 持续按住按键 |
| **应用** | `open_application` | 打开应用程序 |
| | `request_access` | 请求应用访问权限 |
| | `list_granted_applications` | 列出已授权应用 |
| **系统** | `read_clipboard` | 读取剪贴板内容 |
| | `write_clipboard` | 写入剪贴板内容 |
| | `scroll` | 滚动操作 |
| | `cursor_position` | 获取光标/鼠标当前位置 |
| | `wait` | 等待延迟（暂停操作） |
| | `computer_batch` | 批量计算机操作 |

### 4.4 互斥锁机制

```
锁文件路径：~/.claude/computer-use.lock
锁文件格式：{ sessionId, pid, acquiredAt }
创建方式：O_EXCL 原子操作（防止竞态条件）
清理方式：进程死亡时自动清理陈旧锁
```

**限制：** 同一时刻全局只允许一个会话使用 Computer Use 功能。

### 4.5 Gates 配置（`tengu_malort_pedway` 默认值）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `false` | 功能总开关（必须通过 GrowthBook 远程开启） |
| `pixelValidation` | `false` | 像素级坐标验证 |
| `clipboardPasteMultiline` | `true` | 支持多行粘贴 |
| `mouseAnimation` | `true` | 鼠标移动动画 |
| `hideBeforeAction` | `true` | 操作前隐藏窗口 |
| `autoTargetDisplay` | `true` | 自动定位目标显示器 |
| `clipboardGuard` | `true` | 剪贴板内容保护 |
| `coordinateMode` | `'pixels'` | 坐标模式（像素绝对坐标） |

### 4.6 安全限制

- **主线程限制**：仅主线程可发起，子 Agent 无法使用
- **单实例**：全局文件锁确保同一时刻仅一个会话
- **权限不持久**：应用允许列表不跨 `resume` 保留（每次重启需重新授权）
- **防注入保护**：全局 `Escape` 热键拦截（`CGEventTap`），防止 prompt injection 劫持鼠标键盘

---

## 5. Policy Limits 系统

### 5.1 功能概述

Policy Limits 是**组织/团队级别**的功能限制机制，由组织管理员通过后台配置，强制对所有成员生效。与 GrowthBook（用户级别灰度）不同，Policy Limits 是管理员主动禁用功能的手段。

### 5.2 API 接口

```
GET {BASE_API_URL}/api/claude_code/policy_limits
```

| 属性 | 说明 |
|------|------|
| **资格** | Team/Enterprise OAuth 用户 或 Console API Key 用户 |
| **本地缓存** | `~/.config/claude/policy-limits.json` |
| **刷新周期** | 1 小时后台轮询 |
| **失败策略** | 失败开放（网络错误不阻止功能，视为无限制） |

### 5.3 三个已知组织级限制

| Policy 键名 | 默认（未配置） | 限制作用 | 检查位置 |
|-------------|----------------|----------|----------|
| `allow_remote_sessions` | 允许 | 禁用远程会话（`--remote`, `--teleport`） | `main.tsx:3411`<br>`RemoteTriggerTool.ts:60`<br>`initReplBridge.ts:155`<br>`print.ts:4991` |
| `allow_remote_control` | 允许 | 禁用 Bridge 远程控制功能 | `initReplBridge.ts:155`<br>`cli.tsx:157`<br>`bridge.tsx:474` |
| `allow_product_feedback` | 允许 | 禁用产品反馈（调查问卷等） | `useMemorySurvey.tsx:99,178`<br>`useFeedbackSurvey.tsx:136,237`<br>`feedback/index.ts:21` |

### 5.4 ESSENTIAL_TRAFFIC_DENY_ON_MISS 机制

当组织启用 **essential-traffic-only 模式**（HIPAA 合规场景）时，即使 Policy Limits 缓存不可用（如网络超时或缓存未命中），某些策略也会**默认被拒绝**（fail closed），而非执行通常的失败开放（fail open）策略。

| 策略键名 | 缓存不可用时的行为 | 原因 |
|----------|------------------|------|
| `allow_product_feedback` | **默认拒绝** | HIPAA 合规要求，防止在缓存未加载时意外发送用户数据 |

**代码位置**：`src/services/policyLimits/index.ts:502`

```typescript
const ESSENTIAL_TRAFFIC_DENY_ON_MISS = new Set(['allow_product_feedback'])
```

所有其他策略在缓存不可用时仍遵循失败开放原则（默认允许）。

---

## 6. 工具权限系统

### 6.1 权限决策链（`hasPermissionsToUseTool`）

```
用户请求使用工具
    ↓
① 检查 Deny 规则 → 如命中：拒绝
    ↓
② 检查 Ask 规则 → 如命中：询问用户
    ↓
③ tool.checkPermissions() → 工具自身权限验证
    ↓
④ 检查模式：
   - bypassPermissions → 直接允许
   - dontAsk → 直接允许（不询问）
   - auto → 自动决策（ANT only）
    ↓
⑤ 检查 Allow 规则 → 如命中：允许
    ↓
默认拒绝
```

### 6.2 权限模式

| 模式名 | 说明 | 可用范围 |
|--------|------|----------|
| `default` | 标准交互权限，需要确认 | 所有用户 |
| `plan` | 计划模式，只读 | 所有用户 |
| `acceptEdits` | 自动接受文件编辑 | 所有用户 |
| `bypassPermissions` | 绕过所有权限检查 | 所有用户 |
| `dontAsk` | 不询问用户，自动允许 | 所有用户 |
| `auto` | 全自动模式 | **ANT only** |
| `bubble` | 权限向上冒泡 | **ANT only** |

### 6.3 权限规则优先级（从低到高）

```
1. userSettings          ← ~/.config/claude/settings.json（用户级，最低优先级）
2. projectSettings       ← claude.json（项目级）
3. localSettings         ← .claude/settings.json（本地项目级，gitignored）
4. flagSettings          ← Feature Flag 设置
5. policySettings        ← 组织 Policy Limits
6. cliArg                ← 命令行参数
7. command               ← 命令配置
8. session               ← 会话配置（最高优先级，覆盖所有）
```

### 6.4 Agent 工具禁用列表

#### ALL_AGENT_DISALLOWED_TOOLS（所有 Agent 类型均不可用）

| 工具名 | 说明 | 限制条件 |
|--------|------|----------|
| `TaskOutput` | 获取任务输出 | 始终禁用 |
| `ExitPlanMode` | 退出计划模式 | 始终禁用 |
| `EnterPlanMode` | 进入计划模式 | 始终禁用 |
| `AskUserQuestion` | 向用户提问 | 始终禁用 |
| `TaskStop` | 停止任务 | 始终禁用 |
| `AgentTool` | 启动子 Agent | 仅对**非 ANT 用户**禁用 |
| `WorkflowTool` | 工作流工具 | 仅当 `WORKFLOW_SCRIPTS` 启用时才禁用 |

#### ASYNC_AGENT_ALLOWED_TOOLS（异步 Agent 允许使用）

```
FileRead, WebSearch, TodoWrite, Grep, WebFetch, Glob,
Bash/Shell, FileEdit, FileWrite, NotebookEdit, Skill,
SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree
```

#### IN_PROCESS_TEAMMATE_ALLOWED_TOOLS（进程内 Teammate Agent 允许使用）

```
TaskCreate, TaskGet, TaskList, TaskUpdate, SendMessage
（+ 条件性：CronCreate/Delete/List，仅当 AGENT_TRIGGERS 启用时）
```

---

## 7. BUDDY 宠物伴侣系统

编译开关：`feature('BUDDY')`，外部版本完全不包含此代码。

### 7.1 功能描述

每个用户账号绑定一只确定性生成的虚拟宠物（基于账号 UUID），在终端侧边栏展示 ASCII 精灵动画，支持互动命令。

### 7.2 物种系统（18种）

duck、goose、blob、cat、dragon、octopus、owl、penguin、turtle、snail、ghost、axolotl（墨西哥钝口螈）、capybara（水豚）、cactus（仙人掌）、robot、rabbit、mushroom、chonk（胖猫）

> 物种名在源码中通过 String.fromCharCode 十六进制编码隐藏字面值

### 7.3 稀有度系统（5级）

| 稀有度 | 权重 | 概率 | 显示符号 |
|--------|------|------|----------|
| common | 60 | 60% | ★ |
| uncommon | 25 | 25% | ★★ |
| rare | 10 | 10% | ★★★ |
| epic | 4 | 4% | ★★★★ |
| legendary | 1 | 1% | ★★★★★ |

### 7.4 闪光（Shiny）机制

- 概率：1%（`rng() < 0.01`），完全独立于稀有度
- 代码位置：`src/buddy/companion.ts:98`

### 7.5 确定性生成算法

- 盐值：`'friend-2026-401'`（`companion.ts:84`）
- 哈希：`Bun.hash()` 或 FNV-1a fallback（`companion.ts:27-37`）
- PRNG：Mulberry32（`companion.ts:16-25`）
- 生成流程：`hashString(userId + SALT)` → seed → Mulberry32 PRNG → 物种/稀有度/外观/属性/闪光
- 缓存：热路径（500ms 刻度）中缓存相同 userId 的结果

### 7.6 外观系统

- 眼睛（6种）：`·`、`✦`、`×`、`◉`、`@`、`°`
- 帽子（8种）：none、crown（皇冠）、tophat（高礼帽）、propeller（螺旋桨）、halo（光环）、wizard（巫师帽）、beanie（针织帽）、tinyduck（小鸭子）
- 规则：common 稀有度始终为 none 帽子

### 7.7 属性系统（5个）

`DEBUGGING`、`PATIENCE`、`CHAOS`、`WISDOM`、`SNARK`

- 每只宠物有1个高峰属性、1个低谷属性
- 稀有度提升属性下限（common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50）

### 7.8 动画系统

- 帧率：500ms（`TICK_MS = 500`）
- 精灵尺寸：12字符宽 × 5行高
- 闲置序列：15帧循环（约7.5秒周期），含静止帧/摆动帧/眨眼帧
- 宠物反应（/buddy pet）：2.5秒心形浮动动画（5帧）
- 窄终端退化：终端宽度 < 100列时退化为单行脸部显示（如 `(·>`）

### 7.9 交互命令

| 命令 | 功能 |
|------|------|
| `/buddy pet` | 抚摸宠物（触发心形动画） |
| `/buddy hatch` | 孵化宠物（生成 Soul） |
| `/buddy card` | 查看宠物卡片 |
| `/buddy` | 打开宠物界面 |

### 7.10 数据结构

- `CompanionBones`（确定性）：rarity, species, eye, hat, shiny, stats
- `CompanionSoul`（AI生成）：name, personality
- 存储：仅 Soul + hatchedAt 保存到配置，Bones 每次从 userId 重算

### 7.11 代码路径

| 文件路径 | 行数 | 内容 |
|----------|------|------|
| `src/buddy/companion.ts` | 133 | 生成算法 |
| `src/buddy/types.ts` | - | 物种/稀有度/帽子常量 |
| `src/buddy/sprites.ts` | 514 | ASCII 精灵资源 |
| `src/buddy/CompanionSprite.tsx` | 370 | React 动画组件 |
| `src/commands.ts` | 118-122 | 命令注册 |

---

## 8. KAIROS 持久助手模式

编译开关：`feature('KAIROS')`，依赖多个子开关（KAIROS_BRIEF、KAIROS_CHANNELS、KAIROS_GITHUB_WEBHOOKS）。

### 8.1 功能描述

跨会话持久化的 AI 助手模式，关闭终端后仍可后台运行，具备自动日志记录、自动记忆整合（Dream）、主动行动能力和持久 Cron 任务。

### 8.2 启用方式

- 环境变量：`CLAUDE_CODE_ASSISTANT_MODE=1`
- CLI 参数：`--assistant`（隐藏参数，Agent SDK daemon 用）
- GrowthBook gate：`tengu_kairos`

### 8.3 每日日志

- 路径：`<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md`
- 代码位置：`src/memdir/paths.ts:246-250`
- 行为：助手模式下追加日志，夜间 /dream 将日志蒸馏到主题文件

### 8.4 自动做梦（autoDream）四阶段流程

**触发条件（全部满足）：**

1. 距上次整合 ≥ 24 小时（可通过 `tengu_onyx_plover` 配置）
2. 新会话数 ≥ 5 个（可通过 `tengu_onyx_plover` 配置）
3. 不在 KAIROS 模式（KAIROS 模式用磁盘技能 /dream）
4. 不在远程模式
5. 自动内存已启用

**阶段流程：**

| 阶段 | 操作 |
|------|------|
| **Orient** | `ls` 内存目录、读取 MEMORY.md、浏览现有主题文件 |
| **Gather** | 优先读取每日日志，其次检查与代码库矛盾的漂移记忆，再 grep JSONL 转录 |
| **Consolidate** | 编写/更新内存文件，合并到现有主题而非创建重复，绝对日期化 |
| **Prune + Index** | 更新 MEMORY.md（上限200行/25KB），删除陈旧条目，解决矛盾 |

### 8.5 锁机制（防止多进程同时做梦）

- 锁文件：`{autoMemPath}/.consolidate-lock`
- 内容：持有者 PID
- 陈旧保护：1小时后强制过期（防止 PID 复用）
- 代码位置：`src/services/autoDream/consolidationLock.ts`

### 8.6 子代理工具限制（做梦期间）

- 仅允许只读 Bash 命令（ls、find、grep、cat、stat、wc、head、tail）
- 不允许任何写入/重定向/状态修改

### 8.7 主动模式（Proactive）

- 启用：`--proactive` 或 `CLAUDE_CODE_PROACTIVE=1`
- 编译开关：`feature('PROACTIVE')` 或 `feature('KAIROS')`
- 行为：收到周期性 `<tick>` 提示，自主决定继续工作或调用 SleepTool 等待
- 新会话第一个 tick：简短问候用户，询问需要做什么

### 8.8 后台任务自动转换

- 阈值：15秒（`ASSISTANT_BLOCKING_BUDGET_MS = 15_000`）
- 条件：KAIROS 模式 + 主线程 + 未显式后台化
- 代码位置：`src/tools/BashTool/BashTool.tsx:57`

### 8.9 持久化 Cron 任务

- 编译开关：`feature('AGENT_TRIGGERS')`
- 工具：CronCreateTool、CronDeleteTool、CronListTool
- 在进程内 Teammate 中可用（参见工具权限章节）
- `permanent: true` 的任务不受7天过期限制

### 8.10 相关 GrowthBook Flags

| Flag | 说明 |
|------|------|
| `tengu_kairos` | 主开关 |
| `tengu_onyx_plover` | autoDream 阈值配置（minHours/minSessions） |
| `tengu_kairos_brief` | Brief 工具可用性（杀死开关） |
| `tengu_kairos_brief_config` | Brief 配置（含 enable_slash_command） |
| `tengu_passport_quail` | 提取内存启用 |
| `tengu_slate_thimble` | 非交互式会话提取模式 |

### 8.11 代码路径

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/assistant/index.ts` | - | 助手模式检测 |
| `src/services/autoDream/autoDream.ts` | - | 触发条件和子代理执行 |
| `src/services/autoDream/consolidationPrompt.ts` | - | 四阶段提示 |
| `src/services/autoDream/consolidationLock.ts` | - | 锁机制 |
| `src/memdir/paths.ts` | 246-250 | 日志路径生成 |
| `src/tools/BashTool/BashTool.tsx` | 57 | 15秒自动后台 |
| `src/main.tsx` | 3839-3848 | 隐藏 CLI 参数定义 |

---

## 9. ULTRAPLAN 云端深度规划

编译开关：`feature('ULTRAPLAN')`，**仅 Anthropic 内部用户可用**（`isEnabled: () => "external" === 'ant'` 始终为 false）。

### 9.1 功能描述

将复杂规划任务发送到远端 Opus 模型独立研究（最长30分钟），用户在浏览器 PlanModal 中查看/编辑/批准方案，可在远程执行或传送回本地执行。

### 9.2 完整流程

1. 用户执行 `/ultraplan <prompt>` 或消息包含 "ultraplan" 关键词
2. `teleportToRemote()` 创建 CCR 远程会话
3. 远程端用 Opus 模型独立研究（由 `tengu_ultraplan_model` 动态配置）
4. 本地轮询 `pollForApprovedExitPlanMode()`（轮询间隔3000ms，超时30分钟）
5. 用户在浏览器 PlanModal 查看、编辑、批准/拒绝
6. 批准 → 远程执行 或 传送回本地（`ULTRAPLAN_TELEPORT_SENTINEL` 哨兵标记）

### 9.3 超时设置

- `ULTRAPLAN_TIMEOUT_MS = 30 * 60 * 1000`（`src/commands/ultraplan.tsx:24`）
- 最大连续失败：5次后中止（`src/utils/ultraplan/ccrSession.ts:24`）

### 9.4 关键词自动触发（`findKeywordTriggerPositions`）

- 大小写不敏感单词边界匹配（`\bultraplan\b`）
- **排除**：引号/括号/方括号内；路径标识符（含 `/`、`\`、`.扩展名`）；后跟 `?`；`/ultraplan` 斜杠命令
- 代码位置：`src/utils/ultraplan/keyword.ts:46-95`

### 9.5 传送（Teleport）实现

- 默认优先 GitHub 克隆（GitHub App 认证）
- 回退：Git Bundle 模式（`createAndUploadGitBundle()`，通过 Files API 上传）
- 支持未提交代码（通过 `refs/seed/stash` 捕获）
- 强制 Bundle：`CCR_FORCE_BUNDLE=1` 或 GrowthBook `tengu_ccr_bundle_seed_enabled`
- 代码位置：`src/utils/teleport.tsx:730-795`

### 9.6 使用模型

- `tengu_ultraplan_model`（GrowthBook 动态配置）
- 默认：`ALL_MODEL_CONFIGS.opus46.firstParty`
- 代码位置：`src/commands/ultraplan.tsx:32-34`

### 9.7 代码路径

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/commands/ultraplan.tsx` | 234-293 | launchUltraplan 主入口 |
| `src/utils/ultraplan/ccrSession.ts` | - | 轮询和会话管理 |
| `src/utils/ultraplan/keyword.ts` | 46-95 | 关键词检测 |
| `src/utils/teleport.tsx` | 730-795 | 传送实现 |

---

## 10. Coordinator 多 Agent 编排模式

编译开关：`feature('COORDINATOR_MODE')`，运行时环境变量：`CLAUDE_CODE_COORDINATOR_MODE=1`。

### 10.1 功能描述

Coordinator 扮演纯指挥官角色，只有3个工具，通过派发独立 Worker 子进程并行完成复杂任务。

### 10.2 Coordinator 三工具限制

| 工具 | 用途 |
|------|------|
| `AgentTool` | 派遣新 Worker 或创建后台任务 |
| `SendMessageTool` | 向现有 Worker 发送后续指令 |
| `TaskStopTool` | 中止运行中的 Worker |

代码位置：`src/coordinator/coordinatorMode.ts:111-133`

### 10.3 Worker 机制

- 独立子进程，拥有完整的 ASYNC_AGENT_ALLOWED_TOOLS 工具集
- 不含内部工具（TeamCreate、TeamDelete、SendMessage、SyntheticOutput）
- 简单模式（`CLAUDE_CODE_SIMPLE=1`）：仅 Bash + FileRead + FileEdit
- 代码位置：`src/coordinator/coordinatorMode.ts:80-109`

### 10.4 核心铁律（系统提示中强制）

- Workers 无法看到 Coordinator 的对话，每个 prompt 必须自包含所有信息
- 禁止甩锅式委派：不能写 "based on your findings..."，必须自己理解 Worker 结果再明确指派
- 代码位置：`src/coordinator/coordinatorMode.ts:250-259`

### 10.5 共享任务列表

基于文件系统，路径 `~/.claude/tasks/{team-name}/`，其中 `{team-name}` 是团队名称的规范化版本，Coordinator 和 Worker 共同读写。

### 10.6 双层门控

1. 编译时：`feature('COORDINATOR_MODE') === true`
2. 运行时：`CLAUDE_CODE_COORDINATOR_MODE` 为真值（1/true）

### 10.7 代码路径

| 文件路径 | 内容 |
|----------|------|
| `src/coordinator/coordinatorMode.ts` | 主实现（含系统提示、工具过滤、Worker 上下文） |

---

## 11. Voice 语音功能

编译开关：`feature('VOICE_MODE')`，还需要 GrowthBook gate `tengu_amber_quartz_disabled === false`。

### 11.1 功能描述

Hold-to-Talk 实时语音输入，将用户语音通过 Deepgram STT 转换为文字发送给 Claude。支持按住录音、实时转录预览、音频波形可视化、19+语言、关键词增强（Keyterms）。

### 11.2 启用条件（全部必须满足）

1. 编译时：`feature('VOICE_MODE') === true`
2. GrowthBook：`tengu_amber_quartz_disabled === false`（紧急杀死开关）
3. 认证：必须是 claude.ai OAuth 用户（不支持 API Key/Bedrock/Vertex/Foundry）
4. 设备：需要麦克风权限
5. API：`/api/ws/speech_to_text/voice_stream` WebSocket 端点可用

### 11.3 STT 提供商

| 模式 | Provider | 启用条件 | 采样率 |
|------|----------|----------|--------|
| 默认 | Deepgram（旧版） | 默认 | 16kHz，16-bit PCM 单声道 |
| Nova 3 | Deepgram Nova 3 | `tengu_cobalt_frost = true` | 同上 + use_conversation_engine=true |

Nova 3 差异：路由通过 conversation_engine，禁用自动段落检测（因 interim 可修订早期文本）

### 11.4 平台支持

| 平台 | 支持情况 | 实现方式 |
|------|----------|----------|
| macOS | 支持 | 原生 CoreAudio（`audio-capture-napi`） |
| Linux | 支持 | cpal / arecord（ALSA） / SoX 三级 fallback |
| Windows | 支持 | 原生 audio-capture-napi |
| WSL（含 WSLg） | 支持 | arecord / SoX（PulseAudio） |
| 远程环境 | 不支持 | 无本地麦克风 |
| WSL1/Win10无WSLg | 不支持 | 无音频 |
| Headless Linux | 不支持 | 无音频 |

### 11.5 操作模式

- **Hold-to-Talk**：按住 Space 键录音（默认绑定 `voice:pushToTalk`）
- **Focus Mode**：终端获得焦点时自动开始录音

### 11.6 关键词增强（Keyterms）

自动提取项目名、分支名、文件名作为 STT hints，提升专业术语识别准确率。代码位置：`src/services/voiceKeyterms.ts`

### 11.7 命令

`/voice` — 切换语音模式开关，运行6项预检查（录音可用性、API可用性、依赖、麦克风权限等）

### 11.8 GrowthBook Flags

| Flag | 默认值 | 说明 |
|------|--------|------|
| `tengu_amber_quartz_disabled` | false | 紧急关闭开关（true 时禁用语音） |
| `tengu_cobalt_frost` | false | 启用 Deepgram Nova 3 |

**无独立 Policy Limit：** 语音功能不受组织级 Policy Limits 单独控制。

### 11.9 代码路径

| 文件路径 | 行数 | 内容 |
|----------|------|------|
| `src/voice/voiceModeEnabled.ts` | - | 权限检查（OAuth + GrowthBook 门控） |
| `src/services/voiceStreamSTT.ts` | 544 | WebSocket STT 客户端 |
| `src/services/voice.ts` | 526 | 音频捕获与录制 |
| `src/services/voiceKeyterms.ts` | 106 | 关键词提取 |
| `src/commands/voice/voice.ts` | - | /voice 命令 |
| `src/hooks/useVoice.ts` | 1144 | Hold-to-Talk React Hook |

---

## 12. 隐藏命令与系统开关

### 12.1 Feature-Gated 命令（编译时开关控制）

| 命令 | 功能 | 编译开关 |
|------|------|----------|
| `/buddy` | 宠物伴侣系统 | `BUDDY` |
| `/proactive` | 主动自主模式 | `PROACTIVE` / `KAIROS` |
| `/assistant` | 助手守护进程模式 | `KAIROS` |
| `/brief` | Agent-用户通信工具（SendUserMessage） | `KAIROS` / `KAIROS_BRIEF` |
| `/bridge` / `/remote-control` / `/rc` | 远程控制桥接 | `BRIDGE_MODE` |
| `/remoteControlServer` | 远程控制服务器 | `DAEMON` + `BRIDGE_MODE` |
| `/voice` | 语音模式 | `VOICE_MODE` |
| `/ultraplan` | 云端深度规划 | `ULTRAPLAN` |
| `/fork` | 子代理分叉 | `FORK_SUBAGENT` |
| `/peers` | Unix Socket 对等通信 | `UDS_INBOX` |
| `/workflows` | 工作流脚本 | `WORKFLOW_SCRIPTS` |
| `/remote-setup` | CCR 网页远程设置 | `CCR_REMOTE_SETUP` |
| `/torch` | Torch 功能 | `TORCH` |
| `/force-snip` | 强制历史截断 | `HISTORY_SNIP` |
| `/subscribe-pr` | GitHub PR 通知订阅 | `KAIROS_GITHUB_WEBHOOKS` |
| `/teleport` | 会话远程传送 | - |

代码位置：`src/commands.ts:62-122`

### 12.2 ANT Only 内部命令（22个，`USER_TYPE=ant` 限定）

agents-platform、ant-trace、autofix-pr、backfill-sessions、break-cache、bughunter、commit、commit-push-pr、ctx-viz、good-claude、init-verifiers、issue、mock-limits、onboarding、perf-issue、reset-limits、reset-limits-noninteractive、share、subscribe-pr、summary、teleport、force-snip

代码位置：`src/commands.ts:225-254`

### 12.3 隐藏 CLI 参数

```
--proactive              启用主动自主模式（feature: PROACTIVE/KAIROS）
--brief                  启用 SendUserMessage 工具（feature: KAIROS/KAIROS_BRIEF）
--assistant              强制助手守护进程模式（隐藏帮助，feature: KAIROS）
--remote-control [name]  启动远程控制（feature: BRIDGE_MODE）
--remote "desc"          创建远程会话
--teleport [sessionId]   恢复 teleport 会话
--hard-fail              硬失败模式（feature: HARD_FAIL）
--messaging-socket-path  Unix Socket 路径（feature: UDS_INBOX）
--channels               频道通知（feature: KAIROS/KAIROS_CHANNELS）
--enable-auto-mode       启用自动模式（feature: TRANSCRIPT_CLASSIFIER）
--agent-teams            多代理团队（ANT only）
```

### 12.4 完整编译开关列表（共89个）

**核心功能开关（24个）：**

`BRIDGE_MODE`、`BUDDY`、`CHICAGO_MCP`、`COORDINATOR_MODE`、`DAEMON`、`FORK_SUBAGENT`、`HARD_FAIL`、`HISTORY_SNIP`、`KAIROS`、`KAIROS_BRIEF`、`KAIROS_CHANNELS`、`KAIROS_GITHUB_WEBHOOKS`、`LODESTONE`、`MCP_SKILLS`、`PROACTIVE`、`TORCH`、`TRANSCRIPT_CLASSIFIER`、`ULTRAPLAN`、`UDS_INBOX`、`VOICE_MODE`、`WEB_BROWSER_TOOL`、`WORKFLOW_SCRIPTS`、`CCR_AUTO_CONNECT`、`CCR_MIRROR`

**系统/优化开关（65个）：**

`ABLATION_BASELINE`、`AGENT_MEMORY_SNAPSHOT`、`AGENT_TRIGGERS`、`AGENT_TRIGGERS_REMOTE`、`ALLOW_TEST_VERSIONS`、`ANTI_DISTILLATION_CC`、`AUTO_THEME`、`AWAY_SUMMARY`、`BASH_CLASSIFIER`、`BG_SESSIONS`、`BREAK_CACHE_COMMAND`、`BUILDING_CLAUDE_APPS`、`BUILTIN_EXPLORE_PLAN_AGENTS`、`BYOC_ENVIRONMENT_RUNNER`、`CACHED_MICROCOMPACT`、`CCR_REMOTE_SETUP`、`COMMIT_ATTRIBUTION`、`COMPACTION_REMINDERS`、`CONNECTOR_TEXT`、`CONTEXT_COLLAPSE`、`COWORKER_TYPE_TELEMETRY`、`DIRECT_CONNECT`、`DOWNLOAD_USER_SETTINGS`、`DUMP_SYSTEM_PROMPT`、`ENHANCED_TELEMETRY_BETA`、`EXPERIMENTAL_SKILL_SEARCH`、`EXTRACT_MEMORIES`、`FILE_PERSISTENCE`、`HISTORY_PICKER`、`HOOK_PROMPTS`、`IS_LIBC_GLIBC`、`IS_LIBC_MUSL`、`KAIROS_DREAM`、`KAIROS_PUSH_NOTIFICATION`、`MCP_RICH_OUTPUT`、`MEMORY_SHAPE_TELEMETRY`、`MESSAGE_ACTIONS`、`MONITOR_TOOL`、`NATIVE_CLIENT_ATTESTATION`、`NATIVE_CLIPBOARD_IMAGE`、`NEW_INIT`、`OVERFLOW_TEST_TOOL`、`PERFETTO_TRACING`、`POWERSHELL_AUTO_MODE`、`PROMPT_CACHE_BREAK_DETECTION`、`QUICK_SEARCH`、`REACTIVE_COMPACT`、`REVIEW_ARTIFACT`、`RUN_SKILL_GENERATOR`、`SELF_HOSTED_RUNNER`、`SHOT_STATS`、`SKILL_IMPROVEMENT`、`SLOW_OPERATION_LOGGING`、`SSH_REMOTE`、`STREAMLINED_OUTPUT`、`TEAMMEM`、`TEMPLATES`、`TERMINAL_PANEL`、`TOKEN_BUDGET`、`TREE_SITTER_BASH`、`TREE_SITTER_BASH_SHADOW`、`ULTRATHINK`、`UNATTENDED_RETRY`、`UPLOAD_USER_SETTINGS`、`VERIFICATION_AGENT`

### 12.5 USER_TYPE 系统

| 对比项 | ANT 用户 | External 用户 |
|--------|----------|--------------|
| GrowthBook 刷新 | 20分钟 | 6小时 |
| Agent 嵌套 | 允许（AgentTool 可用） | 禁用 |
| Feature 本地覆盖 | 支持（CLAUDE_INTERNAL_FC_OVERRIDES） | 不支持 |
| 内部命令 | 22个 | 0个 |
| 权限模式 | 含 auto、bubble | 不含 |
| 调试日志 | 完整 | 无 |
| 模型覆盖 | tengu_ant_model_override | 不支持 |
| 日期覆盖 | CLAUDE_CODE_OVERRIDE_DATE | 不支持 |
| 托管设置 | CLAUDE_CODE_MANAGED_SETTINGS_PATH | 不支持 |

源码中共有 294 处 `process.env.USER_TYPE === 'ant'` 检查。

### 12.6 关键环境变量（部分精选，完整共171个）

| 环境变量 | 说明 |
|----------|------|
| `CLAUDE_CODE_ASSISTANT_MODE` | 启用 KAIROS 助手模式 |
| `CLAUDE_CODE_PROACTIVE` | 启用主动模式 |
| `CLAUDE_CODE_COORDINATOR_MODE` | 启用 Coordinator 编排模式 |
| `CLAUDE_CODE_BRIEF` | 启用 Brief 工具 |
| `CLAUDE_CODE_SIMPLE` | 简单模式（仅 Bash/Read/Edit） |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 禁用后台任务 |
| `CLAUDE_CODE_REMOTE` | 远程模式标志 |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 远程记忆目录 |
| `CLAUDE_CODE_PLAN_MODE_REQUIRED` | 强制计划模式 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子 Agent 使用的模型 |
| `CLAUDE_CODE_DISABLE_THINKING` | 禁用思考（Thinking）功能 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 最大输出 Token 数 |
| `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES` | 空闲阈值（默认75分钟） |
| `CLAUDE_CODE_EXTRA_BODY` | API 请求附加 JSON body |
| `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | 代码语法高亮主题 |
| `CLAUDE_CODE_OVERRIDE_DATE` | 覆盖系统日期（ANT only） |
| `CLAUDE_INTERNAL_FC_OVERRIDES` | GrowthBook 本地覆盖（ANT only） |
| `ALLOW_ANT_COMPUTER_USE_MCP` | Monorepo 环境下允许 Computer Use（ANT） |
| `CCR_FORCE_BUNDLE` | 强制使用 Git Bundle 传送 |

---

## 13. 代码路径索引

### 13.1 Bridge / Remote Control

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `bridgeEnabled.ts` | `1-36` | BRIDGE_MODE 构建时检查 + tengu_ccr_bridge gate |
| `bridgeEnabled.ts` | `126-130` | tengu_bridge_repl_v2 检查 |
| `bridgeEnabled.ts` | `141-148` | tengu_bridge_repl_v2_cse_shim_enabled |
| `bridgeEnabled.ts` | `160-173` | tengu_bridge_min_version（CLI 最低版本） |
| `bridgeEnabled.ts` | `185-189` | tengu_cobalt_harbor + CCR_AUTO_CONNECT |
| `bridgeEnabled.ts` | `197-202` | tengu_ccr_mirror + CCR_MIRROR |
| `bridgeMain.ts` | `96-98` | tengu_ccr_bridge_multi_session 检查 |
| `bridgeMain.ts` | `1779-1793` | KAIROS 会话恢复（--session-id / --continue） |
| `replBridge.ts` | `169` | tengu_bridge_initial_history_cap（默认200） |
| `useReplBridge.tsx` | - | tengu_bridge_system_init |
| `pollConfig.ts` | - | tengu_bridge_poll_interval_config |
| `envLessBridgeConfig.ts` | - | tengu_bridge_repl_v2_config |
| `trustedDevice.ts` | `33-36` | tengu_sessions_elevated_auth_enforcement |

### 13.2 Policy Limits

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `main.tsx` | `3411` | allow_remote_sessions 检查 |
| `RemoteTriggerTool.ts` | `60` | allow_remote_sessions 检查 |
| `initReplBridge.ts` | `155` | allow_remote_sessions + allow_remote_control 检查 |
| `print.ts` | `4991` | allow_remote_sessions 检查 |
| `cli.tsx` | `157` | allow_remote_control 检查 |
| `bridge.tsx` | `474` | allow_remote_control 检查 |
| `useMemorySurvey.tsx` | `99, 178` | allow_product_feedback 检查 |
| `useFeedbackSurvey.tsx` | `136, 237` | allow_product_feedback 检查 |
| `feedback/index.ts` | `21` | allow_product_feedback 检查 |

### 13.3 Computer Use

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| 编译时检查 | - | `feature('CHICAGO_MCP')` |
| GrowthBook | - | `getDynamicConfig_CACHED_MAY_BE_STALE('tengu_malort_pedway')` |
| 锁文件 | - | `~/.claude/computer-use.lock` |

### 13.4 GrowthBook 系统

| 文件路径 | 内容 |
|----------|------|
| `~/.claude.json` | GrowthBook 磁盘缓存（Feature Flag 持久化） |
| `~/.config/claude/policy-limits.json` | Policy Limits 本地缓存 |
| `~/.config/claude/settings.json` | 用户级权限配置 |
| `.claude/settings.json` | 本地项目级权限配置 |
| `claude.json` | 项目级配置 |

### 13.5 BUDDY 宠物伴侣系统

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/buddy/companion.ts` | 16-25 | Mulberry32 PRNG |
| `src/buddy/companion.ts` | 27-37 | Bun.hash / FNV-1a fallback |
| `src/buddy/companion.ts` | 84 | SALT 盐值定义 |
| `src/buddy/companion.ts` | 98 | Shiny 概率判断 |
| `src/buddy/types.ts` | - | 物种/稀有度/帽子常量定义 |
| `src/buddy/sprites.ts` | - | ASCII 精灵资源（514行） |
| `src/buddy/CompanionSprite.tsx` | - | React 动画组件（370行） |
| `src/commands.ts` | 118-122 | /buddy 命令注册 |

### 13.6 KAIROS 持久助手模式

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/assistant/index.ts` | - | 助手模式检测 |
| `src/services/autoDream/autoDream.ts` | - | autoDream 触发条件和子代理执行 |
| `src/services/autoDream/consolidationPrompt.ts` | - | 四阶段 Dream 提示 |
| `src/services/autoDream/consolidationLock.ts` | - | 防并发锁机制 |
| `src/memdir/paths.ts` | 246-250 | 每日日志路径生成 |
| `src/tools/BashTool/BashTool.tsx` | 57 | 15秒自动后台转换 |
| `src/main.tsx` | 3839-3848 | 隐藏 CLI 参数定义（--assistant 等） |

### 13.7 ULTRAPLAN 云端深度规划

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/commands/ultraplan.tsx` | 24 | ULTRAPLAN_TIMEOUT_MS 超时常量 |
| `src/commands/ultraplan.tsx` | 32-34 | 使用模型配置 |
| `src/commands/ultraplan.tsx` | 234-293 | launchUltraplan 主入口 |
| `src/utils/ultraplan/ccrSession.ts` | 24 | 最大连续失败次数 |
| `src/utils/ultraplan/keyword.ts` | 46-95 | 关键词自动触发检测 |
| `src/utils/teleport.tsx` | 730-795 | Teleport 传送实现 |

### 13.8 Coordinator 多 Agent 编排模式

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/coordinator/coordinatorMode.ts` | 80-109 | Worker 工具集配置 |
| `src/coordinator/coordinatorMode.ts` | 111-133 | Coordinator 三工具限制 |
| `src/coordinator/coordinatorMode.ts` | 250-259 | 禁止甩锅委派铁律（系统提示） |

### 13.9 Voice 语音功能

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/voice/voiceModeEnabled.ts` | - | OAuth + GrowthBook 权限检查 |
| `src/services/voiceStreamSTT.ts` | - | WebSocket STT 客户端（544行） |
| `src/services/voice.ts` | - | 音频捕获与录制（526行） |
| `src/services/voiceKeyterms.ts` | - | 关键词提取（106行） |
| `src/commands/voice/voice.ts` | - | /voice 命令实现 |
| `src/hooks/useVoice.ts` | - | Hold-to-Talk React Hook（1144行） |
| `src/hooks/useVoiceEnabled.ts` | - | 运行时权限 Hook |

### 13.10 隐藏命令与系统开关

| 文件路径 | 关键行号 | 内容 |
|----------|----------|------|
| `src/commands.ts` | 62-122 | Feature-Gated 命令注册 |
| `src/commands.ts` | 225-254 | ANT Only 内部命令列表 |

---

*文档生成时间：2026-04-03*
*分析来源：bridge-agent, policy-agent, growthbook-agent, computeruse-agent, buddy-agent, kairos-agent, ultraplan-agent, commands-agent, voice-agent*
