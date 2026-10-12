# snap-push 图库选择与筛选增强 变更总结 Spec

- 日期：2026-10-12
- 分支：feat/gallery-marquee-select（当前）
- 提交范围：`1be872d..3b7326f`（含 `0646052` 起共 7 个提交）
- 目的：把这一系列「图库选择与筛选」相关变更汇总为一份设计文档留存；逐功能细节另见同目录下各专题 spec。

## 1. 背景与范围

从「图库批量选择删除与筛选」(#8) 起，图库经历了一轮围绕**选择 / 筛选 / 批量操作**的能力增强，
并在后续修复中补齐了交互与一致性细节。本文覆盖如下提交：

| 提交 | 类型 | 标题 |
|---|---|---|
| `0646052` | feat (#8) | 图库批量选择删除与筛选（文件名 / 仅远端独有 / 全选） |
| `e5d3b3d` | feat (#9) | 图库收录手工图片 + 本机独有标记 + 可同步 |
| `127c140` | feat | 图库支持鼠标画框批量选择 |
| `814ed9c` | feat | 画框起手区放宽到图库区周边空白 |
| `b3eb08b` | fix | 画框自动滚动时随内容延伸（坐标改用文档稳定系） |
| `4fa3a79` | feat | 图库新增「清空选择」（按需显示 + Esc 快捷键） |
| `3b7326f` | fix | 清空选择/全选后卡片仍显示勾选（直接改 DOM 未同步签名） |

约束（沿用 `AGENTS.md`）：`src/server.js` 仅用 Node 标准库、零 npm 依赖；页面内嵌、无外部资源；
页面 JS 位于外层模板字符串内（禁反引号/反斜杠/`${`）；改动后 `node --check` 与 `node --test` 必须全绿；
README 中英双版同步。

## 2. 功能变更总览

1. **批量选择与筛选**（#8）：图库工具条支持按文件名筛选、「仅独有」开关、全选/取消全选、批量删除；
   每张卡片带勾选框；删除按当前目标作用域。
2. **收录手工图片 + 本机独有 + 可同步**（#9）：图库收录目录内任意图片（含手工放入、中文名）；
   本机视图对未推送过的图标「本机独有」；手工图可经同步抽屉推送。
3. **画框批量选择**（127c140/814ed9c/b3eb08b）：在空白处拖拽矩形批量选择，追加/Alt 减选、边缘自动滚动、
   起手区放宽到图库区周边空白、滚动时框随内容延伸。
4. **清空选择**（4fa3a79/3b7326f）：按需显示的「清空选择」按钮 + Esc 快捷键；修复直接改 DOM 后
   签名不同步导致清空/全选失效的问题。

**无新增 HTTP 接口**：选择/筛选均为前端行为；#9 仅放宽既有接口的名称校验。

## 3. 批量选择删除与筛选（#8, `0646052`）

- **工具条**（`.gallery-bar`）：`筛选文件名… [仅独有] 已选 N [全选] [批量删除(N)]`。
  - `#galleryFilter` 文件名筛选（不区分大小写；本地卡片按当前目标展示名、远端独有按去 md5 前缀原名）。
  - `#uniqueFilterWrap`/`#filterUnique`「仅独有」开关。
  - `#gallerySelAll` 全选/取消全选（仅作用于当前**可见**卡片）。
  - `#galleryBatchDel` 批量删除(N)（`class="danger"`）。
- **卡片勾选**：`makeGalleryCheck(key, card)` 生成勾选框，键为 `L:<本地名>` / `R:<远端名>`；
  勾选即更新 `gallerySelected` 与卡片 `.card-selected` 高亮。
- **批量删除**：按当前目标作用域——服务器目标只删该目标远端文件与该目标记录；本机目标删本地文件与记录，
  可级联删所有服务器副本（远端任一失败即中止）。串行执行、按钮显示进度、结束汇总失败项。
- **状态**：`gallerySelected`（勾选集合）、`galleryBusy`（批量删除中，锁定交互）、
  `galleryVisibleCache`（当前可见键，供全选与工具条计数）。
- **签名**：`localCardSig`/`remoteCardSig` 含勾选位，使程序化改选后卡片重建、勾选态正确。
- **CSS**：`.gallery-bar`、`.gallery-toggle`、`.gallery-selinfo`、`.gallery-check`、`.card-selected`。

## 4. 收录手工图片 + 本机独有 + 可同步（#9, `e5d3b3d`）

### 服务端
- 新增导出 `isSafeSegment(name)`：非空、≤255、非 `.`/`..`、不以 `.` 开头（排除点文件与 `.tmp` 临时文件）；
  禁 `/`、`\`、单引号、控制字符；其余（中文/空格/`$`/反引号/`"`）允许。**禁单引号**是因为远端命令用单引号
  包裹路径，禁 `'` 即杜绝 shell 逃逸。
- 新增导出 `isImageName(name)`：按扩展名判定是否图片。
- `handleLibrary`：收录 `isFile && isSafeSegment && isImageName` 的文件（含手工放入、中文名）。
- `handleGetFile` / `handleDeleteFile`：名称校验改为 `isSafeSegment && isImageName`。
- `handleSync`：名称校验改为 `isSafeSegment && isImageName`（手工本地图可推送，远端名沿用本地名）。
- `handlePutHistory` / `handleDeleteHistory` / `handleBatchHistory`：名称校验改为 `isSafeSegment`。
- `validateRemoteFileName`：放宽为 `isSafeSegment`（远端列表/预览/删除支持中文名）。
- `remoteShellFile` 的 `~/` 分支：改为 `"$HOME/<rel>"` 拼接 `'/<name>'`（家目录双引号展开、文件名单引号承载），
  含 `$`/反引号/`"`/空格/中文的名字也安全。
- `isValidStoredName` 保留（md5 前缀识别等）。

### 前端
- 新增 `targetHasName(srv, name)`：该目标 history 记录存在，或远端清单含同名文件。
- `renderGrid` 服务器视图本地卡片过滤：`targetHasMd5(...) || targetHasName(srv, f.name)`。
- `renderGrid` 远端独有去重：无 md5 的远端文件若与本地同名则跳过。
- 同步抽屉 `missingItems`：无 md5 项改用 `targetHasName` 判定「目标是否已有」。
- **「本机独有」徽标**：`hasValidTarget(name)`（存在非 `stale` 的 target）为假且本机视图时，卡片加
  `本机独有`（`.badge-local-only`）。
- 「独有」开关自适应：`renderGalleryToolbar` 按目标设标签——本机目标「仅本机独有」、服务器目标「仅远端独有」；
  过滤逻辑相应切换。

### 两种「独有」的口径差异（重要）
- **本机独有**：**历史口径**——本机有、无有效推送记录（`targets` 为空或全 `stale`）。
- **远端独有**：**探测口径**——远端目录实际清单（`remoteIndex`）中本机无副本的文件。
- 二者判定口径不同，分别只在本机视图 / 服务器视图出现。

## 5. 画框批量选择（`127c140` / `814ed9c` / `b3eb08b`）

### 交互
- 起点：`document` 级 `pointerdown`；`isMarqueeBlocked(e.target)` 排除交互元素（`A/BUTTON/INPUT/LABEL/SELECT/
  TEXTAREA/IMG/VIDEO/AUDIO/OPTION/HEADER`）、卡片（class 含 `card`）、工具条（`gallery-bar`）、抽屉/弹窗/
  管理面板/上传区；`marqueeInBand(e.clientY)` 限定起点 Y 落在图库竖直带内（不影响页头/上传区）。
- 追加/减选：普通拖拽=**追加**；按住 **Alt** 拖拽=**减选**（红框）。
- 边缘自动滚动：指针进入视口上/下 ~40px 时按帧 `window.scrollBy` 滚动（速度随接近程度递增）。
- 仅鼠标/触控板/触控笔：忽略 `pointerType === 'touch'`（触摸屏保持原生滚动）。
- 选择框挂在 `.hist-area`（**不能**放 `#grid`——`reconcileCards` 会移除不在期望集合的子节点），
  `pointer-events:none`，`z-index` 低于同步抽屉。

### 几何与坐标（纯函数，导出供单测）
- `rectsIntersect(a, b)`：两矩形相交（边界相接也算）。
- `computeMarqueeKeys(cards, rect)`：`cards=[{key, rect}]` → 相交键（保持顺序）。
- `scrollStep(pointerY, viewportH, threshold, maxStep)`：边缘滚动步长 `{dy}`。
- **坐标用相对 `.hist-area` 的文档稳定系**：起点 `ax/ay` 固定，当前边 `cx/cy` 每帧按当前矩形重算；
  定位直接用相对矩形；命中检测转视口矩形与卡片矩形相交；边缘判定用原始 `clientY`。
  （修复前用视口坐标存起点、滚动时不刷新，导致框相对内容「跟着滚」而非向滚动方向变大。）

### 应用选择
`applyMarqueeSelection(keys, subtract)` 直接更新卡片 `_check.checked` 与 `.card-selected`，
并调用 `invalidateCardSig`（见第 6 节）后刷新工具条。

## 6. 清空选择（`4fa3a79` / `3b7326f`）

- **按钮**：`#galleryClearSel`「清空选择」，**仅有勾选时显示**（无选择隐藏、批量删除中置灰）。
  点击 → `gallerySelected = {}` → `renderGrid()`。
- **Esc 快捷键**：`document` keydown——
  1) 确认弹窗打开（`confirmActive`）→ 交给弹窗；
  2) 正在画框 → `endMarquee(false)` 取消画框；
  3) 焦点在 `INPUT/TEXTAREA/SELECT` → 不干预；
  4) 否则清空选择。
- **`invalidateCardSig(key)` 修复**（`3b7326f`）：卡片勾选态有两条更新路径——`renderGrid` 重建
  （签名含勾选位）与**直接改 DOM**（勾选框 change、画框）。后者不更新 `prevCards` 的 `sig`，
  导致随后 `renderGrid` 算出的签名恰好等于旧 sig（勾选位回到 0）时，`reconcileCards` 判定无变化而
  **复用旧 DOM**，卡片仍显示勾选（「清空选择 / 全选」看似失效）。修复：直接改 DOM 后把对应卡片签名置为
  哨兵 `null`，令下次 `renderGrid` 重建，保证签名与 DOM 一致。

## 7. 状态与数据

- 前端状态：`gallerySelected`、`galleryOnlyUnique`、`galleryFilter`、`galleryBusy`、`confirmActive`、
  `galleryVisibleCache`、`prevCards`。
- 无新增 HTTP 接口。`/api/library` 现在也会列出目录内任意图片（含手工放入）。
- 相关 DOM id：`galleryFilter`、`uniqueFilterWrap`、`filterUnique`、`uniqueFilterLabel`、`gallerySelInfo`、
  `gallerySelAll`、`galleryClearSel`、`galleryBatchDel`、`histArea`、`grid`。

## 8. 安全与边界

- `isSafeSegment` 是本地与远端统一的文件名闸门：不含 `/`（无路径穿越面）、不以 `.` 开头（排除点文件/临时文件）、
  禁单引号（远端单引号命令无逃逸面）与控制字符。
- `path.join(snapDir, name)` 因名内无 `/` 且 `..` 被拒，恒在目标目录内；路由的 WHATWG URL 归一化是另一道闸。
- 触摸屏不画框，保持原生滚动；画框仅鼠标/触控板/触控笔。

## 9. 测试与验收

- `node --check src/server.js` 通过；`node --test test/` 共 **142** 个用例全绿。
- 关键用例：
  - `isSafeSegment` / `isImageName` 边界（中文/空格通过；`..`、`a/b`、`.tmp`、`.hidden`、含 `'`、控制字符、空、超长拒绝）。
  - 手工图收录与读删、非图片/点文件不收录、不安全名 400。
  - 画框几何：`rectsIntersect` / `computeMarqueeKeys` / `scrollStep`。
  - 画框滚动延伸回归（模拟 `.hist-area` 上移，断言框上边固定、高度变大）。
  - 清空选择按需显示 / 点击清空 / Esc 清空；**直接勾选后清空应取消勾选**（已验证修复前失败）。

## 10. 局限

- 手工放入的图片无内容 md5 → **不参与远端对账**（不自动补录/标失效），也无法按内容去重（同名不同内容各自保留）；
  在服务器视图「是否存在」按推送记录/远端同名清单判断。
- 画框选择仅支持鼠标/触控板/触控笔，触摸屏不支持。

## 11. 关联文档

- `2026-10-12-gallery-batch-filter-design.md`（#8 批量选择/筛选）
- `2026-10-12-gallery-manual-images-local-only-design.md`（#9 手工图片/本机独有）
- `2026-10-12-gallery-marquee-select-design.md`（画框选择）
