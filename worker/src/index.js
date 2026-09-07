/**
 * Ink Worker — the server half of Ink (ink.jacobsiler.com).
 *
 * Responsibilities
 *  - Verify Firebase ID tokens for the app and read/write Firestore with a service account
 *  - Send campaigns through Resend in batches (resumable jobs, continued by cron)
 *  - Public endpoints: hosted join page, embed script, confirm, unsubscribe, one-click approve
 *  - Resend webhooks → per-recipient + per-campaign + per-subscriber stats
 *  - Gemini: draft / subject lines / polish / plan / insights
 *  - Cron: scheduled sends, welcome automations, plan nudges (auto-drafts + approval emails),
 *          48-hour campaign reports, quiet-list reminders
 *
 * Secrets (wrangler secret put …): FIREBASE_SERVICE_ACCOUNT, RESEND_API_KEY,
 *   RESEND_WEBHOOK_SECRET, GEMINI_API_KEY, INK_SIGNING_SECRET
 * Vars (wrangler.toml): FIREBASE_PROJECT_ID, FIREBASE_WEB_API_KEY, GEMINI_MODEL,
 *   INK_FROM_DOMAIN, APP_URL, PUBLIC_URL
 */
import '../../shared/render.js';
import '../../shared/templates.js';

const Render = globalThis.InkRender;
const Templates = globalThis.InkTemplates;

// ───────────────────────────────────────────────────────────── utilities ──

const enc = new TextEncoder();
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => { throw new HttpError(400, m); };
const nowIso = () => new Date().toISOString();
const addDays = (iso, d) => new Date(new Date(iso).getTime() + d * 864e5).toISOString();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(enc.encode(s));
const fromB64url = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s); };
const randomToken = (n = 24) => b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
const escapeHtml = Render.escapeHtml;
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || '');

async function sha256b64(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
export async function subscriberId(email) { return (await sha256b64(String(email).trim().toLowerCase())).slice(0, 20); }

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Signed, self-contained tokens (no storage): payload.signature
async function signToken(env, payload) {
  const p = b64urlStr(JSON.stringify(payload));
  return p + '.' + (await hmac(env.INK_SIGNING_SECRET, p)).slice(0, 32);
}
async function verifyToken(env, token) {
  const [p, sig] = String(token || '').split('.');
  if (!p || !sig) return null;
  const expect = (await hmac(env.INK_SIGNING_SECRET, p)).slice(0, 32);
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(fromB64url(p));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
async function unsubToken(env, uid, sid) { return (await hmac(env.INK_SIGNING_SECRET, `unsub:${uid}:${sid}`)).slice(0, 24); }
function unsubUrl(env, uid, sid, token, cid) { return `${env.PUBLIC_URL}/u/${uid}/${sid}/${token}${cid ? '?c=' + encodeURIComponent(cid) : ''}`; }

function tzDate(iso, tz) {
  try { return new Date(iso).toLocaleDateString('en-IE', { timeZone: tz || 'UTC', weekday: 'long', day: 'numeric', month: 'long' }); }
  catch { return iso.slice(0, 10); }
}
// ISO for HH:00 local time on the given local date (yyyy-mm-dd) in tz. Approximate via offset probe.
function localDateTimeToIso(dateStr, hour, tz) {
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(guess).map(p => [p.type, p.value]));
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    const offset = asIfUtc - guess.getTime();
    return new Date(guess.getTime() - offset).toISOString();
  } catch { return guess.toISOString(); }
}
function todayIn(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return nowIso().slice(0, 10); }
}

// ──────────────────────────────────────────────────── Firestore (REST) ──

let saToken = null; // { token, exp }
function pemToArrayBuffer(pem) {
  const b = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
// The service-account JSON can be supplied raw (FIREBASE_SERVICE_ACCOUNT) or base64-encoded
// (FIREBASE_SERVICE_ACCOUNT_B64 — safer: no quotes to lose in shells or .env parsers).
function loadServiceAccount(env) {
  let raw = '';
  if (env.FIREBASE_SERVICE_ACCOUNT_B64) { try { raw = atob(String(env.FIREBASE_SERVICE_ACCOUNT_B64).replace(/\s+/g, '')); } catch { throw new HttpError(503, 'FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64. Re-run worker\\push-secrets.cmd with service-account.json in the worker folder.'); } }
  else raw = String(env.FIREBASE_SERVICE_ACCOUNT || '');
  let sa;
  try { sa = JSON.parse(raw); } catch {
    throw new HttpError(503, `FIREBASE_SERVICE_ACCOUNT is not valid JSON (stored value starts with "${raw.slice(0, 12)}"). Easiest fix: save the Firebase service-account JSON as worker\\service-account.json and run worker\\push-secrets.cmd — it uploads it safely as FIREBASE_SERVICE_ACCOUNT_B64.`);
  }
  if (!sa.client_email || !sa.private_key) throw new HttpError(503, 'FIREBASE_SERVICE_ACCOUNT JSON is missing client_email/private_key — make sure it is the key file from Firebase > Project settings > Service accounts.');
  return sa;
}

async function serviceToken(env) {
  if (saToken && saToken.exp > Date.now() + 60e3) return saToken.token;
  const sa = loadServiceAccount(env);
  const iat = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlStr(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`)));
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claims}.${sig}`
  });
  if (!res.ok) throw new Error('Service account token failed: ' + (await res.text()));
  const data = await res.json();
  saToken = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return saToken.token;
}

export function fsEncode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEncode) } };
  if (typeof v === 'object') return { mapValue: { fields: fsEncodeFields(v) } };
  return { stringValue: String(v) };
}
export function fsEncodeFields(obj) { const f = {}; for (const k of Object.keys(obj)) if (obj[k] !== undefined) f[k] = fsEncode(obj[k]); return f; }
export function fsDecode(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in v) return fsDecodeFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
export function fsDecodeFields(fields) { const o = {}; for (const k of Object.keys(fields || {})) o[k] = fsDecode(fields[k]); return o; }

class Firestore {
  constructor(env) { this.env = env; this.base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`; this.docRoot = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`; }
  async req(method, url, body) {
    const token = await serviceToken(this.env);
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore ${method} ${url.replace(this.base, '')} → ${res.status}: ${await res.text()}`);
    return res.json();
  }
  docFromApi(d) { if (!d || !d.name) return null; const o = fsDecodeFields(d.fields); o.id = d.name.split('/').pop(); o._path = d.name.replace(this.docRoot + '/', ''); o._name = d.name; return o; }
  async get(path) { return this.docFromApi(await this.req('GET', `${this.base}/${path}`)); }
  async set(path, data, merge = true) {
    const url = new URL(`${this.base}/${path}`);
    if (merge) for (const k of Object.keys(data)) if (data[k] !== undefined) url.searchParams.append('updateMask.fieldPaths', k);
    return this.docFromApi(await this.req('PATCH', url.toString(), { fields: fsEncodeFields(data) }));
  }
  // Update nested paths like {'stats.sent': 3}
  async updatePaths(path, updates) {
    const url = new URL(`${this.base}/${path}`);
    const root = {};
    for (const k of Object.keys(updates)) {
      url.searchParams.append('updateMask.fieldPaths', k);
      const parts = k.split('.'); let o = root;
      parts.forEach((p, i) => { if (i === parts.length - 1) o[p] = updates[k]; else o = (o[p] = o[p] || {}); });
    }
    return this.docFromApi(await this.req('PATCH', url.toString(), { fields: fsEncodeFields(root) }));
  }
  async delete(path) { return this.req('DELETE', `${this.base}/${path}`); }
  async increment(path, fields) {
    const write = { transform: { document: `${this.docRoot}/${path}`, fieldTransforms: Object.keys(fields).map(fp => ({ fieldPath: fp, increment: { integerValue: String(fields[fp]) } })) } };
    // Make sure the document exists first (transforms fail on missing docs)
    return this.commit([{ update: { name: `${this.docRoot}/${path}`, fields: {} }, updateMask: { fieldPaths: [] } }, write]);
  }
  async commit(writes) { return this.req('POST', `${this.base}:commit`, { writes }); }
  async batchGet(paths) {
    const out = [];
    for (let i = 0; i < paths.length; i += 300) {
      const rows = await this.req('POST', `${this.base}:batchGet`, { documents: paths.slice(i, i + 300).map(p => `${this.docRoot}/${p}`) });
      for (const r of rows || []) if (r.found) out.push(this.docFromApi(r.found));
    }
    return out;
  }
  writeSet(path, data, merge = true) {
    const w = { update: { name: `${this.docRoot}/${path}`, fields: fsEncodeFields(data) } };
    if (merge) w.updateMask = { fieldPaths: Object.keys(data).filter(k => data[k] !== undefined) };
    return w;
  }
  writeDelete(path) { return { delete: `${this.docRoot}/${path}` }; }
  async commitChunked(writes) { for (let i = 0; i < writes.length; i += 400) await this.commit(writes.slice(i, i + 400)); }
  /** query(parentPath|null, collectionId, { where:[[field,op,value]], orderBy:[[field,dir]], limit, startAfter:[values], allDescendants }) */
  async query(parent, collectionId, opts = {}) {
    const sq = { from: [{ collectionId, allDescendants: !!opts.allDescendants }] };
    if (opts.where && opts.where.length) {
      const filters = opts.where.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: OPS[op] || op, value: fsEncode(value) } }));
      sq.where = filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } };
    }
    if (opts.orderBy) sq.orderBy = opts.orderBy.map(([f, d]) => ({ field: { fieldPath: f }, direction: d === 'desc' ? 'DESCENDING' : 'ASCENDING' }));
    if (opts.limit) sq.limit = opts.limit;
    if (opts.startAfter) sq.startAt = { values: opts.startAfter.map(v => (v && typeof v === 'object' && v.referenceValue) ? v : fsEncode(v)), before: false };
    const url = `${this.base}${parent ? '/' + parent : ''}:runQuery`;
    const rows = await this.req('POST', url, { structuredQuery: sq });
    return (rows || []).filter(r => r.document).map(r => this.docFromApi(r.document));
  }
}
const OPS = { '==': 'EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', '!=': 'NOT_EQUAL', 'in': 'IN', 'array-contains': 'ARRAY_CONTAINS', 'array-contains-any': 'ARRAY_CONTAINS_ANY' };

// ─────────────────────────────────────────────────────────── Firebase auth ──

const tokenCache = new Map();
async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!idToken) throw new HttpError(401, 'Sign in required');
  const cached = tokenCache.get(idToken);
  if (cached && cached.exp > Date.now()) return cached.user;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if (!res.ok) throw new HttpError(401, 'Invalid or expired session — please sign in again');
  const data = await res.json();
  const u = data.users && data.users[0];
  if (!u) throw new HttpError(401, 'Invalid session');
  const user = { uid: u.localId, email: u.email, name: u.displayName || '' };
  tokenCache.set(idToken, { user, exp: Date.now() + 5 * 60e3 });
  if (tokenCache.size > 500) tokenCache.clear();
  return user;
}

// ───────────────────────────────────────────────────────────────── Resend ──

async function resend(env, path, body, method = 'POST') {
  const res = await fetch(`https://api.resend.com${path}`, {
    method, headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Resend ${path} → ${res.status}: ${data.message || text}`);
  return data;
}
function fromAddress(env, author) {
  const local = (author.fromLocal || author.slug || 'author').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const domain = author.customDomain && author.customDomain.status === 'verified' ? author.customDomain.domain : env.INK_FROM_DOMAIN;
  return `${(author.fromName || author.penName || 'Author').replace(/["<>]/g, '')} <${local}@${domain}>`;
}
function inkFrom(env) { return `Ink <ink@${env.INK_FROM_DOMAIN}>`; }

// ───────────────────────────────────────────────────────────────── Gemini ──

async function gemini(env, { system, prompt, jsonSchema, temperature = 0.8 }) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 4096 }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (jsonSchema) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseSchema = jsonSchema; }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('') || '';
  if (!jsonSchema) return text;
  try { return JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Gemini returned non-JSON'); }
}
const EMAIL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    subject: { type: 'STRING' }, previewText: { type: 'STRING' }, body: { type: 'STRING' },
    subjectAlternatives: { type: 'ARRAY', items: { type: 'STRING' } }, notes: { type: 'STRING' }
  }, required: ['subject', 'previewText', 'body']
};
function authorContext(author) {
  const books = (author.books || []).map(b => `- ${b.title}${b.series ? ` (${b.series})` : ''}${b.status ? ` — ${b.status}` : ''}${b.link ? ` — ${b.link}` : ''}${b.blurb ? `\n  ${b.blurb}` : ''}`).join('\n');
  return [
    `Pen name: ${author.penName || 'unknown'}`,
    author.genre ? `Genre: ${author.genre}` : '',
    author.bio ? `About the author: ${author.bio}` : '',
    author.voice ? `Voice and style notes (follow closely): ${author.voice}` : '',
    author.audience ? `Readers: ${author.audience}` : '',
    author.webUrl ? `Website: ${author.webUrl}` : '',
    books ? `Books:\n${books}` : '',
    author.signature ? `Sign-off: ${author.signature}` : ''
  ].filter(Boolean).join('\n');
}
const EMAIL_SYSTEM = `You are Ink, a ghostwriter for a fiction author's reader newsletter. You write in the author's own voice — warm, specific, unhurried, never salesy or hype-driven. Short paragraphs. Concrete details over abstractions. One clear call to action at most. No emojis. Never invent facts about the author's books, dates, prices, or links: where a fact is missing, write a [square-bracket placeholder] the author will fill in.

Formatting rules for the body (plain text with light markup only): paragraphs separated by blank lines; "## " for an optional heading; "> " for a quote; "**bold**", "*italic*"; links as [text](https://url); a prominent button as [button: Label](https://url) on its own line; "---" for a divider. Merge fields you may use: {{first_name}}, {{pen_name}}, {{buy_url}}. Do not include an unsubscribe line or a footer — Ink adds those. Begin with a greeting to {{first_name}} and end with the sign-off.`;

// ────────────────────────────────────────────────────────── subscriber ops ──

function segmentMatch(sub, segment) {
  if (!segment) return true;
  const tags = sub.tags || [];
  if (segment.include && segment.include.length && !segment.include.some(t => tags.includes(t))) return false;
  if (segment.exclude && segment.exclude.length && segment.exclude.some(t => tags.includes(t))) return false;
  if (segment.engagement && segment.engagement !== 'all') {
    const last = sub.lastOpenAt || sub.lastClickAt || sub.createdAt || '';
    const quiet = !last || (Date.now() - new Date(last).getTime()) > 90 * 864e5;
    if (segment.engagement === 'quiet' && !quiet) return false;
    if (segment.engagement === 'engaged' && quiet) return false;
  }
  return true;
}

async function countActive(db, uid) {
  // cheap-ish count for status refresh (pages of 1000)
  let n = 0, last = null;
  for (let i = 0; i < 20; i++) {
    // no status filter in the query: equality + __name__ ordering would need a composite index
    const rows = await db.query(`authors/${uid}`, 'subscribers', { orderBy: [['__name__', 'asc']], limit: 1000, startAfter: last ? [last] : undefined });
    n += rows.filter(r => r.status === 'active').length; if (rows.length < 1000) break; last = { referenceValue: rows[rows.length - 1]._name };
  }
  return n;
}

async function addSubscriber(env, db, uid, author, { email, name, tags = [], source = 'join', fields = {} }) {
  email = String(email || '').trim().toLowerCase();
  if (!isEmail(email)) bad('Please enter a valid email address.');
  const sid = await subscriberId(email);
  const path = `authors/${uid}/subscribers/${sid}`;
  const existing = await db.get(path);
  const doubleOptIn = !!(author.doubleOptIn);
  const t = nowIso();
  if (existing && existing.status === 'active') {
    if (tags.length) await db.set(path, { tags: Array.from(new Set([...(existing.tags || []), ...tags])), updatedAt: t });
    return { sid, status: 'active', already: true };
  }
  const status = doubleOptIn ? 'pending' : 'active';
  await db.set(path, {
    email, name: name || (existing && existing.name) || '', status, tags: Array.from(new Set([...(existing?.tags || []), ...tags])),
    source, fields, createdAt: existing?.createdAt || t, updatedAt: t, confirmedAt: doubleOptIn ? null : t,
    unsubscribedAt: null, opens: existing?.opens || 0, clicks: existing?.clicks || 0
  });
  await db.increment(`authors/${uid}/metricsDaily/${t.slice(0, 10)}`, { subscribed: 1 });
  if (doubleOptIn) {
    const token = await signToken(env, { k: 'confirm', uid, sid, exp: Date.now() + 14 * 864e5 });
    const url = `${env.PUBLIC_URL}/confirm/${token}`;
    const body = `Hello {{first_name}},\n\nOne quick click to confirm you would like letters from ${author.penName || 'me'}:\n\n[button: Yes, confirm my subscription](${url})\n\nIf you did not sign up, you can ignore this email.`;
    await sendSingle(env, db, uid, author, { email, name }, { subject: `Confirm your subscription to ${author.penName || 'the reader list'}`, previewText: 'One click and you are in.', body }, { kind: 'confirm' });
  } else {
    await startAutomations(db, uid, sid);
    await db.increment(`authors/${uid}`, { subscriberCount: 1 });
  }
  return { sid, status };
}

async function startAutomations(db, uid, sid) {
  const auto = await db.get(`authors/${uid}/automations/welcome`);
  if (!auto || !auto.enabled || !(auto.steps || []).length) return;
  const t = nowIso();
  await db.set(`automationRuns/${uid}_${sid}`, { uid, sid, autoId: 'welcome', stepIndex: 0, nextAt: addDays(t, auto.steps[0].delayDays || 0), createdAt: t });
}

// ───────────────────────────────────────────────────────────── sending ──

function buildVars(env, uid, author, sub, token, cid) {
  const firstBook = (author.books || [])[0] || {};
  return {
    name: sub.name || '', first_name: Render.firstName(sub.name) || '', fallback_name: author.readerNoun || 'friend',
    pen_name: author.penName || '', web_url: author.webUrl || '', book_title: firstBook.title || '', buy_url: author.buyUrl || firstBook.link || author.webUrl || '',
    unsubscribe_url: unsubUrl(env, uid, sub.id || sub.sid, token, cid)
  };
}
function renderFor(env, uid, author, sub, token, campaign) {
  return Render.renderEmail({
    subject: campaign.subject, previewText: campaign.previewText, body: campaign.body,
    brand: author.brand || {}, author: { penName: author.penName, address: author.postalAddress, webUrl: author.webUrl, signature: '' },
    vars: buildVars(env, uid, author, sub, token, campaign.trackId)
  });
}
function emailPayload(env, uid, author, sub, token, campaign, tags) {
  const r = renderFor(env, uid, author, sub, token, campaign);
  const u = unsubUrl(env, uid, sub.id || sub.sid, token, campaign.trackId);
  return {
    from: fromAddress(env, author), to: [sub.email], reply_to: author.replyTo || author.email || undefined,
    subject: r.subject, html: r.html, text: r.text,
    headers: { 'List-Unsubscribe': `<${u}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    tags: tags || []
  };
}

/** Transactional single send (confirm, welcome automation steps, tests). */
async function sendSingle(env, db, uid, author, sub, campaign, { kind = 'single', track = true } = {}) {
  const sid = sub.sid || sub.id || (await subscriberId(sub.email));
  const token = await unsubToken(env, uid, sid);
  const payload = emailPayload(env, uid, author, { ...sub, id: sid }, token, campaign, [{ name: 'kind', value: kind }]);
  const res = await resend(env, '/emails', payload);
  if (track && res && res.id) await db.set(`emailIndex/${res.id}`, { uid, sid, kind, cid: campaign.id || null, at: nowIso() });
  return res;
}

/** Create/continue a campaign send job. Returns job state. */
// Engagement score: most recently engaged readers first. Sending to people who open builds
// domain reputation early in the send, which is what mailbox providers watch.
function engagementScore(s) {
  const last = Math.max(s.lastOpenAt ? Date.parse(s.lastOpenAt) : 0, s.lastClickAt ? Date.parse(s.lastClickAt) : 0);
  return last * 10 + (s.opens || 0) * 864e5 + (s.clicks || 0) * 3 * 864e5 + (s.createdAt ? Date.parse(s.createdAt) / 1000 : 0);
}
// Warm-up pacing: how many recipients one cron tick (every 5 min) may send for this author.
// New senders ramp: <500 lifetime sends → 100/tick (~1,200/h); <2,000 → 300/tick; then 1,000/tick.
function paceLimit(author) {
  const total = author.totalSent || 0;
  const d = author.customDomain && author.customDomain.status === 'verified' && author.customDomain.verifiedAt ? (Date.now() - Date.parse(author.customDomain.verifiedAt)) / 864e5 : 999;
  if (total < 500 || d < 3) return 100;
  if (total < 2000 || d < 10) return 300;
  return 1000;
}

async function runSendJob(env, db, uid, cid, maxBatches = 8) {
  const jobPath = `jobs/${uid}_${cid}`;
  let job = await db.get(jobPath);
  const campaign = await db.get(`authors/${uid}/campaigns/${cid}`);
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  const author = await db.get(`authors/${uid}`);
  if (!author) throw new HttpError(404, 'Author profile not found');
  const t = nowIso();
  if (!job) {
    // Build the queue once: every eligible reader, engaged-first, stored in chunks of 4,000 ids.
    const all = []; let last = null;
    for (let i = 0; i < 50; i++) {
      const rows = await db.query(`authors/${uid}`, 'subscribers', { orderBy: [['__name__', 'asc']], limit: 1000, startAfter: last ? [{ referenceValue: last }] : undefined });
      for (const r of rows) if (r.status === 'active' && segmentMatch(r, campaign.segment)) all.push(r);
      if (rows.length < 1000) break; last = rows[rows.length - 1]._name;
    }
    all.sort((a, b) => engagementScore(b) - engagementScore(a));
    const ids = all.map(r => r.id);
    const writes = [];
    for (let i = 0; i * 4000 < ids.length; i++) writes.push(db.writeSet(`jobs/${uid}_${cid}/q/${i}`, { ids: ids.slice(i * 4000, (i + 1) * 4000) }, false));
    if (writes.length) await db.commitChunked(writes);
    job = { uid, cid, status: 'running', total: ids.length, chunks: writes.length, qi: 0, qo: 0, sent: 0, failed: 0, batches: 0, pace: paceLimit(author), createdAt: t, updatedAt: t };
    await db.set(jobPath, job, false);
    await db.set(`authors/${uid}/campaigns/${cid}`, { status: 'sending', sendStartedAt: t, updatedAt: t });
    await db.updatePaths(`authors/${uid}/campaigns/${cid}`, { 'stats.recipients': ids.length });
    if (!ids.length) { job.status = 'done'; }
  }
  if (job.status !== 'running') { if (job.status === 'done' && !job.finishedAt) await finishJob(env, db, uid, cid, job, campaign, author); return job; }

  let sentThisRun = 0;
  const limit = job.pace || paceLimit(author);
  for (let b = 0; b < maxBatches && sentThisRun < limit; b++) {
    // next up to 100 ids from the queue
    let chunk = null, ids = [];
    while (ids.length < 100 && job.qi < job.chunks) {
      if (!chunk || chunk._i !== job.qi) { chunk = await db.get(`jobs/${uid}_${cid}/q/${job.qi}`); if (!chunk) { job.qi++; job.qo = 0; continue; } chunk._i = job.qi; }
      const take = Math.min(100 - ids.length, limit - sentThisRun - ids.length, chunk.ids.length - job.qo);
      if (take <= 0) break;
      ids = ids.concat(chunk.ids.slice(job.qo, job.qo + take)); job.qo += take;
      if (job.qo >= chunk.ids.length) { job.qi++; job.qo = 0; }
    }
    const exhausted = job.qi >= job.chunks;
    if (ids.length) {
      // re-read the readers now: skip anyone who unsubscribed/bounced since the job was queued
      const batch = (await db.batchGet(ids.map(id => `authors/${uid}/subscribers/${id}`))).filter(s => s.status === 'active');
      if (batch.length) {
        const payloads = [];
        for (const s of batch) {
          const token = await unsubToken(env, uid, s.id);
          payloads.push(emailPayload(env, uid, author, s, token, { ...campaign, trackId: cid }, [{ name: 'campaign', value: cid }]));
        }
        let rids = [];
        try { const res = await resend(env, '/emails/batch', payloads); rids = (res.data || []).map(x => x.id); }
        catch (e) {
          job.failed += batch.length;
          await db.set(jobPath, { failed: job.failed, qi: job.qi, qo: job.qo, lastError: String(e.message).slice(0, 500), updatedAt: nowIso() });
          continue;
        }
        const writes = [];
        batch.forEach((s, i) => {
          const id = rids[i] || null;
          writes.push(db.writeSet(`authors/${uid}/campaigns/${cid}/recipients/${s.id}`, { email: s.email, resendId: id, status: id ? 'sent' : 'failed', sentAt: nowIso() }));
          if (id) writes.push(db.writeSet(`emailIndex/${id}`, { uid, sid: s.id, cid, kind: 'campaign', at: nowIso() }));
        });
        await db.commitChunked(writes);
        const ok = rids.filter(Boolean).length;
        job.sent += ok; job.failed += batch.length - ok; job.batches += 1; sentThisRun += batch.length;
        await db.increment(`authors/${uid}/campaigns/${cid}`, { 'stats.sent': ok });
      }
      await db.set(jobPath, { sent: job.sent, failed: job.failed, batches: job.batches, qi: job.qi, qo: job.qo, updatedAt: nowIso() });
    }
    if (exhausted) { job.status = 'done'; await finishJob(env, db, uid, cid, job, campaign, author); break; }
  }
  return job;
}

async function finishJob(env, db, uid, cid, job, campaign, author) {
  const doneAt = nowIso();
  job.finishedAt = doneAt;
  await db.set(`jobs/${uid}_${cid}`, { status: 'done', finishedAt: doneAt });
  await db.set(`authors/${uid}/campaigns/${cid}`, { status: 'sent', sentAt: doneAt, updatedAt: doneAt, reportAt: addDays(doneAt, 2) });
  await db.set(`authors/${uid}`, { lastSentAt: doneAt, lastSentSubject: campaign.subject, updatedAt: doneAt });
  await db.increment(`authors/${uid}`, { totalSent: job.sent });
  await db.set(`schedule/report_${uid}_${cid}`, { kind: 'report', uid, cid, at: addDays(doneAt, 2) });
  await db.increment(`authors/${uid}/metricsDaily/${doneAt.slice(0, 10)}`, { sent: job.sent });
  // clean the queue chunks
  const dels = []; for (let i = 0; i < (job.chunks || 0); i++) dels.push(db.writeDelete(`jobs/${uid}_${cid}/q/${i}`));
  if (dels.length) await db.commitChunked(dels);
  if (campaign.planId && campaign.planItemId) await markPlanItem(db, uid, campaign.planId, campaign.planItemId, { status: 'sent', sentAt: doneAt });
}

async function markPlanItem(db, uid, planId, itemId, patch) {
  const plan = await db.get(`authors/${uid}/plans/${planId}`);
  if (!plan) return;
  const items = (plan.items || []).map(it => it.id === itemId ? { ...it, ...patch } : it);
  await db.set(`authors/${uid}/plans/${planId}`, { items, updatedAt: nowIso() });
}

async function scheduleCampaign(env, db, uid, cid, atIso) {
  const t = nowIso();
  await db.set(`authors/${uid}/campaigns/${cid}`, { status: 'scheduled', scheduledAt: atIso, approvedAt: t, updatedAt: t });
  await db.set(`schedule/send_${uid}_${cid}`, { kind: 'send', uid, cid, at: atIso });
  const c = await db.get(`authors/${uid}/campaigns/${cid}`);
  if (c && c.planId && c.planItemId) await markPlanItem(db, uid, c.planId, c.planItemId, { status: 'approved', campaignId: cid });
}

// ────────────────────────────────────────────────────────────── AI ops ──

async function aiDraft(env, author, { templateId, purpose, brief, tone, subjectHint, planTitle, existing }) {
  const tpl = templateId ? Templates.byId(templateId) : null;
  const prompt = [
    `AUTHOR PROFILE\n${authorContext(author)}`,
    tpl ? `EMAIL TYPE: ${tpl.name}\nPURPOSE: ${tpl.purpose}\nTEMPLATE (use as the skeleton; keep its structure and intent, replace the [placeholders] with real content from the brief, and leave a [placeholder] where the brief gives no fact):\nSubject: ${tpl.subject}\nPreview: ${tpl.previewText}\n\n${tpl.body}` : `PURPOSE: ${purpose || 'a warm letter to readers'}`,
    planTitle ? `THIS EMAIL IN THE CAMPAIGN PLAN: ${planTitle}` : '',
    brief ? `AUTHOR'S BRIEF (what they want to say — the most important input):\n${brief}` : 'The author has not given a brief: write the email from the template purpose and profile, leaving [placeholders] for specifics.',
    tone ? `TONE THIS TIME: ${tone}` : '',
    subjectHint ? `SUBJECT LINE DIRECTION: ${subjectHint}` : '',
    existing ? `EXISTING DRAFT TO IMPROVE (keep what works):\n${existing}` : '',
    `Write the complete email. Return JSON with subject, previewText (under 90 characters, complements the subject, no repetition), body (300–600 words unless the type calls for shorter), subjectAlternatives (4 different subject lines: one curious, one plain, one personal, one specific), and notes (one sentence to the author on anything they must fill in).`
  ].filter(Boolean).join('\n\n');
  return gemini(env, { system: EMAIL_SYSTEM, prompt, jsonSchema: EMAIL_SCHEMA });
}

async function statsSummary(db, uid) {
  const campaigns = (await db.query(`authors/${uid}`, 'campaigns', { orderBy: [['sentAt', 'desc']], limit: 40 })).filter(c => c.status === 'sent').slice(0, 12);
  const days = await db.query(`authors/${uid}`, 'metricsDaily', { orderBy: [['__name__', 'desc']], limit: 90 });
  const lines = campaigns.map(c => {
    const s = c.stats || {}; const r = s.sent || 1;
    return `${(c.sentAt || '').slice(0, 10)} "${c.subject}" — sent ${s.sent || 0}, delivered ${s.delivered || 0}, opens ${s.uniqueOpens || 0} (${Math.round(100 * (s.uniqueOpens || 0) / r)}%), clicks ${s.uniqueClicks || 0} (${Math.round(100 * (s.uniqueClicks || 0) / r)}%), unsubscribes ${s.unsubscribed || 0}, bounces ${s.bounced || 0}, complaints ${s.complained || 0}`;
  });
  const growth = days.reduce((a, d) => { a.subscribed += d.subscribed || 0; a.unsubscribed += d.unsubscribed || 0; return a; }, { subscribed: 0, unsubscribed: 0 });
  return { campaigns, lines, growth, text: `Recent campaigns:\n${lines.join('\n') || '(none sent yet)'}\n\nLast 90 days: +${growth.subscribed} subscribed, -${growth.unsubscribed} unsubscribed.` };
}

const INSIGHT_SCHEMA = {
  type: 'OBJECT', properties: {
    summary: { type: 'STRING' },
    insights: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, detail: { type: 'STRING' }, action: { type: 'STRING' }, actionType: { type: 'STRING' }, priority: { type: 'STRING' } }, required: ['title', 'detail', 'action'] } }
  }, required: ['summary', 'insights']
};
async function aiInsights(env, db, uid, author) {
  const s = await statsSummary(db, uid);
  const plans = await db.query(`authors/${uid}`, 'plans', { where: [['status', '==', 'active']], limit: 3 });
  const prompt = `You are Ink's marketing analyst for a fiction author. Benchmarks for author newsletters: open rate 35–45% is good (under 25% is weak), click rate 2–5% is good, unsubscribe rate under 0.5% per send is healthy, bounce under 2%, complaints under 0.1%. A list that goes more than 5 weeks without a letter cools quickly.

AUTHOR\n${authorContext(author)}\nSubscribers: ${author.subscriberCount || 0}. Last sent: ${author.lastSentAt || 'never'}. Active plans: ${plans.map(p => p.name).join(', ') || 'none'}.

DATA\n${s.text}

Give a two-sentence plain-English summary, then 3–5 insights. Each insight: title, detail (what the numbers say, specific), action (one concrete thing the author can approve in Ink), actionType (one of: send-reengage, adjust-subject, add-plan, clean-list, change-cadence, ask-replies, other), priority (high/medium/low). Be honest, encouraging, and specific — no generic advice. Return JSON.`;
  return gemini(env, { prompt, jsonSchema: INSIGHT_SCHEMA, temperature: 0.5 });
}

// ────────────────────────────────────────────────────── public HTML pages ──

function pageShell(title, body, brand = {}) {
  const b = Object.assign({}, Render.DEFAULT_BRAND, brand);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:${b.bg};font-family:${b.font};color:${b.text}}.wrap{max-width:520px;margin:8vh auto;background:${b.card};border-radius:8px;padding:2.5rem 2rem;box-shadow:0 8px 40px rgba(0,0,0,.08)}h1{font-size:1.7rem;font-weight:600;color:${b.heading};margin:0 0 .5rem;line-height:1.25}p{font-size:1.05rem;line-height:1.6}label{display:block;font-size:.85rem;letter-spacing:.05em;text-transform:uppercase;color:${b.muted};margin:1rem 0 .3rem}input{width:100%;box-sizing:border-box;padding:.8rem 1rem;font-size:1.05rem;font-family:inherit;border:1px solid ${b.rule};border-radius:4px}button{margin-top:1.25rem;width:100%;padding:.95rem;font-size:1.05rem;font-family:inherit;font-weight:600;background:${b.accent};color:${b.accentText};border:0;border-radius:4px;cursor:pointer}button:disabled{opacity:.6}.fine{font-size:.85rem;color:${b.muted}}.pen{font-size:.8rem;letter-spacing:.18em;text-transform:uppercase;color:${b.muted};margin-bottom:1.5rem}.ok{background:#eef7ee;border:1px solid #c9e4c9;padding:1rem;border-radius:4px}.err{color:#b23b2a;font-size:.95rem;margin-top:.6rem;min-height:1.2em}.ink{text-align:center;margin-top:2rem;font-size:.75rem;color:${b.muted}}.ink a{color:inherit}</style></head><body><div class="wrap">${body}</div><p class="ink">Powered by <a href="https://ink.jacobsiler.com">Ink</a></p></body></html>`;
}

function joinPage(env, slug, author, tags) {
  const headline = author.joinHeadline || `Join ${author.penName}'s readers`;
  const blurb = author.joinBlurb || `New books, stories from behind the writing desk, and the occasional gift. ${author.cadenceNote || 'About once a month. Unsubscribe any time.'}`;
  return pageShell(headline, `
<div class="pen">${escapeHtml(author.penName || '')}</div>
<h1>${escapeHtml(headline)}</h1>
<p>${escapeHtml(blurb)}</p>
<form id="f" onsubmit="return go(event)">
<label for="n">First name</label><input id="n" name="name" autocomplete="given-name" placeholder="Optional">
<label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
<input type="text" name="website" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off">
<button id="b" type="submit">${escapeHtml(author.joinButton || 'Join the list')}</button>
<div class="err" id="err"></div>
</form>
<div class="ok" id="ok" style="display:none"></div>
<p class="fine">${author.doubleOptIn ? 'We will send a confirmation email — click the link inside to finish.' : 'No spam, ever. Unsubscribe with one click.'}</p>
<script>
async function go(e){e.preventDefault();var b=document.getElementById('b'),err=document.getElementById('err');b.disabled=true;err.textContent='';
try{var r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('e').value,name:document.getElementById('n').value,website:document.querySelector('[name=website]').value,tags:${JSON.stringify(tags)}})});var d=await r.json();
if(!d.ok){err.textContent=d.error||'Something went wrong.';b.disabled=false;return;}
document.getElementById('f').style.display='none';var ok=document.getElementById('ok');ok.style.display='block';ok.textContent=d.status==='pending'?'Almost there — check your inbox and click the confirmation link.':'You are in. Welcome!';}
catch(x){err.textContent='Network error — please try again.';b.disabled=false;}return false;}
</script>`, author.brand);
}

function embedScript(env) {
  return `(function(){var ds=document.querySelectorAll('[data-ink-join]');ds.forEach(function(el){if(el.dataset.inkReady)return;el.dataset.inkReady=1;var slug=el.getAttribute('data-ink-join'),tags=(el.getAttribute('data-ink-tags')||'').split(',').map(function(s){return s.trim()}).filter(Boolean);var btn=el.getAttribute('data-ink-button')||'Join the list';
el.innerHTML='<form class="ink-form" style="display:flex;flex-wrap:wrap;gap:.5rem"><input class="ink-name" placeholder="First name" style="flex:1 1 120px;padding:.7rem .9rem;font:inherit"><input class="ink-email" type="email" required placeholder="Email" style="flex:2 1 200px;padding:.7rem .9rem;font:inherit"><button type="submit" style="flex:1 1 120px;padding:.7rem 1rem;font:inherit;cursor:pointer">'+btn+'</button><div class="ink-msg" style="flex-basis:100%;font-size:.9rem"></div></form>';
var f=el.querySelector('form'),msg=el.querySelector('.ink-msg');f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('button');b.disabled=true;msg.textContent='';
fetch('${env.PUBLIC_URL}/join/'+encodeURIComponent(slug),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.querySelector('.ink-email').value,name:f.querySelector('.ink-name').value,tags:tags,source:'embed:'+location.hostname})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){msg.textContent=d.error||'Something went wrong.';b.disabled=false;return;}f.querySelector('.ink-email').value='';msg.textContent=d.status==='pending'?'Check your inbox to confirm.':'You are in — welcome!';}).catch(function(){msg.textContent='Network error — please try again.';b.disabled=false;});});});})();`;
}

// ───────────────────────────────────────────────────────── nudge emails ──

function inkMail(env, author, title, paragraphs, actions) {
  const body = [`Hello ${author.penName || 'there'},`, ...paragraphs, ...actions.map(a => `[button: ${a.label}](${a.url})`), `— Ink`].join('\n\n');
  return Render.renderEmail({ subject: title, previewText: paragraphs[0] ? paragraphs[0].slice(0, 90) : '', body, brand: { accent: '#b8860b', heading: '#16120e' }, author: { penName: 'Ink', address: '', webUrl: env.APP_URL }, vars: { first_name: author.penName || 'there', unsubscribe_url: `${env.APP_URL}/#settings` } });
}
async function emailAuthor(env, author, title, paragraphs, actions = []) {
  if (!author.email) return;
  const r = inkMail(env, author, title, paragraphs, actions);
  await resend(env, '/emails', { from: inkFrom(env), to: [author.email], subject: r.subject, html: r.html, text: r.text, tags: [{ name: 'kind', value: 'nudge' }] });
}

async function approveLink(env, uid, cid, mode) {
  const token = await signToken(env, { k: 'approve', uid, cid, mode, exp: Date.now() + 21 * 864e5 });
  return `${env.PUBLIC_URL}/approve/${token}`;
}

/** Daily per-author check: auto-draft upcoming plan items, remind about approvals, nag gently when quiet. */
async function nudgeAuthor(env, db, author) {
  const uid = author.id; const tz = author.timezone || 'Europe/Dublin';
  const t = nowIso();
  const plans = await db.query(`authors/${uid}`, 'plans', { where: [['status', '==', 'active']], limit: 5 });
  const drafted = [], due = [], overdue = [];
  for (const plan of plans) {
    const pb = Templates.playbookById(plan.playbookId) || {};
    const leadDays = plan.leadDays || pb.leadDays || 3;
    let changed = false;
    const items = plan.items || [];
    for (const it of items) {
      if (!it.dueDate || ['sent', 'skipped'].includes(it.status)) continue;
      const dueMs = new Date(it.dueDate + 'T12:00:00Z').getTime();
      const daysUntil = (dueMs - Date.now()) / 864e5;
      if (it.status === 'upcoming' && daysUntil <= leadDays) {
        // auto-draft
        try {
          const tpl = Templates.byId(it.templateId) || {};
          const draft = await aiDraft(env, author, { templateId: it.templateId, planTitle: `${plan.name}: ${it.title}`, brief: it.brief || plan.brief || '' });
          const cid = randomToken(16);
          const seg = it.segment === 'quiet' ? { engagement: 'quiet' } : (it.segment && it.segment.startsWith('tag:') ? { include: [it.segment.slice(4)] } : {});
          await db.set(`authors/${uid}/campaigns/${cid}`, {
            title: it.title, subject: draft.subject, previewText: draft.previewText, body: draft.body, subjectAlternatives: draft.subjectAlternatives || [], aiNotes: draft.notes || '',
            templateId: it.templateId || null, planId: plan.id, planItemId: it.id, segment: seg, status: 'draft', source: 'ink-auto',
            stats: { recipients: 0, sent: 0, delivered: 0, opened: 0, uniqueOpens: 0, clicked: 0, uniqueClicks: 0, bounced: 0, complained: 0, unsubscribed: 0 },
            scheduledFor: it.dueDate, createdAt: t, updatedAt: t
          }, false);
          it.status = 'drafted'; it.campaignId = cid; changed = true;
          await db.set(`authors/${uid}/suggestions/${cid}`, { type: 'draft', title: `Draft ready: ${it.title}`, body: `Due ${tzDate(it.dueDate + 'T12:00:00Z', tz)}. Ink drafted it from your plan — review, tweak, and approve.`, campaignId: cid, planId: plan.id, status: 'open', dueAt: it.dueDate, createdAt: t });
          drafted.push({ it, cid, plan });
        } catch (e) { console.error('auto-draft failed', uid, it.id, e.message); }
      } else if (it.status === 'drafted' && daysUntil <= 1 && it.campaignId && !it.remindedDue) {
        it.remindedDue = true; changed = true; due.push({ it, cid: it.campaignId, plan });
      } else if (['drafted', 'upcoming'].includes(it.status) && daysUntil < -2 && !it.remindedOverdue) {
        it.remindedOverdue = true; changed = true; overdue.push({ it, cid: it.campaignId, plan });
      }
    }
    if (changed) await db.set(`authors/${uid}/plans/${plan.id}`, { items, updatedAt: nowIso() });
  }
  const paragraphs = [], actions = [];
  for (const d of drafted) {
    paragraphs.push(`**${d.it.title}** is due ${tzDate(d.it.dueDate + 'T12:00:00Z', tz)}. I have written a draft from your ${d.plan.name} plan — it needs your eyes before it goes anywhere.`);
    actions.push({ label: `Review "${d.it.title}" in Ink`, url: `${env.APP_URL}/#campaign/${d.cid}` });
    actions.push({ label: `Approve as-is & schedule for ${d.it.dueDate}`, url: await approveLink(env, uid, d.cid, 'schedule') });
  }
  for (const d of due) {
    paragraphs.push(`Reminder: **${d.it.title}** is due ${tzDate(d.it.dueDate + 'T12:00:00Z', tz)} and is still waiting for your approval.`);
    actions.push({ label: `Approve "${d.it.title}"`, url: await approveLink(env, uid, d.cid, 'schedule') });
  }
  for (const d of overdue) {
    paragraphs.push(`**${d.it.title}** was due ${tzDate(d.it.dueDate + 'T12:00:00Z', tz)} and has not gone out. No guilt — lists forgive a late letter far more than a silent one. Send it when you can, or skip it in your plan.`);
    actions.push({ label: `Open the plan`, url: `${env.APP_URL}/#plan/${d.plan.id}` });
  }
  if (paragraphs.length) await emailAuthor(env, author, drafted.length ? `Ink drafted your next letter — approve?` : `Your list is waiting on you`, paragraphs, actions);

  // quiet-list reminder (weekly at most) when no plan is active and nothing sent for 5 weeks
  if (!plans.length) {
    const lastSent = author.lastSentAt ? new Date(author.lastSentAt).getTime() : 0;
    const lastQuiet = author.lastQuietNudgeAt ? new Date(author.lastQuietNudgeAt).getTime() : 0;
    if (Date.now() - lastSent > 35 * 864e5 && Date.now() - lastQuiet > 7 * 864e5 && (author.subscriberCount || 0) > 0) {
      await emailAuthor(env, author, 'Your readers have not heard from you in a while',
        [`It has been ${lastSent ? Math.round((Date.now() - lastSent) / 864e5) + ' days' : 'a while'} since your last letter to ${author.subscriberCount} readers. A short, honest note keeps a list warm — and Ink can draft it for you in a minute.`],
        [{ label: 'Draft a monthly letter', url: `${env.APP_URL}/#compose/monthly-letter` }, { label: 'Start a plan', url: `${env.APP_URL}/#plan` }]);
      await db.set(`authors/${uid}`, { lastQuietNudgeAt: t });
    }
  }
  // next check: tomorrow 08:00 in the author's timezone
  const tomorrow = new Date(Date.now() + 864e5);
  const dstr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  await db.set(`authors/${uid}`, { nudgeNextAt: localDateTimeToIso(dstr, author.nudgeHour || 8, tz), lastNudgeCheckAt: t });
}

async function campaignReport(env, db, uid, cid) {
  const author = await db.get(`authors/${uid}`); const c = await db.get(`authors/${uid}/campaigns/${cid}`);
  if (!author || !c) return;
  const s = c.stats || {}; const n = s.sent || 1;
  const pct = (x) => `${Math.round(100 * (x || 0) / n)}%`;
  let insight = '';
  try {
    insight = await gemini(env, { temperature: 0.4, prompt: `In 3 short sentences, tell a fiction author how their newsletter did and one specific thing to try next time. Benchmarks: opens 35–45% good, clicks 2–5% good, unsubscribes under 0.5% healthy. Data: subject "${c.subject}", sent ${s.sent || 0}, delivered ${s.delivered || 0}, unique opens ${s.uniqueOpens || 0} (${pct(s.uniqueOpens)}), unique clicks ${s.uniqueClicks || 0} (${pct(s.uniqueClicks)}), unsubscribes ${s.unsubscribed || 0}, bounces ${s.bounced || 0}, complaints ${s.complained || 0}. Plain prose, no bullet points, no headings.` });
  } catch (e) { insight = ''; }
  const t = nowIso();
  await db.set(`authors/${uid}/campaigns/${cid}`, { report: { at: t, insight }, updatedAt: t });
  await db.set(`authors/${uid}/suggestions/report_${cid}`, { type: 'insight', title: `How "${c.subject}" did`, body: `${pct(s.uniqueOpens)} opened · ${pct(s.uniqueClicks)} clicked · ${s.unsubscribed || 0} unsubscribed.${insight ? ' ' + insight : ''}`, campaignId: cid, status: 'open', createdAt: t });
  await emailAuthor(env, author, `How "${c.subject}" did`, [
    `48 hours in: **${s.delivered || s.sent || 0} delivered**, **${s.uniqueOpens || 0} opened (${pct(s.uniqueOpens)})**, **${s.uniqueClicks || 0} clicked (${pct(s.uniqueClicks)})**, ${s.unsubscribed || 0} unsubscribed, ${s.bounced || 0} bounced.`,
    insight || 'Open the analytics in Ink for the full picture.'
  ], [{ label: 'See the full report', url: `${env.APP_URL}/#campaign/${cid}` }]);
}

// ───────────────────────────────────────────────────────────── webhooks ──

async function verifySvix(request, rawBody, secret) {
  const id = request.headers.get('svix-id'), ts = request.headers.get('svix-timestamp'), sigs = request.headers.get('svix-signature');
  if (!id || !ts || !sigs || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${rawBody}`)))));
  return sigs.split(' ').some(s => { const [v, val] = s.split(','); return v === 'v1' && val && timingSafeEqual(val, sig); });
}

async function handleResendEvent(env, db, evt) {
  const type = evt.type || ''; const emailId = evt.data && (evt.data.email_id || evt.data.id);
  if (!emailId) return;
  const idx = await db.get(`emailIndex/${emailId}`);
  if (!idx) return;
  const { uid, sid, cid } = idx; const t = evt.created_at || nowIso(); const day = t.slice(0, 10);
  const subPath = `authors/${uid}/subscribers/${sid}`;
  const recPath = cid ? `authors/${uid}/campaigns/${cid}/recipients/${sid}` : null;
  const campPath = cid ? `authors/${uid}/campaigns/${cid}` : null;
  const rec = recPath ? await db.get(recPath) : null;
  const inc = {}; const recPatch = {}; const subPatch = { updatedAt: nowIso() }; const dayInc = {};
  switch (type) {
    case 'email.delivered': if (rec && !rec.deliveredAt) { inc['stats.delivered'] = 1; recPatch.deliveredAt = t; recPatch.status = 'delivered'; } break;
    case 'email.opened':
      inc['stats.opened'] = 1; dayInc.opens = 1; subPatch.lastOpenAt = t;
      if (rec && !rec.openedAt) { inc['stats.uniqueOpens'] = 1; recPatch.openedAt = t; }
      recPatch.opens = (rec?.opens || 0) + 1;
      await db.increment(subPath, { opens: 1 });
      break;
    case 'email.clicked':
      inc['stats.clicked'] = 1; dayInc.clicks = 1; subPatch.lastClickAt = t;
      if (rec && !rec.clickedAt) { inc['stats.uniqueClicks'] = 1; recPatch.clickedAt = t; }
      recPatch.clicks = (rec?.clicks || 0) + 1; recPatch.lastUrl = evt.data.click?.link || '';
      await db.increment(subPath, { clicks: 1 });
      break;
    case 'email.bounced':
      inc['stats.bounced'] = 1; recPatch.status = 'bounced'; recPatch.bouncedAt = t;
      subPatch.status = 'bounced'; subPatch.bouncedAt = t; subPatch.bounceReason = (evt.data.bounce && evt.data.bounce.message) || '';
      dayInc.bounced = 1; await db.increment(`authors/${uid}`, { subscriberCount: -1 });
      break;
    case 'email.complained':
      inc['stats.complained'] = 1; recPatch.status = 'complained';
      subPatch.status = 'complained'; subPatch.unsubscribedAt = t; dayInc.unsubscribed = 1;
      await db.increment(`authors/${uid}`, { subscriberCount: -1 });
      break;
    case 'email.delivery_delayed': recPatch.delayed = true; break;
    default: return;
  }
  const writes = [];
  if (recPath && Object.keys(recPatch).length) writes.push(db.writeSet(recPath, recPatch));
  writes.push(db.writeSet(subPath, subPatch));
  if (writes.length) await db.commit(writes);
  if (campPath && Object.keys(inc).length) await db.increment(campPath, inc);
  if (Object.keys(dayInc).length) await db.increment(`authors/${uid}/metricsDaily/${day}`, dayInc);
}

// ─────────────────────────────────────────────────────────────── router ──

const REQUIRED_SECRETS = ['RESEND_API_KEY', 'GEMINI_API_KEY', 'INK_SIGNING_SECRET'];
function missingConfig(env) { const m = REQUIRED_SECRETS.filter(k => !env[k]); if (!env.FIREBASE_SERVICE_ACCOUNT && !env.FIREBASE_SERVICE_ACCOUNT_B64) m.unshift('FIREBASE_SERVICE_ACCOUNT_B64'); return m; }

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const missing = missingConfig(env);
  if (missing.length && !['/', '/health'].includes(url.pathname.replace(/\/+$/, '') || '/')) {
    throw new HttpError(503, `Ink's server is not fully configured yet — missing secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Set ${missing.length > 1 ? 'them' : 'it'} with "npx wrangler secret put NAME" in the worker folder, then try again.`);
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const m = request.method;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const db = new Firestore(env);

  // ── public ──
  if (path === '/' || path === '/health') return json({ ok: true, service: 'ink-worker', time: nowIso(), configured: missingConfig(env).length === 0, missing: missingConfig(env) });
  if (path === '/embed.js') return new Response(embedScript(env), { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600', ...CORS } });

  if (parts[0] === 'join' && parts[1]) {
    const slugDoc = await db.get(`slugs/${decodeURIComponent(parts[1]).toLowerCase()}`);
    if (!slugDoc) return m === 'GET' ? html(pageShell('Not found', '<h1>No such list</h1><p>This sign-up link is not active.</p>'), 404) : json({ ok: false, error: 'Unknown list' }, 404);
    const author = await db.get(`authors/${slugDoc.uid}`);
    if (!author) return json({ ok: false, error: 'Unknown list' }, 404);
    const tags = (url.searchParams.get('tags') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (m === 'GET') return html(joinPage(env, parts[1], author, tags));
    const body = await readBody(request);
    if (body.website) return json({ ok: true, status: 'active' }); // honeypot
    const r = await addSubscriber(env, db, slugDoc.uid, author, { email: body.email, name: body.name, tags: [...(Array.isArray(body.tags) ? body.tags : []), ...tags].map(String).slice(0, 10), source: body.source || 'join-page' });
    return json({ ok: true, status: r.status, already: !!r.already });
  }

  if (parts[0] === 'confirm' && parts[1]) {
    const p = await verifyToken(env, parts[1]);
    if (!p || p.k !== 'confirm') return html(pageShell('Link expired', '<h1>This link has expired</h1><p>Please sign up again to receive a fresh confirmation email.</p>'), 400);
    const author = await db.get(`authors/${p.uid}`); const sub = await db.get(`authors/${p.uid}/subscribers/${p.sid}`);
    if (!author || !sub) return html(pageShell('Not found', '<h1>Not found</h1>'), 404);
    if (sub.status === 'pending') {
      const t = nowIso();
      await db.set(`authors/${p.uid}/subscribers/${p.sid}`, { status: 'active', confirmedAt: t, updatedAt: t });
      await db.increment(`authors/${p.uid}`, { subscriberCount: 1 });
      await startAutomations(db, p.uid, p.sid);
    }
    return html(pageShell('Confirmed', `<div class="pen">${escapeHtml(author.penName || '')}</div><h1>You are in.</h1><p>Thank you for confirming. ${escapeHtml(author.penName || 'The author')}'s next letter will find you.</p>${author.webUrl ? `<p><a href="${escapeHtml(author.webUrl)}">Back to ${escapeHtml(author.penName)}'s site →</a></p>` : ''}`, author.brand));
  }

  if (parts[0] === 'u' && parts[3]) {
    const [, uid, sid, token] = parts;
    const expect = await unsubToken(env, uid, sid);
    if (!timingSafeEqual(token, expect)) return html(pageShell('Invalid link', '<h1>Invalid link</h1><p>This unsubscribe link is not valid.</p>'), 400);
    const author = await db.get(`authors/${uid}`); const sub = await db.get(`authors/${uid}/subscribers/${sid}`);
    if (!author || !sub) return html(pageShell('Already removed', '<h1>Already removed</h1><p>That address is not on the list.</p>'));
    const doUnsub = async () => {
      if (sub.status === 'active' || sub.status === 'pending') {
        const t = nowIso();
        await db.set(`authors/${uid}/subscribers/${sid}`, { status: 'unsubscribed', unsubscribedAt: t, updatedAt: t });
        if (sub.status === 'active') await db.increment(`authors/${uid}`, { subscriberCount: -1 });
        await db.increment(`authors/${uid}/metricsDaily/${t.slice(0, 10)}`, { unsubscribed: 1 });
        const cid = url.searchParams.get('c');
        if (cid) await db.increment(`authors/${uid}/campaigns/${cid}`, { 'stats.unsubscribed': 1 });
        await db.delete(`automationRuns/${uid}_${sid}`);
      }
    };
    if (m === 'POST') { await doUnsub(); return html(pageShell('Unsubscribed', `<h1>You have been unsubscribed.</h1><p>${escapeHtml(sub.email)} will not receive further letters from ${escapeHtml(author.penName || 'this author')}.</p>`, author.brand)); }
    if (url.searchParams.get('confirm') === '1') { await doUnsub(); return html(pageShell('Unsubscribed', `<h1>You have been unsubscribed.</h1><p>${escapeHtml(sub.email)} will not receive further letters from ${escapeHtml(author.penName || 'this author')}. Sorry to see you go.</p>`, author.brand)); }
    return html(pageShell('Unsubscribe', `<div class="pen">${escapeHtml(author.penName || '')}</div><h1>Unsubscribe?</h1><p>Stop receiving letters from ${escapeHtml(author.penName || 'this author')} at <strong>${escapeHtml(sub.email)}</strong>.</p><form method="POST"><button type="submit">Yes, unsubscribe me</button></form>`, author.brand));
  }

  if (parts[0] === 'approve' && parts[1]) {
    const p = await verifyToken(env, parts[1]);
    if (!p || p.k !== 'approve') return html(pageShell('Link expired', '<h1>This approval link has expired</h1><p>Open Ink to approve the campaign there.</p>'), 400);
    const c = await db.get(`authors/${p.uid}/campaigns/${p.cid}`); const author = await db.get(`authors/${p.uid}`);
    if (!c || !author) return html(pageShell('Not found', '<h1>Campaign not found</h1>'), 404);
    if (['sent', 'sending', 'scheduled'].includes(c.status)) return html(pageShell('Already handled', `<h1>Already ${escapeHtml(c.status)}</h1><p>"${escapeHtml(c.subject)}" is ${escapeHtml(c.status)}. Nothing more to do.</p>`));
    const when = c.scheduledFor && c.scheduledFor >= todayIn(author.timezone) ? localDateTimeToIso(c.scheduledFor, author.sendHour || 9, author.timezone || 'Europe/Dublin') : nowIso();
    if (m === 'POST') {
      await scheduleCampaign(env, db, p.uid, p.cid, when);
      await db.set(`authors/${p.uid}/suggestions/${p.cid}`, { status: 'approved', resolvedAt: nowIso() });
      if (new Date(when).getTime() <= Date.now() + 60e3) ctx.waitUntil(runSendJob(env, db, p.uid, p.cid).catch(e => console.error(e)));
      return html(pageShell('Approved', `<h1>Approved.</h1><p>"${escapeHtml(c.subject)}" will go to ${author.subscriberCount || 'your'} readers ${new Date(when).getTime() <= Date.now() + 60e3 ? 'now' : 'on ' + escapeHtml(tzDate(when, author.timezone))}.</p><p><a href="${env.APP_URL}/#campaign/${p.cid}">Open in Ink →</a></p>`));
    }
    const preview = Render.renderEmail({ subject: c.subject, previewText: c.previewText, body: c.body, brand: author.brand, author: { penName: author.penName, address: author.postalAddress, webUrl: author.webUrl }, vars: { name: 'Reader', first_name: 'Reader', pen_name: author.penName, unsubscribe_url: '#' } });
    return html(pageShell('Approve campaign', `<h1>Approve "${escapeHtml(c.subject)}"?</h1><p>It will be sent to <strong>${author.subscriberCount || 0} readers</strong> ${new Date(when).getTime() <= Date.now() + 60e3 ? '<strong>right away</strong>' : 'on <strong>' + escapeHtml(tzDate(when, author.timezone)) + '</strong>'}.</p><form method="POST"><button type="submit">Approve & schedule</button></form><p class="fine" style="margin-top:1rem"><a href="${env.APP_URL}/#campaign/${p.cid}">Edit it in Ink first →</a></p><hr style="border:0;border-top:1px solid #e6dfd0;margin:2rem 0"><p class="fine">Preview:</p><iframe srcdoc="${escapeHtml(preview.html)}" style="width:100%;height:520px;border:1px solid #e6dfd0;border-radius:4px;background:#fff"></iframe>`));
  }

  if (path === '/webhooks/resend' && m === 'POST') {
    const raw = await request.text();
    if (!(await verifySvix(request, raw, env.RESEND_WEBHOOK_SECRET))) return json({ ok: false, error: 'bad signature' }, 401);
    const evt = JSON.parse(raw);
    ctx.waitUntil(handleResendEvent(env, db, evt).catch(e => console.error('webhook', e.message)));
    return json({ ok: true });
  }

  // ── authenticated API ──
  const user = await requireUser(request, env);
  const uid = user.uid;
  const author = (await db.get(`authors/${uid}`)) || { id: uid, email: user.email };
  author.email = author.replyTo || author.email || user.email;
  author.accountEmail = user.email;
  const body = m === 'POST' || m === 'PUT' ? await readBody(request) : {};

  if (path === '/me' && m === 'GET') return json({ ok: true, user, author, publicUrl: env.PUBLIC_URL, fromAddress: fromAddress(env, author), fromDomain: env.INK_FROM_DOMAIN });

  if (path === '/me/slug' && m === 'POST') {
    const slug = String(body.slug || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
    if (slug.length < 3) bad('Slug must be at least 3 characters (letters, numbers, hyphens).');
    const existing = await db.get(`slugs/${slug}`);
    if (existing && existing.uid !== uid) bad('That address is taken.');
    if (author.slug && author.slug !== slug) await db.delete(`slugs/${author.slug}`);
    await db.set(`slugs/${slug}`, { uid, updatedAt: nowIso() });
    await db.set(`authors/${uid}`, { slug, updatedAt: nowIso() });
    return json({ ok: true, slug, joinUrl: `${env.PUBLIC_URL}/join/${slug}` });
  }

  if (path === '/me/recount' && m === 'POST') {
    const n = await countActive(db, uid);
    await db.set(`authors/${uid}`, { subscriberCount: n, updatedAt: nowIso() });
    return json({ ok: true, subscriberCount: n });
  }

  if (path === '/subscribers/add' && m === 'POST') {
    const r = await addSubscriber(env, db, uid, { ...author, doubleOptIn: false }, { email: body.email, name: body.name, tags: body.tags || [], source: body.source || 'manual' });
    return json({ ok: true, ...r });
  }

  if (parts[0] === 'ai') {
    if (!env.GEMINI_API_KEY) bad('AI is not configured on this Worker (GEMINI_API_KEY).');
    if (parts[1] === 'draft') return json({ ok: true, email: await aiDraft(env, author, body) });
    if (parts[1] === 'subjects') {
      const r = await gemini(env, { system: EMAIL_SYSTEM, prompt: `AUTHOR\n${authorContext(author)}\n\nEMAIL BODY:\n${body.body}\n\nCurrent subject: ${body.subject || '(none)'}\n\nWrite 6 alternative subject lines for this email (under 50 characters each; a mix of curious, plain, personal, specific, urgent-but-honest, and playful). Return JSON {"subjects":[...]}.`, jsonSchema: { type: 'OBJECT', properties: { subjects: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['subjects'] } });
      return json({ ok: true, subjects: r.subjects || [] });
    }
    if (parts[1] === 'polish') {
      const r = await gemini(env, { system: EMAIL_SYSTEM, prompt: `AUTHOR\n${authorContext(author)}\n\nEDIT INSTRUCTION FROM THE AUTHOR: ${body.instruction || 'tighten and improve flow without changing meaning'}\n\nEMAIL BODY TO EDIT:\n${body.body}\n\nReturn JSON with the edited body (same markup rules) and a one-line note of what changed.`, jsonSchema: { type: 'OBJECT', properties: { body: { type: 'STRING' }, notes: { type: 'STRING' } }, required: ['body'] }, temperature: 0.5 });
      return json({ ok: true, ...r });
    }
    if (parts[1] === 'plan') {
      const pbs = Templates.PLAYBOOKS.map(p => `${p.id}: ${p.name} — ${p.description}`).join('\n');
      const r = await gemini(env, { temperature: 0.5, prompt: `You are Ink's campaign strategist for a fiction author.\n\nAUTHOR\n${authorContext(author)}\nSubscribers: ${author.subscriberCount || 0}. Last letter sent: ${author.lastSentAt || 'never'}.\n\nGOAL (in the author's words): ${body.goal}\nKEY DATE (if any): ${body.anchorDate || 'none given'}\nNOTES: ${body.notes || ''}\n\nAVAILABLE PLAYBOOKS:\n${pbs}\n\nRecommend the best playbook, an anchor date (YYYY-MM-DD; if no key date was given choose a sensible start within the next 10 days), a brief for each email in the playbook (one sentence per email telling the ghostwriter what this specific email should say, keyed by its 0-based index), and a short rationale for the author. Return JSON {"playbookId":..., "anchorDate":..., "rationale":..., "briefs": {"0": "...", ...}}.`, jsonSchema: { type: 'OBJECT', properties: { playbookId: { type: 'STRING' }, anchorDate: { type: 'STRING' }, rationale: { type: 'STRING' }, briefs: { type: 'OBJECT', properties: { '0': { type: 'STRING' }, '1': { type: 'STRING' }, '2': { type: 'STRING' }, '3': { type: 'STRING' }, '4': { type: 'STRING' }, '5': { type: 'STRING' }, '6': { type: 'STRING' }, '7': { type: 'STRING' }, '8': { type: 'STRING' }, '9': { type: 'STRING' }, '10': { type: 'STRING' }, '11': { type: 'STRING' } } } }, required: ['playbookId', 'anchorDate', 'rationale'] } });
      return json({ ok: true, ...r });
    }
    if (parts[1] === 'insights') {
      const r = await aiInsights(env, db, uid, author);
      const t = nowIso();
      const writes = (r.insights || []).slice(0, 5).map((ins, i) => db.writeSet(`authors/${uid}/suggestions/insight_${t.slice(0, 10)}_${i}`, { type: 'insight', title: ins.title, body: `${ins.detail} Suggested action: ${ins.action}`, actionType: ins.actionType || 'other', priority: ins.priority || 'medium', status: 'open', createdAt: t }));
      if (writes.length) await db.commit(writes);
      await db.set(`authors/${uid}`, { lastInsights: { at: t, summary: r.summary }, updatedAt: t });
      return json({ ok: true, ...r });
    }
    bad('Unknown AI endpoint');
  }

  if (parts[0] === 'campaigns' && parts[1]) {
    const cid = parts[1]; const action = parts[2];
    const c = await db.get(`authors/${uid}/campaigns/${cid}`);
    if (!c) throw new HttpError(404, 'Campaign not found');
    if (action === 'test' && m === 'POST') {
      const to = body.to || user.email;
      if (!isEmail(to)) bad('Enter a valid address for the test.');
      const r = await sendSingle(env, db, uid, author, { email: to, name: author.penName || 'Reader', sid: 'test' }, { ...c, subject: `[Test] ${c.subject}` }, { kind: 'test', track: false });
      return json({ ok: true, id: r.id, to });
    }
    if (action === 'send' && m === 'POST') {
      if (!author.postalAddress) bad('Add a postal address in Settings first — anti-spam law requires one in every marketing email.');
      if (!c.subject || !c.body) bad('Subject and body are required.');
      if (c.status === 'sent' || c.status === 'sending') bad('This campaign has already been sent.');
      if (body.confirm !== 'SEND') bad('Send was not confirmed.');
      const job = await runSendJob(env, db, uid, cid, 6);
      if (job.status === 'running') ctx.waitUntil(runSendJob(env, db, uid, cid, 20).catch(e => console.error(e)));
      return json({ ok: true, job });
    }
    if (action === 'schedule' && m === 'POST') {
      if (!author.postalAddress) bad('Add a postal address in Settings first — anti-spam law requires one in every marketing email.');
      const at = new Date(body.at || 0);
      if (isNaN(at.getTime())) bad('Invalid date.');
      await scheduleCampaign(env, db, uid, cid, at.toISOString());
      return json({ ok: true, scheduledAt: at.toISOString() });
    }
    if (action === 'unschedule' && m === 'POST') {
      if (c.status !== 'scheduled') bad('Campaign is not scheduled.');
      await db.delete(`schedule/send_${uid}_${cid}`);
      await db.set(`authors/${uid}/campaigns/${cid}`, { status: 'draft', scheduledAt: null, updatedAt: nowIso() });
      return json({ ok: true });
    }
    if (action === 'job' && m === 'GET') return json({ ok: true, job: await db.get(`jobs/${uid}_${cid}`) });
    if (action === 'report' && m === 'POST') { await campaignReport(env, db, uid, cid); return json({ ok: true }); }
    bad('Unknown campaign action');
  }

  if (path === '/deliverability' && m === 'GET') {
    const cd = author.customDomain; const verified = cd && cd.status === 'verified';
    const domain = verified ? cd.domain : env.INK_FROM_DOMAIN;
    const orgDomain = domain.split('.').slice(-2).join('.');
    const doh = async (name, type) => { try { const r = await (await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } })).json(); return (r.Answer || []).map(a => String(a.data).replace(/^"|"$/g, '')); } catch { return []; } };
    const [mx, spf, dkim, dmarcSub, dmarcOrg] = await Promise.all([doh(`send.${domain}`, 'MX'), doh(`send.${domain}`, 'TXT'), doh(`resend._domainkey.${domain}`, 'TXT'), doh(`_dmarc.${domain}`, 'TXT'), doh(`_dmarc.${orgDomain}`, 'TXT')]);
    const dmarc = dmarcSub.find(x => /v=DMARC1/i.test(x)) || dmarcOrg.find(x => /v=DMARC1/i.test(x)) || '';
    const policy = (dmarc.match(/p=(none|quarantine|reject)/i) || [])[1] || null;
    const sent = (await db.query(`authors/${uid}`, 'campaigns', { orderBy: [['sentAt', 'desc']], limit: 20 })).filter(c => c.status === 'sent');
    const tot = sent.reduce((a, c) => { const st = c.stats || {}; a.sent += st.sent || 0; a.bounced += st.bounced || 0; a.complained += st.complained || 0; a.opens += st.uniqueOpens || 0; return a; }, { sent: 0, bounced: 0, complained: 0, opens: 0 });
    const total = author.totalSent || 0;
    const stage = total < 500 ? 'warming' : total < 2000 ? 'building' : 'established';
    return json({ ok: true, domain, usingOwnDomain: !!verified, checks: {
      spf: spf.some(x => /v=spf1/i.test(x)) && mx.length > 0, dkim: dkim.some(x => /p=/.test(x)), dmarc: !!dmarc, dmarcPolicy: policy, dmarcRecord: { name: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:${author.replyTo || author.email || ''}` },
      postalAddress: !!author.postalAddress, replyTo: !!(author.replyTo || author.email), unsubscribe: true, plainText: true,
      bounceRate: tot.sent ? tot.bounced / tot.sent : 0, complaintRate: tot.sent ? tot.complained / tot.sent : 0, openRate: tot.sent ? tot.opens / tot.sent : null,
      totalSent: total, stage, pacePerHour: paceLimit(author) * 12, doubleOptIn: !!author.doubleOptIn
    } });
  }

  if (path === '/domain' && m === 'POST') {
    const domain = String(body.domain || '').toLowerCase().trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) bad('Enter a domain like mail.yourname.com');
    const r = await resend(env, '/domains', { name: domain });
    const records = (r.records || []).map(x => ({ type: x.type, name: x.name, value: x.value, priority: x.priority || null }));
    await db.set(`authors/${uid}`, { customDomain: { domain, resendId: r.id, status: 'pending', records, createdAt: nowIso() }, updatedAt: nowIso() });
    return json({ ok: true, domain, records });
  }
  if (path === '/domain/verify' && m === 'POST') {
    const d = author.customDomain; if (!d || !d.resendId) bad('No custom domain set up.');
    let r;
    try {
      await resend(env, `/domains/${d.resendId}/verify`, null, 'POST').catch(() => { });
      r = await resend(env, `/domains/${d.resendId}`, null, 'GET');
    } catch (e) {
      if (/404|not found/i.test(e.message)) {
        // The Resend entry Ink created no longer exists (deleted or re-created in the Resend dashboard).
        // Look for an entry with the same name and adopt it; otherwise clear so the author can set up again.
        const list = await resend(env, '/domains', null, 'GET').catch(() => ({ data: [] }));
        const match = (list.data || []).find(x => x.name === d.domain);
        if (!match) { await db.set(`authors/${uid}`, { customDomain: null, updatedAt: nowIso() }); bad(`Resend no longer has an entry for ${d.domain} — it was deleted or re-created outside Ink. Click "Set up" again and add the records it shows.`); }
        r = await resend(env, `/domains/${match.id}`, null, 'GET'); d.resendId = match.id; d.adopted = true;
      } else throw e;
    }
    const status = r.status === 'verified' ? 'verified' : (r.status || 'pending');
    const patch = { ...d, status, checkedAt: nowIso(), records: r.records && r.records.length ? r.records.map(x => ({ type: x.type, name: x.name, value: x.value, priority: x.priority || null, status: x.status || null })) : d.records };
    if (status === 'verified' && !d.verifiedAt) patch.verifiedAt = nowIso();
    await db.set(`authors/${uid}`, { customDomain: patch, updatedAt: nowIso() });
    return json({ ok: true, status, records: patch.records });
  }
  if (path === '/domain' && m === 'DELETE') {
    const d = author.customDomain; if (d && d.resendId) await resend(env, `/domains/${d.resendId}`, null, 'DELETE').catch(() => { });
    await db.set(`authors/${uid}`, { customDomain: null, updatedAt: nowIso() });
    return json({ ok: true });
  }

  if (path === '/nudge/run' && m === 'POST') { await nudgeAuthor(env, db, { ...author, id: uid }); return json({ ok: true }); }
  if (path === '/automations/welcome/test' && m === 'POST') {
    const auto = await db.get(`authors/${uid}/automations/welcome`);
    if (!auto || !(auto.steps || []).length) bad('No welcome sequence saved yet.');
    const step = auto.steps[Math.min(Number(body.step || 0), auto.steps.length - 1)];
    const r = await sendSingle(env, db, uid, author, { email: user.email, name: author.penName || 'Reader', sid: 'test' }, { subject: `[Test] ${step.subject}`, previewText: step.previewText, body: step.body }, { kind: 'test', track: false });
    return json({ ok: true, id: r.id });
  }

  throw new HttpError(404, 'Not found');
}

async function readBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) { try { return await request.json(); } catch { return {}; } }
  if (ct.includes('form')) { const f = await request.formData(); const o = {}; for (const [k, v] of f.entries()) o[k] = v; return o; }
  try { return JSON.parse(await request.text()); } catch { return {}; }
}

// ───────────────────────────────────────────────────────────────── cron ──

async function runCron(env, ctx) {
  const db = new Firestore(env); const t = nowIso();
  // 1. due schedule entries (sends + reports)
  const due = await db.query(null, 'schedule', { where: [['at', '<=', t]], limit: 25 });
  for (const s of due) {
    try {
      await db.delete(`schedule/${s.id}`);
      if (s.kind === 'send') {
        const c = await db.get(`authors/${s.uid}/campaigns/${s.cid}`);
        if (c && c.status === 'scheduled') await runSendJob(env, db, s.uid, s.cid, 10);
      } else if (s.kind === 'report') await campaignReport(env, db, s.uid, s.cid);
    } catch (e) { console.error('schedule', s.id, e.message); }
  }
  // 2. unfinished send jobs
  const jobs = await db.query(null, 'jobs', { where: [['status', '==', 'running']], limit: 5 });
  for (const j of jobs) { try { await runSendJob(env, db, j.uid, j.cid, 10); } catch (e) { console.error('job', j.id, e.message); } }
  // 3. automation steps
  const runs = await db.query(null, 'automationRuns', { where: [['nextAt', '<=', t]], limit: 40 });
  for (const r of runs) {
    try {
      const auto = await db.get(`authors/${r.uid}/automations/welcome`);
      const sub = await db.get(`authors/${r.uid}/subscribers/${r.sid}`);
      const author = await db.get(`authors/${r.uid}`);
      if (!auto || !auto.enabled || !sub || sub.status !== 'active' || !author) { await db.delete(`automationRuns/${r.id}`); continue; }
      const step = (auto.steps || [])[r.stepIndex];
      if (!step) { await db.delete(`automationRuns/${r.id}`); continue; }
      await sendSingle(env, db, r.uid, author, sub, { subject: step.subject, previewText: step.previewText || '', body: step.body, id: `welcome-${r.stepIndex}` }, { kind: 'automation' });
      await db.increment(`authors/${r.uid}/automations/welcome`, { [`sentCounts.s${r.stepIndex}`]: 1 });
      const next = (auto.steps || [])[r.stepIndex + 1];
      if (next) await db.set(`automationRuns/${r.id}`, { stepIndex: r.stepIndex + 1, nextAt: addDays(nowIso(), next.delayDays || 1) });
      else await db.delete(`automationRuns/${r.id}`);
    } catch (e) { console.error('automation', r.id, e.message); await db.set(`automationRuns/${r.id}`, { nextAt: addDays(nowIso(), 0.05), lastError: e.message }); }
  }
  // 3b. pending custom sending domains: poll Resend, email the author when verified
  try {
    const pend = await db.query(null, 'authors', { where: [['customDomain.status', '==', 'pending']], limit: 10 });
    for (const a of pend) {
      const d = a.customDomain || {}; if (!d.resendId) continue;
      const lastCheck = d.checkedAt ? new Date(d.checkedAt).getTime() : 0;
      if (Date.now() - lastCheck < 10 * 60e3) continue; // every ~10 minutes per author
      try {
        await resend(env, `/domains/${d.resendId}/verify`, null, 'POST').catch(() => { });
        const r = await resend(env, `/domains/${d.resendId}`, null, 'GET');
        const status = r.status === 'verified' ? 'verified' : (r.status || 'pending');
        const patch = { ...d, status, checkedAt: t, records: r.records && r.records.length ? r.records.map(x => ({ type: x.type, name: x.name, value: x.value, priority: x.priority || null, status: x.status || null })) : d.records };
        if (status === 'verified') {
          patch.verifiedAt = t;
          await db.set(`authors/${a.id}`, { customDomain: patch, updatedAt: t });
          const local = (a.fromLocal || a.slug || 'author').toLowerCase();
          await emailAuthor(env, { ...a, id: a.id, email: a.replyTo || a.email }, `${d.domain} is verified — you now send from your own domain`,
            [`Your DNS records checked out. From now on your letters go out as **${a.fromName || a.penName || 'you'} <${local}@${d.domain}>**, which is the best thing you can do for deliverability and for readers recognising you in the inbox.`,
             `Nothing else to change — Ink switched over automatically. Send yourself a test from any draft to see it.`],
            [{ label: 'Open Ink settings', url: `${env.APP_URL}/#settings` }]);
        } else {
          // gentle nudge once if still pending after 3 days
          const created = d.createdAt ? new Date(d.createdAt).getTime() : Date.now();
          if (!d.remindedPending && Date.now() - created > 3 * 864e5) {
            patch.remindedPending = true;
            await emailAuthor(env, { ...a, id: a.id, email: a.replyTo || a.email }, `${d.domain} still isn't verified`,
              [`It has been three days and Resend still can't see the DNS records for **${d.domain}**. Usually one record was entered with a typo or with the domain name added twice (e.g. "resend._domainkey.${d.domain}.${d.domain}").`,
               `Until it verifies, Ink keeps sending from its shared domain with your name and reply-to, so nothing is blocked — this is only about polish.`],
              [{ label: 'Check the records in Ink', url: `${env.APP_URL}/#settings` }]);
          }
          await db.set(`authors/${a.id}`, { customDomain: patch, updatedAt: t });
        }
      } catch (e) {
        console.error('domain check', a.id, e.message);
        const msg = /404|not found/i.test(e.message) ? `Resend no longer has this domain entry — open Settings and click "Check verification" to re-link it, or "Remove" and set it up again.` : String(e.message).slice(0, 200);
        await db.set(`authors/${a.id}`, { customDomain: { ...d, checkedAt: t, lastError: msg } });
      }
    }
  } catch (e) { console.error('domain poll', e.message); }
  // 4. daily nudges per author
  const authors = await db.query(null, 'authors', { where: [['nudgeNextAt', '<=', t]], limit: 10 });
  for (const a of authors) {
    try { await nudgeAuthor(env, db, a); }
    catch (e) { console.error('nudge', a.id, e.message); await db.set(`authors/${a.id}`, { nudgeNextAt: addDays(t, 0.5), lastNudgeError: e.message }); }
  }
}

export default {
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
      console.error(e);
      return json({ ok: false, error: e.message || 'Server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(env, ctx)); }
};
