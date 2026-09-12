# snap-push 服务端配置与数据目录 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development 逐任务实现。步骤使用 `- [ ]` 勾选跟踪。

**目标：** 把服务器配置与同步记录从浏览器 localStorage 迁移到服务端 `~/.config/snap-push/`（`servers.json` + `history.json`），提供细粒度接口；浏览器只留 `target` 与 `remoteIndex`。

**架构：** `src/server.js` 新增通用 JSON 存储 `createJsonStore`（串行 read-modify-write + 原子写），并新增 `/api/servers`、`/api/history` 两组接口；内嵌页面改为异步启动、经接口读写配置与历史，探测 `status` 仅存内存。

**技术栈：** Node.js ≥ 18，仅标准库；测试 `node:test`。

**设计文档：** `docs/superpowers/specs/2026-09-13-server-side-config-data-design.md`

---

### 任务 1：通用 JSON 存储 `createJsonStore`

**Files:**
- Modify: `src/server.js`（新增常量与 `createJsonStore`，导出）
- Test: `test/server.test.mjs`（新增 describe 块）

- [ ] **Step 1: 写失败测试**

在 `test/server.test.mjs` 顶部 import 中加入 `createJsonStore`，并新增：

```js
describe('createJsonStore（服务端 JSON 存储）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-push-store-'));
  const file = path.join(dir, 'servers.json');

  test('缺失文件回退默认值', () => {
    const store = createJsonStore(file, []);
    assert.deepEqual(store.read(), []);
  });

  test('写入后可读回', async () => {
    const store = createJsonStore(file, []);
    await store.update((s) => { s.push({ id: 's1' }); });
    assert.deepEqual(store.read(), [{ id: 's1' }]);
  });

  test('损坏内容回退默认值', async () => {
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(createJsonStore(file, []).read(), []);
  });

  test('形状不符回退默认值', () => {
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    assert.deepEqual(createJsonStore(file, []).read(), []);
  });

  test('并发 update 串行不丢更新', async () => {
    const f2 = path.join(dir, 'c.json');
    const store = createJsonStore(f2, []);
    await Promise.all([0, 1, 2, 3, 4].map((i) => store.update((s) => { s.push(i); })));
    assert.deepEqual(store.read().sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  });

  test('文件权限为 0600', async () => {
    const f3 = path.join(dir, 'm.json');
    const store = createJsonStore(f3, []);
    await store.update(() => {});
    assert.equal(fs.statSync(f3).mode & 0o777, 0o600);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/ 2>&1 | tail -20`
Expected: `createJsonStore is not a function` 相关失败。

- [ ] **Step 3: 实现**

在 `src/server.js` 顶部常量区新增：

```js
const DEFAULT_CONFIG_DIR = () =>
  path.join(os.homedir(), '.config', 'snap-push');
```

在「一、纯函数」区新增：

```js
/**
 * 通用 JSON 存储：文件缺失/损坏/形状不符时回退 fallback，绝不抛。
 * update(mutator) 串行 read-modify-write：mutator 同步修改 state，随后原子写
 * （同目录临时文件 → rename），避免并发丢更新与半截文件。
 * @param {string} file
 * @param {any} fallback 期望的形状（数组或对象）；read 后形状不符也回退
 * @param {(value:any)=>boolean} [isValid] 形状校验；缺省按 fallback 类型判断
 */
export function createJsonStore(file, fallback, isValid) {
  const check = isValid || ((v) =>
    Array.isArray(fallback)
      ? Array.isArray(v)
      : (v !== null && typeof v === 'object' && !Array.isArray(v)));
  let chain = Promise.resolve();
  function read() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return check(v) ? v : fallback;
    } catch {
      return fallback;
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
    chain = job.catch(() => {});
    return job;
  }
  return { read, update };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/ 2>&1 | tail -20`
Expected: 新增用例全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server.js test/server.test.mjs
git commit -m "feat: 新增服务端 JSON 存储 createJsonStore"
```

---

### 任务 2：servers 接口

**Files:**
- Modify: `src/server.js`（`createServer` 注入 `configDir`/stores；新增 handlers 与路由）
- Test: `test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
describe('服务端 servers 接口', () => {
  let server, base, configDir;
  before(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-push-cfg-'));
    ({ server, base } = await startServer({ configDir }));
  });
  after(() => server.close());

  const srv = { id: 's1', label: 'A', host: '127.0.0.1', user: 'root', dir: '/tmp/x', urlBase: '' };

  test('GET 初始为空数组', async () => {
    const r = await (await fetch(`${base}/api/servers`)).json();
    assert.deepEqual(r.servers, []);
  });

  test('POST 新增并可读回', async () => {
    const res = await fetch(`${base}/api/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(srv),
    });
    assert.equal(res.status, 200);
    const r = await (await fetch(`${base}/api/servers`)).json();
    assert.equal(r.servers.length, 1);
    assert.equal(r.servers[0].host, '127.0.0.1');
  });

  test('重复 id 返回 409', async () => {
    const res = await fetch(`${base}/api/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(srv),
    });
    assert.equal(res.status, 409);
  });

  test('PATCH 局部更新', async () => {
    const res = await fetch(`${base}/api/servers/s1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'B' }),
    });
    assert.equal(res.status, 200);
    const r = await (await fetch(`${base}/api/servers`)).json();
    assert.equal(r.servers[0].label, 'B');
    assert.equal(r.servers[0].host, '127.0.0.1');
  });

  test('非法 host 返回 400', async () => {
    const res = await fetch(`${base}/api/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...srv, id: 's2', host: 'bad host' }),
    });
    assert.equal(res.status, 400);
  });

  test('DELETE 删除', async () => {
    const res = await fetch(`${base}/api/servers/s1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const r = await (await fetch(`${base}/api/servers`)).json();
    assert.deepEqual(r.servers, []);
  });

  test('重启后配置仍在（落盘 servers.json）', () => {
    const file = path.join(configDir, 'servers.json');
    assert.ok(fs.existsSync(file));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/ 2>&1 | tail -20` → 404 / 无 `servers` 字段失败。

- [ ] **Step 3: 实现**

1) `createServer` 内：

```js
const configDir = options.configDir || process.env.SNAP_PUSH_CONFIG_DIR || DEFAULT_CONFIG_DIR();
const serversStore = createJsonStore(path.join(configDir, 'servers.json'), []);
const historyStore = createJsonStore(path.join(configDir, 'history.json'), {});
const ctx = { snapDir, maxBody, enqueue, svcId, configDir, serversStore, historyStore };
```

2) 新增校验与 handlers（放在 `handleLibrary` 附近）：

```js
/** 校验服务器配置字段；partial 时仅校验出现的字段。返回 {ok, error} */
export function validateServerFields(input, partial = false) {
  const has = (k) => input[k] !== undefined;
  if (!partial || has('host')) {
    if (validateHost(input.host) === null) return { ok: false, error: 'host 不合法' };
  }
  if (has('user') && input.user !== '' && validateUser(input.user) === null) {
    return { ok: false, error: 'user 不合法' };
  }
  if (!partial || has('dir')) {
    if (validateDir(input.dir) === null) return { ok: false, error: 'dir 不合法' };
  }
  if (has('urlBase') && input.urlBase) {
    if (!/^https?:\/\//.test(input.urlBase) || /\s/.test(input.urlBase)) {
      return { ok: false, error: 'urlBase 不合法' };
    }
  }
  return { ok: true };
}

async function handleListServers(res, ctx) {
  sendJson(res, 200, { ok: true, servers: ctx.serversStore.read() });
}

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
  let dup = false;
  await ctx.serversStore.update((list) => {
    if (list.some((s) => s.id === entry.id)) { dup = true; return; }
    list.push(entry);
  });
  if (dup) return sendJson(res, 409, { ok: false, error: 'id 已存在' });
  sendJson(res, 200, { ok: true, server: entry });
}

async function handleUpdateServer(req, res, id, ctx) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体不合法' });
  const v = validateServerFields(body, true);
  if (!v.ok) return sendJson(res, 400, { ok: false, error: v.error });
  let updated = null;
  await ctx.serversStore.update((list) => {
    const s = list.find((x) => x.id === id);
    if (!s) return;
    for (const k of ['label', 'host', 'user', 'dir', 'urlBase']) {
      if (body[k] !== undefined) s[k] = k === 'label' ? String(body[k]).slice(0, 200) : body[k];
    }
    updated = s;
  });
  if (!updated) return sendJson(res, 404, { ok: false, error: '服务器配置不存在' });
  sendJson(res, 200, { ok: true, server: updated });
}

async function handleDeleteServer(res, id, ctx) {
  await ctx.serversStore.update((list) => {
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list.splice(i, 1);
  });
  sendJson(res, 200, { ok: true });
}
```

3) 新增请求体读取辅助：

```js
/** 读取并解析 JSON 请求体（上限 4MB）；非法 JSON 返回 null */
const MAX_JSON_BODY = 4 * 1024 * 1024;
async function readJsonBody(req) {
  const buf = await readBodyWithLimit(req, MAX_JSON_BODY);
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}
```

4) 路由：

```js
if (pathname === '/api/servers') {
  if (req.method === 'GET') return handleListServers(res, ctx);
  if (req.method === 'POST') return handleCreateServer(req, res, ctx);
}
if (pathname.startsWith('/api/servers/')) {
  const id = safeDecode(pathname.slice('/api/servers/'.length));
  if (id === null) return sendJson(res, 400, { ok: false, error: '路径不合法' });
  if (req.method === 'PATCH') return handleUpdateServer(req, res, id, ctx);
  if (req.method === 'DELETE') return handleDeleteServer(res, id, ctx);
}
```

- [ ] **Step 4: 运行确认通过** → `node --test test/ 2>&1 | tail -20`
- [ ] **Step 5: 提交** → `git commit -m "feat: 服务端 servers 配置接口"`

---

### 任务 3：history 接口

**Files:**
- Modify: `src/server.js`
- Test: `test/server.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
describe('服务端 history 接口', () => {
  let server, base, configDir;
  before(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-push-hcfg-'));
    ({ server, base } = await startServer({ configDir }));
  });
  after(() => server.close());

  const NAME = `${HEX32}-a.png`;
  const entry = { orig: 'a.png', targets: [{ key: 's1', label: 'A', host: '127.0.0.1', dir: '/tmp/x', remoteName: NAME, remotePath: `/tmp/x/${NAME}`, url: '', method: 'rsync', origin: 'push', time: new Date().toISOString() }] };

  test('GET 初始为空对象', async () => {
    const r = await (await fetch(`${base}/api/history`)).json();
    assert.deepEqual(r.history, {});
  });

  test('PUT 单条 upsert', async () => {
    const res = await fetch(`${base}/api/history/${encodeURIComponent(NAME)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
    });
    assert.equal(res.status, 200);
    const r = await (await fetch(`${base}/api/history`)).json();
    assert.equal(r.history[NAME].orig, 'a.png');
  });

  test('非法 name 返回 400', async () => {
    const res = await fetch(`${base}/api/history/${encodeURIComponent('../etc')}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
    });
    assert.equal(res.status, 400);
  });

  test('batch upserts + deletes', async () => {
    const N2 = `${'a'.repeat(32)}-b.png`;
    const res = await fetch(`${base}/api/history/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upserts: { [N2]: { orig: 'b.png', targets: [] } }, deletes: [NAME] }),
    });
    assert.equal(res.status, 200);
    const r = await (await fetch(`${base}/api/history`)).json();
    assert.ok(r.history[N2]);
    assert.ok(!r.history[NAME]);
  });

  test('DELETE 单条', async () => {
    const N2 = `${'a'.repeat(32)}-b.png`;
    await fetch(`${base}/api/history/${encodeURIComponent(N2)}`, { method: 'DELETE' });
    const r = await (await fetch(`${base}/api/history`)).json();
    assert.deepEqual(r.history, {});
  });

  test('重启后历史仍在（落盘 history.json）', () => {
    assert.ok(fs.existsSync(path.join(configDir, 'history.json')));
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```js
async function handleListHistory(res, ctx) {
  sendJson(res, 200, { ok: true, history: ctx.historyStore.read() });
}

async function handlePutHistory(req, res, name, ctx) {
  if (!isValidStoredName(name)) return sendJson(res, 400, { ok: false, error: 'name 不合法' });
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, error: '请求体不合法' });
  }
  if (!Array.isArray(body.targets)) return sendJson(res, 400, { ok: false, error: 'targets 必须为数组' });
  const entry = { orig: String(body.orig || ''), targets: body.targets };
  await ctx.historyStore.update((h) => { h[name] = entry; });
  sendJson(res, 200, { ok: true });
}

async function handleDeleteHistory(res, name, ctx) {
  if (!isValidStoredName(name)) return sendJson(res, 400, { ok: false, error: 'name 不合法' });
  await ctx.historyStore.update((h) => { delete h[name]; });
  sendJson(res, 200, { ok: true });
}

async function handleBatchHistory(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体不合法' });
  const upserts = body.upserts && typeof body.upserts === 'object' ? body.upserts : {};
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  await ctx.historyStore.update((h) => {
    for (const [name, entry] of Object.entries(upserts)) {
      if (isValidStoredName(name) && entry && Array.isArray(entry.targets)) h[name] = entry;
    }
    for (const name of deletes) delete h[name];
  });
  sendJson(res, 200, { ok: true });
}
```

路由（放在 servers 之后；batch 需先于 `:name` 匹配）：

```js
if (pathname === '/api/history') {
  if (req.method === 'GET') return handleListHistory(res, ctx);
}
if (pathname === '/api/history/batch' && req.method === 'POST') {
  return handleBatchHistory(req, res, ctx);
}
if (pathname.startsWith('/api/history/')) {
  const name = safeDecode(pathname.slice('/api/history/'.length));
  if (name === null) return sendJson(res, 400, { ok: false, error: '路径不合法' });
  if (req.method === 'PUT') return handlePutHistory(req, res, name, ctx);
  if (req.method === 'DELETE') return handleDeleteHistory(res, name, ctx);
}
```

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** → `git commit -m "feat: 服务端 history 记录接口"`

---

### 任务 4：页面异步启动与读写改造

**Files:**
- Modify: `src/server.js`（内嵌页面 `<script>`，约 765-2785 行）

要点（详见 spec 第 6 节）：

- [ ] 删除 `SERVERS_KEY` / `HISTORY_KEY`；`servers = []`、`history = {}`；`migrateLegacy` 只保留 `target`。
- [ ] 新增 `serverStatus = {}` 内存映射；`saveServerStatus` 改同步写内存；`renderStatus` 改读 `serverStatus[srv.id]`；编辑/删除时清除。
- [ ] 新增 `apiJson(url, opts)` 与 `loadServers/loadHistory/createServer/updateServer/deleteServer/saveHistoryEntry/deleteHistoryEntry/batchHistory`。
- [ ] 写入点改 async/await：`applyProbe`、`removeServer`、表单 submit、`recordUpload`、`reconcileWithRemote`、`reconcile`、`dropTargetRecord`、`removeFromLocal`、`cleanStale`。
- [ ] 启动改 `async function boot()`：`await Promise.all([loadServers(), loadHistory()])` → `renderTargetSel()` → `await refreshHistory()` → 探测。
- [ ] 更新 `sendIndexPage` 顶部注释中「localStorage 配置/历史」的表述。

- [ ] **Step 1: 改造页面**
- [ ] **Step 2: 手工验证**（可选）`node src/server.js`，DevTools 确认 localStorage 只剩 `snap-push@<hash>.target` / `.remoteIndex`，新增配置后 `servers.json` 出现。
- [ ] **Step 3: 提交** → `git commit -m "feat: 页面改为经服务端接口读写配置与历史"`

---

### 任务 5：更新页面沙箱测试

**Files:**
- Modify: `test/server.test.mjs`（约 10 个 `new Function` 测试）

- [ ] **Step 1: 新增辅助**

```js
// 在页面测试 fetch 垫片外层包一层：拦截 /api/servers 与 /api/history
function withStateFetch(baseShim, state) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/servers') && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, servers: state.servers || [] }) };
    }
    if (u.includes('/api/history') && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, history: state.history || {} }) };
    }
    if (u.includes('/api/servers') || u.includes('/api/history')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return baseShim(url, opts);
  };
}
```

- [ ] **Step 2: 逐个测试改造**：把 `store.set('snap-push.servers', ...)` / `store.set('snap-push.history', ...)` 改为局部变量 `servers` / `history`，用 `withStateFetch(原 fetchShim, { servers, history })` 包装；`snap-push.target` / `snap-push.remoteIndex` 保持不变。
- [ ] **Step 3: 运行** → `node --test test/ 2>&1 | tail -30` 全绿。
- [ ] **Step 4: 提交** → `git commit -m "test: 页面测试改用服务端配置/历史垫片"`

---

### 任务 6：README 双语 + 全量回归

**Files:**
- Modify: `README.md`、`README.zh-CN.md`

- [ ] **Step 1: 更新两份 README**（内容保持一致）
  - 环境变量表新增 `SNAP_PUSH_CONFIG_DIR`（默认 `~/.config/snap-push`），说明目录内 `instance-id` / `servers.json` / `history.json`。
  - HTTP 接口表新增 `/api/servers`、`/api/history` 端点。
  - FAQ「配置/历史存哪」改为服务端目录；说明浏览器只留当前目标与远端缓存。
- [ ] **Step 2: 全量回归**

```bash
node --check src/server.js && node --test test/
```

Expected: 全部通过。

- [ ] **Step 3: 提交** → `git commit -m "docs: README 同步服务端配置/数据目录说明"`

---

## 验收清单

| 验收项 | 操作 | 标准 |
|---|---|---|
| 配置持久化 | 新增/编辑/删除服务器后重启服务 | 配置仍在（`servers.json` 可见） |
| 历史持久化 | 推送后换浏览器/清缓存打开 | 同步记录仍在 |
| 浏览器仅存偏好 | DevTools localStorage | 只剩 `target`/`remoteIndex`（按实例命名空间） |
| 旧数据不迁移 | 预置旧 localStorage 后打开 | 页面为空，不读取旧键 |
| status 不落盘 | 探测后检查 `servers.json` | 无 `status` 字段 |
| 空 history 重建 | 本地+远端都有同一张图，清空 history 后切服务器目标 | 探测后自动补 `recovered` 记录 |
| 校验与错误 | 非法 host/dir、重复 id、超限 body | 返回 400/409/413，中文提示 |
| 回归 | `node --check` + `node --test` | 全部通过 |
