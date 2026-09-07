# snap-push

> 中文版：[README.zh-CN.md](./README.zh-CN.md)

Zero-dependency screenshot push service. Paste / drag & drop / pick an image in a local web page, push it to your local machine or any SSH passwordless server in one click, and instantly get a copy-ready remote path (optional URL).

**Typical scenario**: running an AI coding tool like opencode on a remote server? Snap local screenshots up in seconds — no more typing `scp` by hand. Ctrl+V and copy the server path to use it right away.

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
| `HOST` | `127.0.0.1` | Listen address (loopback only by default) |
| `PORT` | `8123` | Listen port |
| `SNAP_PUSH_DIR` | `/tmp/snap-push` | Local storage dir for images (preview / library) |

## Usage

1. **Default target is the local machine**: no remote upload — images land in the local `SNAP_PUSH_DIR`, and the page shows the absolute path.
2. **Push to a server**: click **⚙ Manage** to add a config — nickname (optional), IP, username (default `root`), remote dir (default `/tmp/snap-push`), static URL prefix (optional). Then switch targets from the top dropdown.
3. **Upload** any of three ways: click to pick images, drag & drop into the upload area, or screenshot and paste with `Ctrl+V`. On success the page shows the remote path (plus URL if a prefix is configured) — copy in one click.
4. **History library** is strictly filtered by the current target: picking a server shows only images pushed to it; the local view shows everything.

## Transfer Mechanism

- **rsync first, scp fallback**: if the remote has rsync it transfers with `rsync -az`; otherwise it automatically degrades to `scp`.
- **Naming `<md5>-<original>`**: identical content → identical name → natural dedup.
- **Instant re-upload**: before uploading, a single ssh call compares the remote file's md5. If the content already exists it skips the transfer (`method: skip`, instant). If the same-named remote file has mismatched content (e.g. a leftover partial file), it is treated as missing and re-uploaded to repair it (self-healing).

## FAQ

- **"ssh probe failed"**: passwordless login to the target isn't set up, or the host is unreachable. First verify with `ssh user@host` manually.
- **Remote has no rsync**: nothing to do — it falls back to scp automatically, and the result is labeled `scp`.
- **What is the local dir (`SNAP_PUSH_DIR`) for?** It stores preview images and the library for the page thumbnails. Instant-skip logic only looks at the remote — it is independent of local storage.

## Development

```bash
node --check src/server.js   # syntax check
node --test test/        # run all tests
```
