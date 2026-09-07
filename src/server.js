// snap-push —— 本地零依赖的截图推送服务
//
// 职责：
//   1. 浏览器把图片字节 POST 到 /upload，服务端按内容 MD5 命名后落盘本机目录（预览用）；
//   2. 若指定了远程服务器（host/user/dir），则通过 ssh 探测妙传 → rsync（scp 兜底）同步到远端；
//   3. 提供图库清单 / 预览读取 / 删除接口。
//
// 设计文档：docs/superpowers/specs/2026-09-04-snap-push-design.md
// 仅依赖 Node 标准库，无任何 npm 依赖。

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// =====================================================================
// 默认配置（均可通过环境变量覆盖，见设计文档第 8 节）
// =====================================================================
const DEFAULT_HOST = '127.0.0.1';            // 仅监听本机回环，避免暴露到网络
const DEFAULT_PORT = 8123;
const DEFAULT_SNAP_DIR = '/tmp/snap-push';   // 本机图片落盘目录
const MAX_BODY_BYTES = 20 * 1024 * 1024;     // 上传体积上限：20MB
const SUBPROCESS_TIMEOUT_MS = 30_000;        // ssh/rsync/scp 单次执行超时
const STDERR_SUMMARY_LIMIT = 300;            // 错误信息中 stderr 摘要的最大长度

// ssh/scp 共用的免交互参数：
// - BatchMode=yes：密钥不可用时立即失败，而不是挂起等待密码输入
// - StrictHostKeyChecking=accept-new：首次连接自动接受新主机指纹
const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

// =====================================================================
// 一、纯函数：命名与参数校验（全部导出以便单元测试）
// =====================================================================

/**
 * 净化用户提供的原始文件名：
 * 仅取 basename（切断一切路径），过滤只保留白名单字符 [A-Za-z0-9._-]，去首尾空白；
 * 结果为空（空串/纯空白/全非法字符）时回退为 image.png，保证一定有可用文件名。
 */
export function sanitizeOrigName(raw) {
  if (typeof raw !== 'string') return 'image.png';
  const base = path.basename(raw.trim());
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned.length > 0 ? cleaned : 'image.png';
}

/**
 * 按内容生成存储名：<md5hex>-<净化后的原名>。
 * 内容相同的图片得到相同文件名，天然去重（幂等落盘）。
 */
export function md5Name(bytes, orig) {
  const hex = crypto.createHash('md5').update(bytes).digest('hex');
  return `${hex}-${sanitizeOrigName(orig)}`;
}

/**
 * host / user 共用的白名单校验：仅允许字母、数字、点、下划线、连字符。
 * 这两个值会进入 ssh 远端命令与 rsync/scp 目标串，白名单确保没有注入面。
 * 合法返回原值，非法返回 null。
 */
function validateWord(v) {
  if (typeof v !== 'string') return null;
  return /^[A-Za-z0-9._-]+$/.test(v) ? v : null;
}
export const validateHost = validateWord;
export const validateUser = validateWord;

/**
 * 校验远端目录：必须以 / 开头，且仅包含 [A-Za-z0-9._/-]；去掉尾部斜杠统一格式。
 * 非法（相对路径 / 空值 / 特殊字符 / 仅一个 /）返回 null。
 */
export function validateDir(v) {
  if (typeof v !== 'string' || !v.startsWith('/')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) return null;
  const trimmed = v.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 校验本机存储目录中读/删的文件名：必须匹配 <32 位小写 hex>-<安全名>。
 * 该模式天然排除路径分隔符与 ".."，是防路径穿越的最后一道闸。
 */
export function isValidStoredName(name) {
  return typeof name === 'string' && /^[0-9a-f]{32}-[A-Za-z0-9._-]+$/.test(name);
}

// 扩展名 → Content-Type 映射（仅图片类，其余一律按二进制流返回）
const MIME_BY_EXT = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['bmp', 'image/bmp'],
]);

/**
 * 根据文件扩展名推断 Content-Type（大小写不敏感），未知扩展名返回二进制流。
 */
export function mimeOf(name) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name);
  return (ext && MIME_BY_EXT.get(ext[1].toLowerCase())) || 'application/octet-stream';
}

// =====================================================================
// 二、子进程封装：统一「参数数组执行 + 超时 + 中文错误」
// =====================================================================

/**
 * 以参数数组方式执行外部命令（绝不经过 shell，杜绝注入）。
 * - 超时（默认 30s）后 SIGKILL 强杀子进程并抛中文错误；
 * - 命令不存在等启动失败同样抛中文错误（isMissingBinary 标记供 scp 兜底判断）；
 * - 正常结束 resolve {code, stdout, stderr}，退出码语义由调用方判定。
 */
export function run(cmd, args, timeoutMs = SUBPROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动命令 ${cmd}：${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // 超时即视为失败：先记录状态再强杀，最终在 close 事件里统一抛错
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      // 典型场景：本地未安装该命令（ENOENT）。isMissingBinary 供调用方走兜底路径
      const e = new Error(`无法执行命令 ${cmd}：${err.message}`);
      e.isMissingBinary = err.code === 'ENOENT';
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`命令超时（超过 ${timeoutMs}ms 已终止）：${cmd}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// =====================================================================
// 三、远端同步执行器：ssh 探测妙传 → rsync → scp 兜底
// =====================================================================

/**
 * 提取错误信息里的 stderr 摘要：压平空白并截断到 300 字，避免超长输出刷屏。
 */
function summarizeStderr(stderr) {
  const text = String(stderr || '').replace(/\s+/g, ' ').trim();
  return text.length > STDERR_SUMMARY_LIMIT ? `${text.slice(0, STDERR_SUMMARY_LIMIT)}…` : text;
}

/**
 * scp 兜底上传：远端没有 rsync（或本地 rsync 不可用）时改用 scp 直传。
 * 成功返回 {method:'scp'}，失败抛中文错误。
 */
async function scpFallback(localPath, name, target) {
  const { host, user, dir } = target;
  const r = await run('scp', [...SSH_ARGS, localPath, `${user}@${host}:${dir}/${name}`]);
  if (r.code !== 0) {
    throw new Error(`scp 兜底同步失败（退出码 ${r.code}）：${summarizeStderr(r.stderr)}`);
  }
  return { method: 'scp' };
}

/**
 * 构造 ssh 妙传探测脚本（在远端 shell 执行）：
 *   1) mkdir -p 确保远端目录存在；
 *   2) 存在性 + md5 内容比对——文件名前 32 位 hex 即内容 md5（md5Name 约定），
 *      同名必须同内容才算「已存在」。仅凭 test -f 存在性判断会把历史残缺文件
 *      （中断的 scp/rsync 残留）误判为已上传而妙传跳过，造成静默损坏；
 *   3) 远端没有 md5sum 时管道输出为空 → grep 不命中 → MISSING → 走上传。
 *      安全默认：宁可重传也不跳过（rsync -a 增量下重传代价可忽略）。
 * 名字不符合 <md5>- 约定时（正常流程不会发生）条件退化为 false：强制 MISSING。
 * 安全说明：name/dir 进入本函数前均已通过白名单校验，期望 md5 为纯 hex，
 *           嵌入远端命令串没有注入面。
 */
export function buildProbeScript(name, dir) {
  const expectedMd5 = /^[0-9a-f]{32}/.exec(name)?.[0];
  const remoteFile = `${dir}/${name}`;
  const existsCheck = expectedMd5
    ? `test -f '${remoteFile}' && md5sum '${remoteFile}' 2>/dev/null | grep -q '^${expectedMd5}'`
    : 'false';
  return `mkdir -p '${dir}'; if ${existsCheck}; then echo EXISTS; else echo MISSING; fi`;
}

/**
 * 把本地文件同步到远程服务器，返回实际使用的传输方式：
 *   1. ssh 一条命令完成「建目录 + md5 内容比对」——远端已有同内容文件才妙传
 *      跳过（method: skip），残缺文件会被判 MISSING 重传修复（自愈）；
 *   2. rsync 增量上传（method: rsync）；
 *   3. rsync 不可用（远端缺失，stderr 报 not found；或本地未安装）→ scp 兜底（method: scp）。
 * 任何失败抛出带 stderr 摘要的中文 Error。
 * 说明：scp 直写目标名并非原子，但配合 md5 探测，残缺文件会在下次上传时
 *       被发现并重传修复，无需额外原子化。
 * 安全说明：host/user/dir/name 均已通过白名单校验后才进入本函数，嵌入远端命令串是安全的；
 *           本地子进程一律使用参数数组，不经 shell。
 */
export async function syncToRemote(localPath, name, { host, user, dir }) {
  // 第一步：ssh 探测（mkdir -p 保证远端目录存在；md5 比对判断能否妙传）
  const probe = await run('ssh', [...SSH_ARGS, `${user}@${host}`, buildProbeScript(name, dir)]);
  if (probe.code !== 0) {
    throw new Error(`ssh 探测失败（退出码 ${probe.code}）：${summarizeStderr(probe.stderr)}`);
  }
  if (probe.stdout.includes('EXISTS')) {
    return { method: 'skip' }; // 远端已存在同内容文件：妙传，无需再传
  }

  // 第二步：尝试 rsync 上传（-a 保留属性，-z 压缩传输，-e 指定免交互 ssh）
  let rsyncResult = null;
  let localRsyncMissing = false;
  try {
    rsyncResult = await run('rsync', [
      '-az',
      '-e',
      `ssh ${SSH_ARGS.join(' ')}`,
      localPath,
      `${user}@${host}:${dir}/`,
    ]);
  } catch (err) {
    if (!err.isMissingBinary) throw err; // 本地 rsync 缺失以外的错误直接抛出
    localRsyncMissing = true; // 本地未安装 rsync：改走 scp 兜底
  }

  if (rsyncResult && rsyncResult.code === 0) {
    return { method: 'rsync' };
  }
  // 远端没装 rsync 的典型报错：sh: rsync: command not found（不区分大小写匹配）
  const remoteRsyncMissing =
    rsyncResult && rsyncResult.code !== 0 && rsyncResult.stderr.toLowerCase().includes('not found');
  if (localRsyncMissing || remoteRsyncMissing) {
    return scpFallback(localPath, name, { host, user, dir });
  }

  throw new Error(`rsync 同步失败（退出码 ${rsyncResult.code}）：${summarizeStderr(rsyncResult.stderr)}`);
}

// =====================================================================
// 四、HTTP 服务
// =====================================================================

/** 统一的 JSON 响应：显式 charset=utf-8，中文错误信息不乱码 */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * 内嵌单页应用（设计文档第 6 节）：原生 JS + 内联 CSS，无任何外部资源。
 *
 * 页面结构：
 *   - 顶部：目标下拉（本机 + localStorage 服务器配置）与「⚙ 管理」配置面板（增/改/删）；
 *   - 上传区：文件选择 / 拖拽 / Ctrl+V 粘贴截图，逐文件 POST /upload 并展示结果；
 *   - 历史区：/api/library 与 localStorage 历史（snap-push.history）求交渲染，
 *     按当前目标（host+dir）过滤，支持复制路径/URL、删除（联动清历史记录）、对账清理。
 *
 * 安全约定：动态内容一律 createElement + textContent，绝不拼接 innerHTML；
 *           文件名进入 URL 前经 encodeURIComponent 编码。
 * 书写约束：整个页面位于外层模板字符串内，因此页面内禁用反引号与反斜杠
 *           （页面 JS 一律普通引号拼接），也不出现 ${ 序列，避免两层语法互扰。
 */
function sendIndexPage(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>snap-push</title>
<link rel="icon" href="data:,">
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f6f8fa; color: #1f2328; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
header { background: #fff; border-bottom: 1px solid #d0d7de; }
.header-inner { max-width: 1100px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0 4px 0 0; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
section { margin-bottom: 22px; }
h2 { font-size: 15px; margin: 0 0 10px; }
.count { color: #656d76; font-weight: 400; font-size: 13px; }
label { font-size: 13px; }
button { font: inherit; font-size: 13px; padding: 3px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; color: #1f2328; cursor: pointer; }
button:hover { background: #eef1f4; }
button.danger { color: #cf222e; }
button:disabled { opacity: .6; cursor: default; }
.copy-btn { padding: 1px 8px; font-size: 12px; margin-left: 6px; }
select, input { font: inherit; font-size: 13px; padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #eff1f3; padding: 1px 5px; border-radius: 4px; word-break: break-all; font-size: 12px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; color: #fff; background: #6e7781; white-space: nowrap; }
.badge-local { background: #6e7781; }
.badge-skip { background: #1a7f37; }
.badge-rsync { background: #0969da; }
.badge-scp { background: #9a6700; }
.badge-other { background: #8250df; }
.panel { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px 6px; }
#serverList { list-style: none; margin: 0 0 10px; padding: 0; }
#serverList li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f0f2f4; }
#serverList li:last-child { border-bottom: none; }
.srv-info { flex: 1; font-size: 13px; word-break: break-all; }
.field { display: inline-block; margin: 0 16px 10px 0; vertical-align: top; }
.field label { display: block; color: #656d76; margin-bottom: 3px; }
.field input { width: 190px; }
.form-msg { color: #cf222e; font-size: 12px; margin-left: 8px; }
#dropZone { background: #fff; border: 2px dashed #d0d7de; border-radius: 8px; padding: 22px 16px; text-align: center; cursor: pointer; color: #57606a; }
#dropZone.drag { border-color: #0969da; background: #f0f6ff; }
#dropZone p { margin: 6px 0; }
#fileInput { margin-top: 8px; }
#uploadResults { margin-top: 8px; }
.up-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; font-size: 13px; flex-wrap: wrap; }
.up-name { font-weight: 600; word-break: break-all; }
.up-status { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; color: #57606a; }
.up-row.up-fail .up-status { color: #cf222e; }
.msg { min-height: 18px; font-size: 13px; color: #57606a; margin: 8px 0 0; }
.msg.error { color: #cf222e; }
#grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
.thumb { display: flex; align-items: center; justify-content: center; height: 150px; background: #f0f2f4; }
.thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.orig { font-weight: 600; font-size: 13px; word-break: break-all; }
.meta { color: #656d76; font-size: 12px; }
.targets { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.target { background: #f6f8fa; border-radius: 6px; padding: 6px 8px; font-size: 12px; }
.target-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.target-label { font-weight: 600; }
.target-time { margin-left: auto; color: #8b949e; }
.target-line { display: flex; align-items: center; margin-top: 3px; }
.target-line code { flex: 1; }
.target-none { color: #8b949e; }
.card-ops { display: flex; justify-content: flex-end; }
.empty { color: #8b949e; }
</style>
</head>
<body>
<header>
  <div class="header-inner">
    <h1>snap-push</h1>
    <label for="targetSel">目标</label>
    <select id="targetSel"></select>
    <button type="button" id="manageBtn">⚙ 管理</button>
  </div>
</header>
<main>
  <!-- 服务器配置管理面板：默认隐藏，点「⚙ 管理」展开 -->
  <section id="managePanel" class="panel" hidden>
    <h2>服务器管理</h2>
    <ul id="serverList"></ul>
    <form id="serverForm">
      <input type="hidden" id="fKey">
      <span class="field"><label for="fLabel">昵称（可选）</label><input id="fLabel" placeholder="如：测试机"></span>
      <span class="field"><label for="fHost">IP / 主机名（必填）</label><input id="fHost" required placeholder="如 192.168.1.10"></span>
      <span class="field"><label for="fUser">用户名</label><input id="fUser" placeholder="默认 root"></span>
      <span class="field"><label for="fDir">远端目录</label><input id="fDir" placeholder="默认 /tmp/snap-push"></span>
      <span class="field"><label for="fUrlBase">静态 URL 前缀（可选）</label><input id="fUrlBase" placeholder="如 https://cdn.example.com/snap"></span>
      <div>
        <button type="submit">保存</button>
        <button type="button" id="fCancel" hidden>取消编辑</button>
        <span class="form-msg" id="formMsg"></span>
      </div>
    </form>
  </section>

  <!-- 上传区：点选 / 拖拽 / Ctrl+V 粘贴截图 -->
  <section>
    <div id="dropZone">
      <p>把图片拖到这里、点击选择文件，或截图后直接 <strong>Ctrl+V</strong> 粘贴上传</p>
      <input type="file" id="fileInput" multiple accept="image/*">
    </div>
    <div id="uploadResults"></div>
    <p class="msg" id="msg"></p>
  </section>

  <!-- 历史区：按当前目标过滤 -->
  <section>
    <h2>历史图库 <span class="count" id="historyCount"></span></h2>
    <div id="grid"></div>
  </section>
</main>
<script>
(function () {
  'use strict';

  // =============== localStorage 封装 ===============
  // 读取失败（未存过/内容损坏/隐私模式禁用）时静默回退默认值；
  // 写入失败只是不持久化，都不阻断页面功能。
  var SERVERS_KEY = 'snap-push.servers';
  var HISTORY_KEY = 'snap-push.history';

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      var val = raw ? JSON.parse(raw) : null;
      return val || fallback;
    } catch (e) {
      // 内容损坏等：回退默认值，控制台留痕便于排查
      console.warn('读取 ' + key + ' 失败，已回退默认值：', e);
      return fallback;
    }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {
      // 隐私模式/配额超限：只是不持久化，不影响本次会话
      console.warn('写入 ' + key + ' 失败（可能处于隐私模式或存储已满）：', e);
    }
  }

  // =============== 页面状态 ===============
  var servers = loadJson(SERVERS_KEY, []); // [{id,label,host,user,dir,urlBase}]
  if (!Array.isArray(servers)) servers = [];
  // history 结构：{"<localName>": {orig, targets: [{key,label,host,dir,remotePath,url,method,time}]}}
  var history = loadJson(HISTORY_KEY, {});
  if (typeof history !== 'object' || history === null || Array.isArray(history)) history = {};
  var libFiles = []; // 最近一次 GET /api/library 的文件清单

  // =============== DOM 引用 ===============
  var targetSel = document.getElementById('targetSel');
  var manageBtn = document.getElementById('manageBtn');
  var managePanel = document.getElementById('managePanel');
  var serverList = document.getElementById('serverList');
  var serverForm = document.getElementById('serverForm');
  var fKey = document.getElementById('fKey');
  var fLabel = document.getElementById('fLabel');
  var fHost = document.getElementById('fHost');
  var fUser = document.getElementById('fUser');
  var fDir = document.getElementById('fDir');
  var fUrlBase = document.getElementById('fUrlBase');
  var fCancel = document.getElementById('fCancel');
  var formMsg = document.getElementById('formMsg');
  var dropZone = document.getElementById('dropZone');
  var fileInput = document.getElementById('fileInput');
  var uploadResults = document.getElementById('uploadResults');
  var msg = document.getElementById('msg');
  var grid = document.getElementById('grid');
  var historyCount = document.getElementById('historyCount');

  // =============== 通用小工具 ===============

  // 时间格式化为 YYYY-MM-DD HH:MM（本地时区，方便肉眼阅读）
  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 体积格式化为 xxKB / x.xMB
  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  }

  // 去掉字符串尾部的全部斜杠（至少保留 1 个字符，避免把 '/' 清成空串）
  function stripTrailingSlash(s) {
    while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
    return s;
  }

  // 顶部轻提示：几秒后自动消失，不打断操作
  var msgTimer = null;
  function hint(text, isError) {
    msg.textContent = text;
    msg.className = isError ? 'msg error' : 'msg';
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { msg.textContent = ''; }, 4000);
  }

  // 复制文本：优先 navigator.clipboard，不可用或失败时回退 execCommand
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
      return;
    }
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) done(); else hint('复制失败：请手动选择文本复制', true);
  }

  // 复制按钮：点击后短暂显示「已复制」
  function makeCopyButton(getText) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-btn';
    b.textContent = '复制';
    b.addEventListener('click', function () {
      copyText(getText(), function () {
        b.textContent = '已复制';
        b.disabled = true;
        setTimeout(function () { b.textContent = '复制'; b.disabled = false; }, 1200);
      });
    });
    return b;
  }

  // 传输方式徽标：local=本机落盘 / skip=妙传跳过 / rsync / scp（未知值原样展示）
  var METHOD_TEXT = { local: '本机', skip: '妙传', rsync: 'rsync', scp: 'scp' };
  function makeMethodBadge(method) {
    var b = document.createElement('span');
    b.className = 'badge badge-' + (METHOD_TEXT[method] ? method : 'other');
    b.textContent = METHOD_TEXT[method] || String(method || '—');
    return b;
  }

  // =============== 目标下拉 ===============

  function serverById(id) {
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].id === id) return servers[i];
    }
    return null;
  }

  // 当前选中的服务器配置；未选（本机）返回 null
  function currentServer() {
    return serverById(targetSel.value);
  }

  // 重渲染目标下拉：本机 + 全部服务器（显示昵称，无昵称显示 IP）
  function renderTargetSel() {
    var prev = targetSel.value; // 尽量保持原选择，避免重渲染后跳回本机
    targetSel.textContent = '';
    var optLocal = document.createElement('option');
    optLocal.value = 'local';
    optLocal.textContent = '本机（默认）';
    targetSel.appendChild(optLocal);
    servers.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label || s.host;
      targetSel.appendChild(o);
    });
    if (prev && (prev === 'local' || serverById(prev))) targetSel.value = prev;
  }

  // =============== 服务器配置管理 ===============

  // 生成服务器配置的唯一 id（历史记录与下拉选项靠它关联）
  function genId() {
    return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  }

  // 目录校验（与服务端白名单一致）：以 / 开头、字符白名单、去尾部斜杠；'/' 本身非法
  function validDir(v) {
    if (v.charAt(0) !== '/') return null;
    var d = stripTrailingSlash(v);
    if (d === '' || d === '/') return null;
    if (!/^[A-Za-z0-9._/-]+$/.test(d)) return null;
    return d;
  }

  function renderServerList() {
    serverList.textContent = '';
    if (!servers.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '还没有服务器配置，在下方表单添加一台吧。';
      serverList.appendChild(empty);
      return;
    }
    servers.forEach(function (s) {
      var li = document.createElement('li');

      var info = document.createElement('span');
      info.className = 'srv-info';
      info.textContent = (s.label ? s.label + '（' + s.host + '）' : s.host) +
        '　' + (s.user || 'root') + ' @ ' + s.dir;
      li.appendChild(info);

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', function () { startEdit(s); });
      li.appendChild(editBtn);

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', function () { removeServer(s); });
      li.appendChild(delBtn);

      serverList.appendChild(li);
    });
  }

  // 编辑已有配置：表单填入原值，保留 id 不变（保证历史记录仍能关联）
  function startEdit(s) {
    fKey.value = s.id;
    fLabel.value = s.label || '';
    fHost.value = s.host || '';
    fUser.value = s.user || '';
    fDir.value = s.dir || '';
    fUrlBase.value = s.urlBase || '';
    fCancel.hidden = false;
    formMsg.textContent = '';
    fHost.focus();
  }

  function resetForm() {
    serverForm.reset();
    fKey.value = '';
    fCancel.hidden = true;
    formMsg.textContent = '';
  }

  function removeServer(s) {
    if (!window.confirm('确定删除服务器「' + (s.label || s.host) + '」的配置吗？（历史推送记录保留）')) return;
    var idx = servers.indexOf(s);
    if (idx >= 0) servers.splice(idx, 1);
    saveJson(SERVERS_KEY, servers);
    resetForm();
    renderServerList();
    renderTargetSel(); // 若删的是当前选中项，选择会回退到本机
    renderGrid();
    hint('已删除服务器配置');
  }

  serverForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var label = fLabel.value.trim();
    var host = fHost.value.trim();
    var user = fUser.value.trim() || 'root';       // 用户名缺省 root
    var dirRaw = fDir.value.trim() || '/tmp/snap-push'; // 目录缺省 /tmp/snap-push
    var urlBase = stripTrailingSlash(fUrlBase.value.trim()); // 去尾斜杠避免拼出双斜杠

    // 客户端预校验（与服务端白名单一致）：尽早给出中文提示，避免提交后才报错
    if (!host) { formMsg.textContent = 'IP / 主机名必填'; return; }
    if (!/^[A-Za-z0-9._-]+$/.test(host)) {
      formMsg.textContent = 'IP 不合法：仅允许字母、数字、点、下划线、连字符';
      return;
    }
    var dir = validDir(dirRaw);
    if (!dir) {
      formMsg.textContent = '远端目录不合法：必须以 / 开头，且仅允许字母、数字、点、下划线、连字符、斜杠';
      return;
    }
    if (urlBase && urlBase.indexOf('http://') !== 0 && urlBase.indexOf('https://') !== 0) {
      formMsg.textContent = 'URL 前缀不合法：需形如 https://cdn.example.com/snap';
      return;
    }

    var s = serverById(fKey.value);
    if (s) {
      // 编辑：保留原 id（下拉选择与历史记录按 id 关联，昵称/host/dir 可改）
      s.label = label;
      s.host = host;
      s.user = user;
      s.dir = dir;
      s.urlBase = urlBase;
    } else {
      servers.push({ id: genId(), label: label, host: host, user: user, dir: dir, urlBase: urlBase });
    }
    saveJson(SERVERS_KEY, servers);
    resetForm();
    renderServerList();
    renderTargetSel();
    renderGrid(); // host/dir 变化会影响按目标过滤的结果
    hint('服务器配置已保存');
  });

  fCancel.addEventListener('click', resetForm);

  manageBtn.addEventListener('click', function () {
    managePanel.hidden = !managePanel.hidden;
    if (!managePanel.hidden) renderServerList();
  });

  // =============== 上传 ===============

  // 组装 /upload 的 query：本机目标只带 name；服务器目标带 host/user/dir/urlBase
  function targetParams(srv) {
    var p = new URLSearchParams();
    if (srv) {
      p.set('host', srv.host);
      p.set('user', srv.user || 'root');
      p.set('dir', srv.dir);
      if (srv.urlBase) p.set('urlBase', srv.urlBase);
    }
    return p;
  }

  // 追加一行上传结果（文件名 + 状态区），返回状态区引用供更新
  function addResultRow(fileName) {
    var row = document.createElement('div');
    row.className = 'up-row';
    var name = document.createElement('span');
    name.className = 'up-name';
    name.textContent = fileName;
    var status = document.createElement('span');
    status.className = 'up-status';
    status.textContent = '上传中…';
    row.appendChild(name);
    row.appendChild(status);
    uploadResults.appendChild(row);
    return { row: row, status: status };
  }

  // 上传成功写入历史：同 host+dir 的记录覆盖；本机目标固定 key='local'（host/dir 为空串）
  function recordUpload(data, orig, srv) {
    var rec = {
      key: srv ? srv.id : 'local',
      label: srv ? (srv.label || srv.host) : '本机',
      host: srv ? srv.host : '',
      dir: srv ? srv.dir : '',
      remotePath: data.remotePath,
      url: data.url || '',
      method: data.method,
      time: new Date().toISOString(),
    };
    var entry = history[data.localName];
    if (!entry || !Array.isArray(entry.targets)) {
      entry = history[data.localName] = { orig: orig, targets: [] };
    }
    entry.orig = orig;
    var replaced = false;
    for (var i = 0; i < entry.targets.length; i++) {
      if (entry.targets[i].host === rec.host && entry.targets[i].dir === rec.dir) {
        entry.targets[i] = rec; // 同目标重复推送：覆盖旧记录
        replaced = true;
        break;
      }
    }
    if (!replaced) entry.targets.push(rec);
    saveJson(HISTORY_KEY, history);
  }

  // 单文件上传：body 直接放 File 对象（浏览器按原始字节发送）
  async function uploadOne(file, srv) {
    var entry = addResultRow(file.name);
    try {
      var p = targetParams(srv);
      p.set('name', file.name);
      var res;
      try {
        res = await fetch('/upload?' + p.toString(), { method: 'POST', body: file });
      } catch (e) {
        // 网络层异常（服务不可达/连接中断）：转成中文提示，避免露出英文堆栈
        throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
      }
      var data = {};
      var jsonOk = true;
      try { data = await res.json(); } catch (e) { jsonOk = false; } // 非 JSON 响应：按状态码继续报错
      if (!res.ok || !jsonOk || !data.ok) {
        throw new Error(data.error || ('HTTP ' + res.status + (jsonOk ? '' : '（响应非 JSON）')));
      }
      recordUpload(data, file.name, srv);

      // 成功态：方式徽标 + 路径（有 URL 再加一行）+ 各自的复制按钮
      entry.status.textContent = '';
      entry.status.appendChild(makeMethodBadge(data.method));
      var code = document.createElement('code');
      code.textContent = data.remotePath;
      entry.status.appendChild(code);
      entry.status.appendChild(makeCopyButton(function () { return data.remotePath; }));
      if (data.url) {
        var ucode = document.createElement('code');
        ucode.textContent = data.url;
        entry.status.appendChild(ucode);
        entry.status.appendChild(makeCopyButton(function () { return data.url; }));
      }
    } catch (err) {
      entry.status.textContent = '失败：' + (err.message || err);
      entry.row.classList.add('up-fail');
    }
  }

  // 批量入口：过滤出图片后串行逐个上传（后端上传队列本身串行，前端逐个展示结果）
  async function uploadFiles(fileList) {
    var files = [];
    var skipped = 0; // 非 image/* 文件计数，用于提示用户有文件被忽略
    for (var i = 0; i < fileList.length; i++) {
      if (fileList[i].type.indexOf('image/') === 0) files.push(fileList[i]);
      else skipped++;
    }
    if (!files.length) {
      hint(skipped ? '已忽略 ' + skipped + ' 个非图片文件（仅支持 image/* 类型）' : '未检测到图片文件（仅支持图片类型）', true);
      return;
    }
    if (skipped) hint('已忽略 ' + skipped + ' 个非图片文件，仅上传 ' + files.length + ' 张图片', true);
    var srv = currentServer();
    for (var j = 0; j < files.length; j++) {
      await uploadOne(files[j], srv);
    }
    refreshHistory(); // 全部完成后刷新历史区
  }

  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files.length) uploadFiles(fileInput.files);
    fileInput.value = ''; // 清空选择，允许再次选择同一个文件
  });

  // 拖拽：进入悬停高亮，松手后上传
  ['dragenter', 'dragover'].forEach(function (name) {
    dropZone.addEventListener(name, function (e) {
      e.preventDefault();
      dropZone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    dropZone.addEventListener(name, function (e) {
      e.preventDefault();
      dropZone.classList.remove('drag');
    });
  });
  dropZone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      uploadFiles(e.dataTransfer.files);
    }
  });
  // 拖到页面其它位置时阻止浏览器直接打开图片文件（避免误操作离开页面）
  ['dragover', 'drop'].forEach(function (name) {
    document.addEventListener(name, function (e) { e.preventDefault(); });
  });
  // 点击拖拽区任意位置也可唤起文件选择（点在 input 自身上时交给浏览器原生行为）
  dropZone.addEventListener('click', function (e) {
    if (e.target === fileInput) return;
    fileInput.click();
  });

  // 粘贴截图：剪贴板里带文件对象时（系统截图 / 复制图片）触发上传
  document.addEventListener('paste', function (e) {
    if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
    uploadFiles(e.clipboardData.files);
  });

  // =============== 历史图库 ===============

  // 历史区错误占位：拉取失败时显示中文提示，绝不动 localStorage 记录
  function showHistoryError(message) {
    historyCount.textContent = '';
    grid.textContent = '';
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '历史加载失败：' + message + '（本地记录未动，可刷新重试）';
    grid.appendChild(p);
  }

  // 拉取序号守卫：只认最后一次发起的请求结果，
  // 防止并发刷新时旧响应（尤其是失败的旧响应）覆盖新结果
  var historySeq = 0;

  // 拉取本机图库 → 对账 → 渲染。
  // 关键：失败时直接返回（跳过对账与渲染）——若以空清单继续对账，
  // 会把 localStorage 中的推送记录误当「本地文件已删除」而全部清空；
  // 成功但清单为空（文件确实都删了）才允许正常对账清理。
  async function refreshHistory() {
    var seq = ++historySeq;
    try {
      var res;
      try {
        res = await fetch('/api/library');
      } catch (e) {
        throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
      }
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; } // 非 JSON 响应按失败处理
      if (!res.ok || !data || !Array.isArray(data.files)) {
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      if (seq !== historySeq) return; // 已有更新的请求在途，丢弃本次过期结果
      libFiles = data.files;
    } catch (e) {
      if (seq !== historySeq) return; // 过期失败同样让位给新请求
      showHistoryError(e && e.message ? e.message : String(e));
      return;
    }
    reconcile();
    renderGrid();
  }

  // 对账：以服务端图库为准，本地文件已删除的清掉其历史记录
  function reconcile() {
    var known = {};
    libFiles.forEach(function (f) { known[f.name] = true; });
    var changed = false;
    Object.keys(history).forEach(function (k) {
      if (!known[k]) { delete history[k]; changed = true; }
    });
    if (changed) saveJson(HISTORY_KEY, history);
  }

  // 过滤规则：选中服务器 → 只显示 targets 含该 host+dir 的文件；本机 → 全部
  function renderGrid() {
    var srv = currentServer();
    var files = libFiles.filter(function (f) {
      if (!srv) return true;
      var rec = history[f.name];
      if (!rec || !Array.isArray(rec.targets)) return false;
      return rec.targets.some(function (t) { return t.host === srv.host && t.dir === srv.dir; });
    });

    historyCount.textContent = srv
      ? files.length + ' 张 · ' + (srv.label || srv.host)
      : files.length + ' 张';

    grid.textContent = ''; // 清空重建（textContent 赋值不产生 XSS 面）
    if (!files.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = srv
        ? '该目标下还没有图片：选择图片上传即会推送到 ' + (srv.label || srv.host)
        : '还没有图片：粘贴截图 / 拖拽 / 选择文件上传';
      grid.appendChild(empty);
      return;
    }
    files.forEach(function (f) { grid.appendChild(makeCard(f, srv)); });
  }

  function makeCard(f, srv) {
    var rec = history[f.name];

    var card = document.createElement('div');
    card.className = 'card';

    // 缩略图：点击新窗口打开原图
    var link = document.createElement('a');
    link.className = 'thumb';
    link.href = '/files/' + encodeURIComponent(f.name);
    link.target = '_blank';
    link.rel = 'noopener';
    var img = document.createElement('img');
    img.src = link.href;
    img.alt = f.name;
    img.loading = 'lazy';
    link.appendChild(img);
    card.appendChild(link);

    var body = document.createElement('div');
    body.className = 'card-body';

    // 原名优先取历史记录；无记录时从存储名 <md5>-原名 中截取（第 34 个字符起）
    var orig = document.createElement('div');
    orig.className = 'orig';
    orig.textContent = (rec && rec.orig) ? rec.orig : f.name.substring(33);
    body.appendChild(orig);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatSize(f.size) + ' · ' + formatTime(f.mtime);
    body.appendChild(meta);

    // 推送记录：本机视图显示全部记录；选中服务器时只显示该服务器的记录
    var records = (rec && Array.isArray(rec.targets))
      ? rec.targets.filter(function (t) { return !srv || (t.host === srv.host && t.dir === srv.dir); })
      : [];
    var list = document.createElement('div');
    list.className = 'targets';
    if (!records.length) {
      var none = document.createElement('div');
      none.className = 'target-none';
      none.textContent = srv ? '尚未推送到该服务器' : '无推送记录（仅本机预览）';
      list.appendChild(none);
    } else {
      records.forEach(function (t) { list.appendChild(makeTargetRow(t)); });
    }
    body.appendChild(list);

    var ops = document.createElement('div');
    ops.className = 'card-ops';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', function () { removeFile(f.name, orig.textContent); });
    ops.appendChild(del);
    body.appendChild(ops);

    card.appendChild(body);
    return card;
  }

  // 单条推送记录：徽标 + 目标名 + 时间，路径 / URL 各带复制按钮
  function makeTargetRow(t) {
    var row = document.createElement('div');
    row.className = 'target';

    var head = document.createElement('div');
    head.className = 'target-head';
    head.appendChild(makeMethodBadge(t.method));
    var label = document.createElement('span');
    label.className = 'target-label';
    label.textContent = t.label || (t.host || '本机');
    head.appendChild(label);
    var time = document.createElement('span');
    time.className = 'target-time';
    time.textContent = formatTime(t.time);
    head.appendChild(time);
    row.appendChild(head);

    var pathLine = document.createElement('div');
    pathLine.className = 'target-line';
    var code = document.createElement('code');
    code.textContent = t.remotePath;
    pathLine.appendChild(code);
    pathLine.appendChild(makeCopyButton(function () { return t.remotePath; }));
    row.appendChild(pathLine);

    if (t.url) {
      var urlLine = document.createElement('div');
      urlLine.className = 'target-line';
      var ucode = document.createElement('code');
      ucode.textContent = t.url;
      urlLine.appendChild(ucode);
      urlLine.appendChild(makeCopyButton(function () { return t.url; }));
      row.appendChild(urlLine);
    }
    return row;
  }

  // 删除：确认后调 DELETE /files/<name>，成功后清掉对应历史记录并刷新
  async function removeFile(name, display) {
    if (!window.confirm('确定删除「' + display + '」吗？将同时删除本机文件与全部推送记录。')) return;
    try {
      var res = await fetch('/files/' + encodeURIComponent(name), { method: 'DELETE' });
      var data = {};
      var jsonOk = true;
      try { data = await res.json(); } catch (e) { jsonOk = false; } // 非 JSON 响应按失败处理
      if (!res.ok || !jsonOk || !data.ok) {
        throw new Error(data.error || ('HTTP ' + res.status + (jsonOk ? '' : '（响应非 JSON）')));
      }
      delete history[name];
      saveJson(HISTORY_KEY, history);
      refreshHistory();
      hint('已删除');
    } catch (err) {
      window.alert('删除失败：' + (err.message || err));
    }
  }

  // =============== 初始化 ===============
  targetSel.addEventListener('change', renderGrid); // 切目标即按目标过滤历史
  renderTargetSel();
  refreshHistory();
})();
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * 限流读取请求体：累计超过 limit 字节时立即以 413 失败，
 * 后续数据静默丢弃（保持连接可正常回包，不粗暴断开）。
 */
function readBodyWithLimit(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false; // 防止 end / error / 超限之间重复 settle
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    req.on('data', (chunk) => {
      if (settled) return; // 已超限：静默消费剩余数据
      total += chunk.length;
      if (total > limit) {
        const err = new Error(`上传内容超过大小上限（${formatSize(limit)}）`);
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', (err) => fail(new Error(`读取上传数据失败：${err.message}`)));
  });
}

/** 体积的友好展示（错误提示用） */
function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))}MB` : `${bytes} 字节`;
}

/** 对 URL 路径段做百分号解码；非法编码（如 %zz）返回 null，由调用方按 400 处理 */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** 确保 snapDir 存在（幂等；upload 与 library 前调用） */
async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * 处理 POST /upload?name=&host=&user=&dir=&urlBase=：
 * 1) 校验 query 参数（name 必填；host 非空时 user 默认 root、dir 必填且过白名单）；
 * 2) 限流读取图片字节（超 20MB → 413）；
 * 3) md5Name 生成存储名并落盘本机目录（已存在则跳过写入，天然幂等）；
 * 4) host 为空 → 仅本机（method: local，返回本机绝对路径）；否则 syncToRemote 同步远端；
 * 5) 落盘与远端同步进入串行队列执行，避免并发 rsync 交叉（设计文档第 7 节）。
 */
async function handleUpload(req, res, params, ctx) {
  // —— 参数校验：在读取大 body 之前快速失败 ——
  const rawName = params.get('name');
  if (!rawName) {
    req.resume(); // 丢弃未读的请求体，尽快返回错误
    return sendJson(res, 400, { ok: false, error: '缺少必填参数 name' });
  }

  const urlBase = params.get('urlBase') || '';
  let target = null; // null 表示仅本机落盘，不同步远端
  const host = params.get('host') || '';
  if (host) {
    const validHost = validateHost(host);
    if (!validHost) {
      req.resume();
      return sendJson(res, 400, { ok: false, error: 'host 不合法：仅允许字母、数字、点、下划线、连字符' });
    }
    const user = validateUser(params.get('user') || 'root'); // 远程用户名缺省 root
    if (!user) {
      req.resume();
      return sendJson(res, 400, { ok: false, error: 'user 不合法：仅允许字母、数字、点、下划线、连字符' });
    }
    const dirRaw = params.get('dir') || '';
    if (!dirRaw) {
      req.resume();
      return sendJson(res, 400, { ok: false, error: '选择远程目标时 dir（远端目录）必填' });
    }
    const dir = validateDir(dirRaw);
    if (!dir) {
      req.resume();
      return sendJson(res, 400, { ok: false, error: 'dir 不合法：必须以 / 开头，且仅允许字母、数字、点、下划线、连字符、斜杠' });
    }
    target = { host: validHost, user, dir };
  }

  // —— 读取请求体（大小受限） ——
  const bytes = await readBodyWithLimit(req, ctx.maxBody);
  const storedName = md5Name(bytes, rawName);

  // —— 串行执行：写盘 + 远端同步不并发，避免 rsync 交叉 ——
  const result = await ctx.enqueue(async () => {
    await ensureDir(ctx.snapDir);
    const localPath = path.join(ctx.snapDir, storedName);
    if (!fs.existsSync(localPath)) {
      // 原子写入：先写同目录临时文件，再 rename 到最终名（同文件系统 rename 原子）。
      // 直接写最终路径一旦中断（进程被杀/磁盘满），会留下「名字合法但内容残缺」
      // 的文件，被图库收录并同步远端，造成静默损坏；临时文件以 . 开头、.tmp 结尾，
      // 不匹配 isValidStoredName，即使残留也不会进入图库。
      const tmpPath = path.join(
        ctx.snapDir,
        `.${storedName}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`,
      );
      try {
        await fs.promises.writeFile(tmpPath, bytes);
        await fs.promises.rename(tmpPath, localPath);
      } catch (err) {
        // 尽力清理半成品临时文件（清理失败不影响原始错误抛出）
        await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
    }
    if (!target) {
      // 仅本机：remotePath 返回本机绝对路径
      return { method: 'local', remotePath: path.resolve(localPath) };
    }
    const { method } = await syncToRemote(localPath, storedName, target);
    return { method, remotePath: `${target.dir}/${storedName}` };
  });

  return sendJson(res, 200, {
    ok: true,
    localName: storedName,
    remotePath: result.remotePath,
    // 未提供 urlBase 时不输出 url 字段（JSON.stringify 忽略 undefined）
    url: urlBase ? `${urlBase}/${storedName}` : undefined,
    method: result.method,
  });
}

/** GET /api/library：列出本机目录中所有合法存储名文件，按 mtime 降序（新图在前） */
async function handleLibrary(res, ctx) {
  await ensureDir(ctx.snapDir);
  const entries = await fs.promises.readdir(ctx.snapDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isValidStoredName(entry.name)) continue; // 只认 <md5>- 前缀的图片文件
    const stat = await fs.promises.stat(path.join(ctx.snapDir, entry.name));
    files.push({ name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() });
  }
  files.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  sendJson(res, 200, { files });
}

/** GET /files/<name>：返回图片字节与对应 Content-Type */
async function handleGetFile(res, name, ctx) {
  if (!isValidStoredName(name)) {
    return sendJson(res, 400, { ok: false, error: '文件名不合法' });
  }
  let data;
  try {
    data = await fs.promises.readFile(path.join(ctx.snapDir, name));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: '文件不存在' });
    throw err;
  }
  res.writeHead(200, { 'Content-Type': mimeOf(name), 'Content-Length': data.length });
  res.end(data);
}

/** DELETE /files/<name>：删除本机文件 */
async function handleDeleteFile(res, name, ctx) {
  if (!isValidStoredName(name)) {
    return sendJson(res, 400, { ok: false, error: '文件名不合法' });
  }
  try {
    await fs.promises.unlink(path.join(ctx.snapDir, name));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: '文件不存在' });
    throw err;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * 路由分发。用 WHATWG URL 解析：它会规范化 ".." 路径段，
 * 例如 /files/../etc/passwd 会变成 /etc/passwd 落进 404，天然免疫目录穿越。
 */
async function route(req, res, ctx) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求路径不合法' });
  }
  const { pathname, searchParams } = url;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/') {
    return sendIndexPage(res);
  }
  if (req.method === 'POST' && pathname === '/upload') {
    return handleUpload(req, res, searchParams, ctx);
  }
  if (req.method === 'GET' && pathname === '/api/library') {
    return handleLibrary(res, ctx);
  }
  if (pathname.startsWith('/files/')) {
    // 解码后的文件名必须严格匹配 <md5>-<安全名>，否则一律 400
    const name = safeDecode(pathname.slice('/files/'.length));
    if (req.method === 'GET') return handleGetFile(res, name, ctx);
    if (req.method === 'DELETE') return handleDeleteFile(res, name, ctx);
  }
  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

/**
 * 创建 snap-push HTTP 服务（只创建不监听，便于测试注入目录与端口）。
 * @param {object} [options]
 * @param {string} [options.snapDir] 本机落盘目录，默认取环境变量 SNAP_PUSH_DIR 或 /tmp/snap-push
 * @param {number} [options.maxBody] 上传体积上限（字节），默认 20MB
 * @returns {import('node:http').Server}
 */
export function createServer(options = {}) {
  const snapDir = options.snapDir || process.env.SNAP_PUSH_DIR || DEFAULT_SNAP_DIR;
  const maxBody = options.maxBody || MAX_BODY_BYTES;

  // 串行队列：上传的「写盘 + 远端同步」逐个执行，避免并发 rsync 交叉
  let chain = Promise.resolve();
  const enqueue = (job) => {
    const next = chain.then(job, job); // 无论上一个任务成败都继续执行本任务
    chain = next.catch(() => {}); // 吞掉上一个任务的错误，保持队列不中断
    return next;
  };

  const ctx = { snapDir, maxBody, enqueue };
  const server = http.createServer((req, res) => {
    route(req, res, ctx).catch((err) => {
      // 统一兜底：抛错处可携带 statusCode（如 413），其余按 500 处理
      if (res.headersSent) {
        res.destroy(); // 响应已开始发送，无法再补 JSON，只能断开连接
        return;
      }
      sendJson(res, err.statusCode || 500, { ok: false, error: err.message || '服务器内部错误' });
    });
  });
  return server;
}

/**
 * 读取环境变量并启动服务（HOST / PORT / SNAP_PUSH_DIR）。
 */
export function start() {
  const host = process.env.HOST || DEFAULT_HOST;
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`snap-push 已启动：http://${host}:${port}`);
    console.log(`本机图片目录：${process.env.SNAP_PUSH_DIR || DEFAULT_SNAP_DIR}`);
  });
  return server;
}

// 入口判断：node server.js、curl | node 管道、node -e 内联执行时均自动启动；
// 被其它模块 import（例如测试用 node --test 运行）时不产生任何副作用。
// 说明：argv 无脚本参数（stdin/内联）即视为直跑——配合
//   curl -fsSL <server.js> | node --input-type=module  可直接运行、无需落盘。
const isDirectRun = !process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  start();
}
