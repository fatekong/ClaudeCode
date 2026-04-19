# Bridge / Remote Control 功能 文档

**版本**: 1.0  
**基于源码分析**: ClaudeCode 项目  
**分析日期**: 2026-04-03  

---

## 目录

1. [概述](#概述)
2. [架构图](#架构图)
3. [六层开启条件](#六层开启条件)
4. [CCR v1 vs CCR v2 对比](#ccr-v1-vs-ccr-v2-对比)
5. [Multi-Session 三种模式](#multi-session-三种模式)
6. [会话生命周期](#会话生命周期)
7. [权限回调机制](#权限回调机制)
8. [Session 恢复机制](#session-恢复机制)
9. [信任设备验证](#信任设备验证)
10. [Bridge 镜像模式](#bridge-镜像模式)
11. [GrowthBook Feature Flags](#growthbook-feature-flags)
12. [/remote-control 命令](#remote-control-命令)
13. [已知限制/待验证](#已知限制待验证)

---

## 概述

Bridge (Remote Control) 功能允许用户通过 claude.ai 网页界面远程控制本地的 Claude Code CLI 会话。这实现了跨设备的会话同步和远程操作能力。

**核心文件:**
- `src/bridge/bridgeEnabled.ts` - 权限检查和功能门控
- `src/bridge/bridgeMain.ts` - 独立 daemon 模式主循环
- `src/bridge/replBridge.ts` - REPL 集成模式
- `src/bridge/initReplBridge.ts` - REPL Bridge 初始化
- `src/bridge/remoteBridgeCore.ts` - CCR v2 核心实现
- `src/bridge/bridgeApi.ts` - Bridge API 客户端
- `src/bridge/bridgePermissionCallbacks.ts` - 权限回调类型
- `src/bridge/trustedDevice.ts` - 信任设备验证
- `src/bridge/bridgePointer.ts` - 会话恢复指针
- `src/commands/bridge/bridge.tsx` - /remote-control 命令

---

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        claude.ai Web App                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Session List │  │ Chat UI     │  │ Permission Approval UI  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                      │                │
└─────────┼────────────────┼──────────────────────┼────────────────┘
          │                │                      │
          ▼                ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Anthropic CCR Server                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Environment  │  │ Work Queue   │  │ WebSocket Gateway    │   │
│  │ Registry     │  │ (Redis PEL)  │  │ (SSE/Events)         │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│         │    REST API     │    Poll/Ack/Stop     │   Ingress WS  │
└─────────┼─────────────────┼──────────────────────┼───────────────┘
          │                 │                      │
          ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code CLI (Local)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Bridge Main  │  │ Session      │  │ Permission           │   │
│  │ (Poll Loop)  │  │ Spawner      │  │ Callbacks            │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    CLI Session Process                    │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │   │
│  │  │ Tools   │  │ Query   │  │ MCP     │  │ Transcript  │  │   │
│  │  │ Pool    │  │ Engine  │  │ Clients │  │ Storage     │  │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**数据流:**
1. 用户在 claude.ai 发送消息
2. CCR Server 将消息放入 Work Queue
3. CLI 的 Poll Loop 获取 Work
4. CLI 执行任务，通过 Ingress WS 发送事件
5. claude.ai 显示实时进度和结果

---

## 六层开启条件

Bridge 功能需要通过以下六层检查才能启用：

### 第 1 层: 编译时 Feature Flag

```typescript
// src/bridge/bridgeEnabled.ts:28-36
export function isBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}
```

`feature('BRIDGE_MODE')` 必须在构建时启用。

### 第 2 层: Claude.ai 订阅验证

```typescript
// src/bridge/bridgeEnabled.ts:94-100
function isClaudeAISubscriber(): boolean {
  try {
    return authModule.isClaudeAISubscriber()
  } catch {
    return false
  }
}
```

必须使用 claude.ai OAuth 登录，不支持：
- Bedrock/Vertex/Foundry
- API Key 认证
- Console API 登录

### 第 3 层: Profile Scope 检查

```typescript
// src/bridge/bridgeEnabled.ts:75-76
if (!hasProfileScope()) {
  return 'Remote Control requires a full-scope login token.'
}
```

需要 `user:profile` scope，setup-token 和 CLAUDE_CODE_OAUTH_TOKEN 环境变量不具备此 scope。

### 第 4 层: Organization UUID 检查

```typescript
// src/bridge/bridgeEnabled.ts:78-79
if (!getOauthAccountInfo()?.organizationUuid) {
  return 'Unable to determine your organization for Remote Control eligibility.'
}
```

### 第 5 层: GrowthBook Gate

```typescript
// src/bridge/bridgeEnabled.ts:81-83
if (!(await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))) {
  return 'Remote Control is not yet enabled for your account.'
}
```

`tengu_ccr_bridge` gate 控制账户级别的功能可用性。

### 第 6 层: Organization Policy

```typescript
// src/bridge/initReplBridge.ts:154-160
await waitForPolicyLimitsToLoad()
if (!isPolicyAllowed('allow_remote_control')) {
  logBridgeSkip('policy_denied', '...')
  onStateChange?.('failed', "disabled by your organization's policy")
  return null
}
```

组织管理员可以通过 policy 禁用 Remote Control。

---

## CCR v1 vs CCR v2 对比

### CCR v1 (Environment-Based)

**特点:**
- 使用 Environment API 注册 → Poll → Ack → Heartbeat 循环
- 通过环境变量传递配置给子进程
- 支持 perpetual (长生命周期) 会话

**关键代码路径:**
```typescript
// src/bridge/initReplBridge.ts:490-544
return initBridgeCore({
  dir: getOriginalCwd(),
  machineName: hostname(),
  branch,
  gitRepoUrl,
  title,
  baseUrl,
  sessionIngressUrl,
  workerType,
  getAccessToken: getBridgeAccessToken,
  createSession: opts => createBridgeSession({...}),
  archiveSession: sessionId => archiveBridgeSession(sessionId, {...}),
  // ...
})
```

**环境变量:**
- `CLAUDE_CODE_SDK_URL` - SDK 连接 URL
- `CLAUDE_CODE_SESSION_ID` - 会话 ID
- `CLAUDE_CODE_SESSION_TOKEN` - 会话认证 token

### CCR v2 (Env-Less)

**特点:**
- 直接通过 POST /bridge 获取 worker JWT
- 无需 Environment 注册，简化流程
- 通过 GrowthBook `tengu_bridge_repl_v2` 控制

**关键代码路径:**
```typescript
// src/bridge/initReplBridge.ts:410-451
if (isEnvLessBridgeEnabled() && !perpetual) {
  const { initEnvLessBridgeCore } = await import('./remoteBridgeCore.js')
  return initEnvLessBridgeCore({
    baseUrl,
    orgUUID,
    title,
    getAccessToken: getBridgeAccessToken,
    onAuth401: handleOAuth401Error,
    toSDKMessages,
    initialHistoryCap,
    initialMessages,
    // ...
  })
}
```

**配置 (tengu_bridge_repl_v2_config):**

```typescript
// src/bridge/envLessBridgeConfig.ts:7-42
export type EnvLessBridgeConfig = {
  init_retry_max_attempts: number        // 默认: 3
  init_retry_base_delay_ms: number       // 默认: 500
  init_retry_jitter_fraction: number     // 默认: 0.25
  init_retry_max_delay_ms: number        // 默认: 4000
  http_timeout_ms: number                // 默认: 10000
  uuid_dedup_buffer_size: number         // 默认: 2000
  heartbeat_interval_ms: number          // 默认: 20000
  heartbeat_jitter_fraction: number      // 默认: 0.1
  token_refresh_buffer_ms: number        // 默认: 300000
  teardown_archive_timeout_ms: number    // 默认: 1500
  connect_timeout_ms: number             // 默认: 15000
  min_version: string                    // 默认: '0.0.0'
  should_show_app_upgrade_message: boolean // 默认: false
}
```

### 对比表

| 特性 | CCR v1 | CCR v2 |
|------|--------|--------|
| 环境注册 | 需要 | 不需要 |
| Poll/Ack 循环 | 需要 | 不需要 |
| 环境变量传递 | 是 | 否 |
| Perpetual 支持 | 是 | 否 (回退到 v1) |
| Session ID 前缀 | `session_*` | `cse_*` (需要 shim) |
| 版本最低要求 | `tengu_bridge_min_version` | `tengu_bridge_repl_v2_config.min_version` |

---

## Multi-Session 三种模式

通过 `--spawn` 参数控制，由 `tengu_ccr_bridge_multi_session` gate 控制可用性。

### 1. Worktree 模式 (`worktree`)

每个会话在独立的 git worktree 中运行：

```typescript
// src/bridge/bridgeMain.ts
// 为每个会话创建临时 worktree
const worktreeResult = await createAgentWorktree(gitRoot, taskId)
sessionWorktrees.set(sessionId, {
  worktreePath: worktreeResult.worktreePath,
  worktreeBranch: worktreeResult.branch,
  gitRoot,
  hookBased: worktreeResult.hookBased,
})
```

**特点:**
- 每个会话完全隔离的代码副本
- 会话结束后自动清理 worktree
- 适合并行开发不同功能

### 2. Same-Dir 模式 (`same-dir`)

所有会话在同一目录运行：

```typescript
// 会话直接在 config.dir 中运行
const handle = safeSpawn(spawner, opts, config.dir)
```

**特点:**
- 共享文件系统状态
- 需要小心处理文件冲突
- 资源占用最少

### 3. Session 模式 (`session`)

每个会话在独立子目录中运行：

```typescript
// 创建会话特定的子目录
const sessionDir = join(config.dir, 'sessions', sessionId)
```

**特点:**
- 文件隔离但不使用 git worktree
- 适合非 git 仓库

### 配置参数

```typescript
// src/bridge/bridgeMain.ts:83-84
const STATUS_UPDATE_INTERVAL_MS = 1_000
const SPAWN_SESSIONS_DEFAULT = 32  // 默认最大会话数
```

---

## 会话生命周期

### 状态机

```
             ┌──────────────────────────────────────┐
             │                                      │
             ▼                                      │
    ┌──────────────┐                               │
    │   Created    │ ─────────────────────────┐    │
    └──────┬───────┘                          │    │
           │                                  │    │
           ▼                                  │    │
    ┌──────────────┐      ┌─────────────┐     │    │
    │   Running    │ ───► │  Completed  │     │    │
    └──────┬───────┘      └─────────────┘     │    │
           │                                  │    │
           ├─────────────────────────────────►│    │
           │         (error)                  │    │
           ▼                                  ▼    │
    ┌──────────────┐                  ┌───────────────┐
    │   Failed     │                  │   Killed      │
    └──────────────┘                  └───────────────┘
                                             │
                                             │ (TaskStop)
                                             │
                                    ┌────────┴───────┐
                                    │  Interrupted   │
                                    └────────────────┘
```

### 生命周期事件

```typescript
// src/bridge/bridgeMain.ts:442-591
function onSessionDone(
  sessionId: string,
  startTime: number,
  handle: SessionHandle,
): (status: SessionDoneStatus) => void {
  return (rawStatus: SessionDoneStatus): void => {
    // 清理状态
    activeSessions.delete(sessionId)
    sessionStartTimes.delete(sessionId)
    sessionWorkIds.delete(sessionId)
    // ...

    // 通知服务器
    if (status !== 'interrupted' && workId) {
      trackCleanup(stopWorkWithRetry(api, environmentId, workId, logger, ...))
      completedWorkIds.add(workId)
    }

    // 清理 worktree
    const wt = sessionWorktrees.get(sessionId)
    if (wt) {
      trackCleanup(removeAgentWorktree(wt.worktreePath, ...))
    }

    // Multi-session: 归档并继续
    // Single-session: 终止 poll loop
    if (config.spawnMode !== 'single-session') {
      trackCleanup(api.archiveSession(compatId).catch(...))
    } else {
      controller.abort()
    }
  }
}
```

---

## 权限回调机制

### 类型定义

```typescript
// src/bridge/bridgePermissionCallbacks.ts:1-27
type BridgePermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}

type BridgePermissionCallbacks = {
  sendRequest(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    description: string,
    permissionSuggestions?: PermissionUpdate[],
    blockedPath?: string,
  ): void
  sendResponse(requestId: string, response: BridgePermissionResponse): void
  cancelRequest(requestId: string): void
  onResponse(
    requestId: string,
    handler: (response: BridgePermissionResponse) => void,
  ): () => void // returns unsubscribe
}
```

### 流程

1. CLI 执行需要权限的操作
2. 发送 `control_request` 事件到服务器
3. Web UI 显示审批对话框
4. 用户点击 Allow/Deny
5. 服务器发送 `control_response` 事件
6. CLI 接收并执行响应

### API 调用

```typescript
// src/bridge/bridgeApi.ts:419-450
async sendPermissionResponseEvent(
  sessionId: string,
  event: PermissionResponseEvent,
  sessionToken: string,
): Promise<void> {
  const response = await axios.post(
    `${deps.baseUrl}/v1/sessions/${sessionId}/events`,
    { events: [event] },
    {
      headers: getHeaders(sessionToken),
      timeout: 10_000,
      validateStatus: s => s < 500,
    },
  )
  handleErrorStatus(response.status, response.data, 'SendPermissionResponseEvent')
}
```

---

## Session 恢复机制

### bridge-pointer.json 格式

```typescript
// src/bridge/bridgePointer.ts:42-48
const BridgePointerSchema = lazySchema(() =>
  z.object({
    sessionId: z.string(),
    environmentId: z.string(),
    source: z.enum(['standalone', 'repl']),
  }),
)
```

### 写入时机

```typescript
// src/bridge/bridgePointer.ts:62-74
export async function writeBridgePointer(
  dir: string,
  pointer: BridgePointer,
): Promise<void> {
  const path = getBridgePointerPath(dir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, jsonStringify(pointer), 'utf8')
}
```

会话创建后立即写入，并定期刷新 mtime。

### 读取和验证

```typescript
// src/bridge/bridgePointer.ts:83-113
export async function readBridgePointer(
  dir: string,
): Promise<(BridgePointer & { ageMs: number }) | null> {
  // 1. stat 获取 mtime
  // 2. 读取文件内容
  // 3. 验证 schema
  // 4. 检查过期 (4 小时 TTL)
  const ageMs = Math.max(0, Date.now() - mtimeMs)
  if (ageMs > BRIDGE_POINTER_TTL_MS) {
    await clearBridgePointer(dir)
    return null
  }
  return { ...parsed.data, ageMs }
}
```

### Worktree 感知读取

```typescript
// src/bridge/bridgePointer.ts:129-184
export async function readBridgePointerAcrossWorktrees(
  dir: string,
): Promise<{ pointer: BridgePointer & { ageMs: number }; dir: string } | null> {
  // 1. 快速路径：检查当前目录
  const here = await readBridgePointer(dir)
  if (here) return { pointer: here, dir }

  // 2. 扫描所有 git worktree 兄弟目录
  const worktrees = await getWorktreePathsPortable(dir)
  // 3. 并行读取所有候选
  // 4. 返回最新的 (最小 ageMs)
}
```

**TTL**: 4 小时 (`BRIDGE_POINTER_TTL_MS = 4 * 60 * 60 * 1000`)

---

## 信任设备验证

### Gate 控制

```typescript
// src/bridge/trustedDevice.ts:33-37
const TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'

function isGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(TRUSTED_DEVICE_GATE, false)
}
```

### Token 获取

```typescript
// src/bridge/trustedDevice.ts:54-59
export function getTrustedDeviceToken(): string | undefined {
  if (!isGateEnabled()) {
    return undefined
  }
  return readStoredToken()
}
```

优先级: 环境变量 > Keychain 存储

### 设备注册

```typescript
// src/bridge/trustedDevice.ts:98-207
export async function enrollTrustedDevice(): Promise<void> {
  // 1. 检查 gate
  // 2. 检查环境变量
  // 3. 获取 OAuth token
  // 4. POST /api/auth/trusted_devices
  const response = await axios.post(
    `${baseUrl}/api/auth/trusted_devices`,
    { display_name: `Claude Code on ${hostname()} · ${process.platform}` },
    { headers: { Authorization: `Bearer ${accessToken}` }, ... }
  )
  // 5. 存储到 Keychain
  storageData.trustedDeviceToken = response.data.device_token
  secureStorage.update(storageData)
}
```

**时机**: 必须在 `/login` 后 10 分钟内完成注册（服务端限制）

### HTTP Header

```typescript
// src/bridge/bridgeApi.ts:76-88
function getHeaders(accessToken: string): Record<string, string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': BETA_HEADER,
    'x-environment-runner-version': deps.runnerVersion,
  }
  const deviceToken = deps.getTrustedDeviceToken?.()
  if (deviceToken) {
    headers['X-Trusted-Device-Token'] = deviceToken
  }
  return headers
}
```

---

## Bridge 镜像模式

### 启用条件

```typescript
// src/bridge/bridgeEnabled.ts:197-202
export function isCcrMirrorEnabled(): boolean {
  return feature('CCR_MIRROR')
    ? isEnvTruthy(process.env.CLAUDE_CODE_CCR_MIRROR) ||
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_mirror', false)
    : false
}
```

### 特点

- **单向转发**: 只发送事件到 claude.ai，不接收输入
- **outboundOnly 模式**: 本地会话可见但不可远程控制

```typescript
// src/bridge/initReplBridge.ts:106-107
/** When true, the bridge only forwards events outbound (no SSE inbound stream). */
outboundOnly?: boolean
```

### 用途

- 让本地会话在 claude.ai 会话列表中可见
- 不暴露远程控制能力（安全考虑）

---

## GrowthBook Feature Flags

### 核心 Gates

| Flag | 类型 | 默认值 | 描述 | 代码位置 |
|------|------|--------|------|----------|
| `tengu_ccr_bridge` | gate | false | 主功能开关 | `bridgeEnabled.ts:34` |
| `tengu_bridge_repl_v2` | gate | false | CCR v2 (env-less) 开关 | `bridgeEnabled.ts:127-129` |
| `tengu_ccr_bridge_multi_session` | gate | false | 多会话模式开关 | `bridgeMain.ts:96-98` |
| `tengu_ccr_mirror` | gate | false | 镜像模式开关 | `bridgeEnabled.ts:200` |
| `tengu_sessions_elevated_auth_enforcement` | gate | false | 信任设备验证 | `trustedDevice.ts:33` |
| `tengu_cobalt_harbor` | gate | false | CCR 自动连接默认值 | `bridgeEnabled.ts:187` |

### 配置型 Flags

| Flag | 类型 | 默认值 | 描述 | 代码位置 |
|------|------|--------|------|----------|
| `tengu_bridge_min_version` | config | `{minVersion: '0.0.0'}` | v1 最低版本 | `bridgeEnabled.ts:165-168` |
| `tengu_bridge_poll_interval_config` | config | 见下表 | Poll 间隔配置 | `pollConfig.ts:103-107` |
| `tengu_bridge_repl_v2_config` | config | 见下表 | v2 配置 | `envLessBridgeConfig.ts:131-134` |
| `tengu_bridge_initial_history_cap` | config | 200 | 初始历史消息上限 | `initReplBridge.ts:380-384` |
| `tengu_bridge_repl_v2_cse_shim_enabled` | gate | true | cse_* → session_* shim | `bridgeEnabled.ts:143-148` |
| `tengu_ccr_bundle_seed_enabled` | gate | false | Git bundle 种子 | `remoteSession.ts` |
| `tengu_ccr_bundle_max_bytes` | config | 50MB | Bundle 大小上限 | `gitBundle.ts` |

### Poll 配置默认值

```typescript
// src/bridge/pollConfigDefaults.ts
export const DEFAULT_POLL_CONFIG: PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: 500,
  poll_interval_ms_at_capacity: 30000,
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity: 1000,
  multisession_poll_interval_ms_partial_capacity: 3000,
  multisession_poll_interval_ms_at_capacity: 30000,
  reclaim_older_than_ms: 5000,
  session_keepalive_interval_v2_ms: 120000,
}
```

### v2 配置默认值

```typescript
// src/bridge/envLessBridgeConfig.ts:44-58
export const DEFAULT_ENV_LESS_BRIDGE_CONFIG: EnvLessBridgeConfig = {
  init_retry_max_attempts: 3,
  init_retry_base_delay_ms: 500,
  init_retry_jitter_fraction: 0.25,
  init_retry_max_delay_ms: 4000,
  http_timeout_ms: 10_000,
  uuid_dedup_buffer_size: 2000,
  heartbeat_interval_ms: 20_000,
  heartbeat_jitter_fraction: 0.1,
  token_refresh_buffer_ms: 300_000,
  teardown_archive_timeout_ms: 1500,
  connect_timeout_ms: 15_000,
  min_version: '0.0.0',
  should_show_app_upgrade_message: false,
}
```

---

## /remote-control 命令

### 命令入口

```typescript
// src/commands/bridge/bridge.tsx:38-140
function BridgeToggle({ onDone, name }: Props) {
  // 检查是否已连接
  if ((replBridgeConnected || replBridgeEnabled) && !replBridgeOutboundOnly) {
    // 显示断开对话框
    setShowDisconnectDialog(true)
    return
  }

  // 检查前置条件
  const error = await checkBridgePrerequisites()
  if (error) {
    onDone(error, { display: 'system' })
    return
  }

  // 启用 bridge
  setAppState(prev => ({
    ...prev,
    replBridgeEnabled: true,
    replBridgeExplicit: true,
    replBridgeOutboundOnly: false,
    replBridgeInitialName: name,
  }))
  onDone('Remote Control connecting…', { display: 'system' })
}
```

### 参数

| 参数 | 描述 |
|------|------|
| `name` | 可选，会话名称 |
| `--continue` | 恢复之前的会话（使用 bridge-pointer.json） |

### 前置条件检查

```typescript
async function checkBridgePrerequisites(): Promise<string | null> {
  // 1. getBridgeDisabledReason() - 完整的禁用原因检查
  // 2. 版本检查 (v1 或 v2 取决于 isEnvLessBridgeEnabled)
}
```

### 断开对话框

显示选项：
1. 复制 URL
2. 显示 QR 码
3. 断开连接
4. 继续

---

## 已知限制/待验证

1. **JWT 过期处理**: v2 的 JWT 刷新机制（`reconnectSession`）需要验证在长时间会话中的表现

2. **Multi-Session 资源限制**: `SPAWN_SESSIONS_DEFAULT = 32` 的实际内存影响需要测试

3. **Worktree 清理**: 异常退出时 worktree 是否能正确清理

4. **Bridge Pointer TTL**: 4 小时 TTL 是否匹配服务端的 environment 生命周期

5. **信任设备 Token 轮换**: 90 天 rolling expiry 的具体实现细节

6. **SSE vs WebSocket**: v2 是否完全使用 WebSocket，或者某些事件仍通过 SSE

7. **Cross-machine 消息安全**: SendMessageTool 对 bridge: 目标的安全检查是否足够

---

## 代码引用索引

| 功能 | 文件:行号 |
|------|-----------|
| isBridgeEnabled() | `bridgeEnabled.ts:28-36` |
| isBridgeEnabledBlocking() | `bridgeEnabled.ts:50-55` |
| getBridgeDisabledReason() | `bridgeEnabled.ts:70-87` |
| isEnvLessBridgeEnabled() | `bridgeEnabled.ts:126-130` |
| isCcrMirrorEnabled() | `bridgeEnabled.ts:197-202` |
| checkBridgeMinVersion() | `bridgeEnabled.ts:160-173` |
| getCcrAutoConnectDefault() | `bridgeEnabled.ts:185-189` |
| runBridgeLoop() | `bridgeMain.ts:141-700+` |
| initReplBridge() | `initReplBridge.ts:110-545` |
| initBridgeCore() | `replBridge.ts` |
| initEnvLessBridgeCore() | `remoteBridgeCore.ts` |
| createBridgeApiClient() | `bridgeApi.ts:68-452` |
| getTrustedDeviceToken() | `trustedDevice.ts:54-59` |
| enrollTrustedDevice() | `trustedDevice.ts:98-207` |
| writeBridgePointer() | `bridgePointer.ts:62-74` |
| readBridgePointer() | `bridgePointer.ts:83-113` |
| getEnvLessBridgeConfig() | `envLessBridgeConfig.ts:130-137` |
| getPollIntervalConfig() | `pollConfig.ts:102-110` |

---

*文档结束*
