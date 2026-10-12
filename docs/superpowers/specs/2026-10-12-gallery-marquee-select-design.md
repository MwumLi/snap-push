# snap-push 图库鼠标画框选择 设计文档

- 日期：2026-10-12
- 状态：已与需求方确认，作为实现依据
- 分支：feat/gallery-marquee-select
- 范围：图库网格支持鼠标拖拽画框（marquee）批量选择卡片

## 1. 背景与目标

图库已支持逐卡勾选、全选/取消全选、文件名筛选、批量删除。图片较多时逐张勾选低效，本次增加
**鼠标画框选择**：在网格空白处拖拽出矩形，松开后选中与矩形相交的卡片，复用现有 `gallerySelected`
勾选机制。

## 2. 已确认决策

1. **选择语义**：普通拖拽 = **追加**（并集）；按住 **Alt** 拖拽 = **减选**。
2. **边缘自动滚动**：拖到视口上下边缘时按帧自动滚动页面。
3. **触摸屏**：本次**不支持**（`pointerType === 'touch'` 忽略，触摸屏保持原生滚动）。
4. 输入范围：鼠标、Mac 触控板（含三指拖拽，报告为 `mouse`）、触控笔（`pen`）→ 均即时画框。
5. 只作用于当前**可见（筛选后）**的卡片；`galleryBusy`（批量删除中）时禁用。

## 3. 交互设计

- 起点：在 `#grid` 的空白/间隙处按下左键（`event.target === #grid`）。起点落在卡片、链接、按钮、
  勾选框等后代元素上则不启动，避免干扰点击与图片拖拽。
- 拖动：显示半透明矩形；移动超过阈值（约 4px）才显示，区分单击。
- 视觉：追加 = 蓝色框（`rgba(9,105,218,.12)` + `#0969da` 边框）；Alt 减选 = 红色框。
- 松开：与矩形**相交**的卡片加入（或 Alt 时移出）选择；刷新卡片勾选态与工具条。
- 边缘自动滚动：指针进入视口上/下边缘约 40px 时，按帧滚动 `window`，速度随接近程度递增。

## 4. 实现要点

- **事件**：统一用 Pointer Events。`#grid` 上 `pointerdown`；`document` 上
  `pointermove` / `pointerup` / `pointercancel`。开始后 `setPointerCapture` + `preventDefault`。
  忽略 `pointerType === 'touch'`。
- **挂载点**：矩形元素挂到 `.hist-area`（`position: relative`）。**不能**挂到 `#grid`——
  `reconcileCards` 会移除不在期望集合里的子节点。矩形 `pointer-events: none`，`z-index` 低于
  同步抽屉（50）。
- **坐标**：用 `getBoundingClientRect()` 相对 `.hist-area` 计算；每帧重算，页面滚动时保持一致。
- **命中检测**：遍历 `prevCards.grid`（`key → el`），跳过占位键 `@empty`，用元素矩形与框矩形相交。
- **纯函数**（导出以便单测）：
  - `rectsIntersect(a, b)`：两矩形是否相交（含边界相接）。
  - `computeMarqueeKeys(cards, rect)`：`cards=[{key, rect}]` → 相交的 key 数组。
  - `scrollStep(pointerY, viewportH, threshold, maxStep)`：返回 `{ dy }` 滚动步长。
- **应用选择**：更新 `gallerySelected` 后**直接更新**各卡片 `_check.checked` 与 `.card-selected`，
  再 `updateGalleryToolbarLight()`，避免整页重排与 FLIP 抖动。

## 5. 测试

- 单测 `rectsIntersect` / `computeMarqueeKeys` / `scrollStep`：相交、包含、相离、边界相接；滚动分档。
- 页面冒烟：`pointerdown`（含 `pointerType:'touch'` 应被忽略）在垫片上不抛异常；断言页面含 marquee 相关代码。
- 说明：DOM 垫片无 `getBoundingClientRect`、document 级监听为 no-op，完整拖拽行为由纯函数单测覆盖。

## 6. 验收标准

- `node --check src/server.js` 与 `node --test test/` 全绿。
- 实际页面：网格空白处拖拽出蓝框，相交卡片被勾选；按住 Alt 拖拽为红框且移出选择；拖到上下边缘页面自动滚动；
  工具条「已选 N / 批量删除(N)」同步；触摸屏不受影响（可正常滚动）。
- README 中英双版一致。
