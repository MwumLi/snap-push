# snap-push 开发约定（AGENTS.md）

snap-push 是本地零依赖的截图推送服务：浏览器选图/粘贴上传，一键推到本机或 ssh 免密服务器，返回可复制远端路径。

## 约束

1. **server.js 无外部依赖，可随时运行**
   - `src/server.js` 仅允许使用 Node 标准库（node:http、node:crypto、node:child_process、node:fs 等），禁止引入任何 npm 第三方依赖。
   - 页面（HTML/CSS/JS）必须内嵌于 server.js，不依赖任何外部资源/CDN/静态文件。
   - 目标是「存在 Node 运行时即可运行」：保持 `node src/server.js`（或 curl 管道）开箱即用，无需安装步骤。
   - 改动后必须保证 `node --check src/server.js` 与 `node --test test/` 全部用例通过。

2. **README 中英文必须同步更新**
   - 仓库文档双版维护：`README.md`（英文）与 `README.zh-CN.md`（中文）。
   - 任何对 README 的修改（新增章节、改命令/路径/示例/FAQ）都必须同时应用到两个文件，内容保持一致。
   - 若无法同步（例如只改单语言措辞），需在提交说明中注明原因。

## 补充约定

- 代码与关键注释使用中文；函数职责单一、命名清晰、符合人类阅读习惯。
- 应用源码位于 `src/`，测试位于 `test/`。
- 提交前运行：`node --check src/server.js` 和 `node --test test/`。
