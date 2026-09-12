# snap-push 服务端配置与数据目录 设计文档

- 日期：2026-09-13
- 状态：已与需求方逐条确认，作为实现依据
- 分支：feat/server-side-config-history
- 范围：把浏览器 localStorage 中的服务器配置与同步记录迁移到服务端 app 配置/数据目录，并定义该目录的文件布局

## 1. 背景与目标

当前 snap-push 把两类数据存在浏览器 `localStorage`：

- `servers`：服务器配置（昵称/IP/用户名/目录/URL 前缀），并按实例 `#hash` 命名空间隔离；
- `history`：每张图推送到哪些目标的记录（路径/URL/时间/方式）。

这带来几个问题：

1. 配置与历史**只属于某一个浏览器**：换浏览器、清缓存、换设备后需要重新配置、历史丢失；
2. 同一实例被多个浏览器访问时，配置/历史各存一份，无法共享；
3. 数据散落在浏览器，服务端无法统一管理与备份。

本次改造把 `servers` 与 `history` 移到服务端本地文件，通过细粒度接口读写；浏览器只保留「用户偏好」性质的 `target`（当前目标）与可随时重建的 `remoteIndex`（远端清单缓存）。

约束（沿用 `AGENTS.md`）：

- `src/server.js` 仅用 Node 标准库，零 npm 依赖；页面内嵌，无外部资源。
- 改动后 `node --check src/server.js` 与 `node --test test/` 必须全绿。
- `README.md` 与 `README.zh-CN.md` 同步更新。

## 2. 已确认决策

1. **存储位置**：定义 `~/.config/snap-push/` 为 app 配置与数据目录（`SNAP_PUSH_CONFIG_DIR` 可改）。
2. **文件布局**：`instance-id`（已有身份 secret）、`servers.json`（服务器配置）、`history.json`（同步记录），各自独立。
3. **不迁移**：不读取、不导入浏览器里已有的旧 `localStorage` 配置/历史；服务端从空开始。
4. **浏览器保留**：`target`（当前目标）与 `remoteIndex`（远端清单缓存）继续存 `localStorage`。
5. **接口粒度**：细粒度增删改——servers 用 `GET/POST/PATCH/DELETE`，history 用 `PUT 单条 + DELETE 单条 + batch`。
6. **探测 status 不落盘**：`status` 属及时性信息，仅存页面内存，刷新后重新探测，不写入 `servers.json`。

## 3. 目录与文件

```
~/.config/snap-push/            # app 配置与数据目录（SNAP_PUSH_CONFIG_DIR 可改）
├── instance-id                 # 实例身份 secret（已有，0600）
├── servers.json                # 服务器配置数组
└── history.json                # 同步记录对象
```

### 3.1 `servers.json`

```json
[
  { "id": "s...", "label": "测试机", "host": "192.168.1.10", "user": "root", "dir": "/tmp/snap-push", "urlBase": "https://cdn.example.com/snap" }
]
```

- 纯配置，**不含** `status`。
- `id` 由客户端生成（`s` + 时间戳 base36 + 随机），服务端保证唯一。

### 3.2 `history.json`

```json
{
  "<localName>": {
    "orig": "原名.png",
    "targets": [
      { "key": "s...", "label": "测试机", "host": "...", "dir": "/tmp/...", "remoteName": "...", "remotePath": "...", "url": "", "method": "rsync", "origin": "push", "time": "ISO", "verifiedAt": 0, "stale": false }
    ]
  }
}
```

- 键为本地存储名 `<md5hex32>-<原名>`。
- 结构与现有浏览器端 `history` 完全一致，页面逻辑无需改数据形状。

## 4. 存储层

新增通用 JSON 存储 `createJsonStore(file, fallback)`：

- `read()`：同步读取并 `JSON.parse`；文件缺失、内容损坏、形状不符（servers 非数组 / history 非对象）时回退 `fallback`，绝不抛异常。
- `update(mutator)`：串行化 read-modify-write；`mutator(state)` 同步修改 `state` 并返回结果；随后**原子写**（写同目录临时文件 → `fs.renameSync` 覆盖），文件权限 `0600`。
- 每个 store 一条内部 Promise 写链，保证同一文件的写入不交叉；不同文件（servers / history）互不阻塞。

`createServer(options)` 新增 `configDir` 注入（默认 `SNAP_PUSH_CONFIG_DIR` 或 `~/.config/snap-push`）；内部创建两个 store：

- `serversStore = createJsonStore(path.join(configDir, 'servers.json'), [])`
- `historyStore = createJsonStore(path.join(configDir, 'history.json'), {})`

`instance-id` 默认路径同步改为 `${configDir}/instance-id`，`SNAP_PUSH_ID_FILE` 仍可显式覆盖。

## 5. HTTP 接口

### 5.1 servers

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/servers` | 返回 `{ ok, servers: [...] }` |
| POST | `/api/servers` | 新增一条；body 为完整对象（含客户端生成的 `id`）；id 重复返回 409 |
| PATCH | `/api/servers/:id` | 局部更新 `label/host/user/dir/urlBase`；不存在返回 404 |
| DELETE | `/api/servers/:id` | 删除配置；历史记录保留（沿用现有语义） |

### 5.2 history

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/history` | 返回 `{ ok, history: {...} }` |
| PUT | `/api/history/:name` | 覆盖式 upsert 单条 `{ orig, targets }`；`name` 必须为合法存储名 |
| DELETE | `/api/history/:name` | 删除单条（不存在也返回 ok，幂等） |
| POST | `/api/history/batch` | body `{ upserts: {name: entry}, deletes: [name] }`，用于对账/批量清理，原子应用 |

### 5.3 校验与限额

- 复用 `validateHost` / `validateUser` / `validateDir`；`urlBase` 为空或以 `http://` / `https://` 开头。
- history 键必须通过 `isValidStoredName`；targets 中 `host/dir` 通过白名单校验。
- 请求体上限 4MB（复用 `readBodyWithLimit`）；非法输入返回 400 中文错误。
- 路径段用 `safeDecode` 解码，非法编码返回 400。

## 6. 页面改造

- 初始 `servers = []`、`history = {}`；删除 `SERVERS_KEY` / `HISTORY_KEY` 及其 legacy 迁移（`target` 的命名空间迁移保留）。
- 新增读取 `loadServers()` / `loadHistory()` 与写入包装 `createServer / updateServer / deleteServer / saveHistoryEntry / deleteHistoryEntry / batchHistory`。
- **status 改内存**：`var serverStatus = {}`（`id → {reachable,dirExists,hasRsync,error,lastProbe}`）；`saveServerStatus` 同步写内存、不发请求；`renderStatus` 改读 `serverStatus[srv.id]`；编辑改 host/dir 或删除服务器时清除对应项。
- 写入点改异步并 await：`applyProbe`（含 `reconcileWithRemote`）、`removeServer`、服务器表单 submit、`recordUpload`、`reconcile`、`dropTargetRecord`、`removeFromLocal`、`cleanStale`（对账/清理走 batch）。
- 启动改异步：`await Promise.all([loadServers(), loadHistory()])` → `renderTargetSel()` → `await refreshHistory()` → 探测上次目标。
- 写失败：`hint('保存到服务端失败：…', true)`，保留内存态、不阻断操作。

## 7. 空 history 的行为

服务端初始为空时，切到服务器目标仍按现有对账逻辑**自动补录**：探测成功后，对「本地存在且远端同 md5」的文件补 `origin:'recovered'` 记录（`reconcileWithRemote`）。本地已删/远端独有的文件显示为「远端独有」，不进 history；离线时不补，待成功探测或「重新对账」。

## 8. 测试

- 后端：`createJsonStore` 往返、损坏回退、并发串行；servers/history 接口增删改查、409/404/400、batch、重启后文件仍在、路径名与体积校验。
- 页面：更新 `new Function` 沙箱测试的 fetch 垫片，从变量返回 `{servers}` / `{history}`，移除 `snap-push.servers` / `snap-push.history` 预置。
- 回归：`node --check src/server.js`、`node --test test/`。

## 9. 文档

- `README.md` 与 `README.zh-CN.md` 同步：目录/文件说明、`SNAP_PUSH_CONFIG_DIR`、HTTP 接口表、FAQ「配置/历史存哪」。

## 10. 非目标

- 不迁移浏览器旧数据。
- 不做多用户/鉴权（工具仍仅监听回环、无认证）。
- 不改变图片落盘目录的环境变量名（`SNAP_PUSH_DIR`）与同步算法；其默认值与缓存目录调整见 `2026-09-13-persistent-dirs-design.md`。
