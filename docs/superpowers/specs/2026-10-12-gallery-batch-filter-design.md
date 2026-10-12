# snap-push 图库批量选择删除与筛选 设计文档

- 日期：2026-10-12
- 状态：已与需求方确认，作为实现依据
- 分支：feat/gallery-batch-delete-filter
- 范围：图库网格新增「按文件名筛选」「仅远端独有筛选」「批量勾选删除」「对筛选结果全选」

## 1. 背景与目标

当前图库（`#grid`）每张卡片只能单张删除（本机卡片 → 删本地；服务器目标卡片 → 删该目标远端副本），
在图片较多时无法一次清理多张。本次为图库增加：

1. **筛选**：① 原文件名关键字搜索（不区分大小写）；② 「仅远端独有」开关（只显示远端有、本地无副本的卡片）。
2. **批量选择删除**：卡片加勾选框，工具条「批量删除(N)」，删除语义与现有**按目标作用域单删完全一致**。
3. **全选**：作用于**当前筛选后可见**的卡片（「全选 / 取消全选」）。

时间范围筛选本次不做。

约束（沿用 `AGENTS.md`）：

- `src/server.js` 仅用 Node 标准库，零 npm 依赖；页面内嵌，无外部资源。
- 页面 JS 位于外层模板字符串内：禁用反引号、反斜杠、`${`；换行用 `String.fromCharCode(10)`。
- 改动后 `node --check src/server.js` 与 `node --test test/` 必须全绿。
- `README.md` 与 `README.zh-CN.md` 同步更新。

## 2. 已确认决策

1. **筛选维度**：文件名关键字 + 「仅远端独有」；不做时间范围筛选。
2. **「远端独有」判定**：复用现有前端已有数据（`remoteIndex` 缓存 / 远端探测对账结果），**不新增服务端接口**、不额外 ssh。
   该开关只在选中服务器目标时可用（本机目标无「远端独有」概念）。
3. **批量删除范围**：与现有单张删除按目标作用域一致。
   - 服务器目标：只删该服务器上的文件与该目标的推送记录；本地文件与其他目标记录保留。
   - 本机目标：删本地文件与记录；若有远端副本，确认弹窗可选「同时删除所有服务器上的副本」，远端任一失败即中止。
4. **全选语义**：只勾选当前筛选后可见的卡片。
5. **选择状态**：勾选跨筛选保留；图库刷新后自动剪枝已不存在的键；切换目标不清空（键含类型前缀，天然区分本地/远端独有）。

## 3. UI 结构

图库 `<h2>` 与 `.hist-area` 之间新增工具条：

```
[筛选文件名…]  [☐ 仅远端独有]        已选 N   [全选]   [批量删除(N)]
```

- `#galleryFilter`：`type=search`，输入即时过滤。
- `#remoteOnlyWrap` + `#filterRemoteOnly`：仅服务器目标时显示；本机目标隐藏并复位。
- `#gallerySelInfo`：已选计数。
- `#gallerySelAll`：文案在「全选 / 取消全选」间切换。
- `#galleryBatchDel`：`.danger`，无选择时 `disabled`，文案带选中数。

图库卡片（`makeCard` / `makeRemoteCard`）在 `.card-ops` 左侧加复选框（复用 `.sync-check` 样式），
选中卡片加 `.card-selected` 高亮边框。

## 4. 前端状态

```js
var gallerySelected = {};      // 键 -> true，键 = 'L:<本地名>' | 'R:<远端名>'
var galleryFilter = '';        // 文件名关键字（原始输入）
var galleryRemoteOnly = false; // 仅远端独有
var galleryBusy = false;       // 批量删除进行中：锁定工具条与卡片勾选
```

## 5. 渲染逻辑（改 `renderGrid`）

1. 按现有逻辑算出 `locals`（本地卡片）与 `remotes`（远端独有卡片）。
2. 过滤：
   - `galleryRemoteOnly && srv` → `visibleLocals = []`（只留 `remotes`）。
   - `galleryFilter` 非空 → 本地按 `nameOnTarget(f.name, srv)`、远端按 `origFromName(item.name)` 做
     `toLowerCase().includes` 匹配。
3. 剪枝 `gallerySelected`：只保留仍存在于「全集（locals ∪ remotes）」的键，避免刷新后残留。
4. 刷新工具条：已选计数、全选文案、批量删除按钮、`remoteOnlyWrap` 显隐（本机目标隐藏并复位 `galleryRemoteOnly`）。
5. `reconcileCards(grid, 'grid', entries)` 用过滤后的可见集组装。
6. `localCardSig` / `remoteCardSig` 追加勾选位，保证程序化全选后卡片重建且勾选态正确。
7. 顶部计数 `#historyCount`：过滤生效时显示 `可见 / 总数 张`。

## 6. 全选

点击 `#gallerySelAll`：取当前可见键集合；若全部已选 → 取消这些键；否则全部加入。随后 `renderGrid()`。

## 7. 批量删除（`galleryBatchDelete`）

1. 收集 `gallerySelected` → 条目 `{kind:'L'|'R', name}`；为空直接返回。
2. 服务器目标且探测在途（`probeBusy`）→ 提示禁止（与单删一致，避免用旧快照删）。
3. `showConfirm` 确认：
   - 服务器目标：`确定从「X」删除选中的 N 项吗？将删除该服务器上的文件与该目标的推送记录。`
   - 本机目标：`确定删除选中的 N 个本地文件吗？`；若选中项存在远端副本，附复选项
     `同时删除所有服务器上的副本（M 台）`（M = 去重后的 host|dir 数）。
4. 串行执行（`galleryBusy` 锁定，按钮显示 `删除中 i/N`）：
   - 服务器目标：`L:` → `remoteDelete` + `dropTargetRecord` + `dropRemoteIndexFile`；
     `R:` → `remoteDelete` + `dropRemoteIndexFile`。
   - 本机目标：若勾选级联 → 先收集所有副本逐个 `remoteDelete`，任一失败即中止（不删本地）；
     然后 `deleteLocal` + 删 history（`deleteHistoryEntry`）。
5. 汇总成功/失败数，清空 `gallerySelected`，`refreshHistory()`，`hint` 提示。

## 8. 测试

- 页面 HTML 断言新增 4 个 id。
- DOM 垫片冒烟：
  - 勾选一张 → 工具条计数与批量删除文案更新。
  - 全选 → 只勾选当前可见卡片。
  - 关键字筛选 → 只剩匹配卡片；全选只选可见。
  - 仅远端独有筛选 → 本地卡片隐藏、远端独有保留。
  - 服务器目标批量删除 → mock fetch 断言对每个选中调用 `DELETE /api/remote-file`。
  - 本机目标批量删除 → 断言 `DELETE /files/<name>` 与 history 删除。

## 9. 验收标准

- `node --check src/server.js` 与 `node --test test/` 全绿（含新增用例）。
- 服务器目标：仅远端独有筛选只留远端独有卡片；关键字筛选生效。
- 全选只勾选当前可见；计数与按钮文案正确。
- 批量删除服务器目标 = 删远端 + 该目标记录，本地/其他目标不动。
- 批量删除本机目标 = 删本地 + 记录，可级联删远端副本（失败中止）。
- README 中英双版一致。
