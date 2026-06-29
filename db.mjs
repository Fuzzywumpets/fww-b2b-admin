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

  -- Phase 16H: incremental order-edit action ledger.
  -- The UNIQUE idem_key is the dedupe spine that kills the double-add hazard for id-less
  -- new rows: a committed action is never re-staged — its stored result_json is replayed.
  CREATE TABLE IF NOT EXISTS order_edit_action (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idem_key TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT,
    result_json TEXT,
    status TEXT NOT NULL,
    edited_by TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oea_order ON order_edit_action(order_id);

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

  CREATE TABLE IF NOT EXISTS partial_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    invoice_letter TEXT NOT NULL,
    invoice_type TEXT NOT NULL DEFAULT 'fulfilled_only',
    total REAL NOT NULL DEFAULT 0,
    shipping REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    line_items_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    sent_at INTEGER
  );

  -- Phase 24A + 25A: local cache tables (Shopify mirror for fast queries)

  CREATE TABLE IF NOT EXISTS customers_cache (
    shopify_id TEXT PRIMARY KEY,
    gid TEXT NOT NULL,
    email TEXT,
    first_name TEXT,
    last_name TEXT,
    display_name TEXT,
    company TEXT,
    tags TEXT,
    is_b2b INTEGER,
    amount_spent_total REAL,
    orders_count INTEGER,
    first_order_at INTEGER,
    last_order_at INTEGER,
    default_address_json TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_customers_cache_b2b ON customers_cache(is_b2b, amount_spent_total DESC);
  CREATE INDEX IF NOT EXISTS idx_customers_cache_email ON customers_cache(email);
  CREATE INDEX IF NOT EXISTS idx_customers_cache_last_order ON customers_cache(last_order_at DESC);

  CREATE TABLE IF NOT EXISTS orders_cache (
    shopify_id TEXT PRIMARY KEY,
    gid TEXT NOT NULL,
    name TEXT,
    customer_shopify_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    processed_at INTEGER,
    cancelled_at INTEGER,
    closed_at INTEGER,
    financial_status TEXT,
    fulfillment_status TEXT,
    display_financial_status TEXT,
    display_fulfillment_status TEXT,
    total_price REAL,
    subtotal_price REAL,
    total_tax REAL,
    total_shipping REAL,
    total_discounts REAL,
    total_refunded REAL,
    currency TEXT,
    tags TEXT,
    source_name TEXT,
    channel_name TEXT,
    note TEXT,
    shipping_address_json TEXT,
    billing_address_json TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    fulfillments_json TEXT,
    refunds_json TEXT,
    metafields_json TEXT,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_cache_customer ON orders_cache(customer_shopify_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_cache_created ON orders_cache(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_cache_status ON orders_cache(financial_status, fulfillment_status);
  CREATE INDEX IF NOT EXISTS idx_orders_cache_source ON orders_cache(source_name);

  CREATE TABLE IF NOT EXISTS order_line_items_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_shopify_id TEXT NOT NULL,
    line_id TEXT,
    variant_shopify_id TEXT,
    product_shopify_id TEXT,
    sku TEXT,
    title TEXT,
    variant_title TEXT,
    quantity INTEGER,
    price REAL,
    total_discount REAL,
    taxable INTEGER,
    vendor TEXT,
    is_fww_vendor INTEGER,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lineitems_cache_order ON order_line_items_cache(order_shopify_id);
  CREATE INDEX IF NOT EXISTS idx_lineitems_cache_sku ON order_line_items_cache(sku);
  CREATE INDEX IF NOT EXISTS idx_lineitems_cache_fww ON order_line_items_cache(is_fww_vendor);

  CREATE TABLE IF NOT EXISTS sync_state (
    resource TEXT PRIMARY KEY,
    last_synced_at INTEGER NOT NULL,
    last_cursor TEXT,
    total_synced INTEGER,
    last_error TEXT,
    last_error_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS products_cache (
    shopify_id TEXT PRIMARY KEY,
    gid TEXT NOT NULL,
    handle TEXT,
    title TEXT,
    vendor TEXT,
    product_type TEXT,
    status TEXT,
    tags TEXT,
    publications_json TEXT,
    variants_json TEXT,
    images_json TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_products_cache_vendor ON products_cache(vendor);
  CREATE INDEX IF NOT EXISTS idx_products_cache_status ON products_cache(status);
  CREATE INDEX IF NOT EXISTS idx_products_cache_handle ON products_cache(handle);
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

// WHAT: sums orders_cache.total_price for a customer across PENDING/PARTIALLY_PAID/UNPAID, non-cancelled orders (the customer-detail outstanding-balance widget).
// CHANGE-GUARD: customer_shopify_id stores the NUMERIC id, but renderCustomerDetail calls this with customer.id which is a gid:// GID — the WHERE never matches and the widget always shows $0 (see bugs[]); pass shopifyNumericId(customer.id).
// INVARIANT(S): the status list must match the financial_status strings Shopify actually returns; total is ROUND()ed to 2dp; cancelled orders must be excluded.
export function getOutstandingBalanceForCustomer(customerId) {
  const rows = db.prepare(
    'SELECT ROUND(SUM(total_price), 2) AS total, COUNT(*) AS count FROM orders_cache WHERE customer_shopify_id = ? AND cancelled_at IS NULL AND financial_status IN (\'PENDING\',\'PARTIALLY_PAID\',\'UNPAID\')'
  ).get(customerId);
  return { total: rows?.total || 0, count: rows?.count || 0 };
}

export function getOpenBackorders() {
  return db.prepare('SELECT * FROM backorders WHERE status = ? ORDER BY created_at ASC')
    .all('pending');
}

export function fulfillBackorder(orderId, lineItemId) {
  db.prepare("UPDATE backorders SET status = 'fulfilled' WHERE order_id = ? AND line_item_id = ?")
    .run(orderId, lineItemId);
}

export function logOrderEdit(orderId, editedBy, staffNote, changesJson) {
  db.prepare('INSERT INTO order_edit_log (order_id, edited_by, staff_note, changes_json, ts) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, editedBy, staffNote || null, JSON.stringify(changesJson), Date.now());
}

// Phase 16H: incremental order-edit action ledger (idempotency + audit).
// getEditAction returns the row for an idem_key (or null). A row with status='committed'
// means the action already ran and MUST NOT be re-staged — replay result_json verbatim.
export function getEditAction(idemKey) {
  if (!idemKey) return null;
  return db.prepare('SELECT * FROM order_edit_action WHERE idem_key = ?').get(idemKey) || null;
}

// putEditAction upserts on idem_key. status: 'committed' | 'failed'. payload/result are
// objects (JSON-serialized here). A failed row may later be overwritten by a retry.
export function putEditAction({ idemKey, orderId, action, payload, result, status, editedBy }) {
  db.prepare(`
    INSERT INTO order_edit_action (idem_key, order_id, action, payload_json, result_json, status, edited_by, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idem_key) DO UPDATE SET
      order_id = excluded.order_id, action = excluded.action, payload_json = excluded.payload_json,
      result_json = excluded.result_json, status = excluded.status, edited_by = excluded.edited_by, ts = excluded.ts
  `).run(
    idemKey, orderId, action,
    payload != null ? JSON.stringify(payload) : null,
    result != null ? JSON.stringify(result) : null,
    status, editedBy || null, Date.now()
  );
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

// WHAT: atomically validates-and-burns an impersonation nonce (rejects unknown, already-used, or expired), returning the row exactly once.
// CHANGE-GUARD: the SELECT-then-UPDATE is not wrapped in a transaction — two concurrent portal redemptions could both read used_at:null before either writes; acceptable today (single-use links, low concurrency) but re-test if impersonation volume rises.
// INVARIANT(S): a nonce must be redeemable at most once; expiry (expires_at) and used_at are both hard gates; gcImpersonationNonces prunes rows older than 2h independently.
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

// ── Partial invoices ────────────────────────────────────────────────────────

export function getNextInvoiceLetter(orderId) {
  const rows = db.prepare('SELECT invoice_letter FROM partial_invoices WHERE order_id = ? ORDER BY created_at ASC').all(orderId);
  const used = new Set(rows.map(r => r.invoice_letter));
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return 'Z';
}

export function createPartialInvoice({ orderId, invoiceLetter, invoiceType, total, shipping, tax, lineItemsJson, createdBy }) {
  return db.prepare(`
    INSERT INTO partial_invoices (order_id, invoice_letter, invoice_type, total, shipping, tax, line_items_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, invoiceLetter, invoiceType || 'fulfilled_only', total, shipping || 0, tax || 0, lineItemsJson || '[]', Date.now(), createdBy).lastInsertRowid;
}

export function getPartialInvoices(orderId) {
  return db.prepare('SELECT * FROM partial_invoices WHERE order_id = ? ORDER BY created_at ASC').all(orderId);
}

// ── Second build (Build D): read-only order-history timeline ───────────────────
// WHAT: assembles a newest-first activity timeline for ONE order by UNIONing three
//   tables: (a) order_edit_log — the canonical committed-edit ledger (every edit path,
//   legacy batch AND Phase-16H incremental, writes here); (b) order_edit_action — the
//   incremental idempotency ledger, used here ONLY as a graceful fallback when
//   order_edit_log has no rows for the order (today every committed action double-writes
//   to BOTH, so unioning it unconditionally would DOUBLE-list every auto-saved edit —
//   see the live DB: order #7025395859691 has the same line/add in both tables 1ms apart);
//   (c) admin_audit_log — NON-edit audit verbs only (mark_paid / record_manual_payment /
//   order_cancel / create_order / partial_invoice_created / xero:* / visible-note-add …).
// CHANGE-GUARD: this is the de-dupe spine. The order-edit audit verbs (order_edit and the
//   order_edit_line_* / order_edit_discount incremental verbs) are EXCLUDED from the
//   admin_audit_log pull because each of those rows duplicates a row already counted from
//   order_edit_log — including them would double/triple-list a single edit. If a new
//   edit-path audit verb is added, add it to EDIT_AUDIT_ACTIONS below or it will surface twice.
// INVARIANT(S): pure reads, no writes. Every table access is wrapped so a missing table
//   (e.g. order_edit_action on an older DB) degrades to []. Returns rows shaped as
//   { kind, actor, ts, ...} sorted by ts DESC. JSON parsing is delegated to the caller's
//   summarizers — this helper only attaches the raw stored strings.
const EDIT_AUDIT_ACTIONS = new Set([
  'order_edit',
  'order_edit_line_add', 'order_edit_line_custom', 'order_edit_line_qty',
  'order_edit_line_price', 'order_edit_line_remove', 'order_edit_discount',
]);

export function getOrderHistory(orderGid) {
  if (!orderGid) return [];
  const events = [];

  // (a) order_edit_log — canonical committed edits (legacy batch + incremental auto-save).
  let editLogRows = [];
  try {
    editLogRows = db.prepare(
      'SELECT order_id, edited_by, staff_note, changes_json, ts FROM order_edit_log WHERE order_id = ? ORDER BY ts DESC'
    ).all(orderGid);
  } catch { editLogRows = []; }
  for (const r of editLogRows) {
    events.push({ kind: 'edit', actor: r.edited_by, ts: r.ts, staffNote: r.staff_note || null, changesJson: r.changes_json || null });
  }

  // (b) order_edit_action — incremental ledger; FALLBACK ONLY when order_edit_log is empty
  //     for this order (avoids double-listing, since committed actions write to both today).
  //     Guarded: a DB without this table (or without these columns) degrades silently to [].
  if (editLogRows.length === 0) {
    try {
      const actionRows = db.prepare(
        "SELECT order_id, action, payload_json, edited_by, ts FROM order_edit_action WHERE order_id = ? AND status = 'committed' ORDER BY ts DESC"
      ).all(orderGid);
      for (const r of actionRows) {
        events.push({ kind: 'edit_action', actor: r.edited_by, ts: r.ts, action: r.action, payloadJson: r.payload_json || null });
      }
    } catch { /* table absent or schema differs — degrade gracefully */ }
  }

  // (c) admin_audit_log — NON-edit verbs only (edits are covered by (a)/(b) above).
  let auditRows = [];
  try {
    auditRows = db.prepare(
      'SELECT email, action, before_val, after_val, ts FROM admin_audit_log WHERE target = ? ORDER BY ts DESC'
    ).all(orderGid);
  } catch { auditRows = []; }
  for (const r of auditRows) {
    if (EDIT_AUDIT_ACTIONS.has(r.action)) continue; // de-dupe: already counted as an edit
    events.push({ kind: 'audit', actor: r.email, ts: r.ts, action: r.action, beforeJson: r.before_val || null, afterJson: r.after_val || null });
  }

  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return events;
}

// ── Phase 24: Cache helpers ────────────────────────────────────────────────────

export function upsertCustomerCache(c) {
  const tags = Array.isArray(c.tags) ? c.tags.join(',') : (c.tags || '');
  db.prepare(`
    INSERT OR REPLACE INTO customers_cache
    (shopify_id, gid, email, first_name, last_name, display_name, company, tags, is_b2b,
     amount_spent_total, orders_count, first_order_at, last_order_at, default_address_json,
     created_at, updated_at, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    c.shopify_id, c.gid, c.email || null, c.first_name || null, c.last_name || null,
    c.display_name || null, c.company || null, tags,
    tags.split(',').includes('b2b') ? 1 : 0,
    c.amount_spent_total || 0, c.orders_count || 0,
    c.first_order_at || null, c.last_order_at || null,
    c.default_address_json ? JSON.stringify(c.default_address_json) : null,
    c.created_at || null, c.updated_at || null, Date.now()
  );
}

export function getCustomerFromCache(shopifyId) {
  return db.prepare('SELECT * FROM customers_cache WHERE shopify_id = ?').get(shopifyId) || null;
}

export function listCustomersFromCache(filters = {}) {
  const where = [];
  const params = [];
  if (filters.segment === 'b2b') where.push('is_b2b = 1');
  else if (filters.segment === 'has_orders') where.push('orders_count > 0');
  else if (filters.segment === 'no_orders') where.push('orders_count = 0');
  if (filters.q) {
    where.push('(LOWER(display_name) LIKE ? OR LOWER(email) LIKE ?)');
    const q = '%' + filters.q.toLowerCase() + '%';
    params.push(q, q);
  }
  if (filters.tag) {
    where.push('tags LIKE ?');
    params.push('%' + filters.tag + '%');
  }
  let orderBy = 'amount_spent_total DESC';
  if (filters.sort === 'name_asc') orderBy = 'display_name ASC';
  else if (filters.sort === 'orders_desc') orderBy = 'orders_count DESC';
  const sql = `SELECT * FROM customers_cache ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT 100`;
  const rows = db.prepare(sql).all(...params);
  // Map to the shape getCustomersData returns (matching live Shopify GraphQL response)
  return rows.map(r => ({
    id: r.gid,
    displayName: (r.company && r.company.trim()) ? r.company.trim() : r.display_name,
    personalName: r.display_name,
    company: r.company,
    email: r.email,
    phone: null,
    tags: (r.tags || '').split(',').filter(Boolean),
    numberOfOrders: r.orders_count || 0,
    amountSpent: { amount: String(r.amount_spent_total || 0), currencyCode: 'USD' },
    defaultAddress: r.default_address_json ? JSON.parse(r.default_address_json) : null,
    metafields: { edges: [] },
    _fromCache: true,
    _syncedAt: r.synced_at,
  }));
}

// WHAT: B2B-only order list (joins customers_cache where is_b2b=1) with q/status/date filters, feeding the /orders page and CSV.
// CHANGE-GUARD: LIMIT 200 is hardcoded with no offset/cursor — beyond 200 matching orders are silently dropped and getOrdersData reports hasNextPage:false (see bugs[]); re-test filter SQL after any status-enum change.
// INVARIANT(S): the is_b2b=1 join is the B2B scoping guarantee — never widen it without an explicit segment flag; status buckets must mirror FINANCIAL_STATUS_FILTER in server.mjs; q is parameterized (no injection) but the LIKE has no escaping of %/_ .
export function listOrdersFromCache(filters = {}) {
  // Phase 24D: B2B-only — joins customers_cache where is_b2b=1
  const where = ['c.is_b2b = 1'];
  const params = [];
  if (filters.q) {
    where.push("(o.name LIKE ? OR LOWER(c.display_name) LIKE ? OR LOWER(c.email) LIKE ? OR LOWER(COALESCE(c.company,'')) LIKE ?)");
    const q = '%' + filters.q.toLowerCase() + '%';
    params.push('%' + filters.q + '%', q, q, q);
  }
  if (filters.status === 'open') {
    where.push("(o.financial_status IN ('PENDING','AUTHORIZED','PARTIALLY_PAID','UNPAID') OR o.financial_status IS NULL)");
  } else if (filters.status === 'pending') {
    where.push("o.financial_status IN ('PENDING','AUTHORIZED')");
  } else if (filters.status === 'paid') {
    where.push("o.financial_status = 'PAID'");
  } else if (filters.status === 'refunded') {
    where.push("o.financial_status IN ('REFUNDED','PARTIALLY_REFUNDED')");
  } else if (filters.status === 'voided') {
    where.push("o.financial_status = 'VOIDED'");
  }
  if (filters.date) {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.date];
    if (days) {
      const cutoff = Date.now() - days * 86400000;
      where.push('o.created_at >= ?');
      params.push(cutoff);
    }
  }
  const sql = `SELECT o.*, c.display_name AS customer_display_name, c.email AS customer_email_cached, c.company AS customer_company
               FROM orders_cache o
               JOIN customers_cache c ON o.customer_shopify_id = c.shopify_id
               WHERE ${where.join(' AND ')}
               ORDER BY o.created_at DESC LIMIT 200`;
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    id: r.gid,
    name: r.name,
    processedAt: new Date(r.processed_at || r.created_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    customer: r.customer_shopify_id ? {
      id: 'gid://shopify/Customer/' + r.customer_shopify_id,
      displayName: (r.customer_company && r.customer_company.trim()) ? r.customer_company.trim() : r.customer_display_name,
      personalName: r.customer_display_name,
      company: r.customer_company,
      email: r.customer_email_cached,
    } : null,
    displayFinancialStatus: r.financial_status || r.display_financial_status,
    displayFulfillmentStatus: r.fulfillment_status || r.display_fulfillment_status,
    totalPriceSet: { presentmentMoney: { amount: String(r.total_price || 0), currencyCode: r.currency || 'USD' } },
    sourceName: r.source_name,
    note: r.note,
    tags: (r.tags || '').split(',').filter(Boolean),
    lineItems: { edges: [] },
    _fromCache: true,
  }));
}

export function getOrdersCacheStats() {
  return db.prepare('SELECT COUNT(*) AS total, MAX(synced_at) AS latest FROM orders_cache').get();
}

export function getCustomerOrdersFromCache(customerShopifyId, opts = {}) {
  let sql = 'SELECT * FROM orders_cache WHERE customer_shopify_id = ?';
  const params = [customerShopifyId];
  if (opts.from) { sql += ' AND created_at >= ?'; params.push(opts.from); }
  if (opts.to)   { sql += ' AND created_at <= ?'; params.push(opts.to); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

export function getCustomerCacheStats() {
  return db.prepare('SELECT COUNT(*) AS total, MAX(synced_at) AS latest FROM customers_cache').get();
}

export function getCustomersCountInCache() {
  return db.prepare('SELECT COUNT(*) as n FROM customers_cache').get().n;
}

export function upsertOrderCache(o) {
  db.prepare(`
    INSERT OR REPLACE INTO orders_cache
    (shopify_id, gid, name, customer_shopify_id, created_at, updated_at, processed_at,
     cancelled_at, closed_at, financial_status, fulfillment_status, display_financial_status,
     display_fulfillment_status, total_price, subtotal_price, total_tax, total_shipping,
     total_discounts, total_refunded, currency, tags, source_name, channel_name, note,
     shipping_address_json, billing_address_json, customer_email, customer_phone,
     fulfillments_json, refunds_json, metafields_json, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    o.shopify_id, o.gid, o.name || null, o.customer_shopify_id || null,
    o.created_at || null, o.updated_at || null, o.processed_at || null,
    o.cancelled_at || null, o.closed_at || null,
    o.financial_status || null, o.fulfillment_status || null,
    o.display_financial_status || null, o.display_fulfillment_status || null,
    o.total_price || 0, o.subtotal_price || 0, o.total_tax || 0, o.total_shipping || 0,
    o.total_discounts || 0, o.total_refunded || 0, o.currency || 'USD',
    Array.isArray(o.tags) ? o.tags.join(',') : (o.tags || ''),
    o.source_name || null, o.channel_name || null, o.note || null,
    o.shipping_address_json ? JSON.stringify(o.shipping_address_json) : null,
    o.billing_address_json ? JSON.stringify(o.billing_address_json) : null,
    o.customer_email || null, o.customer_phone || null,
    o.fulfillments_json ? JSON.stringify(o.fulfillments_json) : null,
    o.refunds_json ? JSON.stringify(o.refunds_json) : null,
    o.metafields_json ? JSON.stringify(o.metafields_json) : null,
    Date.now()
  );
}

// WHAT: replaces the cached line items for an order (INSERT OR REPLACE per row keyed by autoincrement id).
// CHANGE-GUARD: there is NO delete-before-insert of stale rows for the order — because the PK is a synthetic autoincrement, editing an order down to fewer lines leaves orphaned old line rows in the cache, inflating product-revenue reports; re-test reports after an order edit.
// INVARIANT(S): is_fww_vendor is derived from vendor === 'Fuzzywumpets' (string-literal coupling shared with the backfill scripts); quantity/price default to 0; taxable normalized to 0/1.
export function upsertOrderLineItemsCache(orderShopifyId, lineItems) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO order_line_items_cache
    (order_shopify_id, line_id, variant_shopify_id, product_shopify_id, sku, title,
     variant_title, quantity, price, total_discount, taxable, vendor, is_fww_vendor, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = Date.now();
  for (const li of lineItems) {
    stmt.run(
      orderShopifyId, li.line_id || null, li.variant_shopify_id || null,
      li.product_shopify_id || null, li.sku || null, li.title || null,
      li.variant_title || null, li.quantity || 0, li.price || 0,
      li.total_discount || 0, li.taxable ? 1 : 0, li.vendor || null,
      li.vendor === 'Fuzzywumpets' ? 1 : 0, now
    );
  }
}

export function getOrdersFromCache({ customerId, from, to, limit = 250, offset = 0 } = {}) {
  let where = '1=1';
  const params = [];
  if (customerId) { where += ' AND customer_shopify_id = ?'; params.push(customerId); }
  if (from)       { where += ' AND created_at >= ?'; params.push(new Date(from).getTime()); }
  if (to)         { where += ' AND created_at <= ?'; params.push(new Date(to).getTime()); }
  return db.prepare(`SELECT * FROM orders_cache WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

export function getOrderFromCache(shopifyId) {
  return db.prepare('SELECT * FROM orders_cache WHERE shopify_id = ?').get(shopifyId) || null;
}

export function getOrderByName(nameOrNumber) {
  // Accepts '#37055' or '37055'
  const withHash    = nameOrNumber.startsWith('#') ? nameOrNumber : '#' + nameOrNumber;
  const withoutHash = nameOrNumber.startsWith('#') ? nameOrNumber.slice(1) : nameOrNumber;
  return db.prepare('SELECT shopify_id FROM orders_cache WHERE name = ? OR name = ? LIMIT 1').get(withHash, withoutHash) || null;
}

export function getOrderSpendFromCache(customerId, from, to) {
  let where = 'customer_shopify_id = ? AND cancelled_at IS NULL';
  const params = [customerId];
  if (from) { where += ' AND created_at >= ?'; params.push(new Date(from).getTime()); }
  if (to)   { where += ' AND created_at <= ?'; params.push(new Date(to).getTime()); }
  return db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(total_price), 0) as total
    FROM orders_cache WHERE ${where}
  `).get(...params) || { count: 0, total: 0 };
}

export function getOrdersCountInCache() {
  return db.prepare('SELECT COUNT(*) as n FROM orders_cache').get().n;
}

export function upsertProductCache(p) {
  db.prepare(`
    INSERT OR REPLACE INTO products_cache
    (shopify_id, gid, handle, title, vendor, product_type, status, tags,
     publications_json, variants_json, images_json, created_at, updated_at, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    p.shopify_id, p.gid, p.handle || null, p.title || null, p.vendor || null,
    p.product_type || null, p.status || 'active',
    Array.isArray(p.tags) ? p.tags.join(',') : (p.tags || ''),
    p.publications_json ? JSON.stringify(p.publications_json) : null,
    p.variants_json ? JSON.stringify(p.variants_json) : null,
    p.images_json ? JSON.stringify(p.images_json) : null,
    p.created_at || null, p.updated_at || null, Date.now()
  );
}

export function getProductsCountInCache() {
  return db.prepare('SELECT COUNT(*) as n FROM products_cache').get().n;
}

export function getSyncState(resource) {
  return db.prepare('SELECT * FROM sync_state WHERE resource = ?').get(resource) || null;
}

// WHAT: upserts per-resource sync bookkeeping (last_synced_at, cursor, total, last_error) used by the poller and the backfill scripts to resume.
// CHANGE-GUARD: last_cursor and total_synced use COALESCE(excluded,...) so passing them as null PRESERVES the prior value — callers clearing a cursor must pass an explicit sentinel, not null; re-test resume-after-full-sync logic in backfill-shopify.mjs.
// INVARIANT(S): last_error_at only advances when last_error is non-null; lastSyncedAt defaults to now(); the 'orders_recent' resource row is owned by the live poller, distinct from the backfill 'orders' row.
export function setSyncState(resource, { lastSyncedAt, lastCursor, totalSynced, lastError } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO sync_state (resource, last_synced_at, last_cursor, total_synced, last_error, last_error_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      last_cursor = COALESCE(excluded.last_cursor, last_cursor),
      total_synced = COALESCE(excluded.total_synced, total_synced),
      last_error = excluded.last_error,
      last_error_at = CASE WHEN excluded.last_error IS NOT NULL THEN ? ELSE last_error_at END
  `).run(
    resource, lastSyncedAt || now, lastCursor || null, totalSynced || null,
    lastError || null, now, now
  );
}

export function getAllInvoicesForList({ limit = 200, offset = 0 } = {}) {
  return db.prepare(`
    SELECT o.shopify_id, o.name, o.customer_shopify_id, o.customer_email,
           o.created_at, o.total_price, o.financial_status, o.display_financial_status,
           o.tags, 'shopify' as invoice_type, null as invoice_letter,
           c.display_name as customer_name
    FROM orders_cache o
    LEFT JOIN customers_cache c ON o.customer_shopify_id = c.shopify_id
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function getPartialInvoicesAll({ limit = 200, offset = 0 } = {}) {
  return db.prepare(`
    SELECT pi.*, o.name as order_name, o.customer_email, c.display_name as customer_name
    FROM partial_invoices pi
    LEFT JOIN orders_cache o ON pi.order_id = ('gid://shopify/Order/' || o.shopify_id)
    LEFT JOIN customers_cache c ON o.customer_shopify_id = c.shopify_id
    ORDER BY pi.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

// WHAT: SQL-side 12-month B2B revenue rollup — monthly series, top-20 customers, top-50 products, and headline totals — all scoped to is_b2b=1 and cancelled_at IS NULL.
// CHANGE-GUARD: product aggregation groups by COALESCE(sku,title) and depends on the line-items cache being free of stale rows (see upsertOrderLineItemsCache guard); re-verify totals against Shopify after schema or vendor-tagging changes.
// INVARIANT(S): the month grid is pre-seeded for all 12 months so gaps render as zero; revenue uses total_price (order-level) for customers/totals but price*quantity (line-level) for products — these two bases can legitimately differ.
export function getReportsDataFromCache() {
  // Phase 24F: SQL-side aggregation of last 12 months
  const now = new Date();
  const cutoff = new Date(now); cutoff.setMonth(now.getMonth() - 11); cutoff.setDate(1); cutoff.setHours(0,0,0,0);
  const cutoffMs = cutoff.getTime();

  const monthRows = db.prepare(`
    SELECT strftime('%Y-%m', datetime(o.created_at/1000, 'unixepoch')) AS month,
           ROUND(SUM(o.total_price), 2) AS revenue,
           COUNT(*) AS orders
    FROM orders_cache o JOIN customers_cache c ON o.customer_shopify_id = c.shopify_id
    WHERE c.is_b2b = 1 AND o.cancelled_at IS NULL AND o.created_at >= ?
    GROUP BY month ORDER BY month
  `).all(cutoffMs);
  const monthMap = new Map();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now); d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    monthMap.set(key, { month: key, revenue: 0, orders: 0 });
  }
  for (const r of monthRows) {
    if (monthMap.has(r.month)) monthMap.set(r.month, { month: r.month, revenue: r.revenue, orders: r.orders });
  }
  const monthly = [...monthMap.values()];

  const customerRows = db.prepare(`
    SELECT c.shopify_id AS id,
           COALESCE(NULLIF(TRIM(c.company), ''), c.display_name) AS name,
           c.email AS email,
           ROUND(SUM(o.total_price), 2) AS revenue,
           COUNT(o.shopify_id) AS orders,
           ROUND(AVG(o.total_price), 2) AS aov
    FROM customers_cache c LEFT JOIN orders_cache o ON o.customer_shopify_id = c.shopify_id AND o.cancelled_at IS NULL
    WHERE c.is_b2b = 1
    GROUP BY c.shopify_id
    HAVING revenue > 0
    ORDER BY revenue DESC LIMIT 20
  `).all();
  const customers = customerRows.map(r => ({
    id: r.id, name: r.name, email: r.email,
    revenue: r.revenue || 0, orders: r.orders || 0, aov: Math.round(r.aov || 0),
  }));

  const productRows = db.prepare(`
    SELECT li.title AS title, li.sku AS sku,
           ROUND(SUM(li.price * li.quantity), 2) AS revenue,
           SUM(li.quantity) AS units
    FROM order_line_items_cache li
    JOIN orders_cache o ON o.shopify_id = li.order_shopify_id
    JOIN customers_cache c ON c.shopify_id = o.customer_shopify_id
    WHERE c.is_b2b = 1 AND o.cancelled_at IS NULL
    GROUP BY COALESCE(li.sku, li.title)
    ORDER BY revenue DESC LIMIT 50
  `).all();
  const products = productRows.map(r => ({
    title: r.title, sku: r.sku || '', revenue: r.revenue || 0, units: r.units || 0,
  }));

  const totalsRow = db.prepare(`
    SELECT ROUND(SUM(o.total_price), 2) AS revenue, COUNT(*) AS orders
    FROM orders_cache o JOIN customers_cache c ON c.shopify_id = o.customer_shopify_id
    WHERE c.is_b2b = 1 AND o.cancelled_at IS NULL AND o.created_at >= ?
  `).get(cutoffMs);

  return {
    monthly, customers, products,
    totalRevenue: totalsRow?.revenue || 0,
    totalOrders:  totalsRow?.orders  || 0,
    aov: totalsRow?.orders ? Math.round(totalsRow.revenue / totalsRow.orders) : 0,
    _fromCache: true,
  };
}

export function getTopCustomersAllTime(limit = 5) {
  // All-time top B2B customers by lifetime spend (from cached customer records,
  // which mirror Shopify customer.amountSpent — so this is true lifetime, not just cached orders).
  return db.prepare(`
    SELECT shopify_id AS id,
           COALESCE(NULLIF(TRIM(company), ''), display_name) AS name,
           email,
           amount_spent_total AS spend,
           orders_count AS orders
    FROM customers_cache
    WHERE is_b2b = 1 AND amount_spent_total > 0
    ORDER BY amount_spent_total DESC
    LIMIT ?
  `).all(limit).map(r => ({
    id: 'gid://shopify/Customer/' + r.id,
    name: r.name, email: r.email,
    spend: r.spend || 0, orders: r.orders || 0,
  }));
}

export function listImpersonationsForCustomer(customerId, limit = 10) {
  return db.prepare(`
    SELECT nonce, customer_id, customer_email, admin_email,
           read_only, expires_at, used_at, created_at
    FROM impersonation_nonces
    WHERE customer_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(String(customerId), limit).map(r => ({
    nonce:        r.nonce,
    customerId:   r.customer_id,
    customerEmail:r.customer_email,
    adminEmail:   r.admin_email,
    readOnly:     !!r.read_only,
    expiresAt:    r.expires_at,
    usedAt:       r.used_at,
    createdAt:    r.created_at,
  }));
}
