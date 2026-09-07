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
  mimeOf,
  buildProbeScript,
  run,
  syncToRemote,
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
    const server = createServer(options);
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

  test('非法输入返回 null（相对路径 / 特殊字符 / 空 / 仅斜杠）', () => {
    const badValues = ['tmp/no-leading-slash', '/tmp/a b', "/tmp/a';rm", '/tmp/a;b', '', undefined, '/'];
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
  test('字段齐全、hash 为 8 位 hex、两次调用稳定', () => {
    const a = computeServiceId();
    const b = computeServiceId();
    // hostname 必须与本机一致；ip 为合法 IPv4 或回退回环
    assert.equal(a.hostname, os.hostname());
    assert.ok(/^(\d{1,3}\.){3}\d{1,3}$/.test(a.ip), `ip 应为 IPv4：${a.ip}`);
    assert.equal(a.label, `${a.hostname}@${a.ip}`);
    assert.ok(/^[0-9a-f]{8}$/.test(a.hash), `hash 应为 8 位 hex：${a.hash}`);
    // 同机同一次运行结果必须稳定
    assert.deepEqual(b, a);
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
    // 实例标识形状校验（值随机器变化，只验证结构）
    assert.equal(typeof body.id, 'object');
    assert.ok(body.id.hostname && body.id.ip && body.id.label, 'id 缺少 hostname/ip/label');
    assert.ok(/^[0-9a-f]{8}$/.test(body.id.hash), `hash 应为 8 位 hex：${body.id.hash}`);
  });

  test('GET / → 200 占位 HTML（含 snap-push）', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').startsWith('text/html'));
    const html = await res.text();
    assert.ok(html.includes('snap-push'));
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
