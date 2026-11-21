# 更新日志

## 0.1.0 —— P0 骨架

首版：只建立可装配、可测试的骨架，业务能力按计划分阶段接入。

### 已完成

- **包结构**：`package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`、`install.mjs`。
- **装配层**：只 `insert` 自己一行，**不 disabled 任何原生行**。这是与 `@michengai/dsh-archive-manager` 最本质的区别。
- **`install.mjs`**：幂等双通道安装/卸载（正规 bundle 通道 / 手动通道），含一条**不变量校验**——任何 patch 层若存在对 `workspace` / `session-projection-cache` / `ui-workspace` 的 `disabled: true`，脚本直接报错退出、拒绝写入。
- **`lib/paths.js`**：逐字符复刻宿主的路径编码（`encodeSegment` / `projectKey` / `projectDir` / `sessionDir` / 代际日志文件名识别），并额外提供 `candidateSessionDirs()` 返回**候选列表**而非单值，供调用方逐个 `stat` 校验后再决定。
- **`lib/index.js`**：host 半边骨架。5 条 `/api/sessionArchive.*` 路由经 `connection.fetch.register` 挂载（复用官方 `/api` 认证围栏）；每一条都持有 disposer 并归属 `ctx.effect`（与 archive-manager 丢弃 disposer 的做法相反）；P0 阶段 handler 返回 **501 not-implemented**，而非静默 200。
- **`lib/client.js`**：client 半边骨架，按 DSH 客户端 bundle 的正确格式（`window.__ModuleLoader__.load({id, factory})`）编写；在 `settings.section`（list 槽、`replaceRisk: none`）注册「会话归档」页占位。
- **测试**（3 套，共 52 项断言）：
  - `paths.test.mjs` —— 路径编码，期望值取自本机真实目录名；
  - `paths.disk.test.mjs` —— 真实磁盘交叉验证（读 `~/.dsh/sessions` 反向校验）；
  - `host.apply.test.mjs` —— 路由注册 / 501 fail-loud / disposer 生命周期 / `connection.fetch` 缺失时不影响启动。

### 开发过程中修掉的两个真缺陷

1. **`@deepseek-ai/dsh-home-paths` 无法解析**。初版 host 半边 `import { dshHomePath }`，实测从插件位置抛 `ERR_MODULE_NOT_FOUND`（它是传递依赖），会让插件启动即崩。改为零依赖：读 `DSH_HOME` 环境变量 + `node:os` 的 `homedir()`。
2. **`projectDir(root, null)` 抛错**。`null` 未归一为「无 cwd」，会走 `projectKey(null)` 并抛 `empty project path`。已修，并加单测锁定。

### 关键设计决定

- **回收站放在 `~/.dsh/session-archive/trash/`，而非 `sessions/` 内**。宿主扫描器不过滤点目录，且 `listArtifacts` 对重复 session id 会 `throw` —— 回收站若留在 `sessions/` 内，只要其中某个 id 在别处也存在，**DSH 会直接启动失败**。放在 `sessions` 之外且同设备，`rename` 仍是原子的快路径。
- **回收站不做自动淘汰**。容量/期限只统计与提示，淘汰必须由人确认。

## 0.2.0 —— P1 归档列表 + P2 恢复归档

### P1：归档列表（宿主只读）

- 新增 `lib/archive-list.js`（纯逻辑，无 I/O、不碰宿主内部字段，可完整单测）：
  - `headerOf()` —— **同时接受两种持久化形状**：0.1.5-rc.2 的 `{header, revision, sizeBytes}` 快照，以及旧的裸 header。这正是 `dsh-session-manager` 栽跟头的地方（它只认后者，导致 `.id` 恒为 undefined、删除与恢复静默失效）。
  - `buildHeaderIndex()` —— 实时优先于持久化，与宿主 `sessionQuery` 的取向一致。
  - `resolveArchivedSessions()` —— 去重、按活动时间降序（同时刻按 id 升序保证稳定）、识别**陈旧归档标记**。
- `list` 路由接入真实数据源；`sources` 字段回报各来源计数，便于排查。
- **陈旧标记只报告、不清理**：归档集合是独立持久化的，会话文件却可能已被外部删除。删标记不可逆（原生无 unarchive 入口），所以 `state: 'missing'` 原样返回，是否清理由使用者决定。
- **fail-loud**：`workspaceRegistry.state` 不可读时返回 **503 `state-unreadable`**，而不是回一个空列表让人以为归档丢了。

### P2：恢复归档

- 新增 `lib/unarchive.js`。恢复是原生**完全缺失**的能力（公开面只有单向 `archiveSession()`）。
- **持久化必须走 `registry.enqueueOperation(() => registry.setState(next))`**：
  - `setState` 一次写盘 + 同步更新内存；
  - `enqueueOperation` 与宿主自身的归档共享同一个串行队列。
  - 刻意**不**直写 `storageDomain`（`dsh-session-manager` 的写法）——它绕过串行队列，与宿主并发时是典型的 read-modify-write 丢失更新；它自己还要靠一句「stale registry cache」补丁来修内存漂移，那正是该 bug 的症状。
- **陈旧标记需显式确认**：会话已不存在时默认返回 `409 session-gone`；带 `allowStale: true` 才清除（因为不可逆）。
- `sessionKnown` 探测**保守取向**：只有确定不存在才返回 false；实时探测或持久化列举失败时返回 true，以免把「暂时读不到」误判成「已删除」。
- 幂等：本就不在归档集合里 → `200 changed:false`，不写盘、不报错。

### 开发过程中修掉的真缺陷（由测试抓到）

- **并发恢复丢失更新**。`unarchiveSession` 初版虽然在串行区内重读了 `state`，但新的归档集合是在**进队列之前**算好的 —— 两个并发恢复会基于同一份旧 state 计算，后者覆盖前者。测试 `[4] 两个并发恢复都生效` 直接暴露了它。修法是新增 `mutateArchivedIds()`：把**「读 → 算 → 写」整体**放进串行区，因此它接收的是**变更函数**而不是结果数组。

### 测试

新增 2 套（`archive-list.test.mjs` 26 项、`unarchive.test.mjs` 24 项），并将 `unarchive` 端到端用例并入 host 冒烟测试。
当前共 **5 套 / 116 项断言**，全部通过。

## 0.3.0 —— P3 回收站软删全链路

### 删除语义：回收站软删

删除 = 把会话目录**整体搬入** `~/.dsh/session-archive/trash/<epoch>-<sessionId>/`，
并写入条目自带的 sidecar 元数据 `.dsh-archive-meta.json`。可恢复、可彻底清除。

### 新增模块

- `lib/trash.js` —— 纯逻辑（无 I/O）：
  - `entryDirName` / `parseEntryDirName`：`<epochMillis>-<encodeSegment(id)>`
  - `buildMeta` / `validateMeta`：sidecar 元数据。**必须**记录 `original.sessionDir`
    （目录名依赖宿主编码，不能只靠 `cwd` 现算），并记录 `header.createdAt` 作为
    **身份见证**以识别 id 复用。
  - **`verifyDeletableSessionDir()`** —— 本项目最重要的函数：删除前必须确认
    目录名 == `encodeSegment(sessionId)`、真的是目录、**非符号链接**、且含可识别代际日志。
    任何一条不成立即**放弃删除**（而不是尽力而为）。
  - `checkCapacity()` / `summarizeTrash()` / `suggestPurgeCandidates()` —— 容量策略。
    **绝不自动淘汰**：超限只报错并提示人工清理。
  - `checkRestorable()` —— 恢复前拒绝覆盖；id 被复用（`createdAt` 不符）时拒绝。
- `lib/trash-io.js` —— 文件操作：逐文件 `rename` + **反向回滚**，最后用**非递归 `rmdir`**
  收掉原目录空壳（有预期外残留则失败 —— 这是需要知道的信号，而不是无声 `rm -rf`）。

### 删除流水线时序（`lib/index.js`）

`[1] 运行中拒绝 → [2] 身份校验 → [3] 容量检查 → [4] 写元数据+搬运（提交点）→
[5] 发移除通知 → [6] 清投影缓存 → [7] 摘工作区归属 → [8] 移出归档集合`

**[4] 与 [5] 的顺序对实时/冷会话必须分开**：

- **冷会话**：`api-session/removed` 必须**先于**搬运发出。宿主真正的 dispose 生命周期
  （`persistence.open → fromRestore → enter/announce/detach`）需要读日志，文件搬走就读不到了；
  而直接 `ctx.emit('api-session/removed', id)` 不依赖文件（archive-manager 用的就是这条）。
- **实时会话**：**先搬运再**走 `sessions.detachEntered()`（只操作内存对象），
  它会同时发出 `session/disposed` 与 `api-session/removed`。

[5]–[8] 全部 fail-soft，单个失败只告警不阻断 —— 否则会出现"文件已进回收站、UI 却还显示"的更糟状态。

### 幽灵回归测试（`test/ghost-regression.test.mjs`）

把"删除干净"拆成三个可验证的事实，并在**真实临时目录**上验证：

- **A** 磁盘上任何位置都不再存在该 id 的会话目录（否则宿主 `listArtifacts` 会复活它，
  甚至因重复 id `throw` 导致启动失败）；
- **B** 已从归档集合移除（且是走 `registry` 串行队列）；
- **C** 发出了 `api-session/removed`。

另验证：回收站**不在 `sessions/` 根内**、条目确实进了回收站（不是凭空消失）、
重复删除幂等（第二次明确失败而非静默成功）。

### 测试

新增 3 套（`trash.test.mjs` 46 项、`trash-io.test.mjs` 25 项、`ghost-regression.test.mjs` 15 项），
当前共 **8 套 / 212 项断言**，全部通过。

### 开发过程中修掉的两处

1. **测试会碰真实回收站**：`handleTrashList` 原先直读 `~/.dsh/session-archive/trash`，
   测试因此有副作用。改为支持 `DSH_SESSION_ARCHIVE_ROOT` 覆盖（同时可用于迁移回收站到别的盘）。
2. **两种"体积"语义混淆**：条目记录的是**入站时原始会话体积**，而列举时算出的是**当前
   实际占用（含 sidecar）**。若混用，容量策略会随列举缓慢漂移、展示又会低估占用。
   现在 `recordedSizeBytes` 与 `sizeBytes` 分开给出并在测试中锁定。

## 0.4.0 —— P4 客户端 UI + P5 加固

### P4：`settings.section` 页面

- 双页签：「已归档」（恢复 / 删除到回收站）与「回收站」（恢复 / 彻底清除）。
- **二次点击确认**：删除与彻底清除都需要点两次，避免引入弹层依赖，同时保证不可逆操作不误触。
- 运行中的会话禁止删除、陈旧标记禁止恢复（按钮 `disabled` 并给出原因）。
- 容量提示：条数/体积对上限、待清理条数、超限告警。

**客户端调用形状已定案**（此前一直挂着的未知）：

```js
const base = globalThis.location?.origin
await fetch(new URL('/api/sessionArchive.list', base ?? 'http://dsh.internal'), {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})
```

取自官方样例 `dsh-session-log-export` 的 `hostBase()` 与 `dsh-client-file-upload` 的
`credentials: 'include'`。宿主侧用 `connection.fetch.register` 注册精确 `/api` 路由，
认证由官方围栏（`isTrustedApiRequest` + cookie）承担，插件不自行造鉴权。

### P5：加固

- **容量策略可配置**：`DSH_SESSION_ARCHIVE_LIMITS`（JSON）。非法值**一律退回默认** ——
  绝不因为配置写错就把上限变成 0/NaN 而误伤数据。
- **新增 `purgeExpired` 端点**：批量清理，但必须显式指定 `sessionIds` / `oldestCount` /
  `onlyExpired` 之一；无参数时返回 400 且**不删任何东西**。本端点绝不自行决定淘汰谁。
- UI 在超限或存在超期条目时给出告警与手动清理入口。

### 测试

新增 2 套（`client.test.mjs` 22 项、`hardening.test.mjs` 19 项），当前共 **10 套 / 253 项断言 + 29 个磁盘检查点**，全部通过。

加固测试覆盖的关键事实：

- **内容完整性**：删除 → 恢复后会话日志**逐字节一致**（含多字节字符与换行）；
- **绝不覆盖**：恢复时目标被占用 → 409 且占用者内容未被改写，回收站副本仍在；
- **绝不自行淘汰**：`purgeExpired` 无参数 → 400 且零删除；指定不存在的 id → 0 条不误伤；
- **容量拦截**：超限时删除返回 507 `trash-full`，且**被拦截的会话原封不动留在原地**；
- **坏条目**：缺元数据的条目被如实报告、不参与恢复，但**也不被静默清理**。

### 开发过程中修掉的三处

1. **客户端 bundle 语法错误**：`ArchiveSection` 里少一层闭合括号。已整段重写并加括号配平校验。
   这类错误**只有重启 DSH 才会暴露**，因此新增了 `client.test.mjs` 在 Node 里以 mock 环境
   执行真实客户端代码。
2. **测试卫生**：`handleTrashList` 原先直读真实回收站根，测试有副作用。改为支持
   `DSH_SESSION_ARCHIVE_ROOT` 覆盖。
3. **测试自身的子串陷阱**：端点断言用 `includes('list')` 会误命中 `unarchive`。
   改为「显式端点契约清单 ↔ 真实注册路由集合」双向相等断言，比静态字符串匹配可靠。

## 0.5.0 —— 补齐两个未验证环节

本轮没有新增功能，而是把此前只做过静态推理、或只做过 `--dry-run` 的两个环节补成真实验证。

### 新增：`test/install.test.mjs`（36 项）

`install.mjs` 会**改写使用者的 profile manifest 与 patch 层**，是唯一动到 profile 配置的操作。
此前只跑过 `--dry-run`，真实落盘路径完全没验证。现在在沙盒 profile 里跑通全生命周期：

- dry-run 不落盘；安装写入 `link:` 规格 + 追加 bundle + 建符号链接 + 生成备份；
- **幂等**：重复安装 manifest 逐字节不变；
- 卸载：两条通道都清，且其它 bundle 不受影响；
- **不变量拦截**：patch 层若禁用 `workspace` / `session-projection-cache` / `ui-workspace`
  中任何一个，安装被**拒绝（退出码 1）且不半写**（manifest 未被改写、无符号链接）；
- 手动通道：写入手动段、摘除 bundle 条目、再切回正规通道时手动段被正确摘除；
- 边界：manifest 缺失 / 非法 JSON 均明确报错并退出 1。

### 新增：`test/composition.test.mjs`（8 项）

用**真实 dsh 加载器**验证组合：

- 在**完全隔离的 `DSH_HOME` 沙盒**里建立 profile，跑 `dsh --profile probe --dump-config`；
- **插件行确实出现在组合树里**，且未被禁用；
- **未禁用任何原生核心行**；
- 无 `patch: entry ... not found` 之类告警。

之所以能用一个"只加载本插件"的最小 profile 完成验证：本插件**不依赖任何原生行**
（只 insert 自己），这正是"绝不替换原生服务"这一约束的直接体现。

### 仍未验证的部分（已在 README 明确列出）

需要一次真实重启才能确认的三件事：浏览器实际加载客户端 bundle、`/api` 路由在浏览器
cookie 认证下可被调用、宿主内部字段在运行实例中的实时形状。

当前共 **12 套 / 297 项断言 + 29 个磁盘检查点**，全部通过。

## 0.5.1 —— 覆盖率驱动的加固

本轮不做新功能，而是**测量实际覆盖率并补齐高价值缺口**（`npm run coverage`）。

### 覆盖率（V8 精确覆盖，`test/coverage.mjs`）

| 模块 | 行覆盖率 |
|---|---|
| `trash.js` | 99.5% |
| `archive-list.js` | 98.9% |
| `paths.js` | 98.7% |
| `unarchive.js` | 91.7% |
| `trash-io.js` | 86.5% |
| `index.js` | 85.1% |
| **合计** | **90.1%**（1089/1208） |

三个**安全关键**模块（防误删校验、路径编码、陈旧标记识别）都在 99% 上下。

### 覆盖率暴露并补齐的缺口

- **`trash-io.js` 的恢复回滚路径从未被执行**。此前只测了「搬入失败 → 回滚」，
  「恢复失败 → 把已搬回的再搬回条目目录」完全没跑过 —— 而这正是最危险的代码。
  新增 `[9]`/`[10]` 两段测试（用 ENOTDIR 而非权限位制造失败，避免依赖运行身份），
  验证：恢复失败后**条目目录仍在、会话文件未丢**，且**失败后仍能成功恢复**（状态未被破坏）。
- **`resolveTitles` 完全未被覆盖**。它是 UI 标题解析路径，新增 5 项测试覆盖
  正常取值、依赖缺失、会话查不到、标题为空、逐条抛错容错。
- **数据源适配器的 fail-loud 形状校验**新增 8 项测试，逐一确认
  `readArchivedIds` 在 registry / state / 数组形状不对时都**明确失败而非回退空列表**。
- **`sessionKnown` 的保守取向**新增 4 项：`persistence.list()` 或 `sessions.get()`
  抛错时必须**假定会话存在**（否则会误清使用者的有效归档标记）。

### 仍未覆盖的部分（已知且可接受）

剩余约 119 行主要是：错误日志分支（路由注册/撤销失败、投影缓存清理失败、
工作区摘除失败）、`homedir()` 回退、以及需要完整运行 DSH 才能触发的路径。
这些不是逻辑缺口，而是"仅在异常路径或真实运行时才走到"的代码。

当前共 **12 套 / 307 项断言 + 29 个磁盘检查点**，全部通过。

## 0.6.0 —— 真实运行时端到端验证

本轮把**最后一条主要未知**消掉了：宿主内部字段在真实运行实例中的形状。

### 新增：`npm run e2e`（`test/e2e-runtime.mjs`，21 项）

在一个**完全隔离的 `DSH_HOME`** 里：

1. 建 probe profile（`node_modules` 用逐包符号链接指回真实 profile，避免复制 438M）；
2. 用 `dsh web --no-open --port 3099` 启动**真实 web 实例**（绝不碰运行中的 3080）；
3. 用一个测试专用的小插件（auth harness）在宿主内取出 `connection.authenticatedUrl()`，
   再以 `GET /?token=…` **换取浏览器会话 cookie** —— 与真实浏览器同一条认证路径；
4. 带 cookie 真实调用本插件的 7 条 `/api` 路由。

**结果：21/21 通过。** 关键验证：

- 插件在真实运行时挂载、7 条路由全部注册成功；
- `workspaceRegistry.state.archivedSessionIds` **真实可读**；
- 依赖服务全部可用（connection / registry / persistence / sessions / projectionCache / agents）；
- 跨站 `Origin` 被官方认证围栏拒绝（403）；
- **完整往返**：真实会话工件 `删除 → 回收站 → 恢复`，**内容逐字节一致**。

### 过程中发现并修掉的两个真问题

**1. 伪造的会话工件的教训（测试脚手架的错，但暴露了真实的耦合）。**
首次往返失败：`persisted: 0`、`cwd` 为 `null`、路径退化为 `_no-cwd`。
原因是我把普通 JSON 写成了 `session.v3.jsonl.zstd` —— 后端按 **zstd** 解码，
解不出 header 就认为该会话不存在。改为复制**真实**工件后通过。
这验证了一件重要的事：本插件的目录推导与宿主的持久化根**确实是同一套**。

**2. 测试夹具放在包目录内会导致启动失败。**
夹具文件最初放在 `test/fixtures/` 下，`dsh-client-modules` 按"最近的 package.json"
把它归到了 `dsh-session-archive` 名下，触发
`resolves from multiple active Loader sources` 而启动中止。
修法：把夹具生成到**包目录之外**并给它自己的 `package.json`。
（这正是 `dsh-column-swap` 注释里警告过的坑，这次亲身撞上。）

### 抖动与修复

首轮通过、次轮在往返阶段出现 401（同一轮里前面的调用却正常）。原因：连接服务的会话
cookie 绑定当次 activation 的签名密钥，实例发生重载后旧 cookie 即失效。
真实浏览器此时会重新走 launch URL 认证 —— 测试端补上同一处理（**401 后重新认证并重试一次**），
并在往返前主动刷新认证。此后连续两次 21/21 稳定通过。

（另修一处测试自身的缺陷：「内容逐字节一致」原先是**空转通过**——删除没成功时文件根本没动过，
自然"一致"。现在该断言要求 `delete` 与 `restore` 都返回 200 才生效。）

### 仍未验证

只剩**浏览器里的实际渲染**。客户端 bundle 的格式与座位契约已在 Node 中以 mock 环境
执行真实客户端代码验证，但"页面真的显示出设置页"需要一次真实浏览器访问。

当前共 **12 套 / 319 项断言（+ e2e 21 项）+ 29 个磁盘检查点**，覆盖率 90.1%。

## 0.7.0 —— 修复「删除无效」（真实使用中发现）

### 现象

装机重启后：页面载入正常、归档列表可用、**恢复有效**，但**点击"删除"没有任何反应**。

### 根因：客户端比宿主更严，而且严错了

```
客户端: disabled: busy !== null || item.state === 'missing' || item.live
宿主  : 仅在 agent.status === 'running' 时拒绝
```

`live` 表示"会话在宿主内存 store 里"——**只要点开看过某个归档会话，它就变成 live**。
而客户端据此把删除按钮**禁用**了；禁用按钮没有任何反馈，所以表现为"点击无效"。

但宿主本来就支持删除 live 会话（走 `sessions.detachEntered()` 把它从 store 摘掉，
同时发出 `session/disposed` 与 `api-session/removed`）。**客户端的限制是多余的，也是错的。**

### 修法：把 `running` 与 `live` 彻底分开

- 宿主 `list` 响应新增 **`running`** 字段（`agents.get(id)?.status === 'running'`），
  与 `live` 并列；`summary.running` 同步计数。新增适配器 `readRunningIds()`。
- 客户端删除按钮**只因 `running` 禁用**（文案改为「运行中，需先暂停」）；
  `live` 改为信息性标记「已打开」，不再影响任何操作。

这个 bug 的性质值得记一笔：**两端各自实现策略，mock 测试无法发现不一致**——
我的宿主测试与客户端测试都通过，因为它们从不互相校验。补了三条防线：

1. `archive-list.test.mjs [9]`（6 项）——`running` 与 `live` 的各种组合；
2. `host.apply.test.mjs [4b2]`——**live 空闲会话不被判为 `session-running`**；
3. `client.test.mjs [3b]`（4 项）——从源码层断言删除按钮的禁用依据必须是 `running`，
   并显式禁止 `item.live` 出现在任何 `disabled` 条件里。

### 顺带的可用性改进

不可逆操作（删除 / 彻底清除 / 清理已超期 / 清理最旧）在**等待二次确认**时，
按钮会显示醒目描边与加粗字重 —— 避免"点了一下没反应"的观感（第一下点击本来就只是确认态）。

### 测试

当前共 **12 套 / 330 项断言 + e2e 21 项 + 29 个磁盘检查点**，全部通过。

## 0.7.1 —— 修复「从回收站恢复后会话消失」

### 现象

回收站里点「恢复」后，会话**在界面上彻底消失**：不在回收站、不在归档区、也不在侧边栏。

### 排查（先查真实磁盘，确认是否为数据丢失）

```
session-40e1e744-…/session.v3.jsonl.zstd   856038 字节  mtime 保留为 09-14 01:59
session-40e1e744-…/session.lock
★ 该会话不在 open 工作区的 sessionIds 记账里
```

**没有数据丢失** —— 文件确实被完整搬回了原位置（mtime 未变，说明是 `rename` 而非复制）。
问题纯粹是**可见性**：侧边栏按工作区成员渲染，而它已不在记账里。

### 根因：逆操作只做了一半

| 步骤 | 删除时 | 恢复时（修复前） |
|---|---|---|
| 文件 | 搬入回收站 | ✅ 搬回原位 |
| 归档集合 | 移出 | —（不需要） |
| **工作区记账** | ✅ `detachSession()` | ❌ **没有 `attachSession()`** |

删除时把会话从工作区记账摘除是**必要的**（否则文件已不在、记账还在，会留下幽灵行）。
但恢复漏掉了对称的挂回操作。这个 bug 的性质与上一个（`live` vs `running`）同源：
**一对互逆操作，只实现了一半**。

### 修法

1. **删除时记录归属**：`buildMeta` 新增 `original.workspaceId` / `workspacePath`，
   在 `detachSession` **之前**从 registry 查出该会话属于哪个工作区并写入回收站元数据。
2. **恢复时挂回**：搬回文件后调用 `reattachToWorkspace()` ——
   优先用记录的 `workspaceId`，老条目（无该字段）退回按 `cwd` 调 `registry.resolveByPath()`；
   调用前先检查"是否已经挂回"，因此**幂等**。响应新增 `reattached` / `reattachVia`。
3. `trash-io.listEntries()` 透出 `workspaceId` / `workspacePath`。

### 针对已经产生的孤立会话：检测 + 一键修复

0.7.1 之前恢复过的会话会遗留为"磁盘上有、任何工作区都不记账"的**孤立会话**，
而用户完全无从察觉（它不在回收站、不在归档区，就是消失了）。
且宿主的 `bootstrap()` 只在首次初始化时按 cwd 重建记账 —— 对已初始化的 home **不会**自愈。

因此新增：

- `detectOrphans()` —— 找出"磁盘上有、未被任何工作区记账、且 cwd 确实对应某个工作区"的会话。
  **只报本该有归属的**：cwd 缺失或不对应任何工作区的会话本就应该显示为未分组，不算孤立。
- `sessionArchive.repairOrphans` 端点 —— 把它们挂回所属工作区，**幂等、非破坏**。
- 客户端：归档页在检测到孤立会话时显示**红色告警条**（含数量与说明）+「修复」按钮。
  之所以做成显式按钮而非启动时静默自愈：本项目一贯避免静默改写用户状态。

### 语义说明（补充到 README）

从回收站恢复 ⇒ 会话回到**原工作区**，处于**未归档**状态（归档标记在删除时已移除）。
所以它出现在正常侧边栏，而不是归档列表里。

### 测试

新增 `[4e]`（6 项，删除/恢复的工作区记账对称性）、`[4f]`（5 项，孤立检测与修复）。
当前共 **12 套 / 341 项断言 + e2e 21 项 + 29 个磁盘检查点**，全部通过。

## 0.7.2 —— 修复「恢复后需手动刷新页面」

### 现象

孤立会话修复成功、归档/删除/恢复整条链路可用，但**恢复后侧边栏不自动更新**，
必须手动刷新页面才看得到恢复回来的会话。

### 根因：删除有"移除"信号，恢复没有"新增"信号

宿主侧两条路径并不对称：

| 路径 | 发给浏览器的信号 |
|---|---|
| 删除 | `api-session/removed` ✅ → 浏览器立即删行 |
| 恢复 | **没有** ❌ → 浏览器不知道多了个会话 |

官方客户端会话列表**只**通过 `api-session/added` / `removed` / `status` / `activity`
这几个事件增量更新，且 `handleSessionAdded(summary)` 是**把 summary 合并进列表**
（不是重新向宿主拉取）。而 `summary` 由宿主的 `ApiSessionList.summaryFor(session)`
构造，需要真实的 Session 对象 —— 恢复出来的会话是冷的，宿主侧无法便宜地构造它。

（尝试过在宿主侧 `import { Session } from '@deepseek-ai/dsh-session'` 自行 restore + announce，
但**该模块无法从本插件解析**：插件位于 profile 之外且无 dependencies，
`ERR_MODULE_NOT_FOUND`。所以这条路走不通。）

### 修法：用官方客户端的全量重列

客户端会话服务以服务键 `"sessions"` 提供，并有 `refresh()` —— 其文档为
"Refresh the real Session baseline"，内部即 `refreshList()`，走 `session.list`
**全量重列**（且单飞复用进行中的拉取）。

因此在客户端操作成功后调用它：

```js
const sessions = ctx.get('sessions')          // 可选获取
if (typeof sessions?.refresh === 'function') {
  try { await sessions.refresh() } catch { /* 降级为手动刷新 */ }
}
```

该成员**不在 `ISessions` 公开契约里**，所以全程 `typeof` 守卫 + `try/catch`：
拿不到就退化为「需要手动刷新」，不影响其它功能。这也是官方生态里既有的用法。

### 为什么放在客户端而不是宿主

宿主侧没有"请重列"的语义（`api-session/added` 需要完整 summary）；而客户端
本来就掌握列表服务，且这条路径与"用户点了按钮"同源，语义更自然。

### 测试

新增 `client.test.mjs [3c]`（5 项）：断言调用了 `sessions.refresh()`、
经 `ctx.get('sessions')` 可选获取、有 `typeof` 守卫与降级告警、
且刷新位于成功分支并与本地视图刷新相邻；并显式断言**不**在
`dsh.client.inject` 里声明该模块（因为只按服务取用、不 `require` 它）。

当前共 **12 套 / 346 项断言 + e2e 21 项 + 29 个磁盘检查点**，全部通过。

## 0.8.0 —— 修复「循环一次后归档会话丢失名称」

### 现象

重启后第一次归档，归档页里能看到会话名称；但重复
「归档 → 删除 → 回收站恢复」之后，归档页里的会话就**只剩 sessionId、没有名称**了。

### 根因：两个动作相互拆台

1. 标题在 DSH 里是**投影**（投影键 `title`，由日志里的 `session/title` 事件折出）。
2. 我此前**只对"实时"（live）会话解析标题** —— 冷会话标题为 `null`，UI 退回显示 sessionId。
3. 而删除时我会 `clearProjectionCache()` 清掉该会话的投影缓存行
   （防幽灵摘要用），**其中就包含标题投影**。
4. 恢复后该行不复存在；若不再打开它，它就一直是冷会话 → 名称消失。

所以"第一次正常"是因为那时会话还是 live（刚看过），"循环后丢失"是因为
删除同时把它的实时态与投影缓存都清掉了。

### 修法：从**日志**回填冷会话标题

标题的真源在会话日志里，不只是内存投影。官方 `sessionQuery.observeSession(id)`
能折出投影值（`projections.values.title`），且它在宿主侧**按 revision 缓存**，
重复调用不会重复读日志。

因此 `handleList` 现在分两层取标题：

1. **实时会话** —— 走原有的 `sessionTitle.get(session)`（权威、零额外开销）；
2. **冷会话** —— 用 `observeSession()` 回填，并加两道约束：
   - **每次调用最多回填 24 个**（`MAX_TITLE_LOOKUPS_PER_CALL`）——
     冷读会读整条日志，不能"打开一次页面就把几十份日志读一遍"；
   - 单个失败只告警跳过（fail-soft），不拖垮整次列表。
3. 观测句柄用完即 `[Symbol.dispose]()` 释放。

`sources` 新增 `titlesLiveOnly` / `titleLookups` / `titleCapped`，便于排查。

### 当时（0.8.0）保留了删除时清投影缓存 —— 这个判断在 0.8.1 被推翻

0.8.0 时我仍把"删除时清投影缓存"当作防摘要残留的安全措施，只补了日志回填来补偿副作用。
**0.8.1 核对官方代码后确认这个措施本身是错的**，详见下一条目。

### 测试

新增 `host.apply.test.mjs [4g]`（5 项）：冷会话标题能回填、`sources` 区分实时与回填、
单个观测失败不影响整体、确实查询了目标会话、`sessionQuery` 缺失时降级为 `null` 且不报错。

当前共 **12 套 / 351 项断言 + e2e 21 项 + 29 个磁盘检查点**，全部通过。

## 0.8.1 —— 修正一个我判断错的"安全措施"

### 现象（两处，同一根因）

1. **回收站条目没有名称**；
2. 多次「删除 → 恢复」后，**侧边栏会话名称长期显示为项目文件夹名**，
   点击打开会话也不恢复，要硬刷新页面才复原。

### 根因：删除时清投影缓存 —— 既无必要，又有害

0.7.x 起我在删除流程里调用了 `clearProjectionCache()`，理由是"防宿主列表继续吐已删会话的摘要"。
**核对官方实现后确认这个理由是错的**：

```js
// ApiSessionList.list()
const records = await this.ctx.sessionQuery.listSessions(signal);   // 磁盘 ∪ 内存
for (const record of records) { ... }                                // 只遍历这些
```

会话条目**只**来自 `listSessions()`（磁盘 ∪ 内存）。投影缓存仅由 `projectionsFor()` 用于
**给"已经在列表里的条目"补充投影**（`summaryFor` / `summarizeCold`）——
它**不可能凭空造出一个已删会话**。已删会话既不在磁盘、也不在内存，压根不会进列表。

而它的害处是实打实的：**同一行缓存里还存着 `title`、`sessionListMetadata` 等派生数据**。
清掉之后：

- 回收站条目只能靠 sidecar 元数据（而我把 `title` 写成了 `null`）→ 无名；
- 恢复回来的会话在宿主列表里**没有投影** → 客户端拿不到标题 → 侧边栏退化成工作区名；
- 打开会话会重建缓存行，但客户端手上那份 list 快照不会自动带上投影 → 需硬刷新。

### 修法

1. **移除 `clearProjectionCache()`**（连带删掉该辅助函数）。缓存行按 `identity`
   （header + inheritedEventCount 的哈希）绑定，同 id 换一份日志会自动失效，
   **留着是安全的**。
2. **删除时把标题写进回收站元数据**：新增 `resolveOneTitle()`
   —— 实时会话走 `sessionTitle.get()`（零开销），冷会话退回 `observeSession()`，
   取不到则为 `null`。删除**前**取值，因为删除后标题投影可能已不在缓存里。

### 测试调整

- `ghost-regression.test.mjs`：把"投影缓存已清理"的断言**反转为**
  "删除流程**不得**调用投影缓存 `delete()`"，并写明理由。
- `host.apply.test.mjs [4h]`（4 项）：实时会话与冷会话删除后，**回收站里都带名称**；
  并断言删除流程零次缓存删除调用。

### 一句复盘

这是我这次开发里**唯一一次把自己的错误判断写进文档又推翻**：
我当时把"清理派生数据"当成了保守做法，却没核对**那份派生数据是否还被别处依赖**。
教训与 0.8.0 那条同源 —— **共享派生存储上的副作用，必须先从"谁还在读它"倒推**。

当前共 **12 套 / 355 项断言 + e2e 21 项 + 29 个磁盘检查点**，全部通过。

## 0.8.2 —— DSH 0.1.7-rc.2 适配核对

DSH 由 `0.1.5-rc.2` 升级到 `0.1.7-rc.2`（跨两个 rc）。逐项核对结果：

### 一、依赖的内部接口：全部存在且形状未变

`connection.fetch.register` / 路由路径规则（`ENDPOINT_SEGMENT_PATTERN` 仍为 `/^[A-Za-z0-9_$.-]+$/`）、
`workspaceRegistry.{list,get,resolveByPath,state,setState,enqueueOperation}`、
`workspace.{record.sessionIds,attachSession,detachSession}`、
`sessionPersistence.{list,root}`、`sessions.detachEntered`、`agents.get().status`、
`sessionTitle.get()`、`sessionQuery.observeSession()`、`title` 投影键、
`session/disposed` 事件、客户端 `sessions.refresh()`、`settings.section` 座位 —— 逐一核对通过。

### 二、新增：**客户端半边的投递验证**（e2e 21 → 29 项）

此前客户端是唯一无法在 Node 中覆盖的部分。这一轮找到了可验证的投递链路：
首页由 `webserver/index-inject` 注入 `window.__DSH_BOOT__`，客户端 bundle 由相对路径
`plugins/??<comma-separated client.js>&rev=…` 投递。

于是 e2e 新增 8 项断言：

- 首页可取、含 `__DSH_BOOT__`；
- **boot 清单里登记了 `dsh-session-archive`**；
- **`dsh-session-archive/client.js` 被排进预载批次**（会被真正投递到浏览器）；
- 投递下来的 bundle 里**确实含本插件客户端代码**、含设置页座位 id、且是
  `__ModuleLoader__.load` 注册格式。

这仍不等于"浏览器里渲染成功"，但把"客户端是否被装配、是否被投递、内容对不对"
这三件事钉住了 —— 此前它们完全没有验证。

### 三、修掉两个问题

**1. `dsh.engines.dsh` 声明是错的（已移除）。**
`semver.satisfies('0.1.7-rc.2', '>=0.1.5-rc.1')` 返回 **false**：
node-semver 规定带预发布的版本，只有区间里存在**同一 `major.minor.patch` 元组**的预发布
比较器时才满足。实测 `*` 与 `>=0.1.5` 同样排除一切预发布 ——
**没有任何静态区间能表达"任意 rc"**。而全递归核对确认 DSH 中**无人读取 `dsh.engines`**，
官方包也都不声明。留着只会误导，故移除；`dsh` 下只保留宿主真正读取的 `bundle` 与 `client`。

**2. `install.mjs` 按**链接字面量**比较符号链接，会误报"指向他处"。**
pnpm 会把 `link:` 依赖规范成**相对**链接：字面量变了，解析结果不变，
旧逻辑却会去改写一个本来完全正确的链接（dry-run 每次都报"计划改动"）。
改为比较 `realpath` 解析后的路径。修复后 dry-run 正确输出"已是目标状态，无需改动"。

### 四、profile 状态

升级重写了 profile 清单（`package.json` 于 09-28 21:22 被改写），
但本插件的条目**完好保留**：依赖声明、bundles 末位、符号链接、**原生行禁用数 0**。

### 测试

新增 `composition.test.mjs [清单契约]`（5 项）与 `install.test.mjs [3b]`（5 项）。
当前共 **12 套 / 365 项断言 + e2e 29 项 + 29 个磁盘检查点**，全部通过。

## 0.8.3 —— DSH 0.2.0-rc.2 适配核对（小版本跃迁）

DSH 由 `0.1.7-rc.2` 升到 **`0.2.0-rc.2`** —— 这是 **minor 跃迁**（0.1 → 0.2），
按 semver 可能含破坏性变更，因此这次查得比前两次更细。

### 结论：适配，无需功能性改动

- **22 项内部接口清点全部通过**（传输层 / 工作区 / 会话 / 标题与查询 / 客户端契约）；
- **e2e 40/40 通过**（刷新到 0.2.0 后重跑，含新覆盖的 live 路径）；
- 本地 **12 套 / 365 项断言**全绿；
- profile 在升级中完好：依赖声明、bundles、符号链接均在，**原生行禁用数 0**；
- `title` 投影形状（`z.string().min(1).nullable()`）、`settings.section` 座位均未变。

### 本轮新增：**live 会话删除路径**纳入 e2e（29 → 40 项）

之前的 e2e 只覆盖**冷会话**，但你日常走的是 live 路径：归档 → 点开看过（变 live）→ 删除。
这条路径会调用 `sessions.detachEntered()`，并依赖 `liveEntryFor` ——
正是 minor 跃迁最可能变的地方。

为此给测试夹具加了能力：用**服务方法**（`sessions.prepare` + `enter` + `announce`，
不 import 任何宿主包）把会话置为真正的 live，并让某个工作区记账它。新增断言：

- 删除前确认为 live；归档列表里标记 `live: true` 且 `running: false`；
- **删除走 live 路径成功**、文件移走；
- **删除后不再是 live**（证明 `detachEntered` 生效 —— 否则会留下幽灵行）；
- live 路径同样**逐字节一致**；恢复后**重新挂回工作区**。

### 过程中的两处自我纠正

1. **给副本改 id 是错的**：我最初把会话目录改名成 `<id>-live` 来构造 live 会话，
   `persistence.open` 立刻报 `corrupt session log: requested id … does not match header id`。
   **会话 id 内嵌在日志头里**，改名即伪造 id。改成复用同一个会话后通过。
   （这次失败反倒验证了插件的 fail-loud：列表把伪造 id 标为 `missing`，
   删除以 `identity-mismatch` 拒绝，**不肯碰任何身份无法验证的目录**。）
2. **沙盒里没有工作区**：harness 起初只把会话置为 live，没有纳入工作区记账，
   于是恢复时 `reattached=false via=none`。补上"确保工作区存在 + attachSession"后通过 ——
   这也顺带在真实宿主上覆盖了 `createCanonical` / `attachSession`。

### 观察

profile 里新出现一个 `dsh-session-copy`（v1.0.0，在侧边栏「…」菜单加"复制会话 ID / 链接"两项），
**不触碰归档集合、回收站与工作区记账**，与本插件无交互。

### 顺带修掉：e2e 每次运行都残留临时目录

`cleanup()` 用 `setTimeout` 延迟删除临时 home，而紧随其后的 `process.exit()` 会**直接杀掉
待执行的定时器** —— 清理从未真正执行，每次运行留下一个 `/tmp/sa-e2e-home-*`。
改为 `await` 同步等待（SIGTERM → 1.2s → SIGKILL → 0.3s → 删目录）后再退出。
修复后连续运行：残留目录 **0**、残留隔离实例 **0**。

### 关于本次会话中断

执行验证时 DSH 于 19:56:33 重启（PID 4698 → 6160），把飞行中的工具调用截断，
结果未落盘。已核对：**无数据损坏**（profile 清单、归档集合、回收站均完好），
无残留隔离实例，临时目录已清理。宿主重启会中断其内运行的一切，属正常副作用。

## 0.9.0 —— 取消归档改用原生入口（与原生的归档视图保持一致）

### 背景：原生现在已经有了 unarchive

我最初写这个插件时，`WorkspaceRegistry` 只有单向的 `archiveSession()`，
公开面没有取消归档入口 —— 所以我自己实现了「`enqueueOperation` + `setState`」。

DSH 0.2.x 起**原生已经有了** `registry.unarchiveSession(sessionId)`，而且它在写状态
**之前**会发一个并行事件：

```js
await this.ctx.parallel("workspace/session-unarchiving", { sessionId });
await this.setState({ ...state, archivedSessionIds: filtered });
```

绕过它意味着：从本插件取消归档时，`workspace/session-unarchiving` 不会发出。
该事件当前唯一的监听者是 `dsh-experimental-worktree`（用于取消进行中的工作树回收）。
本次核对的环境里没有安装 worktree 包，所以**此前无实际影响**，但这是应当修的正确性缺口。

### 改法：原生优先，保留回退

`lib/unarchive.js` 的 `unarchiveSession()` 现在：

1. `hasNativeUnarchive(registry)` 为真时 → 调 `registry.unarchiveSession()`；
2. 否则回退到原先的 `enqueueOperation + setState`（兼容更早的 DSH）。

关键约束：**绝不把原生方法包进我们的 `enqueueOperation`** —— 原生内部自己入队，
嵌套会自等待死锁。因此两次 `state` 读取都在队列之外，仅用于幂等判定、陈旧守卫
与尽力给出 `changed` / `next`；真正的写入由原生原子完成。

所有既有语义原样保留：幂等（未归档不写）、陈旧守卫（提供 `sessionKnown` 且判定不存在时
默认拒绝，需 `allowStale`）、错误码映射（`registry-unreadable` / `session-gone` / `persist-failed`）。
返回值新增 `persistedVia`，标明实际走的是哪条路径。

### 顺带修掉：测试套件会读使用者**真实**回收站

`host.apply.test.mjs` 里有个用例用裸 `mockCtx()` 并断言"回收站为空"，
它读的是真实的 `~/.dsh/session-archive/trash`。使用者一试用回收站，该断言就假失败。
已改为**整文件共用的模块级隔离根**（`DEFAULT_ARCHIVE_ROOT`），并把 6 处
`delete process.env.DSH_SESSION_ARCHIVE_ROOT` 改为恢复该默认值 —— 该套件此后
永远不会再碰真实回收站。清理用**同步** `rmSync`：紧随 `process.exit()` 的异步
`rm()` 会被中断，导致每次运行残留一个 `/tmp/sa-apply-root-*`。

### 测试

新增 `unarchive.test.mjs [原生入口优先]`（9 项）：优先调用、不再 setState、不嵌套队列、
幂等不写入、陈旧守卫、探针抛错保守处理、`allowStale` 放行、原生抛错映射、
原生缺席时回退。

当前共 **12 套 / 374 项断言 + e2e 40 项 + 29 个磁盘检查点**，全部通过。

### 生效条件

改的是宿主半边（`lib/unarchive.js`）→ **需重启 DSH 才生效**。
