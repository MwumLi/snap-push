# snap-push 设计文档

- 日期：2026-09-04
- 状态：已与需求方逐条确认，作为实现依据

## 1. 背景与目标

在使用远程服务器（例如在服务器上运行 opencode 等 AI 编码工具）时，经常需要把**本地截图/图片**传给服务器侧使用。手动 scp 命令繁琐且易错。

snap-push 提供一个**本地零依赖 Web 服务**：浏览器打开页面 → 选择目标服务器 → 截图粘贴或选择图片上传 → 页面立刻给出服务器上的文件路径（若配置了静态服务则同时给出 URL），一键复制即可使用。

## 2. 核心需求（已确认）

1. **技术栈**：Node.js 单文件 `server.js`，**零 npm 依赖**（仅用 `node:http`、`node:crypto`、`node:child_process`、`node:fs`、`node:path`、`node:os` 等标准库），内嵌整页 HTML/CSS/JS。
2. **服务器配置**：在页面手动填写，存于浏览器 localStorage；字段：昵称（可选）、IP、用户名（默认 `root`）、远端目录（默认 `/tmp/snap-push`）、静态 URL 前缀（可选）。日常使用只需下拉选择服务器 + 上传，无需重复输入。
3. **传输方式**：优先 `rsync`，远端无 rsync 时兜底 `scp`；SSH 密钥免密登录（环境已配置好）。
4. **命名与去重（妙传）**：远端文件名恒为 `<md5hex>-<原名>`。上传前通过一条 ssh 命令探测远端文件是否已存在：存在则跳过传输（妙传秒回，`method: skip`）。妙传机制**只依赖远端存在性检查**，与本地保存无关。
5. **本地保存（预览用）**：上传的图片同时落盘到**本机** `SNAP_PUSH_DIR`（默认 `/tmp/snap-push`），命名同为 `<md5>-<原名>`，天然去重。本地保存的目的是**页面预览缩略图**，不承担妙传职责。
6. **默认目标 = 本机**：页面未选择任何服务器配置时，目标就是服务所在机器本身——只落盘本机 `SNAP_PUSH_DIR`，不做远端同步，返回本机路径。
7. **历史严格按当前目标过滤**：切换服务器配置后，页面只显示「已上传到该服务器」的图；未选配置（本机）时显示本地全部图。同一张图要传另一台服务器：切到那台重新选原图/粘贴上传即可（本地一份、各服务器记录各加一条）。
8. **历史持久化**：localStorage 记录每张图被推送到了哪些服务器（含路径/URL/时间/方式），刷新/重开页面不丢；页面加载时用本机目录清单对账（本地文件被删 → 清理对应记录）。

## 3. 架构

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  浏览器（本地）           │  HTTP   │  server.js（本机 127.0.0.1）  │
│  - 目标下拉 + 配置管理     │ ──────▶ │  - POST /upload   收字节      │
│  - 上传区（选图/Ctrl+V）   │         │    · 算 MD5                  │
│  - 历史网格（按目标过滤）   │ ◀────── │    · 落盘 SNAP_PUSH_DIR      │
│  - localStorage 配置/记录 │  JSON   │    · 同步远端(rsync→scp)      │
└─────────────────────────┘         │  - GET /files     预览字节     │
                                    │  - GET /api/library 图库清单   │
                                    │  - DELETE /files  删本机文件   │
                                    └──────────┬───────────────────┘
                                               │ ssh / rsync / scp
                                               ▼
                                    ┌──────────────────────────────┐
                                    │  目标服务器 user@host:<dir>    │
                                    │  （默认 /tmp/snap-push）       │
                                    └──────────────────────────────┘
```

## 4. HTTP 接口定义

服务仅绑定 `127.0.0.1`（`HOST` 环境变量可覆盖），默认端口 `8123`（`PORT` 可覆盖）。

| 方法与路径 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `GET /` | - | 返回内嵌页面 HTML | `text/html` |
| `GET /health` | - | 存活检查 | `{"ok":true}` |
| `POST /upload` | query：`name`（原始文件名，必填）；`host`、`user`、`dir`、`urlBase`（选远程目标时必填；host 为空表示仅本机） | 收图片字节 → 算 MD5 → 落盘本机 `SNAP_PUSH_DIR/<md5>-<原名>`（存在则跳过落盘）→ host 非空则同步远端 | `{"ok":true,"localName":"<md5>-原名","remotePath":"<dir>/<md5>-原名","url":"<urlBase>/<md5>-原名"?,"method":"local"\|"skip"\|"rsync"\|"scp"}` |
| `GET /api/library` | - | 列出本机 `SNAP_PUSH_DIR` 中匹配 `<32位hex>-` 前缀的文件 | `{"files":[{"name","size","mtime"}]}` |
| `GET /files/<name>` | - | 读取本机目录文件字节，按扩展名给 Content-Type | 图片字节 |
| `DELETE /files/<name>` | - | 删除本机文件 | `{"ok":true}` |

## 5. 同步流程（远端目标）

1. **参数校验**：`host`/`user` 仅允许 `[A-Za-z0-9._-]`；`dir` 必须以 `/` 开头、允许 `[A-Za-z0-9._/-]`，去掉尾部 `/`；`name` 仅取 basename 且仅允许 `[A-Za-z0-9._-]`。不合法返回 400 中文错误。所有外部输入**绝不拼接进 shell 字符串**，子进程一律 `spawn(文件, [参数数组])`。
2. **妙传探测**（一条 ssh 完成 mkdir + 存在性检查）：
   ```
   ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <user>@<host> \
       "mkdir -p '<dir>' && (test -f '<dir>/<name>' && echo EXISTS || echo MISSING)"
   ```
   （dir/name 已通过白名单校验，嵌入引号安全；`BatchMode=yes` 确保密钥不可用时快速失败而非挂起等待密码。）
   - 输出含 `EXISTS` → 妙传，`method: "skip"`。
   - ssh 本身失败（免密不通/超时/主机不可达）→ 返回中文错误。
3. **rsync 上传**（MISSING 时）：
   ```
   rsync -az -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
       <SNAP_PUSH_DIR>/<name> <user>@<host>:<dir>/
   ```
   成功 → `method: "rsync"`。
4. **scp 兜底**：rsync 失败且 stderr 含 `not found`（远端未装 rsync）时：
   ```
   scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
       <SNAP_PUSH_DIR>/<name> <user>@<host>:<dir>/<name>
   ```
   成功 → `method: "scp"`。
5. 每个子进程 30 秒超时；任何失败把 stderr 摘要包装成中文错误信息返回页面。

## 6. 前端页面设计

单页内嵌于 `server.js`（模板字符串），无任何外部资源/CDN。

1. **顶部：目标选择**
   - 下拉：`本机（默认）` + 各服务器配置（显示昵称或 IP）
   - 「⚙ 管理」打开配置面板：列表 + 增/改/删表单，字段：昵称（可选）、IP、用户名（默认 root）、目录（默认 `/tmp/snap-push`）、URL 前缀（可选）。存 localStorage key `snap-push.servers`。
2. **上传区**
   - 文件选择（`multiple`，仅图片类型）+ 拖拽 + 截图后 `Ctrl+V` 粘贴（`paste` 事件取 `clipboardData.files`）
   - 上传按钮把每个文件字节 `POST /upload`（query 带当前目标参数与 `name`），逐个显示结果
3. **历史/图库区（按当前目标过滤）**
   - `GET /api/library` 拿本机文件清单 + localStorage 记录（key `snap-push.history`，结构 `{"<md5>-原名": {"orig": 原名, "targets": [{"key","label","host","dir","remotePath","url","method","time"}]}}`）
   - 过滤规则：选中某服务器 → 只显示 `targets` 中含该服务器（按 host+dir 匹配）的文件；本机（未选）→ 显示全部本地图
   - 每个文件：缩略图（`GET /files/<name>`）、推送目标列表（路径/URL/时间/方式）、复制按钮（`navigator.clipboard`）、「删除」按钮（`DELETE /files/<name>` 后刷新并清记录）
4. **对账**：页面加载时以 `GET /api/library` 为准——本地已删除的文件清掉其历史记录。

## 7. 安全与健壮性

- 仅绑定 localhost；不做鉴权（局域网/本机工具定位）。
- 所有外部输入白名单校验 + `spawn` 参数数组（无 shell 注入面）。
- 文件名服务端生成（MD5 前缀），`GET/DELETE /files` 校验 `name` 不含路径分隔符（防穿越），且必须匹配 `<32hex>-` 命名模式。
- 上传体积上限 20MB（超出返回 413）。
- 上传队列串行执行，避免并发 rsync 交叉。

## 8. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8123` | 监听端口 |
| `SNAP_PUSH_DIR` | `/tmp/snap-push` | 本地存储目录（预览图库） |

## 9. 验收标准

1. `node server.js` 启动后浏览器打开 `http://127.0.0.1:8123`，页面正常。
2. 默认（本机）上传截图 → 本机 `/tmp/snap-push/<md5>-原名` 落盘，页面显示路径可复制，缩略图可见。
3. 同图再次上传 → 妙传秒回（skip），本地不重复。
4. 配置一台服务器并切换 → 只显示该服务器的图；上传真实落到远端目录；配置 URL 前缀后 URL 可复制。
5. 同图传另一台服务器 → 本地一份，两台各自历史记录正确；切换下拉过滤正确。
6. 远端无 rsync → scp 兜底成功（method 显示 scp）。
7. 免密失败/超时/主机不可达 → 页面中文错误提示，不崩溃。
8. 刷新页面：服务器配置与历史记录仍在；删除本地文件后记录对账清理。
9. `node --check server.js` 通过；`node --test` 全部用例通过。
