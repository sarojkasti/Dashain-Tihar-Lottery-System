import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { audit, transaction } from './core.js';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const lifetime = 8 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const cookieName = 'festival_session';
export const roles = ['administrator', 'operator', 'viewer'];
export function fail(message, status = 400) { const error = Error(message); error.status = status; throw error; }
export function initAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('administrator','operator','viewer')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    must_change_password INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);`);
}
export function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, role: user.role,
    active: Boolean(user.active), mustChangePassword: Boolean(user.must_change_password), created: user.created };
}
export function validateUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) fail('Username must be 3–40 letters, numbers, dots, underscores or hyphens.');
  return username;
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail('Use a password between 12 and 128 characters.');
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, options);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
const dummyHash = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
export async function verifyPassword(password, hash = dummyHash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [, salt, encoded] = hash.split(':');
  const key = await derive(password, salt, 64, options);
  return timingSafeEqual(key, Buffer.from(encoded, 'hex'));
}
function tokenFrom(req) {
  return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
}
export function sessionFor(db, req) {
  const token = tokenFrom(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT u.*, s.csrf, s.token_hash, s.expires FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.active=1`).get(digest(token), Date.now()) || null;
}
function setCookie(res, token, seconds) {
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
}
export function createSession(db, user, res) {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(digest(token), user.id, csrf, Date.now() + lifetime);
  setCookie(res, token, lifetime / 1000);
  return { user: publicUser(user), csrf };
}
export function logout(db, req, res) {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(tokenFrom(req)));
  setCookie(res, '', 0);
}
export function requireCsrf(req, user) {
  if (req.headers['x-csrf-token'] !== user.csrf) fail('Session verification failed. Reload the page.', 403);
}
export function checkLoginLimit(db, ip, username) {
  db.prepare('DELETE FROM login_attempts WHERE expires<=?').run(Date.now());
  const keys = [`ip:${ip}`, `user:${username}`];
  for (const [index, key] of keys.entries()) {
    const entry = db.prepare('SELECT attempts FROM login_attempts WHERE key=?').get(key);
    if (entry?.attempts >= (index === 0 ? 30 : 10)) fail('Too many sign-in attempts. Try again in 15 minutes.', 429);
  }
  for (const key of keys) db.prepare(`INSERT INTO login_attempts(key,attempts,expires) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=attempts+1`).run(key, Date.now() + 15 * 60 * 1000);
}
export async function saveUser(db, data, actingUser) {
  const id = Number(data.id || 0), username = validateUsername(data.username);
  const name = String(data.name || '').trim();
  if (!name || name.length > 100 || !roles.includes(data.role)) fail('Provide a name and a valid role.');
  if (typeof data.active !== 'boolean') fail('Choose whether the account is active.');
  const passwordHash = data.password ? await hashPassword(data.password) : null;
  return transaction(db, () => {
    // Recheck after asynchronous password hashing in case another admin revoked access.
    const actor = db.prepare('SELECT role,active,password_hash,must_change_password FROM users WHERE id=?').get(actingUser.id);
    if (!actor?.active || actor.role !== 'administrator' || actor.must_change_password || actor.password_hash !== actingUser.password_hash) fail('Administrator access required.', 403);
    const current = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null;
    if (id && !current) fail('User not found.', 404);
    if (!id && !passwordHash) fail('A temporary password is required for new users.');
    if (current && current.username !== username) fail('Usernames cannot be changed.');
    if (id === actingUser.id && (!data.active || data.role !== 'administrator')) fail('You cannot disable or demote your own account.');
    if (current?.role === 'administrator' && current.active && (!data.active || data.role !== 'administrator') &&
      db.prepare("SELECT COUNT(*) n FROM users WHERE role='administrator' AND active=1").get().n <= 1) fail('Keep at least one active administrator.');
    if (db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(username, id)) fail('That username is already in use.');
    let userId = id;
    if (current) {
      db.prepare('UPDATE users SET name=?,role=?,active=? WHERE id=?').run(name, data.role, Number(data.active), id);
      if (passwordHash) db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(passwordHash, id);
      if (passwordHash || current.role !== data.role || current.active !== Number(data.active)) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    } else {
      userId = Number(db.prepare('INSERT INTO users(username,name,password_hash,role,active) VALUES(?,?,?,?,?)')
        .run(username, name, passwordHash, data.role, Number(data.active)).lastInsertRowid);
    }
    audit(db, null, current ? 'user updated' : 'user created', JSON.stringify({id:userId, username, name, role:data.role, active:data.active,
      passwordReset:Boolean(current && passwordHash), previous:current ? {name:current.name,role:current.role,active:Boolean(current.active)} : undefined}));
    return { id: userId };
  });
}
