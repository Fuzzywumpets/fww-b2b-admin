import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.B2B_ADMIN_MOCK === '1';

let db;
if (MOCK) {
  db = new Database(':memory:');
} else {
  const DATA_DIR = path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'admin.db'));
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    sid TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    picture TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    before_val TEXT,
    after_val TEXT,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customer_notes (
    customer_id TEXT PRIMARY KEY,
    body TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dropship_config_cache (
    customer_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    margin_pct REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '__global__',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, email)
  );

  CREATE TABLE IF NOT EXISTS label_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts INTEGER NOT NULL,
    template TEXT,
    item_count INTEGER DEFAULT 0,
    total_labels INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS export_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    product_count INTEGER DEFAULT 0,
    row_or_image_count INTEGER DEFAULT 0,
    bytes_out_approx INTEGER DEFAULT 0
  );
`);

export default db;

export function createSession(sid, email, displayName, picture) {
  const now = Date.now();
  const expires = now + 7 * 24 * 60 * 60 * 1000;
  db.prepare(`
    INSERT OR REPLACE INTO admin_sessions (sid, email, display_name, picture, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sid, email, displayName || email, picture || '', now, expires);
}

export function getSession(sid) {
  if (!sid) return null;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE sid = ?').get(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE sid = ?').run(sid);
    return null;
  }
  return row;
}

export function deleteSession(sid) {
  db.prepare('DELETE FROM admin_sessions WHERE sid = ?').run(sid);
}

export function auditLog(email, action, target, before, after) {
  db.prepare(`
    INSERT INTO admin_audit_log (email, action, target, before_val, after_val, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    email,
    action,
    target ?? null,
    before !== undefined && before !== null ? JSON.stringify(before) : null,
    after !== undefined && after !== null ? JSON.stringify(after) : null,
    Date.now()
  );
}

export function getCustomerNotes(customerId) {
  return db.prepare('SELECT * FROM customer_notes WHERE customer_id = ?').get(customerId) || null;
}

export function setCustomerNotes(customerId, body, email) {
  db.prepare(`
    INSERT OR REPLACE INTO customer_notes (customer_id, body, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
  `).run(customerId, body, Date.now(), email);
}

export function getDropshipCache(customerId) {
  return db.prepare('SELECT * FROM dropship_config_cache WHERE customer_id = ?').get(customerId) || null;
}

export function setDropshipCache(customerId, enabled, marginPct) {
  db.prepare(`
    INSERT OR REPLACE INTO dropship_config_cache (customer_id, enabled, margin_pct, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(customerId, enabled ? 1 : 0, Number(marginPct) || 0, Date.now());
}

export function getSetting(key, email = '__global__') {
  const row = db.prepare('SELECT value FROM admin_settings WHERE key = ? AND email = ?').get(key, email);
  return row ? row.value : null;
}

export function setSetting(key, value, email = '__global__') {
  db.prepare(`
    INSERT OR REPLACE INTO admin_settings (key, value, email, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(key, String(value), email, Date.now());
}

export function getGlobalSettings() {
  const rows = db.prepare("SELECT key, value FROM admin_settings WHERE email = '__global__'").all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export function getAuditLog({ limit = 100, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM admin_audit_log ORDER BY ts DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function getAuditLogCount() {
  return db.prepare('SELECT COUNT(*) as n FROM admin_audit_log').get().n;
}
