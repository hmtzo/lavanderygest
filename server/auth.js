// Autenticação — users + sessions com cookie httpOnly
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const SESSION_COOKIE = 'lvs';
const SESSION_DAYS = 30;

export function setupAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'gestor',   -- admin | gestor | tecnico
    active INTEGER DEFAULT 1,
    last_login_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT, user_agent TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);

  // Seed admin inicial + migrar técnicos existentes (idempotente)
  const hasAdmin = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c > 0;
  if (!hasAdmin) {
    const defaultPass = process.env.SEED_ADMIN_PASS || 'lavandery2026';
    const hash = bcrypt.hashSync(defaultPass, 10);
    db.prepare(`INSERT INTO users (id,email,password_hash,name,role) VALUES (?,?,?,?,?)`)
      .run('u_admin', 'admin@lavandery.com.br', hash, 'Administrador', 'admin');
    console.log('[auth] admin seed: admin@lavandery.com.br · senha:', defaultPass);
  }
  // Cria users a partir de technicians (para login do app mobile)
  try {
    const techs = db.prepare('SELECT id, email, name, pin FROM technicians').all();
    const upsert = db.prepare(`INSERT INTO users (id, email, password_hash, name, role)
      VALUES (?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name=excluded.name WHERE users.role='tecnico'`);
    for (const t of techs) {
      if (!t.email) continue;
      const pass = t.pin || '1234';
      upsert.run('u_' + t.id.replace(/[^a-z0-9]/gi,''), t.email, bcrypt.hashSync(pass, 10), t.name, 'tecnico');
    }
  } catch(e) { /* technicians table pode não existir ainda */ }
}

function parseCookies(req) {
  const cookie = req.headers.cookie || '';
  const map = {};
  cookie.split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) map[k] = decodeURIComponent((v.join('=') || '').trim());
  });
  return map;
}

export function authMiddleware(db) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return next();
    const s = db.prepare('SELECT s.user_id, s.expires_at, u.email, u.name, u.role, u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(token);
    if (!s || !s.active) return next();
    if (s.expires_at && s.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return next();
    }
    req.user = { id: s.user_id, email: s.email, name: s.name, role: s.role };
    next();
  };
}

export function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (roles.length && !roles.includes(req.user.role) && !roles.includes('*')) {
      return res.status(403).json({ error: 'forbidden', required: roles });
    }
    next();
  };
}

export function authRoutes(app, db) {
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
    // rate limiting simples: máx 10 falhas/min por email
    const failKey = 'login:' + email.toLowerCase();
    const now = Date.now();
    rateTrim(failKey);
    if (rateCount(failKey) >= 10) return res.status(429).json({ error: 'too_many_attempts' });

    const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email.toLowerCase());
    if (!user) { rateAdd(failKey); return res.status(401).json({ error: 'invalid' }); }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) { rateAdd(failKey); return res.status(401).json({ error: 'invalid' }); }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = now + SESSION_DAYS * 86400_000;
    db.prepare('INSERT INTO sessions (token,user_id,ip,user_agent,expires_at) VALUES (?,?,?,?,?)').run(token, user.id, req.ip, req.headers['user-agent']||'', expires);
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now, user.id);

    const isProd = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS*86400}${isProd?'; Secure':''}`);
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    res.json({ user: req.user });
  });

  app.post('/api/auth/change-password', async (req, res) => {
    if (!req.user) return res.status(401).json({ error:'unauthorized' });
    const { current, next: newPass } = req.body || {};
    if (!current || !newPass || newPass.length < 6) return res.status(400).json({ error:'invalid_input' });
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
    const ok = await bcrypt.compare(current, user.password_hash);
    if (!ok) return res.status(401).json({ error:'wrong_current' });
    const hash = await bcrypt.hash(newPass, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.user.id);
    res.json({ ok:true });
  });

  // Users management (admin only)
  app.get('/api/users', (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error:'forbidden' });
    res.json(db.prepare('SELECT id,email,name,role,active,last_login_at,created_at FROM users ORDER BY created_at DESC').all());
  });
  app.post('/api/users', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error:'forbidden' });
    const { email, password, name, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ error:'missing' });
    const hash = await bcrypt.hash(password, 10);
    const id = 'u_' + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO users (id,email,password_hash,name,role) VALUES (?,?,?,?,?)').run(id, email.toLowerCase(), hash, name||'', role||'gestor');
    res.json({ ok:true, id });
  });
  app.patch('/api/users/:id', async (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error:'forbidden' });
    const b = req.body || {};
    const sets = [], args = [];
    if (b.name !== undefined) { sets.push('name=?'); args.push(b.name); }
    if (b.role !== undefined) { sets.push('role=?'); args.push(b.role); }
    if (b.active !== undefined) { sets.push('active=?'); args.push(b.active?1:0); }
    if (b.password) { sets.push('password_hash=?'); args.push(await bcrypt.hash(b.password, 10)); }
    if (!sets.length) return res.json({ ok:true });
    args.push(req.params.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args);
    res.json({ ok:true });
  });
  app.delete('/api/users/:id', (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error:'forbidden' });
    if (req.params.id === req.user.id) return res.status(400).json({ error:'cannot_delete_self' });
    db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  });
}

// Rate limiting simples em memória (pra prod real use Redis)
const rateMap = new Map();
function rateAdd(k) {
  const arr = rateMap.get(k) || [];
  arr.push(Date.now());
  rateMap.set(k, arr);
}
function rateCount(k) { return (rateMap.get(k) || []).length; }
function rateTrim(k) {
  const cutoff = Date.now() - 60_000;
  const arr = (rateMap.get(k) || []).filter(t => t > cutoff);
  rateMap.set(k, arr);
}

export const PUBLIC_PATHS = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/login\.html$/,
  /^\/chamado\.html$/,
  /^\/implantacao\.html$/,
  /^\/styles\.css$/,
  /^\/design\.css$/,
  /^\/logo\.svg$/,
  /^\/app\.js$/,
  /^\/favicon/,
  /^\/health$/,
  /^\/api\/auth\//,
  /^\/api\/public\//,
  /^\/api\/webhooks\/incoming\//,
  /^\/api\/public\/calendar\.ics/,
];

export function publicMiddleware() {
  return (req, res, next) => {
    // Marca req.isPublic se path for público
    req.isPublic = PUBLIC_PATHS.some(rx => rx.test(req.path));
    next();
  };
}
