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

  CREATE TABLE IF NOT EXISTS backorders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    line_item_id TEXT NOT NULL,
    line_item_title TEXT,
    quantity INTEGER NOT NULL DEFAULT 0,
    eta_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    created_by TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    UNIQUE(order_id, line_item_id)
  );

  CREATE TABLE IF NOT EXISTS order_edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    edited_by TEXT NOT NULL,
    staff_note TEXT,
    changes_json TEXT,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS xero_invoice_map (
    order_id TEXT PRIMARY KEY,
    xero_invoice_id TEXT,
    xero_contact_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    synced_at INTEGER,
    error_text TEXT
  );

  CREATE TABLE IF NOT EXISTS xero_pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retries INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    error_text TEXT
  );

  CREATE TABLE IF NOT EXISTS impersonation_nonces (
    nonce TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    customer_email TEXT,
    customer_display_name TEXT,
    admin_email TEXT NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
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

// ── Backorders ────────────────────────────────────────────────────────────────

export function upsertBackorder(orderId, lineItemId, lineItemTitle, quantity, etaDate, createdBy) {
  db.prepare(`
    INSERT INTO backorders (order_id, line_item_id, line_item_title, quantity, eta_date, status, created_at, created_by, notified)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)
    ON CONFLICT(order_id, line_item_id) DO UPDATE SET
      eta_date = excluded.eta_date, quantity = excluded.quantity, status = 'pending',
      created_at = excluded.created_at, created_by = excluded.created_by
  `).run(orderId, lineItemId, lineItemTitle, quantity, etaDate || null, Date.now(), createdBy);
}

export function getBackordersForOrder(orderId) {
  return db.prepare('SELECT * FROM backorders WHERE order_id = ? AND status = ? ORDER BY created_at DESC')
    .all(orderId, 'pending');
}

export function fulfillBackorder(orderId, lineItemId) {
  db.prepare("UPDATE backorders SET status = 'fulfilled' WHERE order_id = ? AND line_item_id = ?")
    .run(orderId, lineItemId);
}

export function logOrderEdit(orderId, editedBy, staffNote, changesJson) {
  db.prepare('INSERT INTO order_edit_log (order_id, edited_by, staff_note, changes_json, ts) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, editedBy, staffNote || null, JSON.stringify(changesJson), Date.now());
}

// ── Xero accounting ───────────────────────────────────────────────────────────

export function getXeroMap(orderId) {
  return db.prepare('SELECT * FROM xero_invoice_map WHERE order_id = ?').get(orderId) || null;
}

export function setXeroMap(orderId, xeroInvoiceId, xeroContactId, status, errorText = null) {
  db.prepare(`
    INSERT OR REPLACE INTO xero_invoice_map (order_id, xero_invoice_id, xero_contact_id, status, synced_at, error_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(orderId, xeroInvoiceId || null, xeroContactId || null, status, Date.now(), errorText);
}

export function addXeroPending(actionType, payload) {
  return db.prepare(`
    INSERT INTO xero_pending_actions (action_type, payload_json, status, retries, created_at)
    VALUES (?, ?, 'pending', 0, ?)
  `).run(actionType, JSON.stringify(payload), Date.now()).lastInsertRowid;
}

export function getXeroPending(status = 'pending') {
  return db.prepare('SELECT * FROM xero_pending_actions WHERE status = ? ORDER BY created_at ASC').all(status);
}

export function markXeroPendingDone(id) {
  db.prepare("UPDATE xero_pending_actions SET status = 'done', last_attempt_at = ? WHERE id = ?").run(Date.now(), id);
}

export function markXeroPendingFailed(id, errorText, retries) {
  db.prepare(`
    UPDATE xero_pending_actions SET status = 'failed', error_text = ?, retries = ?, last_attempt_at = ? WHERE id = ?
  `).run(String(errorText).slice(0, 500), retries, Date.now(), id);
}

export function getXeroPendingCount() {
  return db.prepare("SELECT COUNT(*) as n FROM xero_pending_actions WHERE status = 'pending'").get().n;
}

export function getXeroInvoiceMaps({ limit = 200 } = {}) {
  return db.prepare('SELECT * FROM xero_invoice_map ORDER BY synced_at DESC LIMIT ?').all(limit);
}

// ── Impersonation nonces ────────────────────────────────────────────────────────

export function createImpersonationNonce({ nonce, customerId, customerEmail, customerDisplayName, adminEmail, readOnly, expiresAt }) {
  db.prepare(`
    INSERT INTO impersonation_nonces (nonce, customer_id, customer_email, customer_display_name, admin_email, read_only, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nonce, customerId, customerEmail || null, customerDisplayName || null, adminEmail, readOnly ? 1 : 0, expiresAt, Date.now());
}

export function consumeImpersonationNonce(nonce) {
  const row = db.prepare('SELECT * FROM impersonation_nonces WHERE nonce = ?').get(nonce);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  db.prepare('UPDATE impersonation_nonces SET used_at = ? WHERE nonce = ?').run(Date.now(), nonce);
  return row;
}

export function gcImpersonationNonces() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h
  db.prepare('DELETE FROM impersonation_nonces WHERE created_at < ?').run(cutoff);
}

