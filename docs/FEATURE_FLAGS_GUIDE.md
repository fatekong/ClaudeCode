# Claude Code 编译开关（Feature Flags）完整指南

> 本文档详细描述了 Claude Code 项目中的 50 个编译开关的功能、效果和代码实现指引。
>
> 这些编译开关通过 Bun 的 `feature()` 函数（`import { feature } from 'bun:bundle'`）在编译时进行条件判断，实现代码的按需包含/排除（Dead Code Elimination），从而控制不同构建版本的功能集。

---

## 编译开关机制概述

### 核心原理

所有编译开关均通过 `feature('FLAG_NAME')` 在编译期间决策。该函数来自 `bun:bundle`，在构建时被替换为 `true` 或 `false` 常量，使得 Bun 打包器可以将未启用的代码路径完全剔除（Tree Shaking / DCE）。

### 典型使用模式

```typescript
import { feature } from 'bun:bundle'

// 模式一：正向三元（推荐，可彻底消除字符串字面量）
return feature('BRIDGE_MODE')
  ? someFeatureLogic()
  : false

// 模式二：条件导入
const module = feature('TEAMMEM')
  ? require('./teamMemoryOps.js')
  : null

// 模式三：配置展开
...(feature('KAIROS')
  ? { assistant: z.boolean().optional() }
  : {})
```

### 双重门控

许多功能采用 **编译时 + 运行时** 双重门控：
- **编译时**：`feature()` 控制代码是否包含在构建产物中
- **运行时**：GrowthBook 远程配置控制功能是否实际生效（如灰度发布、紧急关闭等）

---

## 一、核心智能体与会话模式

### 1. BUDDY — 宠物伴侣系统

- **功能描述**: 在用户输入框旁显示一个虚拟宠物伴侣（如小动物），它会以气泡对话形式偶尔评论当前操作。当用户直接称呼宠物名字时，宠物气泡会回应。
- **实现效果**: 用户界面出现一个可配置的 sprite 动画角色，带有名字和物种属性。可通过 `companionMuted` 静音。主助手在用户与宠物互动时自动退让，不越俎代庖。
- **关键代码文件**:
  - `src/buddy/prompt.ts` — 伴侣介绍文本和附件注入
  - `src/buddy/CompanionSprite.tsx` — 伴侣 UI 渲染组件
  - `src/buddy/useBuddyNotification.tsx` — 伴侣通知 Hook
  - `src/buddy/companion.ts` — 伴侣配置管理
- **实现概要**: 伴侣在对话消息流中以 `companion_intro` 类型附件注入，告知模型伴侣的存在。`CompanionSprite.tsx` 负责 TUI 渲染动画，模型通过系统提示了解不要代替宠物回答，而是"让出空间"。

---

### 2. KAIROS — 持久助手模式

- **功能描述**: 将 Claude Code 转变为一个持久运行的助手，具有自定义系统提示、简报视图、定时签到技能等功能。这是长时间运行 agent 模式的基础设施。
- **实现效果**: 启用后可通过 `assistant: true` 配置进入助手模式，支持自定义助手名称、Brief（简报）视图、Sleep 工具节奏控制、频道通知等。模型以自主、持续运行的方式工作。
- **关键代码文件**:
  - `src/bootstrap/state.ts` — `kairosActive` 状态管理
  - `src/utils/settings/types.ts` — `assistant`, `assistantName`, `defaultView`, `minSleepDurationMs`, `maxSleepDurationMs` 配置
  - `src/constants/prompts.ts` — 自主工作系统提示 (`getProactiveSection`)
  - `src/tools/ScheduleCronTool/prompt.ts` — 定时调度与 KAIROS 的关联
  - `src/tools/ConfigTool/supportedSettings.ts` — 推送通知等配置
- **实现概要**: `kairosActive` 标志存储在全局 state 中，启用后注入自主工作的系统提示，赋予模型 Sleep 工具以控制轮询频率。支持通过 MCP 频道接收外部消息（如 Slack、GitHub）。与 PROACTIVE 联动提供完整的自主工作能力。

---

### 3. KAIROS_BRIEF — 简报模式

- **功能描述**: 提供简报/摘要视图模式，允许在完整对话记录和精简聊天记录之间切换。
- **实现效果**: 用户可通过 `defaultView` 配置选择 `chat`（仅用户消息节点）或 `transcript`（完整记录）视图。
- **关键代码文件**:
  - `src/utils/settings/types.ts` — `defaultView` 配置
  - `src/commands/brief.ts` — `/brief` 命令实现
  - `src/tools/BriefTool/BriefTool.ts` — Brief 工具
- **实现概要**: 与 KAIROS 共享 `defaultView` 配置项。在 UI 层提供两种对话渲染模式，`chat` 模式只显示 `SendUserMessage` 检查点，`transcript` 模式显示完整工具调用链。

---

### 4. KAIROS_CHANNELS — 通道通知

- **功能描述**: 允许通过 MCP 服务器声明 `claude/channel` 能力，向对话中推送入站消息（如来自 Slack、Discord、Telegram 的消息）。
- **实现效果**: 团队/企业用户可启用 `channelsEnabled` 配置，选择允许的频道插件推送消息到当前会话。支持组织级白名单管控。
- **关键代码文件**:
  - `src/services/mcp/channelNotification.ts` — 频道通知逻辑
  - `src/utils/settings/types.ts` — `channelsEnabled`, `allowedChannelPlugins` 配置
  - `src/components/LogoV2/ChannelsNotice.tsx` — UI 通知展示
- **实现概要**: 默认关闭，需要团队/企业管理员显式启用。MCP 服务器通过 `claude/channel` capability 声明推送能力，消息作为入站消息注入对话流。支持 `--channels` 命令行参数选择服务器。

---

### 5. KAIROS_GITHUB_WEBHOOKS — GitHub Webhook

- **功能描述**: 支持订阅 GitHub PR 事件（评审评论、CI 结果等），事件以用户消息形式到达对话。
- **实现效果**: 协调者模式下可使用 `subscribe_pr_activity` / `unsubscribe_pr_activity` 工具订阅 PR 活动，实时接收 GitHub 事件推送。
- **关键代码文件**:
  - `src/coordinator/coordinatorMode.ts` — 订阅工具在系统提示中的描述
  - `src/services/mcp/` — MCP 集成基础设施
- **实现概要**: 基于 MCP 协议实现 GitHub Webhook 事件推送。事件作为 user-role 消息注入对话。注意 GitHub 不会推送 `mergeable_state` 变化，需要轮询 `gh pr view` 获取合并冲突状态。

---

### 6. ULTRAPLAN — 云端深度规划

- **功能描述**: 提供云端深度规划功能，通过 CCR（Claude Code Remote）实现更高级的任务规划和执行能力。
- **实现效果**: 用户可通过 `/ultraplan` 命令触发深度规划模式，在云端进行更复杂的任务分析和规划。
- **关键代码文件**:
  - `src/commands/ultraplan.tsx` — ultraplan 命令入口
  - `src/utils/ultraplan/ccrSession.ts` — CCR 会话管理
  - `src/utils/ultraplan/prompt.txt` — 深度规划提示词
  - `src/utils/ultraplan/keyword.ts` — 关键词匹配
- **实现概要**: 利用 CCR（云端远程控制）基础设施发起深度规划会话，通过云端更大的计算资源和上下文窗口进行复杂任务分析。

---

### 7. COORDINATOR_MODE — 多 Agent 编排

- **功能描述**: 将 Claude Code 切换为"协调者"角色，专注于编排多个 Worker agent 协同完成复杂任务。协调者不直接操作文件，而是指挥 Worker 研究、实现和验证代码变更。
- **实现效果**: 启用后通过 `CLAUDE_CODE_COORDINATOR_MODE=1` 环境变量激活。协调者拥有 `AgentTool`、`SendMessageTool`、`TaskStopTool` 等编排工具，将工作分配给并行 Worker。
- **关键代码文件**:
  - `src/coordinator/coordinatorMode.ts` — 核心逻辑：`isCoordinatorMode()`, `getCoordinatorSystemPrompt()`, `getCoordinatorUserContext()`
  - `src/constants/tools.ts` — `COORDINATOR_MODE_ALLOWED_TOOLS` 工具白名单
  - `src/tools/AgentTool/AgentTool.tsx` — Worker 派发工具
  - `src/tools/SendMessageTool/SendMessageTool.ts` — Worker 通信工具
- **实现概要**: 通过替换系统提示为专用协调者提示，限制工具集为编排工具。工作流分为 Research → Synthesis → Implementation → Verification 四阶段。Worker 结果通过 `<task-notification>` XML 返回。支持会话恢复时自动匹配模式。

---

### 8. BRIDGE_MODE — 远程控制桥接

- **功能描述**: 提供 Remote Control 功能，允许通过 claude.ai 桌面应用或移动端远程控制本地 CLI 实例。
- **实现效果**: 需要 claude.ai 订阅（OAuth 认证）。支持双向通信（标准桥接）和单向镜像模式。启动时可自动连接或按需连接。有最低版本要求检查。
- **关键代码文件**:
  - `src/bridge/bridgeEnabled.ts` — `isBridgeEnabled()`, `getBridgeDisabledReason()`, 版本检查等
  - `src/bridge/bridgeMain.ts` — 桥接主逻辑
  - `src/bridge/initReplBridge.ts` — REPL 桥接初始化
  - `src/bridge/types.ts` — 桥接类型定义
  - `src/hooks/useReplBridge.tsx` — React Hook 集成
  - `src/commands/bridge/bridge.tsx` — `/bridge` 命令
- **实现概要**: 通过 GrowthBook `tengu_ccr_bridge` 门控灰度。桥接连接到 CCR（Claude Code Remote）服务器，实现会话同步。v2 使用无环境变量的 REPL 桥接。包含 CSE shim 兼容层处理 session ID 格式差异。支持推送通知到移动设备。

---

### 9. VOICE_MODE — 语音交互

- **功能描述**: 支持按住说话（hold-to-talk）的语音输入功能，将语音转为文字发送给 Claude。
- **实现效果**: 需要 Anthropic OAuth 认证（使用 claude.ai 的 `voice_stream` 端点）。通过 GrowthBook `tengu_amber_quartz_disabled` 作为紧急关闭开关。
- **关键代码文件**:
  - `src/voice/voiceModeEnabled.ts` — `isVoiceModeEnabled()`, `isVoiceGrowthBookEnabled()`, `hasVoiceAuth()`
  - `src/utils/settings/types.ts` — `voiceEnabled` 配置项
  - `src/tools/ConfigTool/supportedSettings.ts` — 语音设置
- **实现概要**: 需要同时满足 OAuth 认证和 GrowthBook 门控。语音流通过 claude.ai 基础设施处理，不支持 API Key、Bedrock、Vertex 或 Foundry。`useVoiceEnabled()` Hook 在 React 渲染路径中缓存认证结果。

---

### 10. PROACTIVE — 主动自主模式

- **功能描述**: 让 Claude Code 以自主运行模式工作，定期接收 `<tick>` 心跳提示保持活跃，主动寻找有价值的工作执行。
- **实现效果**: 模型收到定期 tick 后自主决定下一步行动。支持根据终端焦点状态（focused/unfocused）调节自主程度。使用 Sleep 工具控制轮询频率和成本。
- **关键代码文件**:
  - `src/constants/prompts.ts` — `getProactiveSection()` 自主工作系统提示
  - `src/utils/settings/types.ts` — `minSleepDurationMs`, `maxSleepDurationMs`
- **实现概要**: 与 KAIROS 共享基础设施。`<tick>` 消息包含用户当前本地时间。首次唤醒时简短问候并等待指示，后续自主探索代码、运行测试、提交代码。终端失焦时更自主，聚焦时更协作。通过 Sleep 工具在活跃度和 API 成本之间平衡（提示缓存 5 分钟过期）。

---

## 二、Agent 基础设施

### 11. FORK_SUBAGENT — 子代理分叉

- **功能描述**: 支持通过 `runForkedAgent` 模式创建"分叉"子代理，共享父对话的提示缓存但独立运行。
- **实现效果**: 分叉代理从当前对话状态创建完美副本，可执行后台任务（如记忆提取、置信度评估）而不影响主对话流。
- **关键代码文件**:
  - `src/utils/forkedAgent.ts` — `runForkedAgent()`, `createCacheSafeParams()`
  - `src/services/extractMemories/extractMemories.ts` — 使用分叉代理提取记忆
- **实现概要**: 分叉代理复用父对话的消息历史以利用提示缓存，但拥有独立的工具集和执行上下文。常用于后台分析任务，如在每次查询循环结束时提取持久记忆。

---

### 12. DAEMON — 守护进程模式

- **功能描述**: 支持以守护进程形式在后台运行 Claude Code，无需用户直接交互。
- **实现效果**: 守护进程可在后台持续运行，处理定时任务或监听事件。与 `BG_SESSIONS` 配合使用。
- **关键代码文件**:
  - `src/utils/concurrentSessions.ts` — `SessionKind` 类型包含 `daemon` 和 `daemon-worker`
  - `src/services/analytics/metadata.ts` — 守护进程会话追踪
- **实现概要**: 通过 `CLAUDE_CODE_SESSION_KIND=daemon` 环境变量标识守护进程会话。守护进程不拥有终端 UI，通过文件系统和信号机制与主进程通信。支持 supervisor 模式管理多个 worker。

---

### 13. UDS_INBOX — Unix Socket 收件箱

- **功能描述**: 使用 Unix Domain Socket 实现进程间通信的收件箱机制，用于 agent 间消息传递。
- **实现效果**: 提供比文件系统轮询更高效的 agent 间通信通道。
- **关键代码文件**:
  - `src/utils/teammateMailbox.ts` — 邮箱基础设施
  - `src/utils/swarm/` — agent 集群通信
- **实现概要**: Unix Domain Socket 提供低延迟的本地 IPC 机制，替代基于文件系统的轮询方式。适用于同一机器上的多 agent 通信场景。

---

### 14. WORKFLOW_SCRIPTS — 工作流脚本

- **功能描述**: 支持定义和执行工作流脚本，实现复杂的自动化操作序列。
- **实现效果**: 用户可以编写脚本来编排多步骤的 Claude Code 操作。
- **关键代码文件**:
  - `src/utils/processUserInput/processUserInput.ts` — 输入处理中的工作流支持
  - `src/utils/processUserInput/processSlashCommand.tsx` — 斜杠命令处理
- **实现概要**: 工作流脚本允许将多个操作步骤串联成可复用的自动化流程。

---

## 三、Shell 与安全

### 15. TORCH — Torch 功能

- **功能描述**: 提供 Torch 相关的高级功能支持。
- **实现效果**: 具体功能与内部 ML/AI 工具链集成相关。
- **关键代码文件**:
  - `src/tools.ts` — 工具注册中的 TORCH 门控
- **实现概要**: 通过 `feature('TORCH')` 条件性注册相关工具和功能。

---

### 16. MONITOR_TOOL — 监控工具

- **功能描述**: 提供系统监控能力，允许 Claude 监测和报告系统状态。
- **实现效果**: 添加一个监控工具到 Claude 的工具集中，用于检查进程、资源使用等。
- **关键代码文件**:
  - `src/tools.ts` — 工具注册
- **实现概要**: 条件性注册监控工具，提供对系统资源、进程状态等的可观测能力。

---

### 17. HISTORY_SNIP — 历史截断

- **功能描述**: 支持对对话历史进行选择性截断（Snip），移除不再需要的中间步骤以释放上下文窗口空间。
- **实现效果**: 提供 Snip 工具，允许模型在对话过长时主动截断不必要的历史消息，保持上下文在有效限制内。
- **关键代码文件**:
  - `src/tools/SnipTool/prompt.ts` — `SNIP_TOOL_NAME`
  - `src/utils/collapseReadSearch.ts` — Snip 工具名称的条件导入
  - `src/utils/messages.ts` — 消息操作中的截断支持
- **实现概要**: Snip 工具注册为可选工具。模型可在上下文接近上限时调用该工具，标记特定消息区间为"已截断"。截断后的消息在后续请求中不再发送给 API，有效释放上下文空间。

---

### 18. ANTI_DISTILLATION_CC — 反蒸馏保护

- **功能描述**: 防止通过 Claude Code 的输出对模型进行知识蒸馏（distillation），保护模型知识产权。
- **实现效果**: 在交互中注入反蒸馏机制，防止批量提取模型能力。
- **关键代码文件**:
  - `src/constants/prompts.ts` — 系统提示中的反蒸馏部分
- **实现概要**: 通过在系统提示和响应管道中注入防蒸馏指令和检测机制。主要面向内部部署场景的安全需求。

---

### 19. BASH_CLASSIFIER — Bash 命令分类器

- **功能描述**: 使用 AI 分类器对 Bash 命令进行安全评估，自动批准安全命令而无需用户确认，拦截危险命令要求确认。
- **实现效果**: 当用户配置了 `Bash(prompt:...)` 权限规则时，分类器根据规则自动判断命令安全性。批准的命令会记录匹配的规则名，在 UI 中显示"由分类器批准"。
- **关键代码文件**:
  - `src/utils/classifierApprovals.ts` — `setClassifierApproval()`, `getClassifierApproval()` 记录分类决策
  - `src/utils/bash/parser.ts` — Bash 命令解析
  - `src/utils/permissions/classifierDecision.ts` — 分类器决策逻辑
  - `src/utils/permissions/permissionRuleParser.ts` — 权限规则解析
- **实现概要**: 分类器维护一个 `CLASSIFIER_APPROVALS` Map（toolUseID → 决策信息）。每次 Bash 工具调用时，分类器评估命令是否匹配用户定义的安全规则。批准决策存储为 `{ classifier: 'bash', matchedRule }` 格式。UI 组件从 Map 中读取显示批准原因。

---

### 20. BG_SESSIONS — 后台会话

- **功能描述**: 支持通过 `claude --bg` 在 tmux 中启动后台会话，会话在终端断开后继续运行。
- **实现效果**: 后台会话的退出操作（`/exit`、`ctrl+c`、`ctrl+d`）会分离客户端而非终止进程。支持 `bg`、`daemon`、`daemon-worker` 三种会话类型。
- **关键代码文件**:
  - `src/utils/concurrentSessions.ts` — `isBgSession()`, `envSessionKind()`, `SessionKind` 类型
  - `src/utils/backgroundHousekeeping.ts` — 后台维护任务
- **实现概要**: 通过 `CLAUDE_CODE_SESSION_KIND` 环境变量由父进程/守护进程设置会话类型。`isBgSession()` 返回 true 时，退出命令执行 tmux detach 而非 process exit。后台会话注册后可在并发会话管理中被追踪。

---

## 四、压缩与上下文管理

### 21. CACHED_MICROCOMPACT — 缓存微压缩

- **功能描述**: 对工具结果进行基于缓存的微压缩（Micro Compact），在保持提示缓存命中的前提下减少 token 使用量。
- **实现效果**: 仅对特定工具（FileRead、Bash、Grep、Glob、WebSearch、WebFetch、FileEdit、FileWrite）的结果进行压缩。通过时间窗口策略管理压缩时机。（仅内部用户）
- **关键代码文件**:
  - `src/services/compact/microCompact.ts` — 微压缩核心逻辑，`COMPACTABLE_TOOLS` 列表
  - `src/services/compact/cachedMicrocompact.ts` — 缓存微压缩模块
  - `src/services/compact/timeBasedMCConfig.ts` — 时间窗口配置
  - `src/services/compact/compactWarningState.ts` — 压缩警告状态
- **实现概要**: 懒加载 `cachedMicrocompact` 模块以避免在外部构建中引入。缓存微压缩跟踪 `CachedMCState` 和 `CacheEditsBlock` 状态。对超出 token 估算阈值的工具结果内容进行就地替换为 `[Old tool result content cleared]`，同时通知提示缓存中断检测系统。

---

### 22. CCR_REMOTE_SETUP — Web 远程设置

- **功能描述**: 支持通过 Web 端完成 Claude Code 的远程配置和初始化。
- **实现效果**: 允许在无本地终端的情况下完成初始设置流程。
- **关键代码文件**:
  - `src/commands/terminalSetup/terminalSetup.tsx` — 终端设置中的远程配置
- **实现概要**: 面向 CCR（Cloud Code Remote）场景，提供 Web UI 驱动的设置向导。

---

### 23. CHICAGO_MCP — MCP 扩展（Computer Use）

- **功能描述**: 扩展 MCP（Model Context Protocol）以支持 Computer Use 功能，允许 Claude 操作计算机界面（鼠标、键盘、屏幕截图等）。
- **实现效果**: 启用后可通过 MCP 服务器提供的 Computer Use 工具进行 GUI 自动化操作。
- **关键代码文件**:
  - `src/services/mcp/client.ts` — MCP 客户端中的 Computer Use 支持
  - `src/services/mcp/config.ts` — MCP 配置
- **实现概要**: 通过 MCP 协议集成 Computer Use 能力。命名 "CHICAGO" 是内部代号。

---

### 24. COMMIT_ATTRIBUTION — 提交归属标注

- **功能描述**: 为 Claude Code 生成的 git commit 和 PR 自动添加归属信息（如 `Co-authored-by` 标注或自定义归属文本）。
- **实现效果**: 提交信息和 PR 描述中自动包含模型名称、会话 URL 等归属信息。支持自定义归属模板和远程模式下的会话链接。
- **关键代码文件**:
  - `src/utils/attribution.ts` — `AttributionTexts` 类型，归属文本生成
  - `src/utils/commitAttribution.ts` — `calculateCommitAttribution()`, 内部仓库检测
- **实现概要**: 根据用户设置的 `attribution.commit` 和 `attribution.pr` 模板生成归属文本。动态获取模型名称（`getPublicModelName()`）。远程模式下返回会话 URL。兼容已废弃的 `includeCoAuthoredBy` 设置。区分内部模型仓库进行特殊处理。

---

### 25. CONNECTOR_TEXT — 连接器文本

- **功能描述**: 启用 API 的"连接器文本摘要"Beta 功能，允许模型接收和处理通过连接器（如文档检索系统）提供的文本。
- **实现效果**: 在 API 请求中添加 `summarize-connector-text-2026-03-13` Beta 头，让模型能更好地处理连接器注入的长文本。
- **关键代码文件**:
  - `src/constants/betas.ts` — `SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER` 常量
  - `src/utils/betas.ts` — Beta 头管理
- **实现概要**: 当 `feature('CONNECTOR_TEXT')` 为 true 时，Beta 头字符串被设置为实际值；否则为空字符串，实现编译时剔除。

---

### 26. CONTEXT_COLLAPSE — 上下文折叠

- **功能描述**: 对连续的只读操作（搜索、读取文件等）进行 UI 折叠，减少对话视图中的视觉噪声。
- **实现效果**: 连续的文件读取和搜索操作在 UI 中被合并为一个可展开/折叠的组。
- **关键代码文件**:
  - `src/utils/collapseReadSearch.ts` — `SearchOrReadResult`, `CollapsedReadSearchGroup` 逻辑
  - `src/types/message.ts` — `CollapsedReadSearchGroup`, `CollapsibleMessage`, `RenderableMessage` 类型
- **实现概要**: 检查每个工具调用是否属于"可折叠"类型（搜索/读取操作），将连续的可折叠操作合并为 `CollapsedReadSearchGroup`。在渲染时以折叠组形式展示，用户可展开查看详情。支持 git 操作追踪（分支/提交/PR）。

---

### 27. COWORKER_TYPE_TELEMETRY — 协作者遥测

- **功能描述**: 收集关于 IDE 协作者类型的遥测数据，帮助分析 Claude Code 在不同 IDE 环境中的使用情况。
- **实现效果**: 在遥测事件中附加 IDE/协作者类型信息。
- **关键代码文件**:
  - `src/services/analytics/metadata.ts` — 遥测元数据收集
- **实现概要**: 在分析事件中记录用户使用的 IDE 类型（VS Code、JetBrains 等），用于产品决策和优化。

---

### 28. DOWNLOAD_USER_SETTINGS — 下载用户设置

- **功能描述**: 从云端下载用户设置到本地（CCR 场景使用），确保远程环境与本地配置同步。
- **实现效果**: CCR 环境启动时自动从远端拉取用户设置和记忆文件。
- **关键代码文件**:
  - `src/services/settingsSync/index.ts` — 设置同步服务，包含下载逻辑
  - `src/services/settingsSync/types.ts` — `SYNC_KEYS`, `UserSyncDataSchema`
- **实现概要**: 设置同步服务使用 axios 通过 OAuth 认证与 Anthropic API 通信。CCR 模式下在插件安装前下载远端设置。支持增量同步（仅同步变更项）。每个文件最大 500KB，超时 10 秒，最多 3 次重试。

---

### 29. EXPERIMENTAL_SKILL_SEARCH — 实验性技能搜索

- **功能描述**: 提供实验性的技能搜索功能，允许发现和安装扩展 Claude Code 能力的技能包。
- **实现效果**: 增强技能发现机制，支持更智能的技能匹配和推荐。
- **关键代码文件**:
  - `src/skills/bundled/index.ts` — 内置技能管理
  - `src/utils/hooks/skillImprovement.ts` — 技能改进
- **实现概要**: 在现有技能系统基础上增加搜索能力，使用语义匹配而非简单的名称匹配来发现相关技能。

---

### 30. EXTRACT_MEMORIES — 自动提取记忆

- **功能描述**: 在每次完整查询循环结束后，自动从对话记录中提取持久记忆并写入自动记忆目录（`~/.claude/projects/<path>/memory/`）。
- **实现效果**: Claude 自动学习和记住项目相关的重要信息，无需用户手动指示"记住这个"。记忆在后续会话中可被读取。
- **关键代码文件**:
  - `src/services/extractMemories/extractMemories.ts` — 核心记忆提取逻辑，使用 `runForkedAgent`
  - `src/services/extractMemories/prompts.ts` — 记忆提取的提示词
  - `src/memdir/paths.ts` — `getAutoMemPath()`, `isAutoMemoryEnabled()`, `isAutoMemPath()`
  - `src/memdir/memoryScan.ts` — 记忆文件扫描
- **实现概要**: 使用分叉代理（`runForkedAgent`）在每次查询完成时运行。分叉代理复用父对话的提示缓存。记忆提取器分析对话内容，识别值得持久化的项目知识（如架构决策、代码约定），写入 markdown 文件。通过 `initExtractMemories()` 在后台初始化，闭包隔离状态以支持测试。

---

## 五、性能与优化

### 31. FILE_PERSISTENCE — 文件持久化

- **功能描述**: 在每个对话回合结束时将修改的文件上传到 Files API，实现 BYOC（自带环境）场景下的文件持久化。
- **实现效果**: BYOC 模式下自动将输出目录中的修改文件上传到远端存储。
- **关键代码文件**:
  - `src/utils/filePersistence/filePersistence.ts` — `runFilePersistence()` 编排逻辑
  - `src/utils/filePersistence/outputsScanner.ts` — `findModifiedFiles()`, `getEnvironmentKind()`
  - `src/utils/filePersistence/types.ts` — `FilesPersistedEventData`, 配置常量
  - `src/services/api/filesApi.ts` — `uploadSessionFiles()` API 调用
- **实现概要**: 区分 BYOC 和 1P/Cloud 两种环境。BYOC 模式下主动上传到 Files API；1P/Cloud 模式下通过 rclone 同步，查询 listDirectory 获取文件 ID。支持并发上传（默认并发度），文件数量限制，中止信号。

---

### 32. HARD_FAIL — 硬失败模式

- **功能描述**: 启用硬失败模式，在遇到错误时立即终止而非尝试恢复或降级。
- **实现效果**: 适用于 CI/CD 和自动化场景，错误不被静默处理。
- **关键代码文件**:
  - `src/utils/errors.ts` — 错误处理逻辑
- **实现概要**: 在关键错误路径中检查硬失败标志，遇到错误时抛出异常终止执行而非回退到降级路径。

---

### 33. LODESTONE — Lodestone 功能

- **功能描述**: 管理 `claude-cli://` 协议处理器的 OS 注册，允许通过自定义 URL scheme 启动 Claude Code。
- **实现效果**: 用户可以从浏览器或其他应用通过 `claude-cli://` 链接直接打开 Claude Code 并执行操作。可通过 `disableDeepLinkRegistration` 设置禁用。
- **关键代码文件**:
  - `src/utils/settings/types.ts` — `disableDeepLinkRegistration` 配置
  - `src/utils/nativeInstaller/download.ts` — 协议注册
  - `src/utils/backgroundHousekeeping.ts` — 启动时执行 `ensureDeepLinkProtocolRegistered()`
- **实现概要**: 在交互式会话启动时，通过平台原生机制（macOS 的 `LSSetDefaultHandlerForURLScheme` 等）注册 `claude-cli://` 协议。仅在交互式模式下注册。支持通过设置禁用以适应企业环境。

---

### 34. MCP_SKILLS — MCP 技能系统

- **功能描述**: 通过 MCP 协议扩展技能系统，允许 MCP 服务器提供可发现和可调用的技能。
- **实现效果**: MCP 服务器可以声明技能能力，Claude 在需要时自动发现和使用这些技能。
- **关键代码文件**:
  - `src/services/mcp/client.ts` — MCP 技能客户端
  - `src/services/mcp/useManageMCPConnections.ts` — MCP 连接管理
  - `src/skills/bundled/index.ts` — 技能注册
- **实现概要**: 在 MCP 客户端中增加技能发现协议支持。MCP 服务器通过 capability 声明暴露技能接口，Claude 通过 ToolSearch 或直接调用来使用这些技能。

---

### 35. MEMORY_SHAPE_TELEMETRY — 记忆形状遥测

- **功能描述**: 收集记忆文件结构和使用模式的遥测数据，帮助优化记忆系统设计。
- **实现效果**: 在遥测事件中附加记忆文件的形状（数量、大小、层级）信息。
- **关键代码文件**:
  - `src/services/analytics/metadata.ts` — 遥测元数据
  - `src/memdir/memdir.ts` — 记忆目录管理
- **实现概要**: 定期扫描记忆目录结构，收集文件数量、大小分布、目录深度等统计数据，通过遥测系统上报用于分析和优化。

---

### 36. MESSAGE_ACTIONS — 消息操作

- **功能描述**: 为对话中的消息提供可操作的按钮/动作（如复制、重试、编辑等）。
- **实现效果**: 消息气泡上显示操作按钮，用户可直接操作消息内容。
- **关键代码文件**:
  - `src/components/Messages.tsx` — 消息渲染组件
  - `src/types/textInputTypes.ts` — 文本输入类型
- **实现概要**: 在消息渲染层添加交互式操作组件，支持针对特定消息的快捷操作。

---

### 37. NATIVE_CLIENT_ATTESTATION — 客户端证明

- **功能描述**: 实现客户端证明机制，验证 Claude Code 客户端的真实性，防止伪造客户端滥用 API。
- **实现效果**: 在 API 请求中附加客户端证明信息，服务端可验证请求来自合法客户端。
- **关键代码文件**:
  - `src/utils/nativeInstaller/download.ts` — 证明信息生成
- **实现概要**: 利用平台原生机制（如 macOS 的代码签名验证）生成客户端证明令牌，附加到 API 请求头中。服务端验证令牌合法性后才处理请求。

---

### 38. PROMPT_CACHE_BREAK_DETECTION — 缓存中断检测

- **功能描述**: 检测导致提示缓存（Prompt Cache）失效的操作，并在发生时发出通知，帮助优化缓存利用率。
- **实现效果**: 当微压缩、手动压缩等操作导致缓存断裂时，系统记录事件并可采取补偿措施。
- **关键代码文件**:
  - `src/services/api/promptCacheBreakDetection.ts` — `notifyCacheDeletion()`, `notifyCompaction()`
  - `src/services/compact/microCompact.ts` — 微压缩时通知缓存中断
- **实现概要**: 维护缓存状态追踪器。当消息被删除、压缩或工具结果被清除时，调用 `notifyCacheDeletion()` 记录缓存断裂事件。这些数据用于遥测分析和优化压缩策略，减少不必要的缓存失效。

---

### 39. QUICK_SEARCH — 快速搜索

- **功能描述**: 提供快速搜索功能，优化代码库搜索的响应速度。
- **实现效果**: 通过轻量级搜索路径加速常见搜索场景。
- **关键代码文件**:
  - `src/tools/ToolSearchTool/ToolSearchTool.ts` — 工具搜索优化
  - `src/tools/AgentTool/built-in/exploreAgent.ts` — Explore agent 的快速搜索模式
- **实现概要**: 在现有搜索基础设施上增加快速路径，对简单查询跳过完整的语义分析流程。Explore agent 支持 `quick`/`medium`/`very thorough` 三档搜索深度。

---

### 40. REACTIVE_COMPACT — 响应式压缩

- **功能描述**: 根据上下文使用情况自动触发对话压缩，而非等到上下文窗口接近满载才被动压缩。
- **实现效果**: 更智能地管理上下文窗口空间，在合适的时机主动压缩以保持对话效率。
- **关键代码文件**:
  - `src/services/compact/autoCompact.ts` — 自动压缩逻辑
  - `src/services/compact/compact.ts` — 压缩核心
  - `src/services/compact/prompt.ts` — 压缩提示词
- **实现概要**: 监控上下文使用量变化趋势。当检测到上下文增长可能影响性能时，主动触发压缩而非等待硬限制。与微压缩配合形成多层压缩策略。

---

## 六、开发者体验

### 41. SLOW_OPERATION_LOGGING — 慢操作日志

- **功能描述**: 记录执行时间较长的操作，帮助识别性能瓶颈。
- **实现效果**: 超过阈值的操作会被记录到日志中，包含操作类型和耗时。
- **关键代码文件**:
  - `src/utils/slowOperations.ts` — `jsonStringify()` 等慢操作包装
  - `src/services/analytics/metadata.ts` — 性能遥测
- **实现概要**: 对 JSON 序列化等已知慢操作进行包装，超时时记录警告。使用性能计时器测量关键路径耗时。

---

### 42. STREAMLINED_OUTPUT — 精简输出

- **功能描述**: 提供精简的输出模式，减少冗余的中间过程输出。
- **实现效果**: 输出更加简洁，聚焦于关键信息和最终结果。
- **关键代码文件**:
  - `src/cli/print.ts` — CLI 输出逻辑
  - `src/cli/structuredIO.ts` — 结构化 IO
- **实现概要**: 在输出管道中过滤中间步骤信息，只展示对用户有价值的最终结果和关键状态变更。

---

### 43. TEAMMEM — 团队记忆同步

- **功能描述**: 在团队成员之间同步共享记忆文件，确保团队对项目的共同理解保持一致。
- **实现效果**: 团队记忆目录中的文件自动在成员间同步。支持 push/pull 双向同步，使用文件监视器检测本地变更后自动推送。
- **关键代码文件**:
  - `src/services/teamMemorySync/watcher.ts` — 文件监视器，`DEBOUNCE_MS=2000`
  - `src/services/teamMemorySync/index.ts` — `pullTeamMemory()`, `pushTeamMemory()`
  - `src/services/teamMemorySync/teamMemSecretGuard.ts` — 敏感信息过滤
  - `src/memdir/teamMemPaths.ts` — `getTeamMemPath()`, `isTeamMemoryEnabled()`
  - `src/utils/collapseReadSearch.ts` — UI 中团队记忆操作的检测
- **实现概要**: 使用 `fs.watch` 监视团队记忆目录。变更后 2 秒防抖延迟然后推送。首次启动执行 pull。推送失败的永久性错误（如 no_oauth、404、413）会抑制后续推送避免无限重试循环。包含 secret guard 过滤敏感信息。

---

### 44. TEMPLATES — 模板/分类器

- **功能描述**: 提供对话模板和输入分类器功能，帮助引导常见工作流。
- **实现效果**: 根据用户输入自动识别意图并推荐合适的模板或工作流。
- **关键代码文件**:
  - `src/utils/classifierApprovals.ts` — 分类器审批
  - `src/utils/permissions/permissionRuleParser.ts` — 规则解析
- **实现概要**: 输入分类器分析用户意图，匹配预定义模板。模板包含预配置的系统提示和工具集。

---

### 45. TERMINAL_PANEL — 终端面板

- **功能描述**: 提供内置终端面板，通过 `Meta+J` 快捷键切换，允许用户在不离开 Claude Code 的情况下执行终端命令。
- **实现效果**: 基于 tmux 实现 Shell 持久化。每个 Claude Code 实例有独立的面板（使用会话 ID 隔离的 tmux socket）。在 tmux 中按 `Meta+J` 返回 Claude Code，Shell 继续后台运行。
- **关键代码文件**:
  - `src/utils/terminalPanel.ts` — `TerminalPanel` 类，`getTerminalPanelSocket()`
  - `src/keybindings/defaultBindings.ts` — `Meta+J` 快捷键绑定
- **实现概要**: 使用 Ink 的 `enterAlternateScreen`/`exitAlternateScreen` 切换到备用屏幕。优先使用 tmux（检查 `tmux -V`），不可用时回退到非持久化的 `spawnSync` 直接运行 shell。tmux 会话在 Claude Code 退出时通过 cleanup 注册自动销毁。

---

### 46. TOKEN_BUDGET — Token 预算

- **功能描述**: 为单个对话回合设置 token 使用预算，模型在预算内自动继续执行，接近或超出预算时停止。
- **实现效果**: 支持通过 API 的 `task_budget` 参数告知模型预算信息。追踪连续执行计数和递减收益检测。
- **关键代码文件**:
  - `src/query/tokenBudget.ts` — `checkTokenBudget()`, `createBudgetTracker()`, `BudgetTracker`
  - `src/utils/tokenBudget.ts` — `getBudgetContinuationMessage()`
  - `src/services/api/claude.ts` — `configureTaskBudgetParams()` API 参数配置
  - `src/constants/betas.ts` — `TASK_BUDGETS_BETA_HEADER`
  - `src/utils/attachments.ts` — `getMaxBudgetUsdAttachment()` USD 预算
- **实现概要**: `BudgetTracker` 跟踪连续执行次数和 token 增量。预算低于 90% 时自动继续并注入鼓励消息。检测"递减收益"（连续 3 次且增量 <500 token），此时提前停止避免浪费。API 参数 `task_budget: { type: 'tokens', total, remaining }` 通过 `task-budgets-2026-03-13` Beta 头启用。

---

### 47. TRANSCRIPT_CLASSIFIER — 转录分类器

- **功能描述**: 实现"自动模式"（Auto Mode）的 AI 分类器，根据对话上下文自动判断工具调用是否需要用户确认。这是 Claude Code 权限系统的核心升级。
- **实现效果**: 用户可选择进入 Auto Mode，AI 分类器根据 allow/soft_deny/environment 规则自动批准安全操作，拦截危险操作。支持 `shift+tab` 在模式间切换。
- **关键代码文件**:
  - `src/utils/permissions/autoModeState.ts` — Auto Mode 状态管理，电路断路器
  - `src/utils/permissions/permissionSetup.ts` — `isAutoModeGateEnabled()`, `hasAutoModeOptIn()`, `shouldPlanUseAutoMode()`
  - `src/utils/permissions/yoloClassifier.ts` — 分类器实现
  - `src/utils/classifierApprovals.ts` — `setYoloClassifierApproval()` 记录自动批准
  - `src/cli/handlers/autoMode.ts` — `auto-mode defaults`, `auto-mode critique` CLI 命令
  - `src/utils/settings/types.ts` — `autoMode` 配置（allow/soft_deny/environment 规则）
  - `src/constants/betas.ts` — `AFK_MODE_BETA_HEADER`（`afk-mode-2026-01-31`）
- **实现概要**: 用户通过 CLI flag、设置或 shift+tab 切换进入 Auto Mode。分类器读取用户自定义规则（与默认规则合并），对每个工具调用进行安全评估。支持电路断路器机制（GrowthBook 可远程禁用）。Plan Mode 可选择使用 Auto Mode 语义。`auto-mode critique` 命令使用 AI 审查用户规则的质量。

---

### 48. UNATTENDED_RETRY — 无人值守重试

- **功能描述**: 为无人值守会话（如 CI/CD、守护进程）提供无限重试 429/529 错误的能力，使用更高的退避时间和定期心跳保持会话活跃。
- **实现效果**: 设置 `CLAUDE_CODE_UNATTENDED_RETRY=1` 后，429（限速）和 529（过载）错误不会终止会话，而是无限重试直到成功。
- **关键代码文件**:
  - `src/services/api/withRetry.ts` — `isPersistentRetryEnabled()`, `PERSISTENT_MAX_BACKOFF_MS=300s`, `PERSISTENT_RESET_CAP_MS=6h`, `HEARTBEAT_INTERVAL_MS=30s`
- **实现概要**: 在重试循环中，当 `isPersistentRetryEnabled()` 为 true 时，`attempt` 计数器不递增，实现无限重试。429 错误尊重 `Retry-After` 头或使用指数退避（最大 5 分钟），窗口限制时等待重置时间（最长 6 小时）。每 30 秒发送 `SystemAPIErrorMessage` 心跳防止宿主环境判定空闲。

---

### 49. UPLOAD_USER_SETTINGS — 上传用户设置

- **功能描述**: 在交互式 CLI 会话中将本地设置增量上传到云端，供远程环境（CCR）同步。
- **实现效果**: 本地设置变更自动在后台上传。仅上传实际变更的条目（增量同步）。
- **关键代码文件**:
  - `src/services/settingsSync/index.ts` — `uploadUserSettingsInBackground()`
  - `src/services/settingsSync/types.ts` — `SYNC_KEYS`, `SettingsSyncUploadResult`
- **实现概要**: 在 `main.tsx` 的 `preAction` 中以后台任务形式启动上传。使用 `pickBy` 仅选择变更的设置项。通过 OAuth 认证调用 Anthropic API。有 10 秒超时和最多 3 次重试保护。每个文件不超过 500KB。

---

### 50. BREAK_CACHE_COMMAND — 缓存清除注入

- **功能描述**: 提供强制清除提示缓存的命令或机制，用于调试和测试场景。
- **实现效果**: 允许手动触发缓存失效，验证缓存相关功能的正确性。
- **关键代码文件**:
  - `src/commands/clear/caches.ts` — 缓存清除命令
  - `src/services/api/promptCacheBreakDetection.ts` — 缓存中断通知
- **实现概要**: 注入一个可打断缓存的占位内容或通过命令手动触发缓存重建。主要用于开发调试场景，确保缓存失效后的系统行为正确。

---

## 附录：开关分类速查表

| 类别 | 开关 |
|------|------|
| **核心模式** | KAIROS, KAIROS_BRIEF, PROACTIVE, COORDINATOR_MODE, BRIDGE_MODE, VOICE_MODE, DAEMON |
| **Agent 基础设施** | FORK_SUBAGENT, UDS_INBOX, BG_SESSIONS, WORKFLOW_SCRIPTS |
| **安全与权限** | BASH_CLASSIFIER, TRANSCRIPT_CLASSIFIER, ANTI_DISTILLATION_CC, NATIVE_CLIENT_ATTESTATION |
| **压缩与上下文** | CACHED_MICROCOMPACT, CONTEXT_COLLAPSE, HISTORY_SNIP, REACTIVE_COMPACT, PROMPT_CACHE_BREAK_DETECTION, BREAK_CACHE_COMMAND |
| **记忆系统** | EXTRACT_MEMORIES, TEAMMEM, MEMORY_SHAPE_TELEMETRY |
| **通信与频道** | KAIROS_CHANNELS, KAIROS_GITHUB_WEBHOOKS, CONNECTOR_TEXT |
| **云端功能** | ULTRAPLAN, CCR_REMOTE_SETUP, FILE_PERSISTENCE, DOWNLOAD_USER_SETTINGS, UPLOAD_USER_SETTINGS |
| **开发者体验** | BUDDY, TERMINAL_PANEL, MESSAGE_ACTIONS, STREAMLINED_OUTPUT, TEMPLATES |
| **性能优化** | TOKEN_BUDGET, QUICK_SEARCH, SLOW_OPERATION_LOGGING, HARD_FAIL |
| **MCP 扩展** | CHICAGO_MCP, MCP_SKILLS, EXPERIMENTAL_SKILL_SEARCH |
| **遥测与分析** | COWORKER_TYPE_TELEMETRY, COMMIT_ATTRIBUTION |
| **平台集成** | LODESTONE, TORCH, MONITOR_TOOL, UNATTENDED_RETRY |

---

> 📝 **注意**: 本文档基于源码静态分析生成。部分仅在内部构建（`USER_TYPE === 'ant'`）中启用的功能在外部版本中不可见。GrowthBook 远程配置可能随时变更功能的实际可用性。
