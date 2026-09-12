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
import os from 'node:os';
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
const MAX_JSON_BODY = 4 * 1024 * 1024;       // 配置/历史 JSON 请求体上限：4MB
const SUBPROCESS_TIMEOUT_MS = 30_000;        // ssh/rsync/scp 单次执行超时
const PROBE_TIMEOUT_MS = 10_000;             // 目标探测超时：探测是后台行为，收短避免长时间占用
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
  if (trimmed.length === 0) return null;
  // 拒绝 .. 路径段：/tmp/../etc 这类目录会把远端读/删能力放大到父目录
  if (trimmed.split('/').some((seg) => seg === '..')) return null;
  return trimmed;
}

/**
 * 校验本机存储目录中读/删的文件名：必须匹配 <32 位小写 hex>-<安全名>。
 * 该模式天然排除路径分隔符与 ".."，是防路径穿越的最后一道闸。
 */
export function isValidStoredName(name) {
  return typeof name === 'string' && /^[0-9a-f]{32}-[A-Za-z0-9._-]+$/.test(name);
}

/**
 * 取出存储名里的内容 md5（前 32 位小写 hex）。
 * 不符合 <md5>-<原名> 约定时返回 null——调用方据此决定按“内容”还是按“文件名”处理。
 */
export function md5OfName(name) {
  const m = /^([0-9a-f]{32})-/.exec(typeof name === 'string' ? name : '');
  return m ? m[1] : null;
}

/**
 * 从存储名 <md5>-<原名> 中还原展示原名；不符合约定时整体当作原名。
 * 用于“远端名 → 本地名”的重命名（如 pull 时用远端名做原名）。
 */
export function origFromStoredName(name) {
  const m = /^[0-9a-f]{32}-(.+)$/.exec(typeof name === 'string' ? name : '');
  return m ? m[1] : (name || 'image.png');
}

/**
 * 校验远端文件名（比本地存储名宽松）：仅允许 [A-Za-z0-9._-]。
 * 不含斜杠、引号、空白，因此可安全嵌入单引号 shell 命令；
 * 同时兼容用户手工放进目标目录、不带 md5 前缀的文件。
 * 纯点（. / ..）单独拒绝，避免目录穿越语义。
 */
export function validateRemoteFileName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return /^\.+$/.test(name) ? null : name;
}

/**
 * 构造“探测 + 列目录”的远端 shell 脚本（在远端 sh 执行）：
 *   1) 目录不存在/不可读 → 只输出 __DIR_MISSING__，前端按“远端为空”处理；
 *   2) 用 command -v 检测远端是否装了 rsync（决定 pull 走 rsync 还是 scp）；
 *   3) ls -1 列出目录内文件名，交给 parseRemoteList 过滤解析。
 * dir 进入本函数前已过 validateDir 白名单，嵌入单引号是安全的。
 */
export function buildRemoteListScript(dir) {
  return [
    `if [ -d '${dir}' ]; then`,
    '  echo ::DIR_OK::;',
    '  command -v rsync >/dev/null 2>&1 && echo ::RSYNC_OK:: || echo ::RSYNC_NO::;',
    `  ls -1 '${dir}' 2>/dev/null;`,
    'else',
    '  echo ::DIR_MISSING::;',
    'fi',
  ].join('\n');
}

/**
 * 解析 buildRemoteListScript 的输出。
 * 标记行（__DIR_OK__ / __RSYNC_OK__ / __RSYNC_NO__ / __DIR_MISSING__）不进入文件列表；
 * 文件名行只保留通过 validateRemoteFileName 的项，并尽量解析出 md5。
 * 目录缺失时返回空清单（dirExists:false），由调用方按“远端为空”处理。
 */
export function parseRemoteList(stdout) {
  const result = { dirExists: false, hasRsync: false, files: [] };
  const lines = String(stdout || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '::DIR_MISSING::') return { dirExists: false, hasRsync: false, files: [] };
    if (line === '::DIR_OK::') { result.dirExists = true; continue; }
    if (line === '::RSYNC_OK::') { result.hasRsync = true; continue; }
    if (line === '::RSYNC_NO::') continue;
    const name = validateRemoteFileName(line);
    if (!name) continue; // 含空格/特殊字符等：不是本工具管理的文件，忽略
    result.files.push({ name, md5: md5OfName(name) });
  }
  return result;
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
// 一·五、实例服务 ID：区分「都是 localhost 却指向不同机器」的场景
// =====================================================================

// 实例身份文件默认位置（可用 SNAP_PUSH_ID_FILE 覆盖）：
// 身份采用「首次运行生成并持久化的随机 secret」，刻意不依赖 hostname/IP——
// 否则切网/VPN/重启后 IP 或 hostname 变化会导致身份变化，浏览器里
// 按实例隔离的目标/历史数据看起来「丢失」。身份文件一旦生成就稳定复用。
const DEFAULT_CONFIG_DIR = () =>
  path.join(os.homedir(), '.config', 'snap-push');

// app 配置与数据目录：SNAP_PUSH_CONFIG_DIR 或 ~/.config/snap-push；
// 目录内保存 instance-id（身份）、servers.json（服务器配置）、history.json（同步记录）。
export function resolveConfigDir(opts = {}) {
  return opts.configDir || process.env.SNAP_PUSH_CONFIG_DIR || DEFAULT_CONFIG_DIR();
}

// 默认路径身份 secret 的进程内缓存：避免每次请求都读一次文件
let cachedSecret = null;

/**
 * 纯函数：由展示名 label 与身份 secret 计算稳定短 hash（8 位 hex）。
 * 同 label + secret → 同一 hash；任一变化 → 不同 hash。
 */
export function serviceIdFrom(label, secret) {
  const hash = crypto.createHash('sha256').update(`${label}|${secret}`).digest('hex').slice(0, 8);
  return { label, hash };
}

/**
 * 读取或创建身份 secret（32 位随机 hex）。
 * 优先级：opts.secret → 环境变量 SNAP_PUSH_ID → 身份文件（不存在则创建）→ 空串。
 * 身份文件写入/读取失败（如 home 只读）时返回空串，由调用方降级为 hostname 兜底。
 * @param {object} [opts]
 * @param {string} [opts.secret] 直接指定 secret（测试/固定复现用，跳过文件）
 * @param {string} [opts.secretFile] 身份文件路径（测试注入用）；缺省取 SNAP_PUSH_ID_FILE 或默认位置
 */
export function getOrCreateSecret(opts = {}) {
  if (opts.secret) return opts.secret;
  const fromEnv = process.env.SNAP_PUSH_ID;
  if (fromEnv) return fromEnv;
  const configDir = resolveConfigDir(opts);
  const defaultFile = path.join(configDir, 'instance-id');
  const idFile = opts.secretFile || process.env.SNAP_PUSH_ID_FILE || defaultFile;
  // 仅默认路径参与进程内缓存；测试注入自定义路径时每次直读，避免串缓存
  const cacheable = !opts.secretFile && !process.env.SNAP_PUSH_ID_FILE;
  try {
    if (cacheable && cachedSecret) return cachedSecret;
    let secret = null;
    try {
      secret = fs.readFileSync(idFile, 'utf8').trim();
    } catch {
      secret = null; // 文件不存在或不可读
    }
    if (!secret) {
      secret = crypto.randomBytes(16).toString('hex'); // 32 位 hex
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      fs.writeFileSync(idFile, secret + '\n', { mode: 0o600 });
    }
    if (cacheable) cachedSecret = secret;
    return secret;
  } catch {
    return ''; // home 不可写等：交由调用方用 hostname 兜底
  }
}

/**
 * 计算本机 snap-push 实例的唯一服务 ID。
 * 展示 label 仅用 hostname（IP 完全不参与身份，避免切网/VPN 后变化）；
 * 身份来自持久化随机 secret（见 getOrCreateSecret），获取失败时降级用 hostname 兜底 hash，
 * 保证服务始终可用（代价：该兜底场景下身份不跨机器唯一）。
 * 典型场景：同一浏览器先后经 ssh -L 指向不同机器的 snap-push，
 * 地址都是 127.0.0.1:8123（同源），靠该 ID 才能区分是哪一台实例。
 * @param {object} [opts] 同 getOrCreateSecret，测试可注入
 */
export function computeServiceId(opts = {}) {
  const hostname = os.hostname();
  const secret = getOrCreateSecret(opts);
  // secret 缺失（写入失败等）时退化为 hostname 兜底，仍保证同机同会话内稳定
  const { label, hash } = serviceIdFrom(hostname, secret || hostname);
  return { hostname, label, hash };
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

/**
 * 与 run 相同的执行封装，但 stdout 以 Buffer 收集（不做 utf8 解码），
 * 用于读取图片等二进制内容。超过 limit 字节立即强杀并失败，避免大文件占满内存。
 */
export function runBuffer(cmd, args, timeoutMs = SUBPROCESS_TIMEOUT_MS, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动命令 ${cmd}：${err.message}`));
      return;
    }

    const chunks = [];
    let total = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false; // 防止 超限 / error / close 之间重复 settle
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(err);
    };

    child.stdout.on('data', (d) => {
      if (settled) return;
      total += d.length;
      if (total > limit) {
        fail(new Error(`远端文件超过大小上限（${formatSize(limit)}）`));
        return;
      }
      chunks.push(d);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      const e = new Error(`无法执行命令 ${cmd}：${err.message}`);
      e.isMissingBinary = err.code === 'ENOENT';
      fail(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`命令超时（超过 ${timeoutMs}ms 已终止）：${cmd}`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
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

/**
 * 从远端取回单个文件到本地路径（pull 方向，与 syncToRemote 相反）：
 * 优先 rsync -az；本地或远端缺 rsync 时回退 scp；其余错误带 stderr 摘要抛出。
 */
export async function pullToLocal(localPath, name, { host, user, dir }) {
  let rsyncResult = null;
  let localRsyncMissing = false;
  try {
    rsyncResult = await run('rsync', [
      '-az',
      '-e',
      `ssh ${SSH_ARGS.join(' ')}`,
      `${user}@${host}:${dir}/${name}`,
      localPath,
    ]);
  } catch (err) {
    if (!err.isMissingBinary) throw err; // 本地 rsync 缺失以外的错误直接抛出
    localRsyncMissing = true;
  }

  if (rsyncResult && rsyncResult.code === 0) {
    return { method: 'rsync' };
  }
  const remoteRsyncMissing =
    rsyncResult && rsyncResult.code !== 0 && rsyncResult.stderr.toLowerCase().includes('not found');
  if (localRsyncMissing || remoteRsyncMissing) {
    const r = await run('scp', [...SSH_ARGS, `${user}@${host}:${dir}/${name}`, localPath]);
    if (r.code !== 0) {
      throw new Error(`scp 拉取失败（退出码 ${r.code}）：${summarizeStderr(r.stderr)}`);
    }
    return { method: 'scp' };
  }

  throw new Error(`rsync 拉取失败（退出码 ${rsyncResult.code}）：${summarizeStderr(rsyncResult.stderr)}`);
}

// =====================================================================
// 三·五、服务端 JSON 存储：app 配置与数据目录下的持久化文件
// =====================================================================

/**
 * 通用 JSON 存储：文件缺失、内容损坏或形状不符时回退 fallback，绝不抛异常。
 *
 * update(mutator) 串行 read-modify-write：mutator 同步修改 state 并返回结果，
 * 随后原子写（写同目录临时文件 → rename 覆盖），避免并发丢更新与半截文件。
 * 每个 store 一条内部写链，同一文件不交叉；不同文件互不阻塞。
 *
 * @param {string} file 目标文件绝对路径
 * @param {any} fallback 期望形状（数组或对象）；read 后形状不符也回退
 * @param {(value:any)=>boolean} [isValid] 自定义形状校验；缺省按 fallback 类型判断
 */
export function createJsonStore(file, fallback, isValid) {
  const check = isValid || ((v) =>
    Array.isArray(fallback)
      ? Array.isArray(v)
      : (v !== null && typeof v === 'object' && !Array.isArray(v)));
  let chain = Promise.resolve();

  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return check(value) ? value : fallback;
    } catch {
      return fallback; // 文件不存在 / 内容损坏：回退默认值
    }
  }

  function writeSync(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function update(mutator) {
    const job = chain.then(() => {
      const state = read();
      const result = mutator(state);
      writeSync(state);
      return result;
    });
    chain = job.catch(() => {}); // 吞掉失败，保持写链不中断
    return job;
  }

  return { read, update };
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
 *   - 图库：按当前目标渲染全部图片（本地存在 + 远端独有），
 *     /api/library 与 localStorage 历史（snap-push.history）求交，远端独有取自 remoteIndex，
 *     按当前目标（host+dir）过滤，支持复制路径/URL、删除（联动清历史记录）、对账清理。
 *
 * 安全约定：动态内容一律 createElement + textContent，绝不拼接 innerHTML；
 *           文件名进入 URL 前经 encodeURIComponent 编码。
 * 书写约束：整个页面位于外层模板字符串内，因此页面内禁用反引号与反斜杠
 *           （页面 JS 一律普通引号拼接），也不出现 ${ 序列，避免两层语法互扰。
 */
function sendIndexPage(res, svc) {
  // 本实例标识：注入 data-* 供页面做展示与存储键命名空间
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
#svcBadge { font-size: 12px; color: #57606a; background: #f0f2f4; border: 1px solid #d0d7de; border-radius: 10px; padding: 1px 8px; white-space: nowrap; }
#svcBadge code { background: none; padding: 0; font-size: 11px; color: #8250df; }
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
#grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; position: relative; }
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

/* —— 卡片新增/删除动效（图库网格与同步抽屉共用）——
   新增：从下滑入 + 淡入 + 模糊到清晰；删除：缩小 + 旋转滑出 + 淡出。
   交错延迟由页面按序号写入 animation-delay；入场用 backwards，动画结束后不残留 filter 图层。 */
@keyframes card-in {
  0%   { opacity: 0; transform: translateY(16px); filter: blur(5px); }
  100% { opacity: 1; transform: translateY(0);    filter: blur(0); }
}
@keyframes card-out {
  0%   { opacity: 1; transform: translateX(0) rotate(0) scale(1); }
  100% { opacity: 0; transform: translateX(26px) rotate(4deg) scale(.82); }
}
.card-enter { animation: card-in .38s cubic-bezier(.22,1,.36,1) backwards; }
/* 放在 .card-enter 之后：删除时同一元素可能同时带两类，需由出场动画覆盖入场 */
.card-leave { animation: card-out .32s ease-in both; pointer-events: none; }
/* 系统开启「减少动态效果」时不做动画，直接呈现终态 */
@media (prefers-reduced-motion: reduce) { .card-enter, .card-leave { animation: none; } }

/* —— 图库区：左侧网格占满；「同步」抽屉为悬浮层（脱离布局，不影响网格宽度/列数） —— */
.hist-area { position: relative; }
#syncDrawer {
  position: fixed; top: 64px; right: 16px; z-index: 50;
  width: 300px; max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(31, 35, 40, .15); overflow: hidden;
  /* 收起态：整体从“刚好移出视口右缘”开始（+100% 宽 +16px 边距），配合动画从右缘滑入 */
  transform: translateX(calc(100% + 16px));
  opacity: 0;
  pointer-events: none;
  transition: transform .24s ease, opacity .18s ease;
}
#syncDrawer.open { transform: translateX(0); opacity: 1; pointer-events: auto; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid #f0f2f4; }
.drawer-head strong { font-size: 13px; word-break: break-all; }
#syncClose { font-size: 15px; line-height: 1; padding: 1px 8px; }
.drawer-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 10px; position: relative; }
.sync-empty { color: #8b949e; font-size: 12px; text-align: center; padding: 14px 6px; }
/* 抽屉内缺项 = 历史卡片样式，仅单列铺满抽屉宽；flex:0 0 auto 防止条目过多时被压缩（否则操作行被裁且不触发滚动） */
.sync-card { width: 100%; flex: 0 0 auto; }
.sync-card .card-ops { justify-content: space-between; align-items: center; margin-top: 2px; }
.sync-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
.sync-err { color: #cf222e; font-size: 11px; word-break: break-all; line-height: 1.4; }
.drawer-foot { display: flex; align-items: center; gap: 6px; justify-content: space-between; padding: 8px 10px; border-top: 1px solid #f0f2f4; }
.drawer-foot .sync-progress { color: #57606a; font-size: 12px; }

/* —— 目标状态徽标 + 对账摘要 —— */
#targetStatus { font-size: 12px; color: #57606a; white-space: nowrap; }
#targetStatus.online { color: #1a7f37; }
#targetStatus.offline { color: #cf222e; }
#recheckBtn { font-size: 12px; }
#cleanStaleBtn { font-size: 12px; margin-left: 8px; }
/* —— 卡片状态徽标 —— */
.badge-stale { background: #cf222e; }
.badge-remote-only { background: #0969da; }
/* —— 抽屉来源选择 —— */
.drawer-src { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid #f0f2f4; font-size: 12px; }
.drawer-src select { flex: 1; }
/* —— 确认模态 —— */
#confirmMask { position: fixed; inset: 0; z-index: 100; background: rgba(31, 35, 40, .35); display: flex; align-items: center; justify-content: center; }
#confirmMask[hidden] { display: none; }
.confirm-box { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; box-shadow: 0 8px 24px rgba(31, 35, 40, .2); width: 380px; max-width: calc(100vw - 32px); padding: 14px 16px; }
.confirm-box h3 { margin: 0 0 8px; font-size: 14px; }
.confirm-box p { margin: 0 0 10px; font-size: 13px; line-height: 1.5; word-break: break-all; }
.confirm-check { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; margin-bottom: 12px; cursor: pointer; }
/* display:flex 会覆盖 hidden 属性默认的 display:none，需显式兜底，否则无复选项时残留空白复选框 */
.confirm-check[hidden] { display: none; }
.confirm-ops { display: flex; justify-content: flex-end; gap: 8px; }
</style>
</head>
<body data-svc="${svc.hash}" data-svc-label="${svc.label}">
<header>
  <div class="header-inner">
    <h1>snap-push</h1>
    <span id="svcBadge" title="本机服务实例（hostname@ip，短 hash 用于区分同源 localhost）"></span>
    <label for="targetSel">目标</label>
    <select id="targetSel"></select>
    <span id="targetStatus"></span>
    <button type="button" id="manageBtn">⚙ 管理</button>
    <button type="button" id="syncLibBtn" disabled title="在当前目标与来源之间同步图片（来源可为本地或其他服务器）">同步</button>
    <button type="button" id="recheckBtn" title="强制重新探测当前目标服务器">重新对账</button>
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

  <!-- 图库：当前目标下的全部图片（本地 + 远端独有）；右侧抽屉（同步）为悬浮层，不遮挡左侧 -->
  <section>
    <h2>图库 <span class="count" id="historyCount"></span>
      <button type="button" id="cleanStaleBtn" hidden>清理失效记录</button>
    </h2>
    <div class="hist-area">
      <div id="grid"></div>
      <aside id="syncDrawer">
        <header class="drawer-head">
          <strong id="syncTitle">同步…</strong>
          <button type="button" id="syncClose" title="关闭">×</button>
        </header>
        <div class="drawer-src">
          <label for="syncSource">来源</label>
          <select id="syncSource"></select>
        </div>
        <div id="syncList" class="drawer-list"></div>
        <footer class="drawer-foot">
          <button type="button" id="syncSelAll">全选</button>
          <button type="button" id="syncSelBtn" disabled>同步选中(0)</button>
        </footer>
      </aside>
    </div>
  </section>
</main>

<!-- 通用确认弹窗：window.confirm 放不下复选项，这里自绘一个轻量模态 -->
<div id="confirmMask" hidden>
  <div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
    <h3 id="confirmTitle"></h3>
    <p id="confirmMsg"></p>
    <label class="confirm-check" id="confirmCheckWrap" hidden>
      <input type="checkbox" id="confirmCheck">
      <span id="confirmCheckLabel"></span>
    </label>
    <div class="confirm-ops">
      <button type="button" id="confirmCancel">取消</button>
      <button type="button" id="confirmOk" class="danger">删除</button>
    </div>
  </div>
</div>
<script>
(function () {
  'use strict';

  // =============== localStorage 封装 ===============
  // 读取失败（未存过/内容损坏/隐私模式禁用）时静默回退默认值；
  // 写入失败只是不持久化，都不阻断页面功能。
  //
  // 存储键按「本实例服务 ID」命名空间隔离：同一浏览器经 ssh -L 先后指向
  // 不同机器的 snap-push 时，地址都是 127.0.0.1:8123（同源），各实例的
  // 配置/历史/目标记忆互不串扰；data-svc 缺失（旧缓存页面）则回退旧键名。
  var svcHash = (document.body && document.body.getAttribute('data-svc')) || '';
  function storageKey(base) {
    return svcHash ? 'snap-push@' + svcHash + '.' + base : 'snap-push.' + base;
  }
  var SERVERS_KEY = storageKey('servers');
  var HISTORY_KEY = storageKey('history');
  var TARGET_KEY = storageKey('target'); // 记忆上次选中的目标（'local' 或服务器 id），刷新后恢复
  var REMOTE_INDEX_KEY = storageKey('remoteIndex'); // 远端清单缓存：{"<host>|<dir>": {fetchedAt, files}}

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

  // 一次性迁移：升级到「按实例命名空间」之前，旧键（snap-push.*）里可能存有
  // 配置/历史/目标。仅当本实例命名空间尚无数据时，把旧键数据复制过去（只复制不删除，安全）。
  function legacyKey(base) { return 'snap-push.' + base; }
  function migrateLegacy() {
    if (!svcHash) return; // 旧缓存页面本身就在用旧键，无需迁移
    ['servers', 'history', 'target'].forEach(function (base) {
      var ns = storageKey(base);
      if (loadJson(ns, null) !== null) return; // 命名空间已有数据，不覆盖
      var raw = null;
      try { raw = localStorage.getItem(legacyKey(base)); } catch (e) { /* 忽略 */ }
      if (raw === null) return; // 旧键也没数据
      try { localStorage.setItem(ns, raw); } catch (e) {
        console.warn('迁移旧数据 ' + legacyKey(base) + ' 失败：', e);
      }
    });
  }
  migrateLegacy();

  // =============== 页面状态 ===============
  var servers = loadJson(SERVERS_KEY, []); // [{id,label,host,user,dir,urlBase}]
  if (!Array.isArray(servers)) servers = [];
  // history 结构：{"<localName>": {orig, targets: [{key,label,host,dir,remotePath,url,method,time}]}}
  var history = loadJson(HISTORY_KEY, {});
  if (typeof history !== 'object' || history === null || Array.isArray(history)) history = {};
  var libFiles = []; // 最近一次 GET /api/library 的文件清单
  var remoteIndex = loadJson(REMOTE_INDEX_KEY, {}); // 远端清单缓存，见 REMOTE_INDEX_KEY
  if (typeof remoteIndex !== 'object' || remoteIndex === null || Array.isArray(remoteIndex)) remoteIndex = {};
  var probeState = {}; // 内存态：<targetKey> -> { at, data } 最近一次探测结果（避免频繁 ssh）
  var probeSeq = {}; // <targetKey> -> 最新请求序号，用于丢弃过期响应
  var probeBusy = {}; // <targetKey> -> true 表示探测进行中
  var PROBE_TTL_MS = 30000; // 探测结果缓存有效期：期间切换目标直接复用，手动「重新对账」可强制刷新
  var syncSelected = {}; // 「从图库补齐」抽屉的勾选集合：localName -> true
  var syncBusy = false; // 同步进行中：期间禁用勾选/按钮，避免交叉

  // =============== DOM 引用 ===============
  var targetSel = document.getElementById('targetSel');
  var targetStatus = document.getElementById('targetStatus');
  var recheckBtn = document.getElementById('recheckBtn');
  var cleanStaleBtn = document.getElementById('cleanStaleBtn');
  var manageBtn = document.getElementById('manageBtn');
  var svcBadge = document.getElementById('svcBadge');
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
  var syncLibBtn = document.getElementById('syncLibBtn');
  var syncSourceSel = document.getElementById('syncSource');
  var syncDrawer = document.getElementById('syncDrawer');
  var syncTitle = document.getElementById('syncTitle');
  var syncList = document.getElementById('syncList');
  var syncClose = document.getElementById('syncClose');
  var syncSelAll = document.getElementById('syncSelAll');
  // 确认弹窗元素
  var confirmMask = document.getElementById('confirmMask');
  var confirmTitle = document.getElementById('confirmTitle');
  var confirmMsg = document.getElementById('confirmMsg');
  var confirmCheckWrap = document.getElementById('confirmCheckWrap');
  var confirmCheck = document.getElementById('confirmCheck');
  var confirmCheckLabel = document.getElementById('confirmCheckLabel');
  var confirmOk = document.getElementById('confirmOk');
  var confirmCancel = document.getElementById('confirmCancel');
  var syncSelBtn = document.getElementById('syncSelBtn');

  // 展示本实例标识（hostname@ip + 短 hash），帮助识别当前 localhost 指向哪台机器
  if (svcBadge) {
    var svcLabel = (document.body && document.body.getAttribute('data-svc-label')) || '';
    svcBadge.textContent = svcLabel ? svcLabel + '  ' : '';
    if (svcHash) {
      var svcCode = document.createElement('code');
      svcCode.textContent = '#' + svcHash;
      svcBadge.appendChild(svcCode);
    }
  }

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

  // 读取上次记住的目标；仅接受 'local' 或仍存在的服务器 id（配置被删/被篡改则视为无效）
  function savedTarget() {
    var v = loadJson(TARGET_KEY, null); // loadJson 会 JSON 解码；未存过返回 null
    return (v === 'local' || serverById(v)) ? v : null;
  }

  // 重渲染目标下拉：本机 + 全部服务器（显示昵称，无昵称显示 IP）
  // 恢复顺序：上次记住的目标 → 当前值 → 本机；设置后立即固化到 localStorage
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
    var keep =
      (savedTarget() || (prev && (prev === 'local' || serverById(prev)) && prev) || 'local');
    targetSel.value = keep;
    saveJson(TARGET_KEY, targetSel.value); // 固化实际生效的选择
  }

  // =============== 远端探测与对账 ===============

  // 目标唯一键：本机为空串；服务器用 host|dir（昵称变化不影响缓存与对账）
  function targetKey(srv) {
    return srv ? (srv.host + '|' + srv.dir) : '';
  }

  // 存储名/文件名前 32 位 hex 即内容 md5；不符合约定返回 null
  function md5Of(name) {
    var m = /^([0-9a-f]{32})-/.exec(name || '');
    return m ? m[1] : null;
  }

  // 取路径最后一段（远端路径 /dir/name → name）
  function baseName(p) {
    var s = p || '';
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // 展示原名：去掉 <md5>- 前缀；不是存储名则原样返回
  function origFromName(name) {
    var base = baseName(name);
    return /^[0-9a-f]{32}-/.test(base) ? base.slice(33) : base;
  }

  // 在 history 中查「本地文件 → 某目标」的推送记录
  function findTargetRec(localName, srv) {
    var rec = history[localName];
    if (!rec || !Array.isArray(rec.targets)) return null;
    for (var i = 0; i < rec.targets.length; i++) {
      if (rec.targets[i].host === srv.host && rec.targets[i].dir === srv.dir) return rec.targets[i];
    }
    return null;
  }

  // 目标上下文下的展示名：本机用本地原名；服务器优先用该目标上的远端名
  function nameOnTarget(localName, srv) {
    var rec = history[localName];
    var localOrig = (rec && rec.orig) ? rec.orig : origFromName(localName);
    if (!srv) return localOrig;
    var t = findTargetRec(localName, srv);
    if (!t) return localOrig;
    return origFromName(t.remoteName || t.remotePath || '') || localOrig;
  }

  // 远端清单里是否含某 md5（对账与抽屉去重都用它）
  function remoteHasMd5(srv, md5) {
    var idx = remoteIndex[targetKey(srv)];
    if (!idx || !Array.isArray(idx.files)) return false;
    return idx.files.some(function (f) { return f.md5 === md5; });
  }

  // 本地图库中该 md5 对应的文件名（同内容不同原名皆可）
  function localNameByMd5(md5) {
    for (var i = 0; i < libFiles.length; i++) {
      if (md5Of(libFiles[i].name) === md5) return libFiles[i].name;
    }
    return null;
  }

  // 组装“已恢复”记录：本地有字节、远端确认存在、但缺 history（#3 场景）
  function makeRecoveredTarget(srv, remoteName) {
    return {
      key: srv.id,
      label: srv.label || srv.host,
      host: srv.host,
      dir: srv.dir,
      remoteName: remoteName,
      remotePath: srv.dir + '/' + remoteName,
      url: srv.urlBase ? srv.urlBase + '/' + remoteName : '',
      method: 'recovered',
      origin: 'recovered',
      time: new Date().toISOString(),
      verifiedAt: Date.now(),
    };
  }

  // 用远端清单对账本地 history（只在探测成功时调用）：
  //   1) 有记录且远端在 → 刷新 verifiedAt、清 stale、校正 remoteName；
  //   2) 有记录但远端无 → 标 stale（仅当该记录在本次探测开始前就已确认，避免把探测期间新上传误标）；
  //   3) 本地有字节、远端有同 md5、却缺记录 → 补录 recovered（同 md5 只补“规范文件”一条）。
  // probeStartedAt：本次探测发起时间，用于竞态判断。
  function reconcileWithRemote(srv, files, probeStartedAt) {
    var byMd5 = {};
    (files || []).forEach(function (f) { if (f.md5) byMd5[f.md5] = f.name; });
    var changed = false;

    // 1) 已有记录的：确认 / 失效
    libFiles.forEach(function (lf) {
      var md5 = md5Of(lf.name);
      if (!md5) return;
      var remoteName = byMd5[md5];
      var t = findTargetRec(lf.name, srv);
      if (!t) return;
      if (remoteName) {
        if (t.stale) { delete t.stale; changed = true; }
        if (t.remoteName !== remoteName) { t.remoteName = remoteName; changed = true; }
        t.verifiedAt = Date.now();
        changed = true;
      } else if (!t.stale && (!t.verifiedAt || t.verifiedAt < probeStartedAt)) {
        t.stale = true; // 远端已删：标记失效
        changed = true;
      }
    });

    // 2) 缺记录的：本地有字节 + 远端有同 md5 → 选“规范文件”补录（精确同名 > 最近修改）
    var canonical = {}; // md5 -> { name, mtime, exact }
    libFiles.forEach(function (lf) {
      var md5 = md5Of(lf.name);
      if (!md5 || !byMd5[md5]) return;
      if (findTargetRec(lf.name, srv)) return; // 已有记录
      var exact = lf.name === byMd5[md5];
      var cur = canonical[md5];
      if (!cur
        || (exact && !cur.exact)
        || (exact === cur.exact && String(lf.mtime) > String(cur.mtime))) {
        canonical[md5] = { name: lf.name, mtime: lf.mtime, exact: exact };
      }
    });
    Object.keys(canonical).forEach(function (md5) {
      var lfName = canonical[md5].name;
      var rec = history[lfName];
      if (!rec || !Array.isArray(rec.targets)) {
        rec = history[lfName] = { orig: origOf(lfName), targets: [] };
      }
      rec.targets.push(makeRecoveredTarget(srv, byMd5[md5]));
      changed = true;
    });

    if (changed) saveJson(HISTORY_KEY, history);
  }

  // 记录探测状态到 servers[i].status（持久化“上次已知”，下次打开先显示再刷新）
  function saveServerStatus(srv, patch) {
    var s = serverById(srv.id);
    if (!s) return;
    s.status = s.status || {};
    for (var k in patch) s.status[k] = patch[k];
    s.status.lastProbe = Date.now();
    saveJson(SERVERS_KEY, servers);
  }

  // 探测成功：落 remoteIndex、写状态、按目标对账
  function applyProbe(srv, data, probeStartedAt) {
    remoteIndex[targetKey(srv)] = { fetchedAt: Date.now(), files: data.files || [] };
    saveJson(REMOTE_INDEX_KEY, remoteIndex);
    saveServerStatus(srv, {
      reachable: true,
      dirExists: !!data.dirExists,
      hasRsync: !!data.hasRsync,
      error: '',
    });
    reconcileWithRemote(srv, data.files || [], probeStartedAt);
  }

  // 探测失败：只记状态，绝不改历史记录（否则会把整批记录误判为失效）
  function markProbeError(srv, error) {
    saveServerStatus(srv, { reachable: false, error: error || '探测失败' });
  }

  // 探测某服务器目标：30s 内复用缓存；force 时强制刷新；过期响应按 targetKey 丢弃
  async function probeTarget(srv, force) {
    if (!srv) return;
    var key = targetKey(srv);
    if (!force && probeState[key] && Date.now() - probeState[key].at < PROBE_TTL_MS) {
      renderStatus();
      return;
    }
    var seq = (probeSeq[key] || 0) + 1;
    probeSeq[key] = seq;
    probeBusy[key] = true;
    renderStatus();
    var startedAt = Date.now(); // 竞态基准：早于此刻确认过的记录，才允许被本次探测判为失效
    var data = null;
    try {
      var p = new URLSearchParams();
      p.set('host', srv.host);
      p.set('user', srv.user || 'root');
      p.set('dir', srv.dir);
      var res = await fetch('/api/remote?' + p.toString());
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (!res.ok || !body) throw new Error((body && body.error) || ('HTTP ' + res.status));
      data = body;
    } catch (e) {
      data = { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
    if (probeSeq[key] !== seq) return; // 已切到别的目标或发起了更新的探测：丢弃本次结果
    probeBusy[key] = false;
    probeState[key] = { at: Date.now(), data: data };
    if (data.ok) applyProbe(srv, data, startedAt);
    else markProbeError(srv, data.error);
    renderStatus();
    renderGrid();
  }

  // 当前目标的对账摘要：远端独有（远端有、本地无）与已缺失（history 标 stale）数量
  function summaryFor(srv) {
    var idx = remoteIndex[targetKey(srv)];
    var remoteOnly = 0;
    if (idx && Array.isArray(idx.files)) {
      idx.files.forEach(function (f) {
        if (f.md5 && !localNameByMd5(f.md5)) remoteOnly++;
      });
    }
    var stale = 0;
    Object.keys(history).forEach(function (k) {
      var t = findTargetRec(k, srv);
      if (t && t.stale) stale++;
    });
    return { remoteOnly: remoteOnly, stale: stale };
  }

  // 状态徽标：探测中 / 在线（可带目录缺失、scp 降级说明）/ 离线，并附对账摘要
  function renderStatus() {
    var srv = currentServer();
    targetStatus.textContent = '';
    targetStatus.className = '';
    targetStatus.title = '';
    cleanStaleBtn.hidden = true;
    if (!srv) return;
    var key = targetKey(srv);
    if (probeBusy[key]) { targetStatus.textContent = '检测中…'; return; }
    var s = serverById(srv.id);
    var st = s && s.status;
    if (!st) { targetStatus.textContent = '未探测'; return; }
    if (!st.reachable) {
      targetStatus.textContent = '离线';
      targetStatus.className = 'offline';
      targetStatus.title = st.error || '';
      return;
    }
    var sum = summaryFor(srv);
    var text = '在线';
    if (!st.dirExists) text += '（目录不存在）';
    else if (!st.hasRsync) text += '（scp）';
    if (sum.remoteOnly) text += ' · 远端独有 ' + sum.remoteOnly;
    if (sum.stale) text += ' · 已缺失 ' + sum.stale;
    targetStatus.textContent = text;
    targetStatus.className = 'online';
    cleanStaleBtn.hidden = !sum.stale;
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
      delete s.status; // host/dir 可能已变：旧探测状态作废
    } else {
      s = { id: genId(), label: label, host: host, user: user, dir: dir, urlBase: urlBase };
      servers.push(s);
    }
    saveJson(SERVERS_KEY, servers);
    resetForm();
    renderServerList();
    renderTargetSel();
    renderGrid(); // host/dir 变化会影响按目标过滤的结果
    // 当前目标正是刚保存的这台时，立即强制探测一次（配置可能已变）
    var cur = currentServer();
    if (cur && cur.id === s.id) probeTarget(cur, true);
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

  // 剪贴板图片命名用时间戳：本地时间 YYYYMMDD_HHmmss（各段补零，便于人类一眼分辨）
  function pasteStamp() {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
      + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }

  // 剪贴板图片的扩展名：优先按 MIME 类型推断，其次取原文件名扩展名，最后回退 png
  // （扩展名决定服务端 Content-Type，缺失会导致缩略图按二进制流返回）
  function pasteExt(file) {
    var byMime = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
    };
    if (file && file.type && byMime[file.type]) return byMime[file.type];
    var m = /\.([A-Za-z0-9]+)$/.exec((file && file.name) || '');
    return m ? m[1].toLowerCase() : 'png';
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
      remoteName: srv ? data.localName : '', // 推送时远端名与本地名一致
      remotePath: data.remotePath,
      url: data.url || '',
      method: data.method,
      origin: 'push',
      time: new Date().toISOString(),
      verifiedAt: Date.now(),
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
  async function uploadOne(file, srv, name) {
    name = name || file.name; // 未指定时沿用原始文件名（粘贴场景由调用方给 paste_<时间戳>）
    var entry = addResultRow(name);
    try {
      var p = targetParams(srv);
      p.set('name', name);
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
      recordUpload(data, name, srv);

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
  // nameFor(file, index) 可选：为图片生成上传用文件名（如粘贴场景），缺省用原始文件名
  async function uploadFiles(fileList, nameFor) {
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
      var name = nameFor ? nameFor(files[j], j) : null;
      await uploadOne(files[j], srv, name);
    }
    refreshHistory(); // 全部完成后刷新图库
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

  // 粘贴截图：剪贴板里带文件对象时（系统截图 / 复制图片）触发上传。
  // 剪贴板图片通常没有有意义的文件名，统一命名 paste_<YYYYMMDD_HHmmss>.<ext>；
  // 一次粘贴多张时共用同一时间戳，第 2 张起追加 _2、_3 区分。
  document.addEventListener('paste', function (e) {
    if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
    var stamp = pasteStamp();
    var n = 0;
    uploadFiles(e.clipboardData.files, function (file) {
      n++;
      return 'paste_' + stamp + (n === 1 ? '' : '_' + n) + '.' + pasteExt(file);
    });
  });

  // =============== 图库 ===============

  // 图库区错误占位：拉取失败时显示中文提示，绝不动 localStorage 记录
  function showHistoryError(message) {
    historyCount.textContent = '';
    grid.textContent = '';
    prevCards.grid = []; // 卡片已被清空，键集同步重置，避免下次对账复用已脱离文档的元素
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
    // 图库刚加载完：若已有探测结果，补做一次对账，
    // 避免「探测先于图库返回」时 #3（本地有、远端有、缺记录）漏补一轮
    var cur = currentServer();
    var cached = cur && probeState[targetKey(cur)];
    if (cur && cached && cached.data && cached.data.ok) {
      reconcileWithRemote(cur, cached.data.files || [], cached.at);
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

  // 卡片键追踪：由 reconcileCards 按「上一轮已存在的键」决定是否播入场动效。
  // 已显示的卡片复用原 DOM 元素、不重新挂载，因此探测/图库刷新触发的二次渲染不会重放动画。

  // 交错入场延迟：按卡片序号递增、封顶，避免长列表末尾等待过久
  function enterDelay(index) { return Math.min(index * 50, 300); }

  // 系统是否要求「减少动态效果」（垫片 window 无 matchMedia 时视为否）
  function reduceMotion() {
    return !!(window && typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // requestAnimationFrame 兜底：垫片 / Node 环境无此 API 时退化为 setTimeout
  function raf(fn) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }

  // 上一轮渲染的卡片元素表（scope -> [{key, el}]），供下一轮 FLIP 量取「变更前」位置
  var prevCards = { grid: [], sync: [] };

  // 量取一组卡片的视口位置：返回 { key: {left, top} }；无测量能力（DOM 垫片）返回空表
  function measureCards(cards) {
    var out = {};
    (cards || []).forEach(function (c) {
      var el = c && c.el;
      if (!el || typeof el.getBoundingClientRect !== 'function') return;
      var r = el.getBoundingClientRect();
      out[c.key] = { left: r.left, top: r.top };
    });
    return out;
  }

  // FLIP 移动过渡：把非新卡片从 first 记录的位置平滑过渡到当前位置。
  // 新增卡片（isNew）带入场动画，跳过以免与其 transform 冲突。
  function playFlip(cards, first, durationMs) {
    if (reduceMotion()) return;
    (cards || []).forEach(function (c) {
      if (!c || c.isNew || !first[c.key]) return;
      var el = c.el;
      if (!el || typeof el.getBoundingClientRect !== 'function') return;
      var nr = el.getBoundingClientRect();
      var dx = first[c.key].left - nr.left;
      var dy = first[c.key].top - nr.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      raf(function () {
        el.style.transition = 'transform ' + durationMs + 'ms ease';
        el.style.transform = '';
      });
    });
  }

  // 卡片键对账渲染：按 key 复用已存在的 DOM 元素，只增/删/移动差异项。
  //   - sig 相同 → 复用原元素（不重新挂载，入场动画不重放，缩略图不重载）；
  //   - sig 变化 → 重建该卡片元素（内容已变，不播入场动画）；
  //   - 新 key   → 新建元素并播入场动画。
  // entries 为期望顺序的 [{ key, sig, build(isNew) -> el }]。
  // 正在出场（_leaving）的旧元素本轮不删除，避免打断删除动画。
  function reconcileCards(container, scope, entries) {
    var prevList = prevCards[scope] || [];
    var prevMap = {};
    prevList.forEach(function (c) { if (c && c.el) prevMap[c.key] = c; });
    var first = measureCards(prevList); // 变更前位置，供 FLIP 补位

    var next = [];
    entries.forEach(function (e, i) {
      var prev = prevMap[e.key];
      var isNew = !prev;
      var el;
      if (prev && prev.sig === e.sig) {
        el = prev.el; // 内容未变：复用，不重新挂载
      } else {
        el = e.build(isNew); // 新卡片或内容变化：重建
        if (isNew && el.style) el.style.animationDelay = enterDelay(i) + 'ms';
      }
      var ref = (container.childNodes && container.childNodes[i]) || null;
      if (ref !== el) container.insertBefore(el, ref);
      next.push({ key: e.key, el: el, sig: e.sig, isNew: isNew });
    });

    // 移除本轮不再需要的节点（跳过正在播出场动画的元素）
    // 注意：不能用对象做元素集合（对象键会被转成 "[object Object]" 而全部命中），改用数组
    var keep = [];
    next.forEach(function (c) { keep.push(c.el); });
    var kids = container.childNodes ? Array.prototype.slice.call(container.childNodes) : [];
    kids.forEach(function (node) {
      if (keep.indexOf(node) >= 0 || (node && node._leaving)) return;
      container.removeChild(node);
    });

    playFlip(next, first, 280); // 其余卡片平滑滑到新位置
    prevCards[scope] = next;
  }

  // 图库本地卡片的内容签名：任一展示字段变化即重建该卡（无入场动画）
  function localCardSig(f, srv) {
    var rec = history[f.name];
    var records = (rec && Array.isArray(rec.targets))
      ? rec.targets.filter(function (x) { return !srv || (x.host === srv.host && x.dir === srv.dir); })
        .map(function (x) {
          return [x.label, x.host, x.dir, x.remoteName, x.remotePath, x.url,
            x.method, x.stale ? 1 : 0, x.time].join('~');
        }).join('|')
      : '';
    return ['L', f.name, f.size, f.mtime, nameOnTarget(f.name, srv),
      srv ? (srv.label || srv.host) : '', records].join('\u0001');
  }

  // 远端独有卡片的内容签名
  function remoteCardSig(item, srv) {
    return ['R', item.name, item.md5 || '', srv.label || srv.host, srv.dir].join('\u0001');
  }

  // 同步抽屉条目的内容签名（来源 / 目标 / 勾选 / 忙碌状态 / 本地副本变化都会触发重建）
  function syncCardSig(item, srcSrv, target) {
    return ['S', syncSourceSel.value, item.name, item.md5 || '', item.local ? 1 : 0,
      item.size, item.mtime, target ? (target.label || target.host) : '',
      syncSelected[item.name] ? 1 : 0, syncBusy ? 1 : 0,
      srcSrv ? (srcSrv.host + '|' + srcSrv.dir) : '',
      item.md5 ? (localNameByMd5(item.md5) || '') : ''].join('\u0001');
  }

  // 图库 = 当前目标下的全部图片：
  //   本机   → 全部本地图；
  //   服务器 → 该目标上存在的本地图（history ∪ remoteIndex）+ 远端独有（本地无副本）。
  // 本地卡片在前（沿用图库的时间倒序），远端独有在后（按文件名）。
  function renderGrid() {
    var srv = currentServer();
    renderStatus(); // 状态徽标与对账摘要随目标刷新
    // 无条件先同步「同步」按钮/抽屉：切到“还没图”的新目标时也必须解锁按钮
    refreshSyncArea();

    var locals = libFiles.filter(function (f) {
      if (!srv) return true;
      return targetHasMd5(srv, md5Of(f.name)); // history 记录或远端清单命中
    });

    var remotes = [];
    if (srv) {
      var idx = remoteIndex[targetKey(srv)];
      if (idx && Array.isArray(idx.files)) {
        var seen = {};
        idx.files.forEach(function (f) {
          if (f.md5) {
            if (localNameByMd5(f.md5)) return; // 本地已有同内容 → 走本地卡片
            if (seen[f.md5]) return; // 同 md5 只展示一条
            seen[f.md5] = true;
          }
          remotes.push(f); // 无 md5 的手工文件无法与本地去重，照常展示
        });
        remotes.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
      }
    }

    var total = locals.length + remotes.length;
    historyCount.textContent = srv
      ? total + ' 张 · ' + (srv.label || srv.host)
      : total + ' 张';

    // 组装期望卡片：本地在前、远端独有在后；空列表用占位节点参与对账
    var entries = [];
    locals.forEach(function (f) {
      entries.push({
        key: 'L:' + f.name,
        sig: localCardSig(f, srv),
        build: function (isNew) { return makeCard(f, srv, isNew); },
      });
    });
    remotes.forEach(function (f) {
      entries.push({
        key: 'R:' + f.name,
        sig: remoteCardSig(f, srv),
        build: function (isNew) { return makeRemoteCard(f, srv, isNew); },
      });
    });
    if (!total) {
      var emptyText = srv
        ? '该目标下还没有图片：选择图片上传即会推送到 ' + (srv.label || srv.host)
        : '还没有图片：粘贴截图 / 拖拽 / 选择文件上传';
      entries.push({
        key: '@empty',
        sig: 'empty:' + emptyText,
        build: function () {
          var p = document.createElement('p');
          p.className = 'empty';
          p.textContent = emptyText;
          return p;
        },
      });
    }
    reconcileCards(grid, 'grid', entries);
    // 探测在途状态不参与签名（否则每次探测起止都重建卡片）：就地刷新删除按钮置灰
    var busy = !!(srv && probeBusy[targetKey(srv)]);
    (prevCards.grid || []).forEach(function (c) {
      if (c.el && c.el._delBtn) c.el._delBtn.disabled = busy;
    });
  }

  // 同步抽屉联动：按钮始终可用（目标可为本机或服务器）；抽屉开着时按当前目标重绘
  function refreshSyncArea() {
    syncLibBtn.disabled = syncBusy;
    if (syncDrawer.classList.contains('open')) renderSyncList();
  }

  function makeCard(f, srv, isNew) {
    var rec = history[f.name];

    var card = document.createElement('div');
    card.className = isNew ? 'card card-enter' : 'card';

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

    // 展示名随当前目标：本机用本地原名；服务器用该目标上的远端名
    var orig = document.createElement('div');
    orig.className = 'orig';
    orig.textContent = nameOnTarget(f.name, srv);
    body.appendChild(orig);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatSize(f.size) + ' · ' + formatTime(f.mtime);
    body.appendChild(meta);

    // 推送记录：本机视图显示全部记录；选中服务器时只显示该服务器的记录
    var records = (rec && Array.isArray(rec.targets))
      ? rec.targets.filter(function (x) { return !srv || (x.host === srv.host && x.dir === srv.dir); })
      : [];
    var list = document.createElement('div');
    list.className = 'targets';
    if (!records.length) {
      var none = document.createElement('div');
      none.className = 'target-none';
      none.textContent = srv ? '尚未推送到该服务器' : '无推送记录（仅本机预览）';
      list.appendChild(none);
    } else {
      records.forEach(function (x) { list.appendChild(makeTargetRow(x, f.name)); });
    }
    body.appendChild(list);

    var ops = document.createElement('div');
    ops.className = 'card-ops';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '删除';
    del.disabled = !!(srv && probeBusy[targetKey(srv)]); // 探测在途时置灰，避免用旧快照删除
    del.addEventListener('click', function () { removeFile(f.name, srv, card, grid, 'grid'); });
    card._delBtn = del; // 复用卡片时就地刷新置灰状态
    ops.appendChild(del);
    body.appendChild(ops);

    card.appendChild(body);
    return card;
  }

  // 远端独有卡片（本地无副本）：缩略图按需从目标读取；操作只有复制远端路径与删除远端文件
  function makeRemoteCard(item, srv, isNew) {
    var remotePath = srv.dir + '/' + item.name;

    var card = document.createElement('div');
    card.className = isNew ? 'card card-enter' : 'card';

    var link = document.createElement('a');
    link.className = 'thumb';
    link.href = itemThumbUrl(item, srv);
    link.target = '_blank';
    link.rel = 'noopener';
    var img = document.createElement('img');
    img.src = link.href;
    img.alt = item.name;
    img.loading = 'lazy';
    link.appendChild(img);
    card.appendChild(link);

    var body = document.createElement('div');
    body.className = 'card-body';

    var orig = document.createElement('div');
    orig.className = 'orig';
    orig.textContent = origFromName(item.name);
    body.appendChild(orig);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '远端文件（本地无副本）';
    body.appendChild(meta);

    // 目标行：与历史卡的目标行同构，展示该目标上的远端路径与复制按钮
    var list = document.createElement('div');
    list.className = 'targets';
    var row = document.createElement('div');
    row.className = 'target';
    var head = document.createElement('div');
    head.className = 'target-head';
    // 「远端独有」徽标置于目标行、服务器名之前
    head.appendChild(makeStateBadge('remote-only', '远端独有'));
    var label = document.createElement('span');
    label.className = 'target-label';
    label.textContent = srv.label || srv.host;
    head.appendChild(label);
    row.appendChild(head);
    var pathLine = document.createElement('div');
    pathLine.className = 'target-line';
    var code = document.createElement('code');
    code.textContent = remotePath;
    pathLine.appendChild(code);
    pathLine.appendChild(makeCopyButton(function () { return remotePath; }));
    row.appendChild(pathLine);
    list.appendChild(row);
    body.appendChild(list);

    var ops = document.createElement('div');
    ops.className = 'card-ops';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '删除';
    del.disabled = !!probeBusy[targetKey(srv)]; // 探测在途时置灰，避免用旧快照删除
    del.addEventListener('click', function () { removeRemoteOnly(item, srv, card, grid, 'grid'); });
    card._delBtn = del; // 复用卡片时就地刷新置灰状态
    ops.appendChild(del);
    body.appendChild(ops);

    card.appendChild(body);
    return card;
  }

  // 卡片状态徽标（远端独有 / 远端已删）
  function makeStateBadge(kind, text) {
    var b = document.createElement('span');
    b.className = 'badge badge-' + kind;
    b.textContent = text;
    return b;
  }

  // 单条推送记录：状态徽标（远端已删）+ 目标名 + 时间，路径 / URL 各带复制按钮
  function makeTargetRow(t, localName) {
    var row = document.createElement('div');
    row.className = 'target';

    var head = document.createElement('div');
    head.className = 'target-head';
    // 图库卡片只展示状态：记录在、远端文件已被删时标「远端已删」
    if (t.stale) head.appendChild(makeStateBadge('stale', '远端已删'));
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

    // 远端名与本地名不同时显式标注，让“同内容不同名”可见
    if (localName && t.remoteName && t.remoteName !== localName) {
      var note = document.createElement('div');
      note.className = 'target-none';
      note.textContent = '远端名 ' + origFromName(t.remoteName);
      row.appendChild(note);
    }

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

  // =============== 确认弹窗与删除 ===============

  // 通用确认弹窗：返回 Promise<{confirmed, checked}>。
  // window.confirm 放不下复选项（本机删除的级联选项），故自绘一个轻量模态。
  function showConfirm(opts) {
    return new Promise(function (resolve) {
      confirmTitle.textContent = opts.title || '确认';
      confirmMsg.textContent = opts.message || '';
      if (opts.checkboxLabel) {
        confirmCheckWrap.hidden = false;
        confirmCheckLabel.textContent = opts.checkboxLabel;
        confirmCheck.checked = false;
      } else {
        confirmCheckWrap.hidden = true;
      }
      confirmOk.textContent = opts.okText || '删除';
      confirmMask.hidden = false;
      confirmOk.focus();

      function cleanup() {
        confirmMask.hidden = true;
        confirmOk.removeEventListener('click', onOk);
        confirmCancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        confirmMask.removeEventListener('click', onMask);
      }
      function onOk() { cleanup(); resolve({ confirmed: true, checked: confirmCheck.checked }); }
      function onCancel() { cleanup(); resolve({ confirmed: false, checked: false }); }
      function onKey(e) {
        if (e.key === 'Escape') onCancel();
        else if (e.key === 'Enter') onOk();
      }
      function onMask(e) { if (e.target === confirmMask) onCancel(); }

      confirmOk.addEventListener('click', onOk);
      confirmCancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      confirmMask.addEventListener('click', onMask);
    });
  }

  // 删除远端目标上的单个文件（DELETE /api/remote-file）
  async function remoteDelete(srv, remoteName) {
    var p = new URLSearchParams();
    p.set('host', srv.host);
    p.set('user', srv.user || 'root');
    p.set('dir', srv.dir);
    p.set('name', remoteName);
    var res;
    try {
      res = await fetch('/api/remote-file?' + p.toString(), { method: 'DELETE' });
    } catch (e) {
      throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
  }

  // 删除本机文件（DELETE /files/<name>）
  async function deleteLocal(name) {
    var res;
    try {
      res = await fetch('/files/' + encodeURIComponent(name), { method: 'DELETE' });
    } catch (e) {
      throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
  }

  // 从本地 history 移除某目标记录；本地条目保留（仍可作本机预览）
  function dropTargetRecord(name, srv) {
    var rec = history[name];
    if (!rec || !Array.isArray(rec.targets)) return;
    rec.targets = rec.targets.filter(function (t) {
      return !(t.host === srv.host && t.dir === srv.dir);
    });
    saveJson(HISTORY_KEY, history);
  }

  // 从 remoteIndex 缓存移除某文件名（删远端后保持缓存一致）
  function dropRemoteIndexFile(srv, remoteName) {
    var idx = remoteIndex[targetKey(srv)];
    if (idx && Array.isArray(idx.files)) {
      idx.files = idx.files.filter(function (f) { return f.name !== remoteName; });
      saveJson(REMOTE_INDEX_KEY, remoteIndex);
    }
    // 同步内存探测快照：refreshHistory 会用它再做一轮对账，
    // 若不同步，过期的快照仍含该文件，会把刚删除的记录当「恢复」补录回来。
    var ps = probeState[targetKey(srv)];
    if (ps && ps.data && Array.isArray(ps.data.files)) {
      ps.data.files = ps.data.files.filter(function (f) { return f.name !== remoteName; });
    }
  }

  // 按 host+dir 找服务器配置（历史记录里的目标可能已从配置中删除，故允许为空）
  function serverByHostDir(host, dir) {
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].host === host && servers[i].dir === dir) return servers[i];
    }
    return null;
  }

  // 收集“该本地文件在各服务器上的副本”（本机级联删除用）：
  // 来源 = history 各 target 记录 + remoteIndex 中同 md5 的清单，按 host+dir 去重。
  function serverCopies(name) {
    var md5 = md5Of(name);
    var copies = [];
    var seen = {};
    function add(host, dir, remoteName) {
      if (!host || !dir || !remoteName) return;
      var k = host + '|' + dir;
      if (seen[k]) return;
      seen[k] = true;
      var srv = serverByHostDir(host, dir);
      copies.push({
        host: host,
        dir: dir,
        user: (srv && srv.user) || 'root',
        remoteName: remoteName,
        label: (srv && (srv.label || srv.host)) || host,
      });
    }
    var rec = history[name];
    if (rec && Array.isArray(rec.targets)) {
      rec.targets.forEach(function (t) { add(t.host, t.dir, t.remoteName || baseName(t.remotePath)); });
    }
    if (md5) {
      Object.keys(remoteIndex).forEach(function (k) {
        var idx = remoteIndex[k];
        if (!idx || !Array.isArray(idx.files)) return;
        idx.files.forEach(function (f) {
          if (f.md5 !== md5) return;
          var parts = k.split('|');
          add(parts[0], parts[1], f.name);
        });
      });
    }
    return copies;
  }

  // 删除出场动效（Vue 列表过渡的 leave-active + move 思路）：
  // 离开卡片加 .card-leave 并脱离文档流（position:absolute 钉在原位），兄弟卡片立即让位，
  // 同时并行 FLIP 平滑补位；动画播完由后续 refreshHistory 的对账移除（_leaving 期间并发对账跳过）。
  // 仅在网络删除成功后调用，确保不会出现「卡片已消失但实际没删掉」。
  // 垫片 / 无测量能力 / 减少动态效果时退化为「只加 card-leave 并等待」。
  var LEAVE_MS = 320; // 与 CSS .card-leave 动画时长（旋转滑出 + 缩小淡出）保持一致
  function leaveCardWithReflow(el, container, scope) {
    return new Promise(function (resolve) {
      if (el) el._leaving = true; // 标记出场中：并发对账不得移除该元素，避免打断动画
      var hasClass = el && typeof el.className === 'string';
      var canReflow = hasClass && !reduceMotion() &&
        typeof el.getBoundingClientRect === 'function' &&
        container && typeof container.getBoundingClientRect === 'function';
      var siblings = [];
      var first = null, rect = null, box = null;
      if (canReflow) {
        // 先量兄弟卡片与离开卡片的「变更前」位置，再改动布局
        siblings = (prevCards[scope] || []).filter(function (c) { return c.el !== el; });
        first = measureCards(siblings);
        rect = el.getBoundingClientRect();
        box = container.getBoundingClientRect();
      }
      if (hasClass) {
        el.className = el.className.replace(' card-enter', '') + ' card-leave'; // 出场动画覆盖入场
        if (el.style) el.style.animationDelay = ''; // 清掉入场交错延迟，出场立即开始
      }
      if (canReflow) {
        // 钉在原位并脱离文档流：兄弟卡片立即让位，再 FLIP 平滑补位
        el.style.width = rect.width + 'px';
        el.style.height = rect.height + 'px';
        el.style.left = (rect.left - box.left + (container.scrollLeft || 0)) + 'px';
        el.style.top = (rect.top - box.top + (container.scrollTop || 0)) + 'px';
        el.style.position = 'absolute';
        el.style.zIndex = '2';
        playFlip(siblings, first, Math.max(0, LEAVE_MS - 20));
      }
      setTimeout(function () {
        if (el) el._leaving = false; // 动画结束：交回对账流程移除
        resolve();
      }, reduceMotion() ? 0 : LEAVE_MS);
    });
  }

  // 删除入口：按当前目标作用域分派（cardEl 为卡片 DOM，container/scope 用于出场重排）
  async function removeFile(name, srv, cardEl, container, scope) {
    if (srv) return removeFromServer(name, srv, cardEl, container, scope);
    return removeFromLocal(name, cardEl, container, scope);
  }

  // 服务器作用域删除：只删该目标的远端文件与记录，本地文件与其他目标记录保留
  async function removeFromServer(name, srv, cardEl, container, scope) {
    // 探测在途时禁止删除：在途探测返回的是删除前的旧快照，会把记录补录回来
    if (probeBusy[targetKey(srv)]) { hint('正在探测该目标，请稍后再删除', true); return; }
    var t = findTargetRec(name, srv);
    var remoteName = (t && (t.remoteName || baseName(t.remotePath))) || name;
    var r = await showConfirm({
      title: '删除远端文件',
      message: '确定从「' + (srv.label || srv.host) + '」删除「' + nameOnTarget(name, srv) +
        '」吗？将同时删除该服务器上的文件与该目标的推送记录。',
    });
    if (!r.confirmed) return;
    try {
      await remoteDelete(srv, remoteName);
    } catch (err) {
      window.alert('删除失败：' + (err.message || err));
      return;
    }
    dropTargetRecord(name, srv);
    dropRemoteIndexFile(srv, remoteName);
    await leaveCardWithReflow(cardEl, container, scope); // 删除成功后出场 + 兄弟并行补位
    hint('已从 ' + (srv.label || srv.host) + ' 删除');
    refreshHistory();
  }

  // 本机作用域删除：删本地文件；可选级联删除所有服务器副本（远端先行、全成才删本地）
  async function removeFromLocal(name, cardEl, container, scope) {
    var copies = serverCopies(name);
    var opts = { title: '删除本地文件', message: '确定删除本地文件「' + origOf(name) + '」吗？' };
    if (copies.length) opts.checkboxLabel = '同时删除所有服务器上的副本（' + copies.length + ' 台）';
    var r = await showConfirm(opts);
    if (!r.confirmed) return;

    if (r.checked && copies.length) {
      var failed = [];
      for (var i = 0; i < copies.length; i++) {
        try {
          await remoteDelete(copies[i], copies[i].remoteName);
        } catch (e) {
          failed.push(copies[i].label + '（' + (e.message || e) + '）');
        }
      }
      if (failed.length) {
        // 有远端未删成：中止本机删除，保留本地文件便于重试
        // 注意：页面 JS 位于外层模板字符串内，禁用反斜杠转义，换行用 String.fromCharCode(10)
        var nl = String.fromCharCode(10);
        window.alert('以下服务器删除失败，已中止本机删除：' + nl + failed.join(nl));
        return;
      }
      copies.forEach(function (c) { dropRemoteIndexFile(c, c.remoteName); });
    }

    try {
      await deleteLocal(name);
    } catch (err) {
      window.alert('删除失败：' + (err.message || err));
      return;
    }
    delete history[name];
    saveJson(HISTORY_KEY, history);
    await leaveCardWithReflow(cardEl, container, scope); // 删除成功后出场 + 兄弟并行补位
    hint('已删除');
    refreshHistory();
  }

  // =============== 从图库补齐抽屉 ===============
  // 把「本地图库有、但还没推到当前目标」的图补推过去（POST /sync，免重传字节）。
  // 抽屉参与布局不遮挡左侧；仅点 × 关闭（不点空白关闭，避免误触）。

  // 取展示用原名：优先历史记录；否则从存储名 <md5>-原名 第 34 位起截取
  function origOf(name) {
    var entry = history[name];
    if (entry && entry.orig) return entry.orig;
    return name.length > 33 ? name.slice(33) : name;
  }

  // 组装 /sync 的 query
  function syncQuery(srv, name) {
    var p = new URLSearchParams();
    p.set('name', name);
    p.set('host', srv.host);
    p.set('user', srv.user || 'root');
    p.set('dir', srv.dir);
    if (srv.urlBase) p.set('urlBase', srv.urlBase);
    return p;
  }

  // 单文件补齐核心：POST /sync，成功写历史并返回 data；失败抛中文错误
  async function doSyncOne(name, srv) {
    var res;
    try {
      res = await fetch('/sync?' + syncQuery(srv, name).toString(), { method: 'POST' });
    } catch (e) {
      throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
    }
    var data = null;
    var jsonOk = true;
    try { data = await res.json(); } catch (e) { jsonOk = false; }
    if (!res.ok || !jsonOk || !data.ok) {
      throw new Error((data && data.error) || ('HTTP ' + res.status + (jsonOk ? '' : '（响应非 JSON）')));
    }
    recordUpload(data, origOf(name), srv);
    return data;
  }

  // 当前勾选数量
  function selectedSyncCount() {
    var n = 0;
    for (var k in syncSelected) { if (syncSelected[k]) n++; }
    return n;
  }

  function updateSyncSelBtn() {
    var n = selectedSyncCount();
    syncSelBtn.disabled = n === 0 || syncBusy;
    syncSelBtn.textContent = '同步选中(' + n + ')';
  }

  // 抽屉来源选项：目标为服务器时 = 本地 + 其他服务器；目标为本机时 = 各服务器
  function sourceOptions() {
    var target = currentServer();
    var list = [];
    if (target) list.push({ value: 'local', label: '本地图库' });
    servers.forEach(function (s) {
      if (target && s.id === target.id) return; // 来源不能等于目标
      list.push({ value: s.id, label: s.label || s.host });
    });
    return list;
  }

  // 重绘来源下拉，尽量保持原选择
  function renderSourceSel() {
    var opts = sourceOptions();
    var prev = syncSourceSel.value;
    syncSourceSel.textContent = '';
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      syncSourceSel.appendChild(el);
    });
    var keep = opts.some(function (o) { return o.value === prev; }) ? prev : (opts[0] && opts[0].value) || '';
    syncSourceSel.value = keep;
  }

  // 来源清单：本地来源取图库；服务器来源取 remoteIndex 缓存（未探测返回 null）
  function sourceFiles() {
    if (syncSourceSel.value === 'local') {
      return libFiles.map(function (f) {
        return { name: f.name, md5: md5Of(f.name), size: f.size, mtime: f.mtime, local: true };
      });
    }
    var srv = serverById(syncSourceSel.value);
    if (!srv) return [];
    var idx = remoteIndex[targetKey(srv)];
    if (!idx || !Array.isArray(idx.files)) return null; // 未探测
    return idx.files.map(function (f) { return { name: f.name, md5: f.md5, local: false }; });
  }

  // 目标是否已有该 md5：本机看本地图库；服务器看 history 记录 ∪ remoteIndex 清单
  // （同步/上传成功只写 history，若只看 remoteIndex 会导致抽屉条目不消失）
  function targetHasMd5(srv, md5) {
    if (!md5) return false;
    if (!srv) return !!localNameByMd5(md5);
    if (Object.keys(history).some(function (k) {
      return md5Of(k) === md5 && findTargetRec(k, srv);
    })) return true;
    var idx = remoteIndex[targetKey(srv)];
    if (idx && Array.isArray(idx.files)) return idx.files.some(function (f) { return f.md5 === md5; });
    return false;
  }

  // 抽屉待同步项 = 来源清单里「目标还没有」的条目（同 md5 只保留一条）
  function missingItems() {
    var target = currentServer();
    var files = sourceFiles();
    if (files === null) return null; // 来源服务器尚未探测
    var seen = {};
    var out = [];
    files.forEach(function (f) {
      if (targetHasMd5(target, f.md5)) return;
      if (f.md5) {
        if (seen[f.md5]) return; // 同内容多副本：只展示一条
        seen[f.md5] = true;
      }
      out.push(f);
    });
    return out;
  }

  // 抽屉条目缩略图：本地有字节走 /files/；否则按需从来源服务器读取（懒加载 + 服务端缓存）
  function itemThumbUrl(item, srcSrv) {
    var localName = item.md5 ? localNameByMd5(item.md5) : null;
    if (localName) return '/files/' + encodeURIComponent(localName);
    if (srcSrv) {
      var p = new URLSearchParams();
      p.set('host', srcSrv.host);
      p.set('user', srcSrv.user || 'root');
      p.set('dir', srcSrv.dir);
      p.set('name', item.name);
      return '/api/remote-file?' + p.toString();
    }
    return '/files/' + encodeURIComponent(item.name);
  }

  // 从来源服务器拉回单个文件到本地图库（POST /pull），返回 {localName, remoteName}
  async function pullOne(name, srcSrv) {
    var p = new URLSearchParams();
    p.set('name', name);
    p.set('host', srcSrv.host);
    p.set('user', srcSrv.user || 'root');
    p.set('dir', srcSrv.dir);
    var res;
    try {
      res = await fetch('/pull?' + p.toString(), { method: 'POST' });
    } catch (e) {
      throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
    return data;
  }

  // 同步单个抽屉条目：
  //   目标本机   → 从来源拉回本地即完成；
  //   目标服务器 → 先确保本地有字节（必要时拉回），再推送到目标（统一用本地名）。
  async function syncDrawerItem(item, srcSrv, target) {
    var localName = item.md5 ? localNameByMd5(item.md5) : null;
    if (!localName && srcSrv) {
      var pulled = await pullOne(item.name, srcSrv);
      localName = pulled.localName;
    }
    if (!localName) localName = item.name; // 本地来源：item.name 即本地名
    if (!target) return; // 目标就是本机：拉回即完成
    await doSyncOne(localName, target);
  }

  // 单行同步（行内按钮）
  async function syncItemRow(item, srcSrv, target, btn, errEl) {
    if (syncBusy) return;
    btn.disabled = true;
    btn.textContent = '同步中…';
    if (errEl) errEl.textContent = '';
    try {
      await syncDrawerItem(item, srcSrv, target);
      delete syncSelected[item.name];
      refreshHistory();
      hint(target ? ('已同步到 ' + (target.label || target.host)) : '已拉回本地');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '同步';
      var msgText = e.message || String(e);
      if (errEl) errEl.textContent = msgText;
      hint(msgText, true);
    }
  }

  // 删除「远端独有（本地无副本）」条目：只删远端文件与 remoteIndex 条目
  async function removeRemoteOnly(item, srcSrv, cardEl, container, scope) {
    // 探测在途时禁止删除：在途探测返回的是删除前的旧快照，会把记录补录回来
    if (probeBusy[targetKey(srcSrv)]) { hint('正在探测该来源，请稍后再删除', true); return; }
    var r = await showConfirm({
      title: '删除远端文件',
      message: '确定从「' + (srcSrv.label || srcSrv.host) + '」删除「' + origFromName(item.name) + '」吗？将删除该服务器上的文件。',
    });
    if (!r.confirmed) return;
    try {
      await remoteDelete(srcSrv, item.name);
    } catch (err) {
      window.alert('删除失败：' + (err.message || err));
      return;
    }
    dropRemoteIndexFile(srcSrv, item.name);
    await leaveCardWithReflow(cardEl, container, scope); // 删除成功后出场 + 兄弟并行补位
    hint('已删除');
    refreshHistory(); // 同时刷新图库网格与（若开着的）同步抽屉
  }

  // 构建抽屉条目卡片：缩略图（本地或远端按需）+ 来源名 + 操作行（勾选 / 同步）
  function buildSyncCard(item, srcSrv, target, isNew) {
    var card = document.createElement('div');
    card.className = isNew ? 'card sync-card card-enter' : 'card sync-card';

    var href = itemThumbUrl(item, srcSrv);

    // 大缩略图：点击新窗口打开原图（同历史卡片）
    var link = document.createElement('a');
    link.className = 'thumb';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    var img = document.createElement('img');
    img.src = href;
    img.alt = item.name;
    img.loading = 'lazy';
    link.appendChild(img);
    card.appendChild(link);

    var body = document.createElement('div');
    body.className = 'card-body';

    // 名称随来源：抽屉里展示来源上的原名
    var origEl = document.createElement('div');
    origEl.className = 'orig';
    origEl.textContent = origFromName(item.name);
    body.appendChild(origEl);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = item.local
      ? (formatSize(item.size) + ' · ' + formatTime(item.mtime))
      : '远端文件（本地无副本）';
    body.appendChild(meta);

    // 状态行：说明这次同步会把条目送到哪里
    var list = document.createElement('div');
    list.className = 'targets';
    var none = document.createElement('div');
    none.className = 'target-none';
    none.textContent = target ? ('尚未同步到 ' + (target.label || target.host)) : '尚未拉回本地';
    list.appendChild(none);
    body.appendChild(list);

    // 操作行：左侧勾选 + 右侧同步
    var ops = document.createElement('div');
    ops.className = 'card-ops';

    var lab = document.createElement('label');
    lab.className = 'sync-check';
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!syncSelected[item.name];
    check.disabled = syncBusy;
    check.addEventListener('change', function () {
      if (syncBusy) { check.checked = !check.checked; return; }
      if (check.checked) syncSelected[item.name] = true;
      else delete syncSelected[item.name];
      updateSyncSelBtn();
    });
    card._check = check; // 复用卡片时就地刷新勾选可用性
    lab.appendChild(check);
    lab.appendChild(document.createTextNode('选择'));
    ops.appendChild(lab);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '同步';
    var errEl = document.createElement('span');
    errEl.className = 'sync-err';
    btn.addEventListener('click', function () { syncItemRow(item, srcSrv, target, btn, errEl); });
    ops.appendChild(btn);

    body.appendChild(ops);

    body.appendChild(errEl);
    card.appendChild(body);
    return card;
  }

  // 重绘抽屉列表：来源清单里「目标还没有」的条目
  function renderSyncList() {
    renderSourceSel();
    var target = currentServer();
    var srcSrv = syncSourceSel.value === 'local' ? null : serverById(syncSourceSel.value);
    var srcLabel = srcSrv ? (srcSrv.label || srcSrv.host) : '本地图库';
    var tgtLabel = target ? (target.label || target.host) : '本机';
    syncTitle.textContent = srcLabel + ' → ' + tgtLabel;
    var missing = missingItems();
    var entries = [];

    if (missing === null) {
      // 来源服务器还没探测：给一个手动探测入口
      entries.push({
        key: '@sync-probe',
        sig: 'probe:' + srcLabel,
        build: function () {
          var tip = document.createElement('p');
          tip.className = 'sync-empty';
          tip.textContent = '尚未获取「' + srcLabel + '」的清单';
          var probeBtn = document.createElement('button');
          probeBtn.type = 'button';
          probeBtn.textContent = '探测';
          probeBtn.addEventListener('click', function () { probeTarget(srcSrv, true); });
          tip.appendChild(document.createElement('br'));
          tip.appendChild(probeBtn);
          return tip;
        },
      });
      syncSelAll.textContent = '全选';
      syncSelAll.disabled = true;
      reconcileCards(syncList, 'sync', entries);
      updateSyncSelBtn();
      return;
    }
    if (!missing.length) {
      entries.push({
        key: '@sync-empty',
        sig: 'empty:' + srcLabel + '|' + tgtLabel,
        build: function () {
          var p = document.createElement('p');
          p.className = 'sync-empty';
          p.textContent = srcLabel + ' 中所有图片都已同步到 ' + tgtLabel;
          return p;
        },
      });
      syncSelAll.textContent = '全选';
      syncSelAll.disabled = true;
      reconcileCards(syncList, 'sync', entries);
      updateSyncSelBtn();
      return;
    }
    // 待同步条目：来源 + 文件名作为键，仅新出现的条目播入场动效
    missing.forEach(function (item) {
      entries.push({
        key: syncSourceSel.value + '|' + item.name,
        sig: syncCardSig(item, srcSrv, target),
        build: function (isNew) { return buildSyncCard(item, srcSrv, target, isNew); },
      });
    });
    reconcileCards(syncList, 'sync', entries);
    // 探测在途状态不参与签名：就地刷新勾选可用性
    (prevCards.sync || []).forEach(function (c) {
      if (!c.el) return;
      if (c.el._check) c.el._check.disabled = syncBusy;
    });
    // 全选按钮文案：全部已勾选 → 显示“取消全选”
    var allChecked = missing.every(function (f) { return syncSelected[f.name]; });
    syncSelAll.textContent = allChecked ? '取消全选' : '全选';
    syncSelAll.disabled = syncBusy;
    updateSyncSelBtn();
  }

  // 打开抽屉：加 .open 触发右滑入动画；来源服务器未探测时自动探一次
  function openDrawer() {
    if (!sourceOptions().length) {
      hint('还没有可选的来源：请先在「⚙ 管理」里添加服务器', true);
      return;
    }
    syncSelected = {};
    syncDrawer.classList.add('open');
    renderSyncList();
    var srcSrv = syncSourceSel.value === 'local' ? null : serverById(syncSourceSel.value);
    if (srcSrv && !remoteIndex[targetKey(srcSrv)]) probeTarget(srcSrv, false);
  }

  function closeDrawer() {
    syncDrawer.classList.remove('open');
    syncSelected = {};
  }

  // 全选/取消全选：作用域是「当前缺项集」
  syncSelAll.addEventListener('click', function () {
    if (syncBusy) return;
    var missing = missingItems();
    if (!missing || !missing.length) return;
    var allChecked = missing.every(function (f) { return syncSelected[f.name]; });
    missing.forEach(function (f) {
      if (allChecked) delete syncSelected[f.name];
      else syncSelected[f.name] = true;
    });
    renderSyncList();
  });

  // 批量同步选中：串行逐条，期间锁定控件
  syncSelBtn.addEventListener('click', async function () {
    if (syncBusy) return;
    var target = currentServer();
    var srcSrv = syncSourceSel.value === 'local' ? null : serverById(syncSourceSel.value);
    var missing = missingItems();
    if (!missing) return;
    var pending = missing.filter(function (f) { return syncSelected[f.name]; });
    if (!pending.length) return;
    syncBusy = true;
    syncLibBtn.disabled = true;
    syncSelAll.disabled = true;
    syncList.style.pointerEvents = 'none'; // 锁定行内交互，防交叉
    syncSelBtn.textContent = '同步中…';
    var ok = 0, fail = 0;
    for (var i = 0; i < pending.length; i++) {
      syncSelBtn.textContent = '同步中 ' + (i + 1) + '/' + pending.length;
      try {
        await syncDrawerItem(pending[i], srcSrv, target);
        delete syncSelected[pending[i].name];
        ok++;
      } catch (e) {
        fail++;
      }
    }
    syncBusy = false;
    syncList.style.pointerEvents = '';
    syncSelAll.disabled = false;
    syncLibBtn.disabled = false;
    refreshHistory(); // pull 可能新增本地文件，重新拉图库
    if (fail) hint('同步完成：成功 ' + ok + ' 张，失败 ' + fail + ' 张', true);
    else hint('已同步 ' + ok + ' 张到 ' + (target ? (target.label || target.host) : '本机'));
  });

  // 清理当前目标下所有「远端已删」的记录（只清本地记录，不动远端与本地文件）
  async function cleanStale() {
    var srv = currentServer();
    if (!srv) return;
    var staleNames = [];
    Object.keys(history).forEach(function (k) {
      var t = findTargetRec(k, srv);
      if (t && t.stale) staleNames.push(k);
    });
    if (!staleNames.length) return;
    var r = await showConfirm({
      title: '清理失效记录',
      message: '确定清理「' + (srv.label || srv.host) + '」下 ' + staleNames.length +
        ' 条远端已删的记录吗？（只清本地记录，不影响远端与本地文件）',
      okText: '清理',
    });
    if (!r.confirmed) return;
    staleNames.forEach(function (k) { dropTargetRecord(k, srv); });
    hint('已清理 ' + staleNames.length + ' 条失效记录');
    refreshHistory();
  }

  syncLibBtn.addEventListener('click', openDrawer);
  syncClose.addEventListener('click', closeDrawer);
  syncSourceSel.addEventListener('change', function () {
    var srcSrv = syncSourceSel.value === 'local' ? null : serverById(syncSourceSel.value);
    renderSyncList();
    if (srcSrv && !remoteIndex[targetKey(srcSrv)]) probeTarget(srcSrv, false);
  });
  cleanStaleBtn.addEventListener('click', cleanStale);
  recheckBtn.addEventListener('click', function () {
    var srv = currentServer();
    if (!srv) { hint('当前是本机目标，无需对账', true); return; }
    probeTarget(srv, true);
  });

  // =============== 初始化 ===============
  // 用户切换目标：记住选择、按该目标过滤历史；切到服务器目标时异步探测+对账
  targetSel.addEventListener('change', function () {
    saveJson(TARGET_KEY, targetSel.value);
    renderGrid();
    var srv = currentServer();
    if (srv) probeTarget(srv, false);
  });
  renderTargetSel();
  refreshHistory();
  // 页面加载：对上次记住的服务器目标探测一次
  var initSrv = currentServer();
  if (initSrv) probeTarget(initSrv, false);
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

/**
 * 读取并解析 JSON 请求体（上限 MAX_JSON_BODY）。
 * 非法 JSON / 非对象返回 null，由调用方按 400 处理；超限抛 413。
 */
async function readJsonBody(req) {
  const buf = await readBodyWithLimit(req, MAX_JSON_BODY);
  try {
    const value = JSON.parse(buf.toString('utf8'));
    return (value !== null && typeof value === 'object') ? value : null;
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

/**
 * 解析并校验「远端目标」参数（host/user/dir/urlBase）。
 * 返回 { ok:true, target:{host,user,dir}, urlBase }；
 * 参数非法时返回 { ok:false, status, error }，由调用方直接回 4xx。
 */
function parseTargetParams(params) {
  const hostRaw = params.get('host') || '';
  const host = validateHost(hostRaw);
  if (!host) {
    return { ok: false, status: 400, error: 'host 缺失或不合法：仅允许字母、数字、点、下划线、连字符' };
  }
  const user = validateUser(params.get('user') || 'root'); // 远程用户名缺省 root
  if (!user) {
    return { ok: false, status: 400, error: 'user 不合法：仅允许字母、数字、点、下划线、连字符' };
  }
  const dirRaw = params.get('dir') || '';
  if (!dirRaw) {
    return { ok: false, status: 400, error: 'dir（远端目录）必填' };
  }
  const dir = validateDir(dirRaw);
  if (!dir) {
    return { ok: false, status: 400, error: 'dir 不合法：必须以 / 开头，且仅允许字母、数字、点、下划线、连字符、斜杠' };
  }
  return { ok: true, target: { host, user, dir }, urlBase: params.get('urlBase') || '' };
}

/**
 * POST /sync?name=<localName>&host=&user=&dir=&urlBase=
 * 把本地图库中已存在的文件直接同步到远端目标（免浏览器重传字节）。
 * 供页面「从图库补齐」抽屉使用——把「本地有、当前目标没有」的图补推过去；
 * 本机目标没有意义（host 必填），妙传/rsync/scp 逻辑与 /upload 一致。
 */
async function handleSync(req, res, params, ctx) {
  req.resume(); // /sync 无请求体
  const name = params.get('name') || '';
  if (!isValidStoredName(name)) {
    return sendJson(res, 400, { ok: false, error: 'name 缺失或不合法（须为图库文件名 <md5>-原名）' });
  }
  const pt = parseTargetParams(params);
  if (!pt.ok) {
    return sendJson(res, pt.status, { ok: false, error: pt.error });
  }
  const localPath = path.join(ctx.snapDir, name);
  let isFile = false;
  try {
    isFile = (await fs.promises.stat(localPath)).isFile();
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: '本机图库中不存在该文件' });
    throw err;
  }
  if (!isFile) return sendJson(res, 404, { ok: false, error: '本机图库中不存在该文件' });
  // 串行执行远端同步，避免并发 rsync 交叉
  const result = await ctx.enqueue(async () => {
    const { method } = await syncToRemote(localPath, name, pt.target);
    return { method };
  });
  return sendJson(res, 200, {
    ok: true,
    localName: name,
    remotePath: `${pt.target.dir}/${name}`,
    url: pt.urlBase ? `${pt.urlBase}/${name}` : undefined,
    method: result.method,
  });
}

/**
 * GET /api/remote?host=&user=&dir=
 * 探测目标可达性、目录存在性与 rsync 能力，并列出目录内文件名（对账用）。
 * 约定：ssh 失败返回 ok:false，前端忽略本次合并；目录不存在返回 ok:true 且清单为空。
 */
async function handleRemoteList(res, params) {
  const pt = parseTargetParams(params);
  if (!pt.ok) return sendJson(res, pt.status, { ok: false, error: pt.error });
  const { host, user, dir } = pt.target;

  let r;
  try {
    r = await run('ssh', [...SSH_ARGS, `${user}@${host}`, buildRemoteListScript(dir)], PROBE_TIMEOUT_MS);
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: err.message || '探测失败' });
  }
  if (r.code !== 0) {
    return sendJson(res, 200, {
      ok: false,
      error: `ssh 探测失败（退出码 ${r.code}）：${summarizeStderr(r.stderr)}`,
    });
  }
  const parsed = parseRemoteList(r.stdout);
  return sendJson(res, 200, {
    ok: true,
    dirExists: parsed.dirExists,
    hasRsync: parsed.hasRsync,
    files: parsed.files,
  });
}

/** 以流式回放本地文件（缩略图/预览用），Content-Type 按扩展名推断 */
function sendFile(res, filePath, name) {
  res.writeHead(200, { 'Content-Type': mimeOf(name) });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy()); // 读流出错：直接断开，避免挂起
  stream.pipe(res);
}

/** 在本地图库中查找指定 md5 的已有文件（同内容不同原名皆可），返回文件名或 null */
async function findLocalByMd5(snapDir, md5) {
  const entries = await fs.promises.readdir(snapDir).catch(() => []);
  return entries.find((n) => isValidStoredName(n) && md5OfName(n) === md5) || null;
}

/**
 * 远端缩略图缓存路径：文件名前掺入 host|dir 的短 hash。
 * 不同目标下同名文件（尤其是不带 md5 前缀的手工文件）内容可能不同，
 * 只用文件名做键会互相覆盖、串图，因此把目标身份也纳入键。
 */
function remoteCachePath(snapDir, host, dir, name) {
  const key = crypto.createHash('sha1').update(`${host}|${dir}`).digest('hex').slice(0, 12);
  return path.join(snapDir, '.remote-cache', `${key}-${name}`);
}

/**
 * GET /api/remote-file?host=&user=&dir=&name=
 * 按需从远端读取单个文件字节（缩略图/预览）：
 *   1) 命中本地缓存 .remote-cache/<name> → 直接回放；
 *   2) 未命中 → ssh cat 取回 → 原子写入缓存 → 回给浏览器。
 * 缓存目录以点号开头，readdir 时不会被 isValidStoredName 收录进图库。
 */
async function handleRemoteFile(req, res, params, ctx) {
  req.resume(); // 无请求体
  const name = validateRemoteFileName(params.get('name') || '');
  if (!name) return sendJson(res, 400, { ok: false, error: 'name 缺失或不合法' });
  const pt = parseTargetParams(params);
  if (!pt.ok) return sendJson(res, pt.status, { ok: false, error: pt.error });
  const { host, user, dir } = pt.target;

  const cacheDir = path.join(ctx.snapDir, '.remote-cache');
  const cachePath = remoteCachePath(ctx.snapDir, host, dir, name);
  try {
    const stat = await fs.promises.stat(cachePath);
    if (stat.isFile()) return sendFile(res, cachePath, name); // 缓存命中
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let r;
  try {
    r = await runBuffer('ssh', [...SSH_ARGS, `${user}@${host}`, `cat '${dir}/${name}'`]);
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: err.message || '读取远端文件失败' });
  }
  if (r.code !== 0) {
    return sendJson(res, 404, {
      ok: false,
      error: `读取远端文件失败（退出码 ${r.code}）：${summarizeStderr(r.stderr)}`,
    });
  }

  // 落缓存：临时文件 + rename，避免半成品被后续请求命中；写缓存失败不阻断本次读取
  try {
    await ensureDir(cacheDir);
    const tmp = path.join(cacheDir, `.${name}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.promises.writeFile(tmp, r.stdout);
    await fs.promises.rename(tmp, cachePath);
  } catch (err) {
    console.warn('写入远端缩略图缓存失败（不影响本次读取）：', err.message);
  }
  res.writeHead(200, { 'Content-Type': mimeOf(name), 'Content-Length': r.stdout.length });
  res.end(r.stdout);
}

/**
 * DELETE /api/remote-file?host=&user=&dir=&name=
 * 删除远端目标上的单个文件（幂等：文件本就不存在也返回 ok）。
 * 只删远端文件，不碰本地图库与历史记录——记录清理由前端按目标作用域处理。
 */
async function handleRemoteDelete(req, res, params, ctx) {
  req.resume();
  const name = validateRemoteFileName(params.get('name') || '');
  if (!name) return sendJson(res, 400, { ok: false, error: 'name 缺失或不合法' });
  const pt = parseTargetParams(params);
  if (!pt.ok) return sendJson(res, pt.status, { ok: false, error: pt.error });
  const { host, user, dir } = pt.target;

  let r;
  try {
    r = await run('ssh', [...SSH_ARGS, `${user}@${host}`, `rm -f '${dir}/${name}'`]);
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: err.message || '删除远端文件失败' });
  }
  if (r.code !== 0) {
    return sendJson(res, 502, {
      ok: false,
      error: `删除远端文件失败（退出码 ${r.code}）：${summarizeStderr(r.stderr)}`,
    });
  }
  // 顺带清掉本地缓存，避免删后仍能命中旧图
  await fs.promises.rm(remoteCachePath(ctx.snapDir, host, dir, name), { force: true }).catch(() => {});
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /pull?host=&user=&dir=&name=
 * 把远端文件拉回本地图库（跨服务器同步的中转步骤）：
 *   1) 远端名自带 md5 时先看本地是否已有同内容 → 直接复用，不重复下载；
 *   2) 否则 scp/rsync 取回到临时文件 → 算内容 md5 → 原子改名 <md5>-<原名> 落库。
 * 返回 localName（本地存储名）与 remoteName（远端真实名），供前端写历史。
 */
async function handlePull(req, res, params, ctx) {
  req.resume();
  const name = validateRemoteFileName(params.get('name') || '');
  if (!name) return sendJson(res, 400, { ok: false, error: 'name 缺失或不合法' });
  const pt = parseTargetParams(params);
  if (!pt.ok) return sendJson(res, pt.status, { ok: false, error: pt.error });
  const { host, user, dir } = pt.target;

  await ensureDir(ctx.snapDir);
  const knownMd5 = md5OfName(name);
  if (knownMd5) {
    const existing = await findLocalByMd5(ctx.snapDir, knownMd5);
    if (existing) {
      // 本地已有同内容副本：按“复用”处理，避免重复下载与重复文件
      return sendJson(res, 200, { ok: true, localName: existing, remoteName: name, method: 'reuse' });
    }
  }

  // 临时文件以点号开头、.tmp 结尾，不匹配 isValidStoredName，残留也不会进入图库
  const tmpPath = path.join(
    ctx.snapDir,
    `.pull-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  const result = await ctx.enqueue(async () => {
    try {
      await pullToLocal(tmpPath, name, { host, user, dir });
      // 大小上限与 /api/remote-file 对齐，避免大文件整块读入内存
      const stat = await fs.promises.stat(tmpPath);
      if (stat.size > ctx.maxBody) {
        throw new Error(`远端文件超过大小上限（${formatSize(ctx.maxBody)}）`);
      }
      const bytes = await fs.promises.readFile(tmpPath);
      // 用远端名里的原名重新命名，保证落库名恒为 <md5>-<原名>
      const localName = md5Name(bytes, origFromStoredName(name));
      const localPath = path.join(ctx.snapDir, localName);
      if (fs.existsSync(localPath)) {
        await fs.promises.rm(tmpPath, { force: true }); // 同内容已存在：复用
        return { localName, method: 'reuse' };
      }
      await fs.promises.rename(tmpPath, localPath);
      return { localName, method: 'pull' };
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {}); // 失败也清掉临时文件
      throw err;
    }
  });
  return sendJson(res, 200, {
    ok: true,
    localName: result.localName,
    remoteName: name,
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

// =====================================================================
// 四·五、服务器配置 / 同步记录的持久化接口
// =====================================================================

/**
 * 校验服务器配置字段：host/dir 必填且过白名单，user/urlBase 可选。
 * partial=true 时仅校验请求体中出现的字段（供 PATCH 局部更新用）。
 * 返回 { ok:true } 或 { ok:false, error }。
 */
export function validateServerFields(input, partial = false) {
  const has = (k) => input[k] !== undefined;
  if (!partial || has('host')) {
    if (validateHost(input.host) === null) {
      return { ok: false, error: 'host 不合法：仅允许字母、数字、点、下划线、连字符' };
    }
  }
  if (has('user') && input.user !== '' && validateUser(input.user) === null) {
    return { ok: false, error: 'user 不合法：仅允许字母、数字、点、下划线、连字符' };
  }
  if (!partial || has('dir')) {
    if (validateDir(input.dir) === null) {
      return { ok: false, error: 'dir 不合法：必须以 / 开头，且仅允许字母、数字、点、下划线、连字符、斜杠' };
    }
  }
  if (has('urlBase') && input.urlBase) {
    if (typeof input.urlBase !== 'string' || !/^https?:\/\//.test(input.urlBase) || /\s/.test(input.urlBase)) {
      return { ok: false, error: 'urlBase 不合法：需形如 https://cdn.example.com/snap' };
    }
  }
  return { ok: true };
}

/** 校验 history 单条：orig 为字符串、targets 为数组；target 的 host/dir 非空时过白名单 */
function isValidHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.orig !== 'string' || !Array.isArray(entry.targets)) return false;
  for (const t of entry.targets) {
    if (!t || typeof t !== 'object') return false;
    if (t.host && validateHost(t.host) === null) return false;
    if (t.dir && validateDir(t.dir) === null) return false;
  }
  return true;
}

/** GET /api/servers：返回全部服务器配置 */
async function handleListServers(res, ctx) {
  sendJson(res, 200, { ok: true, servers: ctx.serversStore.read() });
}

/** POST /api/servers：新增一条（id 由客户端生成）；id 重复返回 409 */
async function handleCreateServer(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!body || typeof body.id !== 'string' || !body.id) {
    return sendJson(res, 400, { ok: false, error: 'id 必填' });
  }
  const v = validateServerFields(body);
  if (!v.ok) return sendJson(res, 400, { ok: false, error: v.error });
  const entry = {
    id: body.id,
    label: String(body.label || '').slice(0, 200),
    host: body.host,
    user: body.user || 'root',
    dir: body.dir,
    urlBase: body.urlBase || '',
  };
  let duplicated = false;
  await ctx.serversStore.update((list) => {
    if (list.some((s) => s.id === entry.id)) { duplicated = true; return; }
    list.push(entry);
  });
  if (duplicated) return sendJson(res, 409, { ok: false, error: '服务器配置 id 已存在' });
  sendJson(res, 200, { ok: true, server: entry });
}

/** PATCH /api/servers/:id：局部更新；不存在返回 404 */
async function handleUpdateServer(req, res, id, ctx) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: '请求体不合法' });
  const v = validateServerFields(body, true);
  if (!v.ok) return sendJson(res, 400, { ok: false, error: v.error });
  let updated = null;
  await ctx.serversStore.update((list) => {
    const s = list.find((x) => x.id === id);
    if (!s) return;
    if (body.label !== undefined) s.label = String(body.label).slice(0, 200);
    for (const k of ['host', 'user', 'dir', 'urlBase']) {
      if (body[k] !== undefined) s[k] = body[k];
    }
    updated = s;
  });
  if (!updated) return sendJson(res, 404, { ok: false, error: '服务器配置不存在' });
  sendJson(res, 200, { ok: true, server: updated });
}

/** DELETE /api/servers/:id：删除配置（历史记录保留）；幂等 */
async function handleDeleteServer(res, id, ctx) {
  await ctx.serversStore.update((list) => {
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list.splice(i, 1);
  });
  sendJson(res, 200, { ok: true });
}

/** GET /api/history：返回全部同步记录 */
async function handleListHistory(res, ctx) {
  sendJson(res, 200, { ok: true, history: ctx.historyStore.read() });
}

/** PUT /api/history/:name：覆盖式 upsert 单条（name 必须为合法存储名） */
async function handlePutHistory(req, res, name, ctx) {
  if (!isValidStoredName(name)) return sendJson(res, 400, { ok: false, error: 'name 不合法' });
  const body = await readJsonBody(req);
  if (!isValidHistoryEntry(body)) {
    return sendJson(res, 400, { ok: false, error: '请求体不合法：需为 { orig, targets[] }' });
  }
  await ctx.historyStore.update((h) => { h[name] = { orig: body.orig, targets: body.targets }; });
  sendJson(res, 200, { ok: true });
}

/** DELETE /api/history/:name：删除单条；幂等 */
async function handleDeleteHistory(res, name, ctx) {
  if (!isValidStoredName(name)) return sendJson(res, 400, { ok: false, error: 'name 不合法' });
  await ctx.historyStore.update((h) => { delete h[name]; });
  sendJson(res, 200, { ok: true });
}

/** POST /api/history/batch：{ upserts:{name:entry}, deletes:[name] } 原子应用（对账/批量清理用） */
async function handleBatchHistory(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: '请求体不合法' });
  const upserts = (body.upserts && typeof body.upserts === 'object' && !Array.isArray(body.upserts))
    ? body.upserts : {};
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  for (const [name, entry] of Object.entries(upserts)) {
    if (!isValidStoredName(name) || !isValidHistoryEntry(entry)) {
      return sendJson(res, 400, { ok: false, error: `upserts 含非法项：${name}` });
    }
  }
  await ctx.historyStore.update((h) => {
    for (const [name, entry] of Object.entries(upserts)) {
      h[name] = { orig: entry.orig, targets: entry.targets };
    }
    for (const name of deletes) delete h[name];
  });
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
    // 附带实例标识，便于确认当前 127.0.0.1:8123 到底指向哪台机器
    return sendJson(res, 200, { ok: true, id: ctx.svcId });
  }
  if (req.method === 'GET' && pathname === '/') {
    return sendIndexPage(res, ctx.svcId);
  }
  if (req.method === 'POST' && pathname === '/upload') {
    return handleUpload(req, res, searchParams, ctx);
  }
  if (req.method === 'POST' && pathname === '/sync') {
    return handleSync(req, res, searchParams, ctx);
  }
  if (req.method === 'POST' && pathname === '/pull') {
    return handlePull(req, res, searchParams, ctx);
  }
  if (req.method === 'GET' && pathname === '/api/remote') {
    return handleRemoteList(res, searchParams);
  }
  if (pathname === '/api/remote-file') {
    if (req.method === 'GET') return handleRemoteFile(req, res, searchParams, ctx);
    if (req.method === 'DELETE') return handleRemoteDelete(req, res, searchParams, ctx);
  }
  if (req.method === 'GET' && pathname === '/api/library') {
    return handleLibrary(res, ctx);
  }
  // —— 服务器配置（app 配置目录 servers.json）——
  if (pathname === '/api/servers') {
    if (req.method === 'GET') return handleListServers(res, ctx);
    if (req.method === 'POST') return handleCreateServer(req, res, ctx);
  }
  if (pathname.startsWith('/api/servers/')) {
    const id = safeDecode(pathname.slice('/api/servers/'.length));
    if (id === null || id === '') return sendJson(res, 400, { ok: false, error: '路径不合法' });
    if (req.method === 'PATCH') return handleUpdateServer(req, res, id, ctx);
    if (req.method === 'DELETE') return handleDeleteServer(res, id, ctx);
  }
  // —— 同步记录（app 数据目录 history.json）——
  if (pathname === '/api/history') {
    if (req.method === 'GET') return handleListHistory(res, ctx);
  }
  if (pathname === '/api/history/batch' && req.method === 'POST') {
    return handleBatchHistory(req, res, ctx);
  }
  if (pathname.startsWith('/api/history/')) {
    const name = safeDecode(pathname.slice('/api/history/'.length));
    if (name === null || name === '') return sendJson(res, 400, { ok: false, error: '路径不合法' });
    if (req.method === 'PUT') return handlePutHistory(req, res, name, ctx);
    if (req.method === 'DELETE') return handleDeleteHistory(res, name, ctx);
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
 * @param {string} [options.configDir] app 配置与数据目录，默认 SNAP_PUSH_CONFIG_DIR 或 ~/.config/snap-push
 * @param {number} [options.maxBody] 上传体积上限（字节），默认 20MB
 * @returns {import('node:http').Server}
 */
export function createServer(options = {}) {
  const snapDir = options.snapDir || process.env.SNAP_PUSH_DIR || DEFAULT_SNAP_DIR;
  const maxBody = options.maxBody || MAX_BODY_BYTES;
  // app 配置与数据目录：servers.json（服务器配置）/ history.json（同步记录）
  const configDir = resolveConfigDir(options);
  // 实例身份在服务创建时计算一次（可注入 secret/secretFile 便于测试与固定复现）
  const svcId = computeServiceId(options);

  // 串行队列：上传的「写盘 + 远端同步」逐个执行，避免并发 rsync 交叉
  let chain = Promise.resolve();
  const enqueue = (job) => {
    const next = chain.then(job, job); // 无论上一个任务成败都继续执行本任务
    chain = next.catch(() => {}); // 吞掉上一个任务的错误，保持队列不中断
    return next;
  };

  const ctx = {
    snapDir,
    maxBody,
    enqueue,
    svcId,
    configDir,
    serversStore: createJsonStore(path.join(configDir, 'servers.json'), []),
    historyStore: createJsonStore(path.join(configDir, 'history.json'), {}),
  };
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
 * 读取环境变量并启动服务（SNAP_PUSH_HOST / SNAP_PUSH_PORT / SNAP_PUSH_DIR）。
 */
export function start() {
  const host = process.env.SNAP_PUSH_HOST || DEFAULT_HOST;
  const port = Number(process.env.SNAP_PUSH_PORT) || DEFAULT_PORT;
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
