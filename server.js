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
 * 把本地文件同步到远程服务器，返回实际使用的传输方式：
 *   1. ssh 一条命令完成「建目录 + 存在性检查」——远端已有同内容文件则妙传跳过（method: skip）；
 *   2. rsync 增量上传（method: rsync）；
 *   3. rsync 不可用（远端缺失，stderr 报 not found；或本地未安装）→ scp 兜底（method: scp）。
 * 任何失败抛出带 stderr 摘要的中文 Error。
 * 安全说明：host/user/dir/name 均已通过白名单校验后才进入本函数，嵌入远端命令串是安全的；
 *           本地子进程一律使用参数数组，不经 shell。
 */
export async function syncToRemote(localPath, name, { host, user, dir }) {
  // 第一步：ssh 探测（mkdir -p 保证远端目录存在；EXISTS/MISSING 判断能否妙传）
  const probeScript = `mkdir -p '${dir}' && (test -f '${dir}/${name}' && echo EXISTS || echo MISSING)`;
  const probe = await run('ssh', [...SSH_ARGS, `${user}@${host}`, probeScript]);
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

/** 占位首页（任务 2 会替换为完整的交互页面） */
function sendIndexPage(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>snap-push</title>
</head>
<body>
  <h1>snap-push</h1>
  <p>本地截图推送服务已就绪：选择目标服务器并上传截图，即可获得服务器上的文件路径。</p>
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
      // md5 内容寻址：同名即同内容，已存在则跳过写入
      await fs.promises.writeFile(localPath, bytes);
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

// 入口判断：只有直接运行（node server.js）时才自动启动；
// 被测试或其它模块 import 时不产生任何副作用。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
