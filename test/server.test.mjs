// snap-push 后端测试（零依赖：node:test + node:assert）
//
// 覆盖范围：
//   1. 纯函数：命名净化 / 参数白名单校验 / 存储名校验 / MIME 映射
//   2. 子进程封装 run：成功、非零退出、超时、命令不存在
//   3. 远端同步 syncToRemote：失败分支（不依赖真实网络）
//   4. HTTP 集成：createServer 注入临时目录 + 随机端口
//   5. E2E（可选）：SNAP_PUSH_E2E=1 且本机 sshd 免密可用时才启用
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createServer,
  md5Name,
  sanitizeOrigName,
  validateHost,
  validateUser,
  validateDir,
  isValidStoredName,
  computeServiceId,
  serviceIdFrom,
  getOrCreateSecret,
  mimeOf,
  buildProbeScript,
  md5OfName,
  origFromStoredName,
  validateRemoteFileName,
  buildRemoteListScript,
  parseRemoteList,
  run,
  runBuffer,
  syncToRemote,
  pullToLocal,
} from '../src/server.js';

const HEX32 = 'd41d8cd98f00b204e9800998ecf8427e'; // 合法的 32 位小写 hex 样例（md5("")）

// ===== 公共测试工具 =====

// 全部测试共用的临时根目录（teardown 统一清理）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-push-test-'));

function md5hex(bytes) {
  return crypto.createHash('md5').update(bytes).digest('hex');
}

// 启动绑定随机端口的测试服务实例
function startServer(options) {
  return new Promise((resolve) => {
    const server = createServer({
      // 注入临时身份文件：避免测试往真实 home 目录写 snap-push 身份
      secretFile: path.join(tmpRoot, `instance-${Math.random().toString(36).slice(2)}`),
      ...options,
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// 关闭服务：先强制断开 keep-alive 空闲连接，避免 close 回调挂起
async function stopServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

// POST /upload 便捷封装（params 经 URLSearchParams 安全编码）
function upload(base, params, body) {
  return fetch(`${base}/upload?${new URLSearchParams(params)}`, { method: 'POST', body });
}

// 上传并断言成功，返回 localName（供需要文件名的后续断言使用）
async function uploadAndGet(base, params, body) {
  const res = await upload(base, params, body);
  assert.equal(res.status, 200, `上传应成功，实际状态码 ${res.status}`);
  return (await res.json()).localName;
}

// 文件级 teardown：清理临时目录
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// =====================================================================
// 一、纯函数
// =====================================================================

describe('纯函数：sanitizeOrigName', () => {
  test('常规安全名原样保留', () => {
    assert.equal(sanitizeOrigName('Screenshot-01_.png'), 'Screenshot-01_.png');
  });

  test('仅取 basename（切断路径）', () => {
    assert.equal(sanitizeOrigName('../x.png'), 'x.png');
    assert.equal(sanitizeOrigName('/etc/passwd'), 'passwd');
    assert.equal(sanitizeOrigName('a/b/c.png'), 'c.png');
  });

  test('过滤白名单外的字符（空格、中文等）', () => {
    assert.equal(sanitizeOrigName('my shot 01.png'), 'myshot01.png');
    assert.equal(sanitizeOrigName('截图.png'), '.png');
  });

  test('去首尾空白', () => {
    assert.equal(sanitizeOrigName('  x.png  '), 'x.png');
  });

  test('空值 / 全非法 / 非字符串 → 默认 image.png', () => {
    assert.equal(sanitizeOrigName(''), 'image.png');
    assert.equal(sanitizeOrigName('   '), 'image.png');
    assert.equal(sanitizeOrigName(undefined), 'image.png');
  });
});

describe('纯函数：md5Name', () => {
  test('返回 <md5hex>-<净化原名>，md5 与内容一致', () => {
    const bytes = Buffer.from('hello');
    const name = md5Name(bytes, 'a.png');
    assert.equal(name, `${md5hex(bytes)}-a.png`);
    assert.match(name, /^[0-9a-f]{32}-a\.png$/);
  });

  test('原名带路径穿越时净化为 basename', () => {
    const bytes = Buffer.from('x');
    assert.equal(md5Name(bytes, '../../etc/passwd'), `${md5hex(bytes)}-passwd`);
  });

  test('不同内容产生不同 md5', () => {
    assert.notEqual(md5Name(Buffer.from('a'), 'x.png'), md5Name(Buffer.from('b'), 'x.png'));
  });
});

describe('纯函数：validateHost / validateUser', () => {
  test('合法值原样返回', () => {
    assert.equal(validateHost('192.168.1.10'), '192.168.1.10');
    assert.equal(validateHost('srv-01.example.com'), 'srv-01.example.com');
    assert.equal(validateHost('my_host'), 'my_host');
    assert.equal(validateUser('root'), 'root');
    assert.equal(validateUser('deploy_01'), 'deploy_01');
  });

  test('非法输入返回 null（注入字符 / 空 / 非字符串）', () => {
    const badValues = ['', 'a b', 'a;rm -rf', 'a$(id)', 'a|b', 'a/b', 'a\\b', 'a\nb', undefined, null];
    for (const bad of badValues) {
      assert.equal(validateHost(bad), null, `validateHost 应拒绝: ${JSON.stringify(bad)}`);
      assert.equal(validateUser(bad), null, `validateUser 应拒绝: ${JSON.stringify(bad)}`);
    }
  });
});

describe('纯函数：validateDir', () => {
  test('合法目录原样返回，尾部斜杠被去掉', () => {
    assert.equal(validateDir('/tmp/snap-push'), '/tmp/snap-push');
    assert.equal(validateDir('/tmp/snap-push/'), '/tmp/snap-push');
    assert.equal(validateDir('/data/images_v2.bak'), '/data/images_v2.bak');
  });

  test('非法输入返回 null（相对路径 / 特殊字符 / 空 / 仅斜杠 / .. 穿越）', () => {
    const badValues = ['tmp/no-leading-slash', '/tmp/a b', "/tmp/a';rm", '/tmp/a;b', '', undefined, '/', '/tmp/../etc', '/../etc', '/a/../../b'];
    for (const bad of badValues) {
      assert.equal(validateDir(bad), null, `validateDir 应拒绝: ${JSON.stringify(bad)}`);
    }
  });
});

describe('纯函数：isValidStoredName', () => {
  test('识别合法存储名 <32hex>-<安全名>', () => {
    assert.ok(isValidStoredName(`${HEX32}-x.png`));
    assert.ok(isValidStoredName(`${HEX32}-Screenshot_01.jpg`));
    assert.ok(isValidStoredName(`${HEX32}-..`)); // 字面量文件名，不含路径分隔符，本身无穿越风险
  });

  test('拒绝非法存储名（穿越 / 缺 md5 / 大写 hex / 空段 / 非字符串）', () => {
    const badValues = [
      `${HEX32}-../etc/passwd`,
      `${HEX32}-a/b.png`,
      'x.png',
      HEX32,
      `${HEX32}-`,
      `D41D8CD98F00B204E9800998ECF8427E-x.png`,
      'short-x.png',
      '../etc/passwd',
      `${HEX32}-a b.png`,
      '',
      undefined,
    ];
    for (const bad of badValues) {
      assert.equal(isValidStoredName(bad), false, `应拒绝: ${JSON.stringify(bad)}`);
    }
  });
});

describe('纯函数：md5OfName / origFromStoredName', () => {
  test('合法存储名取出 md5 与原名', () => {
    assert.equal(md5OfName(`${HEX32}-a.png`), HEX32);
    assert.equal(origFromStoredName(`${HEX32}-a.png`), 'a.png');
    // 原名本身可含连字符，仍完整还原
    assert.equal(origFromStoredName(`${HEX32}-my-shot.png`), 'my-shot.png');
  });

  test('不符合约定时：md5 为 null，原名整体返回', () => {
    assert.equal(md5OfName('x.png'), null);
    assert.equal(md5OfName(undefined), null);
    assert.equal(origFromStoredName('x.png'), 'x.png');
    assert.equal(origFromStoredName(''), 'image.png');
  });
});

describe('纯函数：validateRemoteFileName', () => {
  test('接受安全文件名（含无 md5 前缀的手工名）', () => {
    assert.equal(validateRemoteFileName(`${HEX32}-a.png`), `${HEX32}-a.png`);
    assert.equal(validateRemoteFileName('manual-shot.png'), 'manual-shot.png');
    assert.equal(validateRemoteFileName('a_b.c-d'), 'a_b.c-d');
  });

  test('拒绝路径穿越 / 引号 / 空白 / 纯点 / 非字符串', () => {
    const bad = ['../etc/passwd', 'a/b.png', "a'b.png", 'a b.png', '.', '..', '', undefined, null];
    for (const v of bad) {
      assert.equal(validateRemoteFileName(v), null, `应拒绝: ${JSON.stringify(v)}`);
    }
  });
});

describe('纯函数：buildRemoteListScript', () => {
  test('脚本包含目录判断、rsync 探测与 ls -1（快照断言）', () => {
    const script = buildRemoteListScript('/tmp/snap-push');
    assert.equal(script, [
      "if [ -d '/tmp/snap-push' ]; then",
      '  echo ::DIR_OK::;',
      '  command -v rsync >/dev/null 2>&1 && echo ::RSYNC_OK:: || echo ::RSYNC_NO::;',
      "  ls -1 '/tmp/snap-push' 2>/dev/null;",
      'else',
      '  echo ::DIR_MISSING::;',
      'fi',
    ].join('\n'));
  });
});

describe('纯函数：parseRemoteList', () => {
  test('目录存在 + 有 rsync + 正常文件名', () => {
    const out = ['::DIR_OK::', '::RSYNC_OK::', `${HEX32}-a.png`, 'manual.png'].join('\n');
    assert.deepEqual(parseRemoteList(out), {
      dirExists: true,
      hasRsync: true,
      files: [
        { name: `${HEX32}-a.png`, md5: HEX32 },
        { name: 'manual.png', md5: null },
      ],
    });
  });

  test('无 rsync 标记 → hasRsync=false', () => {
    const out = ['::DIR_OK::', '::RSYNC_NO::', `${HEX32}-a.png`].join('\n');
    const parsed = parseRemoteList(out);
    assert.equal(parsed.dirExists, true);
    assert.equal(parsed.hasRsync, false);
    assert.equal(parsed.files.length, 1);
  });

  test('目录缺失 → 空清单', () => {
    assert.deepEqual(parseRemoteList('::DIR_MISSING::'), { dirExists: false, hasRsync: false, files: [] });
  });

  test('非法名（含空格/引号）被忽略，标记行不入清单', () => {
    const out = ['::DIR_OK::', '::RSYNC_OK::', 'a b.png', "a'b.png", 'ok.png'].join('\n');
    const parsed = parseRemoteList(out);
    assert.deepEqual(parsed.files, [{ name: 'ok.png', md5: null }]);
  });

  test('文件名与旧标记同名不再冲突（标记已改为 :: 前缀）', () => {
    const out = ['::DIR_OK::', '__DIR_MISSING__', '::RSYNC_OK::', 'plain.png'].join('\n');
    const parsed = parseRemoteList(out);
    assert.equal(parsed.dirExists, true);
    assert.deepEqual(parsed.files.map((f) => f.name), ['__DIR_MISSING__', 'plain.png']);
  });
});

describe('纯函数：mimeOf', () => {
  test('常见图片扩展名映射正确（大小写不敏感）', () => {
    assert.equal(mimeOf('a.png'), 'image/png');
    assert.equal(mimeOf('b.jpg'), 'image/jpeg');
    assert.equal(mimeOf('c.jpeg'), 'image/jpeg');
    assert.equal(mimeOf('d.gif'), 'image/gif');
    assert.equal(mimeOf('e.webp'), 'image/webp');
    assert.equal(mimeOf('f.svg'), 'image/svg+xml');
    assert.equal(mimeOf('g.bmp'), 'image/bmp');
    assert.equal(mimeOf('H.PNG'), 'image/png');
  });

  test('未知扩展名或无扩展名回退为二进制流', () => {
    assert.equal(mimeOf('noext'), 'application/octet-stream');
    assert.equal(mimeOf('x.txt'), 'application/octet-stream');
    assert.equal(mimeOf('x.tar.gz'), 'application/octet-stream');
  });
});

describe('实例服务 ID：computeServiceId', () => {
  // 单元测试一律注入固定 secret，避免在真实 home 目录写身份文件
  test('注入 secret：label=hostname、hash 8 位 hex、两次调用稳定', () => {
    const a = computeServiceId({ secret: 'test-fixed-secret' });
    const b = computeServiceId({ secret: 'test-fixed-secret' });
    assert.equal(a.hostname, os.hostname()); // label 仅用 hostname，不含 ip
    assert.equal(a.label, os.hostname());
    assert.equal(a.ip, undefined, '身份不再依赖 ip'); // 回归守卫：ip 不得参与
    assert.ok(/^[0-9a-f]{8}$/.test(a.hash), `hash 应为 8 位 hex：${a.hash}`);
    assert.deepEqual(b, a); // 同 secret 必须稳定
  });

  test('serviceIdFrom 纯函数：同输入稳定、输入变化 hash 变化', () => {
    const s1 = serviceIdFrom('dev-a', 'secret-1');
    assert.deepEqual(serviceIdFrom('dev-a', 'secret-1'), s1); // 幂等
    assert.notEqual(serviceIdFrom('dev-a', 'secret-2').hash, s1.hash); // secret 变→hash 变
    assert.notEqual(serviceIdFrom('dev-b', 'secret-1').hash, s1.hash); // hostname 变→hash 变
    // 关键回归：同一机器只换网络/IP 时（hostname 与 secret 不变）hash 必须保持不变
    assert.equal(serviceIdFrom('dev-a', 'secret-1').hash, s1.hash);
    assert.ok(/^[0-9a-f]{8}$/.test(s1.hash));
  });

  test('身份文件：首次创建 32 hex、再次调用读回不变；删除后变化', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'idfile-'));
    const file = path.join(dir, 'instance-id');
    const a = computeServiceId({ secretFile: file });
    const raw = fs.readFileSync(file, 'utf8').trim();
    assert.ok(/^[0-9a-f]{32}$/.test(raw), `身份文件应为 32 位 hex：${raw}`);
    const b = computeServiceId({ secretFile: file });
    assert.deepEqual(b, a); // 文件持久化 → 身份稳定
    // 文件被删 → 重新生成 → hash 变化（说明持久化是稳定关键）
    fs.unlinkSync(file);
    const c = computeServiceId({ secretFile: file });
    assert.notEqual(c.hash, a.hash);
  });

  test('home 不可写（文件目录无法创建）时降级 hostname 兜底，不抛错', () => {
    // 指向一个必不可能创建成功的路径（路径存在且是普通文件 → mkdir 失败）
    const blocker = path.join(tmpRoot, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const badFile = path.join(blocker, 'sub', 'instance-id');
    const id = computeServiceId({ secretFile: badFile }); // 不应抛错
    assert.ok(/^[0-9a-f]{8}$/.test(id.hash));
  });
});

describe('纯函数：buildProbeScript（妙传探测脚本）', () => {
  test('探测脚本包含 md5 内容比对（快照断言）', () => {
    // 文件名前 32 位 hex 即内容 md5：同名必须同内容才算已存在，防残缺文件被误判
    const script = buildProbeScript(`${HEX32}-x.png`, '/tmp/d');
    assert.equal(
      script,
      `mkdir -p '/tmp/d'; if test -f '/tmp/d/${HEX32}-x.png' && md5sum '/tmp/d/${HEX32}-x.png' 2>/dev/null | grep -q '^${HEX32}'; then echo EXISTS; else echo MISSING; fi`,
    );
  });

  test('名字不符合 <md5>- 约定时条件退化为 false：强制 MISSING（宁可重传不跳过）', () => {
    const script = buildProbeScript('foo.png', '/tmp/d');
    assert.equal(script, `mkdir -p '/tmp/d'; if false; then echo EXISTS; else echo MISSING; fi`);
  });
});

// =====================================================================
// 二、子进程封装 run
// =====================================================================

describe('run 子进程封装', () => {
  test('成功执行并收集 stdout / stderr / 退出码', async () => {
    const r = await run('node', ['-e', 'console.log("out"); console.error("err")']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('out'));
    assert.ok(r.stderr.includes('err'));
  });

  test('非零退出码原样返回（不抛错，由调用方判定语义）', async () => {
    const r = await run('node', ['-e', 'process.exit(3)']);
    assert.equal(r.code, 3);
  });

  test('超时被强杀并抛中文错误', async () => {
    await assert.rejects(
      run('node', ['-e', 'setTimeout(() => {}, 60000)'], 300),
      (err) => err instanceof Error && /超时/.test(err.message),
    );
  });

  test('命令不存在时抛中文错误', async () => {
    await assert.rejects(
      run('snap-push-no-such-cmd', ['--x']),
      (err) => err instanceof Error && /无法执行/.test(err.message),
    );
  });
});

describe('runBuffer 二进制子进程封装', () => {
  test('stdout 以 Buffer 收集，二进制字节不被 utf8 破坏', async () => {
    // 输出 0x00-0xff 全字节序列，验证不做 utf8 解码
    const r = await runBuffer('node', [
      '-e',
      'process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)))',
    ]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.length, 256);
    assert.equal(r.stdout[0], 0);
    assert.equal(r.stdout[255], 255);
  });

  test('超过大小上限时抛中文错误并强杀', async () => {
    await assert.rejects(
      runBuffer('node', ['-e', 'process.stdout.write(Buffer.alloc(4096))'], 5000, 1024),
      (err) => err instanceof Error && /大小上限/.test(err.message),
    );
  });
});

// =====================================================================
// 三、syncToRemote 失败分支（不依赖真实网络）
// =====================================================================

describe('syncToRemote 失败分支', () => {
  const localPath = path.join(tmpRoot, 'probe-fail.bin');

  before(() => {
    fs.writeFileSync(localPath, 'probe-content');
  });

  test('目标不可达（域名解析立即失败）→ 抛带 stderr 摘要的中文错误', async () => {
    await assert.rejects(
      syncToRemote(localPath, `${HEX32}-probe.png`, {
        host: '127.0.0.256', // 非法 IPv4，getaddrinfo 秒级失败，测试无需等超时
        user: 'root',
        dir: '/tmp/snap-push',
      }),
      (err) => err instanceof Error && /ssh/.test(err.message) && /失败/.test(err.message),
    );
  });
});

// =====================================================================
// 三·五、HTTP 集成：POST /sync（从图库补齐）
// =====================================================================

describe('POST /sync（从图库补齐接口）', () => {
  let server;
  let base;
  let snapDir;

  before(async () => {
    snapDir = path.join(tmpRoot, 'sync');
    ({ server, base } = await startServer({ snapDir }));
  });

  after(async () => {
    await stopServer(server);
  });

  // 先本机落盘一张图，返回其 localName（/sync 复用图库已有文件）
  async function seedLocal(orig) {
    const res = await upload(base, { name: orig }, crypto.randomBytes(16));
    assert.equal(res.status, 200);
    return (await res.json()).localName;
  }

  test('缺 name / name 不合法 → 400', async () => {
    // 缺 name
    let r = await fetch(`${base}/sync?host=127.0.0.1&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
    // 非 <md5>- 前缀（含路径穿越串）→ 400
    r = await fetch(`${base}/sync?name=evil%2F..%2Fx.png&host=127.0.0.1&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/sync?name=x.png&host=127.0.0.1&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
  });

  test('host 缺失/非法、dir 缺失 → 400', async () => {
    const localName = await seedLocal('a.png');
    // host 缺失
    let r = await fetch(`${base}/sync?name=${encodeURIComponent(localName)}&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
    // host 非法字符
    r = await fetch(`${base}/sync?name=${encodeURIComponent(localName)}&host=bad%20host&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
    // dir 缺失
    r = await fetch(`${base}/sync?name=${encodeURIComponent(localName)}&host=127.0.0.1`, { method: 'POST' });
    assert.equal(r.status, 400);
  });

  test('合法名但图库中不存在该文件 → 404', async () => {
    const r = await fetch(
      `${base}/sync?name=${HEX32}-ghost.png&host=127.0.0.1&user=root&dir=/tmp/x`,
      { method: 'POST' },
    );
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.ok, false);
  });

  test('目标不可达 → 500 中文错误，服务不崩', async () => {
    const localName = await seedLocal('b.png');
    const r = await fetch(
      `${base}/sync?name=${encodeURIComponent(localName)}&host=127.0.0.256&user=root&dir=/tmp/x`,
      { method: 'POST' },
    );
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /ssh/);
    // 服务仍可用
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

// =====================================================================
// 三·六、HTTP 集成：远端对账与拉取接口
// =====================================================================

describe('GET /api/remote（探测 + 清单）', () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await startServer({ snapDir: path.join(tmpRoot, 'remote-list') }));
  });

  after(async () => {
    await stopServer(server);
  });

  test('缺 host / dir 非法 → 400', async () => {
    let r = await fetch(`${base}/api/remote?dir=/tmp/x`);
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/remote?host=127.0.0.1&dir=relative`);
    assert.equal(r.status, 400);
  });

  test('目标不可达 → 200 且 ok:false（前端据此忽略本次合并）', async () => {
    const r = await fetch(`${base}/api/remote?host=127.0.0.256&user=root&dir=/tmp/x`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /ssh|失败/);
  });
});

describe('GET / DELETE /api/remote-file（远端缩略图）', () => {
  let server;
  let base;
  let snapDir;

  before(async () => {
    snapDir = path.join(tmpRoot, 'remote-file');
    ({ server, base } = await startServer({ snapDir }));
  });

  after(async () => {
    await stopServer(server);
  });

  test('GET 命中本地缓存 → 直接回放字节（不回退 ssh）', async () => {
    const host = '127.0.0.1';
    const dir = '/tmp/x';
    const name = `${HEX32}-cached.png`;
    // 复现服务端的缓存键：sha1(host|dir) 前 12 位 + '-' + 文件名
    const key = crypto.createHash('sha1').update(`${host}|${dir}`).digest('hex').slice(0, 12);
    const cacheDir = path.join(snapDir, '.remote-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${key}-${name}`), Buffer.from([1, 2, 3, 4]));

    const url = `${base}/api/remote-file?host=${host}&user=root&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`;
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...buf], [1, 2, 3, 4]);
  });

  test('GET 缺 name / name 含路径穿越 → 400', async () => {
    let r = await fetch(`${base}/api/remote-file?host=127.0.0.1&dir=/tmp/x`);
    assert.equal(r.status, 400);
    r = await fetch(
      `${base}/api/remote-file?host=127.0.0.1&dir=/tmp/x&name=${encodeURIComponent('../etc/passwd')}`,
    );
    assert.equal(r.status, 400);
  });

  test('GET 目标不可达 → 404 且 ok:false，服务不崩', async () => {
    const r = await fetch(
      `${base}/api/remote-file?host=127.0.0.256&user=root&dir=/tmp/x&name=${HEX32}-a.png`,
    );
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.ok, false);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });

  test('DELETE 缺 name → 400；目标不可达 → 502', async () => {
    let r = await fetch(`${base}/api/remote-file?host=127.0.0.1&dir=/tmp/x`, { method: 'DELETE' });
    assert.equal(r.status, 400);
    r = await fetch(
      `${base}/api/remote-file?host=127.0.0.256&user=root&dir=/tmp/x&name=${HEX32}-a.png`,
      { method: 'DELETE' },
    );
    assert.equal(r.status, 502);
    assert.equal((await r.json()).ok, false);
  });
});

describe('POST /pull（拉回本地）', () => {
  let server;
  let base;
  let snapDir;

  before(async () => {
    snapDir = path.join(tmpRoot, 'pull');
    ({ server, base } = await startServer({ snapDir }));
  });

  after(async () => {
    await stopServer(server);
  });

  test('缺 name / 缺 host → 400', async () => {
    let r = await fetch(`${base}/pull?host=127.0.0.1&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/pull?name=${HEX32}-a.png&dir=/tmp/x`, { method: 'POST' });
    assert.equal(r.status, 400);
  });

  test('本地已有同 md5 → 直接复用，不发起网络请求', async () => {
    // 先本机落盘一张图，拿到其 <md5>-原名
    const bytes = crypto.randomBytes(24);
    const up = await upload(base, { name: 'dup.png' }, bytes);
    const localName = (await up.json()).localName;
    // 用同一名字向一个不可达 host 发起 pull：若走网络会失败，能成功即证明命中复用分支
    const r = await fetch(
      `${base}/pull?name=${encodeURIComponent(localName)}&host=127.0.0.256&user=root&dir=/tmp/x`,
      { method: 'POST' },
    );
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.method, 'reuse');
    assert.equal(body.localName, localName);
  });

  test('本地无副本且目标不可达 → 500 中文错误', async () => {
    const r = await fetch(
      `${base}/pull?name=${HEX32}-ghost.png&host=127.0.0.256&user=root&dir=/tmp/x`,
      { method: 'POST' },
    );
    assert.equal(r.status, 500);
    assert.equal((await r.json()).ok, false);
  });
});

// =====================================================================
// 四、HTTP 集成：基础接口（共享一个测试实例）
// =====================================================================

describe('HTTP 基础接口', () => {
  let server;
  let base;
  let snapDir;

  before(async () => {
    snapDir = path.join(tmpRoot, 'shared');
    ({ server, base } = await startServer({ snapDir }));
  });

  after(async () => {
    await stopServer(server);
  });

  test('GET /health → 200 {ok,id}', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.equal(body.ok, true);
    // 实例标识形状校验（label=hostname；hash 值随 secret 变化，只验证结构）
    assert.equal(typeof body.id, 'object');
    assert.equal(body.id.label, os.hostname());
    assert.equal(body.id.hostname, os.hostname());
    assert.equal(body.id.ip, undefined, '身份不应包含 ip');
    assert.ok(/^[0-9a-f]{8}$/.test(body.id.hash), `hash 应为 8 位 hex：${body.id.hash}`);
  });

  test('GET / → 200 占位 HTML（含 snap-push）', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').startsWith('text/html'));
    const html = await res.text();
    assert.ok(html.includes('snap-push'));
    // 新增的对账/同步 UI 关键节点与接口引用（防止页面模板回退）
    assert.ok(html.includes('id="targetStatus"'), '应含目标状态徽标');
    assert.ok(html.includes('id="recheckBtn"'), '应含重新对账按钮');
    assert.ok(html.includes('id="confirmMask"'), '应含确认弹窗');
    assert.ok(html.includes('id="syncSource"'), '应含同步来源选择');
    assert.ok(html.includes('/api/remote?'), '应引用远端探测接口');
    assert.ok(html.includes('/pull?'), '应引用拉回接口');
    // 回归守卫：#3 恢复记录属于正常一致态，不应再挂 recovered 状态徽标
    assert.ok(!html.includes("makeStateBadge('recovered'"), '不应再挂 recovered 状态徽标');
    // 图库改名与状态徽标
    assert.ok(!html.includes('历史图库'), '不应再出现“历史图库”');
    assert.ok(html.includes("makeStateBadge('remote-only', '远端独有')"), '应含远端独有卡片的“远端独有”标识');
    assert.ok(html.includes("makeStateBadge('stale', '远端已删')"), '应含“远端已删”状态标识');
    // 回归守卫：抽屉条目过多时卡片不得被 flex 压缩（否则操作行被裁且无法滚动）
    assert.ok(html.includes('.sync-card { width: 100%; flex: 0 0 auto; }'), '抽屉卡片应 flex:0 0 auto 防止压缩');
    // 卡片新增/删除动效：从下滑入 + 模糊到清晰；缩小 + 旋转滑出（图库网格与同步抽屉共用）
    assert.ok(html.includes('@keyframes card-in'), '应含卡片入场关键帧');
    assert.ok(html.includes('@keyframes card-out'), '应含卡片出场关键帧');
    assert.ok(html.includes('.card-enter'), '应含卡片入场类');
    assert.ok(html.includes('.card-leave'), '应含卡片出场类');
    assert.ok(html.includes('filter: blur(5px)'), '入场动效应含“模糊到清晰”');
    assert.ok(html.includes('rotate(4deg)'), '出场动效应含“旋转滑出”');
    assert.ok(html.includes('prefers-reduced-motion'), '应尊重系统“减少动态效果”设置');
    // 恢复不再有徽标，传输方式徽标也不再出现在图库卡片上
    assert.ok(!html.includes('badge-recovered'), '不应再引用 badge-recovered');
    assert.ok(!html.includes('badge-verified'), '不应再引用 badge-verified');
  });

  test('未知路径 → 404 + {ok:false} JSON', async () => {
    const res = await fetch(`${base}/no/such/path`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(typeof data.error, 'string');
  });

  test('POST /upload（无 host）→ 落盘本机，method=local', async () => {
    const bytes = crypto.randomBytes(64);
    const res = await upload(base, { name: 'shot.png' }, bytes);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.method, 'local');
    assert.equal(data.localName, `${md5hex(bytes)}-shot.png`);
    assert.equal(data.remotePath, path.resolve(snapDir, data.localName));
    assert.equal('url' in data, false, '未传 urlBase 时不应有 url 字段');
    // 文件真实落盘且内容一致
    assert.deepEqual(fs.readFileSync(path.join(snapDir, data.localName)), bytes);
  });

  test('同字节重复上传 → 幂等成功，localName 不变', async () => {
    const bytes = Buffer.from('idempotent-content');
    const r1 = await upload(base, { name: 'dup.png' }, bytes);
    const r2 = await upload(base, { name: 'dup.png' }, bytes);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const d1 = await r1.json();
    const d2 = await r2.json();
    assert.equal(d2.ok, true);
    assert.equal(d1.localName, d2.localName);
    assert.equal(d2.method, 'local');
  });

  test('带 urlBase → 返回 url = urlBase/<name>', async () => {
    const bytes = Buffer.from('urlbase-content');
    const res = await upload(base, { name: 'u.png', urlBase: 'https://img.example.com/p' }, bytes);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.url, `https://img.example.com/p/${data.localName}`);
  });

  test('上传原名带路径穿越 → 净化为 basename，不含路径分隔符', async () => {
    const bytes = crypto.randomBytes(8);
    const res = await upload(base, { name: '../../evil.png' }, bytes);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.localName, `${md5hex(bytes)}-evil.png`);
    assert.ok(!data.localName.includes('/'));
  });

  test('上传原名含中文/空白 → 过滤为安全名或默认名', async () => {
    const bytes = crypto.randomBytes(4);
    const zh = await upload(base, { name: '截图.png' }, bytes);
    assert.equal(zh.status, 200);
    assert.equal((await zh.json()).localName, `${md5hex(bytes)}-.png`);

    const blank = await upload(base, { name: '   ' }, bytes);
    assert.equal(blank.status, 200);
    assert.equal((await blank.json()).localName, `${md5hex(bytes)}-image.png`);
  });

  test('缺少 name 参数 → 400 中文错误', async () => {
    const res = await upload(base, {}, Buffer.from('x'));
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /name/);
  });

  test('host 含非法字符（注入尝试）→ 400', async () => {
    const res = await upload(base, { name: 'a.png', host: '1.2.3.4;touch /tmp/pwned' }, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });

  test('user 含非法字符 → 400', async () => {
    const res = await upload(base, { name: 'a.png', host: '1.2.3.4', user: 'a b' }, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });

  test('host 非空但缺 dir → 400', async () => {
    const res = await upload(base, { name: 'a.png', host: '1.2.3.4' }, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /目录/);
  });

  test('dir 不以 / 开头 → 400', async () => {
    const res = await upload(base, { name: 'a.png', host: '1.2.3.4', dir: 'tmp/x' }, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });

  test('远端 ssh 不可达 → 500 中文错误，服务不崩溃', async () => {
    const res = await upload(base, { name: 'a.png', host: '127.0.0.256', user: 'root', dir: '/tmp/x' }, Buffer.from('x'));
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /ssh/);
    // 服务应仍然可用
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  test('GET /files/<非法名> → 400/404，绝不返回系统文件', async () => {
    const badNames = [
      '../etc/passwd', // fetch 客户端先规范化为 /etc/passwd → 服务端 404
      '%2E%2E%2Fetc%2Fpasswd', // 解码后含 / → 400
      `${HEX32}-..%2Fetc%2Fpasswd`,
      `${HEX32}-a%2Fb.png`,
      'x.png', // 不符合 <md5>- 前缀
      'a%zz', // 非法百分号编码
    ];
    for (const n of badNames) {
      const res = await fetch(`${base}/files/${n}`);
      assert.ok([400, 404].includes(res.status), `name=${n} 应 400/404，实际 ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('root:'), `绝不能泄露系统文件内容：${n}`);
    }
  });

  test('GET /files/<格式合法但不存在> → 404', async () => {
    const res = await fetch(`${base}/files/${HEX32}-not-exist.png`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);
  });

  test('DELETE /files/<非法名> → 400', async () => {
    const res = await fetch(`${base}/files/${HEX32}-..%2Fetc`, { method: 'DELETE' });
    assert.equal(res.status, 400);
  });

  test('GET /api/library 按 mtime 降序排列', async () => {
    const bytes = crypto.randomBytes(6);
    const older = await uploadAndGet(base, { name: 'older.png' }, bytes);
    const newer = await uploadAndGet(base, { name: 'newer.png' }, bytes);
    // 手工设定 mtime，避免依赖上传时的毫秒级时序
    fs.utimesSync(path.join(snapDir, older), new Date('2020-01-01'), new Date('2020-01-01'));
    fs.utimesSync(path.join(snapDir, newer), new Date('2021-01-01'), new Date('2021-01-01'));

    const lib = await (await fetch(`${base}/api/library`)).json();
    const idxOlder = lib.files.findIndex((f) => f.name === older);
    const idxNewer = lib.files.findIndex((f) => f.name === newer);
    assert.ok(idxOlder >= 0 && idxNewer >= 0, '两个测试文件都应在图库中');
    assert.ok(idxNewer < idxOlder, '较新的文件应排在前面');
  });
});

// =====================================================================
// 五、HTTP 集成：完整生命周期（独立实例，保证「删除后图库为空」可断言）
// =====================================================================

describe('HTTP 完整流程：上传 → 图库 → 读取 → 删除', () => {
  let server;
  let base;
  let snapDir;

  before(async () => {
    snapDir = path.join(tmpRoot, 'flow');
    ({ server, base } = await startServer({ snapDir }));
  });

  after(async () => {
    await stopServer(server);
  });

  test('完整生命周期', async () => {
    // 1) 上传
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // 伪 PNG 头
    const up = await upload(base, { name: 'flow.png' }, bytes);
    assert.equal(up.status, 200);
    const { localName, method, remotePath } = await up.json();
    assert.equal(method, 'local');
    assert.equal(localName, `${md5hex(bytes)}-flow.png`);
    assert.equal(remotePath, path.resolve(snapDir, localName));

    // 原子写入：上传完成后目录中不应有 .tmp 临时文件残留（已全部 rename 为最终名）
    const leftovers = fs.readdirSync(snapDir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);

    // 2) 图库包含该文件，字段齐全
    const lib = await (await fetch(`${base}/api/library`)).json();
    const hit = lib.files.find((f) => f.name === localName);
    assert.ok(hit, '图库应包含刚上传的文件');
    assert.equal(hit.size, bytes.length);
    assert.ok(!Number.isNaN(Date.parse(hit.mtime)), 'mtime 应为可解析的 ISO 字符串');

    // 3) 读取文件：字节与 Content-Type 正确
    const file = await fetch(`${base}/files/${localName}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);

    // 4) 删除后：图库为空、读取 404、再删 404
    const del = await fetch(`${base}/files/${localName}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });

    const lib2 = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib2.files.length, 0, '删除后图库应为空');

    assert.equal((await fetch(`${base}/files/${localName}`)).status, 404);
    const delAgain = await fetch(`${base}/files/${localName}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 404);
  });
});

// =====================================================================
// 六、HTTP 集成：体积上限（注入 maxBody=1024）
// =====================================================================

describe('HTTP 体积上限（maxBody=1024 注入）', () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await startServer({ snapDir: path.join(tmpRoot, 'limit'), maxBody: 1024 }));
  });

  after(async () => {
    await stopServer(server);
  });

  test('等于/小于上限 → 200', async () => {
    assert.equal((await upload(base, { name: 'ok.png' }, crypto.randomBytes(512))).status, 200);
    assert.equal((await upload(base, { name: 'edge.png' }, crypto.randomBytes(1024))).status, 200);
  });

  test('超过上限 → 413 中文错误', async () => {
    const res = await upload(base, { name: 'big.png' }, crypto.randomBytes(2048));
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /超过/);
  });
});

// =====================================================================
// 七、E2E：真实 ssh/rsync/scp（默认跳过；SNAP_PUSH_E2E=1 且本机 sshd 免密时启用）
// =====================================================================

// =====================================================================
// 五、内嵌页面脚本冒烟（DOM 垫片）
// 用最小 DOM 垫片执行页面脚本，捕获初始化期的 ReferenceError / TypeError。
// 不追求行为正确，只作为“页面脚本可被浏览器解析并初始化”的回归守卫。
// =====================================================================

describe('内嵌页面脚本冒烟（DOM 垫片）', () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await startServer({ snapDir: path.join(tmpRoot, 'page-smoke') }));
  });

  after(async () => {
    await stopServer(server);
  });

  function makeEl() {
    return {
      _children: [],
      _listeners: {},
      _text: '',
      style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      appendChild(c) { this._children.push(c); return c; },
      // 模拟真实 DOM：设置 textContent 会清空子节点（renderGrid 依赖此行为清空重建）
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); this._children = []; },
      addEventListener(type, fn) {
        (this._listeners[type] || (this._listeners[type] = [])).push(fn);
      },
      removeEventListener(type, fn) {
        const a = this._listeners[type];
        if (!a) return;
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      // 测试用：派发已注册的监听器（真实浏览器由用户交互触发）
      _trigger(type, ev) {
        (this._listeners[type] || []).slice().forEach((fn) => fn(ev || {}));
      },
      getAttribute() { return ''; },
      setAttribute() {},
      removeAttribute() {},
      focus() {},
      click() {},
      reset() {},
      value: '',
      hidden: false,
      disabled: false,
      className: '',
      title: '',
      type: '',
      checked: false,
      alt: '',
      src: '',
      href: '',
      target: '',
      rel: '',
      loading: '',
      placeholder: '',
      files: null,
    };
  }

  // 递归查找 mock 节点树里的节点（供测试定位删除按钮等）
  function findNode(node, pred) {
    if (!node) return null;
    if (pred(node)) return node;
    for (const c of node._children || []) {
      const r = findNode(c, pred);
      if (r) return r;
    }
    return null;
  }

  // 构造 mock document：byId 缓存元素、createElement 记录 tagName
  function makeDocumentShim(byId) {
    return {
      body: makeEl(),
      getElementById(id) { return byId[id] || (byId[id] = makeEl()); },
      createElement(tag) {
        const el = makeEl();
        el.tagName = String(tag || '').toUpperCase();
        return el;
      },
      createTextNode(t) { return { text: t }; },
      addEventListener() {},
      removeEventListener() {},
    };
  }

  // 定位卡片上的「删除」按钮（className=danger 且文本为「删除」）
  function findDeleteBtn(root) {
    return findNode(root, (n) => n.className === 'danger' && n.textContent === '删除');
  }

  test('从 GET / 提取脚本并在垫片中初始化不抛异常', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, '应能提取内嵌 <script>');

    const byId = {};
    const documentShim = makeDocumentShim(byId);
    const store = new Map();
    const localStorageShim = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
    };
    const windowShim = { confirm() { return true; }, alert() {} };
    const fetchShim = () => new Promise(() => {}); // 挂起，避免触发真实网络

    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(
        'document', 'localStorage', 'window', 'fetch', 'console', 'URLSearchParams',
        'setTimeout', 'clearTimeout',
        m[1],
      )(
        documentShim, localStorageShim, windowShim, fetchShim, console, URLSearchParams,
        setTimeout, clearTimeout,
      );
    }, '页面脚本初始化不应抛异常');
  });

  // 递归查找 mock 节点树里是否存在指定文本（用于断言卡片内容）
  function hasText(node, text) {
    if (!node) return false;
    if (node.textContent === text) return true;
    for (const c of node._children || []) if (hasText(c, text)) return true;
    return false;
  }

  test('图库按目标渲染本地+远端独有，状态徽标为“远端独有”/“远端已删”', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, '应能提取内嵌 <script>');

    const LOCAL = `${HEX32}-local.png`;
    const REMOTE_ONLY = 'ffffffffffffffffffffffffffffffff-remote.png';
    const REMOTE_ONLY_MD5 = 'ffffffffffffffffffffffffffffffff';
    const STALE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-stale.png';

    const store = new Map();
    store.set('snap-push.servers', JSON.stringify([
      { id: 's1', label: 'A', host: '127.0.0.1', user: 'root', dir: '/tmp/x', urlBase: '' },
    ]));
    store.set('snap-push.target', JSON.stringify('s1'));
    // STALE：有 history 记录但远端已无 → 应显示「远端已删」
    store.set('snap-push.history', JSON.stringify({
      [STALE]: {
        orig: 'stale.png',
        targets: [{
          key: 's1', label: 'A', host: '127.0.0.1', dir: '/tmp/x',
          remoteName: STALE, remotePath: `/tmp/x/${STALE}`,
          method: 'rsync', stale: true, time: new Date().toISOString(),
        }],
      },
    }));
    store.set('snap-push.remoteIndex', JSON.stringify({
      '127.0.0.1|/tmp/x': {
        fetchedAt: Date.now(),
        files: [{ name: LOCAL, md5: HEX32 }, { name: REMOTE_ONLY, md5: REMOTE_ONLY_MD5 }],
      },
    }));

    const byId = {};
    const documentShim = makeDocumentShim(byId);
    const localStorageShim = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
    };
    const windowShim = { confirm() { return true; }, alert() {} };
    const fetchShim = async (url) => {
      const u = String(url);
      let body;
      if (u.includes('/api/library')) {
        body = { files: [
          { name: LOCAL, size: 10, mtime: new Date().toISOString() },
          { name: STALE, size: 11, mtime: new Date().toISOString() },
        ] };
      } else if (u.includes('/api/remote')) {
        body = { ok: true, dirExists: true, hasRsync: true, files: [{ name: LOCAL, md5: HEX32 }, { name: REMOTE_ONLY, md5: REMOTE_ONLY_MD5 }] };
      } else {
        body = { ok: true };
      }
      return { ok: true, status: 200, json: async () => body };
    };

    // eslint-disable-next-line no-new-func
    new Function(
      'document', 'localStorage', 'window', 'fetch', 'console', 'URLSearchParams',
      'setTimeout', 'clearTimeout', m[1],
    )(documentShim, localStorageShim, windowShim, fetchShim, console, URLSearchParams, setTimeout, clearTimeout);

    await new Promise((r) => setTimeout(r, 60)); // 等 refreshHistory + 探测完成
    const grid = byId['grid'];
    assert.ok(hasText(grid, 'local.png'), '应渲染本地卡片');
    assert.ok(hasText(grid, 'stale.png'), '应渲染远端已删记录所在卡片');
    assert.ok(hasText(grid, 'remote.png'), '应渲染远端独有卡片');
    assert.ok(hasText(grid, '远端独有'), '远端独有卡片应带“远端独有”标识');
    assert.ok(hasText(grid, '远端已删'), '远端已删记录应带“远端已删”标识');
    // 恢复记录无徽标；传输方式徽标不再出现在图库卡片上
    assert.ok(!hasText(grid, '恢复'), '图库卡片不应再出现“恢复”徽标');
    assert.ok(!hasText(grid, '妙传') && !hasText(grid, 'rsync') && !hasText(grid, 'scp'), '图库卡片不应再出现传输方式徽标');
  });

  // 新增动效：首次渲染的卡片应带 card-enter（淡入 + 缩放），验证键追踪生效
  test('新出现的图库卡片带 card-enter 入场动效', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, '应能提取内嵌 <script>');

    const LOCAL = `${HEX32}-local.png`;
    const store = new Map();

    const byId = {};
    const documentShim = makeDocumentShim(byId);
    const localStorageShim = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
    };
    const windowShim = { confirm() { return true; }, alert() {} };
    const fetchShim = async (url) => {
      const u = String(url);
      const body = u.includes('/api/library')
        ? { files: [{ name: LOCAL, size: 10, mtime: new Date().toISOString() }] }
        : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    };

    // eslint-disable-next-line no-new-func
    new Function(
      'document', 'localStorage', 'window', 'fetch', 'console', 'URLSearchParams',
      'setTimeout', 'clearTimeout', m[1],
    )(documentShim, localStorageShim, windowShim, fetchShim, console, URLSearchParams, setTimeout, clearTimeout);

    await new Promise((r) => setTimeout(r, 60));
    const grid = byId['grid'];
    assert.ok(hasText(grid, 'local.png'), '应渲染本地卡片');
    assert.ok(
      findNode(grid, (n) => typeof n.className === 'string' && n.className.includes('card-enter')),
      '首次渲染的卡片应带 card-enter 入场动效',
    );
    assert.ok(
      findNode(grid, (n) => n.style && n.style.animationDelay === '0ms'),
      '入场卡片应写入交错 animation-delay',
    );
  });

  // 回归：删除远端后，refreshHistory 不得用过期探测快照把记录“恢复”回来。
  // 修复前：dropRemoteIndexFile 未同步 probeState，删除后卡片复活，刷新后误标「远端已删」。
  test('服务器目标删除后卡片立即消失，且不残留“远端已删”', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, '应能提取内嵌 <script>');

    const LOCAL = `${HEX32}-local.png`;
    const KEY = '127.0.0.1|/tmp/x';

    const store = new Map();
    store.set('snap-push.servers', JSON.stringify([
      { id: 's1', label: 'A', host: '127.0.0.1', user: 'root', dir: '/tmp/x', urlBase: '' },
    ]));
    store.set('snap-push.target', JSON.stringify('s1'));
    store.set('snap-push.history', JSON.stringify({
      [LOCAL]: {
        orig: 'local.png',
        targets: [{
          key: 's1', label: 'A', host: '127.0.0.1', dir: '/tmp/x',
          remoteName: LOCAL, remotePath: `/tmp/x/${LOCAL}`,
          method: 'rsync', time: new Date().toISOString(),
        }],
      },
    }));
    store.set('snap-push.remoteIndex', JSON.stringify({
      [KEY]: { fetchedAt: Date.now(), files: [{ name: LOCAL, md5: HEX32 }] },
    }));

    const byId = {};
    const documentShim = makeDocumentShim(byId);
    const localStorageShim = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
    };
    const windowShim = { confirm() { return true; }, alert() {} };
    let deleteCalled = false;
    const fetchShim = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || 'GET';
      if (method === 'DELETE') {
        deleteCalled = true;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      let body;
      if (u.includes('/api/library')) {
        body = { files: [{ name: LOCAL, size: 10, mtime: new Date().toISOString() }] };
      } else if (u.includes('/api/remote')) {
        body = { ok: true, dirExists: true, hasRsync: true, files: [{ name: LOCAL, md5: HEX32 }] };
      } else {
        body = { ok: true };
      }
      return { ok: true, status: 200, json: async () => body };
    };

    // eslint-disable-next-line no-new-func
    new Function(
      'document', 'localStorage', 'window', 'fetch', 'console', 'URLSearchParams',
      'setTimeout', 'clearTimeout', m[1],
    )(documentShim, localStorageShim, windowShim, fetchShim, console, URLSearchParams, setTimeout, clearTimeout);

    await new Promise((r) => setTimeout(r, 60)); // 等 refreshHistory + 探测完成
    const grid = byId['grid'];
    assert.ok(hasText(grid, 'local.png'), '删除前应渲染本地卡片');

    const delBtn = findDeleteBtn(grid);
    assert.ok(delBtn, '应能定位到删除按钮');
    delBtn._trigger('click'); // 触发删除 → 弹确认
    byId['confirmOk']._trigger('click'); // 确认删除

    // 删除成功后先播放 380ms 出场动效（抖动 + 缩小淡出），再 refreshHistory 重绘，故等待时间需覆盖动画时长
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(deleteCalled, '应发起远端删除请求');
    assert.ok(!hasText(grid, 'local.png'), '删除后卡片应在出场动效后消失');
    assert.ok(!hasText(grid, '远端已删'), '删除后不应残留“远端已删”记录');
  });

  // 回归：探测在途时删除按钮置灰，且点击被守卫拒绝（避免用在途探测的旧快照删除）。
  test('探测在途时删除按钮置灰且点击被拒', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, '应能提取内嵌 <script>');

    const LOCAL = `${HEX32}-local.png`;
    const store = new Map();
    store.set('snap-push.servers', JSON.stringify([
      { id: 's1', label: 'A', host: '127.0.0.1', user: 'root', dir: '/tmp/x', urlBase: '' },
    ]));
    store.set('snap-push.target', JSON.stringify('s1'));
    store.set('snap-push.history', JSON.stringify({
      [LOCAL]: {
        orig: 'local.png',
        targets: [{
          key: 's1', label: 'A', host: '127.0.0.1', dir: '/tmp/x',
          remoteName: LOCAL, remotePath: `/tmp/x/${LOCAL}`,
          method: 'rsync', time: new Date().toISOString(),
        }],
      },
    }));

    const byId = {};
    const documentShim = makeDocumentShim(byId);
    const localStorageShim = {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
    };
    const windowShim = { confirm() { return true; }, alert() {} };
    let deleteCalled = false;
    const fetchShim = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || 'GET';
      if (method === 'DELETE') {
        deleteCalled = true;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes('/api/library')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ name: LOCAL, size: 10, mtime: new Date().toISOString() }] }) };
      }
      if (u.includes('/api/remote')) {
        return new Promise(() => {}); // 永不 resolve：让探测一直处于在途
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    // eslint-disable-next-line no-new-func
    new Function(
      'document', 'localStorage', 'window', 'fetch', 'console', 'URLSearchParams',
      'setTimeout', 'clearTimeout', m[1],
    )(documentShim, localStorageShim, windowShim, fetchShim, console, URLSearchParams, setTimeout, clearTimeout);

    await new Promise((r) => setTimeout(r, 60)); // 等 refreshHistory 完成渲染（探测仍在途）
    const grid = byId['grid'];
    const delBtn = findDeleteBtn(grid);
    assert.ok(delBtn, '应能定位到删除按钮');
    assert.equal(delBtn.disabled, true, '探测在途时删除按钮应置灰');

    delBtn._trigger('click'); // 触发被守卫拒绝
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deleteCalled, false, '探测在途时点击删除不应发起请求');
    assert.equal((byId['confirmOk']._listeners.click || []).length, 0, '探测在途时不应弹出确认框');
  });
});

const e2eEnabled = process.env.SNAP_PUSH_E2E === '1';
describe('E2E：真实 ssh 同步（需 SNAP_PUSH_E2E=1 与本机 sshd 免密）', { skip: !e2eEnabled }, () => {
  const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  let localPath;
  let remoteDir;
  let user;

  before(() => {
    user = process.env.USER || 'root';
    remoteDir = `/tmp/snap-push-e2e-${process.pid}-${Date.now()}`; // 每次运行独立远端目录
    localPath = path.join(tmpRoot, 'e2e-source.png');
    fs.writeFileSync(localPath, 'e2e-content');
  });

  after(async () => {
    // 尽力清理远端临时目录，失败不影响测试结果
    await run('ssh', [...SSH_ARGS, `${user}@127.0.0.1`, `rm -rf '${remoteDir}'`]).catch(() => {});
  });

  test('rsync 上传 → 二次上传妙传 skip', async () => {
    const name = `${HEX32}-e2e.png`;
    const r1 = await syncToRemote(localPath, name, { host: '127.0.0.1', user, dir: remoteDir });
    assert.equal(r1.method, 'rsync');
    const r2 = await syncToRemote(localPath, name, { host: '127.0.0.1', user, dir: remoteDir });
    assert.equal(r2.method, 'skip');
  });

  test('远端文件内容损坏（md5 不匹配）→ 不再妙传，重传修复（自愈）', async () => {
    const name = `${HEX32}-e2e-corrupt.png`;
    const target = { host: '127.0.0.1', user, dir: remoteDir };
    await syncToRemote(localPath, name, target); // 先正常上传一次

    // 直接篡改远端文件内容，模拟历史残缺（中断的 scp/rsync 残留）
    await run('ssh', [...SSH_ARGS, `${user}@127.0.0.1`, `echo broken > '${remoteDir}/${name}'`]);

    // md5 探测发现内容不符 → MISSING → 走 rsync 重传而非 skip
    const r = await syncToRemote(localPath, name, target);
    assert.equal(r.method, 'rsync');
  });

  test('rsync 报 not found → scp 兜底', async () => {
    // 构造一个「假 rsync」放到 PATH 最前：输出 command not found 模拟远端缺失 rsync
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-push-fakebin-'));
    const fakeRsync = path.join(fakeDir, 'rsync');
    fs.writeFileSync(fakeRsync, '#!/bin/sh\necho "sh: rsync: command not found" 1>&2\nexit 127\n');
    fs.chmodSync(fakeRsync, 0o755);

    const name = `${HEX32}-e2e-scp.png`;
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${oldPath}`;
    try {
      const r = await syncToRemote(localPath, name, { host: '127.0.0.1', user, dir: remoteDir });
      assert.equal(r.method, 'scp');
    } finally {
      process.env.PATH = oldPath; // 恢复 PATH，避免影响后续测试
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});
