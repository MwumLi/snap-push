# snap-push 图库收录手工图片 + 本机独有 + 可同步 设计文档

- 日期：2026-10-12
- 状态：已与需求方逐条确认，作为实现依据
- 分支：feat/gallery-manual-images-local-only
- 范围：图库收录目录内任意图片（含手工放入、中文名）；本机视图标记「本机独有」；手工图可从同步抽屉推送到服务器；筛选区「独有」开关按目标自适应

## 1. 背景与目标

当前图库只收录文件名符合 `<32位md5>-<原名>` 的文件（`isValidStoredName`），因此手工放进 `SNAP_PUSH_DIR` 的
`logo.png`、`我的图.png` 等既不出现在图库，也无法预览/下载/删除/推送。本次改造：

1. **收录任意图片**：目录内任意图片扩展名、名字安全的文件都进入图库；
2. **本机独有**：本机视图对「无有效推送记录」的图标「本机独有」，与服务器视图的「远端独有」对称；
3. **可同步**：手工图能从「同步」抽屉推送到服务器（远端名沿用本地名）；
4. **筛选对称**：筛选区「独有」开关按当前目标自适应（本机目标→仅本机独有；服务器目标→仅远端独有）。

## 2. 已确认决策

1. 手工图**不计算内容 md5**，按文件名处理。
2. 「本机独有」判定用**历史口径**：`history[name].targets` 为空或全部 `stale`。它与「远端独有」（探测口径）口径不同，文档需注明。
3. 命名沿用「本机独有 / 远端独有」（方案 A）。
4. 「本机独有」标记**只在本机视图**显示；服务器视图行为不变。
5. 文件名允许 **Unicode（中文/空格等）**。
6. 筛选区用**单一自适应开关**。

## 3. 安全文件名校验（`isSafeSegment`）

新增导出函数，用于本地与远端两侧的文件名校验：

```
isSafeSegment(name) :=
  字符串、非空、长度 ≤ 255
  且 name !== '.' && name !== '..'
  且 name 不以 '.' 开头            // 排除点文件与 .tmp 临时文件
  且不含 '/'、'\\'、单引号、控制字符（\u0000-\u001f、\u007f）
```

- 不含 `/`、不以 `.` 开头 → 无路径穿越面（`path.join` 后仍在目标目录内）。
- 禁单引号：远端命令用单引号包裹路径（`'…/name'`），禁 `'` 即杜绝 shell 逃逸；其余字符在单引号内均为字面量，故中文/空格/`$`/反引号/`"` 安全。
- `handleLibrary` 在 `isSafeSegment` 基础上再要求**图片扩展名**（复用 `MIME_BY_EXT`）。

## 4. 服务端改动

| 位置 | 改动 |
|---|---|
| 新增 `isSafeSegment` | 导出，供单测与各处校验 |
| `handleLibrary`(3694) | 收录条件 `isFile && isSafeSegment && 图片扩展名` |
| `handleGetFile`(3704) / `handleDeleteFile`(3720) | 改用 `isSafeSegment && 图片扩展名` |
| `handleSync`(3462) | 名称校验改用 `isSafeSegment`（放行手工本地名，远端名=本地名） |
| `handlePutHistory`(3842) / `handleDeleteHistory`(3853) / `handleBatchHistory`(3866) | 名称校验改用 `isSafeSegment` |
| `validateRemoteFileName`(160) | 放宽为 `isSafeSegment`（远端列表/预览/删除支持中文名） |
| `remoteShellFile`(123) | `~/` 分支改为 `"$HOME/<rel>"` 拼接 `'/<name>'`，单引号承载 name，含 `$`/反引号/`"` 的中文名也安全 |

`isValidStoredName` 保留（md5 前缀识别等仍用）。

## 5. 前端改动（内嵌页面）

1. 新增 `targetHasName(srv, name)`：`findTargetRec(name, srv)` 存在，或该目标 `remoteIndex` 含同名文件。
2. `renderGrid` 服务器视图本地卡片过滤：`targetHasMd5(srv, md5Of(f.name)) || targetHasName(srv, f.name)`（手工图靠历史记录命中）。
3. `renderGrid` 远端独有去重：远端无 md5 文件若与本地**同名**则跳过（避免「本地卡 + 远端独有卡」重复）。
4. 同步抽屉 `missingItems`：无 md5 的项改用 `targetHasName` 判「目标是否已有」，同步成功后不再重复出现。
5. 「本机独有」徽标：`hasValidTarget(name)`；本机视图无有效记录时加 `本机独有`；`stale` 记录仍在下方展示。CSS `.badge-local-only { background:#8250df; }`。
6. 筛选区自适应开关：
   - HTML 由 `remoteOnlyWrap`/`filterRemoteOnly` 更名为 `uniqueFilterWrap`/`filterUnique`，标签为 `<span id="uniqueFilterLabel">`。
   - 状态 `galleryRemoteOnly` → `galleryOnlyUnique`。
   - `renderGalleryToolbar`：两种目标都显示开关，标签按目标设为「仅本机独有」/「仅远端独有」。
   - `renderGrid` 过滤：`galleryOnlyUnique && srv` → 只留远端独有；`galleryOnlyUnique && !srv` → 只留无有效推送记录的本地图。
   - `targetSel` change 时复位该开关。

## 6. 局限（写入文档）

- 手工图无内容 md5 → 远端对账不覆盖（不自动补录/标 stale）；同名不同内容的手工图无法去重。
- 手工图在服务器视图的「是否存在」按历史记录/远端同名清单判定，而非内容。

## 7. 测试

- 单测 `isSafeSegment`：中文/空格通过；`..`、`a/b`、`.tmp`、`.x`、含 `'`、含控制字符、空、超长 → 拒绝。
- `buildProbeScript` / `remoteShellFile` 对中文名快照（单引号承载）。
- HTTP：`logo.png`、`我的图.png` 收录且可 GET/DELETE；`/files/..`、`.x.png`、`a%2Fb.png` 被拒；`POST /sync?name=logo.png` 成功；`PUT/DELETE /api/history/logo.png` 成功。
- 页面冒烟：手工图渲染 + 「本机独有」；「仅本机独有」筛选；服务器视图同名去重；同步抽屉把手工图列为待同步项、同步后消失。

## 8. 验收标准

- `node --check src/server.js` 与 `node --test test/` 全绿。
- 实际服务机器：`SNAP_PUSH_DIR` 放 `logo.png` / `我的图.png` → 本机视图出现且带「本机独有」；预览/下载/删除可用；「仅本机独有」生效；同步抽屉可推到服务器；推送后不再标「本机独有」；服务器视图行为不变。
- README 中英双版一致。
