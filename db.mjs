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

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    business_name TEXT,
    contact_name TEXT,
    phone TEXT,
    website TEXT,
    business_type TEXT,
    estimated_monthly_volume_usd INTEGER,
    source TEXT,
    source_detail TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    application_data_json TEXT,
    sales_tax_state TEXT,
    sales_tax_id TEXT,
    custom_tags TEXT,
    assigned_to TEXT,
    next_followup_due TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    converted_at INTEGER,
    shopify_customer_id TEXT,
    rejected_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS lead_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    author_email TEXT NOT NULL,
    body TEXT NOT NULL,
    note_type TEXT NOT NULL DEFAULT 'general',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lead_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    note TEXT,
    changed_by TEXT,
    changed_at INTEGER NOT NULL
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

export function logLabelBatch(email, template, itemCount, totalLabels) {
  db.prepare(`INSERT INTO label_batches (email, ts, template, item_count, total_labels) VALUES (?, ?, ?, ?, ?)`)
    .run(email, Date.now(), template, itemCount, totalLabels);
}

export function logExportBatch(email, type, productCount, rowOrImageCount, bytesOutApprox) {
  db.prepare(`INSERT INTO export_batches (email, ts, type, product_count, row_or_image_count, bytes_out_approx) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(email, Date.now(), type, productCount, rowOrImageCount, bytesOutApprox || 0);
}

// ── Wholesale leads ────────────────────────────────────────────────────────────

export function createLead(fields) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO leads (email, business_name, contact_name, phone, website, business_type,
      estimated_monthly_volume_usd, source, source_detail, status, custom_tags,
      assigned_to, next_followup_due, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
  `).run(
    fields.email, fields.business_name || null, fields.contact_name || null,
    fields.phone || null, fields.website || null, fields.business_type || null,
    fields.estimated_monthly_volume_usd ? parseInt(fields.estimated_monthly_volume_usd, 10) : null,
    fields.source || null, fields.source_detail || null,
    fields.custom_tags || null, fields.assigned_to || null,
    fields.next_followup_due || null, now, now
  );
  return r.lastInsertRowid;
}

export function getLeads({ status, search, limit = 100, offset = 0 } = {}) {
  let where = '1=1';
  const params = [];
  if (status && status !== 'all') { where += ' AND status = ?'; params.push(status); }
  if (search) {
    where += ' AND (email LIKE ? OR business_name LIKE ? OR contact_name LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  return db.prepare(`SELECT * FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

export function getLeadCounts() {
  const rows = db.prepare(`SELECT status, COUNT(*) as n FROM leads GROUP BY status`).all();
  const counts = {};
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
}

export function updateLead(id, fields) {
  const allowed = ['email','business_name','contact_name','phone','website','business_type',
    'estimated_monthly_volume_usd','source','source_detail','status','custom_tags',
    'assigned_to','next_followup_due','converted_at','shopify_customer_id','rejected_reason'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  vals.push(Date.now(), id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function addLeadNote(leadId, authorEmail, body, noteType = 'general') {
  return db.prepare(`INSERT INTO lead_notes (lead_id, author_email, body, note_type, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(leadId, authorEmail, body, noteType, Date.now()).lastInsertRowid;
}

export function getLeadNotes(leadId) {
  return db.prepare('SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at ASC').all(leadId);
}

export function addLeadStatusHistory(leadId, fromStatus, toStatus, note, changedBy) {
  db.prepare(`INSERT INTO lead_status_history (lead_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(leadId, fromStatus || null, toStatus, note || null, changedBy || null, Date.now());
}

export function getLeadStatusHistory(leadId) {
  return db.prepare('SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY changed_at ASC').all(leadId);
}
