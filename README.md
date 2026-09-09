# snap-push

> 中文版：[README.zh-CN.md](./README.zh-CN.md)

Zero-dependency screenshot push service. Paste / drag & drop / pick an image in a local web page, push it to your local machine or any SSH passwordless server in one click, and instantly get a copy-ready remote path (optional URL).

**Typical scenario**: running an AI coding / agent tool on a remote server (e.g. opencode, claude-code, deepseek-harness, hermess-agent)? Snap local screenshots up in seconds — no more typing `scp` by hand. Ctrl+V and copy the server path to use it right away.

## Quick Start

### Option A — run directly via curl (no file saved)

```bash
curl -fsSL https://raw.githubusercontent.com/MwumLi/snap-push/main/src/server.js \
  | node --input-type=module
```

Open <http://127.0.0.1:8123>. Press `Ctrl+C` to stop.

### Option B — download the single file, then run

```bash
curl -fsSL -o snap-push/server.mjs https://raw.githubusercontent.com/MwumLi/snap-push/main/src/server.js
node snap-push/server.mjs
```

> Saved as `.mjs` so Node treats it as an ES module — a single file works without `package.json`. Or just `git clone` the repo and run `node src/server.js`.

## Prerequisites

- Node.js ≥ 18 (standard library only, zero npm dependencies)
- To push to a server: set up **passwordless SSH** to that machine first (`ssh-copy-id user@host`)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SNAP_PUSH_HOST` | `127.0.0.1` | Listen address (loopback only by default) |
| `SNAP_PUSH_PORT` | `8123` | Listen port |
| `SNAP_PUSH_DIR` | `/tmp/snap-push` | Local storage dir for images (preview / library) |
| `SNAP_PUSH_ID_FILE` | `~/.config/snap-push/instance-id` | File persisting the per-instance identity secret (auto-created on first run) |
| `SNAP_PUSH_ID` | *(empty)* | Pin a fixed instance secret (skips reading/writing the identity file) |

> **On `SNAP_PUSH_HOST`**: keep the default `127.0.0.1`. This tool has **no authentication** — it is meant for local dev convenience, and exposing it to a network is unsafe (and not planned). To reach it from another machine, run snap-push on your dev host bound to loopback and forward the port over SSH, then open <http://127.0.0.1:8123> locally:
>
> ```bash
> ssh -N -L 8123:127.0.0.1:8123 user@dev-host
> ```

## Usage

1. **Default target is the local machine**: no remote upload — images land in the local `SNAP_PUSH_DIR`, and the page shows the absolute path.
2. **Push to a server**: click **⚙ Manage** to add a config — nickname (optional), IP, username (default `root`), remote dir (default `/tmp/snap-push`), static URL prefix (optional). Then switch targets from the top dropdown.
3. **Upload** any of three ways: click to pick images, drag & drop into the upload area, or screenshot and paste with `Ctrl+V`. On success the page shows the remote path (plus URL if a prefix is configured) — copy in one click.
4. **History library** is strictly filtered by the current target: picking a server shows only images pushed to it; the local view shows everything.

## Architecture & Scenarios

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

One picture tells the whole story: an image goes from the browser to the local snap-push service (first stored in the local library for preview / history), then is pushed over passwordless SSH to whichever target server is selected in the dropdown — returning a copy-ready remote path, plus a URL when a static prefix is configured. Because the local machine holds the SSH keys for many servers, the same screenshot can be pushed to dev / test / prod machines one after another by just switching the target. Any AI coding / agent tool running on those machines (e.g. opencode, claude-code, deepseek-harness, hermess-agent) can reference the returned path or URL directly.

## Transfer Mechanism

- **rsync first, scp fallback**: if the remote has rsync it transfers with `rsync -az`; otherwise it automatically degrades to `scp`.
- **Naming `<md5>-<original>`**: identical content → identical name → natural dedup.
- **Instant re-upload**: before uploading, a single ssh call compares the remote file's md5. If the content already exists it skips the transfer (`method: skip`, instant). If the same-named remote file has mismatched content (e.g. a leftover partial file), it is treated as missing and re-uploaded to repair it (self-healing).

## FAQ

- **"ssh probe failed"**: passwordless login to the target isn't set up, or the host is unreachable. First verify with `ssh user@host` manually.
- **Remote has no rsync**: nothing to do — it falls back to scp automatically, and the result is labeled `scp`.
- **What is the local dir (`SNAP_PUSH_DIR`) for?** It stores preview images and the library for the page thumbnails. Instant-skip logic only looks at the remote — it is independent of local storage.
- **Where are my configs / history stored?** In the browser's localStorage, namespaced per snap-push instance (header badge `hostname  #hash`). The instance identity is a random secret persisted at `~/.config/snap-push/instance-id` — it deliberately does not depend on IP, so switching networks / VPN / reboots won't make your saved targets "disappear". Lost the file? Pin one with `SNAP_PUSH_ID` (or delete it and start clean in the browser).

## Development

```bash
node --check src/server.js   # syntax check
node --test test/        # run all tests
```

## License

[MIT](./LICENSE) © 2026 MwumLi
