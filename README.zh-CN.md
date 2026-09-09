# snap-push

> English version: [README.md](./README.md)

本地零依赖的截图推送服务：在浏览器里粘贴/拖拽/选择图片，一键推送到本机或任意 ssh 免密的服务器，立刻拿到可复制的远端文件路径（可选 URL）。

**典型场景**：在服务器上跑 opencode、claude-code、deepseek-harness、hermess-agent 等 AI 编码 / Agent 工具时，把本地截图快速传上去——不用再手敲 `scp` 命令，`Ctrl+V` 粘贴即得服务器路径，复制即可引用。

## 快速开始

### 方式 A —— curl 直接运行（不保存文件）

```bash
curl -fsSL https://raw.githubusercontent.com/MwumLi/snap-push/main/src/server.js \
  | node --input-type=module
```

浏览器打开 <http://127.0.0.1:8123> 即可使用，`Ctrl+C` 停止。

### 方式 B —— 下载成单文件后运行

```bash
curl -fsSL -o snap-push/server.mjs https://raw.githubusercontent.com/MwumLi/snap-push/main/src/server.js
node snap-push/server.mjs
```

> 存为 `.mjs` 让 Node 按 ES 模块解析——单文件无需 `package.json` 即可运行。也可以直接 `git clone` 仓库后执行 `node src/server.js`。

## 前置条件

- Node.js ≥ 18（仅用标准库，零 npm 依赖）
- 推送到服务器前需先配置好该机器的 **ssh 免密登录**（`ssh-copy-id user@host`）

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SNAP_PUSH_HOST` | `127.0.0.1` | 监听地址（默认仅本机回环） |
| `SNAP_PUSH_PORT` | `8123` | 监听端口 |
| `SNAP_PUSH_DIR` | `/tmp/snap-push` | 本机图片落盘目录（页面预览/图库用） |
| `SNAP_PUSH_ID_FILE` | `~/.config/snap-push/instance-id` | 实例身份 secret 的持久化文件位置（首次运行自动创建） |
| `SNAP_PUSH_ID` | （空） | 固定实例 secret（跳过身份文件的读写） |

> **关于 `SNAP_PUSH_HOST` 的提醒**：保持默认 `127.0.0.1`。本工具**没有任何认证**，定位是本地研发提效的小工具，暴露到网络不安全，也暂不计划支持。若要在服务器/远程机器上使用，请在开发机上保持回环监听，用 ssh 把本地端口转发过去，再在本地浏览器打开 <http://127.0.0.1:8123>：
>
> ```bash
> ssh -N -L 8123:127.0.0.1:8123 user@开发机
> ```

## 使用说明

1. **默认目标是本机**：不上传远端，图片落盘本机 `SNAP_PUSH_DIR`，页面直接给出绝对路径。
2. **推送到服务器**：点顶部「⚙ 管理」添加配置——昵称（可选）、IP、用户名（默认 `root`）、远端目录（默认 `/tmp/snap-push`）、静态 URL 前缀（可选）。之后顶部下拉切换目标即可。
3. **上传**三种方式任选：点击选择图片、拖拽进上传区、截图后 `Ctrl+V` 直接粘贴。上传完成页面给出远端路径（配了 URL 前缀则同时给 URL），一键复制。
4. **历史图库**：严格按当前所选目标过滤——选中某服务器只显示已推到那台的图，本机视图显示全部。

## 架构与场景

```
            你的本机 / 开发机（持有多台目标服务器的免密 ssh 密钥）
 ┌──────────────────────────────────────────────────────────────┐
 │  浏览器 127.0.0.1:8123（本机直开，无需改 SNAP_PUSH_HOST）        │
 │  顶部下拉选目标 + 粘贴 / 拖拽 / 选图 → 图片字节                   │
 └───────────────────────────┬──────────────────────────────────┘
                             ▼
                 snap-push 本地服务（src/server.js）
                 ① 落盘本机图库 /tmp/snap-push/<md5>-<原名>
                    → 预览 / 历史（同一份，多目标共享）
                 ② 对该目标 ssh 探测是否已存在同内容
                    → 已存在：妙传跳过（method: skip）
                    → 否则：rsync -az 推送（method: rsync）
                      （远端无 rsync 时自动降级 scp）
      ┌─────────────────┬─────────────────┬─────────────────┐
      ▼ rsync/scp       ▼ rsync/scp       ▼ rsync/scp       ▼ …
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ 目标A · 开发   │ │ 目标B · 测试 │ │ 目标C · 预发 │ │ 更多服务器    │
│ 返回路径 / URL │ │ 返回路径 / URL│ │ 返回路径 / URL│ │ 同左         │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
    切换下拉即可把同一张图推给不同目标；历史按所选目标过滤（配静态前缀则附 URL）
```

一图看懂整条链路：图片经浏览器 → 本地 snap-push 服务（先落盘本机图库，用于预览 / 历史）→ 经免密 ssh 推送到下拉所选的目标服务器，返回可复制的远端路径（配置了静态前缀则附 URL）。因为本机持有多台服务器的免密密钥，切换下拉即可把同一张截图依次推到开发 / 测试 / 生产等不同机器；各目标机上运行的 AI 编码 / Agent 工具（如 opencode、claude-code、deepseek-harness、hermess-agent 等）均可直接引用返回的路径或 URL。

## 传输机制

- **rsync 优先，scp 兜底**：远端装了 rsync 就走 `rsync -az` 增量传输；远端没有 rsync 时自动降级为 `scp` 直传。
- **文件命名 `<md5>-<原名>`**：内容相同即同名，天然去重。
- **同内容妙传**：上传前用一条 ssh 比对远端文件 md5，同内容直接跳过传输（`method: skip`，秒回）。若远端同名文件内容不符（如残缺残留），会判定为缺失并重新上传修复（自愈）。

## 常见问题

- **报「ssh 探测失败」**：目标机器免密未配置或网络不通，先手动 `ssh user@host` 验证能否免密登录。
- **远端没装 rsync**：无需处理，自动用 scp 兜底，上传结果会标注 `scp`。
- **本地目录（`SNAP_PUSH_DIR`）的作用**：存预览图与图库记录，供页面显示缩略图；妙传判断只看远端，与本地保存无关。
- **我的服务器配置/历史存在哪？** 存在浏览器 localStorage，并按 snap-push 实例命名空间隔离（头部徽标 `hostname  #hash`）。实例身份是一个持久化在 `~/.config/snap-push/instance-id` 的随机 secret，刻意不依赖 IP——切换网络/VPN/重启都不会让你保存的目标「丢失」。身份文件丢了？可用 `SNAP_PUSH_ID` 固定一个（或删除后浏览器里重新开始）。

## 开发

```bash
node --check src/server.js   # 语法检查
node --test test/        # 运行全部测试
```

## 开源协议

[MIT](./LICENSE) © 2026 MwumLi
