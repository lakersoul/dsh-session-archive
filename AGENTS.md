# dsh-session-archive — 会话交接（给新会话 / 智能体）

DSH Web 插件：**会话归档管理**。在设置页提供「已归档 / 回收站」两个页签，
可以取消归档、把会话**软删除到可恢复的回收站**、恢复或彻底清除，并检测
「磁盘上有、但没有任何工作区记账」的孤立会话。

## 快速事实

| 项 | 值 |
|---|---|
| 包 / 版本 | `dsh-session-archive`，见 `package.json`（当前 `0.9.0`） |
| 形态 | **无构建**：`lib/*.js` 纯 JS；宿主半边 `lib/index.js`（7 条 `/api` 路由），客户端半边 `lib/client.js`（`window.__ModuleLoader__` 工厂） |
| 模块 | `paths`（路径编码复刻）· `archive-list`（列表装配）· `unarchive`（取消归档）· `trash`（回收站纯逻辑）· `trash-io`（文件操作） |
| 安装渠道 | bundle patch（`cordis.patch.yml`）+ profile 的 `link:` 依赖 + `dsh.profile.bundles`；`install.mjs` 是双渠道幂等安装器 |
| 远端仓库 | `ssh://git@ssh.github.com:443/lakersoul/dsh-session-archive.git`（`main`） |
| 已实测 DSH | `0.1.5-rc.2` / `0.1.7-rc.2` / `0.2.0-rc.2` / `0.2.2-rc.5` |
| 本机安装态 | `~/.dsh/profiles/web/package.json` 的 `link:` 指向本目录；`node_modules/dsh-session-archive` 是指向本目录的**符号链接**（没有代码副本） |

## 硬性不变量（改动前先读）

1. **绝不 `disabled` 任何原生行** —— 只消费原生服务，不替换。`install.mjs` 每次运行都会校验
   `workspace` / `session-projection-cache` / `ui-workspace`，违反即拒绝写入并非零退出。
2. **不自带更新器**、**不 DOM 注入**（只注册 `settings.section` 座位）。
3. **删除前必须 `stat` 复核**：目录名须等于 `encodeSegment(id)`、须非符号链接、须含规范日志；
   任一不符即放弃删除（`identity-mismatch`）。
4. **绝不静默丢弃回收站条目**：容量超限只提示并拒绝操作，从不自动清理。
5. **回收站必须在 `sessions/` 之外**：宿主扫描器不过滤点目录，且对重复 id 会抛错。

## 接手时先读

1. `README.md` —— 设计取舍、**依赖的宿主接口（适配表）**、已知限制、验证步骤
2. `lib/index.js` 顶部注释 —— 删除流水线 `[1]…[8]` 每一步的动机（尤其 live/冷两条分支）
3. `test/e2e-runtime.mjs` —— 真实运行时怎么验的（隔离 `DSH_HOME` + launch token 换 cookie）
4. `CHANGELOG.md` —— 版本演进；每个修复都写了**根因**与当时的错误判断

## 改动 → 验证 → 发布

1. `npm run check`（各文件 `node --check`）
2. `node test/run.mjs` —— **12 套 / 374 项断言 + 29 个磁盘检查点**
3. `npm run e2e` —— 起一个**隔离的真实 web 实例**（约 1–2 分钟）：
   宿主 7 条路由、宿主内部字段、认证围栏、客户端 bundle 投递、
   冷会话与 **live 会话**两条「删除→回收站→恢复」往返（逐字节一致）
4. **生效方式**：改 `lib/index.js` 等宿主半边 ⇒ **重启 DSH**；
   改 `lib/client.js` ⇒ **硬刷新页面**（HMR 不监听本目录，别指望热更）
5. **推送**：`git add -A` → conventional commit（`feat:`/`fix:`/`docs:`）→ `git push`
   → 用 `api.github.com` 的 `/git/trees/main?recursive=1` 与 `git ls-tree -r HEAD` 做**字节级复核**

## 推送凭据不在本目录

仓库设了 `core.sshCommand`，硬编码 `/home/slzca/deepseekwork/open/.ssh/id_ed25519`
（工作区根下，**本目录之外**）。

- `github.com` 在本机不可达，必须走 `ssh.github.com:443`（仓库 URL 已如此配置）
- 报 `Permission denied (publickey)` = 私钥不存在或公钥未贴到 <https://github.com/settings/keys>
  （用 `ssh-keygen -l -f <key>.pub` 的指纹核对）
- 不要把私钥、token、`known_hosts` 写进仓库

## DSH 升级后的适配流程

1. 读 `<DSH 安装目录>/docs/upgrade-guide/README.md`，**只挑**影响下列表面的条目：
   包导出、`dsh.bundle` / `dsh.client` 清单、Client 槽位、服务与事件、
   `cordis.yml` 键、持久化数据格式。其余（搜索/LLM/CUA/Forge/Subagent/终端/Office）跳过。
2. 逐项 grep 宿主源码核对**锚点表**（见 README「版本适配」）：
   `connection.fetch.register` / `ENDPOINT_SEGMENT_PATTERN` ·
   `workspaceRegistry.{list,get,resolveByPath,unarchiveSession,createCanonical}` ·
   `workspace.{record.sessionIds,attachSession,detachSession}` ·
   `sessionPersistence.{list,root,open}` · `sessions.{get,prepare,enter,announce,liveEntryFor,detachEntered}` ·
   `sessionTitle.get` · `sessionQuery.observeSession` 的 `projections.values.title` ·
   事件 `session/disposed`、`api-session/added|removed`、`workspace/session-unarchiving` ·
   客户端 `ctx.get('sessions').refresh()` 与 `settings.section` 座位
3. 跑 `npm run e2e`：它会真启动实例并验证上述链路，是升级后最有力的回归。
4. 更新 README「版本适配」与 `CHANGELOG`，提交并推送。

## 容易踩的坑（都是踩过的）

- **`dsh.engines.dsh` 不要声明**：静态 semver 区间无法匹配跨元组的 rc 版本
  （`>=0.1.5-rc.1` 不匹配 `0.2.2-rc.5`）；缺省时回退到 peer 规则，本包无 DSH peer ⇒ 兼容。
- **不能给会话副本改 id**：会话 id 内嵌在日志头里，改名会让 `persistence.open` 判为 corrupt。
- **删除时不要清投影缓存**：那一行里存着 `title`，清掉会让侧边栏名称退化成工作区名。
- **`live` ≠ `running`**：打开过（live）不阻碍删除；只有 agent 真在跑（running）才拒绝。
- **删除/恢复必须对称**：删除 `detachSession` + 发 `api-session/removed`；
  恢复 `attachSession` + 客户端 `sessions.refresh()`。少一半就会出现「幽灵行」或「恢复了却看不见」。
- **测试不得读使用者真实数据**：`host.apply.test.mjs` 用模块级隔离根
  `DEFAULT_ARCHIVE_ROOT`；清理必须**同步** `rmSync`（`process.exit()` 会中断异步 IO）。

## 不要做

- 不要在本 profile 里再装一份 GitHub 副本（与 `link:` 双源会让 `dsh-client-modules` 启动失败）
- 不要动 `patches/` 下其它插件的文件，也不要把私钥或 token 写进仓库
- profile 与 DSH 安装目录都在工作区之外：写入会触发审批，属正常流程
