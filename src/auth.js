'use strict';
// Authentication: email/password (bcrypt) + optional Google/GitHub OAuth.
// Sessions are opaque tokens in httpOnly cookies, sha256-hashed at rest,
// 7-day expiry. OAuth is enabled only when provider env vars are set —
// pure offline deployments use email auth and the buttons stay hidden.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('./db');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'swaraj_sid';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function providers() {
  return {
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  };
}

function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
}

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, provider: row.provider, created_at: row.created_at };
}

async function register({ email, password, name = '' }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  if (String(password || '').length < 8) throw Object.assign(new Error('Password needs at least 8 characters.'), { status: 400 });
  const hash = await bcrypt.hash(String(password), 10);
  try {
    const { rows } = await getPool().query(
      'INSERT INTO users (email, password_hash, name, provider) VALUES ($1,$2,$3,\'email\') RETURNING *',
      [email, hash, String(name || '').slice(0, 120)]);
    return publicUser(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw Object.assign(new Error('That email is already registered — try logging in.'), { status: 409 });
    throw e;
  }
}

async function login({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const { rows } = await getPool().query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(String(password || ''), u.password_hash))) {
    throw Object.assign(new Error('Wrong email or password.'), { status: 401 });
  }
  return publicUser(u);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await getPool().query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,NOW() + INTERVAL \'7 days\')', [tokenHash, userId]);
  return token;
}

async function userFromToken(token) {
  if (!token) return null;
  const h = crypto.createHash('sha256').update(String(token)).digest('hex');
  const { rows } = await getPool().query(
    'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > NOW()', [h]);
  return rows[0] ? publicUser(rows[0]) : null;
}

async function destroySession(token) {
  if (!token) return;
  const h = crypto.createHash('sha256').update(String(token)).digest('hex');
  await getPool().query('DELETE FROM sessions WHERE token_hash=$1', [h]);
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function clearCookie() {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
function readCookie(req) {
  const m = /swaraj_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

// ---- OAuth (Google + GitHub). Requires internet + registered OAuth app. ----
const oauthState = new Map(); // state -> { provider, ts }

function oauthStart(provider) {
  const p = providers();
  if (!p[provider]) throw Object.assign(new Error(`${provider} login is not configured on this server.`), { status: 501 });
  const state = crypto.randomBytes(16).toString('hex');
  oauthState.set(state, { provider, ts: Date.now() });
  const cb = `${baseUrl()}/api/auth/${provider}/callback`;
  if (provider === 'google') {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: cb,
      response_type: 'code', scope: 'openid email profile', state,
    });
  }
  return 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: cb, scope: 'user:email', state,
  });
}

async function oauthCallback(provider, { code, state }) {
  const rec = oauthState.get(state);
  oauthState.delete(state);
  if (!rec || rec.provider !== provider || Date.now() - rec.ts > 10 * 60 * 1000) {
    throw Object.assign(new Error('Login session expired — please try again.'), { status: 400 });
  }
  if (!code) throw Object.assign(new Error('Login was not approved.'), { status: 400 });
  const cb = `${baseUrl()}/api/auth/${provider}/callback`;
  let email, name, providerId;
  if (provider === 'google') {
    const t = await (await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: cb, grant_type: 'authorization_code' }),
    })).json();
    if (!t.access_token) throw Object.assign(new Error('Google did not return a token.'), { status: 502 });
    const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    if (!u.email) throw Object.assign(new Error('Google did not share an email.'), { status: 502 });
    email = u.email.toLowerCase(); name = u.name || ''; providerId = u.sub;
  } else {
    const t = await (await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri: cb }),
    })).json();
    if (!t.access_token) throw Object.assign(new Error('GitHub did not return a token.'), { status: 502 });
    const h = { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'swaraj-ai' };
    const u = await (await fetch('https://api.github.com/user', { headers: h })).json();
    const emails = await (await fetch('https://api.github.com/user/emails', { headers: h })).json();
    email = (Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0]) : null)?.email?.toLowerCase()
      || (u.email || '').toLowerCase();
    if (!email) throw Object.assign(new Error('GitHub did not share a verified email.'), { status: 502 });
    name = u.name || u.login || ''; providerId = String(u.id);
  }
  const pool = getPool();
  let user = (await pool.query('SELECT * FROM users WHERE provider=$1 AND provider_id=$2', [provider, providerId])).rows[0];
  if (!user) {
    try {
      user = (await pool.query(
        'INSERT INTO users (email, name, provider, provider_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [email, String(name).slice(0, 120), provider, providerId])).rows[0];
    } catch (e) {
      if (e.code === '23505') {
        // Email already registered another way — link provider to it.
        user = (await pool.query('UPDATE users SET provider=$1, provider_id=$2 WHERE email=$3 RETURNING *', [provider, providerId, email])).rows[0];
      } else throw e;
    }
  }
  return publicUser(user);
}

module.exports = { providers, register, login, createSession, userFromToken, destroySession, sessionCookie, clearCookie, readCookie, oauthStart, oauthCallback, COOKIE };
