# dsh-session-archive

DSH Web 插件：**会话归档管理** —— 恢复已归档会话、把会话删除到**可恢复的回收站**、以及手动管理该回收站。

> 状态：**已完成并在真实运行环境使用中**。已在 DSH `0.1.5-rc.2` → `0.2.2-rc.5` 上验证，
> 12 套 / 374 项断言 + 真实运行时 e2e 40 项全部通过。

[English](./README_EN.md) · **中文**

---

## 为什么写这个插件

本机先后装过三个同类插件，全部栽在同一处：

| 插件 | 结局 |
|---|---|
| `dsh-session-xc` | 功能齐全，但删除路径不改写宿主生命周期 → **幽灵会话**；每版升级都要重打本地补丁 |
| `dsh-session-manager` | 宿主半边按旧契约（`list()` 返回 header 数组）写，在当前宿主上**静默失效**：删除只隐藏不删文件、恢复必 404，且返回 `200 ok` |
| `@michengai/dsh-archive-manager` | **接管**官方 `workspace` / `session-projection-cache` 两行并替换实现 → 插件半装/半卸就是「原生被禁 + 替代未插 = 两头空」→ **DSH 启动中止**；且自带可改 profile 配置的自更新器 |

本插件把这三条教训固化成设计约束。

## 设计约束（硬性）

1. **只消费原生服务，绝不替换**。不 `disabled` 任何原生行；不接管 `workspace` / `session-projection-cache` / `ui-workspace`。
   最坏情况是**功能缺失**，而不是 DSH 起不来。`install.mjs` 每次运行都会校验这一条，违反即拒绝写入。
2. **不自带更新器**。升级由使用者手动执行，依赖冷却与代码审阅始终在人的手上。
3. **不做 DOM 注入**。客户端只走官方 slot（`settings.section`，`replaceRisk: none` 的加性座位）。
4. **fail-soft 与 fail-loud 分离**：清理动作单个失败不阻断主流程；但「删除」要么真的删掉、要么返回明确错误——**绝不允许「看起来删了其实没删」**。
5. **删除前必须 `stat` 复核**。路径推导见 `lib/paths.js`，那是唯一有误删风险的地方。
6. **绝不静默丢弃回收站条目**。容量/期限只做统计与提示，淘汰必须由人确认。

## 一个关键设计决定：回收站**不能**放在 `sessions/` 内

宿主扫描器不过滤点目录：

```js
listProjectDirs: entries.filter(e => e.isDirectory())   // 无 dot 过滤
listSessionDirs: entries.filter(e => e.isDirectory())   // 无 dot 过滤
```

而 `listArtifacts` 里有：

```js
if (ids.has(header.id)) throw new Error(`duplicate JSONL session id ... appears in multiple project directories`)
```

后果很具体：**只要回收站里留着某个 id 的副本，而该 id 在别处也存在（原地未删、或历史遗留目录），DSH 直接启动失败**。`checkRootEncoding()` 也会遍历 root 下所有 project/session 目录做编码校验，回收站残留同样会被卷进去。

因此回收站放在 `sessions` 根**之外**，且与它**同设备**（`~/.dsh` 下），使 `rename` 走原子的快路径、零拷贝：

```
~/.dsh/session-archive/
├── index.json                             # 仅缓存/便于人工查看；真源是各条目自身
└── trash/
    └── <epochMillis>-<sessionId>/          # 时间戳前缀 = 删除序，天然有序
        ├── session.v<N>.jsonl[.zstd]       # 原会话目录整体搬入
        ├── session.lock
        └── .dsh-archive-meta.json          # 条目自带元数据（随目录走）
```

## 回收站管理策略

| 维度 | 默认 | 超限行为 |
|---|---|---|
| 条目数 | 100 | **不自动删**；标记为「待清理」，UI 提示并可一键清理最旧 N 条 |
| 总体积 | 2 GB | 同上 |
| 保留时长 | 30 天 | 同上 |
| 单条体积 | 200 MB | 拒绝入回收站，提示改为确认后硬删 |

**不做自动淘汰**：回收站的意义就是「删错了还能找回来」；若它在用户不知情时又默默丢掉最旧的条目，等于把恢复能力变成随机抽奖。

- **删除前拦截**：会越过上限 → 返回 `trash-full`，UI 给出「先清理哪几条」的候选（含标题/时间/体积）。
- **每次删除后 / 启动时**：只**统计**超期条目，不删；在回收站入口显示角标。
- **磁盘不足**：拒绝本次删除，而不是先删了再想。

## 操作语义

- **删除**（归档视图 → 删除）⇒ 文件进回收站；同时从归档集合与**工作区记账**中摘除
  （摘记账是必要的：否则文件已不在、记账还在，会留下幽灵行）。
- **恢复**（回收站 → 恢复）⇒ 文件搬回**原路径**，并**重新挂回原工作区**；
  会话回到**未归档**状态，因此出现在正常侧边栏（不是归档列表）。
  若恢复时发现该 id 已被占用或 `createdAt` 不符，则**拒绝**，绝不覆盖。

## 恢复语义（三种情形）

| 情形 | 判定 | 处理 |
|---|---|---|
| 正常 | `original.sessionDir` 存在且空；无同 id 现存日志 | 目录搬回原位 → 清归档标记 |
| 原目录已消失 | 父目录（project 目录）不存在 | 按 `header.cwd` 重建项目目录并搬回 |
| **id 已被复用** | 现存日志 `createdAt` ≠ 记录值 | **拒绝恢复**（`id-reused`），绝不覆盖已有数据 |

## 目录结构

```
patches/dsh-session-archive/
├── package.json              # 含 icon / exports（locale、icon）/ files
├── cordis.patch.yml          # 只 insert 自己一行，不 disabled 任何原生行
├── install.mjs               # 幂等安装/卸载（含"不得禁用原生行"的不变量校验）
├── icon.svg                  # 36×36 插件图标（插件市场/设置页展示用）
├── locale/{en,zh}.json       # meta.title / meta.description / meta.detail
├── docs/
│   ├── DETAIL.md             # 详情文档（仅一行图片）
│   ├── DETAIL.zh.md
│   └── preview.svg           # 640×300 功能预览图（无文字，明暗主题通用）
├── lib/
│   ├── index.js              # 宿主：8 条 /api 路由 + 删除流水线
│   ├── paths.js              # ★ 路径推导（唯一有误删风险的代码）
│   ├── archive-list.js       # 归档列表装配（含标题回填）
│   ├── unarchive.js          # 取消归档（原生优先 + 回退）
│   ├── trash.js              # 回收站纯逻辑（容量/元数据/身份校验）
│   ├── trash-io.js           # 回收站文件操作（逐文件 rename + 反向回滚）
│   └── client.js             # 客户端：settings.section 页面
└── test/                     # 12 套 + e2e（详见「测试」）
```

## 开发阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 包骨架、装配层、`install.mjs`、`lib/paths.js` + 单测、host apply 骨架 | ✅ 完成 |
| **P1** | 宿主只读：归档列表（`lib/archive-list.js` + `list` 路由） | ✅ 完成 |
| **P2** | 宿主恢复：`unarchive`（`lib/unarchive.js` + 路由，含陈旧标记处理） | ✅ 完成 |
| **P3** | 宿主删除：回收站软删全链路（`lib/trash.js` + `lib/trash-io.js` + 3 条路由 + 幽灵回归测试） | ✅ 完成 |
| **P4** | 客户端 UI：`settings.section` 页面（双页签 + 二次确认 + 容量提示） | ✅ 完成 |
| **P5** | 加固：可配置容量、手动批量清理、内容完整性测试、文档 | ✅ 完成 |

### 已验证 / 未验证 的边界（诚实清单）

**已用真实机制验证**（无需重启 DSH）：

| 环节 | 验证方式 |
|---|---|
| 路径编码与宿主一致 | 对照 `~/.dsh/sessions` 下**真实目录名**交叉验证（`paths.disk.test.mjs`） |
| 删除流水线的磁盘效果、失败回滚 | 真实临时目录（`trash-io.test.mjs`、`ghost-regression.test.mjs`） |
| 删除后该 id 在 sessions 树中彻底消失 | 递归扫描真实目录（`ghost-regression.test.mjs`） |
| 内容完整性（删除→恢复逐字节一致） | 真实文件读写（`hardening.test.mjs`） |
| **安装/卸载会改写的 profile 配置** | 沙盒 profile 跑通全生命周期（`install.test.mjs`） |
| **真实 dsh 加载器会把插件行挂进组合** | 隔离 `DSH_HOME` + `dsh --dump-config`（`composition.test.mjs`） |
| 客户端 bundle 格式与座位契约 | Node 内以 mock 环境执行**真实客户端代码**（`client.test.mjs`） |

**已在真实 DSH 运行时验证**（`npm run e2e`）：

在一个**完全隔离的 `DSH_HOME`** 里启动真实 web 实例（另选端口，绝不碰运行中的实例），
用 `dsh` 自身的 launch token 换取浏览器会话 cookie，然后真实调用本插件的 `/api` 路由：

| 验证项 | 结果 |
|---|---|
| 插件在真实运行时挂载、7 条路由注册成功 | ✅ |
| `workspaceRegistry.state.archivedSessionIds` 真实可读 | ✅ |
| 全部依赖服务可用（connection / registry / persistence / sessions / projectionCache / agents） | ✅ |
| launch token → cookie 认证链路 | ✅ |
| 跨站 `Origin` 被官方认证围栏拒绝（403） | ✅ |
| 未认证 / 缺参数请求 fail-loud（400 / 404），不静默成功 | ✅ |
| **完整往返**：真实会话工件 删除 → 回收站 → 恢复，**内容逐字节一致** | ✅ |
| 客户端半边：boot 清单登记、`client.js` 进入预载批次、投递下的 bundle 含本插件代码且为 `__ModuleLoader__` 格式、含设置页座位 id | ✅ |
| **live 会话路径**（打开过再删除，走 `detachEntered`）：删除后不再是 live、可恢复、逐字节一致 | ✅ |
| 恢复到原工作区后 `reattached: true`（含 `createCanonical` / `attachSession`） | ✅ |

**浏览器实际渲染**已由使用者在真实页面确认（页签出现、归档/删除/恢复/彻底清除均可用）。

### 已知的、与实现无关的边界

- 会话工件必须是**规范布局** `session.v<N>.jsonl[.zstd]`。旧扁平布局 `session.jsonl.zstd`
  会被宿主自己的后端拒绝（`legacyLayout`），本插件同样不处理。
- 归档会话的**标题**通过日志回填取得：实时会话走 `sessionTitle`（零开销），
  冷会话走 `sessionQuery.observeSession()`（宿主按 revision 缓存）。
  为控制开销，**每次列表最多回填 24 个**冷会话，其余等下次调用补齐；
  取不到时 UI 退回显示 sessionId。

## 依赖的宿主接口（升级排查用）

`lib/paths.js` 复刻自 `@deepseek-ai/dsh-session-persistence-jsonl` 的**内部**函数（未导出）：
`encodeSegment` / `projectKey` / `projectDir` / `sessionDir` / `logPath`。
`paths.disk.test.mjs` 会拿 `~/.dsh/sessions` 下的**真实目录名**做交叉验证——宿主若改了编码，测试立刻红。

其余计划依赖的宿主接口（**均为内部字段，非公开 API**，是本项目的主要风险来源）：

| 用途 | 接口 | 风险 |
|---|---|---|
| 读/写归档集合 | `workspaceRegistry.state.archivedSessionIds`、`.global.set()` | 中 |
| 摘工作区归属 | `WorkspaceEntity.detachSession(id)` | 低（公开） |
| ~~清投影缓存~~ | **已移除**：核对后确认删除时清缓存既无必要（缓存行无法让已删会话复活）又有害（毁掉 title 等派生数据） | — |
| 发布移除事件 | `sessions.get/flush/liveEntryFor/detachEntered`（实时）<br>`sessionPersistence.open` → `Session.fromRestore` → `enter/announce/detach`（冷） | 低（已在 0.1.5-rc.1 实测通过） |
| 定位会话目录 | `sessionPersistence.locate()`（**未导出**）→ 退回自算路径 | **高** |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH home（默认识别，与 dsh 自身一致） |
| `DSH_SESSION_ARCHIVE_ROOT` | 覆盖回收站根目录（默认 `<DSH_HOME>/session-archive`）。用于测试隔离或把回收站迁到别的盘。 |
| `DSH_SESSION_ARCHIVE_LIMITS` | JSON 覆盖容量策略，如 `{"maxEntries":50,"maxBytes":1073741824,"retentionDays":14,"maxSingleBytes":104857600}`。非法值一律退回默认，**绝不因配置写错而误伤数据**。 |

## API 端点

全部挂在官方 `/api` 围栏下（`isTrustedApiRequest` + cookie 认证），只接受 `POST`：

| 端点 | 作用 |
|---|---|
| `sessionArchive.list` | 列已归档会话（含陈旧标记 `state:'missing'`） |
| `sessionArchive.unarchive` | 恢复归档（`allowStale:true` 才清陈旧标记） |
| `sessionArchive.delete` | 删除到回收站（运行中会话拒绝） |
| `sessionArchive.trash` | 列回收站（含 `broken` 坏条目报告） |
| `sessionArchive.restore` | 从回收站恢复到原位置 |
| `sessionArchive.purge` | 彻底清除单条（不可逆） |
| `sessionArchive.purgeExpired` | 批量清理，需显式指定 `sessionIds` / `oldestCount` / `onlyExpired` |
| `sessionArchive.repairOrphans` | 把「磁盘上有、但无任何工作区记账」的孤立会话挂回原工作区（幂等） |

## 安装

```bash
node install.mjs --dry-run     # 预检：只打印将做的改动
node install.mjs               # 正规 bundle 通道（自动备份）
node install.mjs --remove      # 卸载
```

安装后需**重启 DSH**（bundles 在启动时读取）。

## 版本适配

**已在 DSH 0.2.2-rc.5 上完整验证**（此前 0.2.0-rc.2 / 0.1.7-rc.2 / 0.1.5-rc.2 亦验证过）。

依赖的宿主内部接口（均已逐个核对存在且形状未变）：

| 服务 / 接口 | 用途 |
|---|---|
| `connection.fetch.register({path, methods, requestBody, fetch})` | 注册 `/api` 路由（路径须匹配 `ENDPOINT_SEGMENT_PATTERN`） |
| `workspaceRegistry.{list,get,resolveByPath,state,setState,enqueueOperation}` | 归档集合读写（经串行队列） |
| `workspace.{record.sessionIds,record.path,attachSession,detachSession}` | 删除/恢复时的归属记账 |
| `registry.unarchiveSession()` | 取消归档（**优先**用它，会发 `workspace/session-unarchiving`） |
| `sessionPersistence.{list,root,stat}` | 会话枚举与目录推导 |
| `sessions.{get,detachEntered}` / `agents.get(id).status` | 运行态判定与摘除 |
| `sessionTitle.get(session)` / `sessionQuery.observeSession(id)` | 标题解析（实时 / 冷会话） |
| 事件 `session/disposed` → `api-session/removed` | 通知浏览器移除行 |
| `sessions.{prepare,enter,announce,liveEntryFor,detachEntered}` | live 会话的摘除（删除打开过的会话） |
| `registry.createCanonical` / `workspace.attachSession` | 恢复时挂回工作区 |
| 客户端 `ctx.get('sessions').refresh()` | 恢复后重列核心会话列表 |
| 客户端座位 `settings.section` | 设置页渲染 |

### 为什么不声明 `dsh.engines.dsh`

早期版本声明过 `dsh.engines.dsh: ">=0.1.5-rc.1"`，**这是错的**：

- node-semver 规则规定，带预发布的版本只有在区间里存在**同一 `major.minor.patch` 元组**的
  预发布比较器时才算满足。因此 `>=0.1.5-rc.1` **不匹配** `0.1.7-rc.2`；
  而 `*` 与 `>=0.1.5` 也同样排除一切预发布。**没有任何静态区间能表达"任意 rc"**。
- 全递归核对确认：DSH 0.1.7-rc.2 中**没有任何代码读取 `dsh.engines`**，
  官方包（`dsh-base` / `dsh-web-app` 等）也都不声明它。

因此改为不声明（`dsh` 下只保留宿主真正读取的 `bundle` 与 `client`），
并在本表记录实际验证过的版本。

## 测试

```bash
node test/run.mjs        # 12 套 / 374 项断言（快，无外部依赖）
npm run coverage         # 覆盖率报告（V8 精确覆盖）
npm run e2e              # 真实 DSH 运行时端到端（40 项，起隔离实例，约 1–2 分钟）
```

`npm run e2e` 会在临时 `DSH_HOME` 中启动一个真实 web 实例，因此**不放进默认套件**。
它不改动真实 profile，也不碰运行中的实例。

## 卸载后如何清理运行数据

```bash
rm -rf ~/.dsh/session-archive      # 回收站 + 索引（会永久丢失回收站内容）
```

归档状态存在 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`（原生所有，卸载本插件不影响）。

## License

MIT
