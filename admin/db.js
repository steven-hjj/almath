// ⭐ 本地存储抽象层 - 替代真后端,数据存 localStorage
// 同一浏览器同源跨页面共享;跨设备用 JSON 备份/恢复
// 精简版 (2026-08-26): 只保留 生产(资料/题目/翻译/已投放) + 账号 + 线索管理

const DB_KEY = 'almath_cloud_v1';

// ===== ☁️ 云同步配置(填入 JSONBin 凭据即启用跨设备互通) =====
// 注册 jsonbin.io → API Keys 页复制 Master Key → 创建一个 Bin 把 id 填下面
const CLOUD = {
  provider: 'jsonbin',
  binId: '6a9010eef5f4af5e294903aa',       // JSONBin Bin ID
  masterKey: '$2a$10$nHoUEkQRlmu0CKKBrjdCoul0BYB.7VaF/H6vTXg..Pk62rQIh/W7q'     // JSONBin X-Master-Key
};
const CLOUD_ENABLED = !!(CLOUD.binId && CLOUD.masterKey);
let _cloudPushTimer = null;
let _cloudRetryTimer = null;
let _cloudPulling = false;

function dbLoad() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function dbTable(name) {
  const db = dbLoad();
  if (!db[name]) db[name] = {};
  return db[name];
}
function dbPersist(name, table) {
  table._ts = Date.now();
  const db = dbLoad();
  db[name] = table;
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (e) {
    // localStorage 写满:清理最大的 answers 历史
    if (db.answers) {
      const sizes = Object.keys(db.answers).map(u => ({
        u, size: (db.answers[u] || []).length
      })).sort((a, b) => b.size - a.size);
      for (const s of sizes) {
        db.answers[s.u] = db.answers[s.u].slice(-200);
      }
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    }
  }
  scheduleCloudPush();
}

// ===== ☁️ 云同步实现(JSONBin,跨设备数据互通) =====
// 合并策略:accounts/leads 记录级时间戳,answers 去重并集,其余表按表级 _ts
function mergeDatabases(local, cloud) {
  const merged = {};
  const allTables = new Set([...Object.keys(local || {}), ...Object.keys(cloud || {})]);
  for (const t of allTables) {
    if (t === 'answers') { merged[t] = mergeAnswers((local||{})[t] || {}, (cloud||{})[t] || {}); continue; }
    if (t === 'accounts' || t === 'leads') {
      merged[t] = mergeTable((local||{})[t] || {}, (cloud||{})[t] || {},
        r => Date.parse(t === 'accounts' ? (r.lastLoginAt || r.joinedAt || '') : (r.updatedAt || '')) || 0);
      continue;
    }
    if (t === 'support') {
      // 客服消息按条级时间合并,师生同时发消息不丢
      merged[t] = mergeTable((local||{})[t] || {}, (cloud||{})[t] || {}, r => Date.parse(r.time || '') || 0);
      continue;
    }
    if (t === 'aiTeach') {
      // AI 讲解缓存:按记录级时间戳合并。教师端与学生端同源共享 localStorage,
      // 若按整表 _ts 覆盖,教师端的推送会把学生刚生成的讲解冲掉
      merged[t] = mergeTable((local||{})[t] || {}, (cloud||{})[t] || {}, r => r.ts || 0);
      continue;
    }
    const lt = (local||{})[t] || {}, ct = (cloud||{})[t] || {};
    merged[t] = ((ct._ts || 0) > (lt._ts || 0)) ? ct : lt;
  }
  // 墓碑(账号注销):注销时间晚于账号最后活动 → 从合并结果中剔除,防止本地旧数据复活
  const tombs = Object.assign({}, (local||{})._tombstones || {}, (cloud||{})._tombstones || {});
  for (const u of Object.keys(tombs)) {
    const tTime = Date.parse(tombs[u]) || 0;
    for (const tbl of ['accounts', 'leads']) {
      if (merged[tbl] && merged[tbl][u]) {
        const alive = Date.parse(tbl === 'accounts'
          ? (merged[tbl][u].lastLoginAt || merged[tbl][u].joinedAt || '')
          : (merged[tbl][u].updatedAt || '')) || 0;
        if (alive <= tTime) delete merged[tbl][u];
      }
    }
  }
  if (Object.keys(tombs).length) merged._tombstones = tombs;
  return merged;
}

async function pushCloud() {
  if (!CLOUD_ENABLED) return;
  if (_cloudPulling) { // 正在拉取:稍后重试而不是丢弃
    clearTimeout(_cloudRetryTimer);
    _cloudRetryTimer = setTimeout(pushCloud, 2500);
    return;
  }
  _cloudPulling = true;
  try {
    // 关键保护:push 前先拉云端合并(read-modify-write),绝不用残缺本地覆盖云端
    const gRes = await fetch('https://api.jsonbin.io/v3/b/' + CLOUD.binId + '/latest', {
      headers: { 'X-Master-Key': CLOUD.masterKey }
    });
    if (gRes.ok) {
      const wrapped = await gRes.json();
      const cloud = wrapped && wrapped.record ? wrapped.record : null;
      if (cloud && typeof cloud === 'object') {
        const merged = mergeDatabases(dbLoad(), cloud);
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
        try { window.dispatchEvent(new Event('almath-cloud-sync')); } catch(e) {}
      }
      // 云可达时推送合并后的全量库
      const pRes = await fetch('https://api.jsonbin.io/v3/b/' + CLOUD.binId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': CLOUD.masterKey },
        body: JSON.stringify(dbLoad())
      });
      if (!pRes.ok) console.warn('[almath] 云推送被拒:', pRes.status);
    }
    // 云不可达(gRes !ok):跳过本次推送,保住云端不被残缺数据覆盖
  } catch (e) { console.warn('[almath] 云同步异常:', e && e.message); }
  finally { _cloudPulling = false; }
}
function scheduleCloudPush() {
  if (!CLOUD_ENABLED) return;
  clearTimeout(_cloudPushTimer);
  _cloudPushTimer = setTimeout(pushCloud, 3000);
}
function mergeTable(localT, cloudT, recordTs) {
  // 记录级合并:每条记录取时间戳较大者
  const out = Object.assign({}, localT);
  for (const k of Object.keys(cloudT || {})) {
    if (k.startsWith('_')) continue;
    const a = out[k], b = cloudT[k];
    if (a === undefined) { out[k] = b; continue; }
    const ta = recordTs(a), tb = recordTs(b);
    if ((tb || 0) > (ta || 0)) out[k] = b;
  }
  return out;
}
function mergeAnswers(localA, cloudA) {
  // 答题记录:按用户合并数组,以 (qid+time) 去重
  const out = Object.assign({}, localA);
  for (const u of Object.keys(cloudA || {})) {
    if (u === '_ts') continue; // 跳过表级时间戳元数据
    const seen = new Set((out[u] || []).map(r => (r.qid || '') + '|' + (r.time || '')));
    const merged = (out[u] || []).slice();
    for (const r of (cloudA[u] || [])) {
      if (!r || typeof r !== 'object') continue;
      const sig = (r.qid || '') + '|' + (r.time || '');
      if (!seen.has(sig)) { merged.push(r); seen.add(sig); }
    }
    merged.sort((x, y) => (x.time || '').localeCompare(y.time || ''));
    out[u] = merged.slice(-1000);
  }
  return out;
}
async function pullCloud() {
  if (!CLOUD_ENABLED || _cloudPulling) return;
  _cloudPulling = true;
  try {
    const res = await fetch('https://api.jsonbin.io/v3/b/' + CLOUD.binId + '/latest', {
      headers: { 'X-Master-Key': CLOUD.masterKey }
    });
    if (!res.ok) return;
    const wrapped = await res.json();
    const cloud = wrapped && wrapped.record ? wrapped.record : wrapped;
    if (!cloud || typeof cloud !== 'object') return;
    const merged = mergeDatabases(dbLoad(), cloud);
    localStorage.setItem(DB_KEY, JSON.stringify(merged));
    syncLegacyAccounts(merged);
    try { window.dispatchEvent(new Event('almath-cloud-sync')); } catch(e) {}
  } catch (e) { /* 静默 */ }
  finally { _cloudPulling = false; }
}

// 云端账号 → 同步老表(phone/nick/role 以云端为准,纠正本机过期残留)
function syncLegacyAccounts(merged) {
  try {
    const acc = JSON.parse(localStorage.getItem('almath_accounts') || '{"users":{}}');
    if (!acc.users) acc.users = {};
    let changed = false;
    const accounts = merged.accounts || {};
    for (const u of Object.keys(accounts)) {
      if (u.startsWith('_')) continue;
      const c = accounts[u] || {};
      if (!acc.users[u]) {
        acc.users[u] = { pass: c.password || '', nick: c.nickname || u, phone: c.phone || '', avatar: c.avatar || '👤', role: c.role || 'student' };
        changed = true;
        continue;
      }
      if (acc.users[u].phone !== (c.phone || '')) { acc.users[u].phone = c.phone || ''; changed = true; }
      if (c.nickname && acc.users[u].nick !== c.nickname) { acc.users[u].nick = c.nickname; changed = true; }
      if (c.role && acc.users[u].role !== c.role) { acc.users[u].role = c.role; changed = true; }
    }
    if (changed) localStorage.setItem('almath_accounts', JSON.stringify(acc));
  } catch (e) {}
}

const _uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const _now = () => new Date().toISOString();

async function _sha256(s) {
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('almath$' + s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
// 老 admin.html 用过的 hash 算法(无前缀)→ 用于兼容迁移老账号
async function _legacy_sha256(s) {
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
// 老 student 端 fallback(无 crypto.subtle 时)→ 'djb2_' 前缀 + 16 进制
function _djb2WithPrefix(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'djb2_' + h.toString(16);
}
// 极老 student 端 fallback:纯 djb2 16 进制(无前缀)
function _djb2Plain(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// ===== A 客户端 =====
const A = {
  base: window.location.origin,
  get token() { return localStorage.getItem('almath_token') || ''; },
  get username() { return localStorage.getItem('almath_user') || ''; },
  get role() { return localStorage.getItem('almath_role') || 'student'; },
  setAuth(username, token, role) {
    localStorage.setItem('almath_user', username);
    localStorage.setItem('almath_token', token);
    localStorage.setItem('almath_role', role || 'student');
  },
  clearAuth() {
    localStorage.removeItem('almath_user');
    localStorage.removeItem('almath_token');
    localStorage.removeItem('almath_role');
  },

  // 教师判定:优先看存储的 role;若被误写(如学生在教师端登录),回退查账号本身的 role
  isTeacher() {
    if (this.role === 'teacher') return true;
    try {
      const db = JSON.parse(localStorage.getItem(DB_KEY) || '{}');
      const a = (db.accounts || {})[this.username];
      return !!(a && a.role === 'teacher');
    } catch (e) { return false; }
  },

  async req(method, path, body) {
    const parts = path.replace(/^\/api\//, '').split('/').filter(Boolean);
    const table = parts[0];
    const id = parts.length >= 2 ? parts[1] : undefined;
    const action = parts.length >= 3 ? parts[2] : undefined;

    // 公开端点
    const isPublic = (method === 'GET' && (table === 'published' || table === 'health' || table === 'leads'))
                   || (method === 'POST' && table === 'auth');

    if (!isPublic && (!this.token || !this.username)) {
      return null;
    }

    // 健康检查
    if (table === 'health') {
      return { ok: true, time: _now(), version: '2.0-leads', mode: 'localStorage' };
    }

    const t = dbTable(table);

    // ============ POST 路由 ============
    if (method === 'POST') {
      // 注册
      if (table === 'auth' && id === 'register' && !action) {
        const accounts = dbTable('accounts');
        if (accounts[body.username]) throw new Error('账号已存在');
        if (body.phone) {
          for (const u of Object.keys(accounts)) {
            if (accounts[u].phone === body.phone) throw new Error('手机号已注册');
          }
        }
        accounts[body.username] = {
          username: body.username,
          password: await _sha256(body.password),
          phone: body.phone || '',
          nickname: body.nickname || body.username,
          role: body.role || 'student',
          avatar: '👤',
          joinedAt: _now()
        };
        dbPersist('accounts', accounts);
        // 同步到老 almath_accounts(含 role,教师端刷新自动登录依赖它)
        try {
          const acc = JSON.parse(localStorage.getItem('almath_accounts') || '{"users":{},"registeredAt":{}}');
          if (!acc.users) acc.users = {};
          acc.users[body.username] = {
            pass: accounts[body.username].password,
            nick: body.nickname || body.username,
            phone: body.phone || '',
            avatar: '👤',
            role: accounts[body.username].role || 'student'
          };
          acc.registeredAt = acc.registeredAt || {};
          acc.registeredAt[body.username] = accounts[body.username].joinedAt;
          localStorage.setItem('almath_accounts', JSON.stringify(acc));
        } catch (e) {}
        const token = await _sha256(body.username + _now() + Math.random());
        return {
          ok: true, token,
          account: { ...accounts[body.username], password: undefined, token: undefined }
        };
      }

      // 登录
      if (table === 'auth' && id === 'login' && !action) {
        const accounts = dbTable('accounts');
        const u = accounts[body.username];
        const newHash = await _sha256(body.password);
        // 1) 新表 + 新 hash('almath$' 前缀)
        if (u && u.password === newHash) {
          const token = await _sha256(body.username + _now() + Math.random());
          accounts[body.username].token = token;
          accounts[body.username].lastLoginAt = _now();
          dbPersist('accounts', accounts);
          return { ok: true, token, account: { ...u, password: undefined, token: undefined } };
        }
        // 2) 老表 almath_accounts 兼容层:
        //    - 老 student 端注册 → hash = sha256('almath$'+pwd)  (有前缀 = newHash)
        //    - 老 student 端 fallback → 'djb2_'+djb2(pwd)
        //    - 老 admin 端注册     → hash = sha256(pwd)            (无前缀 = legacyHash)
        //    - 极老版本            → 纯 djb2(pwd) 十六进制
        try {
          const old = JSON.parse(localStorage.getItem('almath_accounts') || '{"users":{}}');
          const ou = old.users && old.users[body.username];
          if (ou) {
            const legacyHash = await _legacy_sha256(body.password);
            const djb2Prefixed = _djb2WithPrefix(body.password);
            const djb2PlainHex = _djb2Plain(body.password);
            const candidates = [newHash, legacyHash, djb2Prefixed, djb2PlainHex];
            if (candidates.includes(ou.pass)) {
              // 命中老账号,自动迁移到新表
              const newU = {
                username: body.username,
                password: newHash,
                phone: ou.phone || '',
                nickname: ou.nick || body.username,
                role: 'student',
                avatar: ou.avatar || '👤',
                joinedAt: old.registeredAt?.[body.username] || _now(),
                migratedAt: _now()
              };
              accounts[body.username] = newU;
              const token = await _sha256(body.username + _now() + Math.random());
              accounts[body.username].token = token;
              accounts[body.username].lastLoginAt = _now();
              dbPersist('accounts', accounts);
              return { ok: true, token, migrated: true, account: { ...newU, password: undefined, token: undefined } };
            }
          }
        } catch(e){}
        // 3) 失败:友好提示(技术细节仅进 console,便于开发者排查)
        let diag = '账号或密码错误。请检查后重试;如果是老账号,请在常用设备上登录,或重新注册一个新账号。';
        try {
          console.warn('[登录诊断]', JSON.stringify({
            user: body.username,
            hasLegacy: !!(JSON.parse(localStorage.getItem('almath_accounts') || '{}').users || {})[body.username],
            hasCloud: !!(JSON.parse(localStorage.getItem(DB_KEY) || '{}').accounts || {})[body.username]
          }));
        } catch (e) {}
        const err = new Error(diag);
        err.diag = diag;
        throw err;
      }

      // 完善手机号(当前登录用户): /api/profile/phone
      if (table === 'profile' && id === 'phone' && !action) {
        const accounts = dbTable('accounts');
        const me = accounts[this.username];
        if (!me) throw new Error('账号不存在');
        if (!/^1\d{10}$/.test(body.phone || '')) throw new Error('手机号格式错误');
        for (const u of Object.keys(accounts)) {
          if (u !== this.username && accounts[u].phone === body.phone) throw new Error('该手机号已被其他账号绑定');
        }
        me.phone = body.phone;
        me.phoneUpdatedAt = _now();
        dbPersist('accounts', accounts);
        // 同步老表
        try {
          const acc = JSON.parse(localStorage.getItem('almath_accounts') || '{"users":{}}');
          if (acc.users && acc.users[this.username]) acc.users[this.username].phone = body.phone;
          localStorage.setItem('almath_accounts', JSON.stringify(acc));
        } catch (e) {}
        return { ok: true, phone: body.phone };
      }

      // 咨询/反馈/赞助 意向事件
      if (table === 'intent' && !action) {
        const intents = dbTable('intents');
        if (!intents[this.username]) intents[this.username] = [];
        intents[this.username].push({
          type: body.type || 'unknown',
          detail: body.detail || '',
          time: _now()
        });
        if (intents[this.username].length > 50) intents[this.username] = intents[this.username].slice(-50);
        dbPersist('intents', intents);
        return { ok: true };
      }

      // ===== 💬 在线客服消息 =====
      // 学生发消息: /api/support (POST)
      if (table === 'support' && !id && !action) {
        const sup = dbTable('support');
        const accounts = dbTable('accounts');
        const me = accounts[this.username] || {};
        const msg = {
          id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          username: this.username,
          nickname: me.nickname || this.username,
          from: this.role === 'teacher' ? 'teacher' : 'student',
          text: String(body.text || '').slice(0, 800),
          time: _now(),
          readT: false,   // 教师已读?
          readS: false    // 学生已读?
        };
        if (!msg.text.trim()) throw new Error('消息不能为空');
        sup[msg.id] = msg;
        // 同一会话最多保留 200 条
        const mine = Object.values(sup).filter(m => m && m.id && m.username === this.username);
        if (mine.length > 200) {
          mine.sort((a, b) => a.time.localeCompare(b.time));
          for (const old of mine.slice(0, mine.length - 200)) delete sup[old.id];
        }
        dbPersist('support', sup);
        return { ok: true };
      }
      // 教师回复某用户: /api/support/<username>/reply
      if (table === 'support' && id && action === 'reply') {
        if (!this.isTeacher()) throw new Error('无权');
        const sup = dbTable('support');
        const accounts = dbTable('accounts');
        const me = accounts[this.username] || {};
        const msg = {
          id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          username: id,
          nickname: me.nickname || this.username,
          from: 'teacher',
          text: String(body.text || '').slice(0, 800),
          time: _now(),
          readT: true,
          readS: false
        };
        if (!msg.text.trim()) throw new Error('消息不能为空');
        sup[msg.id] = msg;
        dbPersist('support', sup);
        return { ok: true };
      }
      // 教师标记已读: /api/support/<username>/read
      if (table === 'support' && id && action === 'read') {
        if (!this.isTeacher()) throw new Error('无权');
        const sup = dbTable('support');
        let n = 0;
        for (const k of Object.keys(sup)) {
          const m = sup[k];
          if (k.startsWith('_') || !m || !m.id) continue;
          if (m.username === id && m.from === 'student' && !m.readT) { m.readT = true; n++; }
        }
        if (n > 0) dbPersist('support', sup);
        return { ok: true, marked: n };
      }

      // 线索状态更新 (teacher only)
      if (table === 'leads' && id && (!action || action === 'status' || action === 'note' || action === 'priority')) {
        if (!this.isTeacher()) throw new Error('无权');
        const leads = dbTable('leads');
        if (!leads[id]) leads[id] = { username: id, status: 'pending', note: '', priority: 'normal', updatedAt: _now() };
        if (action === 'status') leads[id].status = body.status;
        if (action === 'note')   leads[id].note   = body.note;
        if (action === 'priority') leads[id].priority = body.priority;
        leads[id].updatedAt = _now();
        leads[id].operator  = this.username;
        dbPersist('leads', leads);
        return { ok: true, lead: leads[id] };
      }

      // 答题记录 (答题练习时使用)
      if (table === 'answers' && !action) {
        const ans = dbTable('answers');
        if (!ans[this.username]) ans[this.username] = [];
        ans[this.username].push({
          qid: body.qid, subject: body.subject, chapter: body.chapter,
          isCorrect: !!body.isCorrect, durationMs: body.durationMs || 0,
          source: body.source || 'practice', time: _now()
        });
        if (ans[this.username].length > 1000) ans[this.username] = ans[this.username].slice(-1000);
        dbPersist('answers', ans);
        return { ok: true };
      }

      return { ok: true };
    }

    // ============ DELETE 路由 ============
    if (method === 'DELETE') {
      // 线索删除
      if (table === 'leads' && id) {
        if (!this.isTeacher()) throw new Error('无权');
        const leads = dbTable('leads');
        delete leads[id];
        dbPersist('leads', leads);
        return { ok: true };
      }
      return { ok: true };
    }

    // ============ GET 路由 ============
    if (method === 'GET') {
      // 💬 客服消息
      // 学生取自己的会话: /api/support
      // 教师取全部会话列表: /api/support ; 教师取某用户对话: /api/support/<username>
      if (table === 'support') {
        const sup = dbTable('support');
        const all = Object.keys(sup).filter(k => !k.startsWith('_')).map(k => sup[k]).filter(m => m && m.id && m.text);
        if (!this.isTeacher()) {
          const mine = all.filter(m => m.username === this.username).sort((a, b) => a.time.localeCompare(b.time));
          return { messages: mine };
        }
        if (!id) {
          // 会话列表:按用户分组,最近一条在前,未读数统计
          const accounts = dbTable('accounts');
          const byUser = {};
          for (const m of all) {
            if (!byUser[m.username]) byUser[m.username] = [];
            byUser[m.username].push(m);
          }
          const threads = Object.keys(byUser).map(u => {
            const msgs = byUser[u].sort((a, b) => a.time.localeCompare(b.time));
            const last = msgs[msgs.length - 1];
            const a = accounts[u] || {};
            return {
              username: u,
              nickname: a.nickname || u,
              phone: a.phone || '',
              avatar: a.avatar || '👤',
              total: msgs.length,
              unread: msgs.filter(m => m.from === 'student' && !m.readT).length,
              lastText: last ? last.text : '',
              lastTime: last ? last.time : null,
              lastFrom: last ? last.from : null
            };
          }).sort((x, y) => {
            if (x.unread !== y.unread) return y.unread - x.unread;
            return (y.lastTime || '').localeCompare(x.lastTime || '');
          });
          return { threads, unreadTotal: threads.reduce((s, t) => s + t.unread, 0) };
        }
        const msgs = all.filter(m => m.username === id).sort((a, b) => a.time.localeCompare(b.time));
        return { username: id, messages: msgs };
      }
      // 线索列表 (teacher only)
      if (table === 'leads' && !id) {
        if (!this.isTeacher()) return null;
        const accounts = dbTable('accounts');
        const leads = dbTable('leads');
        const intents = dbTable('intents');
        const answers = dbTable('answers');
        const list = [];
        for (const username of Object.keys(accounts)) {
          if (username.startsWith('_')) continue; // 跳过 _ts 等元数据
          const a = accounts[username] || {};
          if (!a.username) continue;
          const l = leads[username] || { status: 'pending', note: '', priority: 'normal' };
          // 学习画像(视奸模式):从云端 answers 统计
          const ua = answers[username] || [];
          const totalAns = ua.length;
          const correctAns = ua.filter(x => x.isCorrect).length;
          const lastAnswerAt = totalAns ? ua[totalAns - 1].time : null;
          const intentList = intents[username] || [];
          const lastIntentAt = intentList.length ? intentList[intentList.length - 1].time : null;
          list.push({
            username: a.username,
            nickname: a.nickname,
            phone: a.phone || '',
            role: a.role,
            avatar: a.avatar,
            joinedAt: a.joinedAt,
            lastLoginAt: a.lastLoginAt || null,
            status: l.status,
            note: l.note,
            priority: l.priority,
            updatedAt: l.updatedAt || null,
            operator: l.operator || null,
            // 画像字段
            answerTotal: totalAns,
            accuracy: totalAns ? Math.round(correctAns / totalAns * 100) : null,
            lastAnswerAt: lastAnswerAt,
            intentTypes: [...new Set(intentList.map(x => x.type))],
            intentCount: intentList.length,
            lastIntentAt: lastIntentAt,
            hasIntent: intentList.length > 0
          });
        }
        list.sort((x, y) => {
          // 有咨询意向 > 待跟进 > 已处理,再按注册时间倒序
          if (x.hasIntent !== y.hasIntent) return x.hasIntent ? -1 : 1;
          if ((x.status === 'pending') !== (y.status === 'pending')) {
            return x.status === 'pending' ? -1 : 1;
          }
          return (y.joinedAt || '').localeCompare(x.joinedAt || '');
        });
        // 汇总统计
        const total = list.length;
        const students = list.filter(x => x.role === 'student').length;
        const teachers = list.filter(x => x.role === 'teacher').length;
        const contacted = list.filter(x => x.status === 'contacted' || x.status === 'closed').length;
        const pending = list.filter(x => x.status === 'pending').length;
        const phones = list.filter(x => x.phone).length;
        const withIntent = list.filter(x => x.hasIntent).length;
        return { list, stats: { total, students, teachers, contacted, pending, phones, withIntent } };
      }

      // 线索单条
      if (table === 'leads' && id) {
        if (!this.isTeacher()) return null;
        if (String(id).startsWith('_')) return null;
        const accounts = dbTable('accounts');
        const leads = dbTable('leads');
        const a = accounts[id];
        if (!a) return null;
        const l = leads[id] || { status: 'pending', note: '', priority: 'normal' };
        return {
          username: a.username, nickname: a.nickname, phone: a.phone || '',
          role: a.role, avatar: a.avatar, joinedAt: a.joinedAt,
          lastLoginAt: a.lastLoginAt || null,
          status: l.status, note: l.note, priority: l.priority,
          updatedAt: l.updatedAt || null, operator: l.operator || null
        };
      }

      // 兼容老:answers 拉取
      if (table === 'answers' && !id) {
        return dbTable('answers');
      }

      // 默认:返回整张表(其他资源操作交由前端)
      return t;
    }

    return { ok: false, error: 'unsupported' };
  }
};

// 启动云同步:立即拉取 + 每 30 秒轮询(教师端能实时看到新学生注册)
if (CLOUD_ENABLED) {
  pullCloud();
  setInterval(pullCloud, 30000);
}

// 暴露到全局
window.A = A;
