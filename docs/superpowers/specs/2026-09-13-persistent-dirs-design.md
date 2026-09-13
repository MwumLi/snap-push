# snap-push 持久目录、远端 `~` 支持与缓存临时化 设计文档

- 日期：2026-09-13
- 状态：已与需求方确认，作为实现依据
- 分支：feat/server-side-config-history
- 范围：本机图片目录改为持久位置；远端目标目录支持 `~` 并默认 `~/snap-push`；远端缩略图缓存移到系统临时目录

## 1. 背景与目标

原默认 `SNAP_PUSH_DIR=/tmp/snap-push`：`/tmp` 在机器重启后会被清空，本机图库图片随之丢失；页面加载时又会以「本地文件已删除」对账，把对应的 `history.json` 记录一并清掉。即「重启一次，本机图库与历史都没了」。

同时，远端缩略图缓存放在 `SNAP_PUSH_DIR/.remote-cache/`：它只是可随时重建的派生数据，且当前**没有任何淘汰逻辑**，长期会持续占用权威图库目录。

目标：

1. 本机图片落盘目录改为持久位置（默认 `~/snap-push`），重启不丢。
2. 远端目标目录默认改为 `~/snap-push`，与本地概念一致；支持 `~/...` 形式的家目录路径。
3. 远端缩略图缓存移到系统临时目录，重启丢失无所谓、由系统自动清理。

约束（沿用 `AGENTS.md`）：`src/server.js` 仅用 Node 标准库、页面内嵌无外部资源；改动后 `node --check src/server.js` 与 `node --test test/` 必须全绿；README 中英文同步。

## 2. 已确认决策

1. **本机图片目录**：默认 `~/snap-push`（`SNAP_PUSH_DIR` 仍可覆盖）。**不迁移** `/tmp/snap-push` 旧数据。
2. **远端目标目录**：默认 `~/snap-push`；实现 `~` 支持（校验 + 远端 shell 展开 + 前端放开）。
3. **缓存目录**：默认 `os.tmpdir()/snap-push-cache-<uid>`（按用户隔离），新增 `SNAP_PUSH_CACHE_DIR` 覆盖。

## 3. 本机图片目录

- `DEFAULT_SNAP_DIR = () => path.join(os.homedir(), 'snap-push')`。
- 新增导出 `resolveSnapDir(opts)`：`opts.snapDir` → `SNAP_PUSH_DIR` → 默认，与 `resolveConfigDir` 对称，便于测试。
- `createServer` 与 `start()` 统一走该解析。
- 目录按需创建（`ensureDir`），无迁移逻辑。

## 4. 远端 `~` 支持

### 4.1 校验

`validateDir`（服务端）与页面 `validDir` 允许两种形式：

- 绝对路径 `/...`；
- 家目录 `~/...`，其中 `~` 仅允许出现在开头两字符。

其余仍走字符白名单 `[A-Za-z0-9._/-]`，并**拒绝**：裸 `~`（家目录根）、裸 `/`、任何 `..` 路径段；尾部斜杠归一（`~/snap-push/` → `~/snap-push`）。

### 4.2 远端 shell 安全展开

新增两个辅助函数，供所有把目录嵌入远端命令的地方使用：

- `remoteShellDir(dir)`：绝对路径 → `'/tmp/x'`（单引号，无展开，与改造前一致）；`~/x` → `"$HOME/x"`（远端 shell 展开家目录）。
- `remoteShellFile(dir, name)`：绝对路径 → `'/tmp/x/a.png'`；`~/x` → `"$HOME/x/a.png"`。

安全性：`~/x` 中 `x` 与 `name` 均已过白名单（不含 `$`、反引号、引号、空格、分号），因此双引号内只有 `$HOME` 会被展开，无注入面。使用点：`buildProbeScript`、`buildRemoteListScript`、`/api/remote-file` 的 `cat`、`/api/remote-file` DELETE 的 `rm -f`。

`rsync`/`scp` 的 `user@host:${dir}/...` 保持不变，`~/snap-push` 依赖远端 shell/rsync 对 `~` 的标准展开。

### 4.3 前端

管理表单远端目录默认值/占位改为 `~/snap-push`；`validDir` 与服务端校验规则一致（含 `..` 拒绝，此前前端未拒绝 `..`，本次对齐）。

## 5. 缓存目录

- `DEFAULT_CACHE_DIR = () => path.join(os.tmpdir(), 'snap-push-cache-<uid>')`，按 uid 隔离避免多用户权限冲突。
- 新增导出 `resolveCacheDir(opts)`：`opts.cacheDir` → `SNAP_PUSH_CACHE_DIR` → 默认。
- `createServer` 计算 `cacheDir` 放入 `ctx`；`remoteCachePath(cacheDir, host, dir, name)` 首参由 snapDir 改为 cacheDir（键仍含 `host|dir` 短 hash 防串图）；`/api/remote-file` GET/DELETE 使用 `ctx.cacheDir`。
- 缓存可随时丢失：命中失败即重新 ssh 取回；系统会清理临时目录。

## 6. 测试

- `validateDir`：`~/snap-push`、`~/snap-push/`、`~/a/b` 合法；`~`、`~snap-push`、`~/../etc`、`~/a/../b` 非法。
- `buildRemoteListScript` / `buildProbeScript`：绝对路径快照不变；`~/snap-push` 断言输出 `"$HOME/snap-push"`。
- `resolveSnapDir` / `resolveCacheDir`：默认值与 option/env 覆盖。
- `/api/remote-file` 缓存测试改用注入的 `cacheDir`。
- 回归：`node --check`、`node --test`。

## 7. 非目标

- 不迁移 `/tmp/snap-push` 旧图片。
- 不改变 `SNAP_PUSH_CONFIG_DIR`（`~/.config/snap-push`）与同步算法。
- 不改变远端默认目录对「静态服务托管」的要求：默认值只是占位，需长期存活时用户应显式配置持久目录。
