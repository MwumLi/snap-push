# snap-push

> English version: [README.md](./README.md)

本地零依赖的截图推送服务：在浏览器里粘贴/拖拽/选择图片，一键推送到本机或任意 ssh 免密的服务器，立刻拿到可复制的远端文件路径（可选 URL）。

**典型场景**：在服务器上跑 opencode 等 AI 编码工具时，把本地截图快速传上去——不用再手敲 `scp` 命令，`Ctrl+V` 粘贴即得服务器路径，复制即可引用。

## 快速开始

### 方式 A —— curl 直接运行（不保存文件）

```bash
curl -fsSL https://raw.githubusercontent.com/MwumLi/snap-push/main/server.js \
  | node --input-type=module
```

浏览器打开 <http://127.0.0.1:8123> 即可使用，`Ctrl+C` 停止。

### 方式 B —— 下载成单文件后运行

```bash
curl -fsSL -o snap-push/server.mjs https://raw.githubusercontent.com/MwumLi/snap-push/main/server.js
node snap-push/server.mjs
```

> 存为 `.mjs` 让 Node 按 ES 模块解析——单文件无需 `package.json` 即可运行。也可以直接 `git clone` 仓库后执行 `node server.js`。

## 前置条件

- Node.js ≥ 18（仅用标准库，零 npm 依赖）
- 推送到服务器前需先配置好该机器的 **ssh 免密登录**（`ssh-copy-id user@host`）

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址（默认仅本机回环） |
| `PORT` | `8123` | 监听端口 |
| `SNAP_PUSH_DIR` | `/tmp/snap-push` | 本机图片落盘目录（页面预览/图库用） |

## 使用说明

1. **默认目标是本机**：不上传远端，图片落盘本机 `SNAP_PUSH_DIR`，页面直接给出绝对路径。
2. **推送到服务器**：点顶部「⚙ 管理」添加配置——昵称（可选）、IP、用户名（默认 `root`）、远端目录（默认 `/tmp/snap-push`）、静态 URL 前缀（可选）。之后顶部下拉切换目标即可。
3. **上传**三种方式任选：点击选择图片、拖拽进上传区、截图后 `Ctrl+V` 直接粘贴。上传完成页面给出远端路径（配了 URL 前缀则同时给 URL），一键复制。
4. **历史图库**：严格按当前所选目标过滤——选中某服务器只显示已推到那台的图，本机视图显示全部。

## 传输机制

- **rsync 优先，scp 兜底**：远端装了 rsync 就走 `rsync -az` 增量传输；远端没有 rsync 时自动降级为 `scp` 直传。
- **文件命名 `<md5>-<原名>`**：内容相同即同名，天然去重。
- **同内容妙传**：上传前用一条 ssh 比对远端文件 md5，同内容直接跳过传输（`method: skip`，秒回）。若远端同名文件内容不符（如残缺残留），会判定为缺失并重新上传修复（自愈）。

## 常见问题

- **报「ssh 探测失败」**：目标机器免密未配置或网络不通，先手动 `ssh user@host` 验证能否免密登录。
- **远端没装 rsync**：无需处理，自动用 scp 兜底，上传结果会标注 `scp`。
- **本地目录（`SNAP_PUSH_DIR`）的作用**：存预览图与图库记录，供页面显示缩略图；妙传判断只看远端，与本地保存无关。

## 开发

```bash
node --check server.js   # 语法检查
node --test test/        # 运行全部测试
```
