# snap-push 远端对账与多来源同步 设计文档

- 日期：2026-09-10
- 状态：已与需求方逐条确认，作为实现依据
- 分支：feature/remote-reconcile-sync
- 范围：合并三阶段（对账探测 / 远端缩略图 / pull 与多来源同步）为一份 spec

## 1. 背景与目标

现有 snap-push 的「目标」仅是浏览器 localStorage 里的一份静态配置：切换目标后，历史网格按 `history` 里的推送记录过滤，页面并不了解目标服务器上的真实状态。由此带来三类盲区：

1. 记录声称推过、但远端文件已被后台删除（历史过期）；
2. 远端有别的客户端/实例推上去的图、本地 `history` 没有（localStorage 存储不全）；
3. 本地图库有、远端也有、但本浏览器缺 `history`（换浏览器/换实例后的记录丢失）。

本设计让页面在切换到服务器目标时**异步探测远端真实状态并对账**，并在此基础上提供**远端字节按需读取**与**以本地为中转的多来源同步**能力，最终让「本地 ↔ 各服务器」的图片状态可见、可控、可迁移。

约束（沿用 `AGENTS.md`）：

- `src/server.js` 仅用 Node 标准库，零 npm 依赖；页面内嵌，无外部资源。
- 改动后 `node --check src/server.js` 与 `node --test test/` 必须全绿。
- `README.md` 与 `README.zh-CN.md` 同步更新。

## 2. 已确认决策

1. **来源**：同步抽屉默认来源为本地，可手动选某台服务器；并展示“已缓存的其他服务器命中”提示。
2. **跨服务器**：统一走 `A → 本地 → B` 中转，不做 A→B 直连（本地对 A、B 有 ssh 信任）。
3. **远端缩略图**：懒加载 + 本地临时缓存；取过即缓存，后续走本地。
4. **md5 去重**：pull/同步时若本地已有同 md5 副本，直接复用，不重复下载。
5. **spec 拆分**：三阶段合并为一份文档（本文）。
6. **名称展示**：网格随当前目标；抽屉随来源。
7. **补录匹配**：精确同名优先，否则按 md5；本地同 md5 多文件只补“规范文件”；推送到新目标统一用本地名。
8. **删除**：目标作用域化 + 全部确认弹窗；本机删除可级联删除所有服务器副本；僵尸记录后台自动清、不弹窗。

## 3. 术语与身份

- **节点（node）**：本地（本机图库）或某台服务器目标（`host+dir`）。
- **身份 = 内容 md5**：存储名恒为 `<md5hex32>-<原名>`，前 32 位 hex 即内容 md5。同 md5 不同原名视为同一文件。
- **三份真相**：
  - `L`：本地图库（`GET /api/library` 返回的文件）；
  - `H`：`history`（本地文件的推送记录，语义不变，仅描述本地存在的文件）；
  - `R`：远端清单（某 `host+dir` 目录下的文件）。

## 4. 数据模型

### 4.1 history（语义保持，新增字段）

```js
history[localName] = {
  orig: "原名",
  targets: [{
    key, label, host, dir, remotePath, url, method, time,   // 现有字段
    remoteName,          // 新增：远端真实文件名（可与 localName 不同）
    origin: 'push' | 'recovered',   // 新增：记录来源
    verifiedAt,          // 新增：最近一次远端确认存在的毫秒时间戳
    stale                // 新增：远端已不存在（仅探测成功时置位）
  }]
}
```

- `history` 以本地文件名为键；`pruneHistory`（`src/server.js:1085`）逻辑不改。
- 远端独有（本地无字节）的信息**不进 history**，避免被 prune 清掉。

### 4.2 remoteIndex（新增，持久化于 localStorage，按实例命名空间隔离）

```js
remoteIndex["<host>|<dir>"] = {
  fetchedAt: 1690000000000,
  files: [{ name: "<md5>-orig.png", md5: "<md5hex32>" }]
}
```

- 只存远端清单，用于跨服务器发现与对账。
- 体积控制：仅保留合法文件名；必要时只存差集（后续如遇配额问题再优化）。

### 4.3 servers（新增 status）

```js
servers[i].status = {
  reachable, hasRsync, dirExists, lastProbe, error
}
```

- 持久化“上次已知”，下次打开先显示，再异步刷新。

## 5. 对账规则

触发：页面加载恢复目标 + 每次切换到服务器目标时异步探测；**仅探测成功才执行合并**。

| # | L 本地 | H 记录 | R 远端 | 处理 |
|---|---|---|---|---|
| 1 | ✓ | ✓ | ✓ | 该 target 记录置 `verifiedAt=now` |
| 2 | ✓ | ✓ | ✗ | 置 `stale=true`，归入「远端已缺失」，用户可补齐/清理 |
| 3 | ✓ | ✗ | ✓ | 补录 `origin:'recovered'` 的 target 记录（缩略图用本地字节） |
| 4 | ✓ | ✗ | ✗ | 无动作（仅本机预览 / 未推此目标） |
| 5 | ✗ | ✓ | ✓ | 由 `remoteIndex` 承载，抽屉展示「远端独有·本地缺失」 |
| 6 | ✗ | ✓ | ✗ | prune 自动删（僵尸记录，不弹窗） |
| 7 | ✗ | ✗ | ✓ | 同 #5，由 `remoteIndex` 承载 |
| 8 | ✗ | ✗ | ✗ | 无动作 |

补充规则：

- **探测失败**（ssh 超时/不可达）：忽略本次，不写 `stale`、不改任何记录，直接按现有 history 展示。
- **目录不存在**：`dirExists:false, files:[]`，按“远端为空”处理（等价 #2/#4/#6/#8）。
- **同 md5 不同原名 = 同文件**。
- **#3 补录匹配**：精确同名优先，否则按 md5 前缀；本地同 md5 有多个文件时只补“规范文件”（精确同名 > 最近修改），其余视为重复副本不重复补录。
- **推送到新目标统一用本地名**：`remoteName` 仅用于“对账识别既有远端文件”。

## 6. 命名规则

- **网格（历史图库）**：随当前目标。
  - 本机 → 本地原名；
  - 服务器 A → A 上该文件的原名（`remoteName` → `remotePath` 的 basename → 本地原名）。
- **抽屉（同步）**：随来源。
  - 本地来源 → 本地原名；
  - 服务器来源 → 该服务器上的原名。
- 统一实现为 `displayNameFor(entry, node)`。
- 目标行仍显示完整 `remotePath`；标题与路径在当前目标下保持一致。
- 删除确认框使用当前目标名称。

## 7. 删除规则

删除全部目标作用域化，且**所有用户触发的删除都经确认弹窗**。

| 当前目标 | 弹窗内容 | 动作 |
|---|---|---|
| 服务器 A | 显示 A 上名称 | ssh 删 A 上文件 + 移除 `history[localName].targets` 中 A 的记录 + 更新 `remoteIndex[A]`；本地文件与其他目标记录保留 |
| 本机 | 显示本地名 + 复选项「同时删除所有服务器上的副本」 | 默认只删本地文件并清本地记录（远端不动，之后以「远端独有」重现）；勾选则**先逐台删远端、全部成功后再删本地**，任一台失败即中止、保留本地并报告失败服务器 |
| 服务器 A（远端独有，无本地） | 显示 A 上名称 | ssh 删 A 上文件 + 移除 `remoteIndex[A]` 条目 |
| 批量「清理失效记录」 | 汇总确认 | 仅移除 `stale` target 记录（远端已无，无需 ssh） |

- 僵尸记录（#6）由 `pruneHistory` 后台自动清理，不弹窗。
- 服务器作用域删除后：本地文件仍在 → 切到本机仍可见；切到 A 则消失。
- 本机删除会连带清掉本地全部 target 记录（模型使然），但不删远端文件。

### 7.1 确认模态

`window.confirm` 无法承载复选项，内嵌页新增自定义模态：

```js
showConfirm({ title, message, checkboxLabel? }) → Promise<{ confirmed, checked }>
```

- 一律 `createElement` + `textContent` 构建，禁止 innerHTML（沿用页面安全约定）。
- 按钮「取消 / 删除（danger）」；支持 Esc 关闭、Enter 确认；打开时聚焦危险按钮。
- 所有用户触发的删除（单文件、服务器作用域、级联、批量清理）均走它。

## 8. 服务端改动（仅标准库）

复用现有：`run`、`SSH_ARGS`、`syncToRemote`、`parseTargetParams`、`validateHost/User/Dir`、`isValidStoredName`、`mimeOf`、`ctx.enqueue`、`ensureDir`。

### 8.1 新增纯函数（导出以便单元测试）

- `md5OfName(name)`：取前 32 位小写 hex，非法返回 null。
- `validateRemoteFileName(name)`：`^[A-Za-z0-9._-]+$`（无斜杠/引号，可安全嵌入单引号 shell；兼容手工文件名）。
- `buildRemoteListScript(dir)`：构造一条 ssh 远端命令，输出目录状态标记、rsync 能力标记与 `ls -1` 文件名列表。
- `parseRemoteList(stdout)`：解析为 `{ dirExists, hasRsync, files[] }`。
- 级联删除编排（供本机级联选项使用，抽成可测函数）。

### 8.2 新增接口

1. `GET /api/remote?host=&user=&dir=`
   - 成功：`{ ok:true, dirExists, hasRsync, files:[{name, md5}] }`
   - ssh 失败：`{ ok:false, error }`（前端忽略本次合并）
2. `GET /api/remote-file?host=&user=&dir=&name=`
   - ssh `cat` 流式返回字节；Content-Type 用 `mimeOf(name)`。
   - 先查本地缓存 `snapDir/.remote-cache/<hash(host|dir)>-<name>`（点号子目录，不被 `isValidStoredName` 图库扫描收录；文件名掺入目标身份，避免跨目标同名文件串图）。
   - 新增流式子进程管道函数 `streamRemote()`（现有 `run` 为 utf8 缓冲，不适用二进制）。**实现说明**：验收后为控制内存改为 `runBuffer` 整块缓冲（上限 20MB，与上传一致），功能等价；README 措辞已对齐为“按需读取”。
3. `POST /pull?host=&user=&dir=&name=`
   - 本地已有同 md5 → 直接返回既有文件（去重）；
   - 否则 rsync/scp 取回临时文件 → **校验不超过 `maxBody`（默认 20MB）** → 计算 md5 → 原子 rename 为 `<md5>-<原名>`；
   - 返回 `{ ok:true, localName, remoteName }`；经 `ctx.enqueue` 串行；失败清理临时文件。
4. `DELETE /api/remote-file?host=&user=&dir=&name=`
   - ssh `rm -f`，幂等（文件本就不存在也返回 `{ ok:true }`）。

### 8.3 安全

- `host/user/dir/name` 全部白名单校验后才拼远端命令串；本地子进程一律参数数组，不经 shell（与现状一致）。
- 路由在 `route()`（`src/server.js:1768`）注册。

## 9. 前端改动（内嵌页面）

1. **探测触发**：页面加载恢复目标 + 每次切换到服务器目标时异步 `GET /api/remote`；30s 缓存去重、独立探测队列（约 10s 超时，不占上传队列）、按 targetKey 丢弃过期响应、提供手动「重新对账」按钮。上传/补齐成功后本地直接置 verified。
2. **状态展示**：目标下拉旁状态徽标（检测中/在线/离线/降级 scp）+ 对账摘要（远端独有 N / 已缺失 M）；管理面板服务器行显示上次已知状态。
3. **卡片徽标**：`recovered`（来自远端）、`stale`（远端已删）；「已确认」状态由下拉旁状态徽标与对账摘要体现，避免每张卡片都挂徽标造成噪声。
4. **同步抽屉升级**：
   - 目标 = 当前选中目标（本地或服务器）；来源 = 本地（默认）+ 各服务器；
   - 选择服务器来源时按需探测（或复用 `remoteIndex` 缓存），列出「来源有、目标没有」（按 md5 去重）；
   - 缩略图：本地有 → `/files/<name>`；否则 → `/api/remote-file`（懒加载 + 缓存）；
   - 同步执行：目标为本地 → `/pull`；目标为服务器 → 先确保本地有（必要时 `/pull` 来源），再 `/sync` 到目标；
   - 「切到 B 自动发现 A 有」：靠已缓存的 `remoteIndex`，抽屉给出「来源 A（已缓存）」提示。
5. **删除**：按第 7 节分派 + 自定义确认模态。
6. **清理**：`stale` 批量「清理失效记录」。

## 10. 边界情况

- 远端手工/非法名文件：只要 `validateRemoteFileName` 通过即当作文件；无 md5 前缀的 pull 时先取回算 md5 再命名，不支持去重。
- 孤儿 target 记录（目标配置被删/改）：随目标删除或 prune 清理。
- 本机目标不参与对账。
- 竞态：探测/拉取期间的新上传，按 md5 合并，不整体覆盖；标记 `stale` 时仅当该记录在本次探测发起前已确认（`verifiedAt < probeStartedAt`），避免把探测期间新上传的文件误标失效。
- `validateDir` 额外拒绝含 `..` 路径段的目录（如 `/tmp/../etc`），避免远端读/删能力被放大到父目录。

## 11. 测试计划（`test/server.test.mjs`，node:test）

- 纯函数：`md5OfName`、`validateRemoteFileName`、`buildRemoteListScript` 快照、`parseRemoteList`（目录缺失/有 rsync/无 rsync/含非法名）、对账推导与 `displayNameFor`、级联删除编排。
- HTTP：`/api/remote` 参数校验（缺 host/dir 非法 → 400）；不可达 host → `ok:false`（不依赖真实网络）；`/api/remote-file` 名称校验与缓存命中、`DELETE` 幂等；`/pull` 参数校验与本地同 md5 去重返回。
- 保证 `node --check src/server.js`、`node --test test/` 全绿。

## 12. 文档

- 本文档（三阶段合一）。
- 同步更新 `README.md` 与 `README.zh-CN.md`：新增远端对账、远端缩略图、多来源同步、删除语义的说明与接口表。

## 13. 实施顺序

1. 服务端纯函数 + 接口（remote 清单、流式读取、pull、remote delete、去重）。
2. 前端探测/对账/状态/徽标 + `remoteIndex`。
3. 抽屉升级 + 远端缩略图 + 命名规则 + 删除模态与级联。
4. 测试补齐 → `node --check` + `node --test` 全绿。
5. spec + README 双版更新。

## 14. 验收标准

- 切换服务器目标后异步出现状态徽标与对账摘要；探测失败不影响现有展示。
- 网格标题随当前目标、抽屉标题随来源，切换后名称随之变化。
- 远端独有图在抽屉可见缩略图（ssh 懒加载 + 缓存），可拉回本地；拉回后网格正常显示。
- 目标 B 缺、来源 A 有且本地无 → 一键完成 A→本地→B，最终 B 与本地都有且可显示。
- 服务器删除只影响该目标；本机删除默认不动远端、可选级联且失败中止；所有用户触发的删除均有确认弹窗。
- 同 md5 不同原名不产生重复文件；僵尸记录自动清理；失效记录可批量清理。
- `node --check src/server.js`、`node --test test/` 全通过；README 中英一致。
