/**
 * fww-b2b-admin — Fuzzywumpets internal ops dashboard.
 * Phase 1: Google OAuth + dashboard MVP.
 * Phase 2: Orders + Customers pages.
 * Phase 3: Catalog + Reports + Settings + Migrate.
 * Phase 4: Polish — keyboard shortcuts, CSV exports, PWA manifest.
 * Phase 5: UPC barcode label engine.
 * Phase 6: Product CSV + image ZIP exports.
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ZipArchive } from 'archiver';
import {
  createSession, getSession, deleteSession, auditLog,
  getCustomerNotes, setCustomerNotes, getDropshipCache, setDropshipCache,
  getSetting, setSetting, getGlobalSettings, getAuditLog, getAuditLogCount,
  logLabelBatch, logExportBatch,
  createLead, getLeads, getLeadCounts, getLead, updateLead, upsertPortalLead,
  addLeadNote, getLeadNotes, addLeadStatusHistory, getLeadStatusHistory,
  upsertBackorder, getBackordersForOrder, getOpenBackorders, fulfillBackorder, logOrderEdit,
  getEditAction, putEditAction,
  getOutstandingBalanceForCustomer,
  getXeroMap, setXeroMap, addXeroPending, getXeroPending, markXeroPendingDone, markXeroPendingFailed, getXeroPendingCount, getXeroInvoiceMaps,
  createImpersonationNonce, consumeImpersonationNonce, gcImpersonationNonces,
  createPartialInvoice, getPartialInvoices, getNextInvoiceLetter,
  getOrderHistory,
  upsertCustomerCache, upsertOrderCache, upsertOrderLineItemsCache, upsertProductCache,
  getOrdersFromCache, getOrderFromCache, getOrderSpendFromCache, getCustomerFromCache,
  getCustomersCountInCache, getOrdersCountInCache, getProductsCountInCache,
  getSyncState, setSyncState, getAllInvoicesForList, getPartialInvoicesAll,
  listCustomersFromCache,
  getCustomerCacheStats,
  listOrdersFromCache, getOrdersCacheStats, getCustomerOrdersFromCache,
  getReportsDataFromCache,
  getTopCustomersAllTime,
  listImpersonationsForCustomer,
  getOrderByName,
  getOrderInternalNote, setOrderInternalNote,
} from './db.mjs';
import { generateInvoicePdf, lineItemTrueTotal, lineItemTrueUnit, lineItemCurrentQty } from './pdf.mjs';
import { renderLabelSheet, expandItems, TEMPLATES as LABEL_TEMPLATES, DEFAULT_FIELDS } from './labels.mjs';
import { isInsider, resolveXeroContact, syncCustomerToXero, getXeroSyncStatus } from './lib/xero-customer-sync.mjs';
// fww-error-sink monitoring (injected 2026-06-30): error-logging shim only. To disable, remove this import, the installGlobalHandlers() call, and the expressErrorMiddleware() app.use. See fww-error-sink RUNBOOK.
import { installGlobalHandlers, expressErrorMiddleware, reportEvent } from './fww-logsink.mjs';
installGlobalHandlers();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK  = process.env.B2B_ADMIN_MOCK === '1';

// Activity-gated Shopify polling (added 2026-05-30 — shopify-bridge perf fix):
// only sync while the dashboard is in active use, so data stays fresh when someone
// is looking but Shopify isn't polled around the clock.
let lastDashboardActivity = 0;
const ACTIVE_WINDOW_MS = 20 * 60 * 1000; // treat as "in use" for 20 min after last request
const dashboardActive = () => (Date.now() - lastDashboardActivity) < ACTIVE_WINDOW_MS;
const PORT  = Number(process.env.PORT || 8794);

const GOOGLE_CLIENT_ID     = process.env.B2B_ADMIN_GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.B2B_ADMIN_GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS       = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const SHOPIFY_BEARER       = process.env.SHOPIFY_BRIDGE_BEARER           || '';
const REDIRECT_URI         = MOCK
  ? `http://127.0.0.1:${PORT}/auth/google/callback`
  : 'https://b2badmin.fuzzywumpets.com/auth/google/callback';
const COOKIE_NAME = 'b2b_admin_sid';
const B2B_PUB_ID  = 'gid://shopify/Publication/199709720811';
const PORTAL_INTERNAL_TOKEN = process.env.B2B_PORTAL_INTERNAL_TOKEN || '';
const PORTAL_INTERNAL_URL   = process.env.B2B_PORTAL_INTERNAL_URL || 'http://127.0.0.1:8793';
const XERO_BRIDGE_URL       = 'https://fww-xero-bridge.alex-037.workers.dev/xero';
const XERO_BEARER           = process.env.XERO_BRIDGE_BEARER || '';
// ─────────────────────────────────────────────────────────────────────────────
// [XERO-DISABLED] TEMPORARY XERO WRITE KILL-SWITCH — added 2026-07-14 by request.
// Alex is cleaning up bad/garbage data on the Xero side and will do a clean
// re-pull once it's fixed. Until then, ALL Xero WRITE + SYNC operations are
// disconnected: they must NOT reach Xero, must NOT enqueue xero_pending retry
// rows, must NOT write local xero-map / mapping-file entries (that queue + those
// files are themselves "garbage" we don't want to accumulate), and must NOT throw
// — a B2B action (create order, mark paid, manual sync, customer sync) still
// succeeds for the user.
//
// ⚠️  SILENT-PASS WARNING FOR THE NEXT REVIEWER  ⚠️
// While this is false, the Xero steps RETURN SUCCESS-SHAPED RESULTS WITHOUT DOING
// ANYTHING. Logs/UI may say the Xero step "synced/skipped/completed" even though
// NO invoice, payment, or contact was pushed to Xero, and NOTHING was queued for
// later — re-enabling will NOT backfill the gap. What is actually NOT happening
// while this is off:
//   • submitNewOrder  → NO ACCREC invoice created in Xero
//   • /orders/:id/mark-paid → NO Xero invoice + NO payment recorded
//   • /orders/:id/xero/sync (manual button) → NO invoice (reports "xero_synced")
//   • /api/admin/xero/sync (drain queue) → processes nothing
//   • customer xero-sync / b2b-tag / lead-convert → NO Xero contact created
// Reads (GET: account list, sync-status lookups) are left ALIVE — they don't
// create garbage. Backstop below in xeroRequest() blocks any write we missed.
// TO RE-ENABLE: flip this to true, then manually re-sync affected orders/customers
// (there is no automatic catch-up). Grep tag: [XERO-DISABLED]
// ─────────────────────────────────────────────────────────────────────────────
const XERO_WRITES_ENABLED   = false;
const IMPERSONATION_SECRET  = process.env.B2B_IMPERSONATION_SECRET || (MOCK ? 'test-impersonation-secret-mock' : '');
const PORTAL_BASE_URL       = MOCK ? `http://127.0.0.1:8793` : 'https://b2b.fuzzyreporting.com';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || (MOCK ? 'test-shopify-webhook-secret' : '');

const app = express();
// Capture the exact raw bytes of every JSON body so the Shopify webhook route can verify its
// HMAC over the ORIGINAL payload (not a re-serialization). SECURITY: without this, express.json
// parses+re-stringifies before the webhook handler runs and the HMAC never matches → all real
// Shopify webhooks were being rejected.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// WHAT: slow-request tripwire — any response slower than 1s logs method/path/status/ms, so a
// "the app feels broken" report (e.g. the 10s-login complaint, 2026-07-21) yields journalctl data
// instead of guesses. Path only (no query) — never log tokens/codes from OAuth redirects.
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > 1000) console.log(`[slow-req] ${req.method} ${req.path} ${res.statusCode} ${Math.round(ms)}ms`);
  });
  next();
});

// Baseline Content-Security-Policy + hardening headers (defense-in-depth). Inline scripts/handlers
// still require 'unsafe-inline' today, but this blocks external script/exfil hosts, object/base-uri
// injection, and framing/clickjacking. Nonce-based lockdown of inline scripts is follow-up work.
//
// frame-ancestors 'self' (NOT 'none') — REGRESSION FIX 2026-07-15: 'none' forbids EVERY page from
// framing our responses, INCLUDING our own same-origin pages. That silently broke the invoice viewer
// (/orders/:id/invoice embeds <iframe src=".../invoice.pdf">): the PDF response carried
// frame-ancestors 'none', so the iframe rendered BLANK and the only way to see the invoice was the
// "Open / print ↗" link — which opens a bare PDF window with no back button and TRAPS the user in
// the Electron desktop shell (only escape = quit the app). 'self' still blocks external framing /
// clickjacking, which is the actual threat. Re-test the invoice iframe if you touch this.
//
// Cache-Control: no-store — the FWW Admin desktop shell is Electron/Chromium and was caching our
// HTML on DISK (we previously sent no cache headers at all). That cache SURVIVES quitting the app,
// so shipped fixes (invoice back-button, inline custom-item form, notify checkbox) kept appearing
// "missing" for days against a stale page. Dynamic responses must never be cached. NOTE: this
// header would otherwise also hit express.static's assets (setHeader here WINS over static's
// default), so real assets are explicitly skipped below and keep normal ETag/304 revalidation.
// Generated PDFs are deliberately NOT skipped — they change with the order.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!/\.(?:css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// ── Portal integration (read portal SQLite + call portal internal API) ────────

import Database from 'better-sqlite3';

let portalDb = null;
// WHAT: lazily opens the SIBLING fww-b2b-portal SQLite (read-only) at a HARDCODED abs path and memoizes the handle in module-level `portalDb`.
// CHANGE-GUARD: if the portal's data dir moves or the file is missing, the open throws and is swallowed (empty catch) — every portal-backed feature (visible notes, tax certs, activity, carts) silently degrades to empty. Re-test by deleting/renaming the db and confirming pages still render.
// INVARIANT(S): MUST stay { readonly:true } — this process must never write the portal db; path is cross-repo (`/home/alexa/projects/fww-b2b-portal/data/portal.db`) so it only works when both repos are co-located on the VPS; MOCK short-circuits to null.
function getPortalDb() {
  if (MOCK) return null;
  if (!portalDb) {
    const dbPath = '/home/alexa/projects/fww-b2b-portal/data/portal.db';
    try { portalDb = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch (_) {}
  }
  return portalDb;
}

// WHAT: reads visible_notes rows the portal exposes to the customer for one Shopify order id, newest-first.
// CHANGE-GUARD: the catch swallows ALL errors to [] — a schema rename of visible_notes silently hides notes with no log. Re-test the order-detail Visible Notes panel after any portal migration.
// INVARIANT(S): order_id here is the numeric/string Shopify order id stored by the portal, NOT a gid; field mapping (added_at→addedAt, added_by→addedBy) must mirror the portal writer.
function getVisibleNotesForOrder(shopifyOrderId) {
  if (MOCK) return [];
  const db = getPortalDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM visible_notes WHERE order_id = ? ORDER BY added_at DESC').all(shopifyOrderId).map(r => ({
      id: r.id, orderId: r.order_id, customerId: r.customer_id,
      body: r.body, addedAt: r.added_at, addedBy: r.added_by,
    }));
  } catch (_) { return []; }
}

// WHAT: lists tax_exempt_certs rows with status='pending' from the portal db, oldest upload first (review queue order).
// CHANGE-GUARD: feeds the /tax-exempt review queue; the SQL string-literal status filter must match the portal's enum exactly ('pending'). Errors swallowed to [].
// INVARIANT(S): read-only; approval/rejection happens via callPortalInternal, NOT by writing this db.
function getPendingTaxCertsFromPortal() {
  if (MOCK) return [];
  const db = getPortalDb();
  if (!db) return [];
  try {
    return db.prepare("SELECT * FROM tax_exempt_certs WHERE status = 'pending' ORDER BY uploaded_at ASC").all().map(r => ({
      id: r.id, customerId: r.customer_id, state: r.state, filePath: r.file_path,
      status: r.status, uploadedAt: r.uploaded_at,
    }));
  } catch (_) { return []; }
}

// WHAT: pulls wholesale applications from the PORTAL's wholesale_leads table into this app's
//   `leads` table, so applications submitted on fuzzywumpets.com appear in the tool staff use.
// WHY: these are two separate databases. Before this existed, admin.db.leads was empty while real
//   applications sat unread in portal.db.wholesale_leads — an application could be invisible here
//   indefinitely.
// CHANGE-GUARD: called on every /leads render, so it MUST stay cheap and idempotent — upsertPortalLead
//   owns the "never clobber staff edits" rule, do not add field-refresh logic here. Failures are
//   swallowed to a no-op for the same reason every other portal reader does: a portal outage must
//   degrade to "no new leads", never a 500 on the Leads page.
// INVARIANT(S): read-only against the portal db; returns a count of newly-ingested rows for logging;
//   MOCK short-circuits to 0 (getPortalDb returns null there).
function syncPortalWholesaleLeads() {
  const db = getPortalDb();
  if (!db) return 0;
  try {
    const rows = db.prepare('SELECT * FROM wholesale_leads ORDER BY submitted_at ASC').all();
    let ingested = 0;
    for (const row of rows) {
      if (!row.email) continue;
      try {
        if (upsertPortalLead(row).action === 'inserted') ingested += 1;
      } catch (_) { /* one bad row must not stop the rest */ }
    }
    if (ingested) console.log(`[leads] ingested ${ingested} wholesale application(s) from the portal`);
    return ingested;
  } catch (_) { return 0; }
}

// WHAT: paginated activity-log reader for one customer; builds a dynamic WHERE over customer_activity with optional from/to/type/q, returns rows + total + lastLogin + lastCart.
// CHANGE-GUARD: count query is derived by string-replacing 'SELECT *'→'SELECT COUNT(*)'; if the base SELECT shape ever changes that replace breaks the count silently. Re-test pager totals after any query edit.
// INVARIANT(S): all user-controlled filters bind via ? placeholders (no SQL injection); `to` adds +86400000ms to make the upper bound inclusive of the whole day; limit is clamped to max 200; page is 1-based and offset = (page-1)*lim.
function getCustomerActivityFromPortal(numericCustomerId, { from, to, type, q, page = 1, limit = 50 } = {}) {
  if (MOCK) {
    const allRows = [
      { id: 1, customerId: `gid://shopify/Customer/${numericCustomerId}`, sessionId: 'sess-1', eventType: 'page_view', eventSubtype: null, path: '/catalog', httpStatus: 200, durationMs: 120, ts: Date.now() - 5000 },
      { id: 2, customerId: `gid://shopify/Customer/${numericCustomerId}`, sessionId: 'sess-1', eventType: 'api_call', eventSubtype: 'api/catalog', path: '/api/catalog', httpStatus: 200, durationMs: 45, ts: Date.now() - 6000 },
      { id: 3, customerId: `gid://shopify/Customer/${numericCustomerId}`, sessionId: 'sess-1', eventType: 'auth', eventSubtype: 'login', path: '/auth/callback', httpStatus: 302, ts: Date.now() - 7000 },
    ];
    const filtered = (type && type !== 'all') ? allRows.filter(r => r.eventType === type) : allRows;
    return {
      rows: filtered,
      total: filtered.length,
      lastLogin: { ts: Date.now() - 7000 },
      lastCart: null,
      page: 1,
      limit: 50,
    };
  }
  const db = getPortalDb();
  if (!db) return { rows: [], total: 0, lastLogin: null, lastCart: null, page: 1, limit: 50 };
  try {
    const customerId = `gid://shopify/Customer/${numericCustomerId}`;
    let sql = 'SELECT * FROM customer_activity WHERE customer_id = ?';
    const params = [customerId];
    if (from) { sql += ' AND ts >= ?'; params.push(new Date(from).getTime()); }
    if (to)   { sql += ' AND ts <= ?'; params.push(new Date(to).getTime() + 86400000); }
    if (type && type !== 'all') { sql += ' AND event_type = ?'; params.push(type); }
    if (q) {
      sql += ' AND (path LIKE ? OR event_subtype LIKE ? OR event_data LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const countRow = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as cnt')).get(...params);
    const total = countRow ? countRow.cnt : 0;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
    params.push(lim, off);
    const rows = db.prepare(sql).all(...params).map(r => ({
      id: r.id, customerId: r.customer_id, sessionId: r.session_id,
      eventType: r.event_type, eventSubtype: r.event_subtype,
      eventData: r.event_data ? (() => { try { return JSON.parse(r.event_data); } catch(_) { return r.event_data; } })() : null,
      path: r.path, referrer: r.referrer, userAgent: r.user_agent,
      ipHash: r.ip_hash ? r.ip_hash.slice(0, 8) : null,
      ipCountry: r.ip_country, httpStatus: r.http_status,
      durationMs: r.duration_ms, impersonationAdmin: r.impersonation_admin, ts: r.ts,
    }));
    const lastLoginRow = db.prepare(`SELECT * FROM customer_activity WHERE customer_id = ? AND event_type = 'auth' AND event_subtype = 'login' ORDER BY ts DESC LIMIT 1`).get(customerId);
    const lastCartRow  = db.prepare(`SELECT * FROM customer_activity WHERE customer_id = ? AND event_type = 'cart' ORDER BY ts DESC LIMIT 1`).get(customerId);
    return { rows, total, page: Math.max(Number(page) || 1, 1), limit: lim,
      lastLogin: lastLoginRow ? { ts: lastLoginRow.ts } : null,
      lastCart:  lastCartRow  ? { ts: lastCartRow.ts  } : null };
  } catch (e) { console.error('[activity] portal read failed:', e.message); return { rows: [], total: 0, lastLogin: null, lastCart: null, page: 1, limit: 50 }; }
}

// WHAT: reads the customer's current cart + cart_items from the portal db and recomputes a subtotal in JS.
// CHANGE-GUARD: lineTotal/subtotal are recomputed here as round(b2b_price*qty*100)/100 — they do NOT trust a stored total; if the portal ever stores authoritative totals, reconcile to avoid drift. Errors swallowed to an empty cart.
// INVARIANT(S): money is rounded to cents via *100/round/÷100 (float-safe-ish); customer_id is the gid form `gid://shopify/Customer/<id>`, unlike visible_notes which uses the numeric id.
function getActiveCartFromPortal(numericCustomerId) {
  const customerId = `gid://shopify/Customer/${numericCustomerId}`;
  if (MOCK) {
    return { items: [], subtotal: 0, itemCount: 0, updatedAt: null };
  }
  const db = getPortalDb();
  if (!db) return { items: [], subtotal: 0, itemCount: 0, updatedAt: null };
  try {
    const cart = db.prepare('SELECT * FROM carts WHERE customer_id = ?').get(customerId);
    if (!cart) return { items: [], subtotal: 0, itemCount: 0, updatedAt: null };
    const rows = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY added_at').all(cart.cart_id);
    const items = rows.map(r => ({
      variantId:    r.variant_id,
      productId:    r.product_id,
      productTitle: r.product_title,
      variantTitle: r.variant_title,
      sku:          r.sku,
      quantity:     r.quantity,
      b2bPrice:     r.b2b_price,
      lineTotal:    Math.round(r.b2b_price * r.quantity * 100) / 100,
    }));
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    return { items, subtotal: Math.round(subtotal * 100) / 100, itemCount: rows.length, updatedAt: cart.updated_at };
  } catch (e) { console.error('[active-cart] portal read failed:', e.message); return { items: [], subtotal: 0, itemCount: 0, updatedAt: null }; }
}

// WHAT: server-to-server call into the portal's internal API (PORTAL_INTERNAL_URL, default 127.0.0.1:8793) with a Bearer PORTAL_INTERNAL_TOKEN; the ONLY write path into the portal (vs read-only SQLite above).
// CHANGE-GUARD: returns { ok:false, error:'no_internal_token' } when the token env is unset — callers must check .ok, not assume success. Network errors are caught and returned as ok:false (never throws).
// INVARIANT(S): token must match the portal's expected internal secret; on localhost only — do NOT point PORTAL_INTERNAL_URL at a public host without TLS since the bearer is sent in cleartext otherwise.
async function callPortalInternal(method, path, body) {
  if (!PORTAL_INTERNAL_TOKEN) return { ok: false, error: 'no_internal_token' };
  try {
    const r = await fetch(`${PORTAL_INTERNAL_URL}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${PORTAL_INTERNAL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    return { ok: r.ok, ...j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Xero accounting integration ───────────────────────────────────────────────

// WHAT: deterministic fake Xero bridge responses keyed by URL fragment + method, used in MOCK or when XERO_BEARER is absent.
// CHANGE-GUARD: branch ORDER matters — the GET-Contacts-with-where check sits before the generic /Contacts branch so a live-lookup returns [] (forcing create) in mock; reordering changes dedupe behavior. Account codes here (200/610/1110/1120/6100/400) must match getXeroAccountMap defaults.
// INVARIANT(S): the where=-Contacts case MUST return empty Contacts so syncCustomerToXero treats mock as 'not found' and exercises the create path.
function xeroMockResponse(method, xeroPath, body) {
  if (xeroPath.includes('/ContactGroups')) {
    return { ContactGroups: [{ ContactGroupID: 'c5afb0f1-8a59-4db8-be57-83548c361669', Name: 'B2B Customers', Contacts: [] }] };
  }
  if (xeroPath.includes('/Contacts') && method === 'GET' && xeroPath.includes('where=')) {
    // Live lookup by AccountNumber — return empty in mock (so syncCustomerToXero will create)
    return { Contacts: [] };
  }
  if (xeroPath.includes('/Contacts')) {
    return { Contacts: [{ ContactID: 'mock-contact-xero', Name: body?.Contacts?.[0]?.Name || 'Mock Contact', EmailAddress: body?.Contacts?.[0]?.EmailAddress || '' }] };
  }
  if (xeroPath.includes('/Invoices') && method !== 'GET') {
    return { Invoices: [{ InvoiceID: 'mock-inv-' + Date.now(), InvoiceNumber: body?.Invoices?.[0]?.InvoiceNumber || 'MOCK001', Status: 'AUTHORISED', AmountDue: 100 }] };
  }
  if (xeroPath.includes('/Invoices') && method === 'GET') {
    return { Invoices: [{ InvoiceID: 'mock-inv-get', InvoiceNumber: 'MOCK001', Status: 'AUTHORISED', AmountDue: 100 }] };
  }
  if (xeroPath.includes('/Payments')) {
    return { Payments: [{ PaymentID: 'mock-pay-' + Date.now(), Status: 'AUTHORISED' }] };
  }
  if (xeroPath.includes('/Accounts')) {
    return { Accounts: [{ Code: '200', Name: 'Sales', Type: 'REVENUE', AccountID: 'acc-200' }, { Code: '610', Name: 'Accounts Receivable', Type: 'CURRENT', AccountID: 'acc-610' }, { Code: '1110', Name: 'Chase Business Checking', Type: 'BANK', AccountID: 'acc-1110' }, { Code: '1120', Name: 'Stripe Clearing', Type: 'CURRENT', AccountID: 'acc-1120' }, { Code: '6100', Name: 'Bank Fees', Type: 'EXPENSE', AccountID: 'acc-6100' }, { Code: '400', Name: 'Discounts', Type: 'REVENUE', AccountID: 'acc-400' }] };
  }
  return {};
}

// WHAT: single choke-point for all Xero traffic; proxies to the fww-xero-bridge worker with Bearer XERO_BRIDGE_BEARER, else returns mock.
// CHANGE-GUARD: DANGER — `MOCK || !XERO_BEARER` means a PROD run with a missing/empty bearer silently returns fabricated mock success instead of erroring; accounting would appear to sync while nothing reaches Xero. Re-test that prod with no bearer fails loudly, not silently.
// INVARIANT(S): throws on !resp.ok AND on json.ok===false so callers can try/catch; the bridge contract is POST { method, path, body } → { ok, body }.
async function xeroRequest(method, xeroPath, body = null) {
  if (MOCK || !XERO_BEARER) {
    return { ok: true, body: xeroMockResponse(method, xeroPath, body) };
  }
  // [XERO-DISABLED] Backstop: while writes are off, NEVER let a mutating request
  // reach the bridge. Any non-GET short-circuits to a synthetic success (same
  // shape as MOCK) so callers don't throw. GETs (reads) pass through untouched.
  // This is defense-in-depth — the high-level fns below also short-circuit first,
  // so this only fires for a write path we didn't explicitly gate.
  if (!XERO_WRITES_ENABLED && String(method).toUpperCase() !== 'GET') {
    console.warn(`[XERO-DISABLED] blocked ${method} ${xeroPath} — writes are off; returning synthetic success (nothing sent to Xero).`);
    return { ok: true, body: xeroMockResponse(method, xeroPath, body) };
  }
  const payload = { method, path: xeroPath };
  if (body) payload.body = body;
  const resp = await fetch(XERO_BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XERO_BEARER}` },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Xero bridge ${method} ${xeroPath} → ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  if (!json.ok) throw new Error(`Xero API error: ${JSON.stringify(json.body || json).slice(0, 300)}`);
  return json;
}

// WHAT: resolves the chart-of-accounts codes + payment terms from SQLite settings, with hardcoded fallbacks (sales 200, AR 610, Chase 1110, Stripe 1120, fees 6100, discounts 400, NET-30).
// CHANGE-GUARD: these fallbacks must stay aligned with both xeroMockResponse's Accounts list and the real Xero chart; a wrong code posts revenue to the wrong ledger. payment_terms_days is Number()-coerced — a non-numeric setting yields NaN dates downstream.
// INVARIANT(S): every getSetting key here ('xero_*') must exist in the Settings UI or silently fall back.
function getXeroAccountMap() {
  return {
    sales_revenue:        getSetting('xero_sales_revenue')        || '200',
    accounts_receivable:  getSetting('xero_accounts_receivable')  || '610',
    chase_checking:       getSetting('xero_chase_checking')       || '1110',
    stripe_clearing:      getSetting('xero_stripe_clearing')      || '1120',
    processing_fees:      getSetting('xero_processing_fees')      || '6100',
    discounts:            getSetting('xero_discounts')            || '400',
    payment_terms_days:   Number(getSetting('xero_payment_terms_days') || '30'),
  };
}

function toXeroDate(isoString) {
  if (!isoString) return new Date().toISOString().slice(0, 10);
  return new Date(isoString).toISOString().slice(0, 10);
}

function addDays(isoString, days) {
  const d = new Date(isoString || new Date());
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// WHAT: idempotent Xero contact resolver — first tries resolveXeroContact(numId) (mapping/live lookup) to avoid duplicates, only PUTs a new Contact if unresolved.
// CHANGE-GUARD: AccountNumber is set to the Shopify numeric customer id and is the dedupe key on the Xero side; changing what you pass as AccountNumber breaks future resolveXeroContact matches. Re-test that re-syncing the same customer does NOT create a 2nd contact.
// INVARIANT(S): customer.id is a gid; numId derived via shopifyNumericId; throws if the create returns no ContactID.
async function ensureXeroContact(customer) {
  // customer: { id (GID), displayName, email }
  // [XERO-DISABLED] Writes off: never create a Xero contact. Returns null; the only
  // caller (createXeroInvoice) already short-circuits before reaching here, so this
  // is belt-and-suspenders. (Contact writes triggered elsewhere go through the
  // lib syncCustomerToXero path, which the xeroRequest backstop neutralizes.)
  if (!XERO_WRITES_ENABLED) return null;
  // Phase 21G: resolve from mapping / live before creating to avoid duplicates
  const numId = shopifyNumericId(customer.id || '');
  if (numId) {
    const resolved = await resolveXeroContact(numId, xeroRequest, { dryRun: MOCK });
    if (resolved) return resolved.xeroContactId;
  }
  const name  = customer.displayName || customer.email || 'Unknown Customer';
  const email = customer.email || '';
  const res = await xeroRequest('PUT', '/api.xro/2.0/Contacts', {
    Contacts: [{ Name: name, AccountNumber: numId || undefined, EmailAddress: email }],
  });
  const contact = res.body?.Contacts?.[0];
  if (!contact?.ContactID) throw new Error('Xero contact create failed: ' + JSON.stringify(res.body).slice(0, 200));
  return contact.ContactID;
}

// WHAT: builds and PUTs an ACCREC Xero invoice from a Shopify order; short-circuits if getXeroMap already shows status==='synced'.
// CHANGE-GUARD: line-item UnitAmount prefers originalUnitPriceSet then discountedUnitPriceSet (NOTE: original first) — verify this matches intended B2B pricing, since B2B discounts live in the discounted set. Order-level discounts are appended as negative lines to accountMap.discounts. TaxType hardcoded 'NONE' (B2B tax-exempt assumption).
// INVARIANT(S): writes setXeroMap(orderId, InvoiceID, contactId, 'synced') on success — the get/set around this is NOT atomic, so two concurrent syncs of the same order can each pass the 'synced' check and create duplicate invoices; InvoiceNumber = order.name (e.g. #1001) must be unique in Xero.
async function createXeroInvoice(order, accountMap) {
  // order: Shopify order object with lineItems, customer, etc.
  // [XERO-DISABLED] Writes off: do NOT create an invoice, do NOT touch the local
  // xero-map. Return null so callers treat it as "no invoice id" and skip cleanly
  // (e.g. mark-paid skips the payment record). No throw, no pending-queue row.
  if (!XERO_WRITES_ENABLED) {
    console.warn(`[XERO-DISABLED] createXeroInvoice skipped for order ${shopifyNumericId(order.id)} — no invoice pushed to Xero.`);
    return null;
  }
  const orderId   = shopifyNumericId(order.id);
  const existing  = getXeroMap(orderId);
  if (existing?.xero_invoice_id && existing.status === 'synced') return existing.xero_invoice_id;

  const contactId = await ensureXeroContact(order.customer || { displayName: 'Unknown', email: '' });

  // CURRENT-FIELDS (2026-06-29): invoice the order's CURRENT lines — use currentQuantity (post-edit truth)
  // and DROP lines removed in an edit (currentQuantity 0). getOrderDetail (the only feeder of this fn) now
  // selects currentQuantity; it falls back to `quantity` when the field is absent (unedited orders / webhook
  // shapes that omit it) so unedited orders invoice exactly as before.
  // [XERO-DISABLED] TODO(when re-enabled): orders from /orders/new can now carry a Shopify
  // shippingLine (shipping cost). This LineItems build covers PRODUCTS + order discounts only —
  // it does NOT add shipping, so the invoice would under-bill by the shipping amount. Add a
  // shipping LineItem from order.totalShippingPriceSet.presentmentMoney.amount (when > 0),
  // AccountCode = accountMap.sales_revenue (or a dedicated freight code), before the total math.
  const lineItems = (order.lineItems?.edges || [])
    .map(e => e.node)
    .filter(li => (li.currentQuantity != null ? li.currentQuantity : (li.quantity || 0)) > 0)
    .map(li => {
      // DISCOUNT-AWARE (2026-08-05): bill the price the customer actually owes, via the SAME shared
      // helpers the invoice PDF and CSV use (lineItemTrueUnit/lineItemTrueTotal in pdf.mjs), so Xero,
      // the PDF and the CSV can never disagree about one order's money.
      // CHANGE-GUARD: this used to prefer originalUnitPriceSet — the PRE-discount price — and netted
      // out only because an order discount was then a separate NEGATIVE line item that got emitted as
      // its own negative Xero line. Order discounts are now per-line discount ALLOCATIONS, so the old
      // code would have invoiced FULL RETAIL, over-billing by the entire discount on real accounting.
      // (Latent until XERO_WRITES_ENABLED is turned back on — it would have broken on that day, not
      // on deploy, which is exactly why it is fixed here rather than left for later.)
      const qty    = lineItemCurrentQty(li);
      const price  = Math.round(lineItemTrueUnit(li) * 100) / 100;
      return {
        Description:    `${li.title}${li.variantTitle ? ' — ' + li.variantTitle : ''}`,
        Quantity:        qty,
        UnitAmount:      price,
        AccountCode:     accountMap.sales_revenue,
        TaxType:         'NONE',
        LineAmount:      Math.round(lineItemTrueTotal(li) * 100) / 100,
      };
    });

  // NOTE (2026-08-05): a separate negative "Discount:" line USED to be appended here from
  // order.discountApplications. It was already dead code — getOrderDetail, the only feeder of this
  // function, never selected discountApplications — and it is now actively DANGEROUS: UnitAmount
  // above is already net of every discount, so emitting a discount line as well would credit the
  // customer twice. Deliberately removed rather than left dormant for someone to "fix" by adding
  // discountApplications to the query.

  const orderDate  = toXeroDate(order.processedAt || order.createdAt);
  const dueDate    = addDays(orderDate, accountMap.payment_terms_days);
  // CURRENT-FIELDS: degenerate no-line fallback uses the CURRENT total (post-edit), not the frozen original.
  const totalPrice = deriveCurrentOrderTotals(order).total;

  const res = await xeroRequest('PUT', '/api.xro/2.0/Invoices', {
    Invoices: [{
      Type:           'ACCREC',
      Contact:        { ContactID: contactId },
      Date:           orderDate,
      DueDate:        dueDate,
      InvoiceNumber:  order.name || ('#' + orderId),
      Reference:      'b2b-admin',
      LineItems:      lineItems.length ? lineItems : [{ Description: 'B2B Order', Quantity: 1, UnitAmount: totalPrice, AccountCode: accountMap.sales_revenue, TaxType: 'NONE' }],
      Status:         'AUTHORISED',
    }],
  });
  const inv = res.body?.Invoices?.[0];
  if (!inv?.InvoiceID) throw new Error('Xero invoice create failed: ' + JSON.stringify(res.body).slice(0, 300));
  setXeroMap(orderId, inv.InvoiceID, contactId, 'synced');
  return inv.InvoiceID;
}

// WHAT: PUTs a Payment against an existing Xero invoice for the given amount/date/bank-account code.
// CHANGE-GUARD: there is NO idempotency key — calling this twice (e.g. retry queue + manual) records TWO payments and over-allocates the invoice. Re-test the retry path does not double-pay.
// INVARIANT(S): amount is presentment currency major units (dollars), accountCode is a BANK account code (chase_checking/stripe_clearing), date defaults to today if absent; throws if no PaymentID returned.
async function recordXeroPayment(orderId, xeroInvoiceId, amount, date, accountCode) {
  // [XERO-DISABLED] Writes off: do NOT record a payment against any Xero invoice.
  // Return null (no PaymentID) without throwing; callers only audit-log on success.
  if (!XERO_WRITES_ENABLED) {
    console.warn(`[XERO-DISABLED] recordXeroPayment skipped for order ${orderId} — no payment sent to Xero.`);
    return null;
  }
  const payDate = date ? toXeroDate(date) : new Date().toISOString().slice(0, 10);
  const res = await xeroRequest('PUT', '/api.xro/2.0/Payments', {
    Payments: [{
      Invoice:  { InvoiceID: xeroInvoiceId },
      Account:  { Code: accountCode },
      Date:     payDate,
      Amount:   amount,
    }],
  });
  const pay = res.body?.Payments?.[0];
  if (!pay?.PaymentID) throw new Error('Xero payment create failed: ' + JSON.stringify(res.body).slice(0, 300));
  return pay.PaymentID;
}

// WHAT: top-level 'sync this order to Xero' used by the order-detail button; loads the order, creates the invoice, audit-logs success; on failure enqueues an xero_pending action + marks the map 'pending_retry'.
// CHANGE-GUARD: re-throws after queuing, so the HTTP handler must catch and render the 'xero_failed' flash. actorEmail must come from req.adminSession.email (never client input) for a trustworthy audit trail.
// INVARIANT(S): every outcome is audit-logged (xero:invoice_synced / xero:invoice_failed) keyed by the order gid; failures are durably retryable via addXeroPending.
async function syncOrderToXero(numId, actorEmail) {
  // [XERO-DISABLED] Writes off: report a benign "skipped" success WITHOUT creating
  // an invoice and WITHOUT enqueuing a pending-retry row. Callers (submitNewOrder
  // fire-and-forget, and POST /orders/:id/xero/sync) treat this as done. NOTE: the
  // manual-sync endpoint will still flash "xero_synced" — nothing actually synced.
  if (!XERO_WRITES_ENABLED) {
    console.warn(`[XERO-DISABLED] syncOrderToXero skipped for order ${numId} — no invoice pushed, nothing queued.`);
    return { ok: true, skipped: 'xero_writes_disabled', xeroInvoiceId: null };
  }
  const order = await getOrderDetail(numId);
  if (!order) throw new Error('Order not found: ' + numId);
  const accountMap = getXeroAccountMap();
  try {
    const xeroInvoiceId = await createXeroInvoice(order, accountMap);
    auditLog(actorEmail, 'xero:invoice_synced', shopifyOrderGid(numId), null, { xeroInvoiceId });
    return { ok: true, xeroInvoiceId };
  } catch (err) {
    const pendingId = addXeroPending('create_invoice', { orderId: numId, error: err.message });
    setXeroMap(numId, null, null, 'pending_retry', err.message);
    auditLog(actorEmail, 'xero:invoice_failed', shopifyOrderGid(numId), null, { error: err.message, pendingId });
    throw err;
  }
}

// WHAT: drains the xero_pending queue (create_invoice / record_payment), capped at 3 retries per action; returns {done,failed,skipped}.
// CHANGE-GUARD: SERIAL by design (await in a for-of) — do not parallelize, since concurrent create_invoice for the same order would race the non-atomic getXeroMap/setXeroMap and duplicate invoices. retries>=3 → skipped (NOT failed), so a poison action lingers in the queue forever; verify a sweep/alert exists.
// INVARIANT(S): payload_json is the persisted action args; unknown action_type is marked failed; markXeroPendingDone/Failed must be called exactly once per processed action.
async function retryXeroPending() {
  // [XERO-DISABLED] Writes off: don't drain the queue (every action is a Xero
  // write). Leave pending rows untouched and report zero work — no throw.
  if (!XERO_WRITES_ENABLED) {
    console.warn('[XERO-DISABLED] retryXeroPending skipped — queue left intact, nothing sent to Xero.');
    return { done: 0, failed: 0, skipped: 0, disabled: true };
  }
  const pending = getXeroPending('pending');
  const accountMap = getXeroAccountMap();
  const results = { done: 0, failed: 0, skipped: 0 };
  for (const action of pending) {
    if (action.retries >= 3) { results.skipped++; continue; }
    const payload = JSON.parse(action.payload_json);
    try {
      if (action.action_type === 'create_invoice') {
        const order = await getOrderDetail(payload.orderId);
        if (!order) { markXeroPendingFailed(action.id, 'Order not found', action.retries + 1); results.failed++; continue; }
        const xeroInvoiceId = await createXeroInvoice(order, accountMap);
        markXeroPendingDone(action.id);
        setXeroMap(payload.orderId, xeroInvoiceId, null, 'synced');
        results.done++;
      } else if (action.action_type === 'record_payment') {
        await recordXeroPayment(payload.orderId, payload.xeroInvoiceId, payload.amount, payload.date, payload.accountCode);
        markXeroPendingDone(action.id);
        results.done++;
      } else {
        markXeroPendingFailed(action.id, 'Unknown action type: ' + action.action_type, action.retries + 1);
        results.failed++;
      }
    } catch (err) {
      markXeroPendingFailed(action.id, err.message, action.retries + 1);
      results.failed++;
    }
  }
  return results;
}

// ── Mock data ─────────────────────────────────────────────────────────────────
const MOCK_ORDERS = [
  {
    id: 'gid://shopify/Order/1001', name: '#1001', processedAt: '2026-05-24T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '450.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li1', title: 'Elite Collar', quantity: 5, variant: { id: 'v301', sku: 'EC-001-S-NV', title: 'Small / Navy', selectedOptions: [{ name: 'Size', value: 'Small' }, { name: 'Color', value: 'Navy' }], price: '36.00', inventoryQuantity: 24 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '18.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '36.00', currencyCode: 'USD' } } } },
      { node: { id: 'li2', title: 'Luxe Leash', quantity: 2, variant: { id: 'v302', sku: 'LL-005', price: '75.00', inventoryQuantity: 5 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '37.50', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '75.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet: { presentmentMoney: { amount: '420.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } },
    totalTaxSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    billingAddress:  { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    fulfillments: [],
    transactions: [{ id: 'tx1', status: 'PENDING', kind: 'AUTHORIZATION', gateway: 'manual', createdAt: '2026-05-24T10:00:00Z', amountSet: { presentmentMoney: { amount: '450.00', currencyCode: 'USD' } } }],
  },
  {
    id: 'gid://shopify/Order/1002', name: '#1002', processedAt: '2026-05-23T14:00:00Z',
    customer: { id: 'gid://shopify/Customer/102', displayName: 'Happy Paws Boutique', email: 'orders@happypaws.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '285.50', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: 'Ship by Friday',
    lineItems: { edges: [
      { node: { id: 'li3', title: 'Simplicity Collar', quantity: 10, variant: { id: 'v303', sku: 'SC-002-M-RD', title: 'Medium / Red', selectedOptions: [{ name: 'Size', value: 'Medium' }, { name: 'Color', value: 'Red' }], price: '22.00', inventoryQuantity: 7 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '11.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '22.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '275.50', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    billingAddress:  { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    fulfillments: [], transactions: [],
  },
  {
    id: 'gid://shopify/Order/1003', name: '#1003', processedAt: '2026-05-22T09:30:00Z',
    customer: { id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot', email: 'wholesale@doggo.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li4', title: 'Elite Collar Bundle XL', quantity: 20, variant: { id: 'v304', sku: 'ECB-010-XL', title: 'XL', selectedOptions: [{ name: 'Size', value: 'XL' }], price: '60.00', inventoryQuantity: 8 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    billingAddress:  { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'TRACK123', url: null, company: 'UPS' }], createdAt: '2026-05-23T12:00:00Z' }],
    transactions: [{ id: 'tx2', status: 'SUCCESS', kind: 'SALE', gateway: 'manual', createdAt: '2026-05-22T11:00:00Z', amountSet: { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } } }],
  },
  {
    id: 'gid://shopify/Order/1004', name: '#1004', processedAt: '2026-05-21T16:00:00Z',
    customer: { id: 'gid://shopify/Customer/104', displayName: 'Pet Paradise', email: 'buy@petparadise.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '675.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: 'Partial ship OK',
    lineItems: { edges: [
      { node: { id: 'li5', title: 'Everyday Collar', quantity: 15, variant: { id: 'v305', sku: 'EC-003-L-BK', title: 'Large / Black', selectedOptions: [{ name: 'Size', value: 'Large' }, { name: 'Color', value: 'Black' }], price: '30.00', inventoryQuantity: 12 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } } } },
      { node: { id: 'li6', title: 'Leash Set', quantity: 5, variant: { id: 'v306', sku: 'LS-007', price: '45.00', inventoryQuantity: 3 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '45.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '45.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '675.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', address2: 'Suite 4', city: 'Miami', province: 'FL', zip: '33101', country: 'US' },
    billingAddress:  { firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', address2: 'Suite 4', city: 'Miami', province: 'FL', zip: '33101', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'TRACK456', url: null, company: 'FedEx' }], createdAt: '2026-05-22T09:00:00Z' }],
    transactions: [{ id: 'tx3', status: 'SUCCESS', kind: 'SALE', gateway: 'manual', createdAt: '2026-05-21T17:00:00Z', amountSet: { presentmentMoney: { amount: '675.00', currencyCode: 'USD' } } }],
  },
  // SparkLayer wholesale order (historical — pre-portal)
  {
    id: 'gid://shopify/Order/1005', name: '#1005', processedAt: '2026-05-18T11:00:00Z',
    customer: { id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot', email: 'wholesale@doggo.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '540.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['sparklayer', 'b2b'], note: 'SparkLayer historical order',
    lineItems: { edges: [
      { node: { id: 'li7', title: 'Elite Collar', quantity: 9, variant: { id: 'v301', sku: 'EC-001-S-NV', title: 'Small / Navy', selectedOptions: [{ name: 'Size', value: 'Small' }, { name: 'Color', value: 'Navy' }], price: '36.00', inventoryQuantity: 24 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '18.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '36.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '540.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    billingAddress:  { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'SPKL001', url: null, company: 'UPS' }], createdAt: '2026-05-19T09:00:00Z' }],
    transactions: [{ id: 'tx4', status: 'SUCCESS', kind: 'SALE', gateway: 'manual', createdAt: '2026-05-18T11:30:00Z', amountSet: { presentmentMoney: { amount: '540.00', currencyCode: 'USD' } } }],
  },
  // POS order (from dog show / in-person sale)
  {
    id: 'gid://shopify/Order/1006', name: '#1006', processedAt: '2026-05-15T14:30:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '220.00', currencyCode: 'USD' } },
    sourceName: 'pos', tags: [], note: 'In-person at dog show',
    lineItems: { edges: [
      { node: { id: 'li8', title: 'Luxe Leash', quantity: 4, variant: { id: 'v302', sku: 'LL-005', price: '55.00', inventoryQuantity: 5 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '55.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '55.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '220.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: null, billingAddress: null,
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [], createdAt: '2026-05-15T14:30:00Z' }],
    transactions: [{ id: 'tx5', status: 'SUCCESS', kind: 'SALE', gateway: 'pos', createdAt: '2026-05-15T14:30:00Z', amountSet: { presentmentMoney: { amount: '220.00', currencyCode: 'USD' } } }],
  },
  // Second build (Build C): a dedicated PENDING fixture for record-manual-payment testing.
  // NOT mutated by the mark-paid / bulk / edit tests (which use #1001/#1002), so its outstanding
  // balance is deterministic at test time. Carries totalOutstandingSet so the MOCK route reads it
  // authoritatively (mirrors the real Shopify Order.totalOutstandingSet field).
  {
    id: 'gid://shopify/Order/1007', name: '#1007', processedAt: '2026-05-26T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/102', displayName: 'Happy Paws Boutique', email: 'orders@happypaws.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '200.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li9', title: 'Everyday Walking Lead', quantity: 4, variant: { id: 'v307', sku: 'EWL-009', price: '50.00', inventoryQuantity: 20 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '50.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '50.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '200.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalOutstandingSet:   { presentmentMoney: { amount: '200.00', currencyCode: 'USD' } },
    totalReceivedSet:      { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    billingAddress:  { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    fulfillments: [],
    transactions: [{ id: 'tx7', status: 'PENDING', kind: 'AUTHORIZATION', gateway: 'manual', createdAt: '2026-05-26T10:00:00Z', amountSet: { presentmentMoney: { amount: '200.00', currencyCode: 'USD' } } }],
  },
  // CURRENT-FIELDS test fixture (#1008): an EDITED order. Mirrors live #37639's pathology — the FROZEN
  // subtotal/totalPriceSet stay at the ORIGINAL ($300.00) while currentSubtotal/currentTotalPriceSet carry
  // the post-edit truth ($110.00). 3 line edges: one partial (qty 2 → currentQuantity 1), one untouched
  // (qty 1), one fully removed (currentQuantity 0). So 2 lines are active; a correct first paint shows 2 rows
  // and $110.00, NOT 3 rows / $300.00. Used by the ui.test "edited order renders current state on first paint".
  {
    id: 'gid://shopify/Order/1008', name: '#1008', processedAt: '2026-05-27T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet:    { presentmentMoney: { amount: '300.00', currencyCode: 'USD' } }, // FROZEN original
    subtotalPriceSet: { presentmentMoney: { amount: '300.00', currencyCode: 'USD' } }, // FROZEN original
    currentTotalPriceSet:    { presentmentMoney: { amount: '110.00', currencyCode: 'USD' } }, // post-edit truth
    currentSubtotalPriceSet: { presentmentMoney: { amount: '110.00', currencyCode: 'USD' } }, // post-edit truth
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      // partial: qty 2 → currentQuantity 1 @ $30 ⇒ contributes $30
      { node: { id: 'li1008a', title: 'Edited Partial Collar', quantity: 2, currentQuantity: 1, variant: { id: 'v401', sku: 'EP-001', price: '30.00', inventoryQuantity: 10 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } } } },
      // untouched: qty 1 / currentQuantity 1 @ $80 ⇒ contributes $80
      { node: { id: 'li1008b', title: 'Untouched Leash', quantity: 1, currentQuantity: 1, variant: { id: 'v402', sku: 'UL-002', price: '80.00', inventoryQuantity: 4 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } } } },
      // fully removed: currentQuantity 0 — MUST be hidden, MUST NOT contribute to subtotal
      { node: { id: 'li1008c', title: 'Removed Harness', quantity: 1, currentQuantity: 0, variant: { id: 'v403', sku: 'RH-003', price: '190.00', inventoryQuantity: 2 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '190.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '190.00', currencyCode: 'USD' } } } },
    ]},
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalOutstandingSet:   { presentmentMoney: { amount: '110.00', currencyCode: 'USD' } },
    totalReceivedSet:      { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    billingAddress:  { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    fulfillments: [],
    transactions: [{ id: 'tx8', status: 'PENDING', kind: 'AUTHORIZATION', gateway: 'manual', createdAt: '2026-05-27T10:00:00Z', amountSet: { presentmentMoney: { amount: '110.00', currencyCode: 'USD' } } }],
  },
  // ORDER-LEVEL discount fixture (#1009): mirrors live #37637 (SparkLayer 50% ACROSS). The discount is a
  // CART/ORDER-level allocation (discountApplication.targetSelection 'ALL') — so per-line
  // discountedUnitPriceSet == originalUnitPriceSet (the LIST price; the discount is NOT baked into the
  // price sets) and the only evidence of the discount is discountAllocations. discountedTotalSet is also
  // the pre-cart-discount line total. List 100 + 60 = 160; 50% across → allocations 50 + 30 = 80, so the
  // true post-ALL-discounts subtotal (and currentSubtotalPriceSet) is 80.00 — NOT 160.00. A correct
  // invoice must show per-line wholesale 50.00 / 30.00 and Line Totals 50.00 / 30.00 (Σ = 80.00); the
  // pre-fix bug summed the list prices to 160.00 (~2x). No edits here (currentQuantity == quantity).
  {
    id: 'gid://shopify/Order/1009', name: '#1009', processedAt: '2026-05-28T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot', email: 'wholesale@doggo.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet:           { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } },
    subtotalPriceSet:        { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } },  // already net of cart discount
    currentTotalPriceSet:    { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } },
    currentSubtotalPriceSet: { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['sparklayer', 'b2b'], note: '',
    lineItems: { edges: [
      { node: { id: 'li1009a', title: 'Across Discount Collar', quantity: 1, currentQuantity: 1, variant: { id: 'v501', sku: 'ADC-001', price: '100.00', inventoryQuantity: 9, selectedOptions: [] },
          discountedUnitPriceSet: { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
          discountedTotalSet:     { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
          discountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: '50.00', currencyCode: 'USD' } }, discountApplication: { targetSelection: 'ALL' } }] } },
      { node: { id: 'li1009b', title: 'Across Discount Leash', quantity: 1, currentQuantity: 1, variant: { id: 'v502', sku: 'ADL-002', price: '60.00', inventoryQuantity: 6, selectedOptions: [] },
          discountedUnitPriceSet: { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } },
          discountedTotalSet:     { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } },
          discountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } }, discountApplication: { targetSelection: 'ALL' } }] } },
    ]},
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalOutstandingSet:   { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } },
    totalReceivedSet:      { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    billingAddress:  { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    fulfillments: [],
    transactions: [{ id: 'tx9', status: 'PENDING', kind: 'AUTHORIZATION', gateway: 'manual', createdAt: '2026-05-28T10:00:00Z', amountSet: { presentmentMoney: { amount: '80.00', currencyCode: 'USD' } } }],
  },
  // INVOICE-MONEY test fixture (#1010). Every other fixture hardcodes totalTaxSet '0.00', which made
  // two whole classes of money bug structurally untestable. This one carries:
  //   • non-zero TAX (8.00) and SHIPPING (10.00) — so an invoice that bills either of them twice is
  //     visible in the stored totals, which it was not before.
  //   • a COMPED line (li1009b): 100% line-level EXPLICIT discount. Shopify reports
  //     discountedUnitPriceSet/discountedTotalSet of "0.00" and charges the customer nothing. A
  //     truthiness-based fallback reads that legitimate 0.00 as "field absent" and substitutes the
  //     45.99 list price. Nothing in the old fixtures had a zero here, so nothing could catch it.
  // Correct arithmetic: 4 x 25.00 = 100.00 subtotal (the comped line contributes 0.00),
  // + 10.00 shipping + 8.00 tax = 118.00 total.
  {
    id: 'gid://shopify/Order/1010', name: '#1010', processedAt: '2026-05-29T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet:    { presentmentMoney: { amount: '118.00', currencyCode: 'USD' } },
    subtotalPriceSet: { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
    currentTotalPriceSet:    { presentmentMoney: { amount: '118.00', currencyCode: 'USD' } },
    currentSubtotalPriceSet: { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li1010a', title: 'Billed Collar', quantity: 4, currentQuantity: 4, variant: { id: 'v601', sku: 'BC-001', price: '25.00', inventoryQuantity: 10 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '25.00', currencyCode: 'USD' } },
          discountedTotalSet:     { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } } } },
      // Comped replacement: charged 0.00, allocation is EXPLICIT (line-level), NOT 'ALL'.
      { node: { id: 'li1010b', title: 'Comped Replacement Collar', quantity: 2, currentQuantity: 2, variant: { id: 'v602', sku: 'CR-002', price: '45.99', inventoryQuantity: 5 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '45.99', currencyCode: 'USD' } },
          discountedTotalSet:     { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
          discountAllocations: [{ allocatedAmountSet: { presentmentMoney: { amount: '91.98', currencyCode: 'USD' } },
                                  discountApplication: { targetSelection: 'EXPLICIT' } }] } },
    ]},
    totalShippingPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '8.00', currencyCode: 'USD' } },
    totalOutstandingSet:   { presentmentMoney: { amount: '118.00', currencyCode: 'USD' } },
    totalReceivedSet:      { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    billingAddress:  { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'TRACK1009', url: null, company: 'UPS' }], createdAt: '2026-05-30T12:00:00Z' }],
    transactions: [],
  },
];

// In-memory overrides for mock mutations (mark paid, note changes)
const mockOrderOverrides = new Map(); // numericId → { displayFinancialStatus?, note? }

// WHAT: MOCK-only order fetch — finds the MOCK_ORDERS fixture by gid and layers in any in-memory mockOrderOverrides (mark-paid / note edits).
// CHANGE-GUARD: overrides are keyed by the NUMERIC id string; any mock mutation route must write the same key shape or the override won't apply. Returns null for unknown ids (callers 404).
// INVARIANT(S): pure read of process-memory fixtures — resets on restart; never used when MOCK is off.
function getMockOrder(numericId) {
  const gid = `gid://shopify/Order/${numericId}`;
  const order = MOCK_ORDERS.find(o => o.id === gid);
  if (!order) return null;
  const overrides = mockOrderOverrides.get(numericId) || {};
  return { ...order, ...overrides };
}

const MOCK_CUSTOMERS = [
  {
    id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply',
    email: 'buyer@acme.com', phone: '+1-555-0101',
    tags: ['b2b', 'b2b-tier:gold'],
    amountSpent: { amount: '4520.00', currencyCode: 'USD' },
    numberOfOrders: 23,
    defaultAddress: { id: 'addr1', firstName: 'John', lastName: 'Doe', address1: '123 Main St', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    addresses: [{ id: 'addr1', firstName: 'John', lastName: 'Doe', address1: '123 Main St', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' }],
    metafields: { edges: [
      { node: { id: 'mf1', namespace: 'b2b', key: 'dropship_enabled', value: 'false', type: 'boolean' } },
      { node: { id: 'mf4', namespace: 'b2b', key: 'discount_pct', value: '60', type: 'number_integer' } },
    ]},
  },
  {
    id: 'gid://shopify/Customer/102', displayName: 'Happy Paws Boutique',
    email: 'orders@happypaws.com', phone: '+1-555-0102',
    tags: ['b2b', 'b2b-tier:silver'],
    amountSpent: { amount: '2890.00', currencyCode: 'USD' },
    numberOfOrders: 15,
    defaultAddress: { id: 'addr2', firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    addresses: [{ id: 'addr2', firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' }],
    metafields: { edges: [
      { node: { id: 'mf2', namespace: 'b2b', key: 'dropship_enabled', value: 'true', type: 'boolean' } },
      { node: { id: 'mf3', namespace: 'b2b', key: 'dropship_margin_pct', value: '30', type: 'number_integer' } },
    ]},
  },
  {
    id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot',
    email: 'wholesale@doggo.com', phone: '+1-555-0103',
    tags: ['b2b'],
    amountSpent: { amount: '1850.00', currencyCode: 'USD' },
    numberOfOrders: 9,
    defaultAddress: { id: 'addr3', firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    addresses: [{ id: 'addr3', firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', city: 'Austin', province: 'TX', zip: '78701', country: 'US' }],
    metafields: { edges: [] },
  },
  {
    id: 'gid://shopify/Customer/104', displayName: 'Pet Paradise',
    email: 'buy@petparadise.com', phone: '+1-555-0104',
    tags: ['b2b', 'b2b-tier:gold'],
    amountSpent: { amount: '1200.00', currencyCode: 'USD' },
    numberOfOrders: 7,
    defaultAddress: { id: 'addr4', firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', city: 'Miami', province: 'FL', zip: '33101', country: 'US' },
    addresses: [{ id: 'addr4', firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', city: 'Miami', province: 'FL', zip: '33101', country: 'US' }],
    metafields: { edges: [] },
  },
  {
    id: 'gid://shopify/Customer/105', displayName: 'Paw Central',
    email: 'orders@pawcentral.com', phone: '+1-555-0105',
    tags: ['b2b', 'b2b-tier:silver'],
    amountSpent: { amount: '890.00', currencyCode: 'USD' },
    numberOfOrders: 5,
    defaultAddress: null,
    addresses: [],
    metafields: { edges: [] },
  },
  // SparkLayer legacy customer (not yet b2b-tagged)
  {
    id: 'gid://shopify/Customer/106', displayName: 'Top Dog Boutique',
    email: 'buying@topdogboutique.com', phone: '+1-555-0106',
    tags: ['sparklayer', 'sparklayer-customer'],
    amountSpent: { amount: '3100.00', currencyCode: 'USD' },
    numberOfOrders: 11,
    defaultAddress: { id: 'addr6', firstName: 'Dave', lastName: 'Lee', address1: '100 Elm St', city: 'Portland', province: 'OR', zip: '97201', country: 'US' },
    addresses: [{ id: 'addr6', firstName: 'Dave', lastName: 'Lee', address1: '100 Elm St', city: 'Portland', province: 'OR', zip: '97201', country: 'US' }],
    metafields: { edges: [] },
  },
];

// In-memory override store for mock mode (Phase 7). Key = numericId string.
const mockB2bConfigOverrides = new Map();

const MOCK_PRODUCTS = [
  { id: 'gid://shopify/Product/201', title: 'Elite Collar', handle: 'elite-collar',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Elite', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/elite-collar-1.jpg', altText: 'Elite Collar' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/elite-collar-1.jpg', altText: '' } },
      { node: { url: 'https://cdn.shopify.com/mock/elite-collar-2.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/301', title: 'Small / Navy', sku: 'EC-001-S-NV', price: '36.00', compareAtPrice: '54.00', barcode: '012345678901', inventoryQuantity: 24, selectedOptions: [{ name: 'Size', value: 'Small' }, { name: 'Color', value: 'Navy' }] } },
      { node: { id: 'gid://shopify/ProductVariant/302', title: 'Medium / Navy', sku: 'EC-001-M-NV', price: '36.00', compareAtPrice: '54.00', barcode: '012345678902', inventoryQuantity: 12, selectedOptions: [{ name: 'Size', value: 'Medium' }, { name: 'Color', value: 'Navy' }] } },
      { node: { id: 'gid://shopify/ProductVariant/307', title: 'Large / Navy',  sku: 'EC-001-L-NV', price: '36.00', compareAtPrice: '54.00', barcode: '',             inventoryQuantity: 0, selectedOptions: [{ name: 'Size', value: 'Large' }, { name: 'Color', value: 'Navy' }] } },
    ]}
  },
  { id: 'gid://shopify/Product/202', title: 'Luxe Leash', handle: 'luxe-leash',
    vendor: 'Fuzzywumpets', productType: 'Dog Leash', tags: ['Style_Luxe', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/luxe-leash-1.jpg', altText: 'Luxe Leash' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/luxe-leash-1.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/303', title: 'Default Title', sku: 'LL-005', price: '75.00', compareAtPrice: '112.00', barcode: '012345678903', inventoryQuantity: 5 } },
    ]}
  },
  { id: 'gid://shopify/Product/203', title: 'Simplicity Collar', handle: 'simplicity-collar',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Simplicity', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/simplicity-collar-1.jpg', altText: 'Simplicity Collar' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/simplicity-collar-1.jpg', altText: '' } },
      { node: { url: 'https://cdn.shopify.com/mock/simplicity-collar-2.jpg', altText: '' } },
      { node: { url: 'https://cdn.shopify.com/mock/simplicity-collar-3.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/304', title: 'Medium / Red', sku: 'SC-002-M-RD', price: '22.00', compareAtPrice: '33.00', barcode: '012345678904', inventoryQuantity: 7  } },
      { node: { id: 'gid://shopify/ProductVariant/305', title: 'Large / Red',  sku: 'SC-002-L-RD', price: '22.00', compareAtPrice: '33.00', barcode: '012345678905', inventoryQuantity: 18 } },
    ]}
  },
  { id: 'gid://shopify/Product/204', title: 'Everyday Collar Bundle', handle: 'everyday-collar-bundle',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Everyday', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/everyday-bundle-1.jpg', altText: 'Everyday Collar Bundle' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/everyday-bundle-1.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/306', title: 'XL', sku: 'ECB-010-XL', price: '60.00', compareAtPrice: '90.00', barcode: '012345678906', inventoryQuantity: 8, selectedOptions: [{ name: 'Size', value: 'XL' }] } },
    ]}
  },
  // Two-dimension product (Width × Size) — exercises the grouped picker's width sub-headers.
  { id: 'gid://shopify/Product/205', title: 'Pinpoint Limited Slip', handle: 'pinpoint-limited-slip',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Pinpoint', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/pinpoint-1.jpg', altText: 'Pinpoint Limited Slip' },
    images: { edges: [ { node: { url: 'https://cdn.shopify.com/mock/pinpoint-1.jpg', altText: '' } } ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/350', title: '1/2" / SM',  sku: 'PLS-12-SM',  price: '28.00', compareAtPrice: '42.00', barcode: '', inventoryQuantity: 10, selectedOptions: [{ name: 'Width', value: '1/2"' }, { name: 'Size', value: 'SM' }] } },
      { node: { id: 'gid://shopify/ProductVariant/351', title: '1/2" / MED', sku: 'PLS-12-MED', price: '28.00', compareAtPrice: '42.00', barcode: '', inventoryQuantity: 6,  selectedOptions: [{ name: 'Width', value: '1/2"' }, { name: 'Size', value: 'MED' }] } },
      { node: { id: 'gid://shopify/ProductVariant/352', title: '1/2" / LG',  sku: 'PLS-12-LG',  price: '28.00', compareAtPrice: '42.00', barcode: '', inventoryQuantity: 3,  selectedOptions: [{ name: 'Width', value: '1/2"' }, { name: 'Size', value: 'LG' }] } },
      { node: { id: 'gid://shopify/ProductVariant/353', title: '1.5" / SM',  sku: 'PLS-15-SM',  price: '32.00', compareAtPrice: '48.00', barcode: '', inventoryQuantity: 9,  selectedOptions: [{ name: 'Width', value: '1.5"' }, { name: 'Size', value: 'SM' }] } },
      { node: { id: 'gid://shopify/ProductVariant/354', title: '1.5" / MED', sku: 'PLS-15-MED', price: '32.00', compareAtPrice: '48.00', barcode: '', inventoryQuantity: 4,  selectedOptions: [{ name: 'Width', value: '1.5"' }, { name: 'Size', value: 'MED' }] } },
    ]}
  },
];

// Phase 3 mock data ─────────────────────────────────────────────────────────
const MOCK_CATALOG_PRODUCTS = [
  { id: 'gid://shopify/Product/201', title: 'Elite Collar', handle: 'elite-collar',
    vendor: 'Fuzzywumpets', tags: ['Style_Elite', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/301', sku: 'EC-001-S-NV', title: 'Small / Navy', inventoryQuantity: 24 } },
      { node: { id: 'gid://shopify/ProductVariant/302', sku: 'EC-001-M-NV', title: 'Medium / Navy', inventoryQuantity: 12 } },
      { node: { id: 'gid://shopify/ProductVariant/307', sku: 'EC-001-L-NV', title: 'Large / Navy', inventoryQuantity: 0 } },
    ]}
  },
  { id: 'gid://shopify/Product/202', title: 'Luxe Leash', handle: 'luxe-leash',
    vendor: 'Fuzzywumpets', tags: ['Style_Luxe', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/303', sku: 'LL-005', title: 'Default Title', inventoryQuantity: 5 } },
    ]}
  },
  { id: 'gid://shopify/Product/203', title: 'Simplicity Collar', handle: 'simplicity-collar',
    vendor: 'Fuzzywumpets', tags: ['Style_Simplicity', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/304', sku: 'SC-002-M-RD', title: 'Medium / Red', inventoryQuantity: 7 } },
      { node: { id: 'gid://shopify/ProductVariant/305', sku: 'SC-002-L-RD', title: 'Large / Red', inventoryQuantity: 18 } },
    ]}
  },
  { id: 'gid://shopify/Product/204', title: 'Everyday Collar Bundle', handle: 'everyday-collar-bundle',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/306', sku: 'ECB-010-XL', title: 'XL', inventoryQuantity: 8 } },
    ]}
  },
  { id: 'gid://shopify/Product/205', title: 'Everyday Collar Starter', handle: 'everyday-collar-starter',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday'], publishedOnB2B: false, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/308', sku: 'EC-STR-S', title: 'Small', inventoryQuantity: 45 } },
      { node: { id: 'gid://shopify/ProductVariant/309', sku: 'EC-STR-M', title: 'Medium', inventoryQuantity: 32 } },
    ]}
  },
  { id: 'gid://shopify/Product/206', title: 'Elite Harness', handle: 'elite-harness',
    vendor: 'Fuzzywumpets', tags: ['Style_Elite', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/310', sku: 'EH-001-S', title: 'Small', inventoryQuantity: 3 } },
      { node: { id: 'gid://shopify/ProductVariant/311', sku: 'EH-001-M', title: 'Medium', inventoryQuantity: 9 } },
    ]}
  },
  { id: 'gid://shopify/Product/207', title: 'Everyday Bandana (Draft)', handle: 'everyday-bandana-draft',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday'], publishedOnB2B: false, status: 'draft',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/312', sku: 'EB-DFT-S', title: 'Small', inventoryQuantity: 0 } },
    ]}
  },
  { id: 'gid://shopify/Product/208', title: 'Legacy Slip Lead (Archived)', handle: 'legacy-slip-lead',
    vendor: 'Fuzzywumpets', tags: ['Style_Simplicity'], publishedOnB2B: false, status: 'archived',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/313', sku: 'LSL-OLD-OS', title: 'One Size', inventoryQuantity: 0 } },
    ]}
  },
  // Phase 25 test fixture: non-FWW vendor product (should be hidden by default vendor filter)
  { id: 'gid://shopify/Product/210', title: 'FMS Toy Ball - Red', handle: 'fms-toy-ball-red',
    vendor: 'FMS', tags: ['toy'], publishedOnB2B: false, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/320', sku: 'FMS-TB-R', title: 'Default Title', inventoryQuantity: 50 } },
    ]}
  },
];
const mockCatalogOverrides = new Map();

const MOCK_MONTHLY_REVENUE = [
  { month: '2025-06', revenue: 4250.00, orders: 8 },
  { month: '2025-07', revenue: 5100.50, orders: 10 },
  { month: '2025-08', revenue: 6800.00, orders: 13 },
  { month: '2025-09', revenue: 5950.00, orders: 11 },
  { month: '2025-10', revenue: 7200.00, orders: 14 },
  { month: '2025-11', revenue: 8400.00, orders: 17 },
  { month: '2025-12', revenue: 9100.00, orders: 19 },
  { month: '2026-01', revenue: 6200.00, orders: 12 },
  { month: '2026-02', revenue: 7100.00, orders: 14 },
  { month: '2026-03', revenue: 8800.00, orders: 18 },
  { month: '2026-04', revenue: 7500.00, orders: 15 },
  { month: '2026-05', revenue: 4650.00, orders: 9 },
];

const MOCK_CUSTOMER_REVENUE = [
  { id: '101', name: 'Acme Pet Supply',    email: 'buyer@acme.com',         revenue: 14520, orders: 23, aov: 631 },
  { id: '102', name: 'Happy Paws Boutique', email: 'orders@happypaws.com',  revenue: 8890,  orders: 15, aov: 593 },
  { id: '103', name: 'Doggo Depot',         email: 'wholesale@doggo.com',   revenue: 5850,  orders: 9,  aov: 650 },
  { id: '104', name: 'Pet Paradise',        email: 'buy@petparadise.com',   revenue: 4200,  orders: 7,  aov: 600 },
  { id: '105', name: 'Paw Central',         email: 'orders@pawcentral.com', revenue: 2890,  orders: 5,  aov: 578 },
];

// Build variant → product lookup from MOCK_PRODUCTS (mock mode only)
const MOCK_VARIANT_PRODUCT = new Map(); // variantId (short like 'v301') → productNumericId
// WHAT: builds MOCK_VARIANT_PRODUCT, a variant→product reverse index used by order-detail to link line items back to a product page in mock mode.
// CHANGE-GUARD: stores BOTH `v<num>` and bare `<num>` keys because mock line items reference variants as short ids ('v301') while live data uses numeric ids; order-detail lookup tries both forms, so keep both inserts.
// INVARIANT(S): only meaningful in MOCK; relies on shopifyNumericId to strip gids consistently.
for (const p of MOCK_PRODUCTS) {
  const pNum = shopifyNumericId(p.id);
  for (const { node: v } of (p.variants?.edges || [])) {
    const vNum = shopifyNumericId(v.id);
    MOCK_VARIANT_PRODUCT.set(`v${vNum}`, pNum);
    MOCK_VARIANT_PRODUCT.set(vNum, pNum); // also map numeric form
  }
}

const MOCK_PRODUCT_REVENUE = [
  { id: '201', title: 'Elite Collar',           sku: 'EC-001-*', revenue: 8640,  units: 240 },
  { id: '202', title: 'Luxe Leash',             sku: 'LL-005',   revenue: 6375,  units: 85  },
  { id: '203', title: 'Simplicity Collar',      sku: 'SC-002-*', revenue: 4400,  units: 200 },
  { id: '204', title: 'Everyday Collar Bundle', sku: 'ECB-010',  revenue: 3600,  units: 60  },
  { id: '206', title: 'Elite Harness',          sku: 'EH-001-*', revenue: 2200,  units: 55  },
];

const MOCK_SPARKLAYER_CUSTOMERS = [
  { id: 'gid://shopify/Customer/201', displayName: 'SparkLayer Test Store', email: 'sl@retailer.com',     tags: ['sparklayer-customer'] },
  { id: 'gid://shopify/Customer/202', displayName: 'Old Portal Boutique',   email: 'old@boutique.com',    tags: ['sparklayer-account', 'b2b-portal-v1'] },
  { id: 'gid://shopify/Customer/203', displayName: 'Migrated Early',        email: 'migrated@store.com',  tags: ['sparklayer-customer', 'b2b'] },
];
const mockSparkLayerMigrated = new Set(['203']); // id 203 already has b2b

// ── Cookie helpers ────────────────────────────────────────────────────────────
// WHAT: minimal cookie parser (no cookie-parser dep) — splits the Cookie header on ';', URL-decodes the value of the named cookie.
// CHANGE-GUARD: only consumer is the session lookup (COOKIE_NAME); if you add signed cookies, do it here. Returns null when absent so requireAuth treats it as unauthenticated.
// INVARIANT(S): trims keys/values; first '=' splits k/v so values may contain '='; does not handle quoted-string cookie values.
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// WHAT: serializes the Set-Cookie header for the admin session — HttpOnly, SameSite=Lax, 7-day Max-Age (604800s), +Secure outside MOCK.
// CHANGE-GUARD: dropping Secure/HttpOnly/SameSite weakens session security; the expire=true variant (Max-Age=0, empty value) is the logout path — keep both in sync with COOKIE_NAME.
// INVARIANT(S): SameSite=Lax + no CSRF token means state-changing POSTs rely on Lax to block cross-site form posts; any route changed to accept simple cross-site requests needs a CSRF defense.
function sessionCookie(sid, expire = false) {
  const val    = expire ? '' : encodeURIComponent(sid);
  const maxAge = expire ? 0 : 604800;
  const secure = !MOCK ? '; Secure' : '';
  return `${COOKIE_NAME}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
// WHAT: Express middleware gating every page/API behind a valid admin_sessions cookie; also stamps lastDashboardActivity to drive the activity-gated Shopify poller.
// CHANGE-GUARD: re-test that /api/* returns 401 JSON (not an HTML redirect) and that browser routes redirect to /login; touching lastDashboardActivity here changes when syncRecentFromShopify fires.
// INVARIANT(S): this is the ONLY auth gate — every mutating route must mount it; session lookup must reject expired/missing sids; no route may trust req.params/body for identity.
// WHAT: THE auth gate for every page/API — stamps lastDashboardActivity, looks up the session by cookie, attaches req.adminSession, else 401-JSON for /api/* or redirect to /login.
// CHANGE-GUARD: every mutating route MUST be mounted behind this; the /api/* vs HTML split must stay so XHR callers get JSON 401 not an HTML redirect. Re-test an expired sid returns 401 on /api and /login redirect on pages.
// INVARIANT(S): identity comes ONLY from getSession(cookie) — never trust req.params/body for who the actor is; NOTE it stamps lastDashboardActivity BEFORE the auth check, so even unauthenticated hits keep the Shopify poller 'active'.
function requireAuth(req, res, next) {
  lastDashboardActivity = Date.now();
  const session = getSession(getCookie(req, COOKIE_NAME));
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not authenticated' });
    return res.redirect('/login');
  }
  req.adminSession = session;
  next();
}



const US_STATE_CODES = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE',
  'Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
  'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS',
  'Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
  'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
  'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV',
  'Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC','DC':'DC'
};
// WHAT: normalizes a US state to its 2-letter code (passes through already-2-char inputs upcased, maps full names via US_STATE_CODES, else returns input unchanged).
// CHANGE-GUARD: used for address normalization feeding shipping/Xero; an unknown full name passes through verbatim (no throw), so downstream must tolerate non-codes. Keep US_STATE_CODES (incl. DC) in sync with carrier expectations.
// INVARIANT(S): idempotent — toStateCode(toStateCode(x))===toStateCode(x); 2-char fast-path assumes any 2-char string is already a code.
function toStateCode(s) {
  if (!s) return s;
  if (s.length === 2) return s.toUpperCase();
  return US_STATE_CODES[s] || s;
}


// WHAT: renders the '🔄 Synced N min/hr/d ago' relative-time badge from a ms epoch, with the exact ISO timestamp in the title attr.
// CHANGE-GUARD: thresholds are 60s/3600s/86400000ms — purely cosmetic; returns '' when syncedAt is falsy so list headers omit the badge cleanly.
// INVARIANT(S): syncedAt is epoch MILLISECONDS (Date.now() form), not seconds — passing seconds yields nonsense durations.
function fmtSyncBadge(syncedAt) {
  if (!syncedAt) return '';
  const ms = Date.now() - syncedAt;
  let label;
  if (ms < 60000) label = 'just now';
  else if (ms < 3600000) label = Math.floor(ms / 60000) + ' min ago';
  else if (ms < 86400000) label = Math.floor(ms / 3600000) + ' hr ago';
  else label = Math.floor(ms / 86400000) + 'd ago';
  return `<span class="text-muted small-text" style="font-size:11px;margin-left:8px" title="Cache last refreshed ${new Date(syncedAt).toISOString()}">🔄 Synced ${label}</span>`;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
// WHAT: THE HTML-escape helper — escapes & < > " ' for safe interpolation into server-rendered template strings.
// CHANGE-GUARD: this is the project's primary XSS defense in the string-templated HTML; any new dynamic value injected into markup MUST pass through h(). Order matters: & is escaped first so later entities aren't double-escaped. Re-test with a value containing <script> and a quote.
// INVARIANT(S): null/undefined → '' ; does NOT escape for attribute-less JS contexts (inline onclick handlers build strings separately and need their own escaping).
function h(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// WHAT: JSON serializer SAFE to embed inside an inline <script>. h() is NOT enough here — a value
// containing </script> or a JS-string-breaking char must be neutralized at the script/JS layer.
// Escapes < > & and the JS line separators U+2028/U+2029 as \uXXXX (still valid JSON to JSON.parse).
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/[<>&\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

// WHAT: returns the URL only if it is a safe http(s) scheme, else '#'. Blocks javascript:/data:/vbscript:
// in href/src sinks (h() prevents attribute breakout but does NOT validate the scheme). Still h() the result.
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\//i.test(s) ? s : '#';
}

// WHAT: admin allowlist read FRESH from env on every call, so /settings/allowlist/add (which updates
// process.env after a Doppler write) takes effect immediately instead of after a process restart.
function currentAllowedEmails() {
  return (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function fmtMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount) || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Second build (Build D): order-history timeline helpers ─────────────────────
// All pure functions. They take RAW stored strings (from getOrderHistory) and return
// plain text — every value is escaped via h() at the render site, never here.

// WHAT: staff initials from an email local-part or display name. alex@→A, mason@→M,
//   first.last@→FL, "Jane Doe"→JD. Falls back to '?'.
// INVARIANT(S): pure; never throws on null/empty.
function staffInitials(emailOrName) {
  const s = String(emailOrName || '').trim();
  if (!s) return '?';
  const local = s.includes('@') ? s.split('@')[0] : s;
  const parts = local.split(/[.\-_\s]+/).filter(Boolean);
  if (!parts.length) return (local[0] || '?').toUpperCase();
  return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

// WHAT: "Jun 29, 2026 · 1:42 PM" from an epoch-ms timestamp.
function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function safeJsonParse(str) {
  if (str == null) return null;
  try { return JSON.parse(str); } catch { return null; }
}

// WHAT: human one-line summary of an order_edit_log row. Handles BOTH shapes:
//   - incremental (Phase 16H): { action:'line/add', payload:{...} }
//   - legacy batch: { qtys, removes, prices, discountPct, discountFixed, addVariantLines, addCustomLines }
//   Rows are full post-edit state, not deltas, so counts are described, not diffs.
// INVARIANT(S): pure; returns a plain string (escaped at render). staffNote, when present,
//   is appended as a parenthetical so it shows in the timeline.
function summarizeEdit(changesJson, staffNote) {
  const c = safeJsonParse(changesJson) || {};
  let line;
  if (c.action) {
    // Incremental auto-save shape.
    const p = c.payload || {};
    switch (c.action) {
      case 'line/add':    line = `added ${p.title || p.sku || 'an item'}${p.qty ? ` × ${p.qty}` : ''}`; break;
      case 'line/custom': line = `added custom line "${p.title || 'item'}"${p.qty ? ` × ${p.qty}` : ''}`; break;
      case 'line/qty':    line = `changed a line quantity${p.qty != null ? ` to ${p.qty}` : ''}`; break;
      case 'line/price':  line = `changed a line price${p.price != null ? ` to ${fmtMoney(p.price)}` : ''}`; break;
      case 'line/remove': line = 'removed a line'; break;
      case 'discount/order': line = `applied an order discount${p.discountPct ? ` (${p.discountPct}%)` : p.discountFixed ? ` (${fmtMoney(p.discountFixed)})` : ''}${p.discountReason ? ` — ${p.discountReason}` : ''}`; break;
      default: line = `edited the order (${String(c.action).replace(/[/_:]/g, ' ')})`;
    }
  } else {
    // Legacy batch shape — describe the bundle of changes.
    const bits = [];
    const addV = Array.isArray(c.addVariantLines) ? c.addVariantLines.length : 0;
    const addC = Array.isArray(c.addCustomLines) ? c.addCustomLines.length : 0;
    if (addV) bits.push(`added ${addV} catalog line${addV === 1 ? '' : 's'}`);
    if (addC) bits.push(`added ${addC} custom line${addC === 1 ? '' : 's'}`);
    const removed = Array.isArray(c.removes) ? c.removes.length : 0;
    if (removed) bits.push(`removed ${removed} line${removed === 1 ? '' : 's'}`);
    const qtyN = c.qtys && typeof c.qtys === 'object' ? Object.keys(c.qtys).length : 0;
    if (qtyN) bits.push(`updated ${qtyN} quantit${qtyN === 1 ? 'y' : 'ies'}`);
    const priceN = c.prices && typeof c.prices === 'object' ? Object.keys(c.prices).length : 0;
    if (priceN) bits.push(`updated ${priceN} price${priceN === 1 ? '' : 's'}`);
    if (c.discountPct) bits.push(`applied ${c.discountPct}% discount`);
    else if (c.discountFixed) bits.push(`applied ${fmtMoney(c.discountFixed)} discount`);
    line = bits.length ? `edited the order: ${bits.join(', ')}` : 'edited the order';
  }
  if (staffNote) line += ` — "${staffNote}"`;
  return line;
}

// WHAT: human summary of an order_edit_action row (fallback path only).
function summarizeEditAction(action, payloadJson) {
  return summarizeEdit(JSON.stringify({ action, payload: safeJsonParse(payloadJson) || {} }), null);
}

// WHAT: human summary of a NON-edit admin_audit_log verb. after_val carries the detail.
// INVARIANT(S): pure; unknown verbs fall back to a readable form of the verb string.
function summarizeAudit(action, afterJson) {
  const after = safeJsonParse(afterJson) || {};
  switch (action) {
    case 'mark_paid':              return 'marked the order paid';
    case 'record_manual_payment': {
      const amt = after.amount && after.amount !== 'full_outstanding' ? fmtMoney(after.amount) : 'the full balance';
      const method = after.paymentMethod ? ` via ${after.paymentMethod}` : '';
      return `recorded a manual payment of ${amt}${method}`;
    }
    case 'order_cancel':           return `canceled the order${after.reason ? ` (${String(after.reason).toLowerCase()})` : ''}`;
    case 'create_order':           return `created the order${after.lineItemCount ? ` (${after.lineItemCount} line${after.lineItemCount === 1 ? '' : 's'})` : ''}`;
    case 'order_fulfill':          return `recorded a fulfillment${after.trackingNumber ? ` (tracking ${after.trackingNumber})` : ''}`;
    case 'partial_invoice_created':return `issued invoice ${after.letter || ''}${after.type ? ` (${String(after.type).replace(/_/g, ' ')})` : ''}${after.total != null ? ` for ${fmtMoney(after.total)}` : ''}`.replace(/\s+/g, ' ').trim();
    case 'visible-note-add':       return 'added a customer-visible note';
    case 'update_note':            return 'updated the internal order note';
    case 'xero:sync':              return 'synced the order to Xero';
    case 'xero:payment_recorded':  return `recorded a Xero payment${after.amount != null ? ` of ${fmtMoney(after.amount)}` : ''}`;
    case 'xero:invoice_failed':    return 'Xero invoice sync failed';
    case 'chase_invoice_queued':   return 'queued a Chase invoice link';
    default:                       return String(action || 'activity').replace(/[/_:]/g, ' ');
  }
}

// WHAT: server-rendered #order-history-card body (newest-first). One row per event:
//   initials chip · actor · summary · datetime. Mirrors the existing visible-notes list
//   styling (lime left-border, pale background). No client JS, no new route.
// CHANGE-GUARD: every dynamic value is escaped via h(). The card id #order-history-card
//   is fresh — do NOT reuse #visible-notes-list / #customer-replies-list (the inline JS
//   keys off those ids). Empty history renders a muted placeholder, never an empty card.
function renderOrderHistoryCard(history) {
  const rows = (history || []).map(ev => {
    let summary;
    if (ev.kind === 'edit') summary = summarizeEdit(ev.changesJson, ev.staffNote);
    else if (ev.kind === 'edit_action') summary = summarizeEditAction(ev.action, ev.payloadJson);
    else summary = summarizeAudit(ev.action, ev.afterJson);
    const initials = staffInitials(ev.actor);
    return `<div style="display:flex;gap:10px;align-items:flex-start;border-left:3px solid var(--lime);padding:8px 12px;margin-bottom:8px;background:#f9fdf0;border-radius:0 4px 4px 0">
      <span title="${h(ev.actor || '')}" style="flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--lime,#9BBC0E);color:#1a2400;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center">${h(initials)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px"><b>${h(ev.actor || 'Someone')}</b> ${h(summary)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${h(fmtDateTime(ev.ts))}</div>
      </div>
    </div>`;
  }).join('');
  const count = (history || []).length;
  // COLLAPSE: default-collapsed <details> with a count badge so the noisy audit timeline
  // doesn't push the customer-facing chat box / visible-note box below the fold. id stays
  // #order-history-card (inline JS / tests key off it). No `open` attr = collapsed by default.
  return `<details class="card" id="order-history-card">
    <summary class="card-header" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;list-style:none">
      <h2>Order History <span class="badge badge-muted" style="margin-left:6px">${count}</span></h2>
      <span class="text-muted" style="font-size:11px">click to expand</span>
    </summary>
    <div style="margin-top:10px">${rows || '<p class="text-muted small-text">No history yet.</p>'}</div>
  </details>`;
}

// WHAT: extracts the trailing numeric id from a Shopify gid (gid://shopify/Order/1001 → '1001') by taking the last '/'-segment.
// CHANGE-GUARD: used everywhere to bridge gid↔numeric (routes, cache keys, mock lookups); returns null for falsy input. If Shopify ever changes gid format this single function localizes the fix.
// INVARIANT(S): returns a STRING, not a number; passing an already-numeric id returns it unchanged (no '/').
function shopifyNumericId(gid) {
  return gid ? String(gid).split('/').pop() : null;
}

// WHAT: inverse of shopifyNumericId for orders/customers — rebuilds the canonical gid from a numeric id for GraphQL queries and Xero/audit keys.
// CHANGE-GUARD: the gid string here is used as a primary KEY in getXeroMap/audit/backorders — it must byte-match the form Shopify returns; a trailing-space or case change orphans existing rows.
// INVARIANT(S): numId should be the bare numeric (no gid); do not double-wrap an already-gid value.
function shopifyOrderGid(numId)    { return `gid://shopify/Order/${numId}`; }
function shopifyCustomerGid(numId) { return `gid://shopify/Customer/${numId}`; }

// ── HTML layout ───────────────────────────────────────────────────────────────
function gfonts() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">`;
}

// WHAT: master page shell — renders header/nav/user-email + injects content; also ships the global keyboard-shortcut handler and syncCacheNow() helper inline.
// CHANGE-GUARD: navItems is the single source of the top-nav; the keyboard 'g+<key>' map in the inline script must mirror these hrefs or shortcuts dead-link. title is escaped via h() but `content` is injected RAW — callers are responsible for escaping their own dynamic values before passing them in.
// INVARIANT(S): activePath drives the .active nav class via exact-equality match; session?.email is the only user-identity shown and is h()-escaped.
function layout({ title, session, activePath = '/', content, extraHead = '' }) {
  const navItems = [
    ['/', 'Dashboard'], ['/orders', 'Orders'], ['/customers', 'Customers'],
    ['/leads', 'Leads'], ['/catalog', 'Catalog'], ['/backorders', 'Backorders'], ['/reports', 'Reports'],
    ['/labels', 'Labels'], ['/exports', 'Exports'],
    ['/tax-exempt', 'Tax Exempt'], ['/accounting', 'Accounting'],
    ['/settings', 'Settings'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(title)} — FWW Admin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#9BBC0E">
  ${gfonts()}
  <link rel="stylesheet" href="/admin.css">
  ${extraHead}
</head>
<body>
  <header class="admin-header">
    <div class="header-inner">
      <a href="/" class="header-logo">
        <span class="logo-fw">FW</span><span class="logo-admin">admin</span>
      </a>
      <nav class="header-nav">
        ${navItems.map(([href, label]) =>
          `<a href="${href}" class="nav-link${activePath === href ? ' active' : ''}">${label}</a>`
        ).join('')}
      </nav>
      <div class="header-user">
        <span class="user-email">${h(session?.email || '')}</span>
        <a href="/login" id="signout-link" class="btn-signout" role="button">Sign out</a>
      </div>
    </div>
  </header>
  <main class="main-content">
    ${content}
  </main>
  <div id="kb-overlay" class="kb-overlay hidden" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <div class="kb-overlay-inner">
      <h3>Keyboard Shortcuts</h3>
      <table class="kb-table">
        <tr><td><kbd>/</kbd></td><td>Focus search</td></tr>
        <tr><td><kbd>g</kbd> <kbd>d</kbd></td><td>Go to Dashboard</td></tr>
        <tr><td><kbd>g</kbd> <kbd>o</kbd></td><td>Go to Orders</td></tr>
        <tr><td><kbd>g</kbd> <kbd>c</kbd></td><td>Go to Customers</td></tr>
        <tr><td><kbd>g</kbd> <kbd>l</kbd></td><td>Go to Catalog</td></tr>
        <tr><td><kbd>g</kbd> <kbd>r</kbd></td><td>Go to Reports</td></tr>
        <tr><td><kbd>g</kbd> <kbd>b</kbd></td><td>Go to Labels</td></tr>
        <tr><td><kbd>g</kbd> <kbd>e</kbd></td><td>Go to Exports</td></tr>
        <tr><td><kbd>?</kbd></td><td>Toggle this overlay</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close overlay</td></tr>
      </table>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('kb-overlay').classList.add('hidden')">Close</button>
    </div>
  </div>
  <script>
  (function() {
    // Sign out is a POST (CSRF-safe via SameSite=Lax, same as every other mutation) issued as a
    // fetch so no <form> element is added to the DOM (a hidden header form would be the first
    // 'form' match and break tests/UX that key off the page's primary form).
    var _so = document.getElementById('signout-link');
    if (_so) _so.addEventListener('click', function(e){ e.preventDefault(); fetch('/auth/logout', { method: 'POST' }).then(function(){ location.href = '/login'; }).catch(function(){ location.href = '/login'; }); });
    var gDown = false, gTimer = null;
    document.addEventListener('keydown', function(e) {
      var tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        var o = document.getElementById('kb-overlay');
        if (o) o.classList.toggle('hidden');
        return;
      }
      if (e.key === 'Escape') {
        var o = document.getElementById('kb-overlay');
        if (o) o.classList.add('hidden');
        return;
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        var s = document.querySelector('.search-input, #filter-q, input[type="search"]');
        if (s) s.focus();
        return;
      }
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        gDown = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(function() { gDown = false; }, 1000);
        return;
      }
      if (gDown) {
        gDown = false;
        clearTimeout(gTimer);
        var map = { d: '/', o: '/orders', c: '/customers', l: '/catalog', r: '/reports', b: '/labels', e: '/exports', s: '/settings' };
        if (map[e.key]) { e.preventDefault(); window.location = map[e.key]; }
      }
    });
  })();
  </script>
  <script>
// WHAT: client helper POSTing /api/admin/sync-now to force a Shopify→cache refresh, with button busy/disabled state and reload-on-success.
// CHANGE-GUARD: relies on the server returning { ok:true } JSON; if the route path or response shape changes, the 'Sync now' buttons on Orders/Customers break. Re-test the busy→synced→reload flow and the failure alert.
// INVARIANT(S): it disables the button to prevent double-submits but does NOT debounce across page instances; server route must be idempotent under rapid clicks.
  window.syncCacheNow = async function(btn) {
    btn.disabled = true;
    var orig = btn.innerHTML;
    btn.innerHTML = '\u27F3 Syncing\u2026';
    try {
      var r = await fetch('/api/admin/sync-now', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      var j = await r.json();
      if (j && j.ok) {
        btn.innerHTML = '\u2713 Synced';
        setTimeout(function(){ window.location.reload(); }, 600);
      } else {
        btn.innerHTML = orig;
        btn.disabled = false;
        alert('Sync failed: ' + ((j && j.error) || 'unknown'));
      }
    } catch (e) {
      btn.innerHTML = orig;
      btn.disabled = false;
      alert('Sync error: ' + e.message);
    }
  };
  </script>
</body>
</html>`;
}

function renderLogin(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — FWW Admin</title>${gfonts()}
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo"><span class="logo-fw">FW</span><span class="logo-admin">admin</span></div>
    <p class="login-tagline">Fuzzywumpets Internal Dashboard</p>
    ${error ? `<div class="alert alert-error" style="margin-bottom:1.25rem;text-align:left">${h(error)}</div>` : ''}
    <a href="/auth/login" class="btn-google">
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
        <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
      </svg>
      Sign in with Google
    </a>
    <p class="login-note">Access restricted to authorized Fuzzywumpets admin emails.</p>
  </div>
</body></html>`;
}

function renderUnauthorized(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied — FWW Admin</title>${gfonts()}<link rel="stylesheet" href="/admin.css">
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo"><span class="logo-fw">FW</span><span class="logo-admin">admin</span></div>
    <div class="alert alert-error" style="margin-top:1.5rem;text-align:left">
      <strong>Not authorized.</strong><br>
      <span style="word-break:break-all">${h(email)}</span> is not on the admin allowlist.
      Contact Alexa to request access.
    </div>
    <a href="/login" class="btn-google" style="margin-top:1.25rem;background:#f5f5f5;color:#374151;border-color:#e5e7eb">← Back to login</a>
  </div>
</body></html>`;
}

function renderComingSoon(session, label, activePath) {
  return layout({ title: label, session, activePath, content: `
    <div class="page-header"><h1>${h(label)}</h1></div>
    <div class="coming-soon"><h2>${h(label)}</h2><p>Coming in the next phase — check back soon.</p></div>
  ` });
}

// ── Shopify ───────────────────────────────────────────────────────────────────
// WHAT: single choke-point for all live Shopify GraphQL, proxied through the shopify-bridge Cloudflare worker with SHOPIFY_BRIDGE_BEARER.
// CHANGE-GUARD: if the bridge URL, bearer env name, or error-shape handling changes, every order/customer/product/catalog feature breaks at once; re-test one read and one mutation.
// INVARIANT(S): throws on res.!ok and on json.errors[] so callers can try/catch; callers must inspect per-mutation userErrors separately (this only catches transport/top-level errors, NOT mutation userErrors).
// WHAT: single choke-point for all live Shopify GraphQL via the shopify-bridge worker with Bearer SHOPIFY_BRIDGE_BEARER.
// CHANGE-GUARD: hardcoded worker URL (shopify-bridge.alex-037.workers.dev/api/graphql) — if the bridge host or bearer env name changes, EVERY order/customer/product/catalog read+mutation breaks at once; re-test one read and one mutation.
// INVARIANT(S): throws on !res.ok and on json.errors[] (transport/top-level), but does NOT inspect per-mutation userErrors — callers running mutations must check userErrors themselves; bearer is empty-string default so a missing env yields 401s from the bridge, not a local throw.
async function shopifyFetch(query, variables = {}) {
  const res = await fetch('https://shopify-bridge.alex-037.workers.dev/api/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SHOPIFY_BEARER}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`shopify-bridge ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
// WHAT: assembles the dashboard model — open orders, week count, top customers, low-stock B2B variants, 12-mo revenue, pending-Xero-review list.
// CHANGE-GUARD: live path issues TWO parallel shopifyFetch calls (orders tag:b2b-portal last 90d, products published) via Promise.all; the orders query is capped at first:50 with NO pagination, so >50 recent B2B orders silently truncate the open/week counts. Re-verify counts when volume grows.
// INVARIANT(S): top customers prefer the all-time cache (getTopCustomersAllTime) and only fall back to the 90-day live spend map when the cache is empty; low-stock threshold is inventoryQuantity<10 and only for variants on the B2B publication; whole function is wrapped so any error returns a safe zeroed shape with .error set.
const DASHBOARD_CACHE_TTL_MS = 60_000;
let dashboardCache = { data: null, ts: 0 };

async function getDashboardData() {
  if (!MOCK && dashboardCache.data && (Date.now() - dashboardCache.ts) < DASHBOARD_CACHE_TTL_MS) {
    return dashboardCache.data;
  }
  if (MOCK) {
    return {
      openOrdersCount: 2,
      openOrders: MOCK_ORDERS.filter(o => ['PENDING','AUTHORIZED'].includes(o.displayFinancialStatus)).slice(0, 5),
      weekOrdersCount: 3,
      topCustomers: [...MOCK_CUSTOMERS]
        .sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0))
        .slice(0, 5)
        .map(c => ({ id: c.id, name: c.displayName, email: c.email, spend: parseFloat(c.amountSpent.amount), orders: c.numberOfOrders })),
      lowStockItems: [
        { productId: 'gid://shopify/Product/201', productTitle: 'Elite Collar', variantTitle: 'Large / Navy', sku: 'EC-001-L-NV', qty: 0 },
        { productId: 'gid://shopify/Product/202', productTitle: 'Luxe Leash', variantTitle: 'Default Title', sku: 'LL-005', qty: 5 },
        { productId: 'gid://shopify/Product/203', productTitle: 'Simplicity Collar', variantTitle: 'Medium / Red', sku: 'SC-002-M-RD', qty: 7 },
        { productId: 'gid://shopify/Product/204', productTitle: 'Everyday Collar Bundle', variantTitle: 'XL', sku: 'ECB-010-XL', qty: 8 },
      ],
      monthly: MOCK_MONTHLY_REVENUE,
    };
  }
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const [ordersResult, productsResult] = await Promise.all([
      shopifyFetch(`query($q:String!){ orders(first:50,query:$q,sortKey:PROCESSED_AT,reverse:true){
        edges{node{id name processedAt customer{id displayName email} displayFinancialStatus
          totalPriceSet{presentmentMoney{amount currencyCode}} tags}}
        pageInfo{hasNextPage}}}`, { q: `tag:b2b-portal created_at:>${ninetyDaysAgo}` }),
// WHAT: low-stock source query — pulls first:100 published products with publishedOnPublication(B2B_PUB_ID) and first:10 variants each.
// CHANGE-GUARD: DOUBLE truncation risk — first:100 products AND first:10 variants/product with no paging; a catalog beyond those caps drops products/variants from the low-stock widget silently. B2B_PUB_ID is the hardcoded publication gid (199709720811) gating B2B visibility.
// INVARIANT(S): only variants on the B2B publication count (p.publishedOnPublication guard); inventoryQuantity must be a number to be considered.
      shopifyFetch(`query{ products(first:100,query:"published_status:published"){
        edges{node{id title publishedOnPublication(publicationId:"${B2B_PUB_ID}")
          variants(first:10){edges{node{sku title inventoryQuantity}}}}}}}`)
    ]);
    const orders = ordersResult.data?.orders?.edges?.map(e => e.node) || [];
    const openStatuses = new Set(['PENDING','AUTHORIZED','PARTIALLY_PAID']);
    const openOrders = orders.filter(o => openStatuses.has(o.displayFinancialStatus));
    const weekOrders = orders.filter(o => o.processedAt >= sevenDaysAgo);
    const spend = new Map();
    for (const o of orders) {
      if (!o.customer) continue;
      const { id, displayName, email } = o.customer;
      const amt = parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
      if (!spend.has(id)) spend.set(id, { id, name: displayName, email, spend: 0 });
      spend.get(id).spend += amt;
    }
    // Phase 20A: use all-time top from cache (instead of 90-day window from live orders)
    let topCustomers = [];
    try {
      const stats = getCustomerCacheStats();
      if (stats && stats.total > 0) {
        topCustomers = getTopCustomersAllTime(5);
      }
    } catch (e) {
      console.error('top customers cache read failed:', e.message);
    }
    // Fallback to 90-day window from live orders if cache is empty
    if (topCustomers.length === 0) {
      topCustomers = [...spend.values()].sort((a, b) => b.spend - a.spend).slice(0, 5);
    }
    const allProducts = productsResult.data?.products?.edges?.map(e => e.node) || [];
    const lowStockItems = [];
    for (const p of allProducts) {
      if (!p.publishedOnPublication) continue;
      for (const ve of (p.variants?.edges || [])) {
        const v = ve.node;
        if (typeof v.inventoryQuantity === 'number' && v.inventoryQuantity < 10)
          lowStockItems.push({ productId: p.id, productTitle: p.title, variantTitle: v.title, sku: v.sku, qty: v.inventoryQuantity });
      }
    }
    const pendingReview = getCustomersPendingXeroReview();
    let monthly = [];
    try { const rd = getReportsDataFromCache(); monthly = rd.monthly || []; } catch(e) {}
    const result = { openOrdersCount: openOrders.length, openOrders: openOrders.slice(0, 5), weekOrdersCount: weekOrders.length, topCustomers, lowStockItems: lowStockItems.sort((a,b)=>a.qty-b.qty).slice(0,10), pendingReview, monthly };
    dashboardCache = { data: result, ts: Date.now() };
    return result;
  } catch (err) {
    console.error('getDashboardData error:', err.message);
    return { error: err.message, openOrdersCount:0, openOrders:[], weekOrdersCount:0, topCustomers:[], lowStockItems:[], pendingReview:[] };
  }
}

// WHAT: pure HTML renderer for the dashboard widgets (open orders, week, top customers, revenue chart, low stock, pending Xero review).
// CHANGE-GUARD: assumes the getDashboardData shape; data.error renders a non-fatal warning banner rather than failing. Revenue chart calls renderBarChart (defined later, ~line 5060) — keep its data contract {label,value} stable.
// INVARIANT(S): every dynamic customer/order field is h()-escaped; row-critical/qty-zero CSS classes are driven by qty===0 / qty<=3 thresholds and must agree with the data's low-stock cutoff.
function renderDashboard(session, data) {
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const openOrdersTable = data.openOrders?.length > 0
    ? `<table class="mini-table"><thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${data.openOrders.map(o => `<tr>
        <td><a href="/orders/${shopifyNumericId(o.id)}">${h(o.name)}</a></td>
        <td>${h(o.customer?.displayName || '—')}</td>
        <td>${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount, o.totalPriceSet?.presentmentMoney?.currencyCode)}</td>
        <td><span class="badge badge-${h((o.displayFinancialStatus||'').toLowerCase())}">${h(o.displayFinancialStatus)}</span></td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">No open orders</p>';

  const topCustomersTable = data.topCustomers?.length > 0
    ? `<table class="mini-table"><thead><tr><th>Customer</th><th class="text-right">Spend</th><th class="text-right">Orders</th></tr></thead><tbody>
      ${data.topCustomers.map((c, i) => `<tr>
        <td><span class="top-customer-star" title="Top customer">★</span> <a href="/customers/${shopifyNumericId(c.id)}">${h(c.name)}</a><br><small class="text-muted">${h(c.email)}</small></td>
        <td class="text-right mono">${fmtMoney(c.spend)}</td>
        <td class="text-right"><a href="/orders?customer=${shopifyNumericId(c.id)}" class="link">${c.orders ?? '—'}</a></td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">No customer data</p>';

  const pendingReviewTable = data.pendingReview?.length > 0
    ? `<table class="data-table compact"><thead><tr><th>Customer</th><th class="text-right">Spend</th><th></th></tr></thead><tbody>
      ${data.pendingReview.slice(0, 5).map(c => `<tr>
        <td><a href="/customers/${h(c.id)}">${h(c.company || c.displayName)}</a><br><small class="text-muted">${h(c.email || '')}</small></td>
        <td class="text-right mono">${fmtMoney(c.spend)}</td>
        <td class="text-right"><a href="/customers/${h(c.id)}" class="btn btn-ghost btn-sm">Review</a></td>
      </tr>`).join('')}
    </tbody></table>${data.pendingReview.length > 5 ? `<p class="text-muted small-text" style="margin-top:8px;font-size:11px">+${data.pendingReview.length - 5} more</p>` : ''}`
    : '<p class="empty-state">All B2B customers synced to Xero ✓</p>';

  // Revenue chart
  const _monthly = data.monthly || [];
  const _chartData = _monthly.map(d => ({ label: d.month.slice(5), value: d.revenue || 0 }));
  const _revenueChart = _chartData.length
    ? renderBarChart(_chartData, { width: 540, height: 100 })
    : '<p class="empty-state">No cached revenue data yet.</p>';
  const _totalRev12m = _monthly.reduce((s, d) => s + (d.revenue || 0), 0);
  const revenueWidget = `${_revenueChart}<div style="font-size:12px;color:var(--muted);margin-top:6px">12-month total: <strong>$${_totalRev12m.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})}</strong></div>`;

  const lowStockTable = data.lowStockItems?.length > 0
    ? `<table class="mini-table"><thead><tr><th>Product / Variant</th><th>SKU</th><th>Qty</th></tr></thead><tbody>
      ${data.lowStockItems.map(item => `<tr class="${item.qty===0?'row-critical':item.qty<=3?'row-warning':''}">
        <td><a href="/catalog/${shopifyNumericId(item.productId)}">${h(item.productTitle)}</a>
          ${item.variantTitle && item.variantTitle !== 'Default Title' ? `<small>${h(item.variantTitle)}</small>` : ''}</td>
        <td class="mono">${h(item.sku||'—')}</td>
        <td class="${item.qty===0?'qty-zero':item.qty<=3?'qty-critical':'qty-low'}">${item.qty}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">All items well-stocked ✓</p>';

  return layout({ title: 'Dashboard', session, activePath: '/', content: `
    <div class="page-header"><h1>Dashboard</h1><span class="text-muted">${h(today)}</span></div>
    ${data.error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(data.error)}</div>` : ''}
    <div class="widget-grid">
      <div class="widget">
        <div class="widget-header"><h2>Open Orders</h2><a href="/orders?status=open" class="widget-link">View all →</a></div>
        <div class="widget-stat">${data.openOrdersCount??0}</div>
        <p class="widget-subtext">awaiting payment</p>
        ${openOrdersTable}
      </div>
      <div class="widget">
        <div class="widget-header"><h2>This Week</h2><a href="/orders?date=7d" class="widget-link">View →</a></div>
        <div class="widget-stat">${data.weekOrdersCount??0}</div>
        <p class="widget-subtext">B2B orders in last 7 days</p>
      </div>
      <div class="widget">
        <div class="widget-header"><h2>Top Customers</h2><a href="/customers" class="widget-link">View all →</a></div>
        ${topCustomersTable}
      </div>
      <div class="widget">
        <div class="widget-header"><h2>Revenue (12 months)</h2><a href="/reports" class="widget-link">Full report →</a></div>
        ${revenueWidget}
      </div>
      <div class="widget">
        <div class="widget-header"><h2>Low Stock (B2B)</h2><a href="/catalog?stock=low" class="widget-link">Catalog →</a></div>
        ${lowStockTable}
      </div>
      <div class="widget">
        <div class="widget-header"><h2>Pending Review</h2><span class="widget-link text-muted" style="font-size:11px">B2B customers not yet in Xero</span></div>
        ${pendingReviewTable}
      </div>
    </div>
  ` });
}

// ── Orders list ───────────────────────────────────────────────────────────────
// WHAT: classifies an order's channel from tags+sourceName into one of sparklayer/pos/manual/b2b-portal/online (checked in that PRIORITY order).
// CHANGE-GUARD: order of checks is the precedence — sparklayer tag wins over POS wins over draft_order wins over b2b-portal tag; reordering re-labels historical orders. Drives ORDER_SOURCE_LABELS/COLORS badges.
// INVARIANT(S): any 'sparklayer*' prefixed tag (case-insensitive) classifies as sparklayer; 'draft_order' sourceName means a manually-created order.
function deriveOrderSource(order) {
  const tags = order.tags || [];
  const sn   = order.sourceName || '';
  if (tags.some(t => (t || '').toLowerCase().startsWith('sparklayer'))) return 'sparklayer';
  if (sn === 'pos') return 'pos';
  if (sn === 'draft_order') return 'manual';
  if (tags.includes('b2b-portal')) return 'b2b-portal';
  return 'online';
}

const ORDER_SOURCE_LABELS = { 'b2b-portal': 'B2B', sparklayer: 'SparkLayer', pos: 'POS', manual: 'Manual', online: 'Online' };
const ORDER_SOURCE_COLORS = { 'b2b-portal': 'lime', sparklayer: 'blue', pos: 'orange', manual: 'gray', online: 'muted' };

const FINANCIAL_STATUS_FILTER = {
  pending: ['PENDING','AUTHORIZED'],
  paid:    ['PAID'],
  open:    ['PENDING','AUTHORIZED','PARTIALLY_PAID','UNPAID'],
  refunded: ['REFUNDED','PARTIALLY_REFUNDED'],
  voided:   ['VOIDED'],
};

// WHAT: orders-list data source — prefers the local orders_cache (B2B-only, joined on customers_cache.is_b2b) and falls back to live Shopify; also handles the MOCK fixture path.
// CHANGE-GUARD: the cache branch returns hasNextPage:false and the FULL filtered set with no real pagination, while the live branch pages 50 at a time via after-cursor — these two paths have DIFFERENT pagination semantics, so UI 'Next 50' only works on the live path. Re-test list parity cache-vs-live after filter changes.
// INVARIANT(S): cache is authoritative only when getOrdersCacheStats().total>0; live query string is assembled from qParts and user q is passed THROUGH to Shopify's query DSL (Shopify-side escaping, not SQL) — keep filters server-derived where possible; financial_status filter expands via FINANCIAL_STATUS_FILTER.
async function getOrdersData(filters) {
  // Phase 24D: try cache first (B2B-only by definition — joined to customers_cache where is_b2b=1)
  if (!MOCK) {
    try {
      const stats = getOrdersCacheStats();
      if (stats && stats.total > 0) {
        const cached = listOrdersFromCache(filters);
        return { orders: cached, hasNextPage: false, endCursor: null, total: cached.length, _fromCache: true, _syncedAt: stats.latest };
      }
    } catch (e) {
      console.error('orders cache read failed, falling back to live Shopify:', e.message);
    }
  }
  if (MOCK) {
    let orders = MOCK_ORDERS.map(o => {
      const ov = mockOrderOverrides.get(shopifyNumericId(o.id)) || {};
      return { ...o, ...ov };
    });
    if (filters.source === 'b2b-portal') orders = orders.filter(o => (o.tags||[]).includes('b2b-portal'));
    if (filters.source === 'sparklayer')  orders = orders.filter(o => (o.tags||[]).some(t => t.toLowerCase().startsWith('sparklayer')));
    if (filters.source === 'pos')         orders = orders.filter(o => (o.sourceName||'') === 'pos');
    if (filters.source === 'manual')      orders = orders.filter(o => (o.sourceName||'') === 'draft_order');
    if (filters.q) {
      const q = filters.q.toLowerCase();
      orders = orders.filter(o =>
        o.name.toLowerCase().includes(q) ||
        (o.customer?.displayName || '').toLowerCase().includes(q) ||
        (o.customer?.email || '').toLowerCase().includes(q) ||
        o.lineItems?.edges?.some(e => (e.node.variant?.sku || '').toLowerCase().includes(q))
      );
    }
    if (filters.status && FINANCIAL_STATUS_FILTER[filters.status]) {
      const allowed = FINANCIAL_STATUS_FILTER[filters.status];
      orders = orders.filter(o => allowed.includes(o.displayFinancialStatus));
    }
    if (filters.date) {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.date];
      if (days) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        orders = orders.filter(o => o.processedAt >= cutoff);
      }
    }
    return { orders, hasNextPage: false, endCursor: null, total: orders.length };
  }

  try {
    const qParts = [];  // Phase 9: no default filter — show all orders
    if (filters.source === 'b2b-portal') qParts.push('tag:b2b-portal');
    if (filters.source === 'sparklayer')  qParts.push('tag:sparklayer*');
    if (filters.source === 'pos')         qParts.push('source_name:pos');
    if (filters.source === 'manual')      qParts.push('source_name:draft_order');
    if (filters.q) qParts.push(filters.q);
    if (filters.date) {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.date];
      if (days) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        qParts.push(`created_at:>${cutoff}`);
      }
    }
    if (filters.status && FINANCIAL_STATUS_FILTER[filters.status]) {
      const statuses = FINANCIAL_STATUS_FILTER[filters.status];
      qParts.push(`financial_status:${statuses.join(' OR financial_status:')}`);
    }
    const result = await shopifyFetch(`
      query($q:String!,$first:Int!,$after:String){
        orders(first:$first,query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){
          edges{cursor node{
            id name processedAt
            customer{id displayName email}
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet{presentmentMoney{amount currencyCode}}
            currentSubtotalPriceSet{presentmentMoney{amount currencyCode}}
            currentTotalPriceSet{presentmentMoney{amount currencyCode}}
            sourceName note tags
            lineItems(first:3){edges{node{title quantity currentQuantity variant{sku}}}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: qParts.join(' '), first: 50, after: filters.after || null });
    const edges = result.data?.orders?.edges || [];
    return {
      orders: edges.map(e => e.node),
      hasNextPage: result.data?.orders?.pageInfo?.hasNextPage || false,
      endCursor:   result.data?.orders?.pageInfo?.endCursor   || null,
      total:       edges.length,
    };
  } catch (err) {
    console.error('getOrdersData error:', err.message);
    return { orders: [], error: err.message, hasNextPage: false, endCursor: null, total: 0 };
  }
}

// WHAT: the LIST total for one order row — prefers the CURRENT (post-edit) total, falling back to the frozen
// original. On an EDITED order (e.g. #37639) totalPriceSet is FROZEN at $921.72 while currentTotalPriceSet is
// the truth ($601.24); on an unedited or un-resynced order currentTotalPriceSet is absent and we use the frozen
// total. Mirrors the cache fields populated by listOrdersFromCache and the live currentTotalPriceSet on Shopify.
function listRowTotalAmount(o) {
  const cur = o.currentTotalPriceSet?.presentmentMoney?.amount;
  if (cur != null && cur !== '') return cur;
  return o.totalPriceSet?.presentmentMoney?.amount;
}

// WHAT: renders the orders table + filter bar + bulk-select form (mark-paid) + pagination.
// CHANGE-GUARD: the bulk form POSTs /orders/bulk with checked `ids`; the inline select-all/upd() script wires the bulk bar — keep input name="ids" stable. 'Sync now' button only shows when data._fromCache. Re-test bulk mark-paid after table column changes.
// INVARIANT(S): all order/customer fields h()-escaped; pagination 'Next 50' uses endCursor copied into the after param and only renders when hasNextPage (live path only); colspan on the empty row (10) must match the header column count.
function renderOrdersList(session, data, filters) {
  const { orders, hasNextPage, endCursor, error } = data;

  const rows = orders.map(o => {
    const numId  = shopifyNumericId(o.id);
    const status = (o.displayFinancialStatus || '').toLowerCase();
    const fstatus = (o.displayFulfillmentStatus || '').toLowerCase().replace(/_/g, '-');
    // CURRENT-FIELDS (2026-06-29): list preview reflects what's CURRENTLY in the order — show
    // currentQuantity (post-edit truth, fallback frozen quantity) and skip lines removed in an
    // edit (currentQuantity 0). slice(0,3) AFTER filtering so a removed line never eats a preview slot.
    const lineItemSummary = (o.lineItems?.edges || [])
      .filter(e => ((e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0) > 0)
      .slice(0, 3)
      .map(e => `${e.node.title} ×${e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity}`).join(', ');
    const src = deriveOrderSource(o);
    const srcLabel = ORDER_SOURCE_LABELS[src] || src;
    const srcColor = ORDER_SOURCE_COLORS[src] || 'muted';
    return `<tr>
      <td class="col-check"><input type="checkbox" name="ids" value="${h(numId)}"></td>
      <td><a href="/orders/${h(numId)}" class="order-link">${h(o.name)}</a></td>
      <td>${o.customer ? `<a href="/customers/${shopifyNumericId(o.customer.id)}">${h(o.customer.displayName)}</a><br><small>${h(o.customer.email)}</small>` : '—'}</td>
      <td class="text-muted">${fmtDate(o.processedAt)}</td>
      <td class="text-muted small-text">${h(lineItemSummary)}</td>
      <td class="text-right mono">${fmtMoney(listRowTotalAmount(o), o.totalPriceSet?.presentmentMoney?.currencyCode)}</td>
      <td><span class="badge badge-${h(status)}">${h(o.displayFinancialStatus)}</span></td>
      <td><span class="badge badge-ff-${h(fstatus)}">${h(o.displayFulfillmentStatus)}</span></td>
      <td><a href="/orders/${h(numId)}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const emptyRow = orders.length === 0
    ? `<tr><td colspan="10" class="empty-state">No orders found${filters.q || filters.source || filters.status || filters.date ? ' — try clearing filters' : ''}</td></tr>`
    : '';

  const currentParams = new URLSearchParams();
  if (filters.q)      currentParams.set('q', filters.q);
  if (filters.source) currentParams.set('source', filters.source);
  if (filters.status) currentParams.set('status', filters.status);
  if (filters.date)   currentParams.set('date', filters.date);

  const nextParams = new URLSearchParams(currentParams);
  if (endCursor) nextParams.set('after', endCursor);

  const flash = filters.success === 'marked_paid' ? `<div class="alert alert-success">Order(s) marked as paid.</div>` : '';

  // Source filter removed — all orders shown are B2B (filtered via customers_cache.is_b2b)
  const sourceChips = '';

  return layout({ title: 'Orders', session, activePath: '/orders', content: `
    <div class="page-header-row">
      <h1>Orders ${fmtSyncBadge(data._syncedAt)}</h1>
      <div style="display:flex;gap:8px;align-items:center">
        ${data._fromCache ? '<button type="button" class="btn btn-ghost btn-sm" onclick="syncCacheNow(this)" title="Refresh cache from Shopify">🔄 Sync now</button>' : ''}
        <a href="/orders/new" class="btn btn-primary">+ New Order</a>
      </div>
    </div>
    ${flash}
    ${error ? `<div class="alert alert-warning">Shopify unavailable: ${h(error)}</div>` : ''}
    <div class="filter-chips">${sourceChips}</div>
    <form class="filter-bar" method="GET" action="/orders">
      ${filters.source ? `<input type="hidden" name="source" value="${h(filters.source)}">` : ''}
      <input type="search" name="q" value="${h(filters.q||'')}" placeholder="Order #, customer, SKU…" class="filter-input search-input">
      <select name="status" class="filter-select" onchange="this.form.submit()">
        <option value="">All statuses</option>
        <option value="open"    ${filters.status==='open'?'selected':''}>Open (unpaid)</option>
        <option value="pending" ${filters.status==='pending'?'selected':''}>Pending</option>
        <option value="paid"    ${filters.status==='paid'?'selected':''}>Paid</option>
        <option value="refunded" ${filters.status==='refunded'?'selected':''}>Refunded</option>
        <option value="voided"  ${filters.status==='voided'?'selected':''}>Voided</option>
      </select>
      <select name="date" class="filter-select" onchange="this.form.submit()">
        <option value="">All time</option>
        <option value="7d"  ${filters.date==='7d'?'selected':''}>Last 7 days</option>
        <option value="30d" ${filters.date==='30d'?'selected':''}>Last 30 days</option>
        <option value="90d" ${filters.date==='90d'?'selected':''}>Last 90 days</option>
      </select>
      <button type="submit" class="btn btn-secondary">Filter</button>
      <a href="/orders" class="btn btn-ghost">Clear</a>
    </form>
    <form id="bulk-form" method="POST" action="/orders/bulk">
      <div class="bulk-bar" id="bulk-bar" hidden>
        <span id="bulk-count">0 selected</span>
        <button type="submit" name="action" value="mark-paid" class="btn btn-success btn-sm">Mark Paid</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th class="col-check"><input type="checkbox" id="select-all"></th>
            <th>Order</th><th>Customer</th><th>Date</th><th>Items</th>
            <th class="text-right">Amount</th><th>Payment</th><th>Fulfillment</th><th></th>
          </tr></thead>
          <tbody>${rows}${emptyRow}</tbody>
        </table>
      </div>
    </form>
    <div class="pagination">
      <span class="text-muted">${orders.length} order${orders.length !== 1 ? 's' : ''}</span>
      ${hasNextPage ? `<a href="/orders?${nextParams}" class="btn btn-ghost">Next 50 →</a>` : ''}
    </div>
    <script>
    (function(){
      var selectAll = document.getElementById('select-all');
      var bulkBar   = document.getElementById('bulk-bar');
      var bulkCount = document.getElementById('bulk-count');
      var form      = document.getElementById('bulk-form');
      function upd(){
        var checked = form.querySelectorAll('input[name="ids"]:checked');
        if(checked.length>0){ bulkBar.removeAttribute('hidden'); bulkCount.textContent=checked.length+' selected'; }
        else bulkBar.setAttribute('hidden','');
      }
      selectAll.addEventListener('change',function(){ form.querySelectorAll('input[name="ids"]').forEach(function(c){c.checked=selectAll.checked;}); upd(); });
      form.querySelectorAll('input[name="ids"]').forEach(function(c){ c.addEventListener('change',upd); });
    })();
    </script>
  ` });
}

// ── Order detail ──────────────────────────────────────────────────────────────
// WHAT: fetches one order's full detail (customer, line items w/ variant+barcode, addresses, fulfillments, transactions) for the detail page and Xero sync.
// CHANGE-GUARD: lineItems first:50 and transactions first:10 are HARD caps with no paging — an order with >50 lines or >10 transactions silently drops the overflow from the UI AND from createXeroInvoice's line build. Re-verify large orders invoice correctly. Returns null on any error (caller 404s).
// INVARIANT(S): id is built via shopifyOrderGid(numericId); the selected fields are the contract consumed by renderOrderDetail, createXeroInvoice, and the ship/fulfill flows — adding a consumer means extending this query.
// CURRENT-FIELDS (2026-06-29): each lineItems node carries BOTH quantity (frozen original) and currentQuantity (post-edit truth; 0 = removed). The order carries BOTH subtotal/totalPriceSet (frozen) and currentSubtotal/currentTotalPriceSet (post-edit truth). Consumers that mean "what is in the order NOW" (renderOrderDetail line rows + totals, fulfill/ship/cancel, createXeroInvoice) MUST read the current* variants; the frozen ones are kept only where the ORIGINAL value is intended.
async function getOrderDetail(numericId) {
  if (MOCK) return getMockOrder(numericId);
  try {
    const result = await shopifyFetch(`
      query($id:ID!){ order(id:$id){
        id name processedAt createdAt cancelledAt
        customer{id displayName email phone}
        displayFinancialStatus displayFulfillmentStatus
        totalPriceSet{presentmentMoney{amount currencyCode}}
        subtotalPriceSet{presentmentMoney{amount currencyCode}}
        currentSubtotalPriceSet{presentmentMoney{amount currencyCode}}
        currentTotalPriceSet{presentmentMoney{amount currencyCode}}
        totalShippingPriceSet{presentmentMoney{amount currencyCode}}
        totalTaxSet{presentmentMoney{amount currencyCode}}
        totalOutstandingSet{presentmentMoney{amount currencyCode}}
        totalReceivedSet{presentmentMoney{amount currencyCode}}
        note tags
        shippingAddress{firstName lastName address1 address2 city province zip country phone}
        billingAddress{firstName lastName address1 address2 city province zip country}
        lineItems(first:250){edges{node{id title quantity currentQuantity
          variant{id title sku barcode selectedOptions{name value} price inventoryQuantity product{id title}}
          discountedUnitPriceSet{presentmentMoney{amount currencyCode}}
          originalUnitPriceSet{presentmentMoney{amount currencyCode}}
          discountedTotalSet{presentmentMoney{amount currencyCode}}
          discountAllocations{allocatedAmountSet{presentmentMoney{amount currencyCode}} discountApplication{targetSelection ... on ManualDiscountApplication{description}}}
        }}}
        fulfillments{status trackingInfo{number url company} createdAt}
        transactions(first:10){id status kind gateway createdAt
          amountSet{presentmentMoney{amount currencyCode}}}
      }}`, { id: shopifyOrderGid(numericId) });
    return result.data?.order || null;
  } catch (err) {
    console.error('getOrderDetail error:', err.message);
    return null;
  }
}

// WHAT: renders the customer-visible notes panel (body + date + author) on order detail.
// CHANGE-GUARD: note.body is h()-escaped here, but the CLIENT-side refresh path in visibleNotesScript re-renders with only `.replace(/</g,'<')` — weaker escaping; keep both in mind when changing what fields are shown. Empty list shows a muted placeholder.
// INVARIANT(S): notes come from getVisibleNotesForOrder (portal db), newest-first; addedBy is staff email.
function renderVisibleNotesList(notes) {
  if (!notes || !notes.length) return '<p class="text-muted small-text">No visible notes yet.</p>';
  return notes.map(n => `
    <div style="border-left:3px solid var(--lime);padding:8px 12px;margin-bottom:8px;background:#f9fdf0;border-radius:0 4px 4px 0">
      <div style="font-size:13px;white-space:pre-wrap">${h(n.body)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">${fmtDate(n.addedAt)} · ${h(n.addedBy)}</div>
    </div>`).join('');
}

// WHAT: derives the order's CURRENT (post-edit) subtotal/total straight from a getOrderDetail order
// object. On a FRESH page load of an EDITED order, currentSubtotal/currentTotalPriceSet are the truth and
// subtotal/totalPriceSet are FROZEN at the original — so renderOrderDetail must NOT read the frozen fields.
// CHANGE-GUARD (current-fields, 2026-06-29): the Σ currentQuantity*unitPrice line-sum is ONLY a fallback,
// and it is gated on hasEdit = "some line has currentQuantity != quantity". This is critical: on an
// UNEDITED order that carries an ORDER-LEVEL discount (e.g. SparkLayer B2B 50%), the per-line
// discountedUnitPrice is the LIST price and the line-sum is ~2x the discounted subtotal — so the line-sum
// must NEVER override Shopify's authoritative currentSubtotalPriceSet unless we have real evidence the
// order was edited AND current* is lagging. (An earlier version fired the fallback whenever curSub==origSub
// && lineSum!=origSub, which wrongly doubled the subtotal of discounted unedited orders like #37637.)
// INVARIANT(S): unitPrice prefers discounted then original then 0 (matches the row + invoice math); a line
// with currentQuantity 0 contributes 0 to the subtotal and is excluded from lineCount; when current* is
// present and there is no lagging-edit evidence, current* is used VERBATIM (discounts preserved).
function deriveCurrentOrderTotals(order) {
  const lines = (order.lineItems?.edges || []).map(e => e.node);
  const lineCount = lines.filter(n => ((n.currentQuantity != null ? n.currentQuantity : n.quantity) || 0) > 0).length;
  const lineSubtotal = lines.reduce((s, n) => {
    const cq = (n.currentQuantity != null ? n.currentQuantity : n.quantity) || 0;
    const up = parseFloat(n.discountedUnitPriceSet?.presentmentMoney?.amount ?? n.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
    return s + up * cq;
  }, 0);
  // Real edit evidence: at least one line whose currentQuantity differs from its original quantity.
  const hasEdit = lines.some(n => n.currentQuantity != null && n.currentQuantity !== n.quantity);
  const curSub = order.currentSubtotalPriceSet?.presentmentMoney?.amount;
  const curTot = order.currentTotalPriceSet?.presentmentMoney?.amount;
  const origSub = parseFloat(order.subtotalPriceSet?.presentmentMoney?.amount || 0);
  const origTot = parseFloat(order.totalPriceSet?.presentmentMoney?.amount || 0);
  // current* lags only when the order WAS edited but currentSubtotal still equals the frozen original.
  const curSubLags = hasEdit && curSub != null && Math.abs(parseFloat(curSub) - origSub) < 0.005;
  let subtotal;
  if (curSub != null && !curSubLags) {
    subtotal = parseFloat(curSub);            // authoritative current subtotal (discounts preserved)
  } else {
    subtotal = lineSubtotal;                  // missing, or lagging after a rapid edit → trust the lines
  }
  const curTotLags = hasEdit && curTot != null && Math.abs(parseFloat(curTot) - origTot) < 0.005;
  let total;
  if (curTot != null && !curTotLags) {
    total = parseFloat(curTot);               // authoritative current total
  } else {
    const extras = Math.max(0, origTot - origSub); // shipping + tax baked into the original total
    total = subtotal + extras;
  }
  return { subtotal, total, lineCount };
}

// WHAT: human-readable variant label so the order page surfaces size/colour/etc. instead of
//   leaving the variant buried in the SKU. Prefers Shopify's selectedOptions
//   ("Size: XS · Color: Royal Blue"), falls back to the variant title, and ignores the
//   "Default Title" placeholder single-variant products carry. Returns '' when there's nothing
//   meaningful to show (so the caller can omit the sub-line entirely).
function variantLabel(variant) {
  if (!variant) return '';
  const opts = (variant.selectedOptions || [])
    .filter(o => o && o.value && o.value !== 'Default Title' && (o.name || '').toLowerCase() !== 'title')
    .map(o => `${o.name}: ${o.value}`);
  if (opts.length) return opts.join(' · ');
  const t = (variant.title || '').trim();
  return t && t !== 'Default Title' ? t : '';
}

// WHAT: the large order-detail page — status timeline, editable line items, fulfillments, transactions, address, Xero/partial-invoice state, and all the modal JS (edit/discount/fulfill/backorder/invoice/cancel/ship).
// CHANGE-GUARD: reads several SQLite stores by gid (getXeroMap, getPartialInvoices, getBackordersForOrder) — those keys must match shopifyOrderGid(numId). The edit form posts qtys[]/prices[]/removes/addCustomLines to /orders/:id/edit; serializeCustomLines() must run before submit (onclick on Save). Re-test edit/ship/cancel modals after any markup change since the inline JS selects elements by hardcoded ids.
// INVARIANT(S): flash strings map 1:1 to alert banners — adding a server flash value needs a branch here or it renders silently; client-side ship rates JS sorts by amount and posts to <path>/ship/rates then /ship/label; line-item product links resolve via variant.product.id or the MOCK_VARIANT_PRODUCT fallback.
function renderOrderDetail(session, order, flash, flashMsg) {
  const numId    = shopifyNumericId(order.id);
  const isPaid   = order.displayFinancialStatus === 'PAID';
  // Second build (Build C): outstanding balance for the Record-payment button + modal prefill.
  // Prefer the authoritative totalOutstandingSet from Shopify; fall back to a status-derived
  // estimate (so MOCK fixtures without the field still gate/ prefill sensibly).
  const outstanding = (() => {
    const v = order.totalOutstandingSet?.presentmentMoney?.amount;
    if (v != null && v !== '') return Math.max(0, parseFloat(v) || 0);
    if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.displayFinancialStatus)) return 0;
    // CURRENT-FIELDS (2026-06-29): fall back to the CURRENT total (post-edit), not the frozen original,
    // when Shopify's authoritative totalOutstandingSet is absent (e.g. MOCK fixtures).
    return Math.max(0, deriveCurrentOrderTotals(order).total || 0);
  })();
  const canRecordPayment = !isPaid && outstanding > 0;
  // Xero map (read from SQLite)
  const xeroMap  = getXeroMap(numId);
  // Partial invoices (read from SQLite)
  const partialInvoices = getPartialInvoices(`gid://shopify/Order/${numId}`);
  // Second build (Build D): read-only order-history timeline (edits + non-edit audit verbs).
  const orderHistory = getOrderHistory(`gid://shopify/Order/${numId}`);
  const isFulfilled = ['FULFILLED','PARTIALLY_FULFILLED'].includes(order.displayFulfillmentStatus);
  const finStatus = (order.displayFinancialStatus || '').toLowerCase();
  const fulStatus = (order.displayFulfillmentStatus || '').toLowerCase().replace(/_/g, '-');

  // Status timeline
  const step1done  = true;
// WHAT: status-timeline gating — step2 (Payment) is 'done' for PAID/PARTIALLY_PAID/REFUNDED.
// CHANGE-GUARD: REFUNDED counting as payment-done is intentional (money did change hands) — don't 'fix' it without checking the timeline UX. step3curr/step4curr derive from this, so editing the set shifts which node shows as current.
// INVARIANT(S): the four steps are strictly sequential (current = prev-done && this-not-done); displayFinancialStatus is Shopify's enum, compared verbatim (case-sensitive).
  const step2done  = ['PAID','PARTIALLY_PAID','REFUNDED'].includes(order.displayFinancialStatus);
  const step3done  = isFulfilled;
  const step4done  = order.fulfillments?.some(f => f.status === 'DELIVERED') || false;
  const step2curr  = !step2done;
  const step3curr  = step2done && !step3done;
  const step4curr  = step3done && !step4done;

  function timelineStep(label, done, current) {
    return `<div class="tl-step ${done ? 'tl-done' : current ? 'tl-current' : ''}">${label}</div>`;
  }

  const timeline = `<div class="timeline">
    ${timelineStep('Placed', step1done, false)}
    ${timelineStep('Payment', step2done, step2curr)}
    ${timelineStep('Fulfilled', step3done, step3curr)}
    ${timelineStep('Delivered', step4done, step4curr)}
  </div>`;

  // Backorders for this order (from SQLite) — must be before lineItemsHtml
  const backordersForOrder = getBackordersForOrder(`gid://shopify/Order/${numId}`);
// WHAT: indexes this order's backorder rows by line_item_id so each line can render a ⚠ Backorder badge + ETA.
// CHANGE-GUARD: must be computed BEFORE lineItemsHtml (it is) — moving it after the .map() breaks the badge lookup. Keyed by the Shopify line-item id (item.id), which must match what fulfillBackorder/upsertBackorder persist.
// INVARIANT(S): one backorder row per line item assumed (Map collapses duplicates to the last).
  const backorderMap = new Map(backordersForOrder.map(b => [b.line_item_id, b]));

  // Line items table
  const lineItems = (order.lineItems?.edges || []).map(e => e.node);
  // Phase 16F: infer this order's effective B2B discount % from an existing catalog line
  // (original vs discounted unit price) so the "Add product" UI prefills wholesale pricing.
  // Falls back to the global b2b_discount_pct setting, then 50. Staff can override the unit price inline.
  const editDiscPct = (() => {
    for (const it of lineItems) {
      const o = parseFloat(it.originalUnitPriceSet?.presentmentMoney?.amount || 0);
      const d = parseFloat(it.discountedUnitPriceSet?.presentmentMoney?.amount || 0);
      if (o > 0 && d > 0 && d < o) return Math.round(((o - d) / o) * 1000) / 10;
    }
    const s = parseInt(getSetting('b2b_discount_pct') ?? '50', 10);
    return Number.isFinite(s) ? s : 50;
  })();
// WHAT: builds each editable line-item row — title (linked to product), SKU, qty (static+input), unit price (static+input w/ data-retail), row total, remove toggle, and backorder badge/button.
// CHANGE-GUARD: input names qtys[<liId>], prices[<liId>], and removes are parsed server-side in /orders/:id/edit — renaming any breaks order editing. data-retail carries the original (pre-discount) price for client validation; unitPrice prefers discounted then original then 0.
// CURRENT-FIELDS (2026-06-29): rows render the order's CURRENT state on first paint — qty (static + input)
// and rowTotal key off currentQuantity (post-edit truth), NOT the frozen `quantity`. Lines fully removed
// in an edit (currentQuantity 0) are HIDDEN — Shopify retains them on the order but they're not part of it
// anymore, so they must not show as line rows, inflate the count, or contribute to the subtotal. currentQty
// falls back to `quantity` when the field is absent (MOCK fixtures / unedited orders) so behavior is unchanged there.
// INVARIANT(S): rowTotal = unitPrice * currentQty computed in JS for display only (server recomputes on save); productNum resolves via variant.product.id (live) or MOCK_VARIANT_PRODUCT (mock) and gates whether the title is a link; item.title is escaped into both markup and an onclick string (the onclick path uses replace(/'/g) — fragile, prefer not to add quotes-bearing data there).
  const lineItemsHtml = lineItems.map(item => {
    const currentQty = item.currentQuantity != null ? item.currentQuantity : (item.quantity || 0);
    if (currentQty <= 0) return ''; // removed in a prior edit — not part of the order anymore
    const unitPrice = parseFloat(item.discountedUnitPriceSet?.presentmentMoney?.amount ?? item.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
    const rowTotal  = unitPrice * currentQty;
    // Resolve product ID: from GraphQL `variant.product.id` or mock lookup
    const varId = item.variant?.id || '';
    const productGid = item.variant?.product?.id;
    const productNum = productGid ? shopifyNumericId(productGid) : (MOCK_VARIANT_PRODUCT.get(varId) || MOCK_VARIANT_PRODUCT.get(shopifyNumericId(varId)));
    const titleCell = productNum
      ? `<a href="/products/${productNum}" class="link">${h(item.title)}</a>`
      : h(item.title);
    const vLabel = variantLabel(item.variant);
    const variantSub = vLabel ? `<div class="variant-sub">${h(vLabel)}</div>` : '';
    const bo = backorderMap.get(item.id);
    const boBadge = bo ? `<span class="badge badge-warning" title="ETA: ${bo.eta_date || 'unknown'}">⚠ Backorder</span>` : '';
    // Second build (Build 4): the per-line Backorder control read like a STATUS ("Backorder" on
    // every line in edit mode), making every line look backordered. Relabel/restyle it as a clear
    // ACTION — a small muted "⚑ Mark backordered" link — WITHOUT changing behavior (still opens
    // toggleBackorderModal). Keeps the edit-remove-btn class so the edit-mode toggle reveals it.
    // SECURITY: data-* attributes (read by a delegated listener) instead of an inline onclick — item.title
    // is attacker-controllable free text and an inline handler is a JS-string-injection sink (h() does not
    // make a value safe inside a JS string context; the browser decodes &#x27; back to a quote).
    const boBtn = `<button type="button" class="edit-remove-btn bo-action-btn" title="Flag this line as backordered"
      style="display:none;margin-left:6px;background:none;border:none;padding:0;font-size:11px;color:var(--muted);cursor:pointer;text-decoration:underline;text-underline-offset:2px"
      data-li-id="${h(item.id)}" data-li-title="${h(item.title)}" data-li-qty="${currentQty}">⚑ Mark backordered</button>`;
    return `<tr data-removed="0" data-li-id="${h(item.id)}" data-existing="1">
      <td>${titleCell} ${boBadge}${boBtn}
        ${variantSub}
        <span class="row-save-chip" data-state="idle" style="display:none;margin-left:8px;font-size:11px;vertical-align:middle"></span>
        <input type="hidden" name="removes" value="${h(item.id)}" disabled id="remove_${h(item.id)}">
      </td>
      <td class="mono">${h(item.variant?.sku || '—')}</td>
      <td class="text-right">
        <span class="edit-qty-static">${currentQty}</span>
        <input type="number" name="qtys[${h(item.id)}]" value="${currentQty}" min="0" class="edit-qty-input" style="display:none;width:60px">
        <button type="button" class="btn btn-ghost btn-xs edit-remove-btn" style="display:none;margin-left:4px" onclick="markRemove('${h(item.id)}',this)">✕</button>
      </td>
      <td class="text-right">
        <span class="edit-price-static">${fmtMoney(unitPrice)}</span>
        <input type="number" step="0.01" min="0" name="prices[${h(item.id)}]" value="${unitPrice.toFixed(2)}" class="edit-price-input" data-retail="${parseFloat(item.originalUnitPriceSet?.presentmentMoney?.amount ?? unitPrice).toFixed(2)}" style="display:none;width:72px">
      </td>
      <td class="text-right">${fmtMoney(rowTotal)}</td>
    </tr>`;
  }).join('');

  // CURRENT-FIELDS (2026-06-29): show the CURRENT (post-edit) subtotal/total on first paint — the frozen
  // subtotal/totalPriceSet would render the pre-edit amounts ($921.72 on #37639) until the client reconcile
  // JS fired (which only runs AFTER an edit action, never on a plain load). deriveCurrentOrderTotals carries
  // the same belt-and-braces fallback as the post-edit reconcile path. Shipping is unchanged by line edits.
  const curTotals = deriveCurrentOrderTotals(order);
  const sub   = fmtMoney(curTotals.subtotal);
  const ship  = fmtMoney(order.totalShippingPriceSet?.presentmentMoney?.amount);
  const total = fmtMoney(curTotals.total);
  // DISCOUNT-VISIBILITY (2026-08-05): an order discount used to render as its own (negative) line-item
  // ROW in the table above — the ONLY place staff could see one existed or clear it. It is now a
  // per-line discount allocation, so it has no row: surface it in the totals block instead, and pair
  // it with the "Remove discount" control in the edit bar (POST /orders/:id/discount/order/remove).
  // DEPENDS: getOrderDetail must select discountAllocations{...discountApplication{... on
  // ManualDiscountApplication{description}}} or `reason` is blank and the row never renders.
  const orderDiscount = summarizeOrderDiscount((order.lineItems?.edges || []).map(e => ({
    currentQuantity: lineItemCurrentQty(e.node),
    discounts: normalizeAllocations(e.node.discountAllocations),
  })));
  const discountRowHtml = orderDiscount.amount > 0
    ? `<div class="totals-row" id="order-discount-row"><span>Discount${orderDiscount.reason ? ` — ${h(orderDiscount.reason)}` : ''}</span><span>-${fmtMoney(orderDiscount.amount)}</span></div>`
    : '';

  // Fulfillments
  const fulfillmentsHtml = (order.fulfillments || []).length > 0
    ? (order.fulfillments || []).map(f => `
        <div class="fulfillment-row">
          <span class="badge badge-ff-${h((f.status||'').toLowerCase())}">${h(f.status)}</span>
          <span class="text-muted">${fmtDate(f.createdAt)}</span>
          ${(f.trackingInfo || []).map(t => `<a href="${h(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer" class="tracking-link">${h(t.company || '')} ${h(t.number || '')}</a>`).join('')}
        </div>`).join('')
    : '<p class="text-muted small-text">No fulfillments yet</p>';

  // Transactions
  const txHtml = (order.transactions || []).length > 0
    ? `<table class="mini-table"><thead><tr><th>Kind</th><th>Gateway</th><th>Status</th><th class="text-right">Amount</th><th>Date</th></tr></thead><tbody>
        ${(order.transactions||[]).map(tx => `<tr>
          <td>${h(tx.kind)}</td><td>${h(tx.gateway)}</td>
          <td><span class="badge badge-${h((tx.status||'').toLowerCase())}">${h(tx.status)}</span></td>
          <td class="text-right mono">${fmtMoney(tx.amountSet?.presentmentMoney?.amount)}</td>
          <td class="text-muted">${fmtDate(tx.createdAt)}</td>
        </tr>`).join('')}</tbody></table>`
    : '<p class="text-muted small-text">No transactions</p>';

  const addr = order.shippingAddress;
  const addrHtml = addr
    ? `${h(addr.firstName || '')} ${h(addr.lastName || '')}<br>
       ${h(addr.address1||'')}${addr.address2 ? '<br>'+h(addr.address2) : ''}<br>
       ${h(addr.city||'')}, ${h(addr.province||'')} ${h(addr.zip||'')}<br>${h(addr.country||'')}`
    : '<span class="text-muted">No shipping address</span>';

  const flashHtml = flash === 'marked_paid'
    ? `<div class="alert alert-success">Order marked as paid.</div>`
    : flash === 'payment_recorded'
    ? `<div class="alert alert-success">Manual payment recorded.</div>`
    : flash === 'payment_failed'
    ? `<div class="alert alert-warning">Payment failed — nothing was recorded. ${flashMsg ? h(flashMsg) : 'Check server logs.'}</div>`
    : flash === 'method_required'
    ? `<div class="alert alert-warning">A payment method is required to record a payment.</div>`
    : flash === 'bad_amount'
    ? `<div class="alert alert-warning">Payment amount is invalid${flashMsg ? `: ${h(flashMsg)}` : ' — must be greater than 0 and no more than the outstanding balance.'}</div>`
    : flash === 'note_saved'
    ? `<div class="alert alert-success">Note saved.</div>`
    : flash === 'address_saved'
    ? `<div class="alert alert-success">Shipping address updated.</div>`
    : flash === 'chase_invoice_queued'
    ? `<div class="alert alert-success">Chase invoice intent logged. Wire Chase API to send the real link.</div>`
    : flash === 'order_edited'
    ? `<div class="alert alert-success">Order updated.${flashMsg ? ` <span style="color:#b45309">Note: ${h(flashMsg)}</span>` : ''}</div>`
    : flash === 'discount_applied'
    ? `<div class="alert alert-success">Discount applied.</div>`
    : flash === 'fulfilled'
    ? `<div class="alert alert-success">Fulfillment recorded.</div>`
    : flash === 'backorder_flagged'
    ? `<div class="alert alert-success">Line item marked as backordered.</div>`
    : flash === 'xero_synced'
    ? `<div class="alert alert-success">Xero invoice created/synced.</div>`
    : flash === 'xero_paid'
    ? `<div class="alert alert-success">Xero payment recorded.</div>`
    : flash === 'xero_failed'
    ? `<div class="alert alert-warning">Xero sync failed — queued for retry. Check /accounting.</div>`
    : flash === 'partial_invoice_created'
    ? `<div class="alert alert-success">Partial invoice generated.</div>`
    : flash === 'order_canceled' ? `<div class="alert alert-success">Order canceled.</div>` : flash === 'cancel_failed' ? `<div class="alert alert-warning">Cancel failed: ${h(flashMsg || 'see logs')}</div>` : flash === 'edit_failed'
    ? `<div class="alert alert-warning">Order edit failed — nothing was saved. ${flashMsg ? h(flashMsg) : 'Check server logs.'}</div>`
    : flash === 'fulfillment_failed' || flash === 'discount_failed'
    ? `<div class="alert alert-warning">Action failed — ${flashMsg ? h(flashMsg) : 'check server logs.'}</div>`
    : '';

  // Edit mode JS (16A)
// WHAT: inline edit-mode controller — toggles static-vs-input cells, manages custom-line add/remove, discount bar, and all the order modals; also the ship rates/label AJAX.
// CHANGE-GUARD: every function selects DOM by hardcoded element id (edit-mode-bar, edit-save-bar, discount-modal, ship-modal, etc.) — renaming those ids in the markup silently no-ops the buttons. toggleEditMode(false) RESETS custom lines and discount inputs; keep that cleanup if you add fields.
// INVARIANT(S): disabled inputs are excluded from form submission (edit mode toggles .disabled), so non-edit-mode loads never POST qty/price overrides; Escape closes all modals via the keydown handler at the bottom.
  const editModeScript = `<script>
  function toggleEditMode(enable) {
    document.getElementById('edit-mode-bar').style.display = enable ? 'block' : 'none';
    document.getElementById('edit-save-bar').style.display = enable ? 'block' : 'none';
    var addBar = document.getElementById('edit-add-bar'); if (addBar) addBar.style.display = enable ? 'block' : 'none';
    var discBar = document.getElementById('edit-discount-bar'); if (discBar) discBar.style.display = enable ? 'block' : 'none';
    if (!enable) { document.querySelectorAll('tr.custom-line-new').forEach(function(r){ r.remove(); }); document.querySelectorAll('tr.catalog-line-new').forEach(function(r){ r.remove(); }); var avi = document.getElementById('addVariantLinesInput'); if (avi) avi.value = '[]'; var eps = document.getElementById('edit-product-search'); if (eps) eps.value = ''; var epr = document.getElementById('edit-product-results'); if (epr) { epr.style.display='none'; epr.innerHTML=''; } if (window.__newCustomLines) window.__newCustomLines = []; var db2 = document.getElementById('edit-discount-bar'); if (db2) db2.querySelectorAll('input').forEach(function(i){ i.value=''; }); }
    document.getElementById('edit-btn').style.display = enable ? 'none' : 'inline-flex';
    document.querySelectorAll('.edit-qty-input').forEach(el => { el.style.display = enable ? 'inline-block' : 'none'; el.disabled = !enable; });
    document.querySelectorAll('.edit-qty-static').forEach(el => { el.style.display = enable ? 'none' : 'inline'; });
    document.querySelectorAll('.edit-price-input').forEach(el => { el.style.display = enable ? 'inline-block' : 'none'; el.disabled = !enable; });
    document.querySelectorAll('.edit-price-static').forEach(el => { el.style.display = enable ? 'none' : 'inline'; });
    document.querySelectorAll('.edit-remove-btn').forEach(el => { el.style.display = enable ? 'inline-flex' : 'none'; });
    if (!enable) { document.querySelectorAll('tr[data-removed]').forEach(r => { r.dataset.removed = '0'; r.style.opacity = '1'; }); }
  }
  function markRemove(liId, btn) {
    const row = btn.closest('tr');
    const removed = row.dataset.removed === '1';
    row.dataset.removed = removed ? '0' : '1';
    row.style.opacity = removed ? '1' : '0.4';
    const input = document.getElementById('remove_' + liId);
    if (input) input.disabled = removed;
    // Phase 16H: incremental auto-save — when toggling TO removed, persist immediately.
    // (Toggling back is a no-op server-side; Shopify can't un-remove a committed removal — the
    // batch Save fallback / a fresh add would be needed, which is intentionally out of v1 scope.)
    if (!removed && window.__autosave) window.__autosave.removeLine(liId, row);
  }
  function toggleDiscountModal(show) {
    document.getElementById('discount-modal').style.display = show ? 'flex' : 'none';
  }
  function toggleFulfillModal(show) {
    document.getElementById('fulfill-modal').style.display = show ? 'flex' : 'none';
  }
  function toggleBackorderModal(liId, liTitle, liQty, show) {
    const m = document.getElementById('backorder-modal');
    if (show) {
      m.style.display = 'flex';
      document.getElementById('bo-li-id').value = liId || '';
      document.getElementById('bo-li-title').value = liTitle || '';
      document.getElementById('bo-quantity').value = liQty || 1;
    } else {
      m.style.display = 'none';
    }
  }
  // Delegated listener for line "Mark backordered" buttons — reads data-* attrs (safe: attribute
  // context) instead of an inline onclick that would concatenate the attacker-controlled title into JS.
  document.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('.bo-action-btn');
    if (b) { toggleBackorderModal(b.getAttribute('data-li-id'), b.getAttribute('data-li-title'), b.getAttribute('data-li-qty'), true); }
  });
  function toggleInvoiceModal(show) {
    document.getElementById('invoice-modal').style.display = show ? 'flex' : 'none';
  }
  function downloadInvoiceCsv(numId) {
    var checks = document.querySelectorAll('#csv-cols input[type=checkbox]:checked');
    var cols = Array.from(checks).map(function(c){ return c.value; }).join(',');
    if (!cols) { alert('Select at least one column.'); return; }
    window.location.href = '/orders/' + numId + '/invoice.csv?cols=' + encodeURIComponent(cols);
  }
  function toggleCancelModal(show) {
    document.getElementById('cancel-modal').style.display = show ? 'flex' : 'none';
  }
  // Second build (Build C): record-manual-payment modal toggle.
  function toggleRecordPaymentModal(show) {
    var m = document.getElementById('record-payment-modal');
    if (!m) return;
    m.style.display = show ? 'flex' : 'none';
    if (show) {
      // Re-enable the submit button each time the modal opens (a prior failed submit may have disabled it).
      var b = document.getElementById('record-payment-submit');
      if (b) { b.disabled = false; b.textContent = 'Record payment'; }
    }
  }
  function toggleShipModal(show) {
    const m = document.getElementById('ship-modal');
    m.style.display = show ? 'flex' : 'none';
    if (show) {
      // Reset state
      document.getElementById('ship-rates-area').style.display = 'none';
      document.getElementById('ship-label-area').style.display = 'none';
      document.getElementById('ship-error').style.display = 'none';
      document.getElementById('ship-buy-btn').style.display = 'none';
      document.getElementById('ship-get-rates-btn').style.display = 'inline-flex';
    }
  }
  let _selectedRateId = null;
// WHAT: client-side 'Get rates' — collects checked ship line items + fromId + weight and POSTs <path>/ship/rates, then renders a sorted radio list of carrier rates.
// CHANGE-GUARD: weight defaults to 1 if blank/NaN (unit is whatever the shipping bridge expects — confirm lb vs oz before changing); rates are sorted ascending by shipping_amount.amount with 9999 as the missing-price sentinel. Auto-selects the cheapest. Re-test against the shipping bridge after field renames (rate_id, shipping_amount, carrier/service codes).
// INVARIANT(S): _selectedRateId is set to the first/cheapest rate and updated on radio change — shipBuyLabel refuses to proceed without it.
  async function shipGetRates() {
    const btn = document.getElementById('ship-get-rates-btn');
    const errEl = document.getElementById('ship-error');
    errEl.style.display = 'none';
    btn.disabled = true; btn.textContent = 'Fetching rates…';
    const lis = [...document.querySelectorAll('#ship-modal input[name="ship_li[]"]:checked')].map(c => ({ id: c.value, quantity: parseInt(c.dataset.qty, 10) || 1 }));
    const fromId = document.getElementById('ship-from').value;
    const weight = parseFloat(document.getElementById('ship-weight').value) || 1;
    try {
      const r = await fetch(window.location.pathname + '/ship/rates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId, weight, lineItems: lis })
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'rates failed');
      const list = document.getElementById('ship-rates-list');
      const rates = (j.rates || []).sort((a, b) => (a.shipping_amount?.amount || 9999) - (b.shipping_amount?.amount || 9999));
      list.innerHTML = rates.length === 0 ? '<div class=\"text-muted\">No rates returned.</div>' :
        rates.map(function(rt, i) {
          var cost = (rt.shipping_amount && rt.shipping_amount.amount != null) ? rt.shipping_amount.amount.toFixed(2) : '?';
          var days = (rt.delivery_days || rt.estimated_delivery_date) ? (rt.delivery_days ? rt.delivery_days + ' days' : '~' + rt.estimated_delivery_date) : '';
          var checked = i === 0 ? 'checked' : '';
          var carrier = rt.carrier_friendly_name || rt.carrier_code || '';
          var service = rt.service_type || rt.service_code || '';
          return '<label style=\"display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #eee;font-size:13px;cursor:pointer\">' +
            '<input type=\"radio\" name=\"ship_rate\" value=\"' + rt.rate_id + '\" ' + checked + ' onchange=\"_selectedRateId=this.value\">' +
            '<strong style=\"flex:1\">' + service + '</strong>' +
            '<span style=\"color:#888\">' + carrier + '</span>' +
            '<span style=\"font-weight:600;min-width:60px;text-align:right\">$' + cost + '</span>' +
            (days ? '<span style=\"color:#888;font-size:11px\">' + days + '</span>' : '') +
            '</label>';
        }).join('');
      if (rates.length > 0) _selectedRateId = rates[0].rate_id;
      document.getElementById('ship-rates-area').style.display = '';
      document.getElementById('ship-buy-btn').style.display = 'inline-flex';
      document.getElementById('ship-buy-btn').disabled = rates.length === 0;
      btn.style.display = 'none';
    } catch (e) {
      errEl.textContent = 'Rates error: ' + e.message;
      errEl.style.display = '';
      btn.disabled = false; btn.textContent = 'Get rates';
    }
  }
// WHAT: client-side 'Buy label + fulfill' — POSTs <path>/ship/label with the chosen rate_id + line items, then shows tracking + label link.
// CHANGE-GUARD: the success copy distinguishes 'Fulfilled in Shopify' vs 'Shopify fulfill failed' purely from j.fulfillment_id presence — the server contract (tracking_number/tracking_url/label_url/carrier_code/fulfillment_id) must stay stable. Disables the button during purchase to avoid buying two labels.
// INVARIANT(S): refuses without _selectedRateId; buying a label and fulfilling in Shopify are a single server action — the rule is fulfillment must follow the label (don't split them client-side).
  async function shipBuyLabel() {
    const btn = document.getElementById('ship-buy-btn');
    const errEl = document.getElementById('ship-error');
    errEl.style.display = 'none';
    if (!_selectedRateId) { errEl.textContent = 'Pick a rate first'; errEl.style.display = ''; return; }
    btn.disabled = true; btn.textContent = 'Buying label…';
    const lis = [...document.querySelectorAll('#ship-modal input[name="ship_li[]"]:checked')].map(c => ({ id: c.value, quantity: parseInt(c.dataset.qty, 10) || 1 }));
    try {
      const r = await fetch(window.location.pathname + '/ship/label', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_id: _selectedRateId, lineItems: lis })
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'label failed');
      const trackingEl = document.getElementById('ship-tracking-info');
      var tUrl = j.tracking_url || '#';
      var tNum = j.tracking_number || '(no number)';
      var carrSeg = j.carrier_code ? ' &middot; ' + j.carrier_code : '';
      var ffSeg = j.fulfillment_id ? ' &middot; Fulfilled in Shopify' : ' &middot; Shopify fulfill failed (see logs)';
      trackingEl.innerHTML = 'Tracking: <a href=\"' + tUrl + '\" target=\"_blank\" rel=\"noopener\">' + tNum + '</a>' + carrSeg + ffSeg;
      document.getElementById('ship-label-link').href = j.label_url;
      document.getElementById('ship-label-area').style.display = '';
      document.getElementById('ship-rates-area').style.display = 'none';
      btn.style.display = 'none';
    } catch (e) {
      errEl.textContent = 'Buy label error: ' + e.message;
      errEl.style.display = '';
      btn.disabled = false; btn.textContent = 'Buy label + fulfill';
    }
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('discount-modal').style.display = 'none';
      document.getElementById('fulfill-modal').style.display = 'none';
      document.getElementById('backorder-modal').style.display = 'none';
      document.getElementById('invoice-modal').style.display = 'none';
      const cm = document.getElementById('cancel-modal'); if (cm) cm.style.display = 'none';
      const sm = document.getElementById('ship-modal'); if (sm) sm.style.display = 'none';
      const rpm = document.getElementById('record-payment-modal'); if (rpm) rpm.style.display = 'none';
    }
  });
  </script>`;


// WHAT: client JS for the order-detail customer-comms panel — submitVisibleNote() POSTs /api/orders/:id/visible-note and re-renders the visible-notes list; loadCustomerReplies() renders the Re:amaze CHAT BOX: it GETs /api/orders/:id/customer-messages for the thread list, then per thread GETs /api/orders/:id/conversations/:slug/messages and renders us/them bubbles.
// CHANGE-GUARD: bubbles render the portal's pre-cleaned `text` (HTML/header/quote-scrubbed) via esc() only — never inject raw `body`/HTML into the DOM. us=staff=RIGHT bubble, them=customer=LEFT bubble; each shows ONLY text + atDisplay. Endpoint paths are parsed from location.pathname.split('/').pop() for the order id — keep the /orders/:id URL shape. The 'Open in Re:amaze' deep link must survive.
// INVARIANT(S): messages arrive newest-first from Re:amaze and are re-sorted oldest-first for top-to-bottom reading; threads/messages come from the server, this only renders them; the visible-notes re-render still escapes only '<' (weaker than h()) — do not echo attacker-controlled HTML attributes.
  const visibleNotesScript = `
    <script>
    async function submitVisibleNote(e, orderId) {
      e.preventDefault();
      const body = document.getElementById('visible-note-body').value.trim();
      if (!body) return;
      const btn = e.target.querySelector('button[type=submit]');
      const status = document.getElementById('visible-note-status');
      btn.disabled = true;
      status.textContent = 'Sending…';
      try {
        const r = await fetch('/api/orders/' + orderId + '/visible-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Failed');
        document.getElementById('visible-note-body').value = '';
        status.textContent = '✓ Note sent to customer';
        // Refresh notes list
        const nr = await fetch('/api/orders/' + orderId + '/visible-notes');
        const nj = await nr.json();
        const nl = document.getElementById('visible-notes-list');
        if (nl && nj.notes) {
          nl.innerHTML = nj.notes.length
            ? nj.notes.map(n => '<div style="border-left:3px solid var(--lime);padding:8px 12px;margin-bottom:8px;background:#f9fdf0;border-radius:0 4px 4px 0"><div style="font-size:13px;white-space:pre-wrap">' + n.body.replace(/</g,'&lt;') + '</div><div style="font-size:11px;color:var(--muted);margin-top:4px">' + new Date(n.addedAt).toLocaleDateString() + ' · ' + (n.addedBy||'').replace(/</g,'&lt;') + '</div></div>').join('')
            : '<p class="text-muted small-text">No visible notes yet.</p>';
        }
      } catch (err) {
        status.textContent = '✗ ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }
    // Second build (Build B): brand for the Re:amaze STAFF inbox URL, injected server-side
    // (never read process.env in client JS, never hardcode the brand). The staff URL
    // (https://<brand>.reamaze.com/admin/conversations/<slug>) opens the live agent conversation;
    // it falls back to t.permaUrl when no slug is present so the link is never broken.
    var REAMAZE_BRAND = ${JSON.stringify(process.env.REAMAZE_BRAND || 'fuzzywumpets')};
    function reamazeStaffUrl(t){
      if (t && t.staffUrl) return t.staffUrl;
      if (t && t.slug) return 'https://' + REAMAZE_BRAND + '.reamaze.com/admin/conversations/' + encodeURIComponent(t.slug);
      return (t && t.permaUrl) ? t.permaUrl : '';
    }
    function openReamaze(url){ if (url) window.open(url, '_blank', 'noopener'); }
    async function loadCustomerReplies(orderId) {
      const el = document.getElementById('customer-replies-list');
      if (!el) return;
      function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function bubbleHtml(m){
        var them = (m && m.sender === 'them');
        // them = customer = LEFT; us = staff = RIGHT.
        var align = them ? 'flex-start' : 'flex-end';
        var bg = them ? '#ffffff' : '#eaf5c8';
        var border = them ? '1px solid #e3e3e3' : '1px solid #cfe08a';
        var radius = them ? '12px 12px 12px 2px' : '12px 12px 2px 12px';
        var who = them ? 'Customer' : 'Us';
        var when = esc(m && (m.atDisplay || m.at) || '');
        return '<div style="display:flex;justify-content:' + align + ';margin-bottom:8px">'
          + '<div style="max-width:78%;background:' + bg + ';border:' + border + ';border-radius:' + radius + ';padding:8px 11px">'
          +   '<div style="font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word">' + esc(m && m.text || '') + '</div>'
          +   '<div style="font-size:10px;color:var(--muted,#888);margin-top:4px;text-align:' + (them ? 'left' : 'right') + '">' + esc(who) + ' \u00b7 ' + when + '</div>'
          + '</div>'
        + '</div>';
      }
      try {
        const r = await fetch('/api/orders/' + orderId + '/customer-messages');
        const j = await r.json();
        const threads = j.threads || [];
        if (!threads.length) { el.innerHTML = '<p class="text-muted small-text">No customer replies yet. Replies to notes will appear here.</p>'; return; }
        // Render a chat thread per conversation: header (subject + Re:amaze link) + a messages container we fill async.
        el.innerHTML = threads.map(function(t, i){
          var staffUrl = reamazeStaffUrl(t);
          var link = staffUrl ? '<a href="' + esc(staffUrl) + '" target="_blank" rel="noopener" style="font-size:11px;white-space:nowrap" onclick="event.stopPropagation()">Open in Re:amaze \u2197</a>' : '';
          return '<div class="chat-thread" style="border:1px solid #ececec;border-radius:8px;margin-bottom:14px;overflow:hidden">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;background:#f7f7f4;border-bottom:1px solid #ececec">'
            +   '<div style="font-weight:600;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.subject || '(no subject)') + '</div>'
            +   link
            + '</div>'
            + '<div class="chat-messages" id="chat-msgs-' + i + '" data-slug="' + esc(t.slug || '') + '" style="padding:11px;background:#fbfbf9;max-height:420px;overflow-y:auto">'
            +   '<p class="text-muted small-text" style="margin:0">Loading conversation\u2026</p>'
            + '</div>'
          + '</div>';
        }).join('');
        // Fetch each thread's clean messages and render bubbles (oldest-first, top-to-bottom).
        for (let i = 0; i < threads.length; i++) {
          const slug = threads[i].slug;
          const box = document.getElementById('chat-msgs-' + i);
          if (!box) continue;
          if (!slug) { box.innerHTML = '<p class="text-muted small-text" style="margin:0">No conversation detail available.</p>'; continue; }
          try {
            const mr = await fetch('/api/orders/' + orderId + '/conversations/' + encodeURIComponent(slug) + '/messages');
            const mj = await mr.json();
            var msgs = (mj && mj.messages) || [];
            // Re:amaze returns newest-first; show oldest-first so the thread reads top-to-bottom like chat.
            msgs = msgs.slice().sort(function(a,b){ return new Date(a.at||a.createdAt||0) - new Date(b.at||b.createdAt||0); });
            box.innerHTML = msgs.length ? msgs.map(bubbleHtml).join('') : '<p class="text-muted small-text" style="margin:0">No messages in this thread yet.</p>';
            box.scrollTop = box.scrollHeight;
          } catch (e) {
            box.innerHTML = '<p class="text-muted small-text" style="margin:0">Could not load this conversation.</p>';
          }
        }
      } catch(e) { el.innerHTML = '<p class="text-muted small-text">Could not load replies.</p>'; }
    }
    document.addEventListener('DOMContentLoaded', function(){ loadCustomerReplies(location.pathname.split('/').pop()); });
    </script>`;

  return layout({ title: order.name || 'Order', session, activePath: '/orders', content: `
    <style>
      /* COLLAPSE: style the default-collapsed audit/internal-note cards. Hide the native
         disclosure triangle (we render our own 'click to expand' affordance) and add a
         subtle hover so the summary reads as clickable. Scoped to details.card only. */
      details.card > summary { list-style: none; }
      details.card > summary::-webkit-details-marker { display: none; }
      details.card > summary::marker { content: ''; }
      details.card > summary:hover { background: var(--gray-50, #f7f7f4); border-radius: 4px; }
      details.card[open] > summary { margin-bottom: 0.25rem; }
    </style>
    ${visibleNotesScript}
    ${editModeScript}
    <div class="breadcrumb-row"><a href="/orders" class="breadcrumb">← Orders</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1><a href="https://admin.shopify.com/store/parttwoenterprises/orders/${h(numId)}" target="_blank" rel="noopener" class="link" title="Open ${h(order.name)} in Shopify admin">${h(order.name)} ↗</a> <span class="badge badge-${h(finStatus)}">${h(order.displayFinancialStatus)}</span>
            <span class="badge badge-ff-${h(fulStatus)}">${h(order.displayFulfillmentStatus)}</span></h1>
        <p class="text-muted">
          ${order.customer ? `<a href="/customers/${shopifyNumericId(order.customer.id)}">${h(order.customer.displayName)}</a> · ` : ''}
          ${fmtDate(order.processedAt)}
        </p>
      </div>
      <div class="detail-header-actions">
        ${!isPaid ? `<form method="POST" action="/orders/${h(numId)}/mark-paid" style="display:inline">
          <button class="btn btn-success" onclick="return confirm('Mark ${h(order.name)} as paid?')">Mark Paid</button>
        </form>` : ''}
        ${canRecordPayment ? `<button type="button" class="btn btn-success" onclick="toggleRecordPaymentModal(true)" title="Record a manual payment (check, ACH, cash, etc.)">Record payment</button>` : ''}
        ${order.cancelledAt || order.displayFulfillmentStatus === 'FULFILLED' ? '' : `
        <button class="btn btn-primary" onclick="toggleShipModal(true)" title="Buy a shipping label and fulfill this order">📦 Ship order</button>`}
        <button id="edit-btn" class="btn btn-secondary" onclick="toggleEditMode(true)">Edit order</button>
        <button class="btn btn-secondary" onclick="toggleFulfillModal(true)">Fulfill items</button>
        <button class="btn btn-ghost" onclick="toggleDiscountModal(true)">Apply discount</button>
        <button class="btn btn-secondary" onclick="toggleInvoiceModal(true)">Generate Invoice</button>
        <form method="POST" action="/orders/${h(numId)}/send-chase-invoice" style="display:inline">
          <button class="btn btn-secondary" onclick="return confirm('Queue Chase invoice link for ${h(order.name)}?\\n\\nNote: Chase API not yet wired — this logs the intent.')">Send Chase Invoice</button>
        </form>
        <form method="POST" action="/orders/${h(numId)}/xero/sync" style="display:inline">
          <button class="btn btn-ghost" title="Create or refresh Xero invoice for this order">${xeroMap?.status === 'synced' ? '✓ Xero synced' : 'Sync to Xero'}</button>
        </form>
        ${order.cancelledAt ? `<span class="badge badge-danger">CANCELED ${fmtDate(order.cancelledAt)}</span>` : `
        <button type="button" class="btn btn-ghost" style="color:#c00" onclick="toggleCancelModal(true)" title="Cancel this order">Cancel order</button>`}
      </div>
    </div>
    ${timeline}
    <div class="detail-grid">
      <div class="detail-main">
        <div class="card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Line Items</h2>
            <span id="edit-mode-bar" style="display:none">
              <span style="font-size:12px;color:var(--muted);margin-right:8px">✏ Edit mode</span>
              <span id="autosave-pill" data-state="saved" style="font-size:12px;font-weight:600;padding:2px 10px;border-radius:12px;margin-right:8px;background:#e8f5ea;color:#1b7a3d">All changes saved</span>
              <button type="button" class="btn btn-ghost btn-sm" onclick="toggleEditMode(false)">Cancel</button>
            </span>
          </div>
          <form method="POST" action="/orders/${h(numId)}/edit" id="edit-form">
          <table class="data-table">
            <thead><tr><th>Item</th><th>SKU</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Total</th></tr></thead>
            <tbody>${lineItemsHtml}</tbody>
          </table>
          <div class="totals-block">
            <div class="totals-row"><span>Subtotal</span><span>${sub}</span></div>
            ${discountRowHtml}
            <div class="totals-row"><span>Shipping</span><span>${ship}</span></div>
            <div class="totals-row totals-total"><span>Total</span><span>${total}</span></div>
          </div>
          <div id="edit-add-bar" style="display:none;padding:8px 0">
            <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
              <div style="position:relative;flex:1;min-width:260px">
                <input type="text" id="edit-product-search" class="filter-input" placeholder="Add product — search name or SKU…" autocomplete="off" style="width:100%">
                <div id="edit-product-results" style="display:none;position:absolute;z-index:60;left:0;right:0;top:100%;background:#fff;border:1px solid var(--border);border-radius:4px;max-height:260px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.12)"></div>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" onclick="addCustomLineRow()" title="Add a one-off (non-catalog) line item to this order">+ Add custom line</button>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:4px">Type a product name to see its sizes; check the variants you want and click <strong>Add selected</strong> to add them all at once. Catalog items are priced at this customer's wholesale rate (${editDiscPct}% off); adjust each unit price/qty inline.</div>
          </div>
          <input type="hidden" name="addCustomLines" id="addCustomLinesInput" value="[]">
          <input type="hidden" name="addVariantLines" id="addVariantLinesInput" value="[]">
          <div id="edit-discount-bar" style="display:none;padding:12px 0;border-top:1px solid var(--border);margin-top:8px">
            <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Order Discount (optional)</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:4px;font-size:13px">
                <input type="number" name="discountPct" placeholder="%" min="0" max="100" step="0.01" class="filter-input" style="width:64px" oninput="if(this.value)this.form.discountFixed.value=''">
                <span style="color:var(--muted)">% off</span>
              </label>
              <span style="color:var(--muted);font-size:12px">or</span>
              <label style="display:flex;align-items:center;gap:4px;font-size:13px">
                <span style="color:var(--muted)">$</span>
                <input type="number" name="discountFixed" placeholder="0.00" min="0" step="0.01" class="filter-input" style="width:80px" oninput="if(this.value)this.form.discountPct.value=''">
              </label>
              <input type="text" name="discountReason" placeholder="Reason (required for discount)" class="filter-input" style="width:220px">
              <button type="button" id="discount-apply-btn" class="btn btn-primary btn-sm" title="Apply this discount to the order">Apply discount</button>
              <button type="button" id="discount-remove-btn" class="btn btn-ghost btn-sm" title="Clear the order discount entirely" style="display:${orderDiscount.amount > 0 ? '' : 'none'}">Remove discount</button>
              <span id="discount-chip" class="row-save-chip" data-state="idle" style="font-size:11px;vertical-align:middle"></span>
            </div>
          </div>
          <div id="edit-save-bar" style="display:none;padding:12px 0;border-top:1px solid var(--border);margin-top:8px">
            <input type="text" name="staffNote" placeholder="Staff note (optional)" class="filter-input" style="width:60%;margin-right:8px">
            <button type="submit" id="edit-save-btn" class="btn btn-primary" onclick="serializeCustomLines()">Save changes</button>
            <button type="button" class="btn btn-ghost" onclick="toggleEditMode(false)" style="margin-left:4px">Cancel</button>
          </div>
          </form>
          <script>
            (function(){
              // Track newly added custom-line rows so they can be serialized on submit
              window.__newCustomLines = [];
              window.addCustomLineRow = function() {
                var tbody = document.querySelector('#edit-form table.data-table tbody');
                if (!tbody) return;
                var idx = window.__newCustomLines.length;
                window.__newCustomLines.push({ title: '', qty: 1, price: 0 });
                var tr = document.createElement('tr');
                tr.className = 'custom-line-new';
                tr.dataset.newIdx = idx;
                tr.innerHTML =
                  '<td><input type="text" class="filter-input ncl-title" placeholder="Custom item title" style="width:80%">' +
                    ' <span class="row-save-chip" data-state="idle" style="font-size:11px;vertical-align:middle"></span></td>' +
                  '<td><span class="text-muted">CUSTOM</span></td>' +
                  '<td class="text-right"><input type="number" class="filter-input ncl-qty" value="1" min="1" step="1" style="width:60px;text-align:right"></td>' +
                  '<td class="text-right"><input type="number" class="filter-input ncl-price" value="0.00" min="0" step="0.01" style="width:80px;text-align:right"></td>' +
                  '<td class="text-right" style="white-space:nowrap"><button type="button" class="btn btn-primary btn-sm ncl-add" title="Add this line to the order">Add</button> ' +
                    '<button type="button" class="btn btn-ghost btn-sm" onclick="removeCustomLineRow(this)" title="Remove this new line">\u00D7</button></td>';
                tbody.appendChild(tr);
                tr.querySelector('.ncl-title').focus();
                // Phase 16H: incremental auto-save \u2014 persist on blur once title/qty/price are valid.
                if (window.__autosave) window.__autosave.wireCustomRow(tr);
              };
              window.removeCustomLineRow = function(btn) {
                var tr = btn.closest('tr');
                if (!tr) return;
                // If this row was already committed incrementally, remove it from Shopify too.
                if (window.__autosave && tr.dataset.committedLiId) { window.__autosave.removeLine(tr.dataset.committedLiId, tr); return; }
                tr.remove();
              };
              window.serializeCustomLines = function() {
                var rows = document.querySelectorAll('tr.custom-line-new');
                var out = [];
                rows.forEach(function(r){
                  // Phase 16H: skip rows already persisted by incremental auto-save — otherwise the
                  // batch Save path (no idemKey dedupe) would double-add them.
                  // P0 fix (2026-07-21): ALSO skip rows whose incremental commit is still IN FLIGHT.
                  // committedLiId is only stamped on success, so during the multi-second Shopify
                  // round trip the row looked uncommitted and the batch path re-added it. That
                  // window widened when custom lines moved to an explicit Add button, because
                  // Add-then-Save became the natural finishing gesture.
                  if (r.dataset.committedLiId || r.dataset.committing) return;
                  var title = r.querySelector('.ncl-title')?.value?.trim();
                  var qty   = parseInt(r.querySelector('.ncl-qty')?.value, 10);
                  var price = parseFloat(r.querySelector('.ncl-price')?.value);
                  if (title && qty > 0 && price >= 0) out.push({ title: title, qty: qty, price: price });
                });
                document.getElementById('addCustomLinesInput').value = JSON.stringify(out);
                // Phase 16F: serialize newly added catalog (real product) lines
                var crows = document.querySelectorAll('tr.catalog-line-new');
                var cout = [];
                crows.forEach(function(r){
                  if (r.dataset.committedLiId || r.dataset.committing) return; // saved, or mid-flight — don't re-add
                  var qty   = parseInt(r.querySelector('.cl-qty')?.value, 10);
                  var price = parseFloat(r.querySelector('.cl-price')?.value);
                  if (r.dataset.variantId && qty > 0 && price >= 0) cout.push({
                    variantId: r.dataset.variantId,
                    title:     r.dataset.title || '',
                    sku:       r.dataset.sku || '',
                    qty:       qty,
                    listPrice: parseFloat(r.dataset.listPrice) || 0,
                    price:     price
                  });
                });
                document.getElementById('addVariantLinesInput').value = JSON.stringify(cout);
              };

              // Phase 16F: add a real catalog product as a new line (priced at wholesale)
              var EDIT_DISC_PCT = ${editDiscPct};
              window.addCatalogLineRow = function(p) {
                var tbody = document.querySelector('#edit-form table.data-table tbody');
                if (!tbody) return;
                var listPrice = parseFloat(p.price || 0);
                var wholesale = (listPrice * (1 - EDIT_DISC_PCT/100));
                var tr = document.createElement('tr');
                tr.className = 'catalog-line-new';
                tr.dataset.variantId = p.variantId;
                tr.dataset.title     = p.label || '';
                tr.dataset.sku       = p.sku || '';
                tr.dataset.listPrice = String(listPrice);
                tr.innerHTML =
                  '<td><span class="badge badge-success" style="margin-right:6px">NEW</span>' + (p.label ? p.label.replace(/</g,'&lt;') : 'Catalog item') +
                    ' <span class="row-save-chip" data-state="idle" style="margin-left:8px;font-size:11px;vertical-align:middle"></span></td>' +
                  '<td><span class="text-muted">' + ((p.sku||'').replace(/</g,'&lt;') || '—') + '</span></td>' +
                  '<td class="text-right"><input type="number" class="filter-input cl-qty" value="1" min="1" step="1" style="width:60px;text-align:right"></td>' +
                  '<td class="text-right"><input type="number" class="filter-input cl-price" value="' + wholesale.toFixed(2) + '" min="0" step="0.01" style="width:80px;text-align:right" title="Wholesale unit price (list ' + listPrice.toFixed(2) + ')"></td>' +
                  '<td class="text-right"><button type="button" class="btn btn-ghost btn-sm" onclick="removeCustomLineRow(this)" title="Remove this new line">×</button></td>';
                tbody.appendChild(tr);
                // Phase 16H: incremental auto-save — persist this added line immediately.
                if (window.__autosave) window.__autosave.addCatalogLine(p, tr, wholesale, listPrice);
              };

              // Phase 16G: grouped multi-select product picker (Shopify-style "Add item").
              // Type a product name → dropdown shows each matching PRODUCT as a header with
              // its OWN variants nested as checkboxes; products with a Width option are
              // further sub-grouped Width → Size. Check any number across products, then
              // "Add selected" adds them all as new catalog line rows at once.
              (function(){
                var input = document.getElementById('edit-product-search');
                var box   = document.getElementById('edit-product-results');
                if (!input || !box) return;
                var t = null, lastSeq = 0;
                function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
                function hide(){ box.style.display = 'none'; box.innerHTML = ''; window.__editGrouped = null; }

                // Natural size ordering; unknown sizes sort last (Infinity), then alpha.
                var SIZE_RANK = (function(){
                  var order = ['XXS','2XS','XS','XSM','S','SM','SMALL','M','MED','MEDIUM','L','LG','LARGE','XL','XLG','XLARGE','XXL','2XL','XXLG','XXLARGE','XXXL','3XL'];
                  var map = {}; order.forEach(function(k,i){ map[k] = i; }); return map;
                })();
                function sizeRank(v){ var k = String(v||'').toUpperCase().replace(/\\s+/g,''); return SIZE_RANK[k] != null ? SIZE_RANK[k] : Infinity; }
                // Width ordering: parse leading numeric (handles fractions like 1/2") so 1/2" < 1.5" < 2".
                function widthVal(w){
                  var s = String(w||'').replace(/["”]/g,'').trim();
                  var frac = s.match(/^(\\d+)\\s*\\/\\s*(\\d+)$/);
                  if (frac) return parseInt(frac[1],10) / parseInt(frac[2],10);
                  var num = parseFloat(s); return isNaN(num) ? Infinity : num;
                }
                function optVal(variant, nameLc){
                  var o = (variant.selectedOptions||[]).find(function(x){ return String(x.name||'').toLowerCase() === nameLc; });
                  return o ? o.value : null;
                }
                function hasOption(variant, nameLc){ return (variant.selectedOptions||[]).some(function(x){ return String(x.name||'').toLowerCase() === nameLc; }); }

                // Render one variant checkbox <label>. data-key indexes into window.__editGrouped flat list.
                function variantRow(key, v, indent){
                  var size = optVal(v, 'size');
                  var shown = size != null ? size : (v.variantTitle === 'Default Title' ? 'Add this item' : v.variantTitle);
                  var oos = (v.inventoryQuantity != null && v.inventoryQuantity <= 0);
                  return '<label class="edit-var-opt" style="display:flex;align-items:center;gap:8px;padding:5px 10px 5px ' + indent + 'px;cursor:pointer;font-size:13px">' +
                    '<input type="checkbox" class="edit-var-cb" data-key="' + key + '" style="margin:0">' +
                    '<span>' + esc(shown) + (oos ? ' <span style="color:#b91c1c;font-size:11px">(out of stock)</span>' : '') + '</span>' +
                    '<span style="margin-left:auto;color:var(--muted);font-size:11px">' + esc(v.sku || '—') + '</span>' +
                    '</label>';
                }

                function render(products){
                  if (!Array.isArray(products) || !products.length){
                    box.innerHTML = '<div style="padding:8px 10px;color:var(--muted);font-size:13px">No matches</div>';
                    box.style.display = 'block'; window.__editGrouped = null; return;
                  }
                  // Flatten variants into a keyed lookup for serialization on "Add selected".
                  var flat = []; // each: {variantId,label,sku,price}
                  var html = '';
                  products.forEach(function(p){
                    html += '<div style="padding:7px 10px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-weight:600;font-size:13px;color:#111827">' + esc(p.productTitle) +
                            (p.variantsTruncated ? ' <span style="font-weight:400;color:#b45309;font-size:11px">(showing first 25 sizes)</span>' : '') + '</div>';
                    var vs = (p.variants || []).slice();
                    var anyWidth = vs.some(function(v){ return hasOption(v, 'width'); });
                    function pushKey(v){ var key = flat.length; flat.push({ variantId: v.variantId, label: v.label, sku: v.sku, price: v.price }); return key; }
                    if (anyWidth){
                      // Group by width, sort widths asc, sizes natural within each.
                      var byWidth = {};
                      vs.forEach(function(v){ var w = optVal(v,'width') || '—'; (byWidth[w] = byWidth[w] || []).push(v); });
                      Object.keys(byWidth).sort(function(a,b){ return widthVal(a) - widthVal(b) || a.localeCompare(b); }).forEach(function(w){
                        html += '<div style="padding:4px 10px 4px 18px;font-size:12px;font-weight:600;color:#4b5563">' + esc(w) + '</div>';
                        byWidth[w].sort(function(a,b){ return sizeRank(optVal(a,'size')) - sizeRank(optVal(b,'size')) || String(optVal(a,'size')||a.variantTitle).localeCompare(String(optVal(b,'size')||b.variantTitle)); })
                          .forEach(function(v){ html += variantRow(pushKey(v), v, 34); });
                      });
                    } else {
                      // Single dimension (or none): list sizes in natural order under the product.
                      vs.sort(function(a,b){ return sizeRank(optVal(a,'size')) - sizeRank(optVal(b,'size')) || String(optVal(a,'size')||a.variantTitle).localeCompare(String(optVal(b,'size')||b.variantTitle)); })
                        .forEach(function(v){ html += variantRow(pushKey(v), v, 22); });
                    }
                  });
                  // Sticky footer with the "Add selected" action.
                  html += '<div style="position:sticky;bottom:0;background:#fff;border-top:1px solid #e5e7eb;padding:8px 10px;display:flex;align-items:center;gap:8px">' +
                          '<button type="button" id="edit-add-selected" class="btn btn-primary btn-sm">Add selected</button>' +
                          '<span id="edit-sel-count" style="color:var(--muted);font-size:12px">0 selected</span></div>';
                  box.innerHTML = html;
                  box.style.display = 'block';
                  window.__editGrouped = flat;

                  var countEl = box.querySelector('#edit-sel-count');
                  function refreshCount(){ var n = box.querySelectorAll('.edit-var-cb:checked').length; if (countEl) countEl.textContent = n + ' selected'; }
                  Array.prototype.forEach.call(box.querySelectorAll('.edit-var-cb'), function(cb){
                    cb.addEventListener('change', refreshCount);
                  });
                  // Keep clicks inside the box from closing it / blurring the input.
                  box.querySelectorAll('label.edit-var-opt').forEach(function(l){ l.addEventListener('mousedown', function(ev){ ev.preventDefault(); }); });
                  var addBtn = box.querySelector('#edit-add-selected');
                  if (addBtn){
                    addBtn.addEventListener('mousedown', function(ev){ ev.preventDefault(); });
                    addBtn.addEventListener('click', function(){
                      var chosen = Array.prototype.map.call(box.querySelectorAll('.edit-var-cb:checked'), function(cb){
                        return (window.__editGrouped || [])[parseInt(cb.dataset.key, 10)];
                      }).filter(Boolean);
                      if (!chosen.length) return;
                      chosen.forEach(function(p){ addCatalogLineRow(p); });
                      input.value = ''; hide(); input.focus();
                    });
                  }
                }

                input.addEventListener('input', function(){
                  var q = input.value.trim();
                  if (t) clearTimeout(t);
                  if (q.length < 2) { hide(); return; }
                  var seq = ++lastSeq;
                  t = setTimeout(function(){
                    fetch('/api/products/search?grouped=1&q=' + encodeURIComponent(q), { credentials: 'same-origin' })
                      .then(function(r){ return r.json(); })
                      .then(function(products){ if (seq !== lastSeq) return; render(products); })
                      .catch(function(){ hide(); });
                  }, 220);
                });
                document.addEventListener('click', function(ev){ if (ev.target !== input && !box.contains(ev.target)) hide(); });
              })();

              // ── Phase 16H: incremental auto-save controller ─────────────────
              // Each user action persists immediately via its own atomic begin->commit on the
              // server, keyed by a client uuid idemKey so retries/double-fires never double-add.
              // Per-row chip + global pill reflect saving/saved/failed; failures are CLICKABLE to
              // retry (same idemKey) and never silently disappear. The batch "Save changes" button
              // stays as a fallback (server dedupes committed idemKeys, so it can't double-add).
              (function(){
                var ORDER_ID = '${h(numId)}';
                function uuid(){ try { return crypto.randomUUID(); } catch(e){ return 'k-'+Date.now()+'-'+Math.random().toString(16).slice(2); } }
                var inflight = 0, anyFailed = false;
                var pill = document.getElementById('autosave-pill');
                // Edits that are SCHEDULED but not yet sent. debouncedLine waits 500ms before it
                // increments inflight, so for that window inflight is 0 — the pill would read
                // "All changes saved" and the Save button would be enabled while a typed quantity
                // was still sitting in a timer. Clicking Save there navigates away and the write is
                // abandoned; the row is ALSO skipped by serializeCustomLines (it has a
                // committedLiId), so the quantity reaches the server through neither path. That is
                // the exact silent-loss this whole change exists to kill, so pending edits must
                // count as unsaved work everywhere inflight does.
                function pendingLineEdits(){
                  var n = 0;
                  if (typeof linePending === 'object' && linePending) {
                    for (var k in linePending) if (linePending[k]) n++;
                  }
                  return n;
                }
                function unsettledWrites(){ return inflight + pendingLineEdits(); }

                function setPill(){
                  var busy = unsettledWrites();
                  var saveBtn = document.getElementById('edit-save-btn');
                  if (saveBtn){
                    saveBtn.disabled = busy > 0;
                    saveBtn.title = busy > 0 ? 'Waiting for in-progress changes to save…' : '';
                  }
                  if (!pill) return;
                  if (anyFailed) { pill.textContent = 'Changes not saved — review'; pill.dataset.state='failed'; pill.style.background='#fdecec'; pill.style.color='#c00'; }
                  else if (busy > 0) { pill.textContent = 'Saving ' + busy + ' change' + (busy===1?'':'s') + '…'; pill.dataset.state='saving'; pill.style.background='#fff6e6'; pill.style.color='#b45309'; }
                  else { pill.textContent = 'All changes saved'; pill.dataset.state='saved'; pill.style.background='#e8f5ea'; pill.style.color='#1b7a3d'; }
                }
                function recomputeFailed(){ anyFailed = document.querySelectorAll('.row-save-chip[data-state="failed"]').length > 0; }
                function chipOf(tr){ return tr ? tr.querySelector('.row-save-chip') : null; }
                function setChip(tr, state, msg){
                  var c = chipOf(tr); if (!c) return;
                  c.dataset.state = state; c.title = msg || '';
                  c.style.cursor = 'default'; c.onclick = null;
                  if (state === 'saving'){ c.style.display='inline'; c.style.color='var(--muted)'; c.textContent='● Saving…'; }
                  else if (state === 'saved'){ c.style.display='inline'; c.style.color='#1b7a3d'; c.textContent='✓ Saved';
                    setTimeout(function(){ if (c.dataset.state==='saved'){ c.style.display='none'; c.textContent=''; } }, 2000); }
                  else if (state === 'failed'){ c.style.display='inline'; c.style.color='#c00'; c.style.cursor='pointer'; c.textContent='⚠ Not saved'; }
                  else { c.style.display='none'; c.textContent=''; }
                  recomputeFailed(); setPill();
                }
                window.addEventListener('beforeunload', function(e){
                  // unsettledWrites() (not inflight) so a qty still sitting in the 500ms debounce
                  // also warns — otherwise navigating away in that window loses it silently.
                  if (unsettledWrites() > 0 || anyFailed){ e.preventDefault(); e.returnValue=''; return ''; }
                });

                // POST helper. Returns {ok, json} ; ok=false on 422/5xx/network.
                // A 30s ceiling is REQUIRED, not a nicety: inflight gates the batch Save button, so
                // a request that never settles would leave Save disabled forever and the operator
                // unable to save at all. Aborting resolves the promise, so inflight always drains.
                function post(path, body){
                  var opts = { method:'POST', credentials:'same-origin',
                    headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) };
                  try { if (window.AbortSignal && AbortSignal.timeout) opts.signal = AbortSignal.timeout(30000); } catch (e) {}
                  return fetch(path, opts)
                    .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, json:j }; }, function(){ return { ok:false, json:{ errors:['bad response'] } }; }); })
                    .catch(function(e){ return { ok:false, json:{ errors:[(e && e.name === 'TimeoutError') ? 'timed out — not saved' : 'network error'] } }; });
                }
                function totals(order){
                  if (!order) return;
                  function money(n){ return '$' + (Number(n)||0).toFixed(2); }
                  var rows = document.querySelectorAll('.totals-block .totals-row');
                  if (rows[0]) rows[0].lastElementChild.textContent = money(order.subtotal);
                  var totRow = document.querySelector('.totals-block .totals-total');
                  if (totRow) totRow.lastElementChild.textContent = money(order.total);
                  if (order.discount !== undefined) discountRow(order.discount);
                }
                // Keep the totals-block Discount row in sync. An order discount is a per-line
                // allocation, so there is no line ROW to repaint — without this the applied discount
                // stays invisible until a full page reload.
                function discountRow(d){
                  function money(n){ return '$' + (Number(n)||0).toFixed(2); }
                  var row = document.getElementById('order-discount-row');
                  var amt = d && Number(d.amount) || 0;
                  if (amt <= 0){ if (row) row.remove(); toggleRemoveDiscBtn(false); return; }
                  if (!row){
                    row = document.createElement('div');
                    row.className = 'totals-row'; row.id = 'order-discount-row';
                    row.appendChild(document.createElement('span'));
                    row.appendChild(document.createElement('span'));
                    var first = document.querySelector('.totals-block .totals-row');
                    if (first && first.parentNode) first.parentNode.insertBefore(row, first.nextSibling);
                  }
                  row.firstElementChild.textContent = 'Discount' + (d.reason ? ' — ' + d.reason : '');
                  row.lastElementChild.textContent = '-' + money(amt);
                  toggleRemoveDiscBtn(true);
                }
                function toggleRemoveDiscBtn(on){
                  var b = document.getElementById('discount-remove-btn');
                  if (b) b.style.display = on ? '' : 'none';
                }
                function reconcile(){
                  fetch('/api/orders/' + ORDER_ID + '/line-state', { credentials:'same-origin' })
                    .then(function(r){ return r.json(); })
                    .then(function(s){ if (s && s.ok){ totals(s); } })
                    .catch(function(){});
                }

                // Generic single-action runner with per-row chip + idemKey + retry.
                // NB: run() owns dataset.committing for the whole attempt, INCLUDING the chip-retry
                // and the 409 auto-rekey. Setting it at the call sites instead left the retry path
                // uncovered — a retried row was visible to serializeCustomLines again, reopening the
                // batch-Save double-add this change exists to close.
                function run(tr, idemKey, path, body, onOk, rekeyed){
                  setChip(tr, 'saving'); inflight++;
                  if (tr && tr.dataset) tr.dataset.committing = '1';
                  setPill();
                  return post(path, body).then(function(res){
                    inflight--;
                    if (res.ok && res.json && res.json.ok){
                      setChip(tr, 'saved', (res.json.warnings && res.json.warnings.length) ? res.json.warnings.join(' ') : '');
                      totals(res.json.order);
                      if (onOk) onOk(res.json);
                    } else if (res.json && res.json.code === 'IDEM_PAYLOAD_MISMATCH' && !rekeyed){
                      // The server refused to replay a stale save-token against NEW data (the
                      // $80-shipping loss class). Mint a fresh key and resubmit exactly once.
                      var nk = uuid();
                      if (tr && tr.dataset && tr.dataset.idemKey === body.idemKey) tr.dataset.idemKey = nk;
                      body.idemKey = nk;
                      setPill();
                      return run(tr, nk, path, body, onOk, true);
                    } else {
                      var msg = (res.json && res.json.errors) ? res.json.errors.join('; ') : 'Save failed';
                      setChip(tr, 'failed', msg);
                      var c = chipOf(tr);
                      // RETURN the retry so callers can still chain off it. Without this the retry
                      // was fire-and-forget: any continuation attached to the ORIGINAL run()
                      // promise had already settled on the failure, so work queued between the
                      // failure and the retry (see flushDirty) was never performed.
                      if (c) c.onclick = function(){ return run(tr, idemKey, path, body, onOk); }; // retry, SAME idemKey
                      reconcile();
                    }
                    // Cleared on BOTH settle paths (success and failure). On failure the row must
                    // become visible to the batch Save again — that is the recovery route for a
                    // line the incremental path could not commit. The rekey branch returns above
                    // WITHOUT clearing, so the nested attempt keeps ownership of the flag.
                    if (tr && tr.dataset) delete tr.dataset.committing;
                    setPill();
                  });
                }

                // Send ONE field to its per-line editor. P0 fix (2026-07-21): the previous
                // reroute fired qty AND price on every edit. The redundant write is a Shopify
                // no-op that the server deliberately reports as success, and both writes paint the
                // SAME row chip — so a genuinely failed qty save was repainted green by the no-op
                // price save that landed after it, and the global pill then cleared. Only ever send
                // the field the operator actually changed.
                function rerouteField(tr, el, which){
                  var liId = tr.dataset.committedLiId; if (!liId || !el) return;
                  if (which === 'qty'){
                    var q = parseInt(el.value, 10);
                    if (q > 0) window.__autosave.qtyChange(tr, liId, q);
                  } else {
                    var pr = parseFloat(el.value);
                    if (pr >= 0) window.__autosave.priceChange(tr, liId, pr);
                  }
                }
                // Wire a row's qty/price inputs so edits AFTER the line is committed are persisted.
                // P0 fix (2026-07-21): catalog picker rows had NO listener on .cl-qty/.cl-price and
                // no name attribute, and serializeCustomLines skips a row once committedLiId is set
                // — so setting qty 12 after the auto-add was dropped by BOTH the incremental and the
                // batch path. The order shipped 1 while the pill read "All changes saved".
                // Edits typed while the add is still IN FLIGHT are held as dirty and flushed on
                // commit, rather than landing on an unset committedLiId and vanishing.
                function wireRowEdits(tr, qtyEl, priceEl){
                  [[qtyEl, 'qty'], [priceEl, 'price']].forEach(function(pair){
                    var el = pair[0], which = pair[1];
                    if (!el || el.dataset.rrWired) return;
                    el.dataset.rrWired = '1';
                    el.addEventListener('change', function(){
                      if (tr.dataset.committedLiId) rerouteField(tr, el, which);
                      else tr.dataset.dirty = (tr.dataset.dirty ? tr.dataset.dirty + ',' : '') + which;
                    });
                  });
                }
                function flushDirty(tr, qtyEl, priceEl){
                  var d = tr.dataset.dirty; if (!d || !tr.dataset.committedLiId) return;
                  delete tr.dataset.dirty;
                  if (d.indexOf('qty') !== -1) rerouteField(tr, qtyEl, 'qty');
                  if (d.indexOf('price') !== -1) rerouteField(tr, priceEl, 'price');
                }

                window.__autosave = {
                  // Add-from-picker: persist immediately; stamp committed liId onto the row.
                  // Auto-commit on pick is INTENTIONAL and covered by a UI test ("auto-saves
                  // WITHOUT manual Save") — do not convert this to an explicit Add button. It is
                  // safe here (unlike a custom line) because the row is created with a real variant
                  // and its correct wholesale price already filled in, so the committed value is
                  // never a placeholder. What was missing was the post-commit wiring below.
                  addCatalogLine: function(p, tr, wholesale, listPrice){
                    var qtyEl = tr.querySelector('.cl-qty'), priceEl = tr.querySelector('.cl-price');
                    var idemKey = tr.dataset.idemKey || (tr.dataset.idemKey = uuid());
                    var body = { idemKey: idemKey, variantId: p.variantId, title: p.label || '', sku: p.sku || '',
                      qty: parseInt(qtyEl ? qtyEl.value : '1', 10) || 1,
                      listPrice: parseFloat(listPrice) || 0, price: parseFloat(priceEl ? priceEl.value : wholesale) };
                    wireRowEdits(tr, qtyEl, priceEl);
                    // run() sets dataset.committing for the whole attempt (incl. retry/rekey),
                    // which is what hides this row from serializeCustomLines mid-flight.
                    // Clear dirty FIRST: the blur that precedes this call already fired a change
                    // event, and the request payload above carries those exact values — leaving
                    // dirty set made flushDirty re-send them as a redundant /line/price every add.
                    delete tr.dataset.dirty;
                    // flushDirty lives in onOk, NOT in a .then on this promise. onOk fires on
                    // whichever attempt actually commits — including a chip retry, which is a
                    // fresh run() this promise knows nothing about. Attached to .then it silently
                    // skipped the retry path: a qty typed after a failed add was never sent, while
                    // the row showed the new value and a green chip.
                    run(tr, idemKey, '/orders/' + ORDER_ID + '/line/add', body, function(j){
                      if (j.line && j.line.liId){ tr.dataset.committedLiId = j.line.liId; }
                      flushDirty(tr, qtyEl, priceEl);
                    });
                  },
                  // Custom row: EXPLICIT commit only (Add button or Enter) — NEVER on a typing pause.
                  // P0 fix (2026-07-21, $80-shipping loss): the 6/29 debounce auto-save still fired
                  // mid-entry (any pause >600ms committed a half-typed title with the pristine $0.00
                  // price), and the row-scoped idemKey then deduped the corrected resubmit as a
                  // replay — the fixed data was silently dropped and the UI said "saved". A committed
                  // Shopify line can never be renamed, so premature commits are unrecoverable; the only
                  // safe design is no implicit commit at all. The main batch Save still picks up
                  // uncommitted rows (serializeCustomLines), so an un-clicked row is never lost.
                  // After commit: qty/price edits re-route through the per-line editors (fresh idemKey
                  // per flush); the title input locks.
                  wireCustomRow: function(tr){
                    var titleEl = tr.querySelector('.ncl-title'), qtyEl = tr.querySelector('.ncl-qty'), priceEl = tr.querySelector('.ncl-price');
                    var addBtn = tr.querySelector('.ncl-add');
                    var saving = false;
                    function lockCommitted(){
                      if (titleEl && !titleEl.readOnly){ titleEl.readOnly = true; titleEl.title = 'Saved — to rename, remove this line and add a new one.'; }
                      if (addBtn){ addBtn.remove(); addBtn = null; }
                    }
                    function commit(){
                      // Already committed: persistence is handled entirely by the per-field change
                      // handlers (wireRowEdits). This used to call a reroute() that posted BOTH qty
                      // and price; the redundant write is a server-side no-op reported as success,
                      // and it repainted a genuinely failed sibling save green on the shared chip.
                      if (tr.dataset.committedLiId) return;
                      if (saving) return; // single-flight: the in-flight submit carries final values
                      var title = (titleEl && titleEl.value || '').trim();
                      var qty = parseInt(qtyEl && qtyEl.value, 10);
                      var price = parseFloat(priceEl && priceEl.value);
                      if (!title){ setChip(tr, 'failed', 'Title required'); if (titleEl) titleEl.focus(); return; }
                      if (!(qty > 0)){ setChip(tr, 'failed', 'Qty must be at least 1'); if (qtyEl) qtyEl.focus(); return; }
                      if (!(price >= 0)){ setChip(tr, 'failed', 'Price required'); if (priceEl) priceEl.focus(); return; }
                      // Row-scoped (STICKY) key, matching addCatalogLine. This is the double-add
                      // guard: if Shopify commits but the HTTP response is lost, the chip reads
                      // "Not saved" and the operator clicks Add again — the sticky key replays the
                      // committed ledger row instead of staging a SECOND real money line (which
                      // Shopify cannot delete). Reusing it across a CORRECTED payload is now safe:
                      // the server 409s with IDEM_PAYLOAD_MISMATCH and run() auto-rekeys this row.
                      var idemKey = tr.dataset.idemKey || (tr.dataset.idemKey = uuid());
                      saving = true;
                      // run() owns dataset.committing (hides the row from the batch Save for the
                      // whole attempt). Clear dirty first — the blur from clicking Add already
                      // fired change events, and the payload below carries those same values, so
                      // leaving dirty set re-sent them as a redundant /line/price after every add.
                      delete tr.dataset.dirty;
                      if (addBtn){ addBtn.disabled = true; addBtn.textContent = 'Adding…'; }
                      run(tr, idemKey, '/orders/' + ORDER_ID + '/line/custom', { idemKey: idemKey, title: title, qty: qty, price: price }, function(j){
                        if (j.line && j.line.liId){ tr.dataset.committedLiId = j.line.liId; lockCommitted(); }
                        // In onOk (not .then) so a chip RETRY also flushes — see addCatalogLine.
                        // Values typed while the add was in flight would otherwise be stranded: the
                        // change listener saw no committedLiId and the inputs never change again,
                        // so no later event could ever flush them.
                        flushDirty(tr, qtyEl, priceEl);
                      }).then(function(){
                        saving = false;
                        if (addBtn && !tr.dataset.committedLiId){ addBtn.disabled = false; addBtn.textContent = 'Add'; }
                      });
                    }
                    [titleEl, qtyEl, priceEl].forEach(function(el){
                      if (!el) return;
                      el.addEventListener('keydown', function(e){
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        // On a COMMITTED row, blur instead of commit(): blurring fires the change
                        // handler, which routes only the field that actually changed. Calling
                        // commit() here fell through to reroute(), which posted BOTH qty and price
                        // — and the redundant no-op write repainted a failed save green.
                        if (tr.dataset.committedLiId) { el.blur(); return; }
                        commit();
                      });
                    });
                    // qty/price route to the per-line editors once committed, and are held as dirty
                    // while the add is still in flight. Title is intentionally NOT wired — it locks
                    // on commit (Shopify cannot rename a committed line).
                    wireRowEdits(tr, qtyEl, priceEl);
                    if (addBtn) addBtn.addEventListener('click', function(){ commit(); });
                  },
                  // Existing-line qty change (debounced, single-flight, last-write-wins).
                  qtyChange: function(tr, liId, qty){
                    debouncedLine(tr, liId, 'qty', { qty: qty }, '/orders/' + ORDER_ID + '/line/qty');
                  },
                  priceChange: function(tr, liId, price){
                    debouncedLine(tr, liId, 'price', { price: price }, '/orders/' + ORDER_ID + '/line/price');
                  },
                  removeLine: function(liId, tr){
                    var idemKey = uuid();
                    run(tr, idemKey, '/orders/' + ORDER_ID + '/line/remove', { idemKey: idemKey, liId: liId }, function(){
                      tr.style.opacity = '0.4'; tr.dataset.removed = '1';
                    });
                  },
                };

                // Per-line single-flight + debounce for qty/price. Latest value wins.
                var lineTimers = {}, lineInflight = {}, linePending = {};
                function debouncedLine(tr, liId, kind, extra, path){
                  var key = liId + ':' + kind;
                  linePending[key] = { tr: tr, extra: extra, path: path, liId: liId };
                  if (lineTimers[key]) clearTimeout(lineTimers[key]);
                  lineTimers[key] = setTimeout(function(){ flushLine(key); }, 500);
                  // Reflect the pending edit IMMEDIATELY so Save is disabled for the debounce
                  // window too — not just once the request is actually in flight.
                  setChip(tr, 'saving'); setPill();
                }
                function flushLine(key){
                  if (lineInflight[key]) return; // will re-fire after current resolves
                  var p = linePending[key]; if (!p) return;
                  linePending[key] = null; lineInflight[key] = true;
                  var idemKey = uuid();
                  var body = Object.assign({ idemKey: idemKey, liId: p.liId }, p.extra);
                  setChip(p.tr, 'saving'); inflight++; setPill();
                  post(p.path, body).then(function(res){
                    inflight--; lineInflight[key] = false;
                    if (res.ok && res.json && res.json.ok){ setChip(p.tr, 'saved'); totals(res.json.order); }
                    else {
                      var msg = (res.json && res.json.errors) ? res.json.errors.join('; ') : 'Save failed';
                      setChip(p.tr, 'failed', msg);
                      // FAILURE: mark failed + offer a CLICKABLE manual retry. Do NOT re-queue into
                      // linePending here — the trailing auto-flush (below) would then re-fire the
                      // just-failed action instantly and loop forever (stuck "Saving N change…").
                      // The retry click re-queues THEN flushes, exactly once.
                      var c = chipOf(p.tr); if (c) c.onclick = function(){ linePending[key] = { tr: p.tr, extra: p.extra, path: p.path, liId: p.liId }; flushLine(key); };
                      reconcile();
                    }
                    setPill();
                    // Only fires when debouncedLine queued a NEWER change while this was in-flight
                    // (legit last-write-wins) — never on failure, since the failure path no longer re-queues.
                    if (linePending[key] && !lineInflight[key]) flushLine(key);
                  });
                }

                // Wire change handlers on EXISTING line rows (qty + price inputs).
                function wireExisting(){
                  document.querySelectorAll('#edit-form tr[data-existing="1"]').forEach(function(tr){
                    var liId = tr.dataset.liId; if (!liId) return;
                    var qtyEl = tr.querySelector('.edit-qty-input');
                    var priceEl = tr.querySelector('.edit-price-input');
                    if (qtyEl && !qtyEl.dataset.asWired){ qtyEl.dataset.asWired='1';
                      // P0 fix (2026-06-29): save on COMMIT (change/blur) only — NOT per-keystroke.
                      // The old 'input' listener fired qtyChange on every keystroke, so editing "3" to
                      // "15" briefly sent "1" then "15", and clicking into a field could fire a save at
                      // the unchanged current value — which Shopify rejects with "at least one change"
                      // and painted the red pill. 'change' fires once when the user leaves the field.
                      qtyEl.addEventListener('change', function(){ var q = parseInt(qtyEl.value,10); if (q>=0) window.__autosave.qtyChange(tr, liId, q); });
                    }
                    if (priceEl && !priceEl.dataset.asWired){ priceEl.dataset.asWired='1';
                      priceEl.addEventListener('change', function(){ var pr = parseFloat(priceEl.value); if (pr>=0) window.__autosave.priceChange(tr, liId, pr); });
                    }
                  });
                }
                wireExisting();

                // Order-level discount bar — EXPLICIT apply only.
                // P0 fix (2026-07-21): this used to commit on the BLUR of any field, behind a
                // one-way "saved" latch. Two failures compounded, the same pair that cost $80 on a
                // custom line: (1) tabbing out of the reason box with the % still half-typed
                // committed a real discount at the wrong value; (2) the early-return on "saved"
                // silently swallowed every correction — no request, no chip, no error, while the
                // inputs stayed editable and invited the correction being discarded.
                // Now: nothing commits until "Apply discount" is clicked (or Enter), the state is
                // visible in a chip, corrections re-apply, and the SERVER replaces the prior
                // discount line rather than stacking a second one.
                (function(){
                  var bar = document.getElementById('edit-discount-bar'); if (!bar) return;
                  var pctEl = bar.querySelector('input[name="discountPct"]');
                  var fixedEl = bar.querySelector('input[name="discountFixed"]');
                  var reasonEl = bar.querySelector('input[name="discountReason"]');
                  var btn = document.getElementById('discount-apply-btn');
                  var chip = document.getElementById('discount-chip');
                  var applying = false, lastTuple = null, lastKey = null;

                  function setDiscChip(state, msg){
                    if (!chip) return;
                    chip.dataset.state = state;
                    if (state === 'saving'){ chip.style.display='inline'; chip.style.color='#888'; chip.textContent='Applying…'; }
                    else if (state === 'saved'){ chip.style.display='inline'; chip.style.color='#0a0'; chip.title = msg||''; chip.textContent='✓ Applied' + (msg ? ' — ' + msg : ''); }
                    else if (state === 'failed'){ chip.style.display='inline'; chip.style.color='#c00'; chip.style.cursor='pointer'; chip.title = msg||''; chip.textContent='⚠ Not applied'; }
                    else { chip.style.display='none'; chip.textContent=''; }
                  }
                  function apply(){
                    if (applying) return;
                    var pct = parseFloat(pctEl && pctEl.value) || 0;
                    var fixed = parseFloat(fixedEl && fixedEl.value) || 0;
                    var reason = (reasonEl && reasonEl.value || '').trim();
                    if (!reason){ setDiscChip('failed','A reason is required'); if (reasonEl) reasonEl.focus(); return; }
                    if (!(pct>0) && !(fixed>0)){ setDiscChip('failed','Enter a % or a $ amount'); if (pctEl) pctEl.focus(); return; }
                    if (pct > 100){ setDiscChip('failed','Percentage cannot exceed 100'); if (pctEl) pctEl.focus(); return; }
                    // Key per distinct VALUE-tuple: an unchanged re-click replays safely (no
                    // double-apply if a response was lost); changed values mint a new key so the
                    // correction is a genuinely new action the server will replace with.
                    var tuple = pct + '|' + fixed + '|' + reason;
                    if (tuple !== lastTuple){ lastTuple = tuple; lastKey = uuid(); }
                    var idemKey = lastKey;
                    applying = true;
                    if (btn){ btn.disabled = true; btn.textContent = 'Applying…'; }
                    setDiscChip('saving'); inflight++; setPill();
                    post('/orders/' + ORDER_ID + '/discount/order', { idemKey: idemKey, discountPct: pct||'', discountFixed: fixed||'', discountReason: reason }).then(function(res){
                      inflight--; applying = false;
                      if (btn){ btn.disabled = false; btn.textContent = 'Apply discount'; }
                      if (res.ok && res.json && res.json.ok){
                        totals(res.json.order);
                        discountRow(res.json.discount);   // no discount LINE row to repaint — see discountRow()
                        setDiscChip('saved', (res.json.warnings && res.json.warnings.length) ? res.json.warnings.join(' ') : '');
                      } else if (res.json && res.json.code === 'IDEM_PAYLOAD_MISMATCH'){
                        // Stale key vs new values — rekey and let the operator re-apply.
                        lastTuple = null; lastKey = null;
                        setDiscChip('failed', 'Please click Apply again');
                        if (chip) chip.onclick = apply;
                      } else {
                        anyFailed = true;
                        var msg = (res.json && res.json.errors) ? res.json.errors.join('; ') : 'Apply failed';
                        setDiscChip('failed', msg);
                        if (chip) chip.onclick = apply;
                        reconcile();
                      }
                      setPill();
                    });
                  }
                  if (btn) btn.addEventListener('click', apply);
                  // Clear the discount entirely. Replaces the ✕ that used to sit on the negative
                  // discount LINE row — an allocation has no row, so without this there is no way
                  // to undo an order discount from the admin at all.
                  var removeBtn = document.getElementById('discount-remove-btn');
                  if (removeBtn) removeBtn.addEventListener('click', function(){
                    if (applying) return;
                    applying = true;
                    removeBtn.disabled = true;
                    setDiscChip('saving'); inflight++; setPill();
                    post('/orders/' + ORDER_ID + '/discount/order/remove', { idemKey: uuid() }).then(function(res){
                      inflight--; applying = false; removeBtn.disabled = false;
                      if (res.ok && res.json && res.json.ok){
                        lastTuple = null; lastKey = null;
                        if (pctEl) pctEl.value = ''; if (fixedEl) fixedEl.value = ''; if (reasonEl) reasonEl.value = '';
                        totals(res.json.order);
                        discountRow(res.json.discount);
                        setDiscChip('idle');
                      } else {
                        anyFailed = true;
                        setDiscChip('failed', (res.json && res.json.errors) ? res.json.errors.join('; ') : 'Remove failed');
                        reconcile();
                      }
                      setPill();
                    });
                  });
                  [pctEl, fixedEl, reasonEl].forEach(function(el){
                    if (!el) return;
                    el.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); apply(); } });
                    // Editing after an apply clears the green chip so stale "Applied" never lingers
                    // over values that are no longer what the order carries.
                    el.addEventListener('input', function(){ if (chip && chip.dataset.state === 'saved') setDiscChip('idle'); });
                  });
                })();

                setPill();
              })();
            })();
          </script>
        </div>
        ${/* Discount modal */''}<div id="discount-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:340px;max-width:480px">
            <h3 style="margin:0 0 16px">Apply order discount</h3>
            <form method="POST" action="/orders/${h(numId)}/discount">
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Type</label><br>
                <select name="type" class="filter-select" style="width:100%;margin-top:4px">
                  <option value="pct">Percentage (%)</option>
                  <option value="fixed">Fixed amount ($)</option>
                </select>
              </div>
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Value</label><br>
                <input type="number" name="value" step="0.01" min="0" class="filter-input" style="width:100%;margin-top:4px" placeholder="e.g. 10">
              </div>
              <div style="margin-bottom:16px">
                <label style="font-size:13px;font-weight:500">Reason (required)</label><br>
                <input type="text" name="reason" class="filter-input" style="width:100%;margin-top:4px" placeholder="e.g. Loyalty discount" required>
              </div>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Apply discount</button>
                <button type="button" class="btn btn-ghost" onclick="toggleDiscountModal(false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Fulfill modal */''}<div id="fulfill-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:400px;max-width:560px;max-height:80vh;overflow-y:auto">
            <h3 style="margin:0 0 16px">Fulfill items</h3>
            <form method="POST" action="/orders/${h(numId)}/fulfill">
              <div style="margin-bottom:12px">
                ${/* CURRENT-FIELDS (2026-06-29): only CURRENTLY-active lines are fulfillable — a line removed
                      in a prior edit (currentQuantity 0) is no longer part of the order, so it's excluded from
                      the fulfill picker, and the max/value reflect currentQuantity not the frozen original. */''}
                ${lineItems.filter(item => ((item.currentQuantity != null ? item.currentQuantity : item.quantity) || 0) > 0).map(item => {
                  const cq = item.currentQuantity != null ? item.currentQuantity : (item.quantity || 0);
                  const bo = backorderMap.get(item.id);
                  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px">
                    <input type="checkbox" name="sel_${h(item.id)}" value="1" checked style="flex-shrink:0">
                    <span style="flex:1">${h(item.title)}${bo ? ' <span class="badge badge-warning">Backorder</span>' : ''}</span>
                    <input type="number" name="lineItems[${h(item.id)}]" value="${cq}" min="0" max="${cq}" style="width:60px">
                  </div>`;
                }).join('')}
              </div>
              <div style="margin-bottom:12px;display:flex;gap:8px">
                <input type="text" name="trackingCompany" class="filter-input" style="flex:1" placeholder="Carrier (e.g. USPS)">
                <input type="text" name="trackingNumber" class="filter-input" style="flex:2" placeholder="Tracking number">
              </div>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:16px">
                <input type="checkbox" name="notifyCustomer" value="1"> Email customer with tracking info
              </label>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Record fulfillment</button>
                <button type="button" class="btn btn-ghost" onclick="toggleFulfillModal(false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Backorder modal */''}<div id="backorder-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:340px;max-width:480px">
            <h3 style="margin:0 0 16px">Mark as backordered</h3>
            <form method="POST" action="/orders/${h(numId)}/backorder">
              <input type="hidden" name="lineItemId" id="bo-li-id">
              <input type="hidden" name="lineItemTitle" id="bo-li-title">
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Quantity backordered</label><br>
                <input type="number" name="quantity" id="bo-quantity" min="1" class="filter-input" style="width:100%;margin-top:4px">
              </div>
              <div style="margin-bottom:16px">
                <label style="font-size:13px;font-weight:500">Expected ship date (optional)</label><br>
                <input type="date" name="eta" class="filter-input" style="width:100%;margin-top:4px">
              </div>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Mark backordered</button>
                <button type="button" class="btn btn-ghost" onclick="toggleBackorderModal(null,null,null,false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Cancel modal */''}<div id="cancel-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:380px;max-width:500px">
            <h3 style="margin:0 0 16px;color:#c00">Cancel this order?</h3>
            ${/* CURRENT-FIELDS (2026-06-29): show the CURRENT total (post-edit truth) the staffer is canceling, not the frozen original. */''}
            <p style="color:#555;margin:0 0 16px">This will cancel ${h(order.name)} (${fmtMoney(curTotals.total)}) in Shopify. The order will be marked CANCELED and stock will be restored.</p>
            <form method="POST" action="/orders/${h(numId)}/cancel">
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Reason</label><br>
                <select name="reason" class="filter-select" style="width:100%;margin-top:4px">
                  <option value="CUSTOMER">Customer request</option>
                  <option value="INVENTORY">Inventory unavailable</option>
                  <option value="FRAUD">Fraud</option>
                  <option value="DECLINED">Payment declined</option>
                  <option value="OTHER" selected>Other</option>
                </select>
              </div>
              <div style="margin-bottom:12px">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px">
                  <input type="checkbox" name="restock" value="1" checked>
                  Restock items to inventory
                </label>
              </div>
              <div style="margin-bottom:12px">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px">
                  <input type="checkbox" name="refund" value="1" ${isPaid ? 'checked' : ''}>
                  Refund payment (if paid)
                </label>
              </div>
              <div style="margin-bottom:16px">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px">
                  <input type="checkbox" name="notify" value="1" checked>
                  Email customer
                </label>
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button type="button" class="btn btn-ghost" onclick="toggleCancelModal(false)">Keep order</button>
                <button type="submit" class="btn btn-danger" style="background:#c00;color:#fff">Cancel order</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Second build (Build C): Record manual payment modal — cloned from cancel-modal styling */''}${canRecordPayment ? `<div id="record-payment-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:380px;max-width:500px">
            <h3 style="margin:0 0 16px">Record manual payment</h3>
            <p style="color:#555;margin:0 0 16px">Record an off-Shopify payment (check, ACH, cash on pickup, etc.) against ${h(order.name)}.</p>
            <form method="POST" action="/orders/${h(numId)}/record-payment" onsubmit="var b=document.getElementById('record-payment-submit'); if(b){b.disabled=true;b.textContent='Recording…';}">
              <div style="margin-bottom:12px;font-size:13px;background:#f6f8f2;border:1px solid var(--border);border-radius:6px;padding:10px">
                Marks the <b>full balance ${fmtMoney(outstanding)}</b> as paid. <span style="color:var(--muted)">Partial manual payments aren't supported on this Shopify plan.</span>
              </div>
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Payment method <span style="color:#c00">*</span></label><br>
                <input type="text" name="paymentMethod" required placeholder="e.g. Check #1234, ACH 6/29, Cash on pickup" class="filter-input" style="width:100%;margin-top:4px">
              </div>
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Date received</label><br>
                <input type="date" name="processedAt" class="filter-input" style="width:100%;margin-top:4px">
                <div style="font-size:11px;color:var(--muted);margin-top:4px">Optional — defaults to now.</div>
              </div>
              <div style="margin-bottom:16px">
                <label style="font-size:13px;font-weight:500">Internal note</label><br>
                <textarea name="note" class="textarea" rows="2" placeholder="Optional note for staff (not shown to customer)"></textarea>
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button type="button" class="btn btn-ghost" onclick="toggleRecordPaymentModal(false)">Cancel</button>
                <button type="submit" id="record-payment-submit" class="btn btn-success">Record payment</button>
              </div>
            </form>
          </div>
        </div>` : ''}
        ${/* Ship Order modal */''}<div id="ship-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:520px;max-width:640px;max-height:90vh;overflow-y:auto">
            <h3 style="margin:0 0 16px;display:flex;align-items:center;gap:8px">📦 Ship order ${h(order.name)}</h3>
            <div style="margin-bottom:14px">
              <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">Items to ship <span style="color:#999;font-weight:400;font-size:12px">(uncheck to split-ship later)</span></label>
              <div style="border:1px solid #e5e5e5;border-radius:4px;padding:8px;max-height:160px;overflow-y:auto">
                ${/* CURRENT-FIELDS (2026-06-29): ship only CURRENTLY-active lines — a removed line (currentQuantity 0)
                      is no longer shippable, and the qty shown/posted is currentQuantity not the frozen original. */''}
                ${(order.lineItems?.edges || []).filter(e => ((e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0) > 0).map(e => {
                  const cq = e.node.currentQuantity != null ? e.node.currentQuantity : (e.node.quantity || 0);
                  return `
                  <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
                    <input type="checkbox" name="ship_li[]" value="${h(e.node.id || '')}" data-qty="${cq || 1}" checked>
                    <span style="flex:1">${h(e.node.title || '—')} × ${cq}</span>
                    <span class="text-muted" style="font-size:11px">${h(e.node.variant?.sku || '')}</span>
                  </label>`;
                }).join('')}
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
              <div>
                <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">Ship from</label>
                <select id="ship-from" class="filter-select" style="width:100%">
                  <option value="fww-hp">Fuzzywumpets — Highland Park</option>
                  <option value="beth-hastings">Beth Hastings — Fuzzy South</option>
                </select>
              </div>
              <div>
                <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px">Package weight (lbs)</label>
                <input type="number" id="ship-weight" value="1" min="0.1" step="0.1" class="filter-input" style="width:100%">
              </div>
            </div>
            <div id="ship-rates-area" style="margin-bottom:14px;display:none">
              <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">Pick a rate</label>
              <div id="ship-rates-list" style="border:1px solid #e5e5e5;border-radius:4px;padding:8px;max-height:240px;overflow-y:auto"></div>
            </div>
            <div id="ship-label-area" style="margin-bottom:14px;display:none">
              <div style="background:#f1f7da;border:1px solid #9BBC0E;border-radius:6px;padding:12px;display:flex;align-items:center;gap:12px">
                <span style="font-size:24px">✓</span>
                <div style="flex:1">
                  <div style="font-weight:600">Label purchased + order fulfilled</div>
                  <div style="font-size:12px;color:#555" id="ship-tracking-info"></div>
                </div>
                <a id="ship-label-link" href="#" target="_blank" rel="noopener" class="btn btn-primary">Print Label PDF ↗</a>
              </div>
            </div>
            <div id="ship-error" style="display:none;color:#c00;font-size:13px;margin-bottom:10px"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button type="button" class="btn btn-ghost" onclick="toggleShipModal(false)">Close</button>
              <button type="button" id="ship-get-rates-btn" class="btn btn-secondary" onclick="shipGetRates()">Get rates</button>
              <button type="button" id="ship-buy-btn" class="btn btn-primary" onclick="shipBuyLabel()" disabled style="display:none">Buy label + fulfill</button>
            </div>
          </div>
        </div>
        ${/* Generate Invoice modal */''}<div id="invoice-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:380px;max-width:500px">
            <h3 style="margin:0 0 16px">Generate Invoice</h3>
            <form method="POST" action="/orders/${h(numId)}/partial-invoice">
              ${/* The "Fulfilled items only (partial invoice)" radio was REMOVED (2026-08-05): both
                    branches of the server-side ternary it drove were identical, so it billed the
                    ENTIRE order while badging the result "partial". It pre-selected itself whenever
                    the order had any fulfillment, so the default action told staff they had issued a
                    partial invoice when they had issued a duplicate full one. The server now rejects
                    that value outright — see POST /orders/:id/partial-invoice.
                    SYNC: re-adding a scope control here requires real per-line fulfillment detail in
                    getOrderDetail AND lifting the server-side rejection; do not re-add just the UI. */''}
              <input type="hidden" name="type" value="full">
              <div style="margin-bottom:16px">
                <div style="font-size:13px;font-weight:500;margin-bottom:6px">Shipping charge</div>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px">
                  <input type="radio" name="shipping_handling" value="first" checked>
                  Include shipping on this invoice (common for wholesale)
                </label>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px">
                  <input type="radio" name="shipping_handling" value="none">
                  No shipping on this invoice
                </label>
                <div style="font-size:11px;color:var(--muted);margin-top:6px">
                  Shipping and tax are billed once per order, on the first invoice only.
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Generate PDF</button>
                <button type="button" class="btn btn-ghost" onclick="toggleInvoiceModal(false)">Cancel</button>
              </div>
            </form>
            <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px">Download as CSV</div>
            <div id="csv-cols" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:13px;margin-bottom:14px">
              <label><input type="checkbox" value="title" checked> Product title</label>
              <label><input type="checkbox" value="variant1" checked> Variant (option 1)</label>
              <label><input type="checkbox" value="variant2" checked> Variant 2 (option 2)</label>
              <label><input type="checkbox" value="variant3"> Variant 3 (option 3)</label>
              <label><input type="checkbox" value="upc"> UPC / Barcode</label>
              <label><input type="checkbox" value="sku" checked> SKU</label>
              <label><input type="checkbox" value="retail"> Retail price</label>
              <label><input type="checkbox" value="wholesale" checked> Wholesale price</label>
              <label><input type="checkbox" value="qty" checked> Qty</label>
              <label><input type="checkbox" value="total" checked> Line total</label>
            </div>
            <a href="/orders/${h(numId)}/invoice" class="btn btn-primary" style="margin-right:8px">View invoice PDF</a>
            <button type="button" class="btn btn-secondary" onclick="downloadInvoiceCsv(${h(numId)})">Download CSV</button>
          </div>
        </div>
        <div class="card" id="customer-notes-card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Customer notes <span class="badge badge-muted" style="margin-left:6px">${order.note && String(order.note).trim() ? 1 : 0}</span></h2>
            <span class="text-muted" style="font-size:11px">prints on the order invoice</span>
          </div>
          <form method="POST" action="/orders/${h(numId)}/note" style="margin-top:10px">
            <textarea name="note" class="textarea" rows="3" placeholder="Add a customer note for this order…">${h(order.note||'')}</textarea>
            <div style="margin-top:0.5rem;display:flex;gap:8px;align-items:center">
              <button type="submit" class="btn btn-secondary btn-sm">Save note</button>
              ${order.note && String(order.note).trim() ? `<button type="button" class="btn btn-ghost btn-sm" style="color:#a32d2d" onclick="if(confirm('Delete this customer note?')){this.form.note.value='';this.form.submit();}">Delete</button>` : ''}
            </div>
          </form>
        </div>
        <div class="card" id="internal-note-card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Internal note <span class="badge badge-muted" style="margin-left:6px">${order.internalNote && String(order.internalNote).trim() ? 1 : 0}</span></h2>
            <span class="text-muted" style="font-size:11px">staff only · never on the invoice or synced to Shopify</span>
          </div>
          <form method="POST" action="/orders/${h(numId)}/internal-note" style="margin-top:10px">
            <textarea name="note" class="textarea" rows="3" placeholder="Private staff note (e.g. how the order was created, SparkLayer unreachable)…">${h(order.internalNote||'')}</textarea>
            <div style="margin-top:0.5rem;display:flex;gap:8px;align-items:center">
              <button type="submit" class="btn btn-secondary btn-sm">Save internal note</button>
              ${order.internalNote && String(order.internalNote).trim() ? `<button type="button" class="btn btn-ghost btn-sm" style="color:#a32d2d" onclick="if(confirm('Delete this internal note?')){this.form.note.value='';this.form.submit();}">Delete</button>` : ''}
            </div>
          </form>
        </div>
        ${renderOrderHistoryCard(orderHistory)}
        <div class="card" id="visible-notes-card">
          <div class="card-header"><h2>Note visible to customer</h2></div>
          <div id="visible-notes-list" style="margin-bottom:10px">${renderVisibleNotesList(order.visibleNotes || [])}</div>
          <form id="visible-note-form" onsubmit="submitVisibleNote(event, ${h(JSON.stringify(numId))})">
            <textarea id="visible-note-body" class="textarea" rows="3" placeholder="Write a note the customer can see on their order…"></textarea>
            <div style="margin-top:0.5rem;display:flex;gap:8px;align-items:center">
              <button type="submit" class="btn btn-primary btn-sm">Send note to customer</button>
              <span id="visible-note-status" style="font-size:12px;color:var(--muted)"></span>
            </div>
          </form>
        </div>
        <div class="card" id="customer-replies-card">
          <div class="card-header"><h2>Customer replies (Re:amaze)</h2></div>
          <div id="customer-replies-list"><p class="text-muted small-text">Loading…</p></div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Fulfillments</h2></div>
          ${fulfillmentsHtml}
        </div>
      </div>
      <div class="detail-side">
        ${order.customer ? `<div class="card">
          <div class="card-header"><h2>Customer</h2></div>
          <p><a href="/customers/${shopifyNumericId(order.customer.id)}" class="link-strong">${h(order.customer.displayName)}</a></p>
          <p class="text-muted">${h(order.customer.email)}</p>
          ${order.customer.phone ? `<p class="text-muted">${h(order.customer.phone)}</p>` : ''}
        </div>` : ''}
        <div class="card">
          <div class="card-header"><h2>Shipping Address</h2></div>
          <p class="address-block">${addrHtml}</p>
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:13px;color:var(--link,#2086ba)">✏️ Edit shipping address</summary>
            <form method="POST" action="/orders/${h(numId)}/shipping-address" style="margin-top:10px;display:grid;gap:6px">
              <div style="display:flex;gap:6px">
                <input name="firstName" class="filter-input" placeholder="First name" value="${h(addr?.firstName||'')}" style="flex:1">
                <input name="lastName" class="filter-input" placeholder="Last name" value="${h(addr?.lastName||'')}" style="flex:1">
              </div>
              <input name="address1" class="filter-input" placeholder="Address line 1" value="${h(addr?.address1||'')}">
              <input name="address2" class="filter-input" placeholder="Address line 2 (optional)" value="${h(addr?.address2||'')}">
              <div style="display:flex;gap:6px">
                <input name="city" class="filter-input" placeholder="City" value="${h(addr?.city||'')}" style="flex:2">
                <input name="province" class="filter-input" placeholder="State" value="${h(addr?.province||'')}" style="flex:1">
                <input name="zip" class="filter-input" placeholder="ZIP" value="${h(addr?.zip||'')}" style="flex:1">
              </div>
              <div style="display:flex;gap:6px">
                <input name="country" class="filter-input" placeholder="Country" value="${h(addr?.country||'')}" style="flex:1">
                <input name="phone" class="filter-input" placeholder="Phone (optional)" value="${h(addr?.phone||'')}" style="flex:1">
              </div>
              <div><button type="submit" class="btn btn-primary btn-sm">Save address</button></div>
            </form>
          </details>
        </div>
        <div class="card">
          <div class="card-header"><h2>Transactions</h2></div>
          ${txHtml}
        </div>
        <div class="card">
          <div class="card-header"><h2>Tags</h2></div>
          <div class="tags-list">${(order.tags||[]).map(t => `<span class="tag">${h(t)}</span>`).join(' ')}</div>
        </div>
        ${partialInvoices.length > 0 ? `<div class="card">
          <div class="card-header"><h2>Invoices issued</h2></div>
          <div class="kv-list">
            ${partialInvoices.map(inv => `
              <div class="kv-row" style="align-items:flex-start">
                <span>
                  <strong>#${h(String(order.name||numId))}-${h(inv.invoice_letter)}</strong>
                  ${/* Every invoice this app has ever produced billed ALL line items — the old
                       `fulfilled_only` path was a no-op (see POST /orders/:id/partial-invoice). So a
                       stored type of 'fulfilled_only' does NOT mean the row was partial, and badging
                       it "partial" misrepresented historical invoices as well as new ones. Label by
                       what was actually billed, and flag the legacy rows rather than hiding them. */''}
                  <span class="badge badge-muted" style="margin-left:4px">all items</span>
                  ${inv.invoice_type === 'fulfilled_only'
                    ? `<span class="badge badge-orange" style="margin-left:4px" title="Issued before 2026-08-05, when the &quot;fulfilled items only&quot; option billed the entire order despite its label. This invoice charged for every line.">was mislabelled partial</span>`
                    : ''}
                </span>
                <div style="text-align:right">
                  <div class="mono">${fmtMoney(inv.total)}</div>
                  <div style="font-size:11px;color:var(--muted)">${fmtDate(new Date(inv.created_at).toISOString())}</div>
                  <a href="/orders/${h(numId)}/partial-invoice/${h(inv.invoice_letter)}.pdf" target="_blank" rel="noopener" class="link" style="font-size:11px">Download PDF</a>
                </div>
              </div>`).join('')}
          </div>
        </div>` : ''}
        <div class="card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Xero</h2>
            <a href="/accounting" class="link" style="font-size:12px">View all →</a>
          </div>
          ${xeroMap?.status === 'synced'
            ? `<p class="text-sm"><span class="badge badge-paid">Synced</span></p>
               <p class="text-sm text-muted" style="font-size:12px">Invoice: <code>${h(xeroMap.xero_invoice_id)}</code></p>
               <p class="text-sm text-muted" style="font-size:12px">Last synced ${fmtDate(new Date(xeroMap.synced_at).toISOString())}</p>`
            : xeroMap?.status === 'pending_retry'
            ? `<p class="text-sm"><span class="badge badge-pending">Retry queued</span></p>
               <p class="text-sm text-muted" style="font-size:11px">${h(xeroMap.error_text || '')}</p>`
            : `<p class="text-sm text-muted">Not synced to Xero yet.</p>
               <form method="POST" action="/orders/${h(numId)}/xero/sync" style="margin-top:8px">
                 <button class="btn btn-ghost btn-sm">Create Xero invoice</button>
               </form>`
          }
        </div>
      </div>
    </div>
  ` });
}

// ── Customers list ────────────────────────────────────────────────────────────
// WHAT: Build the /customers list — cache-first (Phase 24D local cache via listCustomersFromCache), falling back to a live Shopify customers() GraphQL query when cache empty or MOCK.
// CHANGE-GUARD: re-test all three paths (cache hit, MOCK, live Shopify); if cache returns 0 rows it MUST fall through to live, not show an empty list. Verify _fromCache/_syncedAt flags still set so the 'Sync now' button + sync badge render.
// INVARIANT(S): live query is sortKey:AMOUNT_SPENT reverse:true (descending lifetime spend) and capped at first:50 — pagination is cursor-based via filters.after; segment->Shopify query-string mapping (b2b->tag:b2b, sparklayer->tag:sparklayer*, has_orders->orders_count:>0) must match the MOCK in-memory filter semantics.
async function getCustomersData(filters) {
  // Phase 24D: try local cache first (populated by backfill); fall back to live Shopify
  if (!MOCK) {
    try {
      const stats = getCustomerCacheStats();
      if (stats && stats.total > 0) {
        const cached = listCustomersFromCache(filters);
        if (cached.length > 0) {
          return { customers: cached, hasNextPage: false, total: cached.length, _fromCache: true, _syncedAt: stats.latest };
        }
      }
    } catch (e) {
      console.error('cache read failed, falling back to live Shopify:', e.message);
    }
  }
  if (MOCK) {
    let customers = [...MOCK_CUSTOMERS];
    if (filters.segment === 'b2b')         customers = customers.filter(c => (c.tags||[]).includes('b2b'));
    if (filters.segment === 'sparklayer')  customers = customers.filter(c => (c.tags||[]).some(t => t.toLowerCase().startsWith('sparklayer')));
    if (filters.segment === 'has_orders')  customers = customers.filter(c => (c.numberOfOrders||0) > 0);
    if (filters.segment === 'no_orders')   customers = customers.filter(c => (c.numberOfOrders||0) === 0);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      customers = customers.filter(c =>
        c.displayName.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q)
      );
    }
    if (filters.tag) {
      customers = customers.filter(c => (c.tags||[]).includes(filters.tag));
    }
    // Sort: default = lifetime spend desc (Phase 20)
    const sort = filters.sort || 'lifetime_spend_desc';
    if (sort === 'lifetime_spend_desc') {
      customers.sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0));
    } else if (sort === 'name_asc') {
      customers.sort((a, b) => a.displayName.localeCompare(b.displayName));
    } else if (sort === 'orders_desc') {
      customers.sort((a, b) => (b.numberOfOrders || 0) - (a.numberOfOrders || 0));
    }
    return { customers, hasNextPage: false, total: customers.length };
  }
  try {
    const qParts = [];  // Phase 9: no default filter — show all customers
    if (filters.segment === 'b2b')        qParts.push('tag:b2b');
    if (filters.segment === 'sparklayer') qParts.push('tag:sparklayer*');
    if (filters.segment === 'has_orders') qParts.push('orders_count:>0');
    if (filters.segment === 'no_orders')  qParts.push('orders_count:0');
    if (filters.q) qParts.push(filters.q);
    if (filters.tag && !filters.segment)  qParts.push(`tag:${filters.tag}`);
    const result = await shopifyFetch(`
      query($q:String!,$first:Int!,$after:String){
        customers(first:$first,query:$q,after:$after,sortKey:AMOUNT_SPENT,reverse:true){
          edges{cursor node{
            id displayName email phone tags numberOfOrders
            amountSpent{amount currencyCode}
            defaultAddress{city province country}
            metafields(first:5,namespace:"b2b"){edges{node{key value}}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: qParts.join(' '), first: 50, after: filters.after || null });
    const edges = result.data?.customers?.edges || [];
    return {
      customers: edges.map(e => e.node),
      hasNextPage: result.data?.customers?.pageInfo?.hasNextPage || false,
      endCursor:   result.data?.customers?.pageInfo?.endCursor   || null,
      total:       edges.length,
    };
  } catch (err) {
    console.error('getCustomersData error:', err.message);
    return { customers: [], error: err.message, hasNextPage: false, total: 0 };
  }
}

// WHAT: Render a single customer tag as a colored chip; picks a CSS class from the tag's lowercased prefix (b2b, sparklayer*, b2b-admin, b2b-tier:gold, b2b-tier:*).
// CHANGE-GUARD: if you add a tier color, keep the gold check BEFORE the generic 'b2b-tier:' check (order matters — gold is a prefix of the generic match).
// INVARIANT(S): output is HTML-escaped via h(); linked variant builds /customers?tag=<encoded> — the tag value must be URL-encoded to survive special chars.
function tagChip(t, { linked = false } = {}) {
  const tl = (t || '').toLowerCase();
  let cls = 'tag-chip-default';
  if (tl === 'b2b') cls = 'tag-chip-b2b';
  else if (tl.startsWith('sparklayer')) cls = 'tag-chip-sparklayer';
  else if (tl === 'b2b-admin') cls = 'tag-chip-admin';
  else if (tl.startsWith('b2b-tier:gold')) cls = 'tag-chip-gold';
  else if (tl.startsWith('b2b-tier:')) cls = 'tag-chip-tier';
  if (linked) {
    return `<a href="/customers?tag=${encodeURIComponent(t)}" class="tag-chip ${cls}">${h(t)}</a>`;
  }
  return `<span class="tag-chip ${cls}">${h(t)}</span>`;
}

// WHAT: HTML for the /customers table — segment chips, search/tag/sort filter bar, rows with star badges for top-10-by-spend, and a 'Next 50' cursor link.
// CHANGE-GUARD: the ★ top-customer badge is index-based (idx < TOP_CUSTOMER_THRESHOLD) and ONLY valid when sort is lifetime_spend_desc — if you change the default sort or page size, the star logic silently mislabels. Re-test that 'Next 50' preserves q/segment/tag/sort params plus after cursor.
// INVARIANT(S): colspan=7 on the empty row must match the 7 <th> columns; pagination uses endCursor (opaque Shopify cursor), never an offset.
function renderCustomersList(session, data, filters) {
  const { customers, hasNextPage, endCursor, error } = data;

  // top-10 by spend get a star badge (Phase 20) — rank = index in list when sorted by spend
  const TOP_CUSTOMER_THRESHOLD = 10;
  const rows = customers.map((c, idx) => {
    const numId = shopifyNumericId(c.id);
    const dropship = c.metafields?.edges?.find(e => e.node.key === 'dropship_enabled')?.node?.value === 'true';
    const addr     = c.defaultAddress;
    const location = addr ? `${addr.city || ''}${addr.province ? ', '+addr.province : ''}` : '—';
    const visibleTags = (c.tags || []).slice(0, 3);
    const moreTags    = (c.tags || []).length - visibleTags.length;
    const tagBadges   = visibleTags.map(t => tagChip(t, { linked: true })).join('') + (moreTags > 0 ? `<span class="tag-chip tag-chip-more" title="${h((c.tags||[]).join(', '))}">+${moreTags}</span>` : '');
    const isTop = (filters.sort || 'lifetime_spend_desc') === 'lifetime_spend_desc' && idx < TOP_CUSTOMER_THRESHOLD;
    const starBadge = isTop ? `<span class="top-customer-star" title="Top customer by lifetime spend">★</span>` : '';
    return `<tr>
      <td><a href="/customers/${h(numId)}" class="link-strong">${h(c.displayName)}</a>${starBadge}<br><small>${h(c.email)}</small></td>
      <td class="text-muted">${h(location)}</td>
      <td><div class="tags-mini">${tagBadges}</div></td>
      <td class="text-right mono">${fmtMoney(c.amountSpent?.amount, c.amountSpent?.currencyCode)}</td>
      <td class="text-right"><a href="/orders?customer=${h(numId)}" class="link">${c.numberOfOrders || 0}</a></td>
      <td>${dropship ? '<span class="badge badge-dropship">Dropship</span>' : ''}</td>
      <td><a href="/customers/${h(numId)}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const emptyRow = customers.length === 0
    ? `<tr><td colspan="7" class="empty-state">No customers found</td></tr>`
    : '';

  const currentParams = new URLSearchParams();
  if (filters.q)       currentParams.set('q', filters.q);
  if (filters.segment) currentParams.set('segment', filters.segment);
  if (filters.tag)     currentParams.set('tag', filters.tag);
  if (filters.sort)    currentParams.set('sort', filters.sort);
  const nextParams = new URLSearchParams(currentParams);
  if (endCursor) nextParams.set('after', endCursor);

  const segmentChips = [
    { value: '',           label: 'All' },
    { value: 'b2b',        label: 'B2B-tagged' },
    { value: 'sparklayer', label: 'SparkLayer' },
    { value: 'has_orders', label: 'Has orders' },
    { value: 'no_orders',  label: 'No orders' },
  ].map(c => {
    const p = new URLSearchParams(currentParams);
    if (c.value) p.set('segment', c.value); else p.delete('segment');
    p.delete('after');
    const active = (filters.segment || '') === c.value;
    return `<a href="/customers?${p}" class="filter-chip${active ? ' filter-chip-active' : ''}">${h(c.label)}</a>`;
  }).join('');

  const sortOptions = [
    { value: 'lifetime_spend_desc', label: 'Lifetime spend ↓' },
    { value: 'orders_desc',         label: 'Order count ↓' },
    { value: 'name_asc',            label: 'Name A–Z' },
  ];
  const currentSort = filters.sort || 'lifetime_spend_desc';

  return layout({ title: 'Customers', session, activePath: '/customers', content: `
    <div class="page-header-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <h1>Customers ${fmtSyncBadge(data._syncedAt)}</h1>
      ${data._fromCache ? '<button type="button" class="btn btn-ghost btn-sm" onclick="syncCacheNow(this)" title="Refresh cache from Shopify">\u{1F504} Sync now</button>' : ''}
    </div>
    ${error ? `<div class="alert alert-warning">Shopify unavailable: ${h(error)}</div>` : ''}
    <div class="filter-chips">${segmentChips}</div>
    <form class="filter-bar" method="GET" action="/customers">
      ${filters.segment ? `<input type="hidden" name="segment" value="${h(filters.segment)}">` : ''}
      <input type="search" name="q" value="${h(filters.q||'')}" placeholder="Name, email, phone…" class="filter-input search-input">
      <select name="tag" class="filter-select">
        <option value="">All tags</option>
        <option value="b2b-tier:gold"   ${filters.tag==='b2b-tier:gold'?'selected':''}>Gold tier</option>
        <option value="b2b-tier:silver" ${filters.tag==='b2b-tier:silver'?'selected':''}>Silver tier</option>
        <option value="b2b-dropship"    ${filters.tag==='b2b-dropship'?'selected':''}>Dropship</option>
      </select>
      <select name="sort" class="filter-select" onchange="this.form.submit()">
        ${sortOptions.map(o => `<option value="${h(o.value)}"${currentSort===o.value?' selected':''}>${h(o.label)}</option>`).join('')}
      </select>
      <button type="submit" class="btn btn-secondary">Filter</button>
      <a href="/customers" class="btn btn-ghost">Clear</a>
    </form>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Customer</th><th>Location</th><th>Tags</th>
          <th class="text-right">Lifetime Spend</th><th class="text-right">Orders</th>
          <th>Dropship</th><th></th>
        </tr></thead>
        <tbody>${rows}${emptyRow}</tbody>
      </table>
    </div>
    <div class="pagination">
      <span class="text-muted">${customers.length} customer${customers.length !== 1 ? 's' : ''}</span>
      ${hasNextPage ? `<a href="/customers?${nextParams}" class="btn btn-ghost">Next 50 →</a>` : ''}
    </div>
  ` });
}

// ── Customer detail ───────────────────────────────────────────────────────────
// WHAT: Fetch one customer by numeric id (converted to gid via shopifyCustomerGid) — core fields plus addresses and the b2b-namespace metafields used by the settings card.
// CHANGE-GUARD: metafields are fetched first:20 namespace:'b2b' — if a new per-customer setting key is added beyond 20, it won't be returned. On error returns null, which callers must treat as 404.
// INVARIANT(S): numericId is the bare Shopify numeric id (no gid prefix); the gid round-trip must stay consistent with shopifyNumericId used elsewhere.
async function getCustomerDetail(numericId) {
  if (MOCK) {
    const gid = shopifyCustomerGid(numericId);
    return MOCK_CUSTOMERS.find(c => c.id === gid) || null;
  }
  try {
    const result = await shopifyFetch(`
      query($id:ID!){ customer(id:$id){
        id email displayName phone tags numberOfOrders
        amountSpent{amount currencyCode}
        addresses(first:5){id firstName lastName address1 city province zip country}
        defaultAddress{id firstName lastName address1 address2 city province provinceCode zip country phone}
        metafields(first:20,namespace:"b2b"){edges{node{id namespace key value type}}}
      }}`, { id: shopifyCustomerGid(numericId) });
    return result.data?.customer || null;
  } catch (err) {
    console.error('getCustomerDetail error:', err.message);
    return null;
  }
}

// WHAT: Last 10 orders for a customer — cache-first (getCustomerOrdersFromCache, mapped into the Shopify-shaped object the renderer expects), else live orders(query:customer_id:...).
// CHANGE-GUARD: the cache->Shopify-shape mapping must keep totalPriceSet.presentmentMoney.amount as a STRING and lineItems.edges as [] (renderer assumes these); a live failure swallows to [] (empty, not error).
// INVARIANT(S): always sliced to 10, sortKey:PROCESSED_AT reverse:true (newest first); cache rows are NOT re-sorted here — they rely on getCustomerOrdersFromCache ordering.
async function getCustomerRecentOrders(customerId) {
  // Phase 24D: cache first
  if (!MOCK) {
    try {
      const stats = getOrdersCacheStats();
      if (stats && stats.total > 0) {
        const cached = getCustomerOrdersFromCache(customerId);
        return cached.slice(0, 10).map(o => ({
          id: o.gid,
          name: o.name,
          processedAt: new Date(o.processed_at || o.created_at).toISOString(),
          displayFinancialStatus: o.financial_status || o.display_financial_status,
          displayFulfillmentStatus: o.fulfillment_status || o.display_fulfillment_status,
          totalPriceSet: { presentmentMoney: { amount: String(o.total_price || 0), currencyCode: o.currency || 'USD' } },
          lineItems: { edges: [] },
          _fromCache: true,
        }));
      }
    } catch (e) {
      console.error('recent orders cache failed, falling back to live:', e.message);
    }
  }
  if (MOCK) {
    const gid = shopifyCustomerGid(customerId);
    return MOCK_ORDERS.filter(o => o.customer?.id === gid).slice(0, 10);
  }
  try {
    const result = await shopifyFetch(`
      query($q:String!){ orders(first:10,query:$q,sortKey:PROCESSED_AT,reverse:true){
        edges{node{id name processedAt displayFinancialStatus displayFulfillmentStatus
          totalPriceSet{presentmentMoney{amount currencyCode}}
        }}}}`,
      { q: `customer_id:${customerId}` });
    return result.data?.orders?.edges?.map(e => e.node) || [];
  } catch { return []; }
}

// Phase 10: 4 per-customer fields — discount_pct, dropship_enabled, dropship_margin_pct, allow_order_on_invoice
// min_order_usd and payment_terms are GLOBAL settings only (not per-customer).
// WHAT: Resolve effective B2B per-customer config = defaults (global b2b_discount_pct setting + hardcoded fallbacks) overlaid with this customer's b2b-namespace metafields (discount_pct, dropship_enabled, dropship_margin_pct, allow_order_on_invoice, catalog_access_tags). Returns {effective, overrides, defaults}.
// CHANGE-GUARD: only THESE 4 (+catalog tags) are per-customer; min_order_usd and payment_terms are GLOBAL-only (see comment above) — do not add them here. boolean parse: allow_order_on_invoice defaults true (aoiStr !== 'false'); dropship_enabled defaults via (deStr === 'true').
// INVARIANT(S): overrides==null means 'inherit default' and the UI shows 'default applied'; effective = override ?? default. MOCK path layers mockB2bConfigOverrides over metafields and treats null entries as deletions — keep MOCK and live override semantics identical or the settings card lies.
async function getB2bConfig(numericId) {
  const defaults = {
    discount_pct:            parseInt(getSetting('b2b_discount_pct') ?? '50', 10),
    dropship_enabled:        false,
    dropship_margin_pct:     30,
    allow_order_on_invoice:  true,
    catalog_access_tags:     null,
  };

  if (MOCK) {
    const inMemory = mockB2bConfigOverrides.get(numericId) || {};
    const gid = shopifyCustomerGid(numericId);
    const cust = MOCK_CUSTOMERS.find(c => c.id === gid);
    const mfs  = cust?.metafields?.edges?.map(e => e.node) || [];
    const fromMf = {};
    const dpStr   = mfs.find(m => m.key === 'discount_pct')?.value;
    const deStr   = mfs.find(m => m.key === 'dropship_enabled')?.value;
    const dmStr   = mfs.find(m => m.key === 'dropship_margin_pct')?.value;
    const aoiStr  = mfs.find(m => m.key === 'allow_order_on_invoice')?.value;
    const catStr  = mfs.find(m => m.key === 'catalog_access_tags')?.value;
    if (dpStr  !== undefined) fromMf.discount_pct           = parseInt(dpStr, 10);
    if (deStr  !== undefined) fromMf.dropship_enabled       = deStr === 'true';
    if (dmStr  !== undefined) fromMf.dropship_margin_pct    = parseInt(dmStr, 10);
    if (aoiStr !== undefined) fromMf.allow_order_on_invoice = aoiStr !== 'false';
    if (catStr !== undefined) fromMf.catalog_access_tags    = catStr || null;

    const overrides = { ...fromMf, ...inMemory };
    for (const k of Object.keys(inMemory)) {
      if (inMemory[k] === null) delete overrides[k];
    }
    return {
      effective: {
        discount_pct:            overrides.discount_pct           ?? defaults.discount_pct,
        dropship_enabled:        overrides.dropship_enabled       ?? defaults.dropship_enabled,
        dropship_margin_pct:     overrides.dropship_margin_pct    ?? defaults.dropship_margin_pct,
        allow_order_on_invoice:  overrides.allow_order_on_invoice ?? defaults.allow_order_on_invoice,
        catalog_access_tags:     overrides.catalog_access_tags    ?? null,
      },
      overrides: {
        discount_pct:            overrides.discount_pct           ?? null,
        dropship_enabled:        overrides.dropship_enabled       ?? null,
        dropship_margin_pct:     overrides.dropship_margin_pct    ?? null,
        allow_order_on_invoice:  overrides.allow_order_on_invoice ?? null,
        catalog_access_tags:     overrides.catalog_access_tags    ?? null,
      },
      defaults,
    };
  }

  try {
    const result = await shopifyFetch(`
      query($id:ID!){customer(id:$id){
        metafields(first:20,namespace:"b2b"){edges{node{id key value type}}}
      }}`, { id: shopifyCustomerGid(numericId) });
    const mfs = result.data?.customer?.metafields?.edges?.map(e => e.node) || [];
    const getVal = k => mfs.find(m => m.key === k)?.value ?? null;
    const dpStr  = getVal('discount_pct');
    const deStr  = getVal('dropship_enabled');
    const dmStr  = getVal('dropship_margin_pct');
    const aoiStr = getVal('allow_order_on_invoice');
    const catStr = getVal('catalog_access_tags');
    const overrides = {
      discount_pct:            dpStr  !== null ? parseInt(dpStr, 10)   : null,
      dropship_enabled:        deStr  !== null ? deStr === 'true'       : null,
      dropship_margin_pct:     dmStr  !== null ? parseInt(dmStr, 10)   : null,
      allow_order_on_invoice:  aoiStr !== null ? aoiStr !== 'false'    : null,
      catalog_access_tags:     catStr || null,
    };
    return {
      effective: {
        discount_pct:            overrides.discount_pct           ?? defaults.discount_pct,
        dropship_enabled:        overrides.dropship_enabled       ?? defaults.dropship_enabled,
        dropship_margin_pct:     overrides.dropship_margin_pct    ?? defaults.dropship_margin_pct,
        allow_order_on_invoice:  overrides.allow_order_on_invoice ?? defaults.allow_order_on_invoice,
        catalog_access_tags:     overrides.catalog_access_tags    ?? null,
      },
      overrides,
      defaults,
    };
  } catch (err) {
    console.error('getB2bConfig error:', err.message);
    return {
      effective: defaults,
      overrides: { discount_pct: null, dropship_enabled: null, dropship_margin_pct: null, allow_order_on_invoice: null, catalog_access_tags: null },
      defaults,
    };
  }
}

// WHAT: Persist B2B per-customer settings — sets non-empty fields via metafieldsSet and DELETES fields whose value is null/'' via metafieldsDelete (a blank submit = reset to default).
// CHANGE-GUARD: empty string '' is treated as a delete/reset, NOT as a stored empty value — re-test the per-field 'Reset'/'Clear' submit buttons (they POST name=field value=''). boolean coercion accepts true/'true'/'on'; integers go through parseInt — verify discount_pct stays within the 0-95 UI bound (server does NOT re-validate the range).
// INVARIANT(S): metafieldsSet and metafieldsDelete are TWO separate mutations — a set+delete in one save is non-atomic; userErrors from either are not surfaced to the caller (swallowed).
async function applyB2bConfigUpdate(numericId, body) {
  // SECURITY: clamp percent fields server-side (0–95). The UI's min/max is not authoritative — a direct
  // POST could otherwise persist e.g. discount_pct=999. undefined (absent) / null / '' semantics preserved.
  const _clampPct = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(95, Math.max(0, n)) : v; };
  const discount_pct        = (body.discount_pct == null || body.discount_pct === '') ? body.discount_pct : _clampPct(body.discount_pct);
  const dropship_margin_pct = (body.dropship_margin_pct == null || body.dropship_margin_pct === '') ? body.dropship_margin_pct : _clampPct(body.dropship_margin_pct);
  const { dropship_enabled, allow_order_on_invoice, catalog_access_tags } = body;
  const gid = shopifyCustomerGid(numericId);
  if (MOCK) {
    const cur = { ...(mockB2bConfigOverrides.get(numericId) || {}) };
    if (discount_pct !== undefined)
      cur.discount_pct = (discount_pct === null || discount_pct === '') ? null : parseInt(discount_pct, 10);
    if (dropship_enabled !== undefined)
      cur.dropship_enabled = (dropship_enabled === null || dropship_enabled === '') ? null : (dropship_enabled === true || dropship_enabled === 'true' || dropship_enabled === 'on');
    if (dropship_margin_pct !== undefined)
      cur.dropship_margin_pct = (dropship_margin_pct === null || dropship_margin_pct === '') ? null : parseInt(dropship_margin_pct, 10);
    if (allow_order_on_invoice !== undefined)
      cur.allow_order_on_invoice = (allow_order_on_invoice === null || allow_order_on_invoice === '') ? null : (allow_order_on_invoice === true || allow_order_on_invoice === 'true' || allow_order_on_invoice === 'on');
    if (catalog_access_tags !== undefined)
      cur.catalog_access_tags = (catalog_access_tags === null || catalog_access_tags === '') ? null : String(catalog_access_tags).trim();
    mockB2bConfigOverrides.set(numericId, cur);
    return;
  }

  const sets    = [];
  const delKeys = [];
  const fieldDefs = [
    { key: 'discount_pct',           val: discount_pct,           type: 'number_integer' },
    { key: 'dropship_enabled',       val: dropship_enabled,       type: 'boolean' },
    { key: 'dropship_margin_pct',    val: dropship_margin_pct,    type: 'number_integer' },
    { key: 'allow_order_on_invoice', val: allow_order_on_invoice, type: 'boolean' },
    { key: 'catalog_access_tags',    val: catalog_access_tags,    type: 'single_line_text_field' },
  ];
  for (const f of fieldDefs) {
    if (f.val === undefined) continue;
    if (f.val === null || f.val === '') {
      delKeys.push(f.key);
    } else if (f.type === 'boolean') {
      const bval = f.val === true || f.val === 'true' || f.val === 'on';
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: String(bval), type: 'boolean' });
    } else if (f.type === 'single_line_text_field') {
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: String(f.val).trim(), type: 'single_line_text_field' });
    } else {
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: String(parseInt(f.val, 10)), type: 'number_integer' });
    }
  }
  if (sets.length) {
    await shopifyFetch(`mutation metafieldsSet($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{field message} } }`, { m: sets });
  }
  if (delKeys.length) {
    const delInputs = delKeys.map(k => ({ ownerId: gid, namespace: 'b2b', key: k }));
    await shopifyFetch(`mutation metafieldsDelete($m:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$m){ deletedMetafieldIds userErrors{field message} } }`, { m: delInputs });
  }
}

// WHAT: Full customer detail page — impersonation modal+history, spend section (AJAX to /api/admin/customers/:id/spend), recent orders, portal activity timeline, internal notes, B2B settings form, tags, active cart, and Xero status cards.
// CHANGE-GUARD: many cards are client-fetched (spend, activity, active-cart, xero-status) against /api/admin/customers/${numId}/* — if those route paths change, edit the inline fetch URLs here too. The impersonate flow POSTs {read_only} and window.open's the returned one-time URL. _dropshipCache param is unused (legacy).
// INVARIANT(S): numId derives from shopifyNumericId(customer.id) and is interpolated into MANY inline-script URLs — it must be a clean numeric string (no gid). Outstanding-balance badge is best-effort (try/catch -> {total:0}). impHistory 'Used?' badge logic depends on ev.expiresAt vs Date.now() — keep ms units.
function renderCustomerDetail(session, customer, recentOrders, notes, _dropshipCache, b2bConfig, flash, impHistory = []) {
  const numId      = shopifyNumericId(customer.id);
  const outstanding = (() => { try { return getOutstandingBalanceForCustomer(customer.id); } catch(e) { return { total: 0, count: 0 }; } })();

  // Phase 22H: Impersonation history card
  const impHistoryHtml = (impHistory && impHistory.length > 0)
    ? `<table class="mini-table"><thead><tr><th>When</th><th>Admin</th><th class="text-center">Mode</th><th class="text-center">Used?</th></tr></thead><tbody>
        ${impHistory.map(ev => `<tr>
          <td><small>${fmtDate(new Date(ev.createdAt).toISOString())}</small></td>
          <td><small>${h(ev.adminEmail)}</small></td>
          <td class="text-center"><span class="badge ${ev.readOnly ? 'badge-secondary' : 'badge-warning'}">${ev.readOnly ? 'Read-only' : 'Full'}</span></td>
          <td class="text-center">${ev.usedAt ? `<span class="badge badge-success">Yes</span>` : (ev.expiresAt < Date.now() ? `<span class="text-muted">Expired</span>` : `<span class="text-muted">Pending</span>`)}</td>
        </tr>`).join('')}
      </tbody></table>`
    : '<p class="empty-state">No impersonation events yet.</p>';

  const flashHtml = flash === 'notes_saved'
    ? `<div class="alert alert-success">Notes saved.</div>`
    : flash === 'dropship_saved' || flash === 'b2b_settings_saved'
    ? `<div class="alert alert-success">B2B customer settings saved.</div>`
    : flash === 'b2b_config_saved'
    ? `<div class="alert alert-success">B2B customer settings saved.</div>`
    : flash === 'tags_added'
    ? `<div class="alert alert-success">Tags updated.</div>`
    : '';

  const recentOrdersHtml = recentOrders.length > 0
    ? `<table class="mini-table"><thead><tr><th>Order</th><th>Date</th><th class="text-right">Amount</th><th>Status</th></tr></thead><tbody>
        ${recentOrders.map(o => `<tr>
          <td><a href="/orders/${shopifyNumericId(o.id)}">${h(o.name)}</a></td>
          <td class="text-muted">${fmtDate(o.processedAt)}</td>
          <td class="text-right mono">${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount)}</td>
          <td><span class="badge badge-${h((o.displayFinancialStatus||'').toLowerCase())}">${h(o.displayFinancialStatus)}</span></td>
        </tr>`).join('')}
      </tbody></table>`
    : '<p class="text-muted small-text">No orders yet</p>';

  const addr = customer.defaultAddress;
  const addrHtml = addr
    ? `${h(addr.firstName||'')} ${h(addr.lastName||'')}<br>
       ${h(addr.address1||'')}${addr.address2?'<br>'+h(addr.address2):''}<br>
       ${h(addr.city||'')}, ${h(addr.province||'')} ${h(addr.zip||'')}<br>${h(addr.country||'')}`
    : '<span class="text-muted">No address on file</span>';

  // Date range presets for spend section
  const now    = new Date();
  const ymd    = d => d.toISOString().split('T')[0];
  const daysAgo = n => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
  const spendPresets = [
    { label: 'Last 7 days',    from: ymd(daysAgo(7)),   to: ymd(now) },
    { label: 'Last 30 days',   from: ymd(daysAgo(30)),  to: ymd(now) },
    { label: 'Last 90 days',   from: ymd(daysAgo(90)),  to: ymd(now) },
    { label: 'Last 12 months', from: ymd(daysAgo(365)), to: ymd(now) },
    { label: 'Year to date',   from: `${now.getFullYear()}-01-01`, to: ymd(now) },
    { label: 'All time',       from: '2000-01-01', to: ymd(now) },
  ];

  return layout({ title: customer.displayName || 'Customer', session, activePath: '/customers',
    extraHead: `<style>
      .spend-header{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;}
      .spend-lifetime{font-size:1.5rem;font-weight:700;color:#000;}
      .spend-count{color:#666;font-size:0.9rem;}
      .spend-range-bar{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;}
      .spend-range-totals{display:flex;gap:2rem;margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:#f8f9fa;border-radius:6px;}
      .spend-range-stat{display:flex;flex-direction:column;}
      .spend-range-val{font-size:1.1rem;font-weight:700;}
      .spend-range-lbl{font-size:0.78rem;color:#666;}
      #spend-orders-body tr.voided{opacity:0.5;text-decoration:line-through;}
    </style>`,
    content: `
    <div class="breadcrumb-row"><a href="/customers" class="breadcrumb">← Customers</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(customer.displayName)}</h1>
        <p class="text-muted">${h(customer.email)}${customer.phone ? ' · ' + h(customer.phone) : ''}</p>
      </div>
      <div class="detail-header-actions">
        <a href="/customers/${h(numId)}/activity" class="btn btn-ghost btn-sm" title="View portal activity log">Activity log</a>
        <button class="btn btn-secondary" id="impersonate-btn" type="button" title="Open the B2B portal as this customer">View in Portal</button>
        <a href="/orders/new?customer=${h(numId)}" class="btn btn-primary">+ New Order</a>
      </div>
    </div>

    <!-- Impersonation modal -->
    <div id="impersonate-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:10px;padding:1.5rem;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.18)">
        <h2 style="margin:0 0 0.5rem">View portal as customer</h2>
        <p style="color:#555;margin:0 0 1rem">Open the B2B portal as <strong>${h(customer.displayName)}</strong> (${h(customer.email)}). This generates a one-time link valid for 1 hour.</p>
        <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;cursor:pointer">
          <input type="checkbox" id="impersonate-readonly" checked style="width:16px;height:16px">
          <span>Read-only mode <span style="color:#888;font-size:0.85em">(prevents placing orders or modifying cart)</span></span>
        </label>
        <div id="impersonate-error" style="display:none;color:#b00;margin-bottom:0.75rem;font-size:0.9em"></div>
        <div style="display:flex;gap:0.75rem;justify-content:flex-end">
          <button class="btn btn-ghost" id="impersonate-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="impersonate-open" type="button">Open Portal →</button>
        </div>
      </div>
    </div>
    <script>
    (function(){
      var modal = document.getElementById('impersonate-modal');
      var openBtn = document.getElementById('impersonate-btn');
      var cancelBtn = document.getElementById('impersonate-cancel');
      var doOpenBtn = document.getElementById('impersonate-open');
      var roCheck = document.getElementById('impersonate-readonly');
      var errEl = document.getElementById('impersonate-error');
      openBtn.addEventListener('click', function(){ modal.style.display = 'flex'; errEl.style.display = 'none'; });
      cancelBtn.addEventListener('click', function(){ modal.style.display = 'none'; });
      modal.addEventListener('click', function(e){ if(e.target === modal) modal.style.display = 'none'; });
      document.addEventListener('keydown', function(e){ if(e.key === 'Escape') modal.style.display = 'none'; });
      doOpenBtn.addEventListener('click', function(){
        doOpenBtn.disabled = true;
        doOpenBtn.textContent = 'Opening…';
        errEl.style.display = 'none';
        fetch('/api/admin/customers/${h(numId)}/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read_only: roCheck.checked })
        })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(!d.ok){ errEl.textContent = d.error || 'Error'; errEl.style.display = ''; doOpenBtn.disabled = false; doOpenBtn.textContent = 'Open Portal →'; return; }
          window.open(d.url, '_blank');
          modal.style.display = 'none';
          doOpenBtn.disabled = false;
          doOpenBtn.textContent = 'Open Portal →';
        })
        .catch(function(e){ errEl.textContent = e.message; errEl.style.display = ''; doOpenBtn.disabled = false; doOpenBtn.textContent = 'Open Portal →'; });
      });
    })();
    </script>
    <div class="detail-grid">
      <div class="detail-main">

        <!-- Phase 19A: Spend section -->
        <div class="card" id="spend-card">
          <div class="card-header"><h2>Spend</h2></div>
          <div class="spend-header">
            <span class="spend-lifetime">${fmtMoney(customer.amountSpent?.amount, customer.amountSpent?.currencyCode)}</span>
            <span class="spend-count">lifetime · ${customer.numberOfOrders || 0} orders</span>
          </div>
          <div class="spend-range-bar">
            <label for="spend-preset" style="font-size:0.85rem;color:#555">Show spend for:</label>
            <select id="spend-preset" class="input input-sm" style="width:auto">
              ${spendPresets.map((p, i) => `<option value="${h(p.from)}|${h(p.to)}"${i === 1 ? ' selected' : ''}>${h(p.label)}</option>`).join('')}
              <option value="custom">Custom range…</option>
            </select>
            <span id="spend-custom-row" style="display:none;gap:0.35rem;align-items:center">
              <input type="date" id="spend-from" class="input input-sm">
              <span>to</span>
              <input type="date" id="spend-to" class="input input-sm">
              <button id="spend-custom-go" class="btn btn-secondary btn-sm">Go</button>
            </span>
          </div>
          <div id="spend-range-totals" class="spend-range-totals">
            <div class="spend-range-stat"><span class="spend-range-val" id="spend-range-total">—</span><span class="spend-range-lbl">in range</span></div>
            <div class="spend-range-stat"><span class="spend-range-val" id="spend-range-count">—</span><span class="spend-range-lbl">orders</span></div>
          </div>
          <div id="spend-orders-wrap">
            <table class="mini-table" id="spend-orders-table" style="display:none">
              <thead><tr><th>Order</th><th>Date</th><th class="text-right">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody id="spend-orders-body"></tbody>
            </table>
            <p id="spend-empty" class="text-muted small-text" style="display:none">No orders in this date range.</p>
            <p id="spend-loading" class="text-muted small-text">Loading…</p>
          </div>
        </div>
        <script>
        (function(){
          var custId = ${JSON.stringify(numId)};
          var preset = document.getElementById('spend-preset');
          var customRow = document.getElementById('spend-custom-row');
          var fromIn = document.getElementById('spend-from');
          var toIn   = document.getElementById('spend-to');
          var goBtn  = document.getElementById('spend-custom-go');
          function fmtMoney(n){ return '$' + parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
          function fmtDate(s){ return new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
          function loadSpend(from, to){
            document.getElementById('spend-loading').style.display='';
            document.getElementById('spend-orders-table').style.display='none';
            document.getElementById('spend-empty').style.display='none';
            fetch('/api/admin/customers/' + custId + '/spend?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))
              .then(r=>r.json()).then(function(d){
                document.getElementById('spend-loading').style.display='none';
                document.getElementById('spend-range-total').textContent = fmtMoney(d.rangeTotal || 0);
                document.getElementById('spend-range-count').textContent = d.rangeCount || 0;
                var tbody = document.getElementById('spend-orders-body');
                tbody.innerHTML = '';
                if (d.orders && d.orders.length > 0) {
                  d.orders.forEach(function(o){
                    var tr = document.createElement('tr');
                    tr.innerHTML =
                      '<td><a href="/orders/' + o.id + '">' + o.name + '</a></td>' +
                      '<td class="text-muted">' + fmtDate(o.processedAt) + '</td>' +
                      '<td class="text-right mono">' + fmtMoney(o.total) + '</td>' +
                      '<td><span class="badge badge-' + (o.financialStatus||'').toLowerCase() + '">' + (o.financialStatus||'—') + '</span></td>' +
                      '<td><a href="/orders/' + o.id + '/invoice" class="link text-muted small-text">invoice</a></td>';
                    tbody.appendChild(tr);
                  });
                  document.getElementById('spend-orders-table').style.display='';
                } else {
                  document.getElementById('spend-empty').style.display='';
                }
              }).catch(function(){ document.getElementById('spend-loading').textContent='Error loading spend data.'; });
          }
          function applyPreset(){
            var v = preset.value;
            if(v==='custom'){ customRow.style.display='flex'; return; }
            customRow.style.display='none';
            var parts = v.split('|');
            loadSpend(parts[0], parts[1]);
          }
          preset.addEventListener('change', applyPreset);
          goBtn && goBtn.addEventListener('click', function(){
            if(fromIn.value && toIn.value) loadSpend(fromIn.value, toIn.value);
          });
          applyPreset();
        })();
        </script>

        <div class="card">
          <div class="card-header">
            <h2>Recent Orders</h2>
            <a href="/orders?q=${h(customer.email)}" class="widget-link">All orders →</a>
          </div>
          ${recentOrdersHtml}
        </div>
        <div class="card">
          <div class="card-header"><h2>Impersonation History</h2><span class="text-muted small-text" style="font-size:11px">last 10</span></div>
          ${impHistoryHtml}
        </div>

        <!-- Task 43: Portal Activity Timeline -->
        <div class="card" id="activity-card">
          <div class="card-header" style="cursor:pointer" onclick="loadActivity()">
            <h2>Portal Activity</h2>
            <span id="activity-header-action" class="btn btn-ghost btn-sm" style="pointer-events:none">Load</span>
          </div>
          <div id="activity-body">
            <p class="text-muted small-text" style="padding:0.75rem 0">Click to load recent portal activity for this customer.</p>
          </div>
        </div>
        <script>
        (function(){
          var custId = ${JSON.stringify(numId)};
          var loaded = false;
          window.loadActivity = function() {
            if (loaded) return;
            loaded = true;
            var body = document.getElementById('activity-body');
            var hdr  = document.getElementById('activity-header-action');
            if (hdr) hdr.textContent = 'Loading…';
            body.innerHTML = '<p class="text-muted small-text">Loading…</p>';
            fetch('/api/admin/customers/' + custId + '/activity?limit=20')
              .then(function(r){ return r.json(); })
              .then(function(d){
                if (hdr) { hdr.textContent = d.total + ' events'; }
                if (!d.rows || !d.rows.length) {
                  body.innerHTML = '<p class="text-muted small-text" style="padding:0.5rem 0">No activity yet.</p>';
                  return;
                }
                var EVENT_ICONS = { page_view: '👁', cart: '🛒', order: '📦', auth: '🔑', search: '🔍', activity: '📊' };
                function relTime(ts) {
                  var diff = Date.now() - ts;
                  if (diff < 60000) return 'just now';
                  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
                  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
                  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                // SECURITY: activity fields (path, user-agent, event type) are customer-controlled and
                // go into innerHTML — escape every one. Without esc(), a browsed path / UA header of
                // "<img src=x onerror=...>" would run in the admin session.
                function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;'); }
                var rows = d.rows.map(function(r) {
                  var icon = EVENT_ICONS[r.eventType] || '•';
                  var label = esc(r.eventSubtype ? r.eventType + ':' + r.eventSubtype : r.eventType);
                  var path = r.path ? '<span style="color:#888;font-size:11px;margin-left:6px">' + esc(r.path.slice(0,60)) + '</span>' : '';
                  var ua = '';
                  if (r.eventData) { try { var ed = JSON.parse(r.eventData); if(ed.ua) ua = '<span style="color:#aaa;font-size:10px;margin-left:6px">' + esc(ed.ua.slice(0,40)) + '…</span>'; } catch(e){} }
                  return '<tr>' +
                    '<td style="font-size:16px;line-height:1;padding-right:8px">' + icon + '</td>' +
                    '<td style="font-size:13px">' + label + path + ua + '</td>' +
                    '<td style="font-size:12px;color:#888;white-space:nowrap;text-align:right">' + relTime(r.ts) + '</td>' +
                  '</tr>';
                }).join('');
                body.innerHTML = '<table style="width:100%;border-collapse:collapse">' +
                  '<thead><tr style="border-bottom:1px solid #eee"><th style="width:32px"></th><th style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#888;padding:0 0 6px">Event</th><th style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#888;padding:0 0 6px;text-align:right">When</th></tr></thead>' +
                  '<tbody>' + rows + '</tbody></table>' +
                  (d.total > 20 ? '<div style="margin-top:8px;text-align:right"><a href="/customers/' + custId + '/activity" class="link text-muted small-text">See all ' + d.total + ' events →</a></div>' : '');
              })
              .catch(function(e) {
                body.innerHTML = '<p style="color:#c00;padding:0.5rem 0">Error loading activity: ' + e.message + '</p>';
                if (hdr) hdr.textContent = 'Error';
              });
          };
        })();
        </script>

        <div class="card">
          <div class="card-header"><h2>Internal Notes</h2></div>
          <form method="POST" action="/customers/${h(numId)}/notes">
            <textarea name="body" class="textarea" rows="4" placeholder="Internal notes about this customer (not shown to them)…">${h(notes?.body||'')}</textarea>
            ${notes?.updated_at ? `<p class="text-muted small-text" style="margin-top:0.25rem">Last updated ${fmtDate(new Date(notes.updated_at).toISOString())} by ${h(notes.updated_by)}</p>` : ''}
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save Notes</button></div>
          </form>
        </div>
        <div class="card" id="b2b-settings-card">
          <div class="card-header">
            <h2>B2B Customer Settings</h2>
            ${outstanding.count > 0 ? `<span class="badge badge-warning" title="${outstanding.count} unpaid order(s)">Outstanding: $$${outstanding.total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>` : ''}
          </div>
          <form method="POST" action="/customers/${h(numId)}/b2b-config" id="b2b-settings-form">
            <div class="b2b-settings-grid">
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Discount %</div>
                  <div class="b2b-field-help">What percent off MSRP this customer pays. Default ${h(String(b2bConfig.defaults.discount_pct))}% comes from store settings.</div>
                </div>
                <div class="b2b-field-control">
                  <input type="number" name="discount_pct" id="discount_pct"
                    value="${b2bConfig.overrides.discount_pct !== null ? h(String(b2bConfig.overrides.discount_pct)) : ''}"
                    min="0" max="95" step="1" class="input input-sm" style="width:80px"
                    placeholder="${h(String(b2bConfig.defaults.discount_pct))}">
                  <span class="badge ${b2bConfig.overrides.discount_pct !== null ? 'badge-warning' : 'badge-muted'}">
                    ${b2bConfig.overrides.discount_pct !== null ? 'override: ' + h(String(b2bConfig.effective.discount_pct)) + '%' : 'default applied'}
                  </span>
                  ${b2bConfig.overrides.discount_pct !== null ? `<button type="submit" name="discount_pct" value="" class="btn btn-ghost btn-xs">Reset</button>` : ''}
                </div>
              </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Drop-ship allowed</div>
                  <div class="b2b-field-help">If on, this customer can ship orders directly to their end customer. Useful for resellers who don't carry inventory.</div>
                </div>
                <div class="b2b-field-control">
                  <label class="toggle-label">
                    <input type="checkbox" name="dropship_enabled" id="dropship_enabled" class="toggle"
                      ${b2bConfig.effective.dropship_enabled ? 'checked' : ''}
                      onchange="document.getElementById('dropship_margin_pct').disabled=!this.checked">
                  </label>
                </div>
              </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Drop-ship discount %</div>
                  <div class="b2b-field-help">Discount on drop-ship orders only (separate from standard discount). Typical 25–35%.</div>
                </div>
                <div class="b2b-field-control">
                  <input type="number" name="dropship_margin_pct" id="dropship_margin_pct"
                    value="${h(String(b2bConfig.effective.dropship_margin_pct ?? 30))}"
                    min="0" max="95" step="1" class="input input-sm" style="width:80px"
                    ${!b2bConfig.effective.dropship_enabled ? 'disabled' : ''}>
                </div>
              </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Allow order on invoice</div>
                  <div class="b2b-field-help">If on, customer can place orders without upfront payment — we invoice them. If off, must pay at checkout.</div>
                </div>
                <div class="b2b-field-control">
                  <label class="toggle-label">
                    <input type="checkbox" name="allow_order_on_invoice" id="allow_order_on_invoice" class="toggle"
                      ${b2bConfig.effective.allow_order_on_invoice !== false ? 'checked' : ''}>
                  </label>
                </div>
              </div>
            </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Custom catalog tags</div>
                  <div class="b2b-field-help">Comma-separated private product tags this customer can access (e.g. <code>private-acme,deerskin-trade</code>). Products with these tags are hidden from customers who don't have them listed here.</div>
                </div>
                <div class="b2b-field-control">
                  <input type="text" name="catalog_access_tags" id="catalog_access_tags"
                    value="${h(b2bConfig.effective.catalog_access_tags || '')}"
                    class="input input-sm" style="width:240px"
                    placeholder="e.g. private-acme,deerskin-trade">
                  ${b2bConfig.effective.catalog_access_tags ? `<button type="submit" name="catalog_access_tags" value="" class="btn btn-ghost btn-xs">Clear</button>` : ''}
                </div>
              </div>
            <div style="margin-top:1rem"><button type="submit" class="btn btn-primary btn-sm">Save changes</button></div>
          </form>
        </div>
      </div>
      <div class="detail-side">
        <div class="card">
          <div class="card-header"><h2>Summary</h2></div>
          <div class="kv-list">
            <div class="kv-row"><span>Lifetime spend</span><strong>${fmtMoney(customer.amountSpent?.amount, customer.amountSpent?.currencyCode)}</strong></div>
            <div class="kv-row"><span>Orders</span><strong>${customer.numberOfOrders||0}</strong></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Default Address</h2></div>
          <p class="address-block">${addrHtml}</p>
        </div>
        <div class="card">
          <div class="card-header"><h2>Tags</h2>
            <button class="btn btn-ghost btn-xs" id="tag-add-btn" type="button">+ Add</button>
          </div>
          <div class="tags-list" id="tags-list">
            ${(customer.tags||[]).map(t => `
              <form method="POST" action="/customers/${h(numId)}/tags/remove" style="display:inline">
                <input type="hidden" name="tag" value="${h(t)}">
                <span class="tag">${h(t)} <button type="submit" class="tag-remove" title="Remove tag" onclick="return confirm('Remove tag ${h(t)}?')">×</button></span>
              </form>`).join(' ')}
          </div>
          <form method="POST" action="/customers/${h(numId)}/tags/add" id="tag-add-form" hidden style="margin-top:0.5rem;display:flex;gap:0.5rem">
            <input type="text" name="tag" placeholder="New tag…" class="input input-sm" style="flex:1">
            <button type="submit" class="btn btn-secondary btn-sm">Add</button>
          </form>
          <script>
          (function(){
            var btn  = document.getElementById('tag-add-btn');
            var form = document.getElementById('tag-add-form');
            if(btn && form){ btn.addEventListener('click',function(){ form.hidden=false; form.querySelector('input').focus(); }); }
          })();
          </script>
        </div>
        <!-- Phase 19D: Active cart card -->
        <div class="card" id="active-cart-card">
          <div class="card-header"><h2>Active cart</h2></div>
          <div id="active-cart-body"><span class="text-muted small-text">Loading…</span></div>
          <script>
          (function(){
            var el = document.getElementById('active-cart-body');
            fetch('/api/admin/customers/${h(numId)}/active-cart')
              .then(function(r){ return r.json(); })
              .then(function(d){
                if(!d.items || d.items.length === 0){
                  el.innerHTML = '<span class="text-muted small-text">No active cart</span>';
                  return;
                }
                var itemsHtml = d.items.map(function(i){
                  return '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;font-size:13px">' +
                    '<span>' + (i.productTitle||'').replace(/</g,'&lt;') + (i.variantTitle ? ' — ' + i.variantTitle.replace(/</g,'&lt;') : '') + ' × ' + i.quantity + '</span>' +
                    '<span style="font-weight:600;white-space:nowrap;margin-left:8px">$' + (i.lineTotal||0).toFixed(2) + '</span>' +
                    '</div>';
                }).join('');
                var updatedAgo = d.updatedAt ? (function(ts){
                  var m = Math.floor((Date.now()-ts)/60000);
                  if(m < 1) return 'just now';
                  if(m < 60) return m + 'm ago';
                  var h = Math.floor(m/60);
                  if(h < 24) return h + 'h ago';
                  return Math.floor(h/24) + 'd ago';
                })(d.updatedAt) : '';
                el.innerHTML = itemsHtml +
                  '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);display:flex;justify-content:space-between">' +
                    '<span class="text-muted small-text">' + d.items.length + ' item' + (d.items.length!==1?'s':'') + (updatedAgo ? ' · ' + updatedAgo : '') + '</span>' +
                    '<strong>$' + (d.subtotal||0).toFixed(2) + '</strong>' +
                  '</div>' +
                  '<div style="margin-top:8px;display:flex;gap:6px">' +
                    '<a href="/orders/new?customer=${h(numId)}" class="btn btn-ghost btn-xs" title="Pre-populate new order from cart">Convert to order…</a>' +
                  '</div>';
              })
              .catch(function(){ el.innerHTML = '<span class="text-muted small-text">Unavailable</span>'; });
          })();
          </script>
        </div>
        <!-- Phase 21D: Xero sync status card -->
        <div class="card" id="xero-customer-card">
          <div class="card-header"><h2>Xero</h2></div>
          <div id="xero-customer-status">
            <span class="text-muted small-text">Loading…</span>
          </div>
          <script>
          (function(){
            var el = document.getElementById('xero-customer-status');
            fetch('/api/admin/customers/${h(numId)}/xero-status')
              .then(function(r){ return r.json(); })
              .then(function(d){
                // SECURITY: d.xeroName is synced from the Shopify customer/company name (attacker-controlled)
                // and goes into innerHTML — escape it (and the contact id) or "<img onerror>" runs here.
                var esc = function(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;'); };
                var html = '';
                if(d.state === 'synced'){
                  html = '<span style="color:var(--lime);font-weight:600">✓ Synced</span>' +
                    ' <a href="https://go.xero.com/Contacts/View/'+encodeURIComponent(d.xeroContactId)+'" target="_blank" class="text-muted small-text" style="font-size:11px" title="'+esc(d.xeroContactId)+'">' +
                    esc(String(d.xeroContactId).slice(0,8))+'…</a>' +
                    (d.xeroName ? '<br><span class="text-muted small-text">'+esc(d.xeroName)+'</span>' : '') +
                    '<br><form method="POST" action="/api/admin/customers/${h(numId)}/xero-sync" style="margin-top:6px"><button class="btn btn-ghost btn-xs" type="submit">↻ Re-sync</button></form>';
                } else if(d.state === 'merged'){
                  html = '<span style="color:var(--lime);font-weight:600">⚭ Merged contact</span>' +
                    '<br><span class="text-muted small-text">Invoices for this customer post to <strong>'+esc(d.xeroName)+'</strong>.</span>' +
                    (d.primaryShopifyId ? '<br><a href="/customers/'+encodeURIComponent(d.primaryShopifyId)+'" class="small-text">View primary →</a>' : '');
                } else if(d.state === 'insider'){
                  html = '<span style="color:#999">⊘ Insider — sync not applicable</span>';
                } else {
                  html = '<span style="color:var(--orange)">⚠ Not synced</span>' +
                    '<br><form method="POST" action="/api/admin/customers/${h(numId)}/xero-sync" style="margin-top:6px"><button class="btn btn-secondary btn-xs" type="submit">Sync to Xero</button></form>';
                }
                el.innerHTML = html;
              })
              .catch(function(){ el.innerHTML = '<span class="text-muted small-text">Could not load Xero status.</span>'; });
          })();
          </script>
        </div>
      </div>
    </div>
  ` });
}

// ── Manual order form ─────────────────────────────────────────────────────────
// WHAT: Manual /orders/new draft-order builder — customer + product autocomplete (/api/customers/search, /api/products/search), editable B2B price column, custom (non-catalog) line items, shipping address auto-fill, posts a JSON line_items blob.
// CHANGE-GUARD: B2B price is computed client-side as listPrice*(1-discountPct/100) using selectedCustomer.discountPct (default 50) — re-test that the discount comes from the customer's effective config, not a hardcoded 50, and that price overrides typed by the user survive submit. The hidden line_items field is JSON.stringify(lineItems); submitNewOrder re-parses it.
// INVARIANT(S): submit is gated (disabled) until a customer AND >=1 line item with qty>0 exist; variantId dedupe increments qty rather than adding a row; custom items carry isCustom:true / sku 'CUSTOM' and are sent as titled price lines (no variant).
function renderNewOrderForm(session, prefillCustomer) {
  // jsonForScript (not JSON.stringify): displayName/email come from Shopify (customer-controlled);
  // a name of `</script>…` would otherwise break out of the inline <script> below.
  const customerJson = prefillCustomer ? jsonForScript({ id: shopifyNumericId(prefillCustomer.id), name: prefillCustomer.displayName, email: prefillCustomer.email, address: prefillCustomer.defaultAddress || null }) : 'null';
  return layout({ title: 'New Order', session, activePath: '/orders',
    extraHead: `<style>
      .order-form-grid{display:grid;grid-template-columns:1fr 320px;gap:1rem;}
      #line-items-table tbody tr td{padding:0.35rem 0.5rem;}
      .price-override{width:90px;}
      .qty-input{width:60px;}
      /* The line-items table (6 cols) has a natural min-width that used to force PAGE-level
         horizontal scroll; keep the overflow inside the card instead. */
      .line-items-scroll{overflow-x:auto;}
      /* Stack at <=1100px, not 700px: the 2-col grid is 1fr + a fixed 320px rail, and the table
         floors the left column ~=850px, so 701-1100px overflowed (measured 1170px wide @768). */
      @media(max-width:1100px){.order-form-grid{grid-template-columns:1fr;}}
    </style>`,
    content: `
    <div class="breadcrumb-row"><a href="/orders" class="breadcrumb">← Orders</a></div>
    <div class="page-header-row"><h1>New Order</h1></div>
    <form id="order-form" method="POST" action="/orders/new">
      <input type="hidden" name="customer_id" id="customer_id_hidden">
      <input type="hidden" name="line_items" id="line_items_hidden" value="[]">
      <div class="order-form-grid">
        <div>
          <div class="card">
            <div class="card-header"><h2>Customer</h2></div>
            <div style="position:relative">
              <input type="text" id="customer-search" class="input" placeholder="Search customer by name or email…" autocomplete="off">
              <div id="customer-results" class="autocomplete-dropdown" hidden></div>
            </div>
            <div id="customer-selected" class="selected-item" hidden></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Line Items</h2></div>
            <div style="position:relative;margin-bottom:0.75rem">
              <div style="display:flex;gap:8px;align-items:center"><input type="text" id="product-search" class="input" placeholder="Search product by title or SKU…" autocomplete="off" style="flex:1"><button type="button" class="btn btn-secondary btn-sm" onclick="toggleCustomItemForm()">+ Custom item</button></div>
              <div id="product-results" class="autocomplete-dropdown" hidden></div>
              <div id="custom-item-form" hidden style="margin-top:8px;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:6px;background:var(--gray-50,#f9fafb)">
                <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
                  <div style="flex:2;min-width:150px"><label class="text-muted small-text">Custom item title</label><input type="text" id="ci-title" class="input" placeholder="e.g. Custom collar — Bree"></div>
                  <div style="width:90px"><label class="text-muted small-text">Unit price</label><input type="number" id="ci-price" class="input" min="0" step="0.01" placeholder="0.00"></div>
                  <div style="width:64px"><label class="text-muted small-text">Qty</label><input type="number" id="ci-qty" class="input" min="1" step="1" value="1"></div>
                  <button type="button" class="btn btn-primary btn-sm" onclick="addCustomItem()">Add</button>
                  <button type="button" class="btn btn-ghost btn-sm" onclick="toggleCustomItemForm(false)">Cancel</button>
                </div>
                <div id="ci-error" class="text-muted small-text" style="color:var(--red);margin-top:4px"></div>
              </div>
            </div>
            <div class="line-items-scroll">
              <table class="data-table" id="line-items-table">
                <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>List Price</th><th>B2B Price</th><th></th></tr></thead>
                <tbody id="line-items-body"><tr id="empty-row"><td colspan="6" class="empty-state">Add line items above</td></tr></tbody>
              </table>
            </div>
            <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin:0.6rem 0;padding-top:0.6rem;border-top:1px solid var(--border,#e5e7eb)">
              <label for="ship-cost" style="font-weight:600;margin:0">Shipping charge</label>
              <span style="color:var(--muted)">$</span>
              <input type="number" name="ship_cost" class="input" id="ship-cost" min="0" step="0.01" placeholder="0.00" style="width:110px;text-align:right" title="Optional — added to the order as a Shopify shipping line and included in the total">
            </div>
            <div class="totals-block" id="order-totals" style="margin-top:0"></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Notes &amp; PO</h2></div>
            <div class="form-row">
              <label for="order-po">PO Number</label>
              <input type="text" id="order-po" name="po_number" class="input" placeholder="Optional PO #">
            </div>
            <div class="form-row" style="margin-top:0.5rem">
              <label for="order-note">Order Note</label>
              <textarea id="order-note" name="note" class="textarea" rows="3" placeholder="Internal note / instructions…"></textarea>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <div class="card-header"><h2>Shipping Address</h2></div>
            <div id="default-addr-msg" class="text-muted small-text" style="margin-bottom:0.5rem">Select a customer to auto-fill.</div>
            <div class="form-row"><label>First Name</label><input type="text" name="ship_first" class="input" id="ship-first"></div>
            <div class="form-row"><label>Last Name</label><input type="text" name="ship_last" class="input" id="ship-last"></div>
            <div class="form-row"><label>Address 1</label><input type="text" name="ship_addr1" class="input" id="ship-addr1"></div>
            <div class="form-row"><label>Address 2</label><input type="text" name="ship_addr2" class="input" id="ship-addr2"></div>
            <div class="form-row"><label>City</label><input type="text" name="ship_city" class="input" id="ship-city"></div>
            ${/* CANADA MATTERS: several wholesale accounts are Ontario (howlers.ca, etc). A US-only
                 list made fillShipAddr fall back to blank for them and shipped a province-less
                 address. Keep both countries here, and see fillShipAddr — unknown codes are injected
                 rather than dropped. */''}
            <div class="form-row"><label>Province/State</label><select name="ship_province" class="input" id="ship-province"><option value="">—</option><optgroup label="United States">${['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'].map(s=>`<option value="${s}">${s}</option>`).join('')}</optgroup><optgroup label="Canada">${['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'].map(s=>`<option value="${s}">${s}</option>`).join('')}</optgroup></select></div>
            <div class="form-row"><label>ZIP</label><input type="text" name="ship_zip" class="input" id="ship-zip"></div>
            <div class="form-row"><label>Country</label><input type="text" name="ship_country" class="input" id="ship-country" value="US"></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Submit</h2></div>
            <p class="text-muted small-text" style="margin-bottom:0.75rem">Order will be created as a pending (unpaid) order.</p>
            <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:0.75rem;cursor:pointer;font-size:13px">
              <input type="checkbox" name="notify_customer" id="notify-customer" style="margin-top:2px">
              <span>Email order confirmation to the customer <span class="text-muted">(off by default — leave unchecked to create the order silently)</span></span>
            </label>
            <button type="submit" id="submit-btn" class="btn btn-primary" style="width:100%" disabled>Create Order</button>
            <p id="submit-error" class="text-muted small-text" style="margin-top:0.5rem;color:var(--red)"></p>
          </div>
        </div>
      </div>
    </form>
    <script>
    (function(){
      var lineItems = [];
      var selectedCustomer = ${customerJson};
      var customerIdHidden = document.getElementById('customer_id_hidden');
      var lineItemsHidden  = document.getElementById('line_items_hidden');
      var submitBtn = document.getElementById('submit-btn');
      var submitError = document.getElementById('submit-error');

      if(selectedCustomer){
        customerIdHidden.value = selectedCustomer.id;
        document.getElementById('customer-selected').hidden = false;
        document.getElementById('customer-selected').innerHTML =
          '<strong>'+esc(selectedCustomer.name)+'</strong> &lt;'+esc(selectedCustomer.email)+'&gt; '+
          '<button type="button" onclick="clearCustomer()" class="btn btn-ghost btn-xs">×</button>';
        document.getElementById('customer-search').hidden = true;
        fillShipAddr(selectedCustomer.address); // prefill path (+ New Order from a customer)
      }

      function esc(s){ var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

      // Fill the Shipping Address card from a customer's default address. Shared by BOTH the
      // ?customer= prefill path (above) and the search-and-select path (below). Null/undefined = no-op.
      function fillShipAddr(a){
        if(!a) return;
        document.getElementById('ship-first').value=a.firstName||'';
        document.getElementById('ship-last').value=a.lastName||'';
        document.getElementById('ship-addr1').value=a.address1||'';
        document.getElementById('ship-addr2').value=a.address2||'';
        document.getElementById('ship-city').value=a.city||'';
        // ship-province is a <select> of US+CA codes; prefer provinceCode, else a 2-letter province.
        // NEVER silently drop it: if the customer's code isn't one of our options (any other
        // country), inject it — assigning an unknown value to a <select> yields "" and would ship a
        // province-less address. This regressed 3+ Ontario wholesale accounts.
        var pv = a.provinceCode || (a.province && a.province.length === 2 ? String(a.province).toUpperCase() : '');
        var selP = document.getElementById('ship-province');
        if (pv && !Array.prototype.some.call(selP.options, function(o){ return o.value === pv; })) {
          selP.appendChild(new Option(pv, pv));
        }
        selP.value = pv;
        document.getElementById('ship-zip').value=a.zip||'';
        document.getElementById('ship-country').value=a.country||'US';
        document.getElementById('default-addr-msg').textContent='Auto-filled from customer default address.';
      }

      function updateSubmitBtn(){
        var ok = selectedCustomer && lineItems.length>0 && lineItems.every(function(l){return l.qty>0;});
        submitBtn.disabled = !ok;
        submitError.textContent = !selectedCustomer ? 'Select a customer first.' : lineItems.length===0 ? 'Add at least one line item.' : '';
      }

      function shipCost(){ var el=document.getElementById('ship-cost'); return el ? (parseFloat(el.value)||0) : 0; }
      function updateTotals(){
        var subtotal = lineItems.reduce(function(s,l){ return s + parseFloat(l.price||0)*parseInt(l.qty||0,10); }, 0);
        var ship = shipCost();
        var html='';
        if(subtotal>0 || ship>0){
          html += '<div class="totals-row"><span>Subtotal</span><span>'+fmt(subtotal)+'</span></div>';
          if(ship>0) html += '<div class="totals-row"><span>Shipping</span><span>'+fmt(ship)+'</span></div>';
          html += '<div class="totals-row totals-total"><span>Est. Total</span><span>'+fmt(subtotal+ship)+'</span></div>';
        }
        document.getElementById('order-totals').innerHTML = html;
        lineItemsHidden.value = JSON.stringify(lineItems);
        updateSubmitBtn();
      }
      (function(){ var sc=document.getElementById('ship-cost'); if(sc) sc.addEventListener('input', updateTotals); })();

      function fmt(n){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n); }

      // Render line items table
      function renderLineItems(){
        var tbody = document.getElementById('line-items-body');
        if(lineItems.length===0){
          tbody.innerHTML = '<tr id="empty-row"><td colspan="6" class="empty-state">Add line items above</td></tr>';
          return;
        }
        tbody.innerHTML = lineItems.map(function(li,i){
          return '<tr>'+
            '<td>'+esc(li.title)+'</td>'+
            '<td class="mono">'+esc(li.sku||'—')+'</td>'+
            '<td><input type="number" class="qty-input" value="'+li.qty+'" min="1" data-idx="'+i+'" onchange="setQty('+i+',this.value)"></td>'+
            '<td class="text-right mono">'+fmt(parseFloat(li.listPrice||0))+'</td>'+
            '<td><input type="text" class="price-override" value="'+li.price+'" data-idx="'+i+'" onchange="setPrice('+i+',this.value)"></td>'+
            '<td><button type="button" class="btn btn-ghost btn-xs" onclick="removeItem('+i+')">×</button></td>'+
          '</tr>';
        }).join('');
      }

      window.setQty = function(i,v){ lineItems[i].qty=Math.max(1,parseInt(v,10)||1); renderLineItems(); updateTotals(); };
      window.setPrice = function(i,v){ lineItems[i].price=parseFloat(v)||0; updateTotals(); };
      window.removeItem = function(i){ lineItems.splice(i,1); renderLineItems(); updateTotals(); };
      window.clearCustomer = function(){
        selectedCustomer=null; customerIdHidden.value='';
        document.getElementById('customer-selected').hidden=true;
        document.getElementById('customer-search').hidden=false;
        updateSubmitBtn();
      };

      // Autocomplete helper
      function setupAutocomplete(inputId, resultsId, url, onSelect){
        var input   = document.getElementById(inputId);
        var results = document.getElementById(resultsId);
        var timer   = null;
        input.addEventListener('input',function(){
          clearTimeout(timer);
          var q = input.value.trim();
          if(!q){ results.hidden=true; return; }
          timer = setTimeout(function(){
            fetch(url+'?q='+encodeURIComponent(q))
              .then(function(r){return r.json();})
              .then(function(data){
                if(!data.length){ results.hidden=true; return; }
                results.innerHTML = data.map(function(item){
                  return '<div class="autocomplete-item" data-json="'+JSON.stringify(item).replace(/"/g,"&quot;")+'">'
                    + esc(item.label) + (item.sublabel?'<small>'+esc(item.sublabel)+'</small>':'') + '</div>';
                }).join('');
                results.hidden=false;
              }).catch(function(){ results.hidden=true; });
          },250);
        });
        results.addEventListener('click',function(e){
          var item = e.target.closest('.autocomplete-item');
          if(!item) return;
          var data = JSON.parse(item.dataset.json.replace(/&quot;/g, '"'));
          results.hidden=true; input.value='';
          onSelect(data);
        });
        document.addEventListener('click',function(e){ if(!input.contains(e.target)&&!results.contains(e.target)) results.hidden=true; });
      }

      setupAutocomplete('customer-search','customer-results','/api/customers/search',function(c){
        selectedCustomer={id:c.id,name:c.label,email:c.sublabel,discountPct:c.discountPct||50};
        customerIdHidden.value=c.id;
        document.getElementById('customer-selected').hidden=false;
        document.getElementById('customer-selected').innerHTML=
          '<strong>'+esc(c.label)+'</strong> &lt;'+esc(c.sublabel||'')+'&gt; '+
          '<button type="button" onclick="clearCustomer()" class="btn btn-ghost btn-xs">×</button>';
        document.getElementById('customer-search').hidden=true;
        fillShipAddr(c.address); // search-and-select path
        updateSubmitBtn();
      });

      // Grouped nested-variant product picker — ported 2026-07-14 from the order-EDIT
      // "add item" modal (renderOrderDetail). Type a product name → dropdown shows each
      // PRODUCT as a header with its variants nested as checkboxes (width→size sub-group
      // when a Width option exists); check any number across products, then "Add selected"
      // adds them all at once. Uses /api/products/search?grouped=1. This REPLACED the old
      // flat one-row-per-variant setupAutocomplete picker (which never nested variants —
      // the nesting only ever existed in the edit modal until now).
      function addVariantToOrder(p){
        // p: {variantId,label,sku,price}. Dedupe → qty++, else push at wholesale.
        var exists = lineItems.findIndex(function(l){ return l.variantId===p.variantId; });
        if(exists>=0){ lineItems[exists].qty++; }
        else {
          var disc = (selectedCustomer && selectedCustomer.discountPct != null) ? selectedCustomer.discountPct : 50;
          var wsPrice = (parseFloat(p.price||0) * (1 - disc/100)).toFixed(2);
          lineItems.push({ variantId:p.variantId, title:p.label, sku:p.sku||'', listPrice:parseFloat(p.price||0), price:wsPrice, qty:1 });
        }
      }
      (function(){
        var input = document.getElementById('product-search');
        var box   = document.getElementById('product-results');
        if(!input || !box) return;
        var t=null, lastSeq=0, groupedFlat=null;
        function hide(){ box.hidden=true; box.innerHTML=''; groupedFlat=null; }
        var SIZE_RANK=(function(){ var order=['XXS','2XS','XS','XSM','S','SM','SMALL','M','MED','MEDIUM','L','LG','LARGE','XL','XLG','XLARGE','XXL','2XL','XXLG','XXLARGE','XXXL','3XL']; var m={}; order.forEach(function(k,i){m[k]=i;}); return m; })();
        function sizeRank(v){ var k=String(v||'').toUpperCase().replace(/\\s+/g,''); return SIZE_RANK[k]!=null?SIZE_RANK[k]:Infinity; }
        function widthVal(w){ var s=String(w||'').replace(/["”]/g,'').trim(); var f=s.match(/^(\\d+)\\s*\\/\\s*(\\d+)$/); if(f) return parseInt(f[1],10)/parseInt(f[2],10); var n=parseFloat(s); return isNaN(n)?Infinity:n; }
        function optVal(v,nameLc){ var o=(v.selectedOptions||[]).find(function(x){return String(x.name||'').toLowerCase()===nameLc;}); return o?o.value:null; }
        function hasOption(v,nameLc){ return (v.selectedOptions||[]).some(function(x){return String(x.name||'').toLowerCase()===nameLc;}); }
        function variantRow(key,v,indent){
          var size=optVal(v,'size');
          var shown=size!=null?size:(v.variantTitle==='Default Title'?'Add this item':v.variantTitle);
          var oos=(v.inventoryQuantity!=null && v.inventoryQuantity<=0);
          return '<label class="np-var-opt" style="display:flex;align-items:center;gap:8px;padding:5px 10px 5px '+indent+'px;cursor:pointer;font-size:13px">'+
            '<input type="checkbox" class="np-var-cb" data-key="'+key+'" style="margin:0">'+
            '<span>'+esc(shown)+(oos?' <span style="color:#b91c1c;font-size:11px">(out of stock)</span>':'')+'</span>'+
            '<span style="margin-left:auto;color:var(--muted);font-size:11px">'+esc(v.sku||'—')+'</span>'+
          '</label>';
        }
        function render(products){
          if(!Array.isArray(products)||!products.length){ box.innerHTML='<div style="padding:8px 10px;color:var(--muted);font-size:13px">No matches</div>'; box.hidden=false; groupedFlat=null; return; }
          var flat=[]; var html='';
          products.forEach(function(p){
            html+='<div style="padding:7px 10px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-weight:600;font-size:13px;color:#111827">'+esc(p.productTitle)+(p.variantsTruncated?' <span style="font-weight:400;color:#b45309;font-size:11px">(showing first 25 sizes)</span>':'')+'</div>';
            var vs=(p.variants||[]).slice();
            var anyWidth=vs.some(function(v){return hasOption(v,'width');});
            function pushKey(v){ var key=flat.length; flat.push({variantId:v.variantId,label:v.label,sku:v.sku,price:v.price}); return key; }
            if(anyWidth){
              var byWidth={}; vs.forEach(function(v){ var w=optVal(v,'width')||'—'; (byWidth[w]=byWidth[w]||[]).push(v); });
              Object.keys(byWidth).sort(function(a,b){return widthVal(a)-widthVal(b)||a.localeCompare(b);}).forEach(function(w){
                html+='<div style="padding:4px 10px 4px 18px;font-size:12px;font-weight:600;color:#4b5563">'+esc(w)+'</div>';
                byWidth[w].sort(function(a,b){return sizeRank(optVal(a,'size'))-sizeRank(optVal(b,'size'))||String(optVal(a,'size')||a.variantTitle).localeCompare(String(optVal(b,'size')||b.variantTitle));}).forEach(function(v){ html+=variantRow(pushKey(v),v,34); });
              });
            } else {
              vs.sort(function(a,b){return sizeRank(optVal(a,'size'))-sizeRank(optVal(b,'size'))||String(optVal(a,'size')||a.variantTitle).localeCompare(String(optVal(b,'size')||b.variantTitle));}).forEach(function(v){ html+=variantRow(pushKey(v),v,22); });
            }
          });
          html+='<div style="position:sticky;bottom:0;background:#fff;border-top:1px solid #e5e7eb;padding:8px 10px;display:flex;align-items:center;gap:8px">'+
                '<button type="button" id="np-add-selected" class="btn btn-primary btn-sm">Add selected</button>'+
                '<span id="np-sel-count" style="color:var(--muted);font-size:12px">0 selected</span></div>';
          box.innerHTML=html; box.hidden=false; groupedFlat=flat;
          var countEl=box.querySelector('#np-sel-count');
          function refreshCount(){ var n=box.querySelectorAll('.np-var-cb:checked').length; if(countEl) countEl.textContent=n+' selected'; }
          Array.prototype.forEach.call(box.querySelectorAll('.np-var-cb'),function(cb){ cb.addEventListener('change',refreshCount); });
          box.querySelectorAll('label.np-var-opt').forEach(function(l){ l.addEventListener('mousedown',function(ev){ ev.preventDefault(); }); });
          var addBtn=box.querySelector('#np-add-selected');
          if(addBtn){
            addBtn.addEventListener('mousedown',function(ev){ ev.preventDefault(); });
            addBtn.addEventListener('click',function(){
              var chosen=Array.prototype.map.call(box.querySelectorAll('.np-var-cb:checked'),function(cb){ return (groupedFlat||[])[parseInt(cb.dataset.key,10)]; }).filter(Boolean);
              if(!chosen.length) return;
              chosen.forEach(function(p){ addVariantToOrder(p); });
              input.value=''; hide(); renderLineItems(); updateTotals(); input.focus();
            });
          }
        }
        input.addEventListener('input',function(){
          var q=input.value.trim();
          if(t) clearTimeout(t);
          if(q.length<2){ hide(); return; }
          var seq=++lastSeq;
          t=setTimeout(function(){
            fetch('/api/products/search?grouped=1&q='+encodeURIComponent(q),{credentials:'same-origin'})
              .then(function(r){return r.json();})
              .then(function(products){ if(seq!==lastSeq) return; render(products); })
              .catch(function(){ hide(); });
          },220);
        });
        document.addEventListener('click',function(ev){ if(ev.target!==input && !box.contains(ev.target)) hide(); });
      })();

      // Add custom (non-catalog) line item
      // Inline custom-item form (replaced the old prompt()-based flow, which browsers block
      // after the first dialog). Toggle reveals title/price/qty inputs right in the card.
      window.toggleCustomItemForm = function(show){
        var f = document.getElementById('custom-item-form');
        var open = (show === undefined) ? f.hidden : show;
        f.hidden = !open;
        if(open){ document.getElementById('ci-title').focus(); }
        else {
          document.getElementById('ci-title').value='';
          document.getElementById('ci-price').value='';
          document.getElementById('ci-qty').value='1';
          document.getElementById('ci-error').textContent='';
        }
      };
      window.addCustomItem = function() {
        var title = (document.getElementById('ci-title').value||'').trim();
        var price = parseFloat(document.getElementById('ci-price').value);
        var qty   = parseInt(document.getElementById('ci-qty').value, 10);
        var err   = document.getElementById('ci-error');
        if(!title){ err.textContent='Enter a title.'; return; }
        if(!Number.isFinite(price) || price < 0){ err.textContent='Enter a valid price.'; return; }
        if(!Number.isInteger(qty) || qty < 1){ err.textContent='Enter a valid quantity.'; return; }
        lineItems.push({ isCustom:true, title:title, sku:'CUSTOM', listPrice:price, price:price.toFixed(2), qty:qty });
        toggleCustomItemForm(false);
        renderLineItems();
        updateTotals();
      };

      // Form submit: validate
      var submitting = false;
      document.getElementById('order-form').addEventListener('submit',function(e){
        if(!selectedCustomer||lineItems.length===0){ e.preventDefault(); updateSubmitBtn(); return; }
        submitting = true; // a real submit — don't warn on the success redirect
        lineItemsHidden.value=JSON.stringify(lineItems);
      });

      // Nothing on this page is persisted server-side until "Create Order", so a reload/close used
      // to wipe the entire in-progress order (customer + lines + shipping) with NO warning — which
      // bit hard while the desktop shell was being force-reloaded to dodge stale pages. Warn once
      // there's real work to lose. (renderOrderDetail's autosave controller guards the same way.)
      window.addEventListener('beforeunload', function(e){
        if (submitting) return;
        if (!selectedCustomer && lineItems.length === 0) return;
        e.preventDefault(); e.returnValue = ''; return '';
      });

      updateSubmitBtn();
    })();
    </script>
  ` });
}

// WHAT: Create a Shopify order via orderCreate (financialStatus PENDING) from the manual order form,
// with per-order customer-notification control (options.sendReceipt, default OFF via the Notify-customer
// checkbox). Fire-and-forget Xero invoice push (currently a [XERO-DISABLED] no-op; skipped for insiders).
// CHANGE-GUARD: Switched 2026-07-14 from draftOrderCreate+draftOrderComplete to orderCreate SPECIFICALLY
// so we can suppress the customer order-confirmation email — draftOrderComplete had NO notify toggle and
// always emailed. Key differences, all verified live via real orderCreate round-trips (test:true, deleted):
//   • orderCreate HONORS priceSet directly EVEN WITH a variantId → we set the wholesale price outright.
//     NO appliedDiscount %, NO double-discount, NO full-retail regression. (Trade-off: the line records
//     the wholesale price directly, not "list − 50%" with a strikethrough.)
//   • title is REQUIRED on every line (orderCreate won't pull it from the variant).
//   • requiresShipping:true on ALL lines so shippingLines is retained (Shopify silently drops shipping
//     when no line is shippable — verified). FWW is 100% physical so this is always correct.
//   • inventoryBehaviour:BYPASS so a made-to-order sale (999 stock) can never fail on inventory.
// Re-verify wholesale pricing + variant linkage + shipping end-to-end against Shopify (not just HTTP 200)
// if you touch the line-item build.
// INVARIANT(S): single orderCreate mutation; userErrors abort with {error} (logged [order-create] + sent
// to error-sink); tags ['b2b-portal','b2b-manual-order'] required for the order to appear in /orders
// (filters tag:b2b-portal); sendReceipt=false UNLESS the Notify-customer box is ticked; insider check uses
// isInsider(customer_id); Xero sync (no-op while [XERO-DISABLED]) runs 800ms later so tags are queryable.
async function submitNewOrder(req, session) {
  const { customer_id, line_items, note, po_number, ship_cost, notify_customer,
          ship_first, ship_last, ship_addr1, ship_addr2,
          ship_city, ship_province, ship_zip, ship_country } = req.body;
  let lineItemsParsed = [];
  try { lineItemsParsed = JSON.parse(line_items || '[]'); } catch {}

  if (!customer_id || !lineItemsParsed.length) {
    return { error: 'Missing customer or line items' };
  }

  // Server-side validation BEFORE building the order. orderCreate honors priceSet directly, so a
  // missing/garbage price would create a $0 or NaN line (the OLD draft flow fell back to the variant's
  // list price — orderCreate does not). Trusted staff may set any NON-NEGATIVE price (B2B override is
  // intended); we only reject NaN / negative / missing prices, bad quantities, catalog lines with no
  // valid variant, and untitled lines — with a clear user-facing error instead of mis-pricing.
  for (let i = 0; i < lineItemsParsed.length; i++) {
    const li = lineItemsParsed[i] || {};
    const label = li.title || li.sku || `line ${i + 1}`;
    const price = parseFloat(li.price);
    const qty   = parseInt(li.qty, 10);
    if (!Number.isFinite(price) || price < 0)   return { error: `Invalid price on "${label}".` };
    if (!Number.isInteger(qty) || qty < 1)      return { error: `Invalid quantity on "${label}".` };
    if (!String(li.title || '').trim())         return { error: `A line item is missing a title.` };
    if (!li.isCustom && !/^\d+$/.test(String(li.variantId || '')))
      return { error: `Catalog line "${label}" is missing a valid product variant.` };
  }
  // Shipping is optional; blank/0 → no shipping line. Reject malformed/negative rather than under/over-charge.
  const shipCostRaw = ship_cost == null ? '' : String(ship_cost).trim();
  const shipCostNum = shipCostRaw === '' ? 0 : parseFloat(shipCostRaw);
  if (!Number.isFinite(shipCostNum) || shipCostNum < 0) return { error: 'Invalid shipping cost.' };

  const shippingAddress = {
    firstName: ship_first || '', lastName: ship_last || '',
    address1: ship_addr1 || '', address2: ship_addr2 || '',
    city: ship_city || '', province: ship_province || '',
    zip: ship_zip || '', country: ship_country || 'US',
  };

  const orderNote = [note || '', po_number ? `PO: ${po_number}` : ''].filter(Boolean).join('\n');
  // Notify-customer checkbox: unchecked → field absent; checked → 'on'. Default (absent) = do NOT
  // email the customer (this is the whole reason we moved off draftOrderComplete).
  const sendReceipt = notify_customer === 'on' || notify_customer === 'true' || notify_customer === true;

  if (MOCK) {
    auditLog(session.email, 'create_order', `mock-customer-${customer_id}`, null, { customer_id, lineItemsParsed, shippingAddress, shippingCost: ship_cost || null, sendReceipt });
    return { orderId: 'MOCK-9999', orderName: '#MOCK-9999', ok: true };
  }

  try {
    const gidCustomer = shopifyCustomerGid(customer_id);
    const orderInput = {
      financialStatus: 'PENDING',
      customer: { toAssociate: { id: gidCustomer } },
      lineItems: lineItemsParsed.map(li => {
        const line = {
          title: li.title, // validated non-empty above
          quantity: parseInt(li.qty, 10),
          // priceSet = the exact per-unit price the customer pays (wholesale). orderCreate honors
          // this DIRECTLY even for variant-linked lines — no appliedDiscount %, no double-discount.
          priceSet: { shopMoney: { amount: parseFloat(li.price).toFixed(2), currencyCode: 'USD' } },
          requiresShipping: true, // FWW is all physical; guarantees shippingLines is retained
        };
        if (li.isCustom) {
          line.taxable = false; // custom (non-catalog) line — no variant
        } else {
          line.variantId = `gid://shopify/ProductVariant/${li.variantId}`; // validated present above
          if (li.sku) line.sku = li.sku;
        }
        return line;
      }),
      shippingAddress,
      // Shipping cost → orderCreate shippingLines[] (PLURAL; priceSet: MoneyBagInput{shopMoney{...}}).
      // Verified live that shippingLines is retained when a shippable line exists (requiresShipping above).
      // [XERO-DISABLED] When Xero writes are re-enabled, createXeroInvoice must also add this shipping
      // amount as an invoice LineItem or the Xero invoice under-bills — see the TODO in createXeroInvoice.
      shippingLines: (shipCostNum > 0)
        ? [{ title: 'Shipping', priceSet: { shopMoney: { amount: shipCostNum.toFixed(2), currencyCode: 'USD' } } }]
        : undefined,
      note: orderNote || null,
      // [notify handshake] sendReceipt:false only suppresses Shopify's NATIVE order confirmation — it
      // does NOT stop external automations (a workflow/app sends the customer an invoice ~1 min after
      // creation; verified via the order event log). So when "Notify customer" is OFF we also TAG the
      // order 'no-customer-email'. The automation that emails the invoice must add a condition to SKIP
      // orders carrying this tag for the toggle to actually silence the customer. Grep: no-customer-email.
      tags: sendReceipt
        ? ['b2b-portal', 'b2b-manual-order']
        : ['b2b-portal', 'b2b-manual-order', 'no-customer-email'],
    };
    // sendReceipt=false → NO customer email (default). inventoryBehaviour:BYPASS → never fail on stock.
    const options = { sendReceipt, inventoryBehaviour: 'BYPASS' };

    const res = await shopifyFetch(`
      mutation orderCreate($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){
        orderCreate(order:$order,options:$options){ order{id name} userErrors{field message} }
      }`, { order: orderInput, options });
    const ue = res.data?.orderCreate?.userErrors || [];
    if (ue.length) {
      // Shopify rejected the order (bad price/variant/shipping, etc.). This is a RETURNED error, not a
      // throw, so the express error-middleware won't see it — log it explicitly to runs/serverlog.log
      // AND push to fww-error-sink so a failed create is never silent. Grep tag: [order-create].
      const msg = ue.map(e => e.message).join('; ');
      console.error(`[order-create] orderCreate FAILED: ${msg} | customer=${customer_id} ship_cost=${ship_cost || 0} lines=${lineItemsParsed.length} notify=${sendReceipt}`);
      reportEvent({ kind: 'error', severity: 'error', message: 'orderCreate failed: ' + msg, context: { stage: 'orderCreate', actor: session.email, customer_id, ship_cost: ship_cost || null, lineCount: lineItemsParsed.length, sendReceipt, userErrors: ue } });
      return { error: msg };
    }
    const order = res.data?.orderCreate?.order;
    if (!order?.id) {
      // No userErrors but no order back — treat as failure so we never log false success or leave
      // the operator thinking an order exists. (shopifyFetch already throws on top-level GraphQL
      // errors; this guards the null-payload edge.) Grep tag: [order-create].
      console.error(`[order-create] orderCreate returned NO order | customer=${customer_id} lines=${lineItemsParsed.length}`);
      reportEvent({ kind: 'error', severity: 'error', message: 'orderCreate returned no order', context: { stage: 'orderCreate', actor: session.email, customer_id } });
      return { error: 'Order was not created (Shopify returned no order). Nothing was charged.' };
    }
    const numId = shopifyNumericId(order.id);
    auditLog(session.email, 'create_order', order.id, null, { customer_id, lineItemCount: lineItemsParsed.length, sendReceipt });
    console.log(`[order-create] OK order=${order?.name || numId} id=${numId} customer=${customer_id} lines=${lineItemsParsed.length} ship_cost=${ship_cost || 0} notify=${sendReceipt}`);

    // Phase 18: push to Xero as Authorised ACCREC invoice (fire-and-forget; queue on failure)
    if (numId) {
      if (isInsider(customer_id)) {
        console.log('[xero] skipping invoice create for insider customer', customer_id, 'order', numId);
      } else {
        (async () => {
          // brief delay so Shopify order is queryable + tag indexed before we fetch it
          await new Promise(r => setTimeout(r, 800));
          try {
            const xeroInvoiceId = await syncOrderToXero(numId, session.email);
            console.log('[xero] invoice created for order', numId, '→', xeroInvoiceId);
          } catch (err) {
            console.error('[xero] invoice create failed (queued via addXeroPending):', err.message);
          }
        })();
      }
    }

    return { orderId: numId, orderName: order?.name, ok: true };
  } catch (err) {
    // Thrown/network failure (shopifyFetch threw, etc.). submitNewOrder catches its own
    // throw and RETURNS {error}, so the express error-middleware never sees it — report
    // here so it still reaches fww-error-sink. Grep tag: [order-create].
    console.error(`[order-create] threw: ${err.message} | customer=${customer_id} ship_cost=${ship_cost || 0}`);
    reportEvent({ kind: 'error', severity: 'error', message: 'submitNewOrder threw: ' + err.message, context: { actor: session.email, customer_id, ship_cost: ship_cost || null, stack: err.stack } });
    return { error: err.message };
  }
}

// WHAT: Dashboard manual-review queue — B2B customers (from local cache) that are NOT yet mapped to a Xero contact and are NOT insiders.
// CHANGE-GUARD: insider ids are HARDCODED here (4742401425601, 5163530813633) AND duplicated in isInsider elsewhere — keep them in sync or a customer shows in the review queue while their orders skip Xero. Reads data/shopify_to_xero_mapping.json (by_shopify_id keys); a missing/corrupt file degrades to 'everyone unmapped' rather than throwing.
// INVARIANT(S): listCustomersFromCache({segment:'b2b', limit:999}) — the 999 cap silently truncates if >999 B2B customers exist; ids are normalized by stripping the gid://shopify/Customer/ prefix before the mapped/insider Set lookups.
function getCustomersPendingXeroReview() {
  // B2B customers not yet mapped to a Xero contact (and not insiders).
  // Helps surface manual-review queue on the dashboard.
  try {
    // SYNC: this literal list must match INSIDER_IDS in lib/xero-customer-sync.mjs:18 exactly —
    // no shared import enforces it. Drift means a customer shows in this review queue while
    // their orders still skip Xero (or vice versa).
    const INSIDERS = new Set(['4742401425601', '5163530813633']);
    const mapPath = path.join(__dirname, 'data', 'shopify_to_xero_mapping.json');
    let mapped = new Set();
    try {
      const m = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      mapped = new Set(Object.keys(m.by_shopify_id || {}));
    } catch (e) {
      console.warn('[xero-review] map read failed:', e.message);
    }
    const list = listCustomersFromCache({ segment: 'b2b', limit: 999 });
    return (Array.isArray(list) ? list : []).filter(c => {
      const id = String(c.id || '').replace(/^gid:\/\/shopify\/Customer\//, '');
      return id && !mapped.has(id) && !INSIDERS.has(id);
    }).map(c => ({
      id:          String(c.id || '').replace(/^gid:\/\/shopify\/Customer\//, ''),
      displayName: c.displayName,
      company:     c.company || null,
      email:       c.email,
      spend:       parseFloat(c.amountSpent?.amount || 0),
      orders:      c.numberOfOrders || 0,
    }));
  } catch (err) {
    console.error('[xero-review] error:', err.message);
    return [];
  }
}

// ── PWA icon generator ────────────────────────────────────────────────────────
// Creates a minimal RGB PNG at startup (lime green #9BBC0E with "FW" approximated).
// WHAT: Hand-roll a solid-color RGB PNG at startup (no image lib) — builds CRC32 table, IHDR/IDAT(zlib.deflateSync)/IEND chunks for the PWA icon.
// CHANGE-GUARD: byte layout is hand-encoded — IHDR is 8-bit/colortype-2 (truecolor RGB); each scanline is prefixed with a 0 filter byte (rowSize = 1 + size*3). Any change to bit depth/color type must update the IHDR bytes (ihdr[8..12]) and the raw buffer stride together.
// INVARIANT(S): only called when public/icon-192.png is absent; output must be a valid PNG (magic bytes 137,80,78,71,13,10,26,10) — manifest.json references /icon-192.png at 192x192.
function generateIconPng(size, r, g, b) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
// WHAT: Standard PNG CRC32 over a chunk's type+data using the precomputed crcTable.
// CHANGE-GUARD: must stay the IEEE 802.3 / PNG polynomial (0xEDB88320) with 0xFFFFFFFF init+final-XOR; any drift produces 'CRC error' / unreadable icons.
// INVARIANT(S): operates on bytes; result coerced to unsigned 32-bit (>>> 0).
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const typeBuf = Buffer.from(type);
    const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }
  const rowSize = 1 + size * 3;
  const raw = Buffer.allocUnsafe(size * rowSize);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * rowSize + 1 + x * 3;
      raw[i] = r; raw[i+1] = g; raw[i+2] = b;
    }
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// WHAT: One-time startup generation of the PWA icon (lime #9BBC0E) if it doesn't already exist on disk.
// CHANGE-GUARD: synchronous fs at module load — runs before the server listens; if public/ is missing this throws at boot. Color 0x9B,0xBC,0x0E must match manifest theme_color.
// INVARIANT(S): idempotent — guarded by fs.existsSync so it never overwrites an existing/custom icon.
const ICON_PATH = path.join(__dirname, 'public', 'icon-192.png');
if (!fs.existsSync(ICON_PATH)) {
  fs.writeFileSync(ICON_PATH, generateIconPng(192, 0x9B, 0xBC, 0x0E));
}

// ── Routes ────────────────────────────────────────────────────────────────────

// WHAT: Liveness probe — returns {ok,app,ts}; NO auth (intentionally public for load balancer / uptime checks).
// CHANGE-GUARD: keep unauthenticated and side-effect-free; downstream monitors key off ok:true.
// INVARIANT(S): must stay above requireAuth-protected routes so probes never redirect to /login.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, app: 'fww-b2b-admin', ts: Date.now() });
});

// WHAT: PWA web app manifest (standalone display, lime theme, single 192x192 icon).
// CHANGE-GUARD: icons[].src '/icon-192.png' must match ICON_PATH / generateIconPng output; theme_color #9BBC0E is the brand lime used app-wide.
// INVARIANT(S): public/unauthenticated; start_url '/' (the auth-gated dashboard) — installing the PWA still lands on the login redirect if no session.
app.get('/manifest.json', (_req, res) => {
  res.json({
    name: 'FWW Admin',
    short_name: 'FWWadmin',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#9BBC0E',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
  });
});

// Mock: seed session
// WHAT: TEST-ONLY backdoor that mints a real authenticated session for an arbitrary email and sets the session cookie.
// CHANGE-GUARD: this BYPASSES the entire Google-OAuth allowlist — it is gated by MOCK || B2B_ADMIN_ALLOW_TEST_SESSION==='1'. NEVER let that env var be set in production; re-verify the 404 guard before any deploy.
// INVARIANT(S): in real (non-MOCK) prod with the env unset it must return 404 'not found' — otherwise anyone can become any allowed admin.
app.get('/__test__/session', (req, res) => {
  if (!MOCK && process.env.B2B_ADMIN_ALLOW_TEST_SESSION !== '1') return res.status(404).json({ error: 'not found' });
  const email = req.query.email || 'alex@fuzzywumpets.com';
  const displayName = req.query.name || 'Alex (Test)';
  const sid = crypto.randomBytes(32).toString('hex');
  createSession(sid, email, displayName, '');
  res.setHeader('Set-Cookie', sessionCookie(sid));
  res.json({ ok: true, sid, email });
});

// Auth
// WHAT: Start Google OAuth — sets an oauth_state CSRF cookie (HttpOnly, SameSite=Lax, 5min) then redirects to Google's consent screen; in MOCK it just mints a session and redirects to /.
// CHANGE-GUARD: state cookie and the state query param sent to Google MUST be the same value verified in the callback; scope 'openid email profile' and prompt 'select_account' are deliberate. redirect_uri must equal REDIRECT_URI registered in the Google console.
// INVARIANT(S): MOCK shortcut must never run in prod (no allowlist check there).
app.get('/auth/login', (req, res) => {
  if (MOCK) {
    const sid = crypto.randomBytes(32).toString('hex');
    createSession(sid, 'alex@fuzzywumpets.com', 'Alex (Mock)', '');
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return res.redirect('/');
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'openid email profile',
    access_type: 'offline', prompt: 'select_account', state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// WHAT: Google OAuth2 code->token->userinfo exchange; admits a session only if email_verified AND the lowercased email is in B2B_ADMIN_ALLOWED_EMAILS.
// CHANGE-GUARD: re-test the allowlist gate, the oauth_state CSRF check, and that the state cookie is cleared on success; weakening any check opens the whole dashboard.
// INVARIANT(S): state must equal the oauth_state cookie before token exchange; only verified + allowlisted emails get createSession; redirect_uri must match REDIRECT_URI registered in Google console (MOCK vs prod differ).
// WHAT: OAuth callback — verifies CSRF state, exchanges code for tokens, fetches userinfo, then admits a session ONLY for verified + allowlisted emails.
// CHANGE-GUARD: do not weaken any of: state===oauth_state cookie, user.email_verified, ALLOWED_EMAILS membership (case-insensitive). On success the oauth_state cookie is cleared and the session cookie set; non-allowed emails get a 403 renderUnauthorized.
// INVARIANT(S): token/userinfo fetch failures redirect to /login with an error (never admit a session); client_secret comes from GOOGLE_CLIENT_SECRET env — never log tokens.
app.get('/auth/google/callback', async (req, res) => {
  if (MOCK) return res.redirect('/');
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent('Google: ' + error)}`);
  const storedState = getCookie(req, 'oauth_state');
  if (!state || state !== storedState)
    return res.redirect('/login?error=Invalid+OAuth+state+%E2%80%94+please+try+again');
  try {
    // Per-step timing: if login ever feels slow, journalctl shows WHICH leg ate the time.
    const tTok = Date.now();
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) return res.redirect('/login?error=OAuth+token+exchange+failed');
    const tokens = await tokenRes.json();
    const tUser = Date.now();
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) });
    if (!userRes.ok) return res.redirect('/login?error=Failed+to+fetch+user+info');
    const user = await userRes.json();
    const tokMs = tUser - tTok, userMs = Date.now() - tUser;
    if (tokMs + userMs > 1000) console.log(`[auth-timing] token-exchange=${tokMs}ms userinfo=${userMs}ms`);
    if (!user.email_verified) return res.redirect('/login?error=Google+email+not+verified');
    const emailLower = (user.email || '').toLowerCase();
    if (!currentAllowedEmails().some(e => e.toLowerCase() === emailLower))
      return res.status(403).send(renderUnauthorized(user.email));
    const sid = crypto.randomBytes(32).toString('hex');
    createSession(sid, user.email, user.name || user.email, user.picture || '');
    auditLog(user.email, 'login', null, null, { ip: req.ip });
    res.setHeader('Set-Cookie', ['oauth_state=; Path=/; HttpOnly; Max-Age=0', sessionCookie(sid)]);
    res.redirect('/');
  } catch (err) {
    res.redirect(`/login?error=${encodeURIComponent('Authentication error: ' + err.message)}`);
  }
});

// WHAT: Destroy the server-side session (deleteSession) + audit-log the logout, then expire the cookie and redirect to /login.
// CHANGE-GUARD: must both deleteSession AND clear the cookie — clearing only the cookie leaves a live session id reusable.
// INVARIANT(S): tolerant of a missing/already-dead session (no-op then expire cookie).
// POST (not GET) so a cross-site link/image cannot force-logout an admin (SameSite=Lax sends the
// cookie on top-level GET navigations). The header "Sign out" is now a POST form button.
app.post('/auth/logout', (req, res) => {
  const sid = getCookie(req, COOKIE_NAME);
  if (sid) {
    const session = getSession(sid);
    if (session) { auditLog(session.email, 'logout', null, null, null); deleteSession(sid); }
  }
  res.setHeader('Set-Cookie', sessionCookie(null, true));
  res.redirect('/login');
});

// WHAT: Render the login page (Google button), passing through any ?error; redirects already-authenticated users to /.
// CHANGE-GUARD: req.query.error is rendered — ensure renderLogin escapes it (reflected-XSS surface, error strings come from the OAuth redirect chain).
// INVARIANT(S): public route; the authed-redirect prevents a logged-in admin from seeing the login form.
app.get('/login', (req, res) => {
  if (getSession(getCookie(req, COOKIE_NAME))) return res.redirect('/');
  res.send(renderLogin(req.query.error || null));
});

// Dashboard
// WHAT: Authenticated dashboard — getDashboardData() then renderDashboard; on error still renders a dashboard shell with an error banner and zeroed widgets.
// CHANGE-GUARD: the 500 fallback object must keep every field renderDashboard reads (openOrdersCount, openOrders, weekOrdersCount, topCustomers, lowStockItems) or the error page itself throws.
// INVARIANT(S): requireAuth populates req.adminSession; this is the start_url landing page.
app.get('/', requireAuth, async (req, res) => {
  try {
    const data = await getDashboardData();
    res.send(renderDashboard(req.adminSession, data));
  } catch (err) {
    res.status(500).send(renderDashboard(req.adminSession, { error: err.message, openOrdersCount:0, openOrders:[], weekOrdersCount:0, topCustomers:[], lowStockItems:[] }));
  }
});

// ── Orders ──
// MUST define /orders/new and /orders/bulk BEFORE /orders/:id
// WHAT: Orders list — reads q/source/status/date/after/success query filters and renders the paginated table.
// CHANGE-GUARD: ROUTE ORDER IS LOad-BEARING — /orders/new, /orders/bulk and /orders/export.csv MUST be registered before /orders/:id (see banner) or ':id' captures 'new'/'export.csv'. 'after' is the opaque Shopify cursor for pagination.
// INVARIANT(S): filters object shape must match getOrdersData + renderOrdersList expectations; all values default to '' (never undefined).
app.get('/orders', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', source: req.query.source || '', status: req.query.status || '', date: req.query.date || '', after: req.query.after || '', success: req.query.success || '' };
  const data = await getOrdersData(filters);
  res.send(renderOrdersList(req.adminSession, data, filters));
});

// WHAT: Render the manual new-order form, optionally prefilling the customer from ?customer=<numericId>.
// CHANGE-GUARD: must be declared BEFORE /orders/:id. Prefill resolves via MOCK_CUSTOMERS in mock or getCustomerDetail live — a bad/unknown id yields null (form just starts empty), not a 404.
// INVARIANT(S): ?customer is a bare numeric id; renderNewOrderForm serializes it into the client form state.
app.get('/orders/new', requireAuth, async (req, res) => {
  let prefillCustomer = null;
  if (req.query.customer) {
    prefillCustomer = MOCK ? MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === req.query.customer) || null : await getCustomerDetail(req.query.customer);
  }
  res.send(renderNewOrderForm(req.adminSession, prefillCustomer));
});

// WHAT: Handle manual order submit — delegates to submitNewOrder, renders an error page on failure, else redirects to the new order with ?success=created.
// CHANGE-GUARD: result.error is HTML-escaped via h() into the error alert — keep that escaping. Success path trusts result.orderId for the redirect.
// INVARIANT(S): no order is created on validation failure (submitNewOrder returns {error} before any Shopify mutation).
app.post('/orders/new', requireAuth, async (req, res) => {
  const result = await submitNewOrder(req, req.adminSession);
  if (result.error) {
    res.status(400).send(layout({ title: 'New Order', session: req.adminSession, activePath: '/orders',
      content: `<div class="breadcrumb-row"><a href="/orders">← Orders</a></div>
        <div class="alert alert-error">${h(result.error)}</div>
        <a href="/orders/new" class="btn btn-secondary">← Try again</a>` }));
    return;
  }
  res.redirect(`/orders/${result.orderId}?success=created`);
});

// WHAT: Bulk order action from the list — currently only 'mark-paid'; iterates selected ids and calls orderMarkAsPaid per order (or mocks the status).
// CHANGE-GUARD: must precede /orders/:id. Per-order Shopify errors are caught+logged but NOT surfaced — a partial failure still redirects to success=marked_paid (no per-order result). If you add actions, branch on `action` and keep the empty-ids early-return.
// INVARIANT(S): ids may arrive as a single value or array — normalized via Array.isArray(ids) ? ids : [ids]. Unlike the single mark-paid route, this bulk path does NOT trigger Xero payment recording — a known asymmetry.
app.post('/orders/bulk', requireAuth, async (req, res) => {
  const { action, ids } = req.body;
  const idList = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  if (!idList.length) return res.redirect('/orders');

  if (action === 'mark-paid') {
    for (const numId of idList) {
      if (MOCK) {
        const prev = mockOrderOverrides.get(numId) || {};
        mockOrderOverrides.set(numId, { ...prev, displayFinancialStatus: 'PAID' });
      } else {
        try {
          await shopifyFetch(`mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!){
            orderMarkAsPaid(input:$input){ order{id displayFinancialStatus} userErrors{field message} }
          }`, { input: { id: shopifyOrderGid(numId) } });
        } catch (err) { console.error('bulk mark-paid error:', err.message); }
      }
      auditLog(req.adminSession.email, 'mark_paid', shopifyOrderGid(numId), null, null);
    }
  }
  res.redirect('/orders?success=marked_paid');
});

// Phase 4: Orders CSV export (must be before /orders/:id to avoid route conflict)
// WHAT: Stream all b2b-portal orders as CSV (filename dated YYYY-MM-DD) by paging Shopify orders(query:tag:b2b-portal) at first:250.
// CHANGE-GUARD: MUST be before /orders/:id (banner). Header row + per-row column order are coupled to csvLine — keep them aligned. tags are pipe-joined; note is raw (csvLine must quote/escape).
// INVARIANT(S): pagination is HARD-CAPPED at 20 pages * 250 = 5000 orders — beyond that the export SILENTLY truncates with no warning to the user. Only tag:b2b-portal orders are exported.
app.get('/orders/export.csv', requireAuth, async (req, res) => {
  const ts = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fww-b2b-orders-${ts}.csv"`);
  res.write(csvLine(['order_number','date','customer','email','financial_status','fulfillment_status','total','tags','note']));
  const orders = MOCK
    ? MOCK_ORDERS
    : await (async () => {
        const all = [];
        let after = null;
        for (let page = 0; page < 20; page++) {
          const result = await shopifyFetch(
            `query($q:String!,$first:Int!,$after:String){orders(first:$first,query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){edges{cursor node{name processedAt customer{displayName email} displayFinancialStatus displayFulfillmentStatus totalPriceSet{presentmentMoney{amount}} note tags}}pageInfo{hasNextPage endCursor}}}`,
            { q: 'tag:b2b-portal', first: 250, after });
          const edges = result.data?.orders?.edges || [];
          all.push(...edges.map(e => e.node));
          if (!result.data?.orders?.pageInfo?.hasNextPage) break;
          after = result.data.orders.pageInfo.endCursor;
        }
        return all;
      })();
  for (const o of orders) {
    res.write(csvLine([
      o.name,
      o.processedAt ? o.processedAt.slice(0,10) : '',
      o.customer?.displayName || '',
      o.customer?.email || '',
      o.displayFinancialStatus || '',
      o.displayFulfillmentStatus || '',
      o.totalPriceSet?.presentmentMoney?.amount || '',
      Array.isArray(o.tags) ? o.tags.join('|') : (o.tags || ''),
      o.note || '',
    ]));
  }
  res.end();
});

// WHAT: Order detail — fetch by id; if not found, treat :id as an order NAME/number and redirect to the canonical /orders/<shopify_id>; else 404. Attaches portal visibleNotes (read-only).
// CHANGE-GUARD: keep this LAST among /orders/* GETs. The name-fallback (getOrderByName) lets bare numbers like '37055' resolve — don't remove without updating links. ?success/?error/?msg are passed to the renderer for flash.
// INVARIANT(S): shopifyId is normalized to a gid:// form before getVisibleNotesForOrder; visibleNotes attach is best-effort and must not block rendering.
app.get('/orders/:id', requireAuth, async (req, res) => {
  let order = await getOrderDetail(req.params.id);
  if (!order) {
    // Fallback: treat req.params.id as an order name/number (e.g. "37055" for "#37055")
    const cached = getOrderByName(req.params.id);
    if (cached) return res.redirect(`/orders/${cached.shopify_id}`);
  }
  if (!order) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/orders',
    content: '<div class="page-header"><h1>Order not found</h1></div><a href="/orders" class="btn btn-secondary">← Orders</a>' }));
  // Attach visible notes from portal db (readonly)
  const shopifyId = order.id.startsWith('gid://') ? order.id : `gid://shopify/Order/${order.id}`;
  order.visibleNotes = getVisibleNotesForOrder(shopifyId);
  // Staff-only internal note (admin-local, keyed by numeric order id) — never synced/invoiced
  order.internalNote = getOrderInternalNote(req.params.id)?.body || '';
  res.send(renderOrderDetail(req.adminSession, order, req.query.success || req.query.error || '', req.query.msg || ''));
});

// WHAT: Mark a single order paid in Shopify (orderMarkAsPaid), audit it, then fire-and-forget record the payment in Xero (creating the invoice first if unsynced), skipping insiders.
// CHANGE-GUARD: Xero side is non-blocking and queues via addXeroPending('record_payment',...) on failure — re-test that a Xero outage still returns success=marked_paid to the user AND lands in the retry queue. Payment amount is order total presentmentMoney; deposited to accountMap.chase_checking.
// INVARIANT(S): Shopify userErrors abort with ?error before any Xero work; isInsider(customerId) must short-circuit Xero (insiders never post to accounting); this single-order path DOES record Xero payment whereas /orders/bulk mark-paid does NOT.
app.post('/orders/:id/mark-paid', requireAuth, async (req, res) => {
  const numId = req.params.id;
  if (MOCK) {
    const prev = mockOrderOverrides.get(numId) || {};
    mockOrderOverrides.set(numId, { ...prev, displayFinancialStatus: 'PAID' });
  } else {
    try {
      const r = await shopifyFetch(`mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!){
        orderMarkAsPaid(input:$input){ order{id displayFinancialStatus} userErrors{field message} }
      }`, { input: { id: shopifyOrderGid(numId) } });
      const ue = r.data?.orderMarkAsPaid?.userErrors || [];
      if (ue.length) return res.redirect(`/orders/${numId}?error=${encodeURIComponent(ue[0].message)}`);
    } catch (err) {
      return res.redirect(`/orders/${numId}?error=${encodeURIComponent(err.message)}`);
    }
  }
  auditLog(req.adminSession.email, 'mark_paid', shopifyOrderGid(numId), null, null);

  // Trigger Xero payment recording (non-blocking — queue on failure)
  (async () => {
    try {
      // Phase 21: skip Xero entirely for insider customers
      const order = await getOrderDetail(numId);
      const customerId = order?.customer?.id ? shopifyNumericId(order.customer.id) : null;
      if (customerId && isInsider(customerId)) {
        console.log('[xero] skipping payment record for insider customer', customerId, 'order', numId);
        return;
      }
      const accountMap = getXeroAccountMap();
      const xeroEntry  = getXeroMap(numId);
      let xeroInvoiceId = xeroEntry?.xero_invoice_id;
      if (!xeroInvoiceId) {
        // Try to create invoice first if not yet synced
        if (order) xeroInvoiceId = await createXeroInvoice(order, accountMap);
      }
      if (xeroInvoiceId) {
        // CURRENT-FIELDS (2026-06-29): pay the CURRENT total (post-edit truth) — the frozen totalPriceSet
        // would over-pay an edited order (e.g. $921.72 instead of $601.24 on #37639).
        const amount = order ? deriveCurrentOrderTotals(order).total : 0;
        await recordXeroPayment(numId, xeroInvoiceId, amount, null, accountMap.chase_checking);
        auditLog(req.adminSession.email, 'xero:payment_recorded', shopifyOrderGid(numId), null, { xeroInvoiceId, amount });
      }
    } catch (err) {
      console.error('Xero payment record failed (queued):', err.message);
      const xeroEntry = getXeroMap(numId);
      addXeroPending('record_payment', { orderId: numId, xeroInvoiceId: xeroEntry?.xero_invoice_id || null, error: err.message });
    }
  })();

  res.redirect(`/orders/${numId}?success=marked_paid`);
});

// WHAT: Save the internal order note (orderUpdate) — note truncated to 2000 chars; audit-logged.
// CHANGE-GUARD: the 2000-char slice is the only length guard; Shopify userErrors are surfaced via ?error redirect. This is the INTERNAL note (order.note), distinct from customer-visible notes handled elsewhere.
// INVARIANT(S): note is coerced to String before slice (handles missing/array body).
app.post('/orders/:id/note', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const note  = String(req.body.note || '').slice(0, 2000);
  if (MOCK) {
    const prev = mockOrderOverrides.get(numId) || {};
    mockOrderOverrides.set(numId, { ...prev, note });
  } else {
    try {
      const r = await shopifyFetch(`mutation orderUpdate($input:OrderInput!){
        orderUpdate(input:$input){ order{id note} userErrors{field message} }
      }`, { input: { id: shopifyOrderGid(numId), note } });
      const ue = r.data?.orderUpdate?.userErrors || [];
      if (ue.length) return res.redirect(`/orders/${numId}?error=${encodeURIComponent(ue[0].message)}`);
    } catch (err) {
      return res.redirect(`/orders/${numId}?error=${encodeURIComponent(err.message)}`);
    }
  }
  auditLog(req.adminSession.email, 'update_note', shopifyOrderGid(numId), null, { note });
  res.redirect(`/orders/${numId}?success=note_saved`);
});

// WHAT: Save the staff-only INTERNAL order note (admin-local order_internal_notes table).
// Never synced to Shopify, never on the invoice. Empty body clears it (delete).
app.post('/orders/:id/internal-note', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const note  = String(req.body.note || '').slice(0, 4000);
  setOrderInternalNote(numId, note, req.adminSession.email);
  auditLog(req.adminSession.email, note.trim() ? 'update_internal_note' : 'delete_internal_note', shopifyOrderGid(numId), null, null);
  res.redirect(`/orders/${numId}?success=note_saved`);
});

// WHAT: Update the order's shipping address via Shopify orderUpdate (OrderInput.shippingAddress).
// CHANGE-GUARD: province/country are passed as the values the form was prefilled with (Shopify
// returns names like "Illinois"/"United States"); Shopify resolves names or codes. address2/phone
// may be empty (optional). MOCK mode stores the address on the in-memory override.
app.post('/orders/:id/shipping-address', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const b = req.body || {};
  const addr = {
    firstName: String(b.firstName || '').trim(),
    lastName:  String(b.lastName  || '').trim(),
    address1:  String(b.address1  || '').trim(),
    address2:  String(b.address2  || '').trim(),
    city:      String(b.city      || '').trim(),
    province:  String(b.province  || '').trim(),
    zip:       String(b.zip       || '').trim(),
    country:   String(b.country   || '').trim(),
    phone:     String(b.phone     || '').trim(),
  };
  if (MOCK) {
    const prev = mockOrderOverrides.get(numId) || {};
    mockOrderOverrides.set(numId, { ...prev, shippingAddress: addr });
  } else {
    try {
      const r = await shopifyFetch(`mutation orderUpdate($input:OrderInput!){
        orderUpdate(input:$input){ order{ id shippingAddress{ address1 city province zip } } userErrors{ field message } }
      }`, { input: { id: shopifyOrderGid(numId), shippingAddress: addr } });
      const ue = r.data?.orderUpdate?.userErrors || [];
      if (ue.length) return res.redirect(`/orders/${numId}?error=${encodeURIComponent(ue[0].message)}`);
    } catch (err) {
      return res.redirect(`/orders/${numId}?error=${encodeURIComponent(err.message)}`);
    }
  }
  auditLog(req.adminSession.email, 'update_shipping_address', shopifyOrderGid(numId), null, { address: `${addr.address1}, ${addr.city} ${addr.province} ${addr.zip}` });
  res.redirect(`/orders/${numId}?success=address_saved`);
});

// WHAT: STUB — logs intent to send a Chase Pay invoice link; returns success without calling any real Chase API.
// CHANGE-GUARD: when wiring the real Chase API, replace the auditLog-only body; the route currently 404s only if the order is missing and otherwise always 'succeeds'. Responds JSON when content-type is JSON, else redirects with success=chase_invoice_queued.
// INVARIANT(S): no payment is actually requested yet — callers/UI must not imply the customer was charged. Audit note explicitly records 'not yet wired'.
app.post('/orders/:id/send-chase-invoice', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const customerEmail = order.customer?.email || 'unknown';
  // Stub mode: log intent, return success. When Chase API is wired, replace this with real call.
  auditLog(req.adminSession.email, 'chase_invoice_queued', shopifyOrderGid(numId), null, {
    order_name: order.name,
    customer_email: customerEmail,
    note: 'Chase API not yet wired — logged intent only',
  });
  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true, status: 'stubbed', message: 'Chase invoice intent logged. Wire Chase API to send real link.' });
  }
  res.redirect(`/orders/${numId}?success=chase_invoice_queued`);
});


// ── Invoice CSV export ────────────────────────────────────────────────────────
// WHAT: Build the per-order invoice CSV from selected columns (cols[]) — discovers up to 3 variant option names from line items, then emits header + one row per line item.
// CHANGE-GUARD: variant2/variant3 columns are conditional on optionNames[1]/[2] EXISTING — header and row inclusion logic must stay symmetric (both gated by the same condition) or columns misalign. wholesale falls back discountedUnitPrice -> originalUnitPrice -> 0; line total = wholesale*qty.
// INVARIANT(S): output uses CRLF (\r\n) line endings and quotes every field with ""-doubling — Excel-safe; 'Default Title' variant value is blanked. Retail = originalUnitPrice, wholesale = discounted price; keep these two distinct.
function buildInvoiceCsv(order, cols) {
  const lineItems = order.lineItems?.edges?.map(e => e.node) || [];
  // Discover option names from first item that has them
  const optionNames = [];
  for (const item of lineItems) {
    (item.variant?.selectedOptions || []).forEach((o, i) => {
      if (!optionNames[i]) optionNames[i] = o.name;
    });
    if (optionNames.length >= 3) break;
  }
  const headers = [];
  if (cols.includes('title'))    headers.push('Product');
  if (cols.includes('variant1')) headers.push(optionNames[0] || 'Variant 1');
  if (cols.includes('variant2') && optionNames[1]) headers.push(optionNames[1]);
  if (cols.includes('variant3') && optionNames[2]) headers.push(optionNames[2]);
  if (cols.includes('upc'))      headers.push('UPC / Barcode');
  if (cols.includes('sku'))      headers.push('SKU');
  if (cols.includes('retail'))   headers.push('Retail Price');
  if (cols.includes('wholesale'))headers.push('Wholesale Price');
  if (cols.includes('qty'))      headers.push('Qty');
  if (cols.includes('total'))    headers.push('Line Total');
  const rows = [headers];
  for (const item of lineItems) {
    // CURRENT-FIELDS (2026-06-29): invoice the order's CURRENT lines. qty + Line Total key off
    // currentQuantity (post-edit truth), falling back to the frozen `quantity` for unedited orders
    // (where currentQuantity is absent). Lines fully removed in an edit (currentQuantity 0) are SKIPPED
    // entirely — Shopify retains them on the order but they're no longer part of it. getOrderDetail
    // (the only feeder of this fn) already selects currentQuantity per line.
    const currentQty = lineItemCurrentQty(item);
    if (currentQty <= 0) continue;
    // ORDER-LEVEL discount fix: wholesale (unit) + Line Total must be net of ALL discounts incl
    // order/cart-level (targetSelection ALL) ones, so Σ Line Total == currentSubtotalPriceSet. The
    // shared lineItemTrue* helpers (pdf.mjs) own this math; the CSV and PDF must agree. For #37637
    // (50% ACROSS) wholesale drops from 45.99→22.99; for per-line-discounted #37639 it is unchanged.
    const wholesale = lineItemTrueUnit(item);
    const lineTotal = lineItemTrueTotal(item);
    const retail    = parseFloat(item.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
    const opts = item.variant?.selectedOptions || [];
    const row = [];
    if (cols.includes('title'))    row.push(item.title || '');
    if (cols.includes('variant1')) { const v = opts[0]?.value || ''; row.push(v === 'Default Title' ? '' : v); }
    if (cols.includes('variant2') && optionNames[1]) row.push(opts[1]?.value || '');
    if (cols.includes('variant3') && optionNames[2]) row.push(opts[2]?.value || '');
    if (cols.includes('upc'))      row.push(item.variant?.barcode || '');
    if (cols.includes('sku'))      row.push(item.variant?.sku || '');
    if (cols.includes('retail'))   row.push(retail.toFixed(2));
    if (cols.includes('wholesale'))row.push(wholesale.toFixed(2));
    if (cols.includes('qty'))      row.push(String(currentQty));
    if (cols.includes('total'))    row.push(lineTotal.toFixed(2));
    rows.push(row);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

// WHAT: streams an order invoice as CSV; ?cols selects/orders columns (default title,variant1,variant2,sku,wholesale,qty,total).
// CHANGE-GUARD: leading '﻿' BOM on res.send is intentional for Excel UTF-8 autodetect — do not strip; keep filename sanitizer regex /[^a-z0-9\-_#]/gi in sync with the .pdf route.
// INVARIANT(S): requireAuth gates all order routes; cols come straight from the query string into buildInvoiceCsv — buildInvoiceCsv must whitelist/ignore unknown column names (no arbitrary property access).
app.get('/orders/:id/invoice.csv', requireAuth, async (req, res) => {
  const order = await getOrderDetail(req.params.id);
  if (!order) return res.status(404).send('Order not found');
  const cols = String(req.query.cols || 'title,variant1,variant2,sku,wholesale,qty,total').split(',').map(s => s.trim());
  const csv = buildInvoiceCsv(order, cols);
  const safeName = (order.name || req.params.id).replace(/[^a-z0-9\-_#]/gi, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-invoice.csv"`);
  res.send('﻿' + csv);  // BOM for Excel UTF-8 detection
});

// WHAT: renders the full-order invoice PDF inline (Content-Disposition: inline) via generateInvoicePdf(order).
// CHANGE-GUARD: generateInvoicePdf is async and may throw — keep the try/catch; a 500 here means the PDF lib failed, not a missing order (that is a 404 above).
// INVARIANT(S): 404 returns JSON but the success path returns binary PDF; callers must branch on Content-Type, not status alone.
app.get('/orders/:id/invoice.pdf', requireAuth, async (req, res) => {
  const order = await getOrderDetail(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const pdf = await generateInvoicePdf(order);
    const safeName = (order.name || 'invoice').replace(/[^a-z0-9#-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WHAT: HTML viewer wrapping an order's invoice PDF so there is ALWAYS a "← Back to order"
// path — the raw /invoice.pdf opens in the browser's bare PDF viewer, which traps the user
// (alexa 2026-07-01). Embeds the PDF in an iframe; ?letter=X shows a partial invoice. The raw
// PDF stays available at /invoice.pdf (iframe src + "Open / print" link).
app.get('/orders/:id/invoice', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/orders',
    content: '<div class="page-header"><h1>Order not found</h1></div><a href="/orders" class="btn btn-secondary">← Orders</a>' }));
  const letter = String(req.query.letter || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  const orderLabel = order.name || ('#' + numId);
  const pdfUrl = letter
    ? `/orders/${encodeURIComponent(numId)}/partial-invoice/${letter}.pdf`
    : `/orders/${encodeURIComponent(numId)}/invoice.pdf`;
  const content = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <a href="/orders/${h(numId)}" class="btn btn-secondary">← Back to order ${h(orderLabel)}</a>
      <div style="display:flex;align-items:center;gap:8px">
        <h1 style="margin:0;font-size:16px">Invoice ${h(orderLabel)}${letter ? ('-' + h(letter)) : ''}</h1>
        <a href="${h(pdfUrl)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Open / print ↗</a>
      </div>
    </div>
    <iframe title="Invoice PDF" src="${h(pdfUrl)}" style="width:100%;height:82vh;border:1px solid var(--border,#e2e2dd);border-radius:8px;background:#fff"></iframe>
  `;
  res.send(layout({ title: `Invoice ${orderLabel}`, session: req.adminSession, activePath: '/orders', content }));
});

// ── Phase 16E: Partial invoices ──────────────────────────────────────────────

// WHAT: Phase 16E — creates a lettered partial invoice (A,B,C...) row via createPartialInvoice and streams its PDF; body {type:'full'|'fulfilled_only', shipping_handling:'first'|other}.
// CHANGE-GUARD: 'fulfilled_only' is NOT actually implemented — both branches use allLineItems (see inline 'simplified' note); if you wire real fulfilled-line detection, re-test subtotal/tax/total math and the lineItemsJson snapshot shape consumed by the re-download route.
// INVARIANT(S): getNextInvoiceLetter+createPartialInvoice are a non-atomic read-modify-write keyed on orderGid — two concurrent POSTs can collide on the same letter (see bugs[]); shipping is only billed when shipping_handling==='first' so it is charged on exactly one partial.
app.post('/orders/:id/partial-invoice', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const { type = 'full', shipping_handling = 'first' } = req.body;
  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const allLineItems = (order.lineItems?.edges || []).map(e => e.node);
  const orderGid     = `gid://shopify/Order/${numId}`;

  // WHAT: rejects the old `fulfilled_only` scope outright.
  // WHY: it never worked. Both arms of the ternary that used to live here were `allLineItems`, so a
  //   "partial" invoice billed the ENTIRE order — while the modal pre-selected that option whenever
  //   the order had any fulfillment and the stored row was badged "partial" next to the full total.
  //   Staff were told they had issued a partial invoice when they had issued a duplicate full one.
  //   Real fulfilled-line billing needs per-line fulfillment detail this query does not fetch;
  //   until that exists, refusing is the only honest behaviour.
  // CHANGE-GUARD: this server-side rejection is load-bearing even though the radio is gone from the
  //   modal — the Electron shell has been observed serving HTML cached on DISK across app restarts
  //   (see the Cache-Control note near the top of this file), so a stale page can still POST it.
  if (type === 'fulfilled_only') {
    return res.status(422).json({
      error: 'Partial invoicing by fulfilled items is not available — this order can only be invoiced in full.',
    });
  }
  const lineItems = allLineItems;

  // WHAT: shipping and tax are charged ONCE per order, on the first invoice only, and the decision is
  //   made HERE rather than trusted from the request body.
  // WHY: `shipping_handling` arrived from the client with the modal defaulting it to 'first', and tax
  //   had no gate at all. Generating two invoices without touching the radio therefore billed the full
  //   shipping twice and the full tax twice: a $100 + $10 ship + $8 tax order invoiced $118 then $108.
  // INVARIANT(S): an operator may still suppress shipping explicitly ('none'); they cannot cause it to
  //   be charged a second time. Tax follows the same once-per-order rule.
  const priorInvoices = getPartialInvoices(orderGid);
  const isFirstInvoice = priorInvoices.length === 0;

  // ORDER-LEVEL discount fix: the partial-invoice subtotal + the stored per-line snapshot must be net of
  // ALL discounts (incl order/cart-level). Sum the shared lineItemTrueTotal (post-ALL-discounts, current
  // qty) and snapshot the post-discount unit + current qty so the re-download path (which reconstructs
  // from the flat {unitPrice,quantity} shape, without discountedTotalSet/allocations) renders identically.
  const subtotal = lineItems.reduce((sum, item) => sum + lineItemTrueTotal(item), 0);
  const shippingAmt = (isFirstInvoice && shipping_handling !== 'none')
    ? parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0)
    : 0;
  const taxAmt  = isFirstInvoice
    ? parseFloat(order.totalTaxSet?.presentmentMoney?.amount || 0)
    : 0;
  const total   = subtotal + shippingAmt + taxAmt;

  const letter = getNextInvoiceLetter(orderGid);
  const invId  = createPartialInvoice({
    orderId: orderGid,
    invoiceLetter: letter,
    invoiceType: type,
    total,
    shipping: shippingAmt,
    tax: taxAmt,
    lineItemsJson: JSON.stringify(lineItems
      .filter(i => lineItemCurrentQty(i) > 0)
      .map(i => ({ id: i.id, title: i.title, quantity: lineItemCurrentQty(i), unitPrice: lineItemTrueUnit(i) }))),
    createdBy: session.email,
  });
  auditLog(session.email, 'partial_invoice_created', orderGid, null, { invoiceId: invId, letter, type, total });

  try {
    const pdf = await generateInvoicePdf(order, {
      lineItems,
      invoiceSuffix: letter,
      subtotal,
      shipping: shippingAmt,
      total,
    });
    const safeName = (order.name || 'invoice').replace(/[^a-z0-9#-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-${letter}-invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-download a previously generated partial invoice
// WHAT: re-renders a previously-created partial invoice from its stored line_items_json snapshot (matched by uppercased :letter).
// CHANGE-GUARD: reconstructs discountedUnitPriceSet/originalUnitPriceSet from the flat snapshot {unitPrice} — keep this shape aligned with what generateInvoicePdf reads and with the JSON written in the POST route.
// INVARIANT(S): subtotal is derived as inv.total - inv.shipping - inv.tax (the snapshot does not store subtotal) so the three stored fields must stay self-consistent; currency hardcoded 'USD'.
app.get('/orders/:id/partial-invoice/:letter.pdf', requireAuth, async (req, res) => {
  const numId  = req.params.id;
  const letter = req.params.letter.toUpperCase();
  const orderGid = `gid://shopify/Order/${numId}`;
  const rows = getPartialInvoices(orderGid);
  const inv  = rows.find(r => r.invoice_letter === letter);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const lineItems = JSON.parse(inv.line_items_json || '[]').map(li => ({
    id: li.id, title: li.title, quantity: li.quantity,
    discountedUnitPriceSet: { presentmentMoney: { amount: String(li.unitPrice), currencyCode: 'USD' } },
    originalUnitPriceSet:   { presentmentMoney: { amount: String(li.unitPrice), currencyCode: 'USD' } },
    variant: null,
  }));
  try {
    const pdf = await generateInvoicePdf(order, {
      lineItems,
      invoiceSuffix: letter,
      subtotal: inv.total - inv.shipping - inv.tax,
      shipping: inv.shipping,
      total: inv.total,
    });
    const safeName = (order.name || 'invoice').replace(/[^a-z0-9#-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-${letter}-invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON API — list partial invoices for an order
// WHAT: JSON list of all partial-invoice rows for an order (used by the order-detail UI to render the lettered-invoice list).
// CHANGE-GUARD: returns the raw DB rows (snake_case columns) — front-end depends on invoice_letter/total/shipping/tax field names.
// INVARIANT(S): numeric :id is wrapped to gid://shopify/Order/<id> before lookup — keep the gid prefix identical to the writer route or rows go missing.
app.get('/api/admin/orders/:id/partial-invoices', requireAuth, (req, res) => {
  const numId = req.params.id;
  const rows = getPartialInvoices(`gid://shopify/Order/${numId}`);
  res.json({ ok: true, invoices: rows });
});

// ── Phase 16: Order editing, partial fulfillment, backorder ──────────────────

// ── Phase 16H: incremental ("constantly update") order-edit core ──────────────
// WHY: the prior batch handler swallowed orderEditCommit.userErrors and the per-line
// wholesale-discount userError, then logged success + redirected ?success while NOTHING
// (or only part) persisted — the live #37583 "Got Collar" false-green. This core fixes
// that at the source: every action is its OWN atomic begin->stage->commit, EVERY userError
// (including commit) is inspected and surfaced, the committed line delta is read back, and a
// client-supplied idemKey + UNIQUE-key dedupe makes a retried/duplicated request a no-op
// (never a double-add). Actions per order are serialized by a tiny async mutex so two begins
// can't race the same calculatedOrder.

class OrderEditError extends Error {
  constructor(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.filter(Boolean).join('; ') || 'order edit failed');
    this.name = 'OrderEditError';
    this.userMessages = list.filter(Boolean);
  }
}

// WHAT: replay guard — an idemKey may only replay the SAME action+payload it committed. A reused
// key carrying DIFFERENT data is a distinct submission wrongly deduped: silently replaying drops
// the new data ($80-shipping loss, 2026-07-21 — premature "UPS world"×1@$0 committed, then the
// corrected "UPS worldwide saver"@$80 replayed the $0 result and reported ok). 409s with
// IDEM_PAYLOAD_MISMATCH so the client mints a fresh key and resubmits.
// INVARIANT(S): comparison is exact-JSON (same call site builds the payload object, so key order
// is deterministic); legacy rows with null payload_json always pass (never break an old retry).
function assertReplayPayloadMatches(existing, action, payload) {
  if (!existing || existing.payload_json == null) return;
  let same = false;
  try { same = existing.action === action && existing.payload_json === JSON.stringify(payload); } catch { same = false; }
  if (!same) {
    console.error(`[order-edit] IDEM_PAYLOAD_MISMATCH idem=${existing.idem_key} stored action=${existing.action} — refusing to replay a different payload`);
    const err = new OrderEditError(['This change reused a save-token from an earlier edit — retrying with a fresh one.']);
    err.code = 'IDEM_PAYLOAD_MISMATCH';
    throw err;
  }
}

// WHAT: shared error→HTTP mapping for the incremental order-edit routes.
// IDEM_PAYLOAD_MISMATCH → 409 + code (client auto-rekeys and resubmits once); anything else → 422.
function editErrorResponse(res, idemKey, err, label) {
  const msgs = err instanceof OrderEditError ? err.userMessages : [err.message];
  console.error(`[${label}] failed:`, msgs.join('; '));
  const body = { ok: false, idemKey, errors: msgs };
  if (err.code) body.code = err.code;
  return res.status(err.code === 'IDEM_PAYLOAD_MISMATCH' ? 409 : 422).json(body);
}

// Per-order serialization: chain of promises keyed by orderId so concurrent rapid edits
// (5 qty changes + an add fired at once) run one-at-a-time and never race a begin/commit.
const orderEditLocks = new Map(); // orderId -> Promise (tail of the chain)
function withOrderLock(orderId, fn) {
  const prev = orderEditLocks.get(orderId) || Promise.resolve();
  // Run fn after prev settles (regardless of prior outcome). `result` is what the caller awaits.
  const result = prev.then(() => fn(), () => fn());
  // The chain tail must never reject (or the next waiter would short-circuit), so swallow here.
  const tail = result.then(() => {}, () => {});
  orderEditLocks.set(orderId, tail);
  // Best-effort cleanup so the Map doesn't grow unbounded across many orders.
  tail.then(() => { if (orderEditLocks.get(orderId) === tail) orderEditLocks.delete(orderId); });
  return result;
}

// ── Order-level discount: representation, identity, and shared staging ────────
//
// WHAT: an "order discount" is a per-line Shopify MANUAL DISCOUNT APPLICATION (percentValue)
// carrying the description `Order discount: <reason>`, applied at the SAME percentage to every
// eligible line. It is NOT a line item.
//
// WHY NOT the old negative-priced custom line (2026-08-05 — THE bug this replaces): Shopify
// rejects negative custom items outright — `orderEditAddCustomItem(price:{amount:"-136.95"})`
// returns userErrors [{field:["price","amount"], message:"must be greater than or equal to 0"}],
// which became OrderEditError -> 422 on EVERY apply (reproduced live on #38616). The schema's own
// arg doc says "This value can't be negative". There is no flag or ordering that makes it work.
// Shopify also has NO order/cart-level discount mutation in the orderEdit* suite at all
// ("Order level discounts can't be added, removed or updated"), so an order discount MUST be
// synthesized as an equal percentage across the lines.
//
// CHANGE-GUARD: the DESCRIPTION prefix is now the only identity of an order discount (it used to be
// a line TITLE prefix). If you change it, existing orders' discounts become invisible to the replace
// logic and the next apply DOUBLE-DISCOUNTS. The prefix must stay byte-identical everywhere it is
// written and read.
// INVARIANT(S): percentValue (never fixedValue) — fixedValue is PER UNIT and silently CLAMPS to the
// line total with NO userErrors, so a $136.95 fixedValue on a qty-12 $12.50 line allocates $150.00
// and reports success. A fixed-$ order discount is therefore converted to its equivalent percentage
// of the goods basis before staging. Shopify permits at most ONE manual discount per line (a second
// add REPLACES the first, verified live) — see stageOrderDiscount's foreign-discount refusal.
// DEPENDS: pdf.mjs lineItemTrueTotal/lineItemTrueUnit subtract only targetSelection 'ALL'
// allocations because EXPLICIT (line-level) ones are already baked into
// discountedUnitPriceSet/discountedTotalSet. Our discounts are EXPLICIT (verified live), so the
// invoice PDF, the invoice CSV and the partial-invoice math stay correct with NO change. Do NOT
// "fix" pdf.mjs to also subtract EXPLICIT allocations — that would double-subtract every line.
const ORDER_DISCOUNT_PREFIX = 'Order discount: ';
const isOrderDiscountDescription = (d) => String(d || '').startsWith(ORDER_DISCOUNT_PREFIX);
const orderDiscountDescription = (reason) => `${ORDER_DISCOUNT_PREFIX}${reason}`;

// Flatten a committed line's discountAllocations into { amount, targetSelection, description, isOurs }.
function normalizeAllocations(allocations) {
  return (allocations || []).map(a => ({
    amount: parseFloat(a?.allocatedAmountSet?.presentmentMoney?.amount ?? 0) || 0,
    targetSelection: a?.discountApplication?.targetSelection || null,
    description: a?.discountApplication?.description || '',
    isOurs: isOrderDiscountDescription(a?.discountApplication?.description),
  }));
}

// Σ of the order-discount allocations on a committed line (0 when the line carries none).
function lineOrderDiscountAmount(line) {
  return (line.discounts || []).filter(d => d.isOurs).reduce((s, d) => s + d.amount, 0);
}

// WHAT: the order's currently-applied order discount, derived from committed line state.
// Returns { amount, reason, lineCount } — amount 0 / reason null when there is none.
// INVARIANT(S): amount is Σ allocatedAmountSet across ALL active lines (the authoritative surface —
// lineItem.totalDiscountSet is UNRELIABLE and reads 0.00 despite a real allocation, verified live).
function summarizeOrderDiscount(lines) {
  let amount = 0, reason = null, n = 0;
  for (const l of (lines || [])) {
    if ((l.currentQuantity || 0) <= 0) continue;
    const ours = (l.discounts || []).filter(d => d.isOurs);
    if (!ours.length) continue;
    n++;
    for (const d of ours) {
      amount += d.amount;
      if (reason == null) reason = d.description.slice(ORDER_DISCOUNT_PREFIX.length);
    }
  }
  return { amount: Math.round(amount * 100) / 100, reason, lineCount: n };
}

// SYNC: CALC_LINE_FIELDS — the CalculatedLineItem selection shared by orderEditBegin and by the
// orderEditRemoveDiscount payload in stageOrderDiscount. Both must return the SAME shape or the
// post-removal basis read silently falls back to stale pre-removal prices. `description` and `id`
// are on the CalculatedDiscountApplication INTERFACE (verified against live 2024-10), so no inline
// fragment is needed on this side — unlike the committed-order read in readCommittedLineState.
const CALC_LINE_FIELDS = `
  id title quantity variant{id}
  discountedUnitPriceSet{presentmentMoney{amount}}
  originalUnitPriceSet{presentmentMoney{amount}}
  calculatedDiscountAllocations{
    allocatedAmountSet{presentmentMoney{amount}}
    discountApplication{ id targetType targetSelection description }
  }
`;

// Read authoritative line state straight off the live order (NOT a calculatedOrder).
// Returns currentQuantity (Shopify retains removed/zeroed lines — UI must key off this, not quantity).
// CHANGE-GUARD (total-not-updating bug, 2026-06-29): use current*PriceSet, NOT subtotal/totalPriceSet.
// On an edited order, subtotalPriceSet / totalPriceSet stay frozen at the ORIGINAL amounts and never
// reflect removals/qty changes — that was the "the order TOTAL did not update" half of the bug.
// currentSubtotalPriceSet / currentTotalPriceSet ARE the post-edit truth. We also recompute the
// subtotal from the surviving lines (currentQuantity * unitPrice) as a belt-and-braces fallback in
// case the current* fields lag immediately after a rapid edit.
// DISCOUNT-VISIBILITY (2026-08-05): the query now also selects discountAllocations. An order
// discount is a per-line MANUAL discount application (see ORDER_DISCOUNT_PREFIX below), which is NOT
// a line — without these fields the discount is completely unobservable to the server and
// verifyFn cannot check anything. `description` lives on ManualDiscountApplication, NOT on the
// DiscountApplication interface, so the inline fragment is REQUIRED here (verified against live
// 2024-10; contrast the CALCULATED side, where description IS on the interface).
async function readCommittedLineState(orderId) {
  const r = await shopifyFetch(`query($id:ID!){order(id:$id){
    subtotalPriceSet{presentmentMoney{amount}}
    totalPriceSet{presentmentMoney{amount}}
    currentSubtotalPriceSet{presentmentMoney{amount}}
    currentTotalPriceSet{presentmentMoney{amount}}
    lineItems(first:100){edges{node{
      id title quantity currentQuantity sku
      variant{id}
      discountedUnitPriceSet{presentmentMoney{amount}}
      originalUnitPriceSet{presentmentMoney{amount}}
      discountAllocations{
        allocatedAmountSet{presentmentMoney{amount}}
        discountApplication{ targetSelection ... on ManualDiscountApplication { description } }
      }
    }}}
  }}`, { id: orderId });
  const o = r.data?.order || {};
  const edges = o?.lineItems?.edges?.map(e => e.node) || [];
  const lines = edges.map(n => ({
    liId: n.id,
    title: n.title,
    sku: n.sku || n.variant?.sku || '',
    currentQuantity: n.currentQuantity != null ? n.currentQuantity : n.quantity,
    unitPrice: parseFloat(n.discountedUnitPriceSet?.presentmentMoney?.amount ?? n.originalUnitPriceSet?.presentmentMoney?.amount ?? 0),
    discounts: normalizeAllocations(n.discountAllocations),
  }));
  // Subtotal/total + active line count use the SHARED helper so this stays in lockstep with the
  // first-paint totals in renderOrderDetail (deriveCurrentOrderTotals). Both honor the same
  // belt-and-braces fallback (prefer current*; trust Σ currentQuantity*unitPrice when current* lags).
  const { subtotal, total, lineCount } = deriveCurrentOrderTotals(o);
  return { lines, subtotal, total, lineCount };
}

// True when the calculated line already carries an order-level / stacked discount
// (targetSelection:ALL). Adding orderEditAddLineItemDiscount on top throws
// "The order has a discount which prevents applying additional discounts to this line item."
function lineHasStackedOrderDiscount(calcItem) {
  return (calcItem?.calculatedDiscountAllocations || []).some(a =>
    a?.discountApplication?.targetSelection === 'ALL');
}

// WHAT: removes EVERY previously-applied order discount from the open edit session and returns the
// refreshed calculated lines. This is the REPLACE half of the order-discount contract.
// WHY it works: a committed manual discount application is exposed again (with a stable id) on
// calculatedOrder.lineItems[].calculatedDiscountAllocations[].discountApplication after a fresh
// orderEditBegin, and orderEditRemoveDiscount accepts it. The committed Order does NOT expose the
// application id at all, so removal is ONLY ever possible inside an edit session.
// CHANGE-GUARD: do NOT add `stagedChanges` to this mutation's selection — Shopify throws an internal
// error when stagedChanges is selected in the same response as a discount removal.
// INVARIANT(S): ids are de-duplicated (one application spans many lines, so the same id appears on
// every discounted line and removing it twice would error); the returned line list REPLACES
// ctx.calcItems for the caller so the discount basis is read post-removal, never pre-removal.
async function removePriorOrderDiscounts(calcId, calcItems) {
  const priorIds = [...new Set((calcItems || []).flatMap(i =>
    (i.calculatedDiscountAllocations || [])
      .map(a => a?.discountApplication)
      .filter(da => da?.id && isOrderDiscountDescription(da.description))
      .map(da => da.id)))];
  let lines = calcItems || [];
  for (const did of priorIds) {
    const remRes = await shopifyFetch(`mutation rem($id:ID!,$did:ID!){
      orderEditRemoveDiscount(id:$id,discountApplicationId:$did){
        calculatedOrder{ id lineItems(first:100){edges{node{ ${CALC_LINE_FIELDS} }}} }
        userErrors{field message}}}`, { id: calcId, did });
    const remErrs = remRes.data?.orderEditRemoveDiscount?.userErrors || [];
    if (remErrs.length) throw new OrderEditError(remErrs.map(e => e.message));
    const fresh = remRes.data?.orderEditRemoveDiscount?.calculatedOrder?.lineItems?.edges?.map(e => e.node);
    if (fresh?.length) lines = fresh;
  }
  return { removed: priorIds.length, lines };
}

// Re-read an OPEN calculatedOrder's lines mid-session (there is no root `calculatedOrder` query
// field in 2024-10 — `node` is the only way in). Needed by the batch /edit handler, whose cached
// calcItems are stale by the time the discount is staged (qty + price mutations ran first).
async function readCalcLines(calcId) {
  const r = await shopifyFetch(`query($id:ID!){node(id:$id){ ... on CalculatedOrder {
    id lineItems(first:100){edges{node{ ${CALC_LINE_FIELDS} }}} } }}`, { id: calcId });
  return r.data?.node?.lineItems?.edges?.map(e => e.node) || [];
}

// WHAT: stages an order-level discount onto an OPEN calculatedOrder — replace-then-apply, all inside
// the caller's single orderEditBegin/commit. Returns the expectation object verifyOrderDiscount checks.
// CHANGE-GUARD: percentValue ONLY. fixedValue is per-UNIT and silently clamps to the line total with
// zero userErrors, so it cannot be used to express an order-level amount (that is the live defect in
// the legacy modal route). A fixed-$ request is converted to the equivalent percentage of the basis.
// INVARIANT(S):
//  - The basis is read from the calculated order AFTER prior order discounts are removed, so a
//    corrected % is NEVER computed on an already-discounted subtotal. (The old code achieved this by
//    excluding discount-titled LINES from the basis; there are no discount lines any more, and
//    discountedUnitPriceSet on the calculated order DOES bake in a live line discount, so removing
//    first and re-reading is what keeps the guarantee.)
//  - Shopify permits at most ONE manual discount per line — a second add REPLACES the first. So a
//    line already carrying a foreign manual discount ("B2B price adj" / "B2B wholesale") CANNOT also
//    carry an order discount. We REFUSE rather than silently overwrite it, because overwriting would
//    raise that line back toward retail and OVERCHARGE the customer.
//  - expectedAmt is derived from the ROUNDED percentage actually sent, not from the requested amount,
//    so verify compares like with like.
async function stageOrderDiscount(calcId, ctx, { pct, fixed, reason }) {
  const description = orderDiscountDescription(reason);

  const { removed, lines } = await removePriorOrderDiscounts(calcId, ctx.calcItems);
  if (removed) ctx.warnings.push(`replaced ${removed} existing order discount${removed === 1 ? '' : 's'}`);

  const eligible = [];
  const blocked = [];
  for (const it of lines) {
    const qty = it.quantity || 0;
    if (qty <= 0) continue;
    if (lineHasStackedOrderDiscount(it)) {
      throw new OrderEditError('This order carries an order-level discount applied at checkout, and Shopify refuses to add a line discount on top of it. Remove that discount in Shopify first.');
    }
    const foreign = (it.calculatedDiscountAllocations || [])
      .map(a => a?.discountApplication)
      .find(da => da && !isOrderDiscountDescription(da.description));
    if (foreign) { blocked.push(`"${it.title}" (${foreign.description || 'manual discount'})`); continue; }
    const unit = parseFloat(it.discountedUnitPriceSet?.presentmentMoney?.amount ?? it.originalUnitPriceSet?.presentmentMoney?.amount ?? 0) || 0;
    if (unit <= 0) continue;
    eligible.push({ id: it.id, title: it.title, unit, qty, lineTotal: unit * qty });
  }
  if (blocked.length) {
    throw new OrderEditError(`Shopify allows only ONE discount per line, and ${blocked.length} line(s) already carry a manual price adjustment: ${blocked.join('; ')}. Clear those line prices first, or apply the reduction as a per-line price instead.`);
  }
  if (!eligible.length) throw new OrderEditError('this order has no discountable lines');

  const basis = eligible.reduce((s, l) => s + l.lineTotal, 0);
  const requested = pct > 0 ? basis * pct / 100 : fixed;
  if (!(requested > 0)) throw new OrderEditError('computed discount is zero — nothing to apply');
  if (requested > basis + 0.005) throw new OrderEditError(`discount ${fmtMoney(requested)} exceeds the order subtotal ${fmtMoney(basis)}`);
  const effPct = parseFloat(Math.min(100, (requested / basis) * 100).toFixed(4));
  // What Shopify will actually allocate: the rounded % against each line, rounded to cents.
  const expectedAmt = Math.round(eligible.reduce((s, l) => s + Math.round(l.lineTotal * effPct) / 100, 0) * 100) / 100;
  if (fixed > 0 && Math.abs(expectedAmt - fixed) > 0.01) {
    ctx.warnings.push(`a fixed $ discount is applied as ${effPct}% across ${eligible.length} lines, landing at ${fmtMoney(expectedAmt)}`);
  }

  for (const l of eligible) {
    const r = await shopifyFetch(`mutation addDisc($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
      orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){ calculatedOrder{id} userErrors{field message}}}`,
      { id: calcId, li: l.id, d: { percentValue: effPct, description } });
    const errs = r.data?.orderEditAddLineItemDiscount?.userErrors || [];
    if (errs.length) throw new OrderEditError(errs.map(e => `"${l.title}": ${e.message}`));
  }
  return { expectedAmt, effPct, basis, description, lineCount: eligible.length };
}

// WHAT: VERIFY-OR-FAIL for an order discount, run against committed line state before the action is
// recorded `committed`. Replaces the old "exactly 1 discount line" assertion, which is unimplementable
// against an allocation (and, left in place, would have failed EVERY successful apply — a false-RED
// after the money already moved).
// INVARIANT(S): Σ allocatedAmountSet is the authoritative applied amount; exactly one distinct
// description must survive (two = a failed replace = the customer is double-discounted).
function verifyOrderDiscount(lineState, expected) {
  const active = (lineState.lines || []).filter(l => (l.currentQuantity || 0) > 0);
  const bearing = active.filter(l => (l.discounts || []).some(d => d.isOurs));
  if (!bearing.length) {
    throw new OrderEditError('the discount did not persist — no discounted line found on the order after commit (please retry)');
  }
  const descs = [...new Set(bearing.flatMap(l => l.discounts.filter(d => d.isOurs).map(d => d.description)))];
  if (descs.length !== 1) {
    throw new OrderEditError(`the order carries ${descs.length} different order discounts (${descs.join(', ')}) — it may be double-discounted; review it in Shopify`);
  }
  const applied = Math.round(bearing.reduce((s, l) => s + lineOrderDiscountAmount(l), 0) * 100) / 100;
  const tol = 0.01 * bearing.length + 0.01;   // per-line cent rounding on the synthesized percentage
  if (Math.abs(applied - expected.expectedAmt) > tol) {
    throw new OrderEditError(`discount landed at ${fmtMoney(applied)} but ${fmtMoney(expected.expectedAmt)} was intended — please re-check the order`);
  }
  if (bearing.length !== expected.lineCount) {
    return `discount applied to ${bearing.length} of ${expected.lineCount} intended lines`;
  }
}

// THE chokepoint. idempotent + atomic + serialized + userError-honest.
// stageFn(calcId, ctx) does the per-action staging; ctx exposes { calcOrder, calcItems, warnings }.
// stageFn may push human-readable strings into ctx.warnings (e.g. "added at list price — order
// already has a discount") which are returned to the client but do NOT fail the action.
// verifyFn(lineState) (optional) runs AFTER commit + readCommittedLineState but BEFORE the action
// is recorded `committed`: if it throws, the action is marked `failed` and the error surfaces —
// so the idempotency ledger never records a commit that did not actually take effect on Shopify
// (the delete-persist false-green). Returning a string from verifyFn pushes it as a warning.
async function runOrderEdit(orderId, idemKey, editedBy, action, payload, stageFn, verifyFn) {
  // [order-edit] P0 instrumentation (2026-06-29): log every save attempt + its REAL outcome so a
  // future failure shows the actual Shopify userError / exception in journalctl, not just a red pill.
  const _payloadSummary = (() => { try { const p = payload || {}; return JSON.stringify({ liId: p.liId, qty: p.qty, price: p.price, variantId: p.variantId, title: p.title ? String(p.title).slice(0,40) : undefined }); } catch { return '<unserializable>'; } })();
  console.log(`[order-edit] BEGIN action=${action} order=${orderId} idem=${idemKey} payload=${_payloadSummary}`);
  // 1) DEDUPE FIRST — never re-stage a committed action (kills the double-add hazard).
  const existing = getEditAction(idemKey);
  if (existing && existing.status === 'committed') {
    assertReplayPayloadMatches(existing, action, payload);
    try { return { ...JSON.parse(existing.result_json || '{}'), replayed: true }; }
    catch { return { replayed: true }; }
  }
  // 2) Serialize per order so two begins don't race the same calculatedOrder.
  return withOrderLock(orderId, async () => {
    // Re-check inside the lock (a concurrent request with the same key may have just committed).
    const again = getEditAction(idemKey);
    if (again && again.status === 'committed') {
      assertReplayPayloadMatches(again, action, payload);
      try { return { ...JSON.parse(again.result_json || '{}'), replayed: true }; }
      catch { return { replayed: true }; }
    }
    try {
      const beginResult = await shopifyFetch(`
        mutation begin($id:ID!){orderEditBegin(id:$id){
          calculatedOrder{ id lineItems(first:100){edges{node{ ${CALC_LINE_FIELDS} }}} }
          userErrors{field message}
        }}
      `, { id: orderId });
      const beginErrs = beginResult.data?.orderEditBegin?.userErrors || [];
      if (beginErrs.length) { console.error(`[order-edit] ${action} orderEditBegin userErrors:`, JSON.stringify(beginErrs)); throw new OrderEditError(beginErrs.map(e => e.message)); }
      const calcOrder = beginResult.data?.orderEditBegin?.calculatedOrder;
      const calcId = calcOrder?.id;
      if (!calcId) { console.error(`[order-edit] ${action} orderEditBegin returned no calculatedOrder; raw=`, JSON.stringify(beginResult.data?.orderEditBegin || beginResult.errors || beginResult).slice(0, 600)); throw new OrderEditError('orderEditBegin returned no calculatedOrder'); }
      const calcItems = calcOrder.lineItems?.edges?.map(e => e.node) || [];

      const ctx = { calcOrder, calcItems, warnings: [] };
      await stageFn(calcId, ctx);

      // Commit — and ACTUALLY READ userErrors (this is the bug the user hit).
      const commitRes = await shopifyFetch(`mutation commit($id:ID!,$notify:Boolean!,$note:String){
        orderEditCommit(id:$id,notifyCustomer:$notify,staffNote:$note){
          order{id} userErrors{field message}}}`,
        { id: calcId, notify: false, note: payload?.staffNote || null });
      const cErrs = commitRes.data?.orderEditCommit?.userErrors || [];
      if (cErrs.length) {
        // NO-OP IS NOT A FAILURE (P0 regression fix, 2026-06-29): Shopify returns
        // "There must be at least one change to be made." when the staged edit produced no net
        // change — e.g. a qty re-save to the value the order ALREADY has. Since commit a6c1735 the
        // qty input renders currentQuantity (the post-edit truth), so "confirm without changing"
        // (or a per-keystroke autosave landing on the current value) stages nothing and commit
        // 422s — which surfaced to staff as a red "Changes not saved — review" pill even though the
        // order was already in the desired state. Treat that specific userError as a SUCCESSFUL
        // no-op: read the live state and return ok:true so the pill stays green. Any OTHER commit
        // userError is still a real failure and throws.
        const isNoChange = cErrs.every(e => /at least one change/i.test(e.message || ''));
        if (isNoChange) {
          console.log(`[order-edit] ${action} commit was a NO-OP (order already in desired state) — treating as success`);
          const lineState = await readCommittedLineState(orderId);
          if (verifyFn) { const w = await verifyFn(lineState); if (typeof w === 'string' && w) ctx.warnings.push(w); }
          const result = { ok: true, idemKey, noop: true, warnings: ctx.warnings, order: { subtotal: lineState.subtotal, total: lineState.total, lineCount: lineState.lineCount }, lineState };
          putEditAction({ idemKey, orderId, action, payload, result, status: 'committed', editedBy });
          return result;
        }
        console.error(`[order-edit] ${action} orderEditCommit userErrors:`, JSON.stringify(cErrs));
        throw new OrderEditError(cErrs.map(e => e.message));
      }

      // Read authoritative committed state. VERIFY-OR-FAIL before recording committed: a
      // mis-mapped or no-op'd mutation can `commit` cleanly yet leave the targeted line
      // untouched — verifyFn re-checks the live state and throws if reality disagrees, so we
      // never record a false-green in the idempotency ledger or return ok:true to the UI.
      const lineState = await readCommittedLineState(orderId);
      if (verifyFn) {
        const w = await verifyFn(lineState);
        if (typeof w === 'string' && w) ctx.warnings.push(w);
      }
      const result = { ok: true, idemKey, warnings: ctx.warnings, order: { subtotal: lineState.subtotal, total: lineState.total, lineCount: lineState.lineCount }, lineState };
      putEditAction({ idemKey, orderId, action, payload, result, status: 'committed', editedBy });
      console.log(`[order-edit] OK action=${action} order=${orderId} idem=${idemKey} lineCount=${result.order?.lineCount} subtotal=${result.order?.subtotal} warnings=${(result.warnings||[]).length}`);
      return result;
    } catch (err) {
      const messages = err instanceof OrderEditError ? err.userMessages : [err.message];
      // [order-edit] P0: surface the REAL failure reason (userMessages or the raw stack) in journalctl.
      console.error(`[order-edit] FAIL action=${action} order=${orderId} idem=${idemKey} reason=${JSON.stringify(messages)}${err instanceof OrderEditError ? '' : '\n' + (err && err.stack ? err.stack : String(err))}`);
      putEditAction({ idemKey, orderId, action, payload, result: { ok: false, errors: messages }, status: 'failed', editedBy });
      const e = new OrderEditError(messages);
      throw e;
    }
  });
}

// MOCK helper: apply an incremental action to mockOrderOverrides and return the same shape
// the real runOrderEdit returns, with idem dedupe via order_edit_action so the mock suite can
// assert "no double-add on same idemKey". editFn(edges) mutates the edges array in place and
// returns optional { warnings }.
function mockIncrementalEdit({ numId, idemKey, action, payload, editFn, editedBy }) {
  const existing = getEditAction(idemKey);
  if (existing && existing.status === 'committed') {
    assertReplayPayloadMatches(existing, action, payload);
    try { return { ...JSON.parse(existing.result_json || '{}'), replayed: true }; }
    catch { return { replayed: true }; }
  }
  const order = getMockOrder(numId);
  if (!order) return null;
  const overrides = mockOrderOverrides.get(numId) || {};
  const baseEdges = overrides.lineItems?.edges || (order.lineItems?.edges || []);
  // deep-ish clone so we don't mutate fixtures
  const edges = baseEdges.map(e => ({ node: { ...e.node } }));
  const warnings = editFn(edges) || [];
  let subtotal = 0;
  for (const e of edges) {
    const cq = e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity;
    const price = parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount || 0);
    subtotal += price * (cq || 0);
  }
  const ship = parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0);
  overrides.lineItems = { edges };
  overrides.subtotalPriceSet = { presentmentMoney: { amount: subtotal.toFixed(2), currencyCode: 'USD' } };
  overrides.totalPriceSet    = { presentmentMoney: { amount: (subtotal + ship).toFixed(2), currencyCode: 'USD' } };
  mockOrderOverrides.set(numId, overrides);
  const lines = edges.map(e => ({
    liId: e.node.id, title: e.node.title, sku: e.node.variant?.sku || '',
    currentQuantity: e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity,
    unitPrice: parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount || 0),
    // SYNC: must mirror readCommittedLineState's `discounts` shape — the order-discount verify and
    // the line-state API read this field, so a mock that omits it hides discounts from the tests.
    discounts: normalizeAllocations(e.node.discountAllocations),
  }));
  const lineCount = lines.filter(l => (l.currentQuantity || 0) > 0).length;
  const result = { ok: true, idemKey, warnings, order: { subtotal, total: subtotal + ship, lineCount }, lineState: { lines, subtotal, total: subtotal + ship, lineCount } };
  putEditAction({ idemKey, orderId: `gid://shopify/Order/${numId}`, action, payload, result, status: 'committed', editedBy });
  return result;
}

// 16A: Edit order line items (qty changes, remove, add, price override)
// WHAT: applies qty changes, removals, per-line B2B price re-discounting, order-level discount, and custom line additions via the Shopify orderEdit* mutation suite (begin->setQuantity/removeDiscount/addLineItemDiscount/addCustomItem->commit).
// CHANGE-GUARD: this is the most fragile handler — re-test the original-li-id -> calculated-li-id mapping (matched by variant id + title) after any Shopify API-version bump; price re-discount does remove+add (NOT updateDiscount) because discounts stack on commit.
// INVARIANT(S): NON-ATOMIC across many round-trips — a mid-sequence failure leaves the calculatedOrder partially edited yet still commits; orderEditSetQuantity/remove userErrors are logged but not surfaced; commit uses notifyCustomer:false; restock:true only on full removes.
app.post('/orders/:id/edit', requireAuth, async (req, res) => {
  const numId   = req.params.id;
  const session = req.adminSession;
  const { qtys, removes, staffNote, discountPct, discountFixed, discountReason, addCustomLines, addVariantLines, prices } = req.body;
  // qtys: { lineItemId: newQty, ... }   removes: [lineItemId, ...]
  const qtysMap   = Object.fromEntries(Object.entries(qtys || {}).map(([k,v]) => [k, parseInt(v,10) || 0]));
  const removeSet = new Set([removes || []].flat());

  // Phase 16A: parse new custom-line additions
  let newCustomLines = [];
  try {
    const raw = typeof addCustomLines === 'string' ? JSON.parse(addCustomLines || '[]') : (addCustomLines || []);
    newCustomLines = (Array.isArray(raw) ? raw : []).filter(l => l && l.title && Number(l.qty) > 0 && Number(l.price) >= 0).map(l => ({
      title: String(l.title).slice(0, 200),
      qty:   parseInt(l.qty, 10),
      price: parseFloat(l.price),
    }));
  } catch (e) {
    console.warn('[order-edit] addCustomLines parse failed:', e.message);
  }

  // Phase 16F: parse new catalog (real product/variant) additions
  let newVariantLines = [];
  try {
    const raw = typeof addVariantLines === 'string' ? JSON.parse(addVariantLines || '[]') : (addVariantLines || []);
    newVariantLines = (Array.isArray(raw) ? raw : []).filter(l => l && l.variantId && Number(l.qty) > 0).map(l => ({
      variantId: String(l.variantId),
      title:     String(l.title || '').slice(0, 200),
      sku:       String(l.sku || '').slice(0, 64),
      qty:       parseInt(l.qty, 10),
      listPrice: parseFloat(l.listPrice) || 0,
      price:     Math.max(0, parseFloat(l.price) || 0),
    }));
  } catch (e) {
    console.warn('[order-edit] addVariantLines parse failed:', e.message);
  }

  const pricesMap = Object.fromEntries(Object.entries(prices || {}).map(([k,v]) => [k, parseFloat(v) || 0]));
  const changes = { qtys: qtysMap, removes: [...removeSet], prices: pricesMap, discountPct, discountFixed, discountReason, addCustomLines: newCustomLines, addVariantLines: newVariantLines };
  console.log(`[order-edit] BATCH /edit order=${numId} qtys=${Object.keys(qtysMap).length} removes=${removeSet.size} prices=${Object.keys(pricesMap).length} addCustom=${newCustomLines.length} addVariant=${newVariantLines.length} disc=${discountPct||discountFixed||'none'}`);

  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ error: 'order not found' });
    // Apply changes to mockOrderOverrides
    const overrides = mockOrderOverrides.get(numId) || {};
    const newEdges = (order.lineItems?.edges || []).filter(e => !removeSet.has(e.node.id)).map(e => {
      const newQty = qtysMap[e.node.id] ?? e.node.quantity;
      return { node: { ...e.node, quantity: newQty } };
    });
    // Phase 16F: append synthetic edges for newly added catalog variants (mock display)
    newVariantLines.forEach((l, i) => {
      newEdges.push({ node: {
        id: `gid://shopify/LineItem/new-variant-${i}`,
        title: l.title || 'Catalog item',
        quantity: l.qty,
        variant: { id: `gid://shopify/ProductVariant/${l.variantId}`, sku: l.sku || '' },
        discountedUnitPriceSet: { presentmentMoney: { amount: l.price.toFixed(2), currencyCode: 'USD' } },
        originalUnitPriceSet:   { presentmentMoney: { amount: (l.listPrice || l.price).toFixed(2), currencyCode: 'USD' } },
      } });
    });
    overrides.lineItems = { edges: newEdges };
    // Recalculate totals
    let subtotal = 0;
    for (const e of newEdges) {
      const price = parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount || 0);
      subtotal += price * (e.node.quantity || 0);
    }
    if (discountPct) subtotal = subtotal * (1 - parseFloat(discountPct) / 100);
    if (discountFixed) subtotal = subtotal - parseFloat(discountFixed);
    overrides.subtotalPriceSet = { presentmentMoney: { amount: subtotal.toFixed(2), currencyCode: 'USD' } };
    overrides.totalPriceSet    = { presentmentMoney: { amount: (subtotal + parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0)).toFixed(2), currencyCode: 'USD' } };
    mockOrderOverrides.set(numId, overrides);
    logOrderEdit(`gid://shopify/Order/${numId}`, session.email, staffNote, changes);
    auditLog(session.email, 'order_edit', `gid://shopify/Order/${numId}`, null, changes);
    return res.redirect(`/orders/${numId}?success=order_edited`);
  }

  // Real mode: use Shopify orderEdit* mutation suite
  try {
    const orderId = `gid://shopify/Order/${numId}`;
    // Build map original_li_id -> calc_li_id by matching variant + title.
    // orderEditBegin (starts a CalculatedOrder edit session) and the read of the original line
    // items are independent — run them concurrently to save a round-trip.
    const [beginResult, origRes] = await Promise.all([
      shopifyFetch(`
      mutation begin($id:ID!){orderEditBegin(id:$id){
        calculatedOrder{
          id
          lineItems(first:100){edges{node{
            id title quantity variant{id}
            calculatedDiscountAllocations{
              discountApplication{id targetType targetSelection}
            }
          }}}
        }
        userErrors{field message}
      }}
    `, { id: orderId }),
      // Original order line items, to pair original IDs with variant/title
      shopifyFetch(`query($id:ID!){order(id:$id){lineItems(first:100){edges{node{id title variant{id} originalUnitPriceSet{presentmentMoney{amount}} discountedUnitPriceSet{presentmentMoney{amount}}}}}}}`, { id: orderId }),
    ]);
    const calcOrder = beginResult.data?.orderEditBegin?.calculatedOrder;
    const calcId = calcOrder?.id;
    if (!calcId) {
      const errs = beginResult.data?.orderEditBegin?.userErrors || [];
      throw new Error(errs.map(e => e.message).join(', ') || 'orderEditBegin failed');
    }
    const origItems = origRes.data?.order?.lineItems?.edges?.map(e => e.node) || [];
    const calcItems = calcOrder.lineItems?.edges?.map(e => e.node) || [];
    // Map original_li_id -> calc_li_id
    const idMap = {};
    for (const orig of origItems) {
      // Match by variant id first (works for catalog items)
      let match = orig.variant?.id ? calcItems.find(c => c.variant?.id === orig.variant.id && c.title === orig.title) : null;
      // Fallback: match by title alone (custom items, no variant)
      if (!match) match = calcItems.find(c => c.title === orig.title && !c.variant);
      if (!match) match = calcItems.find(c => c.title === orig.title);
      if (match) idMap[orig.id] = match.id;
    }
    // Build map: origLiId -> { discountAppId, retailPrice, wholesalePrice }
    const discountIdMap = {};
    for (const orig of origItems) {
      const calcLiId = idMap[orig.id];
      if (!calcLiId) continue;
      const calcItem = calcItems.find(c => c.id === calcLiId);
      // Prefer explicit per-line B2B discount over admin order-level discounts (targetSelection:ALL)
      const discApp = calcItem?.calculatedDiscountAllocations
        ?.map(a => a.discountApplication)
        ?.find(da => da?.targetSelection === 'EXPLICIT')
        || calcItem?.calculatedDiscountAllocations?.[0]?.discountApplication;
      const retailPrice = parseFloat(orig.originalUnitPriceSet?.presentmentMoney?.amount || 0);
      const wholesalePrice = parseFloat(orig.discountedUnitPriceSet?.presentmentMoney?.amount || retailPrice);
      if (discApp?.id && retailPrice > 0) {
        discountIdMap[orig.id] = { discountAppId: discApp.id, retailPrice, wholesalePrice };
      }
    }
    // Apply qty changes using calculated line item IDs. The edit form submits a qty field for
    // EVERY line, so skip lines whose quantity already equals the calculated order's current
    // quantity — otherwise a large order fires one Shopify mutation per line on every Save, even
    // when nothing changed (the 30s+ "Save changes" hang, especially after incremental auto-save
    // already persisted the edits — every line then re-sends its unchanged qty). Removes always fire.
    const calcQtyById = new Map(calcItems.map(c => [c.id, c.quantity]));
    let qtyWrites = 0, qtySkipped = 0;
    for (const [origLiId, newQty] of Object.entries(qtysMap)) {
      if (removeSet.has(origLiId)) continue;
      const calcLiId = idMap[origLiId];
      if (!calcLiId) { console.warn('[order-edit] no calc map for', origLiId); continue; }
      if (calcQtyById.get(calcLiId) === newQty) { qtySkipped++; continue; }  // unchanged — skip the round-trip
      qtyWrites++;
      await shopifyFetch(`mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
        orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){
          calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, li: calcLiId, qty: newQty, r: false });
    }
    if (qtySkipped) console.log(`[order-edit] BATCH /edit order=${numId} qty: ${qtyWrites} changed, ${qtySkipped} unchanged (skipped)`);
    for (const origLiId of removeSet) {
      const calcLiId = idMap[origLiId];
      if (!calcLiId) { console.warn('[order-edit] no calc map for remove', origLiId); continue; }
      await shopifyFetch(`mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
        orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){
          calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, li: calcLiId, qty: 0, r: true });
    }
    // Apply per-line price changes: remove existing B2B discount + add new one at new %
    // Note: orderEditUpdateDiscount stacks on commit — must remove+add instead.
    for (const [origLiId, newPrice] of Object.entries(pricesMap)) {
      const info = discountIdMap[origLiId];
      if (!info) continue;  // no B2B discount on this line (custom item or no discount)
      const calcLiId = idMap[origLiId];
      if (!calcLiId) continue;
      const currentPrice = info.wholesalePrice;
      if (Math.abs(newPrice - currentPrice) < 0.005) continue;  // no change
      const newPct = ((info.retailPrice - newPrice) / info.retailPrice) * 100;
      if (newPct < 0 || newPct > 100) { console.warn('[order-edit] price out of range — skipping', origLiId); continue; }
      // Step 1: remove existing per-line B2B discount
      const remRes = await shopifyFetch(
        `mutation rem($id:ID!,$did:ID!){
          orderEditRemoveDiscount(id:$id,discountApplicationId:$did){
            calculatedOrder{id} userErrors{field message}
          }
        }`,
        { id: calcId, did: info.discountAppId }
      );
      const remErrs = remRes.data?.orderEditRemoveDiscount?.userErrors || [];
      if (remErrs.length) { console.error('[order-edit] remove discount failed:', JSON.stringify(remErrs)); continue; }
      // Step 2: add new discount at adjusted percentage
      const addRes = await shopifyFetch(
        `mutation add($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
          orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){
            addedDiscountStagedChange{id} calculatedOrder{id} userErrors{field message}
          }
        }`,
        { id: calcId, li: calcLiId, d: { percentValue: parseFloat(newPct.toFixed(4)), description: 'B2B price adj' } }
      );
      const addErrs = addRes.data?.orderEditAddLineItemDiscount?.userErrors || [];
      if (addErrs.length) console.error('[order-edit] add discount failed:', JSON.stringify(addErrs));
      else console.log('[order-edit] price updated:', origLiId, currentPrice, '->', newPrice, `(${newPct.toFixed(2)}%)`);
    }
    // Collected non-fatal warnings surfaced to staff via ?msg= on the redirect. Declared HERE (not at
    // the Phase 16F block below) because the order-discount staging that follows also pushes into it.
    const batchWarnings = [];
    // Apply the order-level discount — SAME code path as POST /orders/:id/discount/order.
    // CHANGE-GUARD (2026-08-05): this block used to be an independent SECOND copy of the
    // negative-priced orderEditAddCustomItem bug, and it did not even read its userErrors — so it
    // failed SILENTLY mid-batch on every save. It also computed the basis from subtotalPriceSet,
    // which both lags and is already net of any existing discount (a % re-apply then compounded).
    // Both defects are gone by delegating to the shared helper; do not re-inline this.
    // DEPENDS: the calculated order is RE-READ here because the qty/remove/price mutations above
    // have already mutated it — the `calcItems` captured at begin are stale, and staging a discount
    // off stale prices would compute the wrong basis.
    if ((discountPct || discountFixed) && discountReason) {
      const discCtx = { calcItems: await readCalcLines(calcId), warnings: batchWarnings };
      await stageOrderDiscount(calcId, discCtx, {
        pct: parseFloat(discountPct) || 0,
        fixed: parseFloat(discountFixed) || 0,
        reason: String(discountReason).slice(0, 200),
      });
    }
    // Phase 16A: add new custom items before commit
    for (const line of newCustomLines) {
      const addRes = await shopifyFetch(`mutation addItem($id:ID!,$title:String!,$price:MoneyInput!,$qty:Int!){
        orderEditAddCustomItem(id:$id,title:$title,price:$price,quantity:$qty,taxable:false,requiresShipping:true){
          calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, title: line.title, price: { amount: line.price.toFixed(2), currencyCode: 'USD' }, qty: line.qty });
      const addErrs = addRes.data?.orderEditAddCustomItem?.userErrors || [];
      if (addErrs.length) {
        console.error('[order-edit] addCustomItem failed:', JSON.stringify(addErrs));
        // continue with remaining lines; soft-fail
      }
    }

    // Phase 16F: add real catalog variants, then apply each line's B2B wholesale price.
    // CRITICAL: when a variantId is present Shopify uses the variant's full retail price and
    // IGNORES any manual unit price — so wholesale is applied as a per-line appliedDiscount
    // PERCENTAGE = (listPrice - wholesalePrice)/listPrice, mirroring submitNewOrder.
    // GUARD: if the order already carries an order-level/stacked discount (targetSelection:ALL),
    // orderEditAddLineItemDiscount throws "The order has a discount which prevents applying
    // additional discounts to this line item" — so the line is added at LIST price and a
    // warning is collected and surfaced (NOT a silent continue, NOT a swallowed userError).
    for (const line of newVariantLines) {
      const variantGid = line.variantId.startsWith('gid://') ? line.variantId : `gid://shopify/ProductVariant/${line.variantId}`;
      const addRes = await shopifyFetch(`mutation addVar($id:ID!,$v:ID!,$q:Int!){
        orderEditAddVariant(id:$id,variantId:$v,quantity:$q,allowDuplicates:true){
          calculatedLineItem{id calculatedDiscountAllocations{discountApplication{targetSelection}}} calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, v: variantGid, q: line.qty });
      const addErrs = addRes.data?.orderEditAddVariant?.userErrors || [];
      if (addErrs.length) { throw new Error('add ' + (line.sku || line.variantId) + ': ' + addErrs.map(e => e.message).join('; ')); }
      const calcLineItem = addRes.data?.orderEditAddVariant?.calculatedLineItem;
      const calcLiId = calcLineItem?.id;
      const listPrice = line.listPrice > 0 ? line.listPrice : line.price;
      if (calcLiId && listPrice > 0 && line.price >= 0 && line.price < listPrice) {
        if (lineHasStackedOrderDiscount(calcLineItem)) {
          batchWarnings.push(`"${line.title || line.sku || line.variantId}" added at list price ($${listPrice.toFixed(2)}) — this order already has a discount, so a wholesale line discount could not be stacked.`);
          console.warn('[order-edit] skipped wholesale discount (stacked order discount):', line.sku || line.variantId);
          continue;
        }
        const pct = ((listPrice - line.price) / listPrice) * 100;
        if (pct > 0 && pct <= 100) {
          const dRes = await shopifyFetch(`mutation addDisc($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
            orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){
              calculatedOrder{id} userErrors{field message}}}`,
            { id: calcId, li: calcLiId, d: { percentValue: parseFloat(pct.toFixed(4)), description: 'B2B wholesale' } });
          const dErrs = dRes.data?.orderEditAddLineItemDiscount?.userErrors || [];
          if (dErrs.length) {
            // Surface, don't swallow. The line IS added (at list price) — collect a warning.
            batchWarnings.push(`"${line.title || line.sku || line.variantId}" added at list price — ${dErrs.map(e => e.message).join('; ')}`);
            console.warn('[order-edit] addVariant discount failed:', JSON.stringify(dErrs));
          } else {
            console.log('[order-edit] catalog line added:', line.sku || line.variantId, 'x', line.qty, '@', line.price, `(${pct.toFixed(2)}% off ${listPrice})`);
          }
        }
      } else {
        console.log('[order-edit] catalog line added at list price:', line.sku || line.variantId, 'x', line.qty);
      }
    }

    // Count expected committed line delta BEFORE commit so we can verify it actually applied.
    // (Adds increase the live line count; this is the honest "did it save?" check the prior
    // handler skipped, which is exactly how the #37583 false-green slipped through.)
    const preState = await readCommittedLineState(orderId).catch(() => null);
    const expectedAdds = newCustomLines.length + newVariantLines.length;
    // P0 fix (2026-06-29): the post-commit count check MUST account for REMOVES in the same batch.
    // A batch that removes 1 line AND adds 1 leaves lineCount unchanged, so the old check
    // (postCount >= preCount + adds) false-FAILED an edit that Shopify had actually saved — staff saw
    // "edit failed" while the qty/remove/add all persisted. Count only removes that were ACTIVE
    // pre-edit (removing an already-removed line is a no-op and must not inflate the expected delta).
    const expectedRemoves = preState
      ? [...removeSet].filter(li => (preState.lines.find(l => l.liId === li)?.currentQuantity || 0) > 0).length
      : removeSet.size;

    // Commit — CAPTURE the result and INSPECT userErrors (was fire-and-forget: the root-cause bug).
    const commitRes = await shopifyFetch(`mutation commit($id:ID!,$notify:Boolean!,$note:String){
      orderEditCommit(id:$id,notifyCustomer:$notify,staffNote:$note){
        order{id} userErrors{field message}}}`,
      { id: calcId, notify: false, note: staffNote || null });
    const cErrs = commitRes.data?.orderEditCommit?.userErrors || [];
    if (cErrs.length) {
      // NO-OP IS NOT A FAILURE: a batch that nets no change (e.g. qty re-saved to its current value,
      // or only removes of already-removed lines) makes Shopify reject the commit with "There must be
      // at least one change to be made." Treat that as success — the order is already in the desired
      // state. Any OTHER commit userError is a real failure.
      if (cErrs.every(e => /at least one change/i.test(e.message || ''))) {
        console.log(`[order-edit] BATCH /edit order=${numId} commit was a NO-OP — treating as success`);
        logOrderEdit(orderId, session.email, staffNote, changes);
        auditLog(session.email, 'order_edit', orderId, null, changes);
        return res.redirect(`/orders/${numId}?success=order_edited`);
      }
      throw new Error('commit: ' + cErrs.map(e => e.message).join('; '));
    }

    // Verify the committed line delta actually applied. Net expected active-line delta = adds - removes.
    if ((expectedAdds > 0 || expectedRemoves > 0) && preState) {
      const postState = await readCommittedLineState(orderId).catch(() => null);
      const expectedNet = preState.lineCount + expectedAdds - expectedRemoves;
      if (postState && postState.lineCount < expectedNet) {
        throw new Error(`commit reported success but live line count is ${postState.lineCount}, expected ${expectedNet} (adds=${expectedAdds}, removes=${expectedRemoves})`);
      }
    }
    logOrderEdit(orderId, session.email, staffNote, changes);
    auditLog(session.email, 'order_edit', orderId, null, changes);
    if (batchWarnings.length) {
      return res.redirect(`/orders/${numId}?success=order_edited&msg=${encodeURIComponent(batchWarnings.join(' ').slice(0, 300))}`);
    }
    res.redirect(`/orders/${numId}?success=order_edited`);
  } catch (err) {
    console.error(`[order-edit] BATCH /edit FAIL order=${numId} reason=${err.message}\n${err && err.stack ? err.stack : ''}`);
    // Surface the REAL Shopify reason in the banner (renderOrderDetail plumbs ?msg= into flashMsg).
    res.redirect(`/orders/${numId}?error=edit_failed&msg=${encodeURIComponent(String(err.message || '').slice(0, 300))}`);
  }
});

// ── Phase 16H: incremental ("constantly update") order-edit endpoints ─────────
// Each endpoint runs ONE atomic begin->stage->commit via runOrderEdit (real) or
// mockIncrementalEdit (mock), requires a client uuid idemKey for dedupe, inspects every
// userError incl. commit, and returns authoritative server state so the client re-syncs.
// On Shopify userError they return 422 { ok:false, errors:[...] } — NEVER a false 200.

// Helper: map an ORIGINAL Shopify line-item id to its calculated line-item id within a fresh
// calculatedOrder.
// CHANGE-GUARD (delete-persist bug, 2026-06-29): the PRIMARY mapping is by NUMERIC ID SUFFIX —
// Shopify mints CalculatedLineItem ids that share the SAME numeric suffix as the OrderLineItem
// (orig gid://shopify/LineItem/123  ->  calc gid://shopify/CalculatedLineItem/123). This is the
// ONLY 1:1 mapping. The previous variant+title (then title-alone) heuristic returned the FIRST
// match, so on an order with duplicate variant+title lines (e.g. the same variant added twice via
// allowDuplicates, or many same-title sizes) EVERY line resolved to the first calc line — a
// remove/qty/price then mutated the WRONG line while the endpoint still reported success and
// logged "removed". Keep the suffix match first; the variant+title heuristic is a last-ditch
// fallback only for the (rare) case where Shopify does NOT preserve the suffix.
async function mapOrigToCalc(orderId, calcItems, origLiId) {
  const origRes = await shopifyFetch(`query($id:ID!){order(id:$id){lineItems(first:100){edges{node{id title variant{id} originalUnitPriceSet{presentmentMoney{amount}} discountedUnitPriceSet{presentmentMoney{amount}}}}}}}`, { id: orderId });
  const origItems = origRes.data?.order?.lineItems?.edges?.map(e => e.node) || [];
  const orig = origItems.find(o => o.id === origLiId);
  if (!orig) return { calcLiId: null, orig: null, calcItem: null };
  // PRIMARY: exact numeric-suffix match (1:1, collision-free).
  const wantNum = shopifyNumericId(origLiId);
  let match = calcItems.find(c => shopifyNumericId(c.id) === wantNum);
  // FALLBACK ONLY (suffix not preserved): variant+title, then title alone. To avoid the
  // duplicate-collision the suffix match exists to prevent, skip any calc line already claimed
  // by another original line via its own suffix.
  if (!match) {
    const claimed = new Set(origItems.map(o => shopifyNumericId(o.id)).filter(n => calcItems.some(c => shopifyNumericId(c.id) === n)));
    const free = calcItems.filter(c => !claimed.has(shopifyNumericId(c.id)));
    match = (orig.variant?.id ? free.find(c => c.variant?.id === orig.variant.id && c.title === orig.title) : null)
      || free.find(c => c.title === orig.title && !c.variant)
      || free.find(c => c.title === orig.title);
  }
  return { calcLiId: match?.id || null, orig, calcItem: match || null };
}

// POST /orders/:id/line/add — incremental add-from-picker (one variant). Idempotent.
app.post('/orders/:id/line/add', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey, variantId, title, sku, qty, listPrice, price } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  const q = parseInt(qty, 10);
  if (!variantId || !(q > 0)) return res.status(400).json({ ok: false, errors: ['variantId and qty>0 required'] });
  const lp = parseFloat(listPrice) || 0;
  const pr = Math.max(0, parseFloat(price) || 0);
  const payload = { variantId: String(variantId), title: String(title || ''), sku: String(sku || ''), qty: q, listPrice: lp, price: pr };
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'line/add', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'line/add'); }
  }

  if (MOCK) {
    const out = mockIncrementalEdit({ numId, idemKey, action: 'line/add', payload, editedBy: session.email, editFn: (edges) => {
      const warnings = [];
      const exists = edges.find(e => e.node.id === `gid://shopify/LineItem/idem-${idemKey}`);
      if (exists) return warnings; // belt-and-braces (dedupe already handled)
      edges.push({ node: {
        id: `gid://shopify/LineItem/idem-${idemKey}`,
        title: payload.title || 'Catalog item', quantity: q, currentQuantity: q,
        variant: { id: `gid://shopify/ProductVariant/${payload.variantId}`, sku: payload.sku },
        discountedUnitPriceSet: { presentmentMoney: { amount: pr.toFixed(2), currencyCode: 'USD' } },
        originalUnitPriceSet:   { presentmentMoney: { amount: (lp || pr).toFixed(2), currencyCode: 'USD' } },
      } });
      return warnings;
    }});
    if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
    const added = out.lineState.lines.find(l => l.liId === `gid://shopify/LineItem/idem-${idemKey}`) || out.lineState.lines[out.lineState.lines.length - 1];
    logOrderEdit(orderId, session.email, null, { action: 'line/add', payload });
    return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, line: { liId: added?.liId, title: payload.title, sku: payload.sku, qty: q, unitPrice: pr }, order: out.order });
  }

  try {
    const result = await runOrderEdit(orderId, idemKey, session.email, 'line/add', payload, async (calcId, ctx) => {
      const variantGid = payload.variantId.startsWith('gid://') ? payload.variantId : `gid://shopify/ProductVariant/${payload.variantId}`;
      const addRes = await shopifyFetch(`mutation addVar($id:ID!,$v:ID!,$q:Int!){
        orderEditAddVariant(id:$id,variantId:$v,quantity:$q,allowDuplicates:true){
          calculatedLineItem{id calculatedDiscountAllocations{discountApplication{targetSelection}}} calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, v: variantGid, q });
      const addErrs = addRes.data?.orderEditAddVariant?.userErrors || [];
      if (addErrs.length) throw new OrderEditError(addErrs.map(e => e.message));
      const calcLineItem = addRes.data?.orderEditAddVariant?.calculatedLineItem;
      const calcLiId = calcLineItem?.id;
      const lpEff = lp > 0 ? lp : pr;
      if (calcLiId && lpEff > 0 && pr >= 0 && pr < lpEff) {
        if (lineHasStackedOrderDiscount(calcLineItem)) {
          ctx.warnings.push(`Added at list price ($${lpEff.toFixed(2)}) — this order already has a discount, so a wholesale line discount could not be stacked.`);
        } else {
          const pct = ((lpEff - pr) / lpEff) * 100;
          if (pct > 0 && pct <= 100) {
            const dRes = await shopifyFetch(`mutation addDisc($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
              orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){ calculatedOrder{id} userErrors{field message}}}`,
              { id: calcId, li: calcLiId, d: { percentValue: parseFloat(pct.toFixed(4)), description: 'B2B wholesale' } });
            const dErrs = dRes.data?.orderEditAddLineItemDiscount?.userErrors || [];
            if (dErrs.length) ctx.warnings.push(`Added at list price — ${dErrs.map(e => e.message).join('; ')}`);
          }
        }
      }
    });
    // Find the committed line for this add so the client can stamp committedLiId (lets an add
    // then in-session delete target the right line WITHOUT a reload). A freshly added line always
    // gets the HIGHEST numeric line-item id, so among SKU/title matches prefer the newest id.
    // payload.title is the variant-suffixed picker label; lineState carries the product title —
    // so SKU is the reliable key, title is only a coarse fallback.
    const committed = (result.lineState?.lines || []).filter(l => (l.currentQuantity || 0) > 0);
    const byNewest = (arr) => arr.slice().sort((a, b) => Number(shopifyNumericId(b.liId)) - Number(shopifyNumericId(a.liId)))[0];
    const skuMatches = payload.sku ? committed.filter(l => l.sku === payload.sku) : [];
    const titleMatches = committed.filter(l => l.title === payload.title);
    const line = (skuMatches.length ? byNewest(skuMatches) : null)
      || (titleMatches.length ? byNewest(titleMatches) : null)
      || committed[committed.length - 1];
    logOrderEdit(orderId, session.email, null, { action: 'line/add', payload });
    auditLog(session.email, 'order_edit_line_add', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], line: { liId: line?.liId, title: line?.title || payload.title, sku: line?.sku || payload.sku, qty: line?.currentQuantity ?? q, unitPrice: line?.unitPrice ?? pr }, order: result.order });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'line/add');
  }
});

// POST /orders/:id/line/custom — incremental custom (non-catalog) line. Idempotent.
app.post('/orders/:id/line/custom', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey, title, qty, price } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  const q = parseInt(qty, 10);
  const pr = parseFloat(price);
  if (!title || !(q > 0) || !(pr >= 0)) return res.status(400).json({ ok: false, errors: ['title, qty>0 and price>=0 required'] });
  const payload = { title: String(title).slice(0, 200), qty: q, price: pr };
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'line/custom', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'line/custom'); }
  }

  if (MOCK) {
    const out = mockIncrementalEdit({ numId, idemKey, action: 'line/custom', payload, editedBy: session.email, editFn: (edges) => {
      edges.push({ node: {
        id: `gid://shopify/LineItem/idem-${idemKey}`,
        title: payload.title, quantity: q, currentQuantity: q, variant: null,
        discountedUnitPriceSet: { presentmentMoney: { amount: pr.toFixed(2), currencyCode: 'USD' } },
        originalUnitPriceSet:   { presentmentMoney: { amount: pr.toFixed(2), currencyCode: 'USD' } },
      } });
      return [];
    }});
    if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
    const added = out.lineState.lines.find(l => l.liId === `gid://shopify/LineItem/idem-${idemKey}`) || out.lineState.lines[out.lineState.lines.length - 1];
    logOrderEdit(orderId, session.email, null, { action: 'line/custom', payload });
    return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, line: { liId: added?.liId, title: payload.title, sku: '', qty: q, unitPrice: pr }, order: out.order });
  }

  try {
    const result = await runOrderEdit(orderId, idemKey, session.email, 'line/custom', payload, async (calcId) => {
      const addRes = await shopifyFetch(`mutation addItem($id:ID!,$title:String!,$price:MoneyInput!,$qty:Int!){
        orderEditAddCustomItem(id:$id,title:$title,price:$price,quantity:$qty,taxable:false,requiresShipping:true){
          calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, title: payload.title, price: { amount: pr.toFixed(2), currencyCode: 'USD' }, qty: q });
      const addErrs = addRes.data?.orderEditAddCustomItem?.userErrors || [];
      if (addErrs.length) throw new OrderEditError(addErrs.map(e => e.message));
    });
    const committed = (result.lineState?.lines || []).filter(l => (l.currentQuantity || 0) > 0);
    const line = committed.find(l => l.title === payload.title && !l.sku) || committed.find(l => l.title === payload.title) || committed[committed.length - 1];
    logOrderEdit(orderId, session.email, null, { action: 'line/custom', payload });
    auditLog(session.email, 'order_edit_line_custom', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], line: { liId: line?.liId, title: payload.title, sku: '', qty: line?.currentQuantity ?? q, unitPrice: line?.unitPrice ?? pr }, order: result.order });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'line/custom');
  }
});

// POST /orders/:id/line/qty — incremental qty change on an EXISTING line. Idempotent.
// qty 0 mirrors remove semantics (restock:true). Returns currentQuantity (not quantity).
app.post('/orders/:id/line/qty', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey, liId, qty } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  const q = parseInt(qty, 10);
  if (!liId || !(q >= 0)) return res.status(400).json({ ok: false, errors: ['liId and qty>=0 required'] });
  const payload = { liId: String(liId), qty: q };
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'line/qty', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'line/qty'); }
  }

  if (MOCK) {
    const out = mockIncrementalEdit({ numId, idemKey, action: 'line/qty', payload, editedBy: session.email, editFn: (edges) => {
      const e = edges.find(x => x.node.id === payload.liId);
      if (e) { e.node.quantity = q; e.node.currentQuantity = q; }
      return [];
    }});
    if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
    const l = out.lineState.lines.find(x => x.liId === payload.liId);
    logOrderEdit(orderId, session.email, null, { action: 'line/qty', payload });
    return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, line: { liId: payload.liId, currentQuantity: l?.currentQuantity ?? q }, order: out.order });
  }

  try {
    const result = await runOrderEdit(orderId, idemKey, session.email, 'line/qty', payload, async (calcId, ctx) => {
      const { calcLiId } = await mapOrigToCalc(orderId, ctx.calcItems, payload.liId);
      if (!calcLiId) throw new OrderEditError('line not found on order');
      const r = await shopifyFetch(`mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
        orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){ calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, li: calcLiId, qty: q, r: q === 0 });
      const errs = r.data?.orderEditSetQuantity?.userErrors || [];
      if (errs.length) throw new OrderEditError(errs.map(e => e.message));
    }, (lineState) => {
      // VERIFY-OR-FAIL: the targeted line MUST reflect the requested quantity post-commit.
      const l = (lineState.lines || []).find(x => x.liId === payload.liId);
      const got = l ? (l.currentQuantity || 0) : 0;
      if (got !== q) {
        throw new OrderEditError(`quantity did not persist — expected ${q}, order still shows ${got} (please retry)`);
      }
    });
    const l = (result.lineState?.lines || []).find(x => x.liId === payload.liId);
    logOrderEdit(orderId, session.email, null, { action: 'line/qty', payload });
    auditLog(session.email, 'order_edit_line_qty', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], line: { liId: payload.liId, currentQuantity: l?.currentQuantity ?? q }, order: result.order });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'line/qty');
  }
});

// POST /orders/:id/line/price — incremental unit-price change on an existing discountable line.
// Removes the explicit per-line discount then re-adds at the new %; guards the stacked-discount case.
app.post('/orders/:id/line/price', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey, liId, price } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  const pr = parseFloat(price);
  if (!liId || !(pr >= 0)) return res.status(400).json({ ok: false, errors: ['liId and price>=0 required'] });
  const payload = { liId: String(liId), price: pr };
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'line/price', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'line/price'); }
  }

  if (MOCK) {
    const out = mockIncrementalEdit({ numId, idemKey, action: 'line/price', payload, editedBy: session.email, editFn: (edges) => {
      const e = edges.find(x => x.node.id === payload.liId);
      if (!e) return [];
      // MOCK FIDELITY: production sets a unit price by REMOVING the line's explicit discount and
      // adding a `percentValue` one described "B2B price adj" — so the price change always leaves a
      // discount ALLOCATION behind. Modelling only the price (and no allocation) hid the fact that a
      // per-line adjustment and an order discount cannot coexist on one line.
      const qty = (e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0;
      const retail = parseFloat(e.node.originalUnitPriceSet?.presentmentMoney?.amount || 0) || 0;
      e.node.discountedUnitPriceSet = { presentmentMoney: { amount: pr.toFixed(2), currencyCode: 'USD' } };
      const keep = (e.node.discountAllocations || []).filter(a => a?.discountApplication?.targetSelection !== 'EXPLICIT');
      const adj = Math.round((retail - pr) * qty * 100) / 100;
      e.node.discountAllocations = adj > 0
        ? [...keep, { allocatedAmountSet: { presentmentMoney: { amount: adj.toFixed(2), currencyCode: 'USD' } },
                      discountApplication: { targetSelection: 'EXPLICIT', description: 'B2B price adj' } }]
        : keep;
      return [];
    }});
    if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
    const l = out.lineState.lines.find(x => x.liId === payload.liId);
    logOrderEdit(orderId, session.email, null, { action: 'line/price', payload });
    return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, line: { liId: payload.liId, unitPrice: l?.unitPrice ?? pr }, order: out.order });
  }

  try {
    const result = await runOrderEdit(orderId, idemKey, session.email, 'line/price', payload, async (calcId, ctx) => {
      // Need calc item + its discount allocations + retail price to re-discount.
      const { calcLiId, orig, calcItem } = await mapOrigToCalc(orderId, ctx.calcItems, payload.liId);
      if (!calcLiId || !orig) throw new OrderEditError('line not found on order');
      const retail = parseFloat(orig.originalUnitPriceSet?.presentmentMoney?.amount || 0);
      if (!(retail > 0)) throw new OrderEditError('line has no retail price to discount from');
      // Find an EXPLICIT per-line discount to remove first.
      const explicitDisc = (calcItem?.calculatedDiscountAllocations || [])
        .map(a => a.discountApplication).find(da => da?.targetSelection === 'EXPLICIT');
      if (lineHasStackedOrderDiscount(calcItem) && !explicitDisc) {
        throw new OrderEditError('The order has a discount which prevents applying additional discounts to this line item.');
      }
      // DEPENDS: since 2026-08-05 an ORDER discount is itself an EXPLICIT per-line manual discount
      // (see stageOrderDiscount), so it can be the allocation we are about to remove. Shopify permits
      // only ONE manual discount per line, so setting an explicit price here NECESSARILY drops the
      // order discount from this line — that is unavoidable, but it must never be silent: warn, or
      // staff would see the order total move for no visible reason.
      if (isOrderDiscountDescription(explicitDisc?.description)) {
        ctx.warnings.push('this line’s share of the order discount was replaced by the manual price — re-apply the order discount if it should still cover this line');
      }
      if (explicitDisc?.id) {
        const remRes = await shopifyFetch(`mutation rem($id:ID!,$did:ID!){
          orderEditRemoveDiscount(id:$id,discountApplicationId:$did){ calculatedOrder{id} userErrors{field message}}}`,
          { id: calcId, did: explicitDisc.id });
        const remErrs = remRes.data?.orderEditRemoveDiscount?.userErrors || [];
        if (remErrs.length) throw new OrderEditError(remErrs.map(e => e.message));
      }
      const pct = ((retail - pr) / retail) * 100;
      if (pct < 0 || pct > 100) throw new OrderEditError(`price $${pr.toFixed(2)} is out of range for retail $${retail.toFixed(2)}`);
      if (pct >= 0.0001) {
        const addRes = await shopifyFetch(`mutation addDisc($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
          orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){ calculatedOrder{id} userErrors{field message}}}`,
          { id: calcId, li: calcLiId, d: { percentValue: parseFloat(pct.toFixed(4)), description: 'B2B price adj' } });
        const addErrs = addRes.data?.orderEditAddLineItemDiscount?.userErrors || [];
        if (addErrs.length) throw new OrderEditError(addErrs.map(e => e.message));
      }
    });
    const l = (result.lineState?.lines || []).find(x => x.liId === payload.liId);
    logOrderEdit(orderId, session.email, null, { action: 'line/price', payload });
    auditLog(session.email, 'order_edit_line_price', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], line: { liId: payload.liId, unitPrice: l?.unitPrice ?? pr }, order: result.order });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'line/price');
  }
});

// POST /orders/:id/line/remove — incremental remove (setQuantity 0, restock). Idempotent.
// Shopify retains the line at currentQuantity:0 — client greys the row, does not delete it.
app.post('/orders/:id/line/remove', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey, liId } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  if (!liId) return res.status(400).json({ ok: false, errors: ['liId required'] });
  const payload = { liId: String(liId) };
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'line/remove', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'line/remove'); }
  }

  if (MOCK) {
    const out = mockIncrementalEdit({ numId, idemKey, action: 'line/remove', payload, editedBy: session.email, editFn: (edges) => {
      const e = edges.find(x => x.node.id === payload.liId);
      if (e) e.node.currentQuantity = 0;
      return [];
    }});
    if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
    const l = out.lineState.lines.find(x => x.liId === payload.liId);
    logOrderEdit(orderId, session.email, null, { action: 'line/remove', payload });
    return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, line: { liId: payload.liId, currentQuantity: l?.currentQuantity ?? 0 }, order: out.order });
  }

  try {
    const result = await runOrderEdit(orderId, idemKey, session.email, 'line/remove', payload, async (calcId, ctx) => {
      const { calcLiId } = await mapOrigToCalc(orderId, ctx.calcItems, payload.liId);
      if (!calcLiId) throw new OrderEditError('line not found on order');
      const r = await shopifyFetch(`mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
        orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){ calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, li: calcLiId, qty: 0, r: true });
      const errs = r.data?.orderEditSetQuantity?.userErrors || [];
      if (errs.length) throw new OrderEditError(errs.map(e => e.message));
    }, (lineState) => {
      // VERIFY-OR-FAIL: the targeted line MUST be gone (absent) or at currentQuantity 0.
      const l = (lineState.lines || []).find(x => x.liId === payload.liId);
      if (l && (l.currentQuantity || 0) > 0) {
        throw new OrderEditError('removal did not persist — the line is still on the order (please retry)');
      }
    });
    const l = (result.lineState?.lines || []).find(x => x.liId === payload.liId);
    logOrderEdit(orderId, session.email, null, { action: 'line/remove', payload });
    auditLog(session.email, 'order_edit_line_remove', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], line: { liId: payload.liId, currentQuantity: l?.currentQuantity ?? 0 }, order: result.order });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'line/remove');
  }
});

// ── MOCK model of an order discount ──────────────────────────────────────────
// WHAT: applies/removes the order discount on mock line edges the SAME WAY Shopify does — as a
// per-line manual discount ALLOCATION that lowers discountedUnitPriceSet, leaving
// originalUnitPriceSet at retail.
// CHANGE-GUARD (2026-08-05, the reason this exists): the previous mock fabricated a NEGATIVE-priced
// custom line item. Production rejects negative custom items outright ("must be greater than or
// equal to 0"), so the suite was green against behaviour Shopify 422s on every single call. A mock
// that models a representation the API refuses is worse than no mock — keep this in lockstep with
// stageOrderDiscount/removePriorOrderDiscounts, and never model a discount as a line again.
// SYNC: mockApplyOrderDiscount ↔ stageOrderDiscount — the basis, the effective-percent rounding and
// the per-line cent rounding must match, or the mock's amounts drift from production's.
function mockStripOrderDiscount(edges) {
  let removed = 0;
  for (const e of edges) {
    const allocs = e.node.discountAllocations || [];
    const ours = allocs.filter(a => isOrderDiscountDescription(a?.discountApplication?.description));
    if (!ours.length) continue;
    removed++;
    const qty = (e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0;
    const back = ours.reduce((s, a) => s + (parseFloat(a?.allocatedAmountSet?.presentmentMoney?.amount ?? 0) || 0), 0);
    const net = parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount || 0) * qty;
    e.node.discountAllocations = allocs.filter(a => !isOrderDiscountDescription(a?.discountApplication?.description));
    if (qty > 0) e.node.discountedUnitPriceSet = { presentmentMoney: { amount: ((net + back) / qty).toFixed(2), currencyCode: 'USD' } };
  }
  return removed;
}

function mockApplyOrderDiscount(edges, { pct, fixed, reason }) {
  const description = orderDiscountDescription(reason);
  const warnings = [];
  const removed = mockStripOrderDiscount(edges);
  if (removed) warnings.push(`replaced ${removed} existing order discount${removed === 1 ? '' : 's'}`);

  const eligible = [], blocked = [];
  for (const e of edges) {
    const qty = (e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0;
    if (qty <= 0) continue;
    // Mirror the live guard: Shopify refuses a line discount when a cart-level ('ALL') discount
    // exists ("The order has a discount which prevents applying additional discounts to this line
    // item."), e.g. mock order #1009.
    if ((e.node.discountAllocations || []).some(a => a?.discountApplication?.targetSelection === 'ALL')) {
      throw new OrderEditError('This order carries an order-level discount applied at checkout, and Shopify refuses to add a line discount on top of it. Remove that discount in Shopify first.');
    }
    const foreign = (e.node.discountAllocations || [])
      .map(a => a?.discountApplication)
      .find(da => da && !isOrderDiscountDescription(da.description));
    if (foreign) { blocked.push(`"${e.node.title}" (${foreign.description || 'manual discount'})`); continue; }
    const unit = parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount ?? e.node.originalUnitPriceSet?.presentmentMoney?.amount ?? 0) || 0;
    if (unit <= 0) continue;
    eligible.push({ e, qty, lineTotal: unit * qty });
  }
  if (blocked.length) throw new OrderEditError(`Shopify allows only ONE discount per line, and ${blocked.length} line(s) already carry a manual price adjustment: ${blocked.join('; ')}. Clear those line prices first, or apply the reduction as a per-line price instead.`);
  if (!eligible.length) throw new OrderEditError('this order has no discountable lines');

  const basis = eligible.reduce((s, l) => s + l.lineTotal, 0);
  const requested = pct > 0 ? basis * pct / 100 : fixed;
  if (!(requested > 0)) throw new OrderEditError('computed discount is zero — nothing to apply');
  if (requested > basis + 0.005) throw new OrderEditError(`discount ${fmtMoney(requested)} exceeds the order subtotal ${fmtMoney(basis)}`);
  const effPct = parseFloat(Math.min(100, (requested / basis) * 100).toFixed(4));

  for (const l of eligible) {
    const alloc = Math.round(l.lineTotal * effPct) / 100;
    l.e.node.discountedUnitPriceSet = { presentmentMoney: { amount: ((l.lineTotal - alloc) / l.qty).toFixed(2), currencyCode: 'USD' } };
    l.e.node.discountAllocations = [
      ...(l.e.node.discountAllocations || []),
      { allocatedAmountSet: { presentmentMoney: { amount: alloc.toFixed(2), currencyCode: 'USD' } },
        discountApplication: { targetSelection: 'EXPLICIT', description } },
    ];
  }
  return warnings;
}

// POST /orders/:id/discount/order — incremental order-level discount.
// WHAT: applies an order discount as an equal-percentage MANUAL LINE-ITEM DISCOUNT on every eligible
// line (orderEditAddLineItemDiscount), replacing any discount already applied — all inside ONE
// orderEditBegin/commit, verified against committed allocations before it is recorded committed.
// CHANGE-GUARD (2026-08-05): this route used to add a NEGATIVE-priced custom line item, which
// Shopify rejects unconditionally — the route 422'd on every call in production while the mock made
// the tests pass. Do not reintroduce orderEditAddCustomItem with a negative price; the regression
// test "an order discount is an ALLOCATION, never a negative-priced line item" guards this.
// INVARIANT(S): re-applying REPLACES (never stacks); the % basis is read AFTER the prior discount is
// removed so it can never be computed on an already-discounted subtotal; a line already carrying a
// foreign manual discount makes the whole apply FAIL rather than silently overwrite it.
app.post('/orders/:id/discount/order', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey, discountPct, discountFixed, discountReason } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  if (!discountReason) return res.status(422).json({ ok: false, errors: ['discountReason is required'] });
  const pct = parseFloat(discountPct) || 0;
  const fixed = parseFloat(discountFixed) || 0;
  if (!(pct > 0) && !(fixed > 0)) return res.status(422).json({ ok: false, errors: ['a discount % or $ amount is required'] });
  const payload = { discountPct: pct || null, discountFixed: fixed || null, discountReason: String(discountReason).slice(0, 200) };
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'discount/order', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'discount/order'); }
  }

  if (MOCK) {
    try {
      const out = mockIncrementalEdit({ numId, idemKey, action: 'discount/order', payload, editedBy: session.email,
        editFn: (edges) => mockApplyOrderDiscount(edges, { pct, fixed, reason: payload.discountReason }) });
      if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
      logOrderEdit(orderId, session.email, null, { action: 'discount/order', payload });
      return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, order: out.order, discount: summarizeOrderDiscount(out.lineState?.lines) });
    } catch (err) {
      return editErrorResponse(res, idemKey, err, 'discount/order');
    }
  }

  try {
    let expected = null;
    const result = await runOrderEdit(orderId, idemKey, session.email, 'discount/order', payload,
      async (calcId, ctx) => { expected = await stageOrderDiscount(calcId, ctx, { pct, fixed, reason: payload.discountReason }); },
      (lineState) => verifyOrderDiscount(lineState, expected));
    logOrderEdit(orderId, session.email, null, { action: 'discount/order', payload });
    auditLog(session.email, 'order_edit_discount', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], order: result.order, discount: summarizeOrderDiscount(result.lineState?.lines) });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'discount/order');
  }
});

// POST /orders/:id/discount/order/remove — clear the order discount entirely.
// WHAT: replaces the affordance lost when the discount stopped being a line item. Previously staff
// cleared a discount by hitting the ✕ (setQuantity 0) on the negative discount ROW in the line table;
// an allocation has no row, so without this route there is NO way to undo an order discount from the
// admin at all.
// INVARIANT(S): idempotent — removing when there is no discount is a successful no-op (runOrderEdit
// already treats Shopify's "at least one change" commit userError as success).
app.post('/orders/:id/discount/order/remove', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { idemKey } = req.body || {};
  if (!idemKey) return res.status(400).json({ ok: false, errors: ['idemKey required'] });
  const payload = {};
  const dup = getEditAction(idemKey);
  if (dup && dup.status === 'committed') {
    try { assertReplayPayloadMatches(dup, 'discount/order/remove', payload); }
    catch (err) { return editErrorResponse(res, idemKey, err, 'discount/order/remove'); }
  }

  if (MOCK) {
    try {
      const out = mockIncrementalEdit({ numId, idemKey, action: 'discount/order/remove', payload, editedBy: session.email,
        editFn: (edges) => { const n = mockStripOrderDiscount(edges); return n ? [`removed the order discount from ${n} line${n === 1 ? '' : 's'}`] : []; } });
      if (!out) return res.status(404).json({ ok: false, errors: ['order not found'] });
      logOrderEdit(orderId, session.email, null, { action: 'discount/order/remove', payload });
      return res.json({ ok: true, idemKey: out.idemKey, replayed: !!out.replayed, warnings: out.warnings, order: out.order, discount: summarizeOrderDiscount(out.lineState?.lines) });
    } catch (err) {
      return editErrorResponse(res, idemKey, err, 'discount/order/remove');
    }
  }

  try {
    const result = await runOrderEdit(orderId, idemKey, session.email, 'discount/order/remove', payload, async (calcId, ctx) => {
      const { removed } = await removePriorOrderDiscounts(calcId, ctx.calcItems);
      if (!removed) ctx.warnings.push('this order had no order discount to remove');
      else ctx.warnings.push(`removed ${removed} order discount${removed === 1 ? '' : 's'}`);
    }, (lineState) => {
      // VERIFY-OR-FAIL: no order-discount allocation may survive on any active line.
      const left = (lineState.lines || []).filter(l => (l.currentQuantity || 0) > 0 && (l.discounts || []).some(d => d.isOurs));
      if (left.length) throw new OrderEditError(`the order discount is still on ${left.length} line(s) after commit — please retry`);
    });
    logOrderEdit(orderId, session.email, null, { action: 'discount/order/remove', payload });
    auditLog(session.email, 'order_edit_discount_remove', orderId, null, payload);
    return res.json({ ok: true, idemKey, replayed: !!result.replayed, warnings: result.warnings || [], order: result.order, discount: summarizeOrderDiscount(result.lineState?.lines) });
  } catch (err) {
    return editErrorResponse(res, idemKey, err, 'discount/order/remove');
  }
});

// GET /api/orders/:id/line-state — authoritative line state for the client to re-sync/reconcile.
// DISCOUNT-VISIBILITY (2026-08-05): every line now carries `discounts` (its discount allocations) and
// `orderDiscount` (the per-line share of the app's order discount), and the response carries an
// order-level `discount` summary. An order discount is no longer a LINE, so without these fields it
// is invisible to the client and to the regression tests — which is exactly how the 422 hid.
app.get('/api/orders/:id/line-state', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const orderId = `gid://shopify/Order/${numId}`;
  const shape = (l) => ({
    liId: l.liId, title: l.title || '', currentQuantity: l.currentQuantity, unitPrice: l.unitPrice,
    discounts: l.discounts || [], orderDiscount: lineOrderDiscountAmount(l),
  });
  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ ok: false, error: 'order not found' });
    const edges = order.lineItems?.edges || [];
    let subtotal = 0;
    const lines = edges.map(e => {
      const cq = e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity;
      const up = parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount || 0);
      subtotal += up * (cq || 0);
      return { liId: e.node.id, title: e.node.title || '', currentQuantity: cq, unitPrice: up, discounts: normalizeAllocations(e.node.discountAllocations) };
    });
    const ship = parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0);
    return res.json({ ok: true, lines: lines.map(shape), subtotal, total: subtotal + ship, lineCount: lines.filter(l => (l.currentQuantity || 0) > 0).length, discount: summarizeOrderDiscount(lines) });
  }
  try {
    const st = await readCommittedLineState(orderId);
    return res.json({ ok: true, lines: st.lines.map(shape), subtotal: st.subtotal, total: st.total, lineCount: st.lineCount, discount: summarizeOrderDiscount(st.lines) });
  } catch (err) {
    console.error('[line-state] failed:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// 16B: Order-level discount (the legacy MODAL path; form POST + redirect, no idemKey).
// WHAT: applies a standalone order-level discount; body {type:'pct'|'fixed', value, reason}. Now a thin
// wrapper over the SAME runOrderEdit + stageOrderDiscount + verifyOrderDiscount path as
// POST /orders/:id/discount/order — only the transport (form POST -> 302) differs.
// CHANGE-GUARD (2026-08-05): this route used to hand the WHOLE order-level amount to
// orderEditAddLineItemDiscount as `fixedValue` on calcOrder.lineItems[0]. fixedValue is PER UNIT and
// silently CLAMPS to the line total with EMPTY userErrors — verified live: fixedValue 136.95 on a
// qty-12 @ $12.50 line allocated $150.00 and zeroed the unit price, returning success. It also had no
// replace step (every submit STACKED another discount, computed on the already-discounted
// subtotalPriceSet) and never inspected orderEditCommit.userErrors. All four defects are gone.
// INVARIANT(S): the redirect now carries the REAL failure reason in ?msg= instead of a bare
// ?error=discount_failed; a synthetic idemKey is minted per submission because this transport has no
// client-side key — that means a double-submit is NOT deduped here, which is precisely why the
// inline edit-bar route (which does carry an idemKey) is the preferred path.
app.post('/orders/:id/discount', requireAuth, async (req, res) => {
  const numId  = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const { type, value, reason } = req.body;
  if (!value || !reason) return res.redirect(`/orders/${numId}?error=discount_missing_fields`);
  const changes = { discountType: type, discountValue: value, reason };
  const pct   = type === 'pct' ? parseFloat(value) || 0 : 0;
  const fixed = type === 'pct' ? 0 : parseFloat(value) || 0;
  const cleanReason = String(reason).slice(0, 200);
  const idemKey = `modal-${numId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { discountPct: pct || null, discountFixed: fixed || null, discountReason: cleanReason };

  if (MOCK) {
    try {
      const out = mockIncrementalEdit({ numId, idemKey, action: 'discount/order', payload, editedBy: session.email,
        editFn: (edges) => mockApplyOrderDiscount(edges, { pct, fixed, reason: cleanReason }) });
      if (!out) return res.status(404).json({ error: 'not found' });
      auditLog(session.email, 'order_discount', orderId, null, changes);
      return res.redirect(`/orders/${numId}?success=discount_applied`);
    } catch (err) {
      return res.redirect(`/orders/${numId}?error=discount_failed&msg=${encodeURIComponent(String(err.message || '').slice(0, 300))}`);
    }
  }

  try {
    let expected = null;
    await runOrderEdit(orderId, idemKey, session.email, 'discount/order', payload,
      async (calcId, ctx) => { expected = await stageOrderDiscount(calcId, ctx, { pct, fixed, reason: cleanReason }); },
      (lineState) => verifyOrderDiscount(lineState, expected));
    logOrderEdit(orderId, session.email, null, { action: 'discount/order', payload });
    auditLog(session.email, 'order_discount', orderId, null, changes);
    res.redirect(`/orders/${numId}?success=discount_applied`);
  } catch (err) {
    const msg = err instanceof OrderEditError ? err.userMessages.join('; ') : String(err.message || '');
    console.error('discount error:', msg);
    res.redirect(`/orders/${numId}?error=discount_failed&msg=${encodeURIComponent(msg.slice(0, 300))}`);
  }
});

// Ship order — get rates via shipping bridge
// WHAT: fetches live shipping rates from SHIPPING_BRIDGE_URL /rates for an order; body {fromId,weight,lineItems}; maps Shopify shippingAddress -> bridge addrToSS schema.
// CHANGE-GUARD: weight defaults to 1 and units are hardcoded 'pound' — a mismatch with the bridge's expected unit silently mis-rates; residential:true is a deliberate B2B default; province is normalized via toStateCode().
// INVARIANT(S): only rates with shipping_amount>0 are returned and amounts are normalized to {amount,currency:'usd'}; requires env SHIPPING_BRIDGE_URL + SHIPPING_BRIDGE_BEARER (bearer sent as Authorization header).
app.post('/orders/:id/ship/rates', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const { fromId = 'fww-hp', weight = 1, lineItems = [] } = req.body || {};
  try {
    const order = await getOrderDetail(numId);
    if (!order) return res.status(404).json({ error: 'order not found' });
    const ship = order.shippingAddress || {};
    // Bridge expects: fromId (pinned id) + to (flat address obj using bridge's addrToSS schema) + package
    const body = {
      fromId: fromId,  // 'fww-hp' or 'beth-hastings' — bridge resolves to warehouse
      to: {
        name: `${ship.firstName || ''} ${ship.lastName || ''}`.trim() || order.customer?.displayName || '—',
        phone: ship.phone || order.customer?.phone || '',
        street1: ship.address1 || '',
        street2: ship.address2 || '',
        city: ship.city || '',
        state: toStateCode(ship.province) || '',
        postalCode: ship.zip || '',
        country: (ship.country || 'United States') === 'United States' ? 'US' : (ship.country || '').slice(0,2),
        residential: true,  // most B2B-portal customers ship to homes/small businesses; safe default
      },
      package: { weight: { value: parseFloat(weight) || 1, units: 'pound' } },
    };
    const r = await fetch(`${process.env.SHIPPING_BRIDGE_URL}/rates`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.SHIPPING_BRIDGE_BEARER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j.error || j.message || 'rates failed', detail: j });
    const rates = j.rate_response?.rates || j.rates || [];
    const normalized = rates.filter(rt => (typeof rt.shipping_amount === 'number' ? rt.shipping_amount : rt.shipping_amount?.amount) > 0).map(rt => ({
      ...rt,
      shipping_amount: typeof rt.shipping_amount === 'number'
        ? { amount: rt.shipping_amount, currency: 'usd' }
        : rt.shipping_amount,
    }));
    res.json({ rates: normalized });
  } catch (err) {
    console.error('ship rates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ship order — buy label + auto-fulfill in Shopify
// WHAT: buys a 4x6 PDF label via shipping-bridge then auto-fulfills the matched line items in Shopify with the returned tracking (USPS/UPS/FedEx mapped from carrier_code).
// CHANGE-GUARD: fulfillment MUST follow the label (paid label with no Shopify fulfillment = silent drift); re-test the fulfillmentOrder line-item mapping and the carrier_code->company name map after any bridge or API-version change.
// INVARIANT(S): label purchase is the source of truth — if fulfillmentCreate fails the label is already paid (logged, not refunded); only OPEN/IN_PROGRESS fulfillmentOrders are eligible; wantedQty is clamped to remainingQuantity; notifyCustomer:true here.
app.post('/orders/:id/ship/label', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const { rate_id, lineItems = [] } = req.body || {};
  if (!rate_id) return res.status(400).json({ error: 'rate_id required' });
  try {
    // 1) Buy the label
    const r = await fetch(`${process.env.SHIPPING_BRIDGE_URL}/label`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.SHIPPING_BRIDGE_BEARER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate_id, label_format: 'pdf', label_layout: '4x6' }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j.error || j.message || 'label purchase failed', detail: j });
    const label_url = j.label_download?.pdf || j.label_url || j.label_download?.href || '';
    const tracking_number = j.tracking_number || '';
    const carrier_code = j.carrier_code || '';
    const tracking_url = j.tracking_url || (carrier_code === 'usps' ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking_number}` : '');

    auditLog(req.adminSession.email, 'ship_label_purchased', `gid://shopify/Order/${numId}`, null, { rate_id, tracking_number, carrier_code, cost: j.shipment_cost?.amount });

    // 2) Auto-fulfill in Shopify with the tracking
    let fulfillment_id = null;
    try {
      const orderId = `gid://shopify/Order/${numId}`;
      const foRes = await shopifyFetch(`query($id:ID!){order(id:$id){
        fulfillmentOrders(first:10){edges{node{
          id status
          lineItems(first:50){edges{node{id remainingQuantity lineItem{id title}}}}
        }}}
      }}`, { id: orderId });
      const fos = foRes.data?.order?.fulfillmentOrders?.edges?.map(e => e.node) || [];
      const liMap = {};
      for (const fo of fos) {
        if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') continue;
        for (const edge of fo.lineItems.edges) {
          const foLi = edge.node;
          const origId = foLi.lineItem?.id;
          if (origId && foLi.remainingQuantity > 0) {
            liMap[origId] = { foId: fo.id, foLiId: foLi.id, remaining: foLi.remainingQuantity };
          }
        }
      }
      const groupedByFo = {};
      for (const li of lineItems) {
        const mapping = liMap[li.id];
        if (!mapping) continue;
        const wantedQty = Math.min(li.quantity, mapping.remaining);
        if (!groupedByFo[mapping.foId]) groupedByFo[mapping.foId] = [];
        groupedByFo[mapping.foId].push({ id: mapping.foLiId, quantity: wantedQty });
      }
      const fulfillmentOrderInput = Object.entries(groupedByFo).map(([foId, items]) => ({ fulfillmentOrderId: foId, fulfillmentOrderLineItems: items }));
      if (fulfillmentOrderInput.length > 0) {
        const ffRes = await shopifyFetch(`mutation fulfill($f:FulfillmentInput!){
          fulfillmentCreate(fulfillment:$f){fulfillment{id status} userErrors{field message}}
        }`, { f: {
          lineItemsByFulfillmentOrder: fulfillmentOrderInput,
          trackingInfo: tracking_number ? { number: tracking_number, url: tracking_url, company: carrier_code === 'usps' ? 'USPS' : carrier_code === 'ups' ? 'UPS' : carrier_code === 'fedex' ? 'FedEx' : '' } : null,
          notifyCustomer: true,
        }});
        const ffErrs = ffRes.data?.fulfillmentCreate?.userErrors || [];
        if (ffErrs.length === 0) {
          fulfillment_id = ffRes.data?.fulfillmentCreate?.fulfillment?.id;
        } else {
          console.error('ship label fulfill failed:', ffErrs.map(e => e.message).join(', '));
        }
      }
    } catch (ffErr) {
      console.error('ship label fulfill error:', ffErr.message);
    }

    res.json({ ok: true, label_url, tracking_number, tracking_url, carrier_code, fulfillment_id, cost: j.shipment_cost?.amount });
  } catch (err) {
    console.error('ship label error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cancel order (calls Shopify orderCancel mutation)
// WHAT: cancels an order via Shopify orderCancel; body flags restock/refund/notify are the literal string '1'; reason defaults to 'OTHER'.
// CHANGE-GUARD: orderCancel runs async server-side (returns job{id}) — userErrors are checked but a returned job is NOT polled, so a queued-but-failed cancel still redirects success; reason must be a valid OrderCancelReason enum value.
// INVARIANT(S): MOCK path only sets cancelledAt override; real path always passes a staffNote crediting session.email; error redirect truncates err.message to 200 chars.
app.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  const numId   = req.params.id;
  const session = req.adminSession;
  const reason  = String(req.body.reason || 'OTHER');
  const restock = req.body.restock === '1';
  const refund  = req.body.refund === '1';
  const notify  = req.body.notify === '1';

  if (MOCK) {
    const order = getMockOrder(numId);
    if (order) {
      const overrides = mockOrderOverrides.get(numId) || {};
      overrides.cancelledAt = new Date().toISOString();
      mockOrderOverrides.set(numId, overrides);
    }
    auditLog(session.email, 'order_cancel', `gid://shopify/Order/${numId}`, null, { reason, restock, refund, notify });
    return res.redirect(`/orders/${numId}?success=order_canceled`);
  }

  try {
    const orderId = `gid://shopify/Order/${numId}`;
    const result = await shopifyFetch(`
      mutation cancel($id:ID!,$reason:OrderCancelReason!,$refund:Boolean!,$restock:Boolean!,$notify:Boolean!,$staffNote:String){
        orderCancel(orderId:$id, reason:$reason, refund:$refund, restock:$restock, notifyCustomer:$notify, staffNote:$staffNote){
          job{id} userErrors{field message}
        }
      }`, {
      id: orderId,
      reason,
      refund,
      restock,
      notify,
      staffNote: `Canceled via FWW admin by ${session.email}`,
    });
    const errs = result.data?.orderCancel?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join(', '));
    auditLog(session.email, 'order_cancel', orderId, null, { reason, restock, refund, notify });
    res.redirect(`/orders/${numId}?success=order_canceled`);
  } catch (err) {
    console.error('order cancel error:', err.message);
    res.redirect(`/orders/${numId}?error=cancel_failed&msg=${encodeURIComponent(err.message.slice(0, 200))}`);
  }
});

// Second build (Build C): Record a manual (off-Shopify) payment against an order.
// WHAT: marks a B2B order paid via orderMarkAsPaid (FULL outstanding) so an off-Shopify payment
//   (check / ACH / cash) shows as received in Shopify + the Transactions card. FULL-PAYMENT ONLY:
//   this store is on Shopify "Advanced", where partial manual payments aren't supported — the
//   orderCreateManualPayment mutation is Plus-gated, and the Shopify admin can't do partials
//   either. The payment method + note are recorded in the audit log → Build D order-history
//   timeline (Shopify books the payment against the pending balance; no custom gateway label).
// CHANGE-GUARD: modeled on /orders/:id/cancel — MOCK branch first, then real mutation, then
//   audit + PRG redirect. Validation gates a comp/zero-outstanding order (Shopify userErrors
//   on those) and a partial amount > the FRESH outstanding (re-fetched immediately before the
//   mutation, NOT trusting the page-render prefill — an in-flight auto-save edit can change it).
//   Never swallow a failure: userErrors / exceptions redirect with ?error=payment_failed&msg=…
// INVARIANT(S): paymentMethod is REQUIRED (blank ⇒ ?error=method_required). Marks the FULL
//   balance paid (no amount input). Gates a comp/zero-outstanding order (fresh-refetched ⇒
//   ?error=payment_failed). No Xero recording in v1 (flagged follow-up). Mirrors the existing
//   /mark-paid mutation, plus a captured method/note for the audit trail.
app.post('/orders/:id/record-payment', requireAuth, async (req, res) => {
  const numId   = req.params.id;
  const session = req.adminSession;
  const orderId = `gid://shopify/Order/${numId}`;
  const method  = String(req.body.paymentMethod || '').trim();
  const note    = String(req.body.note || '').trim().slice(0, 500);
  const rawDate = String(req.body.processedAt || '').trim();
  const rawAmt  = String(req.body.amount ?? '').trim();
  const amountProvided = rawAmt !== '';
  const amt     = amountProvided ? parseFloat(rawAmt) : null;

  // processedAt: accept a date (yyyy-mm-dd) and send an ISO datetime; blank ⇒ omit (Shopify uses now).
  let processedAt = null;
  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) processedAt = d.toISOString();
  }

  if (!method) return res.redirect(`/orders/${numId}?error=method_required`);

  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ error: 'order not found' });
    const outstanding = (() => {
      const v = order.totalOutstandingSet?.presentmentMoney?.amount;
      if (v != null && v !== '') return Math.max(0, parseFloat(v) || 0);
      if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.displayFinancialStatus)) return 0;
      return Math.max(0, parseFloat(order.totalPriceSet?.presentmentMoney?.amount || 0) || 0);
    })();
    if (!(outstanding > 0)) return res.redirect(`/orders/${numId}?error=payment_failed&msg=${encodeURIComponent('Order has no outstanding balance to pay.')}`);
    // Full-payment only (Advanced plan): mark the whole balance paid.
    const overrides = mockOrderOverrides.get(numId) || {};
    const newReceived = parseFloat(order.totalReceivedSet?.presentmentMoney?.amount || 0) + outstanding;
    overrides.displayFinancialStatus = 'PAID';
    overrides.totalOutstandingSet = { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } };
    overrides.totalReceivedSet    = { presentmentMoney: { amount: newReceived.toFixed(2), currencyCode: 'USD' } };
    const existingTx = overrides.transactions || order.transactions || [];
    overrides.transactions = [...existingTx, {
      id: `tx-manual-${Date.now()}`, status: 'SUCCESS', kind: 'SALE', gateway: method,
      createdAt: processedAt || new Date().toISOString(),
      amountSet: { presentmentMoney: { amount: outstanding.toFixed(2), currencyCode: 'USD' } },
    }];
    mockOrderOverrides.set(numId, overrides);
    auditLog(session.email, 'record_manual_payment', orderId, null, { amount: 'full_balance', paymentMethod: method, note, processedAt });
    return res.redirect(`/orders/${numId}?success=payment_recorded`);
  }

  try {
    // Re-fetch the FRESH outstanding right before mutating (don't trust the page prefill —
    // an in-flight auto-save edit may have changed the order total since render).
    const freshRes = await shopifyFetch(`query($id:ID!){order(id:$id){displayFinancialStatus totalOutstandingSet{presentmentMoney{amount currencyCode}}}}`, { id: orderId });
    const fo = freshRes.data?.order;
    if (!fo) return res.redirect(`/orders/${numId}?error=payment_failed&msg=${encodeURIComponent('Order not found.')}`);
    const outstanding = Math.max(0, parseFloat(fo.totalOutstandingSet?.presentmentMoney?.amount || 0) || 0);
    if (!(outstanding > 0)) {
      return res.redirect(`/orders/${numId}?error=payment_failed&msg=${encodeURIComponent('Order has no outstanding balance to pay (it may be a comp / 100%-discount order, already paid, or in-flight edits removed the balance).')}`);
    }
    // Full-payment only: orderCreateManualPayment is Shopify-Plus-gated and this store is on
    // "Advanced"; orderMarkAsPaid works on all plans and marks the full outstanding paid. The
    // method + note are recorded in the audit/order-history (not on the Shopify transaction).
    const r = await shopifyFetch(`mutation mp($id:ID!){
      orderMarkAsPaid(input:{id:$id}){
        order{ id displayFinancialStatus totalReceivedSet{presentmentMoney{amount}} }
        userErrors{ field message }
      }
    }`, { id: orderId });
    const ue = r.data?.orderMarkAsPaid?.userErrors || [];
    if (ue.length) {
      const msg = ue.map(e => e.message).join('; ');
      console.error('record-payment userErrors:', msg);
      return res.redirect(`/orders/${numId}?error=payment_failed&msg=${encodeURIComponent(msg.slice(0, 200))}`);
    }
    auditLog(session.email, 'record_manual_payment', orderId, null, { amount: amountProvided ? amt.toFixed(2) : 'full_outstanding', paymentMethod: method, note, processedAt });
    return res.redirect(`/orders/${numId}?success=payment_recorded`);
  } catch (err) {
    console.error('record-payment error:', err.message);
    return res.redirect(`/orders/${numId}?error=payment_failed&msg=${encodeURIComponent(err.message.slice(0, 200))}`);
  }
});

// 16C: Partial fulfillment
// WHAT: 16C partial fulfillment — body liRaw{lineItemId:qty}; real mode maps original lineItem ids to OPEN/IN_PROGRESS fulfillmentOrder line items then fulfillmentCreate with optional tracking.
// CHANGE-GUARD: wantedQty is clamped to mapping.remaining; lines with no FO map are skipped with a warn (silent partial); fulfillBackorder() is called per requested li after success to clear backorder flags — keep that loop.
// INVARIANT(S): throws 'No matching open fulfillment orders' if nothing maps; fulfillmentOrders query is capped first:10 / lineItems first:50 — orders exceeding those page sizes silently drop lines (see bugs[]).
app.post('/orders/:id/fulfill', requireAuth, async (req, res) => {
  const numId   = req.params.id;
  const session = req.adminSession;
  const { lineItems: liRaw, trackingCompany, trackingNumber, notifyCustomer } = req.body;
  // liRaw: { lineItemId: qty, ... } or { 'li1': '2', 'li2': '3' }
  const lineItemsMap = Object.fromEntries(
    Object.entries(liRaw || {}).map(([k, v]) => [k, parseInt(v, 10) || 0]).filter(([,qty]) => qty > 0)
  );
  if (!Object.keys(lineItemsMap).length) return res.redirect(`/orders/${numId}?error=no_items_selected`);

  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ error: 'not found' });
    const overrides = mockOrderOverrides.get(numId) || {};
    const tracking = trackingNumber ? [{ number: trackingNumber, url: null, company: trackingCompany || '' }] : [];
    const existingFulfillments = overrides.fulfillments || order.fulfillments || [];
    overrides.fulfillments = [...existingFulfillments, {
      status: 'SUCCESS', trackingInfo: tracking, createdAt: new Date().toISOString(),
      lineItemIds: Object.keys(lineItemsMap),
    }];
    overrides.displayFulfillmentStatus = 'PARTIALLY_FULFILLED';
    // Mark backorders as fulfilled for matched lines
    for (const liId of Object.keys(lineItemsMap)) {
      fulfillBackorder(`gid://shopify/Order/${numId}`, liId);
    }
    mockOrderOverrides.set(numId, overrides);
    auditLog(session.email, 'order_fulfill', `gid://shopify/Order/${numId}`, null, { lineItems: lineItemsMap, trackingNumber });
    return res.redirect(`/orders/${numId}?success=fulfilled`);
  }

  // Real mode: fulfillmentCreate with FulfillmentV2Input + fulfillmentOrderId lookup
  try {
    const orderId    = `gid://shopify/Order/${numId}`;
    const trackInput = trackingNumber ? { company: trackingCompany || '', number: trackingNumber, url: null } : null;

    // Step 1: fetch fulfillmentOrders for this order + their line items, map original lineItemId -> fulfillmentOrderLineItem
    const foRes = await shopifyFetch(`query($id:ID!){order(id:$id){
      fulfillmentOrders(first:10){edges{node{
        id status
        lineItems(first:50){edges{node{id remainingQuantity lineItem{id title}}}}
      }}}
    }}`, { id: orderId });
    const fos = foRes.data?.order?.fulfillmentOrders?.edges?.map(e => e.node) || [];
    // Find OPEN/IN_PROGRESS fulfillmentOrders, build map original_li_id -> { fulfillmentOrderId, foLineItemId, remaining }
    const liMap = {};
    for (const fo of fos) {
      if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') continue;
      for (const edge of fo.lineItems.edges) {
        const foLi = edge.node;
        const origId = foLi.lineItem?.id;
        if (origId && foLi.remainingQuantity > 0) {
          liMap[origId] = { foId: fo.id, foLiId: foLi.id, remaining: foLi.remainingQuantity };
        }
      }
    }

    // Step 2: group requested line items by fulfillmentOrderId
    const groupedByFo = {};
    for (const [origLiId, qty] of Object.entries(lineItemsMap)) {
      const mapping = liMap[origLiId];
      if (!mapping) { console.warn('[fulfill] no FO map for', origLiId); continue; }
      const wantedQty = Math.min(qty, mapping.remaining);
      if (!groupedByFo[mapping.foId]) groupedByFo[mapping.foId] = [];
      groupedByFo[mapping.foId].push({ id: mapping.foLiId, quantity: wantedQty });
    }
    const fulfillmentOrderInput = Object.entries(groupedByFo).map(([foId, items]) => ({
      fulfillmentOrderId: foId,
      fulfillmentOrderLineItems: items,
    }));
    if (fulfillmentOrderInput.length === 0) throw new Error('No matching open fulfillment orders');

    const result = await shopifyFetch(`mutation fulfill($f:FulfillmentInput!){
      fulfillmentCreate(fulfillment:$f){fulfillment{id status} userErrors{field message}}
    }`, { f: { lineItemsByFulfillmentOrder: fulfillmentOrderInput, trackingInfo: trackInput, notifyCustomer: !!notifyCustomer } });
    const errs = result.data?.fulfillmentCreate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join(', '));
    // Mark any matching backorders as fulfilled
    for (const liId of Object.keys(lineItemsMap)) {
      fulfillBackorder(orderId, liId);
    }
    auditLog(session.email, 'order_fulfill', orderId, null, { lineItems: lineItemsMap, trackingNumber });
    res.redirect(`/orders/${numId}?success=fulfilled`);
  } catch (err) {
    console.error('fulfillment error:', err.message);
    res.redirect(`/orders/${numId}?error=fulfillment_failed`);
  }
});

// 16D: Backorder flag per line item
// WHAT: 16D — flags a single line item as backordered via upsertBackorder(orderGid, lineItemId, title, qty, eta, by).
// CHANGE-GUARD: synchronous handler (no await) — upsertBackorder must stay sync or wrap; quantity parsed with parseInt fallback 0, eta passed through nullable.
// INVARIANT(S): keyed on gid://shopify/Order/<id> + lineItemId; fulfilling the same line later calls fulfillBackorder with the SAME lineItemId to clear it — id formats must match across backorder/fulfill routes.
app.post('/orders/:id/backorder', requireAuth, (req, res) => {
  const numId   = req.params.id;
  const { lineItemId, lineItemTitle, quantity, eta } = req.body;
  if (!lineItemId) return res.redirect(`/orders/${numId}?error=missing_line_item`);
  const orderId = `gid://shopify/Order/${numId}`;
  upsertBackorder(orderId, lineItemId, lineItemTitle || '', parseInt(quantity, 10) || 0, eta || null, req.adminSession.email);
  auditLog(req.adminSession.email, 'order_backorder', orderId, null, { lineItemId, lineItemTitle, eta });
  res.redirect(`/orders/${numId}?success=backorder_flagged`);
});

// API: get backorders for an order (used by order detail page)
// WHAT: returns backorder rows for one order (consumed by the order-detail page).
// INVARIANT(S): wraps numeric :id into the order gid before getBackordersForOrder — same prefix as the writer.
app.get('/api/orders/:id/backorders', requireAuth, (req, res) => {
  const orderId = `gid://shopify/Order/${req.params.id}`;
  res.json({ backorders: getBackordersForOrder(orderId) });
});

// API: get all open backorders
// WHAT: returns ALL open backorders across orders (feeds the /backorders queue page and any dashboards).
// CHANGE-GUARD: getOpenBackorders() is unbounded — if backorder volume grows this needs pagination/limit.
app.get('/api/admin/backorders', requireAuth, (req, res) => {
  res.json({ backorders: getOpenBackorders() });
});

// ── Task #45: Backorder queue page ──────────────────────────────────────────
// WHAT: Task #45 — HTML backorder-queue page; renders one row per open backorder with order link, qty, ETA, age, and creator.
// CHANGE-GUARD: eta_date is parsed as `${eta_date}T00:00:00` (local-midnight) to avoid UTC off-by-one day shifts — keep the T00:00:00 suffix; age uses /86400000 ms-per-day.
// INVARIANT(S): all interpolated cells go through h() for XSS-escaping; order_id is stripped of the gid prefix only for display/link.
app.get('/backorders', requireAuth, (req, res) => {
  const backorders = getOpenBackorders();
  const rows = backorders.map(b => {
    const numOrderId = b.order_id.replace('gid://shopify/Order/', '');
    const etaDisplay = b.eta_date ? new Date(b.eta_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const age = Math.floor((Date.now() - b.created_at) / 86400000);
    const ageLabel = age === 0 ? 'today' : age === 1 ? '1 day ago' : `${age} days ago`;
    return `<tr>
      <td><a href="/orders/${h(numOrderId)}" class="link">#${h(numOrderId)}</a></td>
      <td>${h(b.line_item_title || '—')}</td>
      <td>${h(String(b.quantity))}</td>
      <td>${h(etaDisplay)}</td>
      <td><span class="text-muted small-text">${h(ageLabel)}</span></td>
      <td>${h(b.created_by || '—')}</td>
    </tr>`;
  }).join('');

  const content = `
    <div class="page-header">
      <h1>Backorder Queue</h1>
      <span class="badge">${backorders.length} pending</span>
    </div>
    ${backorders.length === 0
      ? `<div class="card"><div class="card-body text-muted" style="padding:2rem;text-align:center">No pending backorders.</div></div>`
      : `<div class="card">
        <div class="table-wrap">
          <table class="data-table" id="backorder-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Item</th>
                <th>Qty</th>
                <th>ETA</th>
                <th>Flagged</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`
    }`;
  res.send(layout({ title: 'Backorder Queue', session: req.adminSession, activePath: '/backorders', content }));
});

// ── Phase 14D: Visible notes API (proxies to portal internal) ─────────────────

// WHAT: Phase 14D — adds a customer-visible note to an order by proxying to the portal's internal API (callPortalInternal POST /__internal__/visible-note).
// CHANGE-GUARD: MOCK short-circuits with a fake noteId:1; real failures return 500 with result.error — keep the trimmed-body 400 guard.
// INVARIANT(S): addedBy is the admin session email; auditLog only fires on the real (non-MOCK) success path; the portal-internal contract (path + payload keys orderId/body/addedBy) must stay in sync with the portal repo.
app.post('/api/orders/:id/visible-note', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const shopifyId = `gid://shopify/Order/${numId}`;
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (MOCK) {
    return res.json({ ok: true, noteId: 1, mock: true });
  }
  const result = await callPortalInternal('POST', `/__internal__/visible-note`, {
    orderId: shopifyId, body, addedBy: req.adminSession.email,
  });
  if (!result.ok) return res.status(500).json({ error: result.error || 'failed' });
  auditLog(req.adminSession.email, 'visible-note-add', shopifyId, null, { body });
  res.json({ ok: true, noteId: result.noteId });
});

// WHAT: returns locally-cached visible notes for an order (getVisibleNotesForOrder), independent of the portal proxy used to write them.
// INVARIANT(S): read path is local cache only — a note written via the POST proxy is not guaranteed visible here until the cache syncs.
app.get('/api/orders/:id/visible-notes', requireAuth, (req, res) => {
  const shopifyId = `gid://shopify/Order/${req.params.id}`;
  res.json({ notes: getVisibleNotesForOrder(shopifyId) });
});

// WHAT: fetches Re:amaze/portal customer message threads for an order via callPortalInternal POST /__internal__/customer-messages.
// CHANGE-GUARD: MOCK returns empty threads; real failures return 500 — front-end must tolerate both threads:[] and customerEmail:null.
// INVARIANT(S): read-only; depends on the portal-internal contract returning {threads,customerEmail}.
app.get('/api/orders/:id/customer-messages', requireAuth, async (req, res) => {
  const shopifyId = `gid://shopify/Order/${req.params.id}`;
  if (MOCK) return res.json({ threads: [], customerEmail: null, mock: true });
  const result = await callPortalInternal('POST', '/__internal__/customer-messages', { orderId: shopifyId });
  if (!result.ok) return res.status(500).json({ error: result.error || 'failed' });
  res.json({ threads: result.threads || [], customerEmail: result.customerEmail || null });
});

// WHAT: chat-box feed — proxies one Re:amaze thread's CLEAN per-message data to the portal-internal
//   twin GET /__internal__/conversations/:slug/messages so the order-detail chat box can render
//   us/them bubbles with timestamps and NO HTML / headers / quoted history. Mirrors the
//   customer-messages proxy above (requireAuth + callPortalInternal with the shared internal bearer).
// CHANGE-GUARD: read-only; MOCK returns an empty thread; real portal failure returns 500. The slug is
//   passed through verbatim from the customer-messages thread list — front-end must encode it. The
//   portal returns text already HTML/header/quote-scrubbed; do NOT re-inject raw body[] into the DOM.
// INVARIANT(S): shape = { ok, messages:[{ text, sender:'us'|'them', at, atDisplay, ... }] }; depends on
//   the portal-internal contract (B2B_PORTAL_INTERNAL_TOKEN) being set — else callPortalInternal returns ok:false.
app.get('/api/orders/:id/conversations/:slug/messages', requireAuth, async (req, res) => {
  if (MOCK) return res.json({ ok: true, messages: [], mock: true });
  const slug = encodeURIComponent(req.params.slug);
  const result = await callPortalInternal('GET', `/__internal__/conversations/${slug}/messages`, null);
  if (!result.ok) return res.status(500).json({ ok: false, error: result.error || 'failed' });
  res.json({ ok: true, messages: result.messages || [] });
});

// ── Phase 14C: Tax exempt admin review page ───────────────────────────────────

// WHAT: Phase 14C — admin review page listing pending tax-exempt certificates pulled from the portal (getPendingTaxCertsFromPortal); approve/reject post to sibling routes.
// CHANGE-GUARD: the 'View PDF' link rewrites PORTAL_INTERNAL_URL's 127.0.0.1 -> b2b.fuzzyreporting.com so the admin's browser (not the server) can reach it — keep that rewrite or the link 404s for users; getPendingTaxCertsFromPortal is called SYNCHRONOUSLY in a sync handler (see bugs[] — likely returns a Promise).
// INVARIANT(S): MOCK shows no certs; customerId is split on '/' to recover the numeric id; all dynamic fields are h()-escaped.
app.get('/tax-exempt', requireAuth, (req, res) => {
  const pendingCerts = MOCK ? [] : getPendingTaxCertsFromPortal();
  const flashHtml = req.query.success === 'approved'
    ? `<div class="alert alert-success">Certificate approved — customer is now tax-exempt.</div>`
    : req.query.success === 'rejected'
    ? `<div class="alert alert-success">Certificate rejected.</div>`
    : '';
  const rows = pendingCerts.map(c => `
    <tr>
      <td><a href="/customers/${c.customerId.split('/').pop()}">${h(c.customerId.split('/').pop())}</a></td>
      <td>${h(c.state || '—')}</td>
      <td>${new Date(c.uploadedAt).toLocaleDateString()}</td>
      <td>
        <a href="${h(PORTAL_INTERNAL_URL.replace('127.0.0.1', 'b2b.fuzzyreporting.com'))}/api/admin/tax-exempt/${c.id}/file" target="_blank" class="btn btn-sm btn-secondary">View PDF</a>
        <form method="POST" action="/tax-exempt/${c.id}/approve" style="display:inline">
          <button class="btn btn-sm btn-success" onclick="return confirm('Approve this certificate?')">Approve</button>
        </form>
        <form method="POST" action="/tax-exempt/${c.id}/reject" style="display:inline">
          <input type="hidden" name="reason" value="Certificate does not meet requirements">
          <button class="btn btn-sm" style="border:1px solid var(--danger);color:var(--danger)" onclick="return confirm('Reject this certificate?')">Reject</button>
        </form>
      </td>
    </tr>`).join('');
  res.send(layout({ title: 'Tax Exempt Review', session: req.adminSession, activePath: '/tax-exempt', content: `
    <div class="page-header"><h1>Tax Exemption Certs — Pending Review</h1></div>
    ${flashHtml}
    <div class="card">
      <table class="data-table">
        <thead><tr><th>Customer ID</th><th>State</th><th>Uploaded</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No pending certificates.</td></tr>'}</tbody>
      </table>
    </div>` }));
});

// WHAT: approves a tax-exempt cert by proxying to portal /__internal__/tax-exempt/:id/approve with reviewedBy=admin email.
// CHANGE-GUARD: auditLog fires BEFORE checking result.ok, so a failed approve is still audited as an approve attempt; redirect flash reflects result.ok.
// INVARIANT(S): MOCK redirects success without calling the portal; :id is the cert id passed straight into the portal path (ensure portal validates it).
app.post('/tax-exempt/:id/approve', requireAuth, async (req, res) => {
  if (MOCK) return res.redirect('/tax-exempt?success=approved');
  const result = await callPortalInternal('POST', `/__internal__/tax-exempt/${req.params.id}/approve`, {
    reviewedBy: req.adminSession.email,
  });
  auditLog(req.adminSession.email, 'tax-cert-approve', `cert:${req.params.id}`, null, { reviewedBy: req.adminSession.email });
  res.redirect(`/tax-exempt?success=${result.ok ? 'approved' : 'error'}`);
});

// WHAT: rejects a tax-exempt cert with a reason (capped 500 chars) via the portal-internal reject endpoint.
// CHANGE-GUARD: same pre-check audit ordering as approve; reason defaults to 'Rejected'.
// INVARIANT(S): MOCK redirects success without portal call; reviewedBy recorded from session email.
app.post('/tax-exempt/:id/reject', requireAuth, async (req, res) => {
  if (MOCK) return res.redirect('/tax-exempt?success=rejected');
  const reason = String(req.body?.reason || 'Rejected').slice(0, 500);
  const result = await callPortalInternal('POST', `/__internal__/tax-exempt/${req.params.id}/reject`, {
    reviewedBy: req.adminSession.email, reason,
  });
  auditLog(req.adminSession.email, 'tax-cert-reject', `cert:${req.params.id}`, null, { reason });
  res.redirect(`/tax-exempt?success=${result.ok ? 'rejected' : 'error'}`);
});

// Phase 4: Customers CSV export
// WHAT: Phase 4 — streams a CSV of all tag:b2b customers sorted by AMOUNT_SPENT desc, paginating Shopify customers in pages of 250.
// CHANGE-GUARD: pagination loop is hard-capped at 10 pages (max 2500 customers) — beyond that the export SILENTLY truncates with no warning (see bugs[]); response is streamed via res.write so headers are committed before the loop (cannot switch to an error status mid-stream).
// INVARIANT(S): column order is fixed by the header csvLine; tags joined with '|'; ids reduced via shopifyNumericId.
app.get('/customers/export.csv', requireAuth, async (req, res) => {
  const ts = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fww-b2b-customers-${ts}.csv"`);
  res.write(csvLine(['customer_id','name','email','phone','tags','lifetime_spend','orders','city','province','country']));
  const customers = MOCK
    ? MOCK_CUSTOMERS
    : await (async () => {
        const all = [];
        let after = null;
        for (let page = 0; page < 10; page++) {
          const result = await shopifyFetch(
            `query($q:String!,$first:Int!,$after:String){customers(first:$first,query:$q,after:$after,sortKey:AMOUNT_SPENT,reverse:true){edges{cursor node{id displayName email phone tags amountSpent{amount} numberOfOrders defaultAddress{city province country}}}pageInfo{hasNextPage endCursor}}}`,
            { q: 'tag:b2b', first: 250, after });
          const edges = result.data?.customers?.edges || [];
          all.push(...edges.map(e => e.node));
          if (!result.data?.customers?.pageInfo?.hasNextPage) break;
          after = result.data.customers.pageInfo.endCursor;
        }
        return all;
      })();
  for (const c of customers) {
    const addr = c.defaultAddress || {};
    res.write(csvLine([
      shopifyNumericId(c.id),
      c.displayName || '',
      c.email || '',
      c.phone || '',
      Array.isArray(c.tags) ? c.tags.join('|') : (c.tags || ''),
      c.amountSpent?.amount || '',
      c.numberOfOrders || '',
      addr.city || '',
      addr.province || '',
      addr.country || '',
    ]));
  }
  res.end();
});

// ── Customers ──
// WHAT: customer list page; filters {q,segment,tag,after,sort} -> getCustomersData -> renderCustomersList.
// INVARIANT(S): cursor pagination via ?after (Shopify endCursor); all filters originate from query string and must be forwarded verbatim to keep next/prev links stable.
app.get('/customers', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', segment: req.query.segment || '', tag: req.query.tag || '', after: req.query.after || '', sort: req.query.sort || '' };
  const data = await getCustomersData(filters);
  res.send(renderCustomersList(req.adminSession, data, filters));
});

// WHAT: customer detail page — parallel-fetches detail, recent orders, and B2B config (Promise.all), then loads notes, dropship cache, and impersonation history before rendering.
// CHANGE-GUARD: Promise.all means any one rejection 500s the whole page; the three follow-up reads (notes/dropship/imp) are sync local-cache calls keyed on shopifyCustomerGid(:id) — keep gid derivation consistent.
// INVARIANT(S): 404 renders a friendly layout, not JSON; impersonation history limited to 10.
app.get('/customers/:id', requireAuth, async (req, res) => {
  const [customer, recentOrders, b2bConfig] = await Promise.all([
    getCustomerDetail(req.params.id),
    getCustomerRecentOrders(req.params.id),
    getB2bConfig(req.params.id),
  ]);
  if (!customer) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/customers',
    content: '<div class="page-header"><h1>Customer not found</h1></div><a href="/customers" class="btn btn-secondary">← Customers</a>' }));
  const notes    = getCustomerNotes(shopifyCustomerGid(req.params.id));
  const dropship = getDropshipCache(shopifyCustomerGid(req.params.id));
  const impHistory = listImpersonationsForCustomer(shopifyCustomerGid(req.params.id), 10);
  res.send(renderCustomerDetail(req.adminSession, customer, recentOrders, notes, dropship, b2bConfig, req.query.success || '', impHistory));
});

// WHAT: saves internal admin notes (max 5000 chars) for a customer to local store; audit logs a 100-char preview.
// INVARIANT(S): notes are local-only (not synced to Shopify); gid via shopifyCustomerGid.
app.post('/customers/:id/notes', requireAuth, (req, res) => {
  const body = String(req.body.body || '').slice(0, 5000);
  const gid  = shopifyCustomerGid(req.params.id);
  setCustomerNotes(gid, body, req.adminSession.email);
  auditLog(req.adminSession.email, 'update_customer_notes', gid, null, { body: body.slice(0, 100) });
  res.redirect(`/customers/${req.params.id}?success=notes_saved`);
});

// WHAT: adds a Shopify customer tag (tagsAdd mutation, max 100 chars); when tag==='b2b' it ALSO fires a non-blocking Xero customer sync.
// CHANGE-GUARD: tagsAdd userErrors are fetched but NOT inspected — a rejected tag still audits+redirects success; the Xero sync is fire-and-forget (.then/.catch) so its failure never blocks the response but also is only audited on success.
// INVARIANT(S): syncCustomerToXero gets {email:''} (no email) — verify Xero sync can resolve the contact from the customer id alone, else it may create a blank/duplicate contact (see bugs[]).
app.post('/customers/:id/tags/add', requireAuth, async (req, res) => {
  const tag  = String(req.body.tag || '').trim().slice(0, 100);
  const gid  = shopifyCustomerGid(req.params.id);
  if (!tag) return res.redirect(`/customers/${req.params.id}`);
  if (!MOCK) {
    try {
      await shopifyFetch(`mutation tagsAdd($id:ID!,$tags:[String!]!){
        tagsAdd(id:$id,tags:$tags){ node{id} userErrors{field message} }
      }`, { id: gid, tags: [tag] });
    } catch (err) { console.error('tagsAdd error:', err.message); }
  }
  auditLog(req.adminSession.email, 'add_tag', gid, null, { tag });
  // Phase 21C: when b2b tag is added, trigger Xero sync (non-blocking)
  if (tag === 'b2b') {
    // [XERO-DISABLED] dryRun when writes off: PUT is blocked by the xeroRequest
    // backstop, and dryRun stops a fake mapping-file entry from being persisted.
    syncCustomerToXero(req.params.id, { email: '' }, xeroRequest, { dryRun: MOCK || !XERO_WRITES_ENABLED })
      .then(r => { if (r.created) auditLog(req.adminSession.email, 'xero:customer_sync', gid, null, { xeroContactId: r.xeroContactId, via: 'tag_add' }); })
      .catch(e => console.error('[xero-sync] tag add sync failed:', e.message));
  }
  res.redirect(`/customers/${req.params.id}?success=tags_added`);
});

// WHAT: removes a Shopify customer tag (tagsRemove mutation, max 100 chars).
// CHANGE-GUARD: success redirect uses ?success=tags_added (copy-paste from the add route — cosmetic but misleading flash); userErrors swallowed like the add route.
// INVARIANT(S): removing the 'b2b' tag does NOT reverse the Xero sync — there is no de-sync counterpart to the add route's Xero hook.
app.post('/customers/:id/tags/remove', requireAuth, async (req, res) => {
  const tag = String(req.body.tag || '').trim().slice(0, 100);
  const gid = shopifyCustomerGid(req.params.id);
  if (!tag) return res.redirect(`/customers/${req.params.id}`);
  if (!MOCK) {
    try {
      await shopifyFetch(`mutation tagsRemove($id:ID!,$tags:[String!]!){
        tagsRemove(id:$id,tags:$tags){ node{id} userErrors{field message} }
      }`, { id: gid, tags: [tag] });
    } catch (err) { console.error('tagsRemove error:', err.message); }
  }
  auditLog(req.adminSession.email, 'remove_tag', gid, null, { tag });
  res.redirect(`/customers/${req.params.id}?success=tags_added`);
});

// WHAT: toggles dropship + margin% for a customer; writes local cache AND Shopify metafields (namespace 'b2b', keys dropship_enabled/dropship_margin_pct).
// CHANGE-GUARD: marginPct is clamped 0..100 via Math.max/min; metafieldsSet userErrors are swallowed so a failed Shopify write leaves the local cache and Shopify out of sync (see bugs[]); enabled accepts both 'on' and 'true'.
// INVARIANT(S): local setDropshipCache always runs even in MOCK; metafield types must stay boolean / number_integer to match the portal reader.
app.post('/customers/:id/dropship', requireAuth, async (req, res) => {
  const enabled   = req.body.enabled === 'on' || req.body.enabled === 'true';
  const marginPct = Math.max(0, Math.min(100, parseInt(req.body.margin_pct || '0', 10)));
  const gid       = shopifyCustomerGid(req.params.id);
  setDropshipCache(gid, enabled, marginPct);
  if (!MOCK) {
    try {
      await shopifyFetch(`mutation metafieldsSet($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ metafields{id key value} userErrors{field message} }
      }`, { metafields: [
        { ownerId: gid, namespace: 'b2b', key: 'dropship_enabled', value: String(enabled), type: 'boolean' },
        { ownerId: gid, namespace: 'b2b', key: 'dropship_margin_pct', value: String(marginPct), type: 'number_integer' },
      ]});
    } catch (err) { console.error('metafieldsSet error:', err.message); }
  }
  auditLog(req.adminSession.email, 'update_dropship', gid, null, { enabled, marginPct });
  res.redirect(`/customers/${req.params.id}?success=dropship_saved`);
});

// ── Phase 7/10: B2B config (unified: discount + dropship + allow_order_on_invoice) ──

// WHAT: Phase 7/10 unified B2B-config form POST (discount + dropship + allow_order_on_invoice); checkboxes absent from the body are coerced to explicit 'false'.
// CHANGE-GUARD: the checkbox-absence coercion is load-bearing — unchecked HTML checkboxes are omitted entirely, so without this an unchecked box would leave the prior value; keep dropship_enabled/allow_order_on_invoice in the coercion list when adding new checkboxes.
// INVARIANT(S): before/after snapshots from getB2bConfig bracket applyB2bConfigUpdate for an accurate audit diff.
app.post('/customers/:id/b2b-config', requireAuth, async (req, res) => {
  const numId = req.params.id;
  // Checkboxes: if absent from form body, checkbox was unchecked → explicitly set false
  const body = {
    ...req.body,
    dropship_enabled:       'dropship_enabled'       in req.body ? req.body.dropship_enabled       : 'false',
    allow_order_on_invoice: 'allow_order_on_invoice' in req.body ? req.body.allow_order_on_invoice : 'false',
  };
  const before = await getB2bConfig(numId);
  await applyB2bConfigUpdate(numId, body);
  const after = await getB2bConfig(numId);
  auditLog(req.adminSession.email, 'customer:b2b-config', shopifyCustomerGid(numId), before.overrides, after.overrides);
  res.redirect(`/customers/${numId}?success=b2b_settings_saved`);
});

// WHAT: JSON read of a customer's effective B2B config (getB2bConfig).
// INVARIANT(S): read-only; shape must match the PUT writer's response and the form POST's audit snapshots.
app.get('/api/admin/customers/:id/b2b-config', requireAuth, async (req, res) => {
  res.json(await getB2bConfig(req.params.id));
});

// WHAT: JSON API to update B2B config (same applyB2bConfigUpdate as the form route) returning {ok,...after}.
// CHANGE-GUARD: unlike the form POST this does NOT coerce missing checkboxes to 'false' — a partial JSON body only updates the keys present, so API and form callers have DIFFERENT merge semantics (see bugs[]).
// INVARIANT(S): before/after audit diff preserved.
app.put('/api/admin/customers/:id/b2b-config', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const before = await getB2bConfig(numId);
  await applyB2bConfigUpdate(numId, req.body);
  const after = await getB2bConfig(numId);
  auditLog(req.adminSession.email, 'customer:b2b-config', shopifyCustomerGid(numId), before.overrides, after.overrides);
  res.json({ ok: true, ...after });
});

// ── 19A: Customer spend API ──

// Manual cache refresh endpoint
// WHAT: manual trigger to refresh the local orders/customers cache from Shopify (syncRecentFromShopify) if that fn is defined.
// CHANGE-GUARD: guarded by typeof check so it no-ops (still returns ok:true) when the sync fn isn't loaded — callers cannot distinguish 'synced' from 'no-op'.
// INVARIANT(S): returns syncedAt timestamp; a real sync failure surfaces as 500 with err.message.
app.post('/api/admin/sync-now', requireAuth, async (req, res) => {
  try {
    if (typeof syncRecentFromShopify === 'function') {
      await syncRecentFromShopify();
    }
    res.json({ ok: true, syncedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WHAT: 19A/24D customer spend API; returns lifetime + date-ranged totals/orders. Tries the local orders cache first (real mode), then MOCK, then live Shopify.
// CHANGE-GUARD: three code paths must return the SAME JSON shape {lifetimeTotal,lifetimeCount,rangeTotal,rangeCount,orders[]}; the live query caps orders at first:250 with NO pagination so a customer with >250 in-range orders is silently truncated (see bugs[]); from/to default to epoch-0 .. now+1day.
// INVARIANT(S): cache path requires both a cached customer AND non-empty cache stats before short-circuiting; range filter is inclusive on both ends (created_at>=from && <=to).
app.get('/api/admin/customers/:id/spend', requireAuth, async (req, res) => {
  const numId  = req.params.id;
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : 0;
  const toTs   = req.query.to   ? new Date(req.query.to).getTime()   : Date.now() + 86400000;

  // Phase 24D: try cache first
  if (!MOCK) {
    try {
      const cust = getCustomerFromCache(numId);
      const stats = getOrdersCacheStats();
      if (cust && stats && stats.total > 0) {
        const allOrders = getCustomerOrdersFromCache(numId);
        const rangeOrders = allOrders.filter(o => o.created_at >= fromTs && o.created_at <= toTs);
        const rangeTotal = rangeOrders.reduce((s, o) => s + (o.total_price || 0), 0);
        return res.json({
          lifetimeTotal: String(cust.amount_spent_total || 0),
          lifetimeCount: cust.orders_count || 0,
          rangeTotal: rangeTotal.toFixed(2),
          rangeCount: rangeOrders.length,
          orders: rangeOrders.map(o => ({
            id: o.shopify_id,
            name: o.name,
            processedAt: new Date(o.processed_at || o.created_at).toISOString(),
            total: String(o.total_price || 0),
            financialStatus: o.financial_status || o.display_financial_status,
            fulfillmentStatus: o.fulfillment_status || o.display_fulfillment_status,
          })),
          _fromCache: true,
        });
      }
    } catch (e) {
      console.error('spend cache read failed, falling back to live Shopify:', e.message);
    }
  }
  if (MOCK) {
    const gid = shopifyCustomerGid(numId);
    const all = MOCK_ORDERS.filter(o => o.customer?.id === gid);
    const lifetimeTotal = all.reduce((s, o) => s + parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0), 0);
    const range = all.filter(o => {
      const d = new Date(o.processedAt).getTime();
      return d >= fromTs && d <= toTs;
    });
    const rangeTotal = range.reduce((s, o) => s + parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0), 0);
    return res.json({
      lifetimeTotal: lifetimeTotal.toFixed(2),
      lifetimeCount: all.length,
      rangeTotal: rangeTotal.toFixed(2),
      rangeCount: range.length,
      orders: range.map(o => ({
        id:   shopifyNumericId(o.id),
        name: o.name,
        processedAt: o.processedAt,
        total: o.totalPriceSet?.presentmentMoney?.amount || '0.00',
        financialStatus: o.displayFinancialStatus,
        fulfillmentStatus: o.displayFulfillmentStatus,
      })),
    });
  }

  try {
    const gid = shopifyCustomerGid(numId);
    const fromStr = new Date(fromTs).toISOString().split('T')[0];
    const toStr   = new Date(toTs  ).toISOString().split('T')[0];
    const r = await shopifyFetch(`
      query($id:ID!,$q:String!){
        customer(id:$id){
          amountSpent{amount currencyCode}
          numberOfOrders
          orders(first:250,query:$q,sortKey:PROCESSED_AT,reverse:true){
            edges{node{
              id name processedAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet{presentmentMoney{amount currencyCode}}
            }}
          }
        }
      }`, { id: gid, q: `processed_at:>=${fromStr} processed_at:<=${toStr}` });
    const cust = r.data?.customer;
    if (!cust) return res.status(404).json({ error: 'not found' });
    const orders = cust.orders.edges.map(e => e.node);
    const rangeTotal = orders.reduce((s, o) => s + parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0), 0);
    res.json({
      lifetimeTotal: cust.amountSpent?.amount || '0.00',
      lifetimeCount: cust.numberOfOrders || 0,
      rangeTotal: rangeTotal.toFixed(2),
      rangeCount: orders.length,
      orders: orders.map(o => ({
        id:   shopifyNumericId(o.id),
        name: o.name,
        processedAt: o.processedAt,
        total: o.totalPriceSet?.presentmentMoney?.amount || '0.00',
        financialStatus: o.displayFinancialStatus,
        fulfillmentStatus: o.displayFulfillmentStatus,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API search ──
// WHAT: typeahead customer search (draft-order builder); MOCK filters MOCK_CUSTOMERS, real mode queries Shopify customers with `tag:b2b <q>` capped first:10.
// CHANGE-GUARD: the per-result discount enrichment reads each customer's b2b.discount_pct metafield (fetched inline in the customers query -- no N+1) and falls back to the global b2b_discount_pct default; keep the parse in sync with getB2bConfig.
// INVARIANT(S): results are capped to 10; every result must include discountPct so the draft-order UI can pre-fill pricing.
app.get('/api/customers/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const customers = MOCK
    ? MOCK_CUSTOMERS.filter(c => c.displayName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    : await (async () => {
        try {
          const r = await shopifyFetch(`query($q:String!){ customers(first:10,query:$q){
            edges{node{id displayName email defaultAddress{firstName lastName address1 address2 city province provinceCode zip country} metafields(first:25,namespace:"b2b"){edges{node{key value}}}}}}}`,
            { q: `tag:b2b ${q}` });
          return r.data?.customers?.edges?.map(e => e.node) || [];
        } catch { return []; }
      })();
  const discountDefault = parseInt(getSetting('b2b_discount_pct') ?? '50', 10);
  res.json(customers.slice(0, 10).map(c => {
    const numId = shopifyNumericId(c.id);
    let discountPct = discountDefault;
    try {
// WHAT: enrich each result with the customer's effective discount = their b2b.discount_pct metafield override, else the global default.
// CHANGE-GUARD: discount_pct is read from the b2b-namespace metafields fetched inline in the customers query above (no extra round-trip / N+1) and parsed exactly like getB2bConfig (parseInt base-10, override ?? default) -- keep the two in sync. (This branch previously called an undefined cache reader, which threw a swallowed ReferenceError and pinned every result to the default.)
// INVARIANT(S): search results must reflect the customer's effective discount; a customer with a non-default override now returns that override, not the global default.
      const mfs = c?.metafields?.edges || [];
      const dpRaw = mfs.find(m => m?.node?.key === 'discount_pct')?.node?.value;
      if (dpRaw != null && dpRaw !== '') {
        const dp = parseInt(dpRaw, 10);
        if (!Number.isNaN(dp)) discountPct = dp;
      }
    } catch (e) { /* ignore */ }
    return {
      id:          numId,
      label:       c.displayName,
      sublabel:    c.email,
      address:     c.defaultAddress || null,
      discountPct: discountPct,
    };
  }));
});

// WHAT: typeahead product/variant search; flattens products->variants. MOCK filters MOCK_PRODUCTS by title/sku/variant; real mode queries Shopify products first:10, variants first:5.
// CHANGE-GUARD: the Shopify query has NO `tag:b2b`/publication filter so it can surface variants not published to B2B (unlike the customer search) — confirm that is intended before relying on it for draft orders; results capped to 20.
// INVARIANT(S): 'Default Title' variant collapses to just the product title in the label; price is the raw list/MSRP (no B2B discount applied here).
// CHANGE-GUARD (Phase 16G): this endpoint serves TWO shapes off the same query.
//   • default (flat): array of {variantId,label,sublabel,sku,price} — used by the
//     New Order page setupAutocomplete('product-search',...) AND the legacy edit-modal
//     single-variant picker. DO NOT change this shape.
//   • ?grouped=1: array of products {productId,productTitle,variants:[{variantId,
//     variantTitle,label,sku,price,sublabel,inventoryQuantity}]} — used by the edit-modal
//     multi-select picker (addCatalogLineRow needs label/sku/price per variant).
// Variant cap raised first:5 → first:25 so all collar sizes (SM/MED/LG/XLG/XXLG and
// width/colour combos) surface in the grouped picker. Products with >25 variants set
// variantsTruncated:true on their group (caller may surface a hint).
const PRODUCT_VARIANT_CAP = 25;
app.get('/api/products/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const grouped = String(req.query.grouped || '') === '1';
  if (!q) return res.json([]);

  const fmtUsd = (v) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(parseFloat(v||0));

  // Build a uniform list of products, each with its OWN variants (product→variants
  // structure preserved end to end; we never collapse multiple products into one bucket).
  // A product matches if its title OR any of its variant titles/skus contains q.
  const products = MOCK
    ? MOCK_PRODUCTS
        .map(p => ({
          productId:   shopifyNumericId(p.id),
          productTitle: p.title,
          variants: (p.variants?.edges || []).map(e => ({
            variantId: shopifyNumericId(e.node.id),
            variantTitle: e.node.title,
            sku: e.node.sku,
            price: e.node.price,
            inventoryQuantity: e.node.inventoryQuantity,
            selectedOptions: e.node.selectedOptions || [],
          })).slice(0, PRODUCT_VARIANT_CAP),
          variantsTruncated: (p.variants?.edges || []).length > PRODUCT_VARIANT_CAP,
        }))
        .filter(p =>
          p.productTitle.toLowerCase().includes(q) ||
          p.variants.some(v => (v.sku || '').toLowerCase().includes(q) || (v.variantTitle || '').toLowerCase().includes(q))
        )
    : await (async () => {
        try {
          const r = await shopifyFetch(`query($q:String!){ products(first:10,query:$q){
            edges{node{id title variants(first:${PRODUCT_VARIANT_CAP}){edges{node{id title sku price inventoryQuantity selectedOptions{name value}}}}}}}}`,
            { q });
          return (r.data?.products?.edges || []).map(e => ({
            productId:   shopifyNumericId(e.node.id),
            productTitle: e.node.title,
            variants: (e.node.variants?.edges || []).map(ve => ({
              variantId: shopifyNumericId(ve.node.id),
              variantTitle: ve.node.title,
              sku: ve.node.sku,
              price: ve.node.price,
              inventoryQuantity: ve.node.inventoryQuantity,
              selectedOptions: ve.node.selectedOptions || [],
            })),
            // first:25 cap is enforced server-side by the query; if Shopify returned a
            // full page of 25 the product *may* have more variants we didn't fetch.
            variantsTruncated: (e.node.variants?.edges || []).length >= PRODUCT_VARIANT_CAP,
          }));
        } catch (e) { console.error('[products-search] shopify query failed (returning empty):', e.message); return []; }
      })();

  if (grouped) {
    return res.json(products.slice(0, 10).map(p => ({
      productId:    p.productId,
      productTitle: p.productTitle,
      variantsTruncated: !!p.variantsTruncated,
      variants: p.variants.map(v => ({
        variantId:    v.variantId,
        variantTitle: v.variantTitle,
        // label/sku/price match the fields addCatalogLineRow(p) consumes per row.
        label:        v.variantTitle === 'Default Title' ? p.productTitle : `${p.productTitle} — ${v.variantTitle}`,
        sublabel:     `${v.sku || '—'} · ${fmtUsd(v.price)} list`,
        sku:          v.sku,
        price:        v.price,
        inventoryQuantity: v.inventoryQuantity,
        selectedOptions: v.selectedOptions || [],
      })),
    })));
  }

  // Default flat shape (unchanged): one row per variant.
  const allVariants = products.flatMap(p =>
    p.variants.map(v => ({ productTitle: p.productTitle, ...v }))
  );
  res.json(allVariants.slice(0, 20).map(v => ({
    variantId: v.variantId,
    label:     v.variantTitle === 'Default Title' ? v.productTitle : `${v.productTitle} — ${v.variantTitle}`,
    sublabel:  `${v.sku || '—'} · ${fmtUsd(v.price)} list`,
    sku:       v.sku,
    price:     v.price,
  })));
});

// ── Phase 3 helpers ───────────────────────────────────────────────────────────

// WHAT: helper — extracts the style name from a Shopify tag of the form 'Style_<name>' (returns the substring after the 6-char prefix), else null.
// INVARIANT(S): the literal prefix length 6 ('Style_') and the slice(6) must stay in lockstep — renderProductDetail/renderCatalog also hardcode 'Style_'.
function getStyleFromTags(tags) {
  const t = (tags || []).find(t => t.startsWith('Style_'));
  return t ? t.slice(6) : null;
}

// WHAT: RFC-4180-ish CSV row builder — quotes any cell containing " , \n or \r and doubles embedded quotes; appends a single '\n'.
// CHANGE-GUARD: shared by every CSV export route (customers, reports/*) — changing the quoting/escaping or line terminator affects all of them; nulls/undefined become empty string.
// INVARIANT(S): does NOT prefix a BOM (callers add '﻿' themselves) and does NOT guard against CSV-injection (leading =,+,-,@) — see bugs[].
function csvLine(cells) {
  return cells.map(c => {
    let s = c == null ? '' : String(c);
    // Neutralize spreadsheet formula injection: Excel/Sheets execute cells starting with = + - @ (or
    // a control char). Prefix with a single quote so the value is treated as text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',') + '\n';
}

// WHAT: inline SVG bar chart used on the Reports page; opts {width,height,fill,labelField,valueField}.
// CHANGE-GUARD: x-axis labels are only drawn when data.length<=12 (avoids overlap); bar height floors at 2px and max is taken across valueField — empty data returns an empty <svg>.
// INVARIANT(S): label values are h()-escaped into <title>/<text>; relies on the caller supplying numeric valueField (NaN max would zero all bars).
function renderBarChart(data, opts = {}) {
  const { width = 580, height = 110, fill = '#9BBC0E', labelField = 'label', valueField = 'value' } = opts;
  if (!data.length) return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  const max = Math.max(...data.map(d => d[valueField]));
  const barW = Math.max(4, Math.floor((width - 8) / data.length) - 2);
  const bars = data.map((d, i) => {
    const bh = max > 0 ? Math.max(2, Math.round((d[valueField] / max) * (height - 24))) : 2;
    const x = 4 + i * (barW + 2);
    const y = height - 18 - bh;
    const lbl = data.length <= 12 ? `<text x="${x + barW / 2}" y="${height - 3}" text-anchor="middle" font-size="9" fill="#6B7280" font-family="sans-serif">${h(String(d[labelField]))}</text>` : '';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${fill}" rx="1"><title>${h(String(d[labelField]))}: ${h(String(d[valueField]))}</title></rect>${lbl}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="max-width:100%;display:block">${bars}</svg>`;
}

// WHAT: tiny inline SVG polyline sparkline for per-customer revenue trend in the Reports table.
// INVARIANT(S): returns '' for empty input; max floors at 1 to avoid divide-by-zero; single-point arrays use the `||1` guard on the x denominator.
function renderSparkline(values, opts = {}) {
  const { width = 80, height = 24, fill = '#9BBC0E' } = opts;
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = Math.round((i / (values.length - 1 || 1)) * (width - 2)) + 1;
    const y = height - 2 - Math.round((v / max) * (height - 4));
    return `${x},${y}`;
  }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="vertical-align:middle"><polyline points="${pts}" fill="none" stroke="${fill}" stroke-width="1.5"/></svg>`;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

// WHAT: Phase 25B/F — loads catalog products; vendor defaults to 'Fuzzywumpets' (pass vendor='all' to bypass), with status (active/draft/archived/all), style, stock (low/out), and b2b-publication filters.
// CHANGE-GUARD: real mode fetches ONLY the first 50 products in ONE page then filters in-memory — style/stock/b2b filters therefore operate on at most 50 rows and totals are page-local, NOT catalog-wide (the `page` param is unused); statusCounts is null in real mode (only computed in MOCK). See bugs[] before trusting counts.
// INVARIANT(S): publishedOnB2B is derived from publishedOnPublication(B2B_PUB_ID); on error returns an empty product set with the error string rather than throwing.
async function getCatalogData({ vendor, style, stock, b2b, status = 'active', page = 1 }) {
  // Phase 25B/F: default to Fuzzywumpets vendor; use vendor='all' to bypass
  const effectiveVendor = (vendor === 'all') ? '' : (vendor || 'Fuzzywumpets');

  if (MOCK) {
    const allProds = MOCK_CATALOG_PRODUCTS.map(p => {
      const ov = mockCatalogOverrides.get(shopifyNumericId(p.id)) || {};
      return { ...p, publishedOnB2B: ov.publishedOnB2B !== undefined ? ov.publishedOnB2B : p.publishedOnB2B };
    });
    const vendorProds = effectiveVendor ? allProds.filter(p => p.vendor === effectiveVendor) : allProds;
    const statusCounts = {
      active:   vendorProds.filter(p => (p.status || 'active') === 'active').length,
      draft:    vendorProds.filter(p => p.status === 'draft').length,
      archived: vendorProds.filter(p => p.status === 'archived').length,
      all:      vendorProds.length,
    };
    let prods = status === 'all' ? vendorProds : vendorProds.filter(p => (p.status || 'active') === status);
    if (style)       prods = prods.filter(p => (p.tags || []).includes(`Style_${style}`));
    if (b2b === '1') prods = prods.filter(p => p.publishedOnB2B);
    if (b2b === '0') prods = prods.filter(p => !p.publishedOnB2B);
    if (stock === 'low')  prods = prods.filter(p => { const t = (p.variants?.edges||[]).reduce((s,e) => s+(e.node.inventoryQuantity||0),0); return t > 0 && t < 10; });
    if (stock === 'out')  prods = prods.filter(p => { const t = (p.variants?.edges||[]).reduce((s,e) => s+(e.node.inventoryQuantity||0),0); return t === 0; });
    const vendors = [...new Set(allProds.map(p => p.vendor))];
    const styles  = [...new Set(vendorProds.flatMap(p => (p.tags||[]).filter(t=>t.startsWith('Style_')).map(t=>t.slice(6))))];
    return { products: prods, vendors, styles, total: prods.length, hasNextPage: false, statusCounts, effectiveVendor };
  }

  try {
    const qParts = [];
    if (effectiveVendor) qParts.push(`vendor:"${effectiveVendor}"`);
    if (status !== 'all') qParts.push(`status:${status}`);
    const result = await shopifyFetch(`
      query($q:String!,$after:String){
        products(first:50,query:$q,after:$after,sortKey:TITLE){
          edges{node{
            id title handle vendor tags status
            publishedOnPublication(publicationId:"${B2B_PUB_ID}")
            variants(first:15){edges{node{sku title inventoryQuantity}}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: qParts.join(' '), after: null });
    let prods = (result.data?.products?.edges || []).map(e => ({
      ...e.node,
      publishedOnB2B: e.node.publishedOnPublication,
    }));
    if (style)       prods = prods.filter(p => (p.tags||[]).includes(`Style_${style}`));
    if (b2b === '1') prods = prods.filter(p => p.publishedOnB2B);
    if (b2b === '0') prods = prods.filter(p => !p.publishedOnB2B);
    if (stock === 'low')  prods = prods.filter(p => { const t=(p.variants?.edges||[]).reduce((s,e)=>s+(e.node.inventoryQuantity||0),0); return t>0&&t<10; });
    if (stock === 'out')  prods = prods.filter(p => { const t=(p.variants?.edges||[]).reduce((s,e)=>s+(e.node.inventoryQuantity||0),0); return t===0; });
    const allVendors = [...new Set(result.data?.products?.edges?.map(e => e.node.vendor).filter(Boolean) || [])];
    const allStyles  = [...new Set((result.data?.products?.edges||[]).flatMap(e => (e.node.tags||[]).filter(t=>t.startsWith('Style_')).map(t=>t.slice(6))))];
    return { products: prods, vendors: allVendors, styles: allStyles, total: prods.length, hasNextPage: result.data?.products?.pageInfo?.hasNextPage, statusCounts: null, effectiveVendor };
  } catch (err) {
    console.error('getCatalogData error:', err.message);
    return { products: [], vendors: [], styles: [], total: 0, hasNextPage: false, error: err.message, statusCounts: null, effectiveVendor };
  }
}

// WHAT: renders the catalog table with status filter chips, vendor/style/stock/B2B selects, a bulk publish/unpublish bar, and per-row publish toggles.
// CHANGE-GUARD: the bulk <form id=catalog-bulk-form> WRAPS the table and posts to /catalog/bulk — the closing </form> is emitted in the template after ${table}; nested per-row <form>s for single publish/unpublish must stay outside that wrapper logically (they are inline but submit to different actions). Re-test selection JS (updateBulkBar/selectAll/clearSelection) after markup changes.
// INVARIANT(S): all product fields rendered through h(); chip hrefs preserve the other active filters via URLSearchParams; 'active' status is the implicit default (omitted from the URL).
function renderCatalog(session, data, filters) {
  const { products, vendors, styles, error, statusCounts, effectiveVendor } = data;

  // Status filter chips (Phase 19E) — Active is the default
  const statusChips = [
    { value: 'active',   label: 'Active' },
    { value: 'draft',    label: 'Draft' },
    { value: 'archived', label: 'Archived' },
    { value: 'all',      label: 'All' },
  ].map(c => {
    const active = (filters.status || 'active') === c.value;
    const count  = statusCounts ? statusCounts[c.value] : null;
    const badge  = count != null ? ` <span class="chip-count">(${count})</span>` : '';
    const params = new URLSearchParams();
    if (c.value !== 'active') params.set('status', c.value);
    if (filters.vendor) params.set('vendor', filters.vendor);
    if (filters.style)  params.set('style',  filters.style);
    if (filters.stock)  params.set('stock',  filters.stock);
    if (filters.b2b)    params.set('b2b',    filters.b2b);
    const href = params.toString() ? `/catalog?${params}` : '/catalog';
    return `<a href="${href}" class="filter-chip${active ? ' filter-chip-active' : ''}">${h(c.label)}${badge}</a>`;
  }).join('');

  const vendorIsDefault = !filters.vendor || filters.vendor === 'Fuzzywumpets';
  const filterBar = `
    <div class="filter-chips" id="catalog-status-chips">${statusChips}</div>
    <form method="GET" action="/catalog" class="filter-bar">
      ${filters.status && filters.status !== 'active' ? `<input type="hidden" name="status" value="${h(filters.status)}">` : ''}
      <select name="vendor" onchange="this.form.submit()" title="Vendor filter — defaults to Fuzzywumpets">
        <option value=""${vendorIsDefault ? ' selected' : ''}>Fuzzywumpets (default)</option>
        <option value="all"${filters.vendor === 'all' ? ' selected' : ''}>All vendors</option>
        ${(vendors||[]).filter(v => v && v !== 'Fuzzywumpets').map(v => `<option value="${h(v)}"${filters.vendor===v?' selected':''}>${h(v)}</option>`).join('')}
      </select>
      <select name="style" onchange="this.form.submit()">
        <option value="">All styles</option>
        ${(styles||[]).map(s => `<option value="${h(s)}"${filters.style===s?' selected':''}>${h(s)}</option>`).join('')}
      </select>
      <select name="stock" onchange="this.form.submit()">
        <option value="">All stock</option>
        <option value="low"${filters.stock==='low'?' selected':''}>Low stock (&lt;10)</option>
        <option value="out"${filters.stock==='out'?' selected':''}>Out of stock</option>
      </select>
      <select name="b2b" onchange="this.form.submit()">
        <option value="">All B2B status</option>
        <option value="1"${filters.b2b==='1'?' selected':''}>On B2B publication</option>
        <option value="0"${filters.b2b==='0'?' selected':''}>Not on B2B</option>
      </select>
      <button type="submit" class="btn btn-secondary btn-sm">Filter</button>
      <a href="/catalog" class="btn btn-ghost btn-sm">Reset</a>
    </form>`;

  const bulkBar = `
    <form method="POST" action="/catalog/bulk" id="catalog-bulk-form">
      <div class="bulk-bar" id="bulk-bar" style="display:none">
        <span id="bulk-count">0</span> selected
        <button type="submit" name="action" value="publish" class="btn btn-primary btn-sm">Publish to B2B</button>
        <button type="submit" name="action" value="unpublish" class="btn btn-secondary btn-sm">Remove from B2B</button>
        <button type="button" onclick="clearSelection()" class="btn btn-ghost btn-sm">Clear</button>
      </div>`;

  const rows = products.map(p => {
    const style = getStyleFromTags(p.tags);
    const variants = (p.variants?.edges || []);
    const totalQty = variants.reduce((s, e) => s + (e.node.inventoryQuantity || 0), 0);
    const numId = shopifyNumericId(p.id);
    const qtyClass = totalQty === 0 ? 'qty-zero' : totalQty < 10 ? 'qty-critical' : '';
    const b2bBadge = p.publishedOnB2B
      ? `<span class="badge badge-paid">B2B ✓</span>`
      : `<span class="badge badge-pending">Not on B2B</span>`;
    const pStatus = (p.status || 'active').toLowerCase();
    const statusBadge = pStatus === 'draft'
      ? ` <span class="badge badge-draft">DRAFT</span>`
      : pStatus === 'archived'
        ? ` <span class="badge badge-archived">ARCHIVED</span>`
        : '';
    const rowClass = pStatus === 'archived' ? ' class="row-archived"' : '';
    return `<tr data-id="${h(numId)}"${rowClass}>
      <td><input type="checkbox" name="ids" value="${h(numId)}" class="row-check" onchange="updateBulkBar()"></td>
      <td><a href="/catalog/${h(numId)}" class="link-primary">${h(p.title)}</a>${statusBadge}</td>
      <td class="text-muted">${h(p.vendor||'—')}</td>
      <td>${style ? `<span class="tag-chip">${h(style)}</span>` : '—'}</td>
      <td class="mono text-sm">${variants.map(e => h(e.node.sku||'—')).join('<br>')}</td>
      <td class="${qtyClass}">${totalQty}</td>
      <td>${b2bBadge}</td>
      <td>
        ${p.publishedOnB2B
          ? `<form method="POST" action="/catalog/${h(numId)}/unpublish" style="display:inline"><button class="btn btn-ghost btn-sm" onclick="return confirm('Remove from B2B publication?')">Remove</button></form>`
          : `<form method="POST" action="/catalog/${h(numId)}/publish" style="display:inline"><button class="btn btn-primary btn-sm">Add to B2B</button></form>`
        }
      </td>
    </tr>`;
  }).join('');

  const table = products.length ? `
    <div class="table-wrap">
    <table class="data-table" id="catalog-table">
      <thead><tr>
        <th style="width:32px"><input type="checkbox" id="select-all" onchange="selectAll(this)"></th>
        <th>Product</th><th>Vendor</th><th>Style</th><th>SKUs</th>
        <th title="Total inventory across variants">Qty</th>
        <th>B2B Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>` : `<p class="empty-state">No products match the current filters.</p>`;

  return layout({ title: 'Catalog', session, activePath: '/catalog', content: `
    <div class="page-header">
      <h1>Catalog</h1>
      <span class="text-muted">${products.length} products</span>
    </div>
    ${error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(error)}</div>` : ''}
    ${filterBar}
    ${bulkBar}
    ${table}
    </form>
    <script>
    function updateBulkBar(){
      const checked=document.querySelectorAll('.row-check:checked');
      const bar=document.getElementById('bulk-bar');
      document.getElementById('bulk-count').textContent=checked.length;
      bar.style.display=checked.length?'flex':'none';
    }
    function selectAll(cb){
      document.querySelectorAll('.row-check').forEach(c=>{c.checked=cb.checked;});
      updateBulkBar();
    }
    function clearSelection(){
      document.querySelectorAll('.row-check').forEach(c=>{c.checked=false;});
      document.getElementById('select-all').checked=false;
      updateBulkBar();
    }
    </script>
  ` });
}

// WHAT: catalog list page; reads vendor/style/stock/b2b/status from the query (status defaults 'active') and pipes them through getCatalogData -> renderCatalog.
// INVARIANT(S): filter object keys must match what getCatalogData/renderCatalog expect; no server-side pagination here (see getCatalogData 50-row cap).
app.get('/catalog', requireAuth, async (req, res) => {
  const filters = {
    vendor: req.query.vendor || '',
    style:  req.query.style  || '',
    stock:  req.query.stock  || '',
    b2b:    req.query.b2b    || '',
    status: req.query.status || 'active',
  };
  const data = await getCatalogData(filters);
  res.send(renderCatalog(req.adminSession, data, filters));
});

// WHAT: legacy alias — 301-style redirect from /catalog/:id to the canonical /products/:id detail page.
// INVARIANT(S): keep this redirect so old catalog links and the row-action hrefs (/catalog/<id>) still resolve.
app.get('/catalog/:id', requireAuth, async (req, res) => {
  res.redirect(`/products/${req.params.id}`);
});

// WHAT: publishes a single product to the B2B publication (publishablePublish with publicationId B2B_PUB_ID).
// CHANGE-GUARD: userErrors are swallowed (logged only) so a failed publish still audits as published and redirects to /catalog — the UI may show stale 'B2B' state until refresh (see bugs[]).
// INVARIANT(S): gid is gid://shopify/Product/<numId>; audit records before=false,after=true regardless of actual outcome.
app.post('/catalog/:id/publish', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const gid = `gid://shopify/Product/${numId}`;
  if (MOCK) {
    mockCatalogOverrides.set(numId, { publishedOnB2B: true });
  } else {
    try {
      await shopifyFetch(`mutation pub($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{field message}}}`,
        { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
    } catch (err) {
      console.error('publish error:', err.message);
    }
  }
  auditLog(req.adminSession.email, 'catalog:publish', gid, false, true);
  res.redirect('/catalog');
});

// WHAT: removes a single product from the B2B publication (publishableUnpublish).
// CHANGE-GUARD: same swallowed-userErrors caveat as the publish route; audit records before=true,after=false unconditionally.
// INVARIANT(S): publicationId must be B2B_PUB_ID to target the correct channel.
app.post('/catalog/:id/unpublish', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const gid = `gid://shopify/Product/${numId}`;
  if (MOCK) {
    mockCatalogOverrides.set(numId, { publishedOnB2B: false });
  } else {
    try {
      await shopifyFetch(`mutation unpub($id:ID!,$input:[PublicationInput!]!){publishableUnpublish(id:$id,input:$input){userErrors{field message}}}`,
        { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
    } catch (err) {
      console.error('unpublish error:', err.message);
    }
  }
  auditLog(req.adminSession.email, 'catalog:unpublish', gid, true, false);
  res.redirect('/catalog');
});

// WHAT: bulk publish/unpublish — req.body.ids may be a single value or array (flattened); action defaults to 'unpublish' unless exactly 'publish'.
// CHANGE-GUARD: products are processed SEQUENTIALLY in a for-loop (await per id) with per-item errors swallowed and logged — a large selection is slow and partial failures are invisible to the user; no Shopify bulk-publish API is used (see bugs[]).
// INVARIANT(S): every id is audited individually as catalog:bulk:<action>; MOCK updates mockCatalogOverrides only.
app.post('/catalog/bulk', requireAuth, async (req, res) => {
  const ids    = [req.body.ids || []].flat().filter(Boolean);
  const action = req.body.action === 'publish' ? 'publish' : 'unpublish';
  for (const numId of ids) {
    const gid = `gid://shopify/Product/${numId}`;
    if (MOCK) {
      mockCatalogOverrides.set(numId, { publishedOnB2B: action === 'publish' });
    } else {
      try {
        if (action === 'publish') {
          await shopifyFetch(`mutation pub($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{field message}}}`,
            { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
        } else {
          await shopifyFetch(`mutation unpub($id:ID!,$input:[PublicationInput!]!){publishableUnpublish(id:$id,input:$input){userErrors{field message}}}`,
            { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
        }
      } catch (err) { console.error(`bulk ${action} ${numId}:`, err.message); }
    }
    auditLog(req.adminSession.email, `catalog:bulk:${action}`, gid, null, null);
  }
  res.redirect('/catalog');
});

// ── Phase 19C: Product detail ─────────────────────────────────────────────────

// WHAT: Phase 19C — loads a product (incl. images, variants with barcode/price/inventory, and B2B publication state) plus up to 10 recent orders that contain it.
// CHANGE-GUARD: real-mode related-orders query matches on `sku:<first variant sku>` ONLY — products whose first variant has no SKU, or whose sales used a different variant, will show NO related orders (see bugs[]); returns null on any error (renders a 404).
// INVARIANT(S): publishedOnB2B from publishedOnPublication(B2B_PUB_ID); MOCK synthesizes related orders by matching variant SKUs against MOCK_ORDERS line items.
async function getProductDetail(numericId) {
  if (MOCK) {
    const p = MOCK_PRODUCTS.find(x => shopifyNumericId(x.id) === numericId);
    if (!p) return null;
    // Find related orders for this product
    const variantSkus = new Set((p.variants?.edges || []).map(e => e.node.sku));
    const relatedOrders = MOCK_ORDERS.filter(o =>
      (o.lineItems?.edges || []).some(li => variantSkus.has(li.node.variant?.sku))
    ).slice(0, 10).map(o => ({
      id: o.id, name: o.name, processedAt: o.processedAt,
      customer: o.customer,
      displayFinancialStatus: o.displayFinancialStatus,
      total: o.totalPriceSet?.presentmentMoney?.amount,
    }));
    const catalogEntry = MOCK_CATALOG_PRODUCTS.find(x => shopifyNumericId(x.id) === numericId);
    return {
      ...p,
      status: catalogEntry?.status || 'active',
      publishedOnB2B: catalogEntry?.publishedOnB2B ?? true,
      relatedOrders,
    };
  }
  try {
    const result = await shopifyFetch(`
      query($id:ID!){product(id:$id){
        id title handle vendor productType status tags
        featuredImage{url altText}
        images(first:10){edges{node{url altText}}}
        variants(first:50){edges{node{
          id title sku barcode price compareAtPrice inventoryQuantity
          inventoryItem{tracked}
        }}}
        publishedOnPublication(publicationId:"${B2B_PUB_ID}")
      }}`, { id: `gid://shopify/Product/${numericId}` });
    const p = result.data?.product;
    if (!p) return null;
    // Fetch recent orders containing this product
    const ordersResult = await shopifyFetch(`
      query($q:String!){orders(first:10,query:$q,sortKey:PROCESSED_AT,reverse:true){
        edges{node{id name processedAt
          customer{id displayName email}
          displayFinancialStatus
          totalPriceSet{presentmentMoney{amount}}
        }}
      }}`, { q: `sku:${(p.variants?.edges?.[0]?.node?.sku || '')}` });
    const relatedOrders = (ordersResult.data?.orders?.edges || []).map(e => ({
      id: e.node.id, name: e.node.name, processedAt: e.node.processedAt,
      customer: e.node.customer,
      displayFinancialStatus: e.node.displayFinancialStatus,
      total: e.node.totalPriceSet?.presentmentMoney?.amount,
    }));
    return { ...p, publishedOnB2B: p.publishedOnPublication, relatedOrders };
  } catch (err) {
    console.error('getProductDetail error:', err.message);
    return null;
  }
}

// WHAT: renders the product detail page — variant table (SKU/barcode/price/compare/inventory), image thumbs, related orders, publication status, and an 'Edit in Shopify' deep link.
// CHANGE-GUARD: the Shopify edit URL hardcodes store slug 'parttwoenterprises' — keep in sync with the actual store handle (also referenced elsewhere); inventory cells colour-code <=0 danger / <10 warning.
// INVARIANT(S): every product/variant/order field is h()-escaped; non-Fuzzywumpets vendor products get an info banner warning that catalog ops don't apply.
function renderProductDetail(session, product) {
  const numId = shopifyNumericId(product.id);
  const variants = (product.variants?.edges || []).map(e => e.node);
  const images   = (product.images?.edges || []).map(e => e.node);
  const tags     = product.tags || [];
  const style    = tags.find(t => t.startsWith('Style_'))?.replace('Style_', '') || '';
  const isB2B    = product.publishedOnB2B;

  const variantRows = variants.map(v => `<tr>
    <td>${h(v.title)}</td>
    <td class="mono">${h(v.sku || '—')}</td>
    <td class="mono">${h(v.barcode || '—')}</td>
    <td class="text-right">${fmtMoney(v.price)}</td>
    <td class="text-right text-muted">${fmtMoney(v.compareAtPrice)}</td>
    <td class="text-right ${v.inventoryQuantity <= 0 ? 'text-danger' : v.inventoryQuantity < 10 ? 'text-warning' : ''}">${v.inventoryQuantity ?? '—'}</td>
  </tr>`).join('');

  const imageThumbs = images.slice(0, 6).map(img =>
    `<img src="${h(img.url)}" alt="${h(img.altText || '')}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">`
  ).join('');

  const relatedOrderRows = (product.relatedOrders || []).map(o => {
    const oNum = shopifyNumericId(o.id);
    const cNum = o.customer ? shopifyNumericId(o.customer.id) : null;
    return `<tr>
      <td><a href="/orders/${oNum}" class="link">${h(o.name)}</a></td>
      <td>${cNum ? `<a href="/customers/${cNum}" class="link">${h(o.customer.displayName)}</a>` : '—'}</td>
      <td class="text-muted">${fmtDate(o.processedAt)}</td>
      <td><span class="badge badge-${(o.displayFinancialStatus||'').toLowerCase()}">${h(o.displayFinancialStatus||'')}</span></td>
      <td class="text-right mono">${fmtMoney(o.total)}</td>
    </tr>`;
  }).join('');

  const shopifyEditUrl = `https://admin.shopify.com/store/parttwoenterprises/products/${numId}`;

  const nonFwwBanner = (product.vendor && product.vendor !== 'Fuzzywumpets')
    ? `<div class="alert alert-info" style="margin-bottom:16px">ℹ This product is from vendor <strong>${h(product.vendor)}</strong> (not Fuzzywumpets). Most catalog operations don't apply.</div>`
    : '';

  return layout({ title: product.title, session, activePath: '/catalog', content: `
    <div class="breadcrumb-row"><a href="/catalog" class="breadcrumb">← Catalog</a></div>
    ${nonFwwBanner}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(product.title)}</h1>
        <p class="text-muted">
          ${h(product.vendor || '')}${product.productType ? ` · ${h(product.productType)}` : ''}
          ${style ? ` · <strong>${h(style)}</strong>` : ''}
          · <code>${h(product.handle || '')}</code>
        </p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <span class="badge badge-${(product.status||'active').toLowerCase()}">${h(product.status||'Active')}</span>
          <span class="badge ${isB2B ? 'badge-success' : 'badge-secondary'}">${isB2B ? 'B2B Published' : 'Not on B2B'}</span>
          ${tags.map(t => tagChip(t)).join('')}
        </div>
      </div>
      <div class="detail-header-actions">
        <a href="${h(shopifyEditUrl)}" target="_blank" rel="noopener" class="btn btn-secondary">Edit in Shopify ↗</a>
        ${isB2B
          ? `<form method="POST" action="/catalog/${numId}/unpublish" style="display:inline">
              <button class="btn btn-ghost btn-sm">Remove from B2B</button></form>`
          : `<form method="POST" action="/catalog/${numId}/publish" style="display:inline">
              <button class="btn btn-primary btn-sm">Publish to B2B</button></form>`}
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-main">
        ${imageThumbs ? `<div class="card"><div class="card-header"><h2>Images</h2></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${imageThumbs}</div></div>` : ''}

        <div class="card">
          <div class="card-header"><h2>Variants (${variants.length})</h2></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr>
                <th>Variant</th><th>SKU</th><th>UPC/Barcode</th>
                <th class="text-right">Price (MSRP)</th>
                <th class="text-right">Compare at</th>
                <th class="text-right">Inventory</th>
              </tr></thead>
              <tbody>${variantRows || '<tr><td colspan="6" class="empty-state">No variants</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        ${product.relatedOrders?.length ? `<div class="card">
          <div class="card-header"><h2>Recent orders with this product</h2></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th class="text-right">Total</th></tr></thead>
              <tbody>${relatedOrderRows}</tbody>
            </table>
          </div>
        </div>` : ''}
      </div>

      <div class="detail-side">
        <div class="card">
          <div class="card-header"><h2>Publication status</h2></div>
          <p>
            <span class="badge ${isB2B ? 'badge-success' : 'badge-secondary'}">
              ${isB2B ? '✓ On B2B catalog' : '✗ Not on B2B catalog'}
            </span>
          </p>
        </div>
        <div class="card">
          <div class="card-header"><h2>Details</h2></div>
          <table class="mini-table">
            <tr><td class="text-muted">Vendor</td><td>${h(product.vendor || '—')}</td></tr>
            <tr><td class="text-muted">Type</td><td>${h(product.productType || '—')}</td></tr>
            <tr><td class="text-muted">Handle</td><td><code>${h(product.handle || '—')}</code></td></tr>
            <tr><td class="text-muted">Style</td><td>${h(style || '—')}</td></tr>
            <tr><td class="text-muted">Shopify ID</td><td><code>${numId}</code></td></tr>
          </table>
        </div>
      </div>
    </div>
  ` });
}

// WHAT: product detail route; 404s with a friendly layout (not JSON) when getProductDetail returns null.
// INVARIANT(S): :id is the numeric Shopify product id (wrapped to a gid inside getProductDetail).
app.get('/products/:id', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const product = await getProductDetail(numId);
  if (!product) {
    return res.status(404).send(layout({ title: 'Product not found', session: req.adminSession, activePath: '/catalog', content: `
      <div class="breadcrumb-row"><a href="/catalog" class="breadcrumb">← Catalog</a></div>
      <div class="empty-state">Product ${h(numId)} not found</div>
    ` }));
  }
  res.send(renderProductDetail(req.adminSession, product));
});

// ── Reports ───────────────────────────────────────────────────────────────────

// WHAT: Phase 24F — builds 12-month revenue + top-customer + top-product aggregates. Prefers SQL aggregation over the local orders cache (getReportsDataFromCache); falls back to MOCK, then live Shopify.
// CHANGE-GUARD: live fallback paginates `tag:b2b-portal created_at:><cutoff>` in pages of 250 but is HARD-CAPPED at 10 pages (2500 orders) — high-volume periods silently truncate the totals (see bugs[]); the cache and live paths must produce the same {monthly,customers,products,totalRevenue,totalOrders,aov} shape.
// INVARIANT(S): the 12-month bucket map is pre-seeded so every month appears even with 0 revenue; customers top-20, products top-50; product key is sku||title.
async function getReportsData() {
  // Phase 24F: read from cache first (SQL aggregation across 12mo of cached orders)
  if (!MOCK) {
    try {
      const stats = getOrdersCacheStats();
      if (stats && stats.total > 0) {
        return getReportsDataFromCache();
      }
    } catch (e) {
      console.error('reports cache read failed, falling back to live:', e.message);
    }
  }

  if (MOCK) {
    return {
      monthly:    MOCK_MONTHLY_REVENUE,
      customers:  MOCK_CUSTOMER_REVENUE,
      products:   MOCK_PRODUCT_REVENUE,
      totalRevenue: MOCK_MONTHLY_REVENUE.reduce((s, d) => s + d.revenue, 0),
      totalOrders:  MOCK_MONTHLY_REVENUE.reduce((s, d) => s + d.orders, 0),
      aov: Math.round(MOCK_MONTHLY_REVENUE.reduce((s,d)=>s+d.revenue,0) / MOCK_MONTHLY_REVENUE.reduce((s,d)=>s+d.orders,0)),
    };
  }
  try {
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const allOrders = [];
    let after = null;
    let pageCount = 0;
    while (pageCount < 10) {
      const result = await shopifyFetch(`
        query($q:String!,$first:Int!,$after:String){
          orders(first:$first,query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){
            edges{cursor node{
              id processedAt
              customer{id displayName email}
              totalPriceSet{presentmentMoney{amount}}
              lineItems(first:50){edges{node{
                title quantity
                variant{sku}
                discountedUnitPriceSet{presentmentMoney{amount}}
              }}}
            }}
            pageInfo{hasNextPage endCursor}
          }
        }`, { q: `tag:b2b-portal created_at:>${cutoff}`, first: 250, after });
      const edges = result.data?.orders?.edges || [];
      allOrders.push(...edges.map(e => e.node));
      if (!result.data?.orders?.pageInfo?.hasNextPage) break;
      after = result.data?.orders?.pageInfo?.endCursor;
      pageCount++;
    }

    // Aggregate monthly
    const monthMap = new Map();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      monthMap.set(key, { month: key, revenue: 0, orders: 0 });
    }
    const customerMap = new Map();
    const productMap  = new Map();
    for (const o of allOrders) {
      const m = (o.processedAt || '').slice(0, 7);
      if (monthMap.has(m)) {
        const d = monthMap.get(m);
        d.revenue += parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
        d.orders++;
      }
      if (o.customer) {
        const { id, displayName, email } = o.customer;
        const amt = parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
        if (!customerMap.has(id)) customerMap.set(id, { id: shopifyNumericId(id), name: displayName, email, revenue: 0, orders: 0 });
        const c = customerMap.get(id); c.revenue += amt; c.orders++;
      }
      for (const li of (o.lineItems?.edges || [])) {
        const { title, quantity, variant, discountedUnitPriceSet: dp } = li.node;
        const sku = variant?.sku || '';
        const rev = parseFloat(dp?.presentmentMoney?.amount || 0) * quantity;
        const key = sku || title;
        if (!productMap.has(key)) productMap.set(key, { title, sku, revenue: 0, units: 0 });
        const p = productMap.get(key); p.revenue += rev; p.units += quantity;
      }
    }
    const monthly   = [...monthMap.values()];
    const customers = [...customerMap.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,20).map(c => ({ ...c, aov: c.orders ? Math.round(c.revenue/c.orders) : 0 }));
    const products  = [...productMap.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,50);
    const totalRevenue = monthly.reduce((s,d)=>s+d.revenue,0);
    const totalOrders  = monthly.reduce((s,d)=>s+d.orders,0);
    return { monthly, customers, products, totalRevenue, totalOrders, aov: totalOrders ? Math.round(totalRevenue/totalOrders) : 0 };
  } catch (err) {
    console.error('getReportsData error:', err.message);
    return { monthly: [], customers: [], products: [], totalRevenue: 0, totalOrders: 0, aov: 0, error: err.message };
  }
}

// WHAT: renders the Reports page — monthly revenue bar chart + table, top customers (with sparkline), and top products, each with a CSV download link.
// CHANGE-GUARD: CSV links point at /reports/csv/{monthly,customers,products} — keep those three :type values in sync with the CSV route's switch; chart consumes monthly[].{month,revenue}.
// INVARIANT(S): all names/emails/skus h()-escaped; AOV per row guards divide-by-zero with the orders/units ternaries.
function renderReports(session, data) {
  const { monthly, customers, products, totalRevenue, totalOrders, aov, error } = data;

  const chartData = monthly.map(d => ({ label: d.month.slice(5), value: d.revenue }));
  const chart = renderBarChart(chartData, { width: 580, height: 110 });

  const customerRows = (customers||[]).map((c, i) => {
    const spark = renderSparkline([c.revenue], { width: 64, height: 20 });
    return `<tr>
      <td class="text-muted">${i+1}</td>
      <td><a href="/customers/${h(c.id)}">${h(c.name)}</a><br><small class="text-muted">${h(c.email)}</small></td>
      <td>${fmtMoney(c.revenue)}</td>
      <td>${c.orders}</td>
      <td>${fmtMoney(c.aov)}</td>
      <td>${spark}</td>
    </tr>`;
  }).join('');

  const productRows = (products||[]).map((p, i) => `<tr>
    <td class="text-muted">${i+1}</td>
    <td>${h(p.title)}</td>
    <td class="mono text-sm">${h(p.sku||'—')}</td>
    <td>${fmtMoney(p.revenue)}</td>
    <td>${p.units}</td>
    <td>${p.units ? fmtMoney(p.revenue / p.units) : '—'}</td>
  </tr>`).join('');

  return layout({ title: 'Reports', session, activePath: '/reports', content: `
    <div class="page-header">
      <h1>Reports</h1>
      <span class="text-muted">Last 12 months</span>
    </div>
    ${error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(error)}</div>` : ''}
    <div class="report-stats">
      <div class="stat-card"><div class="stat-value">${fmtMoney(totalRevenue)}</div><div class="stat-label">Total Revenue</div></div>
      <div class="stat-card"><div class="stat-value">${totalOrders}</div><div class="stat-label">Total Orders</div></div>
      <div class="stat-card"><div class="stat-value">${fmtMoney(aov)}</div><div class="stat-label">Avg Order Value</div></div>
    </div>

    <div class="report-section">
      <div class="report-section-header">
        <h2>Monthly Revenue (last 12 months)</h2>
        <a href="/reports/csv/monthly" class="btn btn-ghost btn-sm">↓ CSV</a>
      </div>
      <div class="chart-container">${chart}</div>
      <table class="data-table data-table-sm">
        <thead><tr><th>Month</th><th>Revenue</th><th>Orders</th><th>AOV</th></tr></thead>
        <tbody>
        ${(monthly||[]).map(d => `<tr>
          <td>${h(d.month)}</td>
          <td>${fmtMoney(d.revenue)}</td>
          <td>${d.orders}</td>
          <td>${d.orders ? fmtMoney(d.revenue / d.orders) : '—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="report-section">
      <div class="report-section-header">
        <h2>Sales by Customer (top ${customers?.length||0})</h2>
        <a href="/reports/csv/customers" class="btn btn-ghost btn-sm">↓ CSV</a>
      </div>
      <table class="data-table data-table-sm">
        <thead><tr><th>#</th><th>Customer</th><th>Revenue</th><th>Orders</th><th>AOV</th><th>Trend</th></tr></thead>
        <tbody>${customerRows||'<tr><td colspan="6" class="empty-state">No data</td></tr>'}</tbody>
      </table>
    </div>

    <div class="report-section">
      <div class="report-section-header">
        <h2>Sales by Product (top ${products?.length||0})</h2>
        <a href="/reports/csv/products" class="btn btn-ghost btn-sm">↓ CSV</a>
      </div>
      <table class="data-table data-table-sm">
        <thead><tr><th>#</th><th>Product</th><th>SKU</th><th>Revenue</th><th>Units</th><th>Avg Price</th></tr></thead>
        <tbody>${productRows||'<tr><td colspan="6" class="empty-state">No data</td></tr>'}</tbody>
      </table>
    </div>
  ` });
}

// WHAT: Reports page route — getReportsData() -> renderReports().
// INVARIANT(S): getReportsData never throws (returns {error} on failure) so this handler does not need its own try/catch.
app.get('/reports', requireAuth, async (req, res) => {
  const data = await getReportsData();
  res.send(renderReports(req.adminSession, data));
});

// WHAT: streams a revenue CSV for :type in {monthly,customers,products}; recomputes getReportsData() per request.
// CHANGE-GUARD: re-running getReportsData here means the CSV can differ from the on-screen table if the cache changed between requests; unknown :type returns 404 text; cells are NOT BOM-prefixed (unlike the customer export) so Excel may misread UTF-8 (minor) — see bugs[] re CSV-injection.
// INVARIANT(S): each branch sets headers then streams via res.write/res.end; column orders are fixed by the header csvLine.
app.get('/reports/csv/:type', requireAuth, async (req, res) => {
  const data = await getReportsData();
  const ts   = new Date().toISOString().slice(0, 10);
  const type = req.params.type;

  if (type === 'monthly') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fww-revenue-monthly-${ts}.csv"`);
    res.write(csvLine(['month','revenue','orders','aov']));
    for (const d of (data.monthly||[])) {
      res.write(csvLine([d.month, d.revenue.toFixed(2), d.orders, d.orders ? (d.revenue/d.orders).toFixed(2) : '0']));
    }
    return res.end();
  }
  if (type === 'customers') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fww-revenue-customers-${ts}.csv"`);
    res.write(csvLine(['rank','name','email','revenue','orders','aov']));
    (data.customers||[]).forEach((c, i) => res.write(csvLine([i+1, c.name, c.email, c.revenue.toFixed(2), c.orders, c.aov])));
    return res.end();
  }
  if (type === 'products') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fww-revenue-products-${ts}.csv"`);
    res.write(csvLine(['rank','title','sku','revenue','units','avg_price']));
    (data.products||[]).forEach((p, i) => res.write(csvLine([i+1, p.title, p.sku||'', p.revenue.toFixed(2), p.units, p.units ? (p.revenue/p.units).toFixed(2) : '0'])));
    return res.end();
  }
  res.status(404).send('Unknown CSV type');
});

// ── Settings ──────────────────────────────────────────────────────────────────

// WHAT: assembles the settings view-model — b2b_discount_pct/order_minimum/payment_terms/catalog_private_tags from the settings store (with defaults) plus the admin allowlist.
// CHANGE-GUARD: allowlist source is B2B_ADMIN_ALLOWED_EMAILS env (comma-split) in real mode, hardcoded two emails in MOCK — the /settings/allowlist/add form cannot actually persist to env, so adds are display-only unless backed elsewhere (verify the add route).
// INVARIANT(S): defaults (50 / 0 / 'Net 30' / '') must match the consumers that read these settings (e.g. b2b_discount_pct default 50 is also assumed in /api/customers/search).
function getSettingsData(flash) {
  const settings = {
    b2b_discount_pct:    getSetting('b2b_discount_pct')    ?? '50',
    order_minimum:       getSetting('order_minimum')       ?? '0',
    payment_terms:       getSetting('payment_terms')       ?? 'Net 30',
    catalog_private_tags: getSetting('catalog_private_tags') ?? '',
  };
  const allowlist = MOCK
    ? ['alex@fuzzywumpets.com', 'alexa@fuzzywumpets.com']
    : (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { settings, allowlist, flash };
}

// WHAT: renders the Settings page — B2B config form, admin allowlist list+add, and a read-only info block (B2B_PUB_ID, REDIRECT_URI, MOCK/PROD badge).
// INVARIANT(S): all setting values and allowlist emails h()-escaped; the read-only block exposes B2B_PUB_ID and REDIRECT_URI to any logged-in admin (acceptable since requireAuth gates it).
function renderSettings(session, { settings, allowlist, flash }) {
  const flashHtml = flash
    ? `<div class="alert ${flash.ok ? 'alert-success' : 'alert-error'}" style="margin-bottom:1rem">${h(flash.msg)}</div>`
    : '';
  return layout({ title: 'Settings', session, activePath: '/settings', content: `
    <div class="page-header"><h1>Settings</h1></div>
    ${flashHtml}

    <div class="settings-grid">
      <section class="settings-section">
        <h2>B2B Config</h2>
        <form method="POST" action="/settings" class="settings-form">
          <div class="form-row">
            <label>B2B Discount %</label>
            <input type="number" name="b2b_discount_pct" value="${h(settings.b2b_discount_pct)}" min="0" max="100" step="1" class="form-input" style="width:80px">
            <small class="text-muted">Applied to all B2B orders (default 50%)</small>
          </div>
          <div class="form-row">
            <label>Order Minimum ($)</label>
            <input type="number" name="order_minimum" value="${h(settings.order_minimum)}" min="0" step="0.01" class="form-input" style="width:100px">
            <small class="text-muted">Minimum order value for B2B checkout (0 = no minimum)</small>
          </div>
          <div class="form-row">
            <label>Payment Terms</label>
            <input type="text" name="payment_terms" value="${h(settings.payment_terms)}" maxlength="100" class="form-input" style="width:200px">
            <small class="text-muted">Shown on invoices (e.g. "Net 30", "Due on receipt")</small>
          </div>
          <div class="form-row">
            <label>Private catalog tags</label>
            <input type="text" name="catalog_private_tags" value="${h(settings.catalog_private_tags || '')}" maxlength="500" class="form-input" style="width:300px">
            <small class="text-muted">Comma-separated Shopify product tags treated as "private." Products with these tags are only visible to customers whose Custom catalog tags (on their B2B settings) include a match.</small>
          </div>
          <button type="submit" class="btn btn-primary">Save Config</button>
        </form>
      </section>

      <section class="settings-section">
        <h2>Admin Allowlist</h2>
        <p class="text-muted" style="font-size:0.85rem;margin-bottom:0.75rem">Emails that may log in to this admin panel.</p>
        <ul class="allowlist">
          ${allowlist.map(e => `<li>${h(e)}</li>`).join('')}
        </ul>
        <form method="POST" action="/settings/allowlist/add" class="settings-form" style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center">
          <input type="email" name="email" placeholder="new@fuzzywumpets.com" class="form-input" style="width:240px" required>
          <button type="submit" class="btn btn-secondary">+ Add</button>
        </form>
      </section>

      <section class="settings-section settings-readonly">
        <h2>Read-only Info</h2>
        <dl class="info-grid">
          <dt>B2B Publication ID</dt><dd class="mono">${h(B2B_PUB_ID)}</dd>
          <dt>OAuth Redirect URI</dt><dd class="mono">${h(REDIRECT_URI)}</dd>
          <dt>Environment</dt><dd>${MOCK ? '<span class="badge badge-pending">MOCK</span>' : '<span class="badge badge-paid">PRODUCTION</span>'}</dd>
        </dl>
      </section>
    </div>
  ` });
}

// WHAT: Settings page route; builds a flash object from ?flash=ok|err (+ optional ?msg) and renders.
// INVARIANT(S): flash msg comes from the query string and is h()-escaped in renderSettings — do not bypass that escaping when adding new flash sources.
app.get('/settings', requireAuth, (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || (req.query.flash === 'ok' ? 'Settings saved.' : 'Error saving settings.') } : null;
  res.send(renderSettings(req.adminSession, getSettingsData(flash)));
});

app.post('/settings', requireAuth, (req, res) => {
  const { b2b_discount_pct, order_minimum, payment_terms, catalog_private_tags } = req.body;
  try {
    if (b2b_discount_pct    !== undefined) { const _d = Math.round(Number(b2b_discount_pct)); setSetting('b2b_discount_pct', String(Number.isFinite(_d) ? Math.min(95, Math.max(0, _d)) : 50)); }
    if (order_minimum       !== undefined) setSetting('order_minimum',        String(Number(order_minimum)    || 0));
    if (payment_terms       !== undefined) setSetting('payment_terms',        String(payment_terms).slice(0, 100));
    if (catalog_private_tags !== undefined) setSetting('catalog_private_tags', String(catalog_private_tags || '').slice(0, 500));
    auditLog(req.adminSession.email, 'settings:update', null, null, { b2b_discount_pct, order_minimum, payment_terms, catalog_private_tags });
    // Push the global order minimum to the b2b-portal so IT enforces this value (admin is the single
    // source of truth) instead of a hardcoded env default. Fire-and-forget — the portal sync must not
    // block or fail the admin save; callPortalInternal never throws (returns {ok:false} on error).
    if (order_minimum !== undefined) {
      callPortalInternal('POST', '/__internal__/settings', { order_minimum: Number(order_minimum) || 0 })
        .then(r => { if (!r.ok) console.error('[settings] portal min-order sync failed:', r.error || r); })
        .catch(e => console.error('[settings] portal min-order sync threw:', e?.message || e));
    }
    res.redirect('/settings?flash=ok&msg=Settings+saved.');
  } catch (err) {
    res.redirect(`/settings?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

// WHAT: adds an email to B2B_ADMIN_ALLOWED_EMAILS by shelling out to `doppler secrets set` and mutating process.env in-place (privilege-grant surface).
// CHANGE-GUARD: any admin can grant full-dashboard access to any email here — re-test the email-format regex gate and that the Doppler write succeeds before process.env is updated; a failed Doppler write must not leave a divergent in-memory allowlist.
// INVARIANT(S): the new value persists only via Doppler (next deploy re-reads it); spawnSync has a 10s timeout and non-zero status throws; MOCK mode never persists; this is the one place the trust boundary widens at runtime.
app.post('/settings/allowlist/add', requireAuth, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) {
    return res.redirect('/settings?flash=err&msg=Invalid+email+address.');
  }
  if (MOCK) {
    return res.redirect(`/settings?flash=ok&msg=${encodeURIComponent(`${email} added (mock mode — not persisted).`)}`);
  }
  try {
    const current = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (current.includes(email)) {
      return res.redirect(`/settings?flash=ok&msg=${encodeURIComponent(`${email} is already on the allowlist.`)}`);
    }
    const newList = [...current, email].join(',');
    const result = spawnSync('doppler', ['secrets', 'set', `B2B_ADMIN_ALLOWED_EMAILS=${newList}`], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(result.stderr || 'doppler command failed');
    process.env.B2B_ADMIN_ALLOWED_EMAILS = newList;
    auditLog(req.adminSession.email, 'settings:allowlist:add', email, null, null);
    res.redirect(`/settings?flash=ok&msg=${encodeURIComponent(`${email} added to allowlist.`)}`);
  } catch (err) {
    res.redirect(`/settings?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

// ── SparkLayer Migration ───────────────────────────────────────────────────────

// WHAT: fetches Shopify customers tagged `sparklayer` (or MOCK_SPARKLAYER_CUSTOMERS) and flags each as alreadyB2B if it already carries the `b2b` tag.
// CHANGE-GUARD: the Shopify query is `customers(first:50,query:'tag:sparklayer')` with NO pagination loop — only the first 50 SparkLayer customers are ever considered for migration (see bugs[]); re-test counts against a real tag:sparklayer population before relying on `total`.
// INVARIANT(S): numId is derived via shopifyNumericId(node.id) and is the checkbox value the migrate form posts; on Shopify error returns an empty candidate set with `error` set rather than throwing, so the page must render the warning banner.
async function getMigrateData() {
  if (MOCK) {
    const candidates = MOCK_SPARKLAYER_CUSTOMERS.map(c => ({
      ...c, numId: shopifyNumericId(c.id),
      alreadyB2B: c.tags.includes('b2b') || mockSparkLayerMigrated.has(shopifyNumericId(c.id)),
    }));
    return { candidates, total: candidates.length, alreadyMigrated: candidates.filter(c => c.alreadyB2B).length };
  }
  try {
    const result = await shopifyFetch(`
      query($q:String!,$after:String){
        customers(first:50,query:$q,after:$after){
          edges{node{id displayName email tags}}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: 'tag:sparklayer', after: null });
    const candidates = (result.data?.customers?.edges || []).map(e => ({
      ...e.node, numId: shopifyNumericId(e.node.id),
      alreadyB2B: (e.node.tags || []).includes('b2b'),
    }));
    return { candidates, total: candidates.length, alreadyMigrated: candidates.filter(c => c.alreadyB2B).length };
  } catch (err) {
    console.error('getMigrateData error:', err.message);
    return { candidates: [], total: 0, alreadyMigrated: 0, error: err.message };
  }
}

// WHAT: renders the SparkLayer migration page — stat cards, a bulk Run-Migration form, and a per-customer table with checkboxes.
// CHANGE-GUARD: the `ids` checkboxes are decorative here — POST /migrate/run ignores them and re-derives `pending` from getMigrateData(), so unchecking a row in the UI does NOT exclude it from the run; keep that in mind if you wire the checkboxes up.
// INVARIANT(S): all user-supplied strings pass through h() for escaping; the confirm() dialog text must keep its pending.length count in sync with the server-side recompute.
function renderMigrate(session, data, flash) {
  const { candidates, total, alreadyMigrated, error } = data;
  const flashHtml = flash ? `<div class="alert ${flash.ok?'alert-success':'alert-error'}" style="margin-bottom:1rem">${h(flash.msg)}</div>` : '';
  const pending = candidates.filter(c => !c.alreadyB2B);
  const done    = candidates.filter(c => c.alreadyB2B);

  const rows = candidates.map(c => `<tr class="${c.alreadyB2B ? 'row-done' : ''}">
    <td>${c.alreadyB2B ? '✓' : '<input type="checkbox" name="ids" value="'+h(c.numId)+'" checked>'}</td>
    <td><a href="/customers/${h(c.numId)}">${h(c.displayName)}</a></td>
    <td>${h(c.email)}</td>
    <td class="text-sm">${(c.tags||[]).map(t => `<span class="tag-chip">${h(t)}</span>`).join(' ')}</td>
    <td>${c.alreadyB2B ? '<span class="badge badge-paid">Already b2b</span>' : '<span class="badge badge-pending">Needs migration</span>'}</td>
  </tr>`).join('');

  return layout({ title: 'SparkLayer Migration', session, activePath: '/migrate', content: `
    <div class="page-header">
      <h1>SparkLayer Migration</h1>
      <span class="text-muted">Tag legacy SparkLayer customers with <code>b2b</code></span>
    </div>
    ${flashHtml}
    ${error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(error)}</div>` : ''}

    <div class="report-stats" style="margin-bottom:1.5rem">
      <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">SparkLayer Customers Found</div></div>
      <div class="stat-card"><div class="stat-value">${alreadyMigrated}</div><div class="stat-label">Already Have b2b Tag</div></div>
      <div class="stat-card"><div class="stat-value">${pending.length}</div><div class="stat-label">Pending Migration</div></div>
    </div>

    ${pending.length === 0 ? `<div class="alert alert-success">All SparkLayer customers are already tagged <code>b2b</code>. Nothing to migrate.</div>` : `
    <form method="POST" action="/migrate/run">
      <div style="margin-bottom:1rem">
        <strong>${pending.length} customers</strong> will receive the <code>b2b</code> tag. This is idempotent — re-running is safe.
      </div>
      <button type="submit" class="btn btn-primary" onclick="return confirm('Tag ${pending.length} customers with b2b? This writes to Shopify.')">
        Run Migration (${pending.length} customers)
      </button>
    </form>`}

    ${candidates.length ? `
    <div class="report-section" style="margin-top:2rem">
      <h2>All SparkLayer Customers</h2>
      <table class="data-table data-table-sm">
        <thead><tr><th>Select</th><th>Name</th><th>Email</th><th>Current Tags</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ''}
  ` });
}

// WHAT: GET /migrate — requireAuth-gated page listing SparkLayer customers eligible for the `b2b` tag.
// CHANGE-GUARD: flash is parsed from query (?flash=ok|err&msg=...); data comes from getMigrateData() which may carry an `error` field — renderMigrate must handle the degraded case.
// INVARIANT(S): read-only; performs no writes; safe to refresh.
app.get('/migrate', requireAuth, async (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || '' } : null;
  const data = await getMigrateData();
  res.send(renderMigrate(req.adminSession, data, flash));
});

// WHAT: POST /migrate/run — tags every pending SparkLayer customer with `b2b` via Shopify tagsAdd (or mockSparkLayerMigrated.add in MOCK).
// CHANGE-GUARD: it RE-FETCHES getMigrateData() and re-derives `pending` rather than trusting posted ids; two concurrent submits would each tag the same set (tagsAdd is idempotent so harmless, but migrated/errors counts double-count) — serialize if that matters.
// INVARIANT(S): tagsAdd is idempotent (re-running is safe, as the UI claims); per-customer failures are caught, logged, and counted in `errors` without aborting the loop; every successful tag is auditLog'd as migrate:sparklayer:tag_b2b.
app.post('/migrate/run', requireAuth, async (req, res) => {
  const data = await getMigrateData();
  const pending = data.candidates.filter(c => !c.alreadyB2B);
  let migrated = 0;
  let errors   = 0;
  for (const c of pending) {
    try {
      if (MOCK) {
        mockSparkLayerMigrated.add(c.numId);
      } else {
        await shopifyFetch(`mutation tagsAdd($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){node{id} userErrors{field message}}}`,
          { id: c.id, tags: ['b2b'] });
      }
      auditLog(req.adminSession.email, 'migrate:sparklayer:tag_b2b', c.id, JSON.stringify(c.tags), JSON.stringify([...c.tags, 'b2b']));
      migrated++;
    } catch (err) {
      console.error(`migrate ${c.id}:`, err.message);
      errors++;
    }
  }
  const msg = errors
    ? `Migrated ${migrated}, errors on ${errors}. Check logs.`
    : `Successfully tagged ${migrated} customer${migrated!==1?'s':''} with b2b.`;
  res.redirect(`/migrate?flash=${errors?'err':'ok'}&msg=${encodeURIComponent(msg)}`);
});

// ── Audit log ─────────────────────────────────────────────────────────────────

// WHAT: GET /audit — paginated audit-log viewer (100 rows/page) backed by getAuditLog/getAuditLogCount.
// CHANGE-GUARD: page is parsed from req.query.page and clamped to >=1; auditTargetLink() regex-matches gid://shopify/Order|Customer and lead:N patterns to build links — extend both the regex and the link map together if new target shapes are introduced.
// INVARIANT(S): r.after_val and r.target are h()-escaped before render; timestamps are formatted as UTC ISO sliced to 19 chars; pagination links preserve only ?page (no other filters exist on this route).
app.get('/audit', requireAuth, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;
  const rows  = getAuditLog({ limit, offset });
  const total = getAuditLogCount();
  const pages = Math.ceil(total / limit);

  function auditTargetLink(target) {
    if (!target) return '—';
    // Shopify GID: gid://shopify/Order/123, gid://shopify/Customer/456
    const gidM = /^gid:\/\/shopify\/(Order|Customer)\/(\d+)$/.exec(target);
    if (gidM) {
      const [, type, id] = gidM;
      const url = type === 'Order' ? `/orders/${id}` : `/customers/${id}`;
      const label = `${type} #${id}`;
      return `<a href="${url}" class="link">${h(label)}</a>`;
    }
    // Short patterns: "lead:5"
    const shortM = /^lead:(\d+)$/.exec(target);
    if (shortM) {
      return `<a href="/leads/${shortM[1]}" class="link">${h(target)}</a>`;
    }
    return `<span title="${h(target)}" style="max-width:200px;display:inline-block;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom">${h(target)}</span>`;
  }

  const tableRows = rows.map(r => `<tr>
    <td class="mono text-sm">${new Date(r.ts).toISOString().replace('T',' ').slice(0,19)}</td>
    <td><a href="mailto:${h(r.email)}" class="link">${h(r.email)}</a></td>
    <td class="mono">${h(r.action)}</td>
    <td class="text-sm text-muted">${auditTargetLink(r.target)}</td>
    <td class="text-sm mono" style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${h(r.after_val||'')}</td>
  </tr>`).join('');

  const pagination = pages > 1 ? `<div class="pagination">
    ${page > 1 ? `<a href="/audit?page=${page-1}" class="btn btn-ghost btn-sm">← Prev</a>` : ''}
    <span class="text-muted">Page ${page} of ${pages} (${total} entries)</span>
    ${page < pages ? `<a href="/audit?page=${page+1}" class="btn btn-ghost btn-sm">Next →</a>` : ''}
  </div>` : `<p class="text-muted">${total} entries</p>`;

  res.send(layout({ title: 'Audit Log', session: req.adminSession, activePath: '/audit', content: `
    <div class="page-header"><h1>Audit Log</h1></div>
    ${pagination}
    <table class="data-table data-table-sm">
      <thead><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Target</th><th>After</th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="5" class="empty-state">No audit entries yet.</td></tr>'}</tbody>
    </table>
    ${pagination}
  ` }));
});

// ── Phase 5: Labels ───────────────────────────────────────────────────────────

// Mock data for labels (products with barcodes for test/demo)
const MOCK_LABEL_PRODUCTS = MOCK_PRODUCTS;

// WHAT: loads product+variant data (barcode, sku, price, inventory) for label generation, by id list or full catalog in MOCK.
// CHANGE-GUARD: variants are fetched first:30 — products with >30 variants silently lose the overflow on labels; the Shopify `nodes(ids:)` query expects gid://shopify/Product/<id> form built here from numeric ids.
// INVARIANT(S): result is filtered through Boolean to drop null nodes (deleted/inaccessible products); the returned shape (p.variants.edges[].node) must match what /labels and handleLabelsPdf consume.
async function getProductsForLabels(ids) {
  if (MOCK) {
    if (ids && ids.length) return MOCK_LABEL_PRODUCTS.filter(p => ids.includes(shopifyNumericId(p.id)));
    return MOCK_LABEL_PRODUCTS;
  }
  const gids = ids.map(id => `gid://shopify/Product/${id}`);
  const result = await shopifyFetch(`
    query($ids:[ID!]!){nodes(ids:$ids){... on Product{
      id handle title vendor productType tags barcode
      variants(first:30){edges{node{id title sku price compareAtPrice barcode inventoryQuantity}}}
    }}}`, { ids: gids });
  return (result.data?.nodes || []).filter(Boolean);
}

// WHAT: loads one order's line items (barcode, title, variantTitle, sku, price, qty) for the 'From an Order' labels tab.
// CHANGE-GUARD: lineItems are fetched first:50 — orders with >50 line items truncate silently; barcode comes from variant.barcode and is later validated as /^\d{12,13}$/ in renderLabelsPage, so non-UPC barcodes are dropped downstream.
// INVARIANT(S): returns null when the order doesn't exist (caller shows 'Order not found'); MOCK path reads MOCK_ORDERS and mirrors the live shape exactly.
async function getOrderForLabels(numericId) {
  if (MOCK) {
    const o = MOCK_ORDERS.find(o => shopifyNumericId(o.id) === numericId);
    if (!o) return null;
    return { order: o, items: o.lineItems.edges
      // CURRENT-FIELDS (2026-06-29): drop lines removed in an edit (currentQuantity 0) so packing
      // labels never list a line that's no longer part of the order.
      .filter(e => ((e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0) > 0)
      .map(e => {
      const v = e.node.variant || {};
      return {
        barcode:      v.barcode || '',
        title:        e.node.title,
        variantTitle: v.displayName || v.sku || 'Default Title',
        sku:          v.sku || '',
        price:        v.price || '0.00',
        // qty keys off currentQuantity (post-edit truth), falling back to frozen quantity for unedited orders.
        qty:          e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity,
      };
    })};
  }
  const result = await shopifyFetch(`
    query($id:ID!){order(id:$id){
      name
      lineItems(first:50){edges{node{
        title quantity currentQuantity
        variant{id sku price barcode displayName}
      }}}
    }}`, { id: `gid://shopify/Order/${numericId}` });
  const o = result.data?.order;
  if (!o) return null;
  return {
    order: o,
    items: o.lineItems.edges
      // CURRENT-FIELDS (2026-06-29): drop lines removed in an edit (currentQuantity 0).
      .filter(e => ((e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity) || 0) > 0)
      .map(e => ({
      barcode:      e.node.variant?.barcode || '',
      title:        e.node.title,
      variantTitle: e.node.variant?.displayName || e.node.variant?.sku || '',
      sku:          e.node.variant?.sku || '',
      price:        e.node.variant?.price || '0.00',
      // qty keys off currentQuantity (post-edit truth), falling back to frozen quantity for unedited orders.
      qty:          e.node.currentQuantity != null ? e.node.currentQuantity : e.node.quantity,
    })),
  };
}

function renderLabelsPage(session, { source, orderData, productItems, flash, savedTemplate, savedFields, queryOrder = '', queryQ = '' }) {
  const sf = savedFields || DEFAULT_FIELDS;
  const templateOptions = Object.entries(LABEL_TEMPLATES)
    .map(([k, v]) => `<option value="${h(k)}"${k === (savedTemplate || 'avery-5160') ? ' selected' : ''}>${h(v.name)}</option>`)
    .join('');

  const fieldCheckboxes = [
    { key: 'productName', label: 'Product name' },
    { key: 'variantName', label: 'Variant name' },
    { key: 'msrp',        label: 'Retail price (MSRP)' },
    { key: 'sku',         label: 'SKU' },
    { key: 'upcBarcode',  label: 'UPC barcode (graphic)' },
    { key: 'upcDigits',   label: 'UPC digits (text)' },
  ].map(f => `<label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;white-space:nowrap">
      <input type="checkbox" name="field_${h(f.key)}" value="1"${sf[f.key] !== false ? ' checked' : ''} class="field-sel">
      ${h(f.label)}
    </label>`).join('');

  const optionsForm = `
    <div class="settings-section" style="margin-top:1rem">
      <h3 style="font-size:0.9rem;margin-bottom:0.75rem">Options</h3>
      <div class="form-row">
        <label>Label size</label>
        <select name="template" class="form-input">${templateOptions}</select>
      </div>
      <div class="form-row" style="align-items:flex-start">
        <label style="min-width:120px;padding-top:2px">Include on label</label>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem 1rem">${fieldCheckboxes}</div>
      </div>
    </div>`;

  const flashHtml = flash ? `<div class="alert ${flash.ok ? 'alert-success' : 'alert-error'}" style="margin-bottom:1rem">${h(flash)}</div>` : '';

  // Build items table if we have data
  let itemsTable = '';
  let hiddenItems = '';
  const allItems = source === 'order' ? (orderData?.items || []) : (productItems || []);
  const skippedCount = allItems.filter(i => !i.barcode || !/^\d{12,13}$/.test(String(i.barcode))).length;

  if (allItems.length) {
    const skippedWarn = skippedCount > 0
      ? `<div class="alert alert-error" style="margin-bottom:0.75rem">${skippedCount} variant${skippedCount > 1 ? 's have' : ' has'} no valid UPC barcode and will be skipped.</div>`
      : '';
    const rows = allItems.map((item, idx) => {
      const hasBarcode = item.barcode && /^\d{12,13}$/.test(String(item.barcode));
      return `<tr class="${hasBarcode ? '' : 'row-muted'}">
        <td><input type="checkbox" name="sel" value="${idx}"${hasBarcode ? ' checked' : ' disabled'} class="item-sel"></td>
        <td>${h(item.title)}</td>
        <td class="text-sm text-muted">${h(item.variantTitle || '')}</td>
        <td class="mono text-sm">${hasBarcode ? h(item.barcode) : '<span class="text-muted">—</span>'}</td>
        <td><input type="number" name="item_qty_${idx}" value="${item.qty || 1}" min="1" max="999" style="width:60px" class="form-input form-input-sm"></td>
        <td class="text-sm">${item.price ? '$' + h(String(item.price)) : '—'}</td>
      </tr>
      <input type="hidden" name="item_barcode_${idx}" value="${h(item.barcode || '')}">
      <input type="hidden" name="item_title_${idx}" value="${h(item.title || '')}">
      <input type="hidden" name="item_variant_${idx}" value="${h(item.variantTitle || '')}">
      <input type="hidden" name="item_sku_${idx}" value="${h(item.sku || '')}">
      <input type="hidden" name="item_price_${idx}" value="${h(item.price || '')}">`;
    }).join('');
    itemsTable = `
      <input type="hidden" name="item_count" value="${allItems.length}">
      ${skippedWarn}
      <div class="table-wrap" style="margin-top:0.75rem">
        <table class="data-table data-table-sm">
          <thead><tr><th style="width:30px"></th><th>Product</th><th>Variant</th><th>UPC</th><th style="width:70px">Qty</th><th>Price</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:1rem;display:flex;gap:0.75rem;flex-wrap:wrap">
        <button type="submit" formaction="/labels/preview" formtarget="_blank" class="btn btn-secondary">Preview PDF</button>
        <button type="submit" formaction="/labels/print" class="btn btn-primary">Download PDF</button>
      </div>`;
  }

  // Order tab: optionsForm always visible; items table conditional
  const orderItemsSection = source === 'order' && allItems.length
    ? `<form method="POST">${optionsForm}${itemsTable}</form>`
    : `<div>${optionsForm}</div>`;

  const fromOrderTab = `
    <div>
      <form method="GET" action="/labels" style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem">
        <input type="hidden" name="source" value="order">
        <input type="text" name="order" placeholder="Order # (e.g. 1001)" class="form-input search-input" style="width:220px" value="${h(queryOrder)}">
        <button type="submit" class="btn btn-secondary">Load Order</button>
      </form>
      ${source === 'order' && orderData ? `<p class="text-muted text-sm">Loaded order ${h(orderData.order?.name || '')}</p>` : ''}
      ${source === 'order' && !orderData && queryOrder ? '<p class="alert alert-error">Order not found.</p>' : ''}
      ${orderItemsSection}
    </div>`;

  // Products tab: optionsForm always visible; items table conditional
  const productItemsSection = source === 'products' && productItems !== null && allItems.length
    ? `<form method="POST">${optionsForm}${itemsTable}</form>`
    : `<div>${optionsForm}</div>`;

  const fromProductsTab = `
    <div>
      <form method="GET" action="/labels" id="product-search-form" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem">
        <input type="hidden" name="source" value="products">
        <input type="text" name="q" placeholder="Search products..." class="form-input search-input" style="width:240px" value="${h(queryQ)}">
        <button type="submit" class="btn btn-secondary">Search</button>
      </form>
      ${productItemsSection}
    </div>`;

  return layout({ title: 'Labels', session, activePath: '/labels', content: `
    <div class="page-header"><h1>Barcode Labels</h1></div>
    ${flashHtml}
    <div class="tab-bar">
      <button class="tab${source !== 'products' ? ' active' : ''}" data-tab="from-order">From an Order</button>
      <button class="tab${source === 'products' ? ' active' : ''}" data-tab="from-products">From Products</button>
    </div>
    <div class="tab-content${source !== 'products' ? '' : ' hidden'}" id="from-order">${fromOrderTab}</div>
    <div class="tab-content${source === 'products' ? '' : ' hidden'}" id="from-products">${fromProductsTab}</div>
    <script>
    document.querySelectorAll('.tab').forEach(function(t) {
      t.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(x) { x.classList.add('hidden'); });
        this.classList.add('active');
        document.getElementById(this.dataset.tab).classList.remove('hidden');
      });
    });
    </script>
  ` });
}

app.get('/labels', requireAuth, async (req, res) => {
  const source = req.query.source || 'order';
  const savedTemplate = getSetting('last_label_template', req.adminSession.email) || 'avery-5160';
  const savedFieldsStr = getSetting('last_label_fields', req.adminSession.email);
  const savedFields = savedFieldsStr ? JSON.parse(savedFieldsStr) : { ...DEFAULT_FIELDS };
  const queryOrder = req.query.order || '';
  const queryQ = req.query.q || '';

  if (source === 'order' && queryOrder) {
    const orderData = await getOrderForLabels(queryOrder);
    return res.send(renderLabelsPage(req.adminSession, { source: 'order', orderData, productItems: null, flash: null, savedTemplate, savedFields, queryOrder, queryQ }));
  }

  if (source === 'products') {
    const q = queryQ.toLowerCase();
    const rawProducts = await getProductsForLabels(null);
    const filtered = q
      ? rawProducts.filter(p => p.title.toLowerCase().includes(q) || (p.handle || '').includes(q))
      : rawProducts;
    const productItems = filtered.flatMap(p =>
      p.variants.edges.map(e => ({
        barcode:      e.node.barcode || '',
        title:        p.title,
        variantTitle: e.node.title !== 'Default Title' ? e.node.title : '',
        sku:          e.node.sku || '',
        price:        e.node.price || '0.00',
        qty:          1,
      }))
    );
    return res.send(renderLabelsPage(req.adminSession, { source: 'products', orderData: null, productItems, flash: null, savedTemplate, savedFields, queryOrder, queryQ }));
  }

  res.send(renderLabelsPage(req.adminSession, { source: 'order', orderData: null, productItems: null, flash: null, savedTemplate, savedFields, queryOrder, queryQ }));
});

// Shared label PDF generator for preview + print
// WHAT: shared PDF generator for POST /labels/preview (inline) and /labels/print (attachment) — reads the 6 field checkboxes + selected items from the form, renders an Avery label sheet, persists last-used template/fields, and logs the batch.
// CHANGE-GUARD: trusts client-posted item_barcode_/title_/sku_/price_ hidden fields (no server re-fetch), so barcodes are whatever the browser submitted — re-test that renderLabelSheet still rejects non-12/13-digit barcodes; the `sel` field is normalized via [req.body.sel||[]].flat() to tolerate single-vs-array.
// INVARIANT(S): 400 if zero fields selected or zero items selected; on success sets Content-Type application/pdf with the disposition arg and emits auditLog label:generate; setSetting keys (last_label_template/last_label_fields) are per-admin (scoped by req.adminSession.email).
async function handleLabelsPdf(req, res, disposition) {
  const itemCount = parseInt(req.body.item_count) || 0;
  const template  = req.body.template || 'avery-5160';

  // Phase 8: 6-checkbox field selection
  const fields = {
    productName: req.body.field_productName === '1',
    variantName: req.body.field_variantName === '1',
    msrp:        req.body.field_msrp        === '1',
    sku:         req.body.field_sku         === '1',
    upcBarcode:  req.body.field_upcBarcode  === '1',
    upcDigits:   req.body.field_upcDigits   === '1',
  };
  if (!Object.values(fields).some(Boolean)) return res.status(400).json({ error: 'Select at least one field.' });

  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const sel = [req.body.sel || []].flat();
    if (!sel.includes(String(i))) continue;
    items.push({
      barcode:      String(req.body[`item_barcode_${i}`] || ''),
      title:        String(req.body[`item_title_${i}`]   || ''),
      variantTitle: String(req.body[`item_variant_${i}`] || ''),
      sku:          String(req.body[`item_sku_${i}`]     || ''),
      price:        String(req.body[`item_price_${i}`]   || ''),
      qty:          parseInt(req.body[`item_qty_${i}`])  || 1,
    });
  }

  if (!items.length) return res.status(400).json({ error: 'No items selected.' });

  try {
    const { pdf, skipped } = await renderLabelSheet({ template, items, fields });
    const { labels } = expandItems(items);

    setSetting('last_label_template', template, req.adminSession.email);
    setSetting('last_label_fields', JSON.stringify(fields), req.adminSession.email);
    logLabelBatch(req.adminSession.email, template, items.length, labels.length);
    auditLog(req.adminSession.email, 'label:generate', template, null, { items: items.length, labels: labels.length });

    const ts = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="fww-labels-${ts}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Label PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// WHAT: the two label-PDF endpoints — /labels/preview opens inline (formtarget=_blank), /labels/print downloads as attachment; both delegate to handleLabelsPdf.
// CHANGE-GUARD: the only difference is the Content-Disposition arg ('inline' vs 'attachment'); keep both requireAuth-gated since they read order/product data.
// INVARIANT(S): both are POST (form carries item_count + per-item hidden fields); GET would lose the selection payload.
app.post('/labels/preview', requireAuth, (req, res) => handleLabelsPdf(req, res, 'inline'));
app.post('/labels/print',   requireAuth, (req, res) => handleLabelsPdf(req, res, 'attachment'));

// ── Phase 6: Exports ──────────────────────────────────────────────────────────

// WHAT: loads full product+variant detail (images, inventory, timestamps) for CSV/image exports via Shopify nodes(ids:) or MOCK_PRODUCTS.
// CHANGE-GUARD: images first:30 and variants first:50 — exports silently drop overflow beyond those caps; the gid mapping `gid://shopify/Product/<id>` must match what getAllB2bProductIds returns (numeric ids).
// INVARIANT(S): null nodes filtered out; b2b_price in the CSV is later derived as price*0.5 (hardcoded 50%, NOT the per-customer/global discount) — see /exports/csv.
async function getProductsForExport(ids) {
  if (MOCK) {
    if (ids && ids.length) return MOCK_PRODUCTS.filter(p => ids.includes(shopifyNumericId(p.id)));
    return MOCK_PRODUCTS;
  }
  const gids = ids.map(id => `gid://shopify/Product/${id}`);
  const result = await shopifyFetch(`
    query($ids:[ID!]!){nodes(ids:$ids){... on Product{
      id handle title vendor productType tags
      featuredImage{url altText}
      images(first:30){edges{node{url altText}}}
      variants(first:50){edges{node{
        id title sku barcode price compareAtPrice inventoryQuantity inventoryPolicy
        createdAt updatedAt
      }}}
      createdAt updatedAt
    }}}`, { ids: gids });
  return (result.data?.nodes || []).filter(Boolean);
}

// WHAT: paginates all product ids in the B2B publication (publication_id:<B2B_PUB_ID tail>) for select-all on the export pages.
// CHANGE-GUARD: the loop is bounded to 20 pages * 250 = 5000 products MAX and then stops silently (see bugs[]) — a larger B2B catalog will export an incomplete 'all'; raise the page bound or surface a truncation warning if the catalog grows.
// INVARIANT(S): breaks on !hasNextPage; advances via endCursor cursor pagination; MOCK returns every MOCK_PRODUCTS id.
async function getAllB2bProductIds() {
  if (MOCK) return MOCK_PRODUCTS.map(p => shopifyNumericId(p.id));
  const ids = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const result = await shopifyFetch(
      `query($q:String!,$first:Int!,$after:String){products(first:$first,query:$q,after:$after){edges{node{id}}pageInfo{hasNextPage endCursor}}}`,
      { q: `publication_id:${B2B_PUB_ID.split('/').pop()}`, first: 250, after });
    const edges = result.data?.products?.edges || [];
    ids.push(...edges.map(e => shopifyNumericId(e.node.id)));
    if (!result.data?.products?.pageInfo?.hasNextPage) break;
    after = result.data.products.pageInfo.endCursor;
  }
  return ids;
}

// WHAT: renders the /exports landing with two cards linking to the CSV and image export flows.
// CHANGE-GUARD: static markup only; the card hrefs (/exports/csv, /exports/images) must match the registered routes.
// INVARIANT(S): no user data interpolated, so no escaping needed here.
function renderExportsLanding(session) {
  return layout({ title: 'Exports', session, activePath: '/exports', content: `
    <div class="page-header"><h1>Exports</h1></div>
    <div class="exports-cards">
      <a href="/exports/csv" class="export-card">
        <div class="export-card-icon">CSV</div>
        <h3>Product CSV</h3>
        <p>Export product + variant data (handle, SKU, UPC, price, inventory) as CSV. One row per variant.</p>
      </a>
      <a href="/exports/images" class="export-card">
        <div class="export-card-icon">ZIP</div>
        <h3>Product Images</h3>
        <p>Download main photos or full image galleries as a ZIP file. Original resolution from Shopify CDN.</p>
      </a>
    </div>
  ` });
}

// WHAT: renders the CSV export builder — product picker (with select-all/clear links) plus a column checklist; ALL_COLS is the canonical column catalog.
// CHANGE-GUARD: ALL_COLS keys MUST stay in sync with the rowData object in POST /exports/csv (a key here with no rowData entry exports as blank); estRows is a cosmetic estimate (selectedCount*2 in MOCK, *3 live) — not authoritative.
// INVARIANT(S): selCols defaults to all columns when `columns` is null; checkbox name='cols' values are the raw column keys consumed server-side.
function renderExportsCsv(session, { products, selectedIds, columns, flash }) {
  const ALL_COLS = [
    ['product_handle','Handle'], ['product_title','Title'], ['vendor','Vendor'], ['product_type','Type'],
    ['style','Style'], ['tags','Tags'], ['variant_id','Variant ID'], ['variant_title','Variant Title'],
    ['sku','SKU'], ['barcode','UPC/Barcode'], ['price','Price (MSRP)'], ['b2b_price','B2B Price'],
    ['compare_at_price','Compare At'], ['inventory_qty','Inventory'], ['inventory_policy','Inv. Policy'],
    ['created_at','Created'], ['updated_at','Updated'],
  ];
  const selCols = columns || ALL_COLS.map(([k]) => k);
  const colChecks = ALL_COLS.map(([k, label]) =>
    `<label class="col-check"><input type="checkbox" name="cols" value="${k}"${selCols.includes(k) ? ' checked' : ''}> ${h(label)}</label>`
  ).join('');
  const productRows = products.map(p => {
    const numId = shopifyNumericId(p.id);
    const selected = selectedIds.includes(numId);
    return `<tr>
      <td><input type="checkbox" name="ids" value="${numId}"${selected ? ' checked' : ''} class="item-sel"></td>
      <td>${h(p.title)}</td>
      <td class="text-sm text-muted">${h(p.vendor || '')}</td>
      <td class="text-sm">${p.variants.edges.length} variant${p.variants.edges.length !== 1 ? 's' : ''}</td>
    </tr>`;
  }).join('');
  const selectedCount = selectedIds.length || products.length;
  const estRows = MOCK ? selectedCount * 2 : selectedCount * 3;

  return layout({ title: 'CSV Export', session, activePath: '/exports', content: `
    <div class="page-header">
      <h1>Product CSV Export</h1>
      <a href="/exports" class="btn btn-ghost btn-sm">← Exports</a>
    </div>
    ${flash ? `<div class="alert alert-error" style="margin-bottom:1rem">${h(flash)}</div>` : ''}
    <form method="POST" action="/exports/csv">
      <div class="exports-layout">
        <section class="settings-section">
          <h3>Select Products</h3>
          <div style="margin-bottom:0.5rem;display:flex;gap:0.5rem;align-items:center">
            <a href="/exports/csv?select=all" class="btn btn-ghost btn-sm">Select all B2B (${products.length})</a>
            <a href="/exports/csv?select=none" class="btn btn-ghost btn-sm">Clear</a>
          </div>
          <div class="table-wrap" style="max-height:360px;overflow-y:auto">
            <table class="data-table data-table-sm">
              <thead><tr><th style="width:30px"></th><th>Product</th><th>Vendor</th><th>Variants</th></tr></thead>
              <tbody>${productRows || '<tr><td colspan="4" class="empty-state">No products.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        <section class="settings-section">
          <h3>Columns</h3>
          <div class="col-checks">${colChecks}</div>
          <div style="margin-top:1.25rem">
            <p class="text-muted text-sm">~${estRows} rows (1 per variant)</p>
            <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">Download CSV</button>
          </div>
        </section>
      </div>
    </form>
  ` });
}

// WHAT: renders the image-export builder — product picker plus a main-only vs full-gallery radio; estimates total image count per the chosen mode.
// CHANGE-GUARD: imgCount/totalImgs estimates read p.images.edges.length (gallery) or 1 (main) and must match the actual enumeration logic in POST /exports/images or the estimate misleads.
// INVARIANT(S): mode is normalized to 'gallery' vs anything-else server-side; checkbox name='ids', radio name='mode'.
function renderExportsImages(session, { products, selectedIds, mode, flash }) {
  const productRows = products.map(p => {
    const numId = shopifyNumericId(p.id);
    const selected = selectedIds.includes(numId);
    const imgCount = mode === 'gallery' ? (p.images?.edges?.length || 1) : 1;
    return `<tr>
      <td><input type="checkbox" name="ids" value="${numId}"${selected ? ' checked' : ''} class="item-sel"></td>
      <td>${h(p.title)}</td>
      <td class="text-sm text-muted">${h(p.vendor || '')}</td>
      <td class="text-sm" id="img-count-${numId}">${imgCount} image${imgCount !== 1 ? 's' : ''}</td>
    </tr>`;
  }).join('');
  const totalImgs = selectedIds.length
    ? products.filter(p => selectedIds.includes(shopifyNumericId(p.id))).reduce((s, p) => s + (mode === 'gallery' ? (p.images?.edges?.length || 1) : 1), 0)
    : products.reduce((s, p) => s + (mode === 'gallery' ? (p.images?.edges?.length || 1) : 1), 0);

  return layout({ title: 'Image Export', session, activePath: '/exports', content: `
    <div class="page-header">
      <h1>Product Image Export</h1>
      <a href="/exports" class="btn btn-ghost btn-sm">← Exports</a>
    </div>
    ${flash ? `<div class="alert alert-error" style="margin-bottom:1rem">${h(flash)}</div>` : ''}
    <form method="POST" action="/exports/images" id="images-form">
      <div class="exports-layout">
        <section class="settings-section">
          <h3>Select Products</h3>
          <div style="margin-bottom:0.5rem;display:flex;gap:0.5rem;align-items:center">
            <a href="/exports/images?select=all" class="btn btn-ghost btn-sm">Select all B2B (${products.length})</a>
            <a href="/exports/images?select=none" class="btn btn-ghost btn-sm">Clear</a>
          </div>
          <div class="table-wrap" style="max-height:360px;overflow-y:auto">
            <table class="data-table data-table-sm">
              <thead><tr><th style="width:30px"></th><th>Product</th><th>Vendor</th><th>Images</th></tr></thead>
              <tbody>${productRows || '<tr><td colspan="4" class="empty-state">No products.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        <section class="settings-section">
          <h3>Image Mode</h3>
          <div style="display:flex;flex-direction:column;gap:0.5rem">
            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
              <input type="radio" name="mode" value="main-only"${mode !== 'gallery' ? ' checked' : ''}> Main photo only
            </label>
            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
              <input type="radio" name="mode" value="gallery"${mode === 'gallery' ? ' checked' : ''}> Main + all gallery images
            </label>
          </div>
          <div style="margin-top:1.25rem">
            <p class="text-muted text-sm" id="img-total-est">~${totalImgs} image${totalImgs !== 1 ? 's' : ''} estimated</p>
            <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">Download ZIP</button>
          </div>
        </section>
      </div>
    </form>
  ` });
}

// WHAT: GET /exports — the exports landing page (requireAuth).
// CHANGE-GUARD: pure render of renderExportsLanding; no data fetch.
// INVARIANT(S): read-only.
app.get('/exports', requireAuth, (req, res) => {
  res.send(renderExportsLanding(req.adminSession));
});

// WHAT: GET /exports/csv — renders the CSV builder pre-populated with all B2B products and the admin's last-used columns.
// CHANGE-GUARD: it calls getAllB2bProductIds() then getProductsForExport(allIds) on every load — this is two full paginated Shopify passes and can be slow for large catalogs; consider caching if the catalog grows.
// INVARIANT(S): the ?select=none|all toggle only affects which boxes are checked, NOT which products are loaded; saved columns come from per-admin setting last_export_csv_cols.
app.get('/exports/csv', requireAuth, async (req, res) => {
  const allIds = await getAllB2bProductIds();
  const products = await getProductsForExport(allIds);
  const select = req.query.select;
  const selectedIds = select === 'none' ? [] : select === 'all' ? allIds : allIds;
  const savedCols = getSetting('last_export_csv_cols', req.adminSession.email);
  const columns = savedCols ? savedCols.split(',') : null;
  res.send(renderExportsCsv(req.adminSession, { products, selectedIds, columns, flash: null }));
});

// WHAT: POST /exports/csv — streams a CSV (one row per variant) for the selected product ids and columns; saves the column selection per-admin.
// CHANGE-GUARD: b2b_price is hardcoded as price*0.5 (NOT the global b2b_discount_pct or any per-customer metafield) — fix here if 50% is no longer the wholesale default; ids/cols are normalized via [x||[]].flat().filter(Boolean) to tolerate single-vs-array form posts.
// INVARIANT(S): re-renders the builder with a flash (not a 4xx) when ids or cols are empty; writes the header row then streams variant rows via res.write/res.end; logExportBatch + auditLog export:csv fire AFTER res.end (totals reflect actual rows written).
app.post('/exports/csv', requireAuth, async (req, res) => {
  const ids = [req.body.ids || []].flat().filter(Boolean);
  const cols = [req.body.cols || []].flat().filter(Boolean);
  if (!ids.length) {
    const allIds = await getAllB2bProductIds();
    const products = await getProductsForExport(allIds);
    return res.send(renderExportsCsv(req.adminSession, { products, selectedIds: [], columns: cols, flash: 'Select at least one product.' }));
  }
  if (!cols.length) {
    const products = await getProductsForExport(ids);
    return res.send(renderExportsCsv(req.adminSession, { products, selectedIds: ids, columns: null, flash: 'Select at least one column.' }));
  }

  // Save prefs
  setSetting('last_export_csv_cols', cols.join(','), req.adminSession.email);

  const products = await getProductsForExport(ids);
  const ts = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fww-products-${ts}.csv"`);
  res.write(csvLine(cols));

  let totalRows = 0;
  for (const p of products) {
    const style = (p.tags || []).find(t => t.startsWith('Style_'))?.slice(6) || '';
    const tagStr = (p.tags || []).join('|');
    for (const ve of p.variants.edges) {
      const v = ve.node;
      const b2bPrice = (parseFloat(v.price || 0) * 0.5).toFixed(2);
      const rowData = {
        product_handle: p.handle || '',
        product_title: p.title || '',
        vendor: p.vendor || '',
        product_type: p.productType || '',
        style,
        tags: tagStr,
        variant_id: shopifyNumericId(v.id || ''),
        variant_title: v.title || '',
        sku: v.sku || '',
        barcode: v.barcode || '',
        price: v.price || '',
        b2b_price: b2bPrice,
        compare_at_price: v.compareAtPrice || '',
        inventory_qty: v.inventoryQuantity ?? '',
        inventory_policy: v.inventoryPolicy || '',
        created_at: (v.createdAt || p.createdAt || '').slice(0, 10),
        updated_at: (v.updatedAt || p.updatedAt || '').slice(0, 10),
      };
      res.write(csvLine(cols.map(c => rowData[c] ?? '')));
      totalRows++;
    }
  }
  res.end();
  logExportBatch(req.adminSession.email, 'csv', products.length, totalRows, 0);
  auditLog(req.adminSession.email, 'export:csv', null, null, { products: products.length, rows: totalRows, cols: cols.length });
});

// WHAT: GET /exports/images — renders the image-export builder with all B2B products and the admin's last-used mode.
// CHANGE-GUARD: same dual full-pagination cost as /exports/csv (getAllB2bProductIds + getProductsForExport); savedMode defaults to 'main-only'.
// INVARIANT(S): ?select=none clears the pre-checked boxes, otherwise all are checked; read-only (no Shopify writes).
app.get('/exports/images', requireAuth, async (req, res) => {
  const allIds = await getAllB2bProductIds();
  const products = await getProductsForExport(allIds);
  const select = req.query.select;
  const selectedIds = select === 'none' ? [] : allIds;
  const savedMode = getSetting('last_export_img_mode', req.adminSession.email) || 'main-only';
  res.send(renderExportsImages(req.adminSession, { products, selectedIds, mode: savedMode, flash: null }));
});

// WHAT: streams a ZIP of product images (main-only or full gallery) fetched live from the Shopify CDN, one product at a time.
// CHANGE-GUARD: images are fetched sequentially with no concurrency cap, no per-request timeout, and no upper bound on product count — a large selection can hang the response and the event loop (see bugs[]); re-test with the full B2B catalog before changing batch sizing.
// INVARIANT(S): zip.finalize() must be called after all appends; a single failed image fetch is logged and skipped (does not abort the archive); filenames are derived from product.handle and must stay unique within the zip.
// WHAT: POST /exports/images — streams a ZIP of product images fetched live from the Shopify CDN, main-only or full gallery per `mode`.
// CHANGE-GUARD: images are fetched SEQUENTIALLY with await fetch(url) inside nested loops — no concurrency cap, no per-fetch timeout, and no upper bound on selected product count (see bugs[]); a large selection can stall the response and tie up the event loop. Re-test with the full catalog before changing batch sizing.
// INVARIANT(S): zip.finalize() MUST run after all appends; a single failed image fetch is caught/logged/skipped (does not abort the archive); zip entry names derive from p.handle (gallery names get a 2-digit index suffix) and must be unique within the zip; res headers (application/zip + Content-Disposition) are set before the first append.
app.post('/exports/images', requireAuth, async (req, res) => {
  const ids = [req.body.ids || []].flat().filter(Boolean);
  const mode = req.body.mode === 'gallery' ? 'gallery' : 'main-only';
  if (!ids.length) {
    const allIds = await getAllB2bProductIds();
    const products = await getProductsForExport(allIds);
    return res.send(renderExportsImages(req.adminSession, { products, selectedIds: [], mode, flash: 'Select at least one product.' }));
  }

  setSetting('last_export_img_mode', mode, req.adminSession.email);
  const products = await getProductsForExport(ids);
  const ts = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="fww-images-${ts}.zip"`);

  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.pipe(res);
  zip.on('error', err => { console.error('zip error:', err.message); });

  let totalImages = 0;
  for (const p of products) {
    let images = [];
    if (mode === 'gallery') {
      images = (p.images?.edges || []).map(e => e.node);
      if (!images.length && p.featuredImage) images = [p.featuredImage];
    } else {
      if (p.featuredImage) images = [p.featuredImage];
      else if (p.images?.edges?.length) images = [p.images.edges[0].node];
    }
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const url = img.url || '';
      const ext = path.extname(new URL(url, 'https://cdn.shopify.com').pathname) || '.jpg';
      const name = mode === 'gallery'
        ? `${p.handle}_${String(i + 1).padStart(2, '0')}${ext}`
        : `${p.handle}${ext}`;
      try {
        if (MOCK) {
          zip.append(Buffer.from(`mock image: ${url}`), { name });
        } else {
          const r = await fetch(url);
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            zip.append(buf, { name });
          }
        }
        totalImages++;
      } catch (err) {
        console.error(`image fetch error ${url}:`, err.message);
      }
    }
  }
  zip.finalize();
  logExportBatch(req.adminSession.email, 'images', products.length, totalImages, 0);
  auditLog(req.adminSession.email, 'export:images', mode, null, { products: products.length, images: totalImages });
});

// ── Phase 17: Wholesale Leads CRM ─────────────────────────────────────────────

// WHAT: the wholesale-lead status enum — label, badge color, and `terminal` flag for each state (converted/rejected are terminal).
// CHANGE-GUARD: keys here are the canonical status strings stored in the DB and referenced by LEAD_TRANSITIONS, renderLeadDetail badges, and audit logs — renaming a key requires a data migration AND a matching LEAD_TRANSITIONS update.
// INVARIANT(S): every status used in LEAD_TRANSITIONS (both sides) must exist here, or badge/label lookups fall back to a muted '—'.
const LEAD_STATUSES = {
  new:                 { label: 'New',                 color: 'blue',    terminal: false },
  under_review:        { label: 'Under Review',         color: 'warning', terminal: false },
  waiting_on_docs:     { label: 'Waiting on Docs',      color: 'orange',  terminal: false },
  waiting_on_sales_tax:{ label: 'Waiting on Tax Cert',  color: 'orange',  terminal: false },
  waiting_on_w9:       { label: 'Waiting on W9',        color: 'orange',  terminal: false },
  approved:            { label: 'Approved',             color: 'success', terminal: false },
  converted:           { label: 'Converted',            color: 'lime',    terminal: true  },
  rejected:            { label: 'Rejected',             color: 'danger',  terminal: true  },
  dormant:             { label: 'Dormant',              color: 'muted',   terminal: false },
};

// WHAT: the allowed lead state-machine edges — maps each status to the set of statuses it may move to.
// CHANGE-GUARD: POST /leads/:id/status enforces membership here (rejects with flash=invalid_status otherwise); 'approved'->'converted' is the ONLY path that reaches the convert flow, so removing it disables conversion. Terminal states map to [].
// INVARIANT(S): every key and every target must be a valid LEAD_STATUSES key; the machine is the single source of truth for legal transitions (the UI dropdown is built from it).
const LEAD_TRANSITIONS = {
  new:                  ['under_review', 'rejected'],
  under_review:         ['waiting_on_docs','waiting_on_sales_tax','waiting_on_w9','approved','rejected','dormant'],
  waiting_on_docs:      ['under_review','dormant','rejected'],
  waiting_on_sales_tax: ['under_review','dormant','rejected'],
  waiting_on_w9:        ['under_review','dormant','rejected'],
  approved:             ['converted','rejected'],
  converted:            [],
  rejected:             [],
  dormant:              ['under_review','rejected'],
};

// WHAT: renders the leads index — a search box, per-status filter chips with live counts, and a table; overdue follow-ups render in text-danger.
// CHANGE-GUARD: chip links carry both status and (encoded) q so filtering+search compose; the 'all' count is summed from counts across every status — if a status is missing from counts it contributes 0.
// INVARIANT(S): business_name/email/contact_name are h()-escaped; overdue is computed as next_followup_due < today (ISO date compare, lexicographic but safe for YYYY-MM-DD).
function renderLeadsList(session, { leads, counts, flash, q, status }) {
  const allCount = Object.values(counts).reduce((s, n) => s + n, 0);
  const chipList = [
    { value: 'all', label: `All (${allCount})` },
    ...Object.entries(LEAD_STATUSES).map(([k, v]) => ({ value: k, label: `${v.label} (${counts[k] || 0})` })),
  ];
  const chipBar = chipList.map(c =>
    `<a href="/leads?status=${h(c.value)}${q ? '&q=' + encodeURIComponent(q) : ''}" class="filter-chip${(status || 'all') === c.value ? ' filter-chip-active' : ''}">${h(c.label)}</a>`
  ).join('');

  const rows = leads.map(l => {
    const st = LEAD_STATUSES[l.status] || { label: l.status, color: 'muted' };
    const followUp = l.next_followup_due
      ? `<span class="${l.next_followup_due < new Date().toISOString().split('T')[0] ? 'text-danger' : 'text-muted'}">${h(l.next_followup_due)}</span>`
      : '<span class="text-muted">—</span>';
    return `<tr>
      <td><a href="/leads/${l.id}" class="link-strong">${h(l.business_name || '—')}</a><br><small class="text-muted">${h(l.email)}</small></td>
      <td>${h(l.contact_name || '—')}</td>
      <td><span class="badge badge-${st.color}">${h(st.label)}</span></td>
      <td class="text-muted small-text">${fmtDate(new Date(l.updated_at).toISOString())}</td>
      <td>${followUp}</td>
      <td><a href="/leads/${l.id}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const flashHtml = flash ? `<div class="alert alert-success">${h(flash)}</div>` : '';

  return layout({ title: 'Wholesale Leads', session, activePath: '/leads', content: `
    <div class="page-header-row">
      <h1>Wholesale Leads</h1>
      <a href="/leads/new" class="btn btn-primary">+ New Lead</a>
    </div>
    ${flashHtml}
    <div class="filter-bar" style="margin-bottom:0.75rem">
      <form method="GET" action="/leads" style="display:flex;gap:0.5rem;align-items:center;flex:1">
        <input type="hidden" name="status" value="${h(status || 'all')}">
        <input type="text" name="q" value="${h(q || '')}" class="input search-input" placeholder="Search name, email, business…" style="max-width:320px">
        <button type="submit" class="btn btn-secondary btn-sm">Search</button>
        ${q ? `<a href="/leads?status=${h(status || 'all')}" class="btn btn-ghost btn-sm">Clear</a>` : ''}
      </form>
    </div>
    <div class="filter-chips-row" style="margin-bottom:1rem;display:flex;flex-wrap:wrap;gap:0.35rem">${chipBar}</div>
    ${leads.length === 0
      ? `<div class="empty-state card" style="padding:2rem;text-align:center"><p class="text-muted">No leads found.</p><a href="/leads/new" class="btn btn-primary" style="margin-top:0.75rem">Create first lead</a></div>`
      : `<div class="table-wrap"><table class="data-table">
          <thead><tr><th>Business</th><th>Contact</th><th>Status</th><th>Last Activity</th><th>Follow-up</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
    }
  ` });
}

// WHAT: renders the New Lead form; `prefill` repopulates fields after a validation error (e.g. duplicate email).
// CHANGE-GUARD: the business_type and source <option> lists are hardcoded here — keep them in sync with any DB constraints or downstream reporting that buckets on these values.
// INVARIANT(S): email is the only required field (marked *); all prefill values pass through h() including the numeric estimated_monthly_volume_usd (String()-coerced).
// WHAT: closed set of valid ISO-3166-1 alpha-2 country codes for the lead address `country_code`
//   <select>. Deliberately NOT the same helper as fww-b2b-portal's `toCountryCode()` -- that
//   function DEFAULTS an unrecognized/blank value to 'US' (see its own comment: "US-only B2B
//   store"), which is precisely the bug that shipped order #38656 to Auckland NZ marked "United
//   States" (HANDOFF-2026-08-11). This map has no default: a code not in it is rejected outright.
// SYNC: keys here must stay in sync with the <option value=...> list rendered by countryOptions()
//   below and with PROVINCE_REQUIRED_COUNTRY_CODES/validateLeadInput's zip check.
const VALID_LEAD_COUNTRY_CODES = new Map(Object.entries({
  US: 'United States', CA: 'Canada', MX: 'Mexico', GB: 'United Kingdom', IE: 'Ireland',
  AU: 'Australia', NZ: 'New Zealand', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', CH: 'Switzerland', AT: 'Austria',
  PT: 'Portugal', DK: 'Denmark', SE: 'Sweden', NO: 'Norway', FI: 'Finland', IS: 'Iceland',
  PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria',
  GR: 'Greece', HR: 'Croatia', SI: 'Slovenia', EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania',
  JP: 'Japan', KR: 'South Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', SG: 'Singapore',
  MY: 'Malaysia', TH: 'Thailand', PH: 'Philippines', ID: 'Indonesia', VN: 'Vietnam', IN: 'India',
  IL: 'Israel', AE: 'United Arab Emirates', SA: 'Saudi Arabia', ZA: 'South Africa',
  BR: 'Brazil', AR: 'Argentina', CL: 'Chile', CO: 'Colombia', PE: 'Peru', UY: 'Uruguay',
  CR: 'Costa Rica', PA: 'Panama', DO: 'Dominican Republic', JM: 'Jamaica', PR: 'Puerto Rico',
}));

// WHAT: countries where a resale-style state/province is a meaningful, expected part of the
//   address (used to gate a required-field error in validateLeadInput). Not exhaustive of every
//   country that HAS provinces -- deliberately scoped to where Fuzzywumpets actually ships/sells.
const PROVINCE_REQUIRED_COUNTRY_CODES = new Set(['US', 'CA', 'AU', 'MX']);

function countryOptions(selected) {
  const sel = String(selected || '').toUpperCase();
  const rows = [...VALID_LEAD_COUNTRY_CODES.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return `<option value="">— select —</option>` + rows.map(([code, name]) =>
    `<option value="${code}"${sel === code ? ' selected' : ''}>${h(name)}</option>`
  ).join('');
}

// WHAT: shared validator for lead contact + address fields, used by both POST /leads/new and
//   POST /leads/:id/edit (D5, HANDOFF-2026-08-11) so the two entry points can never drift.
// CHANGE-GUARD: returns the FIRST problem found, as a specific human-readable message naming the
//   field, or null when the input is acceptable. Address requiredness rules ONLY engage once
//   country_code is non-blank -- a lead with a street address and nothing else (Hydref K-9, lead
//   #3) is honestly incomplete, not invalid, and must remain storable. NEVER default a blank or
//   unrecognized country to 'US' -- see VALID_LEAD_COUNTRY_CODES comment above.
// INVARIANT(S): pure function, no I/O; does not mutate req.body.
function validateLeadInput(body) {
  const email = String(body.email || '').trim();
  if (!email) return 'Email is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';

  const country = String(body.country_code || '').trim().toUpperCase();
  if (country) {
    if (!VALID_LEAD_COUNTRY_CODES.has(country)) return 'Unrecognized country. Choose one from the list.';
    if (PROVINCE_REQUIRED_COUNTRY_CODES.has(country) && !String(body.state || '').trim()) {
      return `State/province is required for ${VALID_LEAD_COUNTRY_CODES.get(country)}.`;
    }
    const postal = String(body.postal_code || '').trim();
    if (!postal) return 'Postal code is required when a country is set.';
    if (country === 'US' && !/^\d{5}(-\d{4})?$/.test(postal)) {
      return 'Enter a valid 5-digit US ZIP code (12345 or 12345-6789).';
    }
  }
  return null;
}

function renderLeadNew(session, { flash, prefill = {} }) {
  const flashHtml = flash ? `<div class="alert alert-danger">${h(flash)}</div>` : '';
  return layout({ title: 'New Lead', session, activePath: '/leads', content: `
    <div class="breadcrumb-row"><a href="/leads" class="breadcrumb">← Leads</a></div>
    <div class="page-header-row"><h1>New Lead</h1></div>
    ${flashHtml}
    <div class="card" style="max-width:640px">
      <form method="POST" action="/leads/new">
        <div class="settings-grid">
          <label>Email *</label>
          <input type="email" name="email" value="${h(prefill.email||'')}" required class="input" placeholder="buyer@boutique.com">
          <label>Business name</label>
          <input type="text" name="business_name" value="${h(prefill.business_name||'')}" class="input" placeholder="Paws & Co.">
          <label>Contact name</label>
          <input type="text" name="contact_name" value="${h(prefill.contact_name||'')}" class="input">
          <label>Phone</label>
          <input type="tel" name="phone" value="${h(prefill.phone||'')}" class="input">
          <label>Website</label>
          <input type="url" name="website" value="${h(prefill.website||'')}" class="input" placeholder="https://…">
          <label>Business type</label>
          <select name="business_type" class="input">
            <option value="">— select —</option>
            ${['boutique','trainer','kennel','show-vendor','groomer','other'].map(t =>
              `<option value="${t}"${prefill.business_type===t?' selected':''}>${h(t)}</option>`
            ).join('')}
          </select>
          <label>Est. monthly volume ($)</label>
          <input type="number" name="estimated_monthly_volume_usd" value="${h(String(prefill.estimated_monthly_volume_usd||''))}" class="input" min="0" step="100">
          <label>Source</label>
          <select name="source" class="input">
            <option value="">— select —</option>
            ${['tradeshow','website-form','instagram','referral','cold-outreach','other'].map(s =>
              `<option value="${s}"${prefill.source===s?' selected':''}>${h(s)}</option>`
            ).join('')}
          </select>
          <label>Source detail</label>
          <input type="text" name="source_detail" value="${h(prefill.source_detail||'')}" class="input" placeholder="IKC 2026, @petboutique referred…">
          <label>Follow-up date</label>
          <input type="date" name="next_followup_due" value="${h(prefill.next_followup_due||'')}" class="input">
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:0.75rem">
          <button type="submit" class="btn btn-primary">Create Lead</button>
          <a href="/leads" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
  ` });
}

// WHAT: renders one lead — merged notes+status-history timeline (sorted by ts), a status-change form (options from LEAD_TRANSITIONS), an add-note form, a profile panel, and a follow-up editor; shows Convert button only when status==='approved'.
// CHANGE-GUARD: timeline sort is `(a,b)=>a.ts-b.ts` over note.created_at and history.changed_at — both MUST be numeric epoch ms or the subtraction sorts wrongly (string timestamps would NaN-sort); transition <select> is built from LEAD_TRANSITIONS[lead.status].
// INVARIANT(S): note bodies, author emails, websites and all lead fields are h()-escaped; the Convert link/button is gated on 'approved' here AND server-side in /leads/:id/convert (defense in depth).
function renderLeadDetail(session, { lead, notes, history, flash }) {
  const st = LEAD_STATUSES[lead.status] || { label: lead.status, color: 'muted' };
  const transitions = LEAD_TRANSITIONS[lead.status] || [];
  const flashHtml = flash ? `<div class="alert alert-success">${h(flash)}</div>` : '';

  // Merge notes + history into a single timeline, sorted by created_at
  const timeline = [
    ...notes.map(n => ({ ts: n.created_at, type: 'note', data: n })),
    ...history.map(h2 => ({ ts: h2.changed_at, type: 'status', data: h2 })),
  ].sort((a, b) => a.ts - b.ts);

  const timelineHtml = timeline.length === 0
    ? '<p class="text-muted small-text">No activity yet.</p>'
    : timeline.map(item => {
        if (item.type === 'note') {
          const n = item.data;
          const noteColor = { call:'blue', email:'green', meeting:'lime', system:'muted', general:'' }[n.note_type] || '';
          return `<div class="timeline-item">
            <div class="timeline-meta"><span class="badge badge-${noteColor} badge-xs">${h(n.note_type)}</span> <span class="text-muted small-text">${h(n.author_email)} · ${fmtDate(new Date(n.created_at).toISOString())}</span></div>
            <div class="timeline-body">${h(n.body)}</div>
          </div>`;
        } else {
          const s = item.data;
          const newSt = LEAD_STATUSES[s.to_status] || { label: s.to_status, color: 'muted' };
          return `<div class="timeline-item timeline-status">
            <div class="timeline-meta"><span class="text-muted small-text">Status changed by ${h(s.changed_by || '—')} · ${fmtDate(new Date(s.changed_at).toISOString())}</span></div>
            <div class="timeline-body">${s.from_status ? `<span class="badge badge-muted badge-xs">${h(LEAD_STATUSES[s.from_status]?.label || s.from_status)}</span> → ` : ''}<span class="badge badge-${newSt.color} badge-xs">${h(newSt.label)}</span>${s.note ? ` — ${h(s.note)}` : ''}</div>
          </div>`;
        }
      }).join('');

  const transitionOpts = transitions.map(t => {
    const ts2 = LEAD_STATUSES[t] || { label: t };
    return `<option value="${h(t)}">${h(ts2.label)}</option>`;
  }).join('');

  const convertBtn = lead.status === 'approved'
    ? `<a href="/leads/${lead.id}/convert" class="btn btn-primary">Convert to Customer</a>`
    : '';

  // WHAT: address completeness display (B2B-1/B2B-2, HANDOFF-2026-08-11). "Complete" here means
  //   enough to actually ship to: a street line, a city, and a postal code, PLUS a country (never
  //   assumed — see validateLeadInput). Anything short of that reads as "Address incomplete" so
  //   staff can see at a glance that a lead like Hydref K-9 (street only) still needs follow-up.
  const hasAnyAddressField = [lead.address1, lead.address2, lead.city, lead.state, lead.postal_code, lead.country_code].some(Boolean);
  const addressComplete = !!(lead.address1 && lead.city && lead.postal_code && lead.country_code);
  const countryName = lead.country_code ? (VALID_LEAD_COUNTRY_CODES.get(lead.country_code) || lead.country_code) : '';
  const addressLines = [lead.address1, lead.address2].filter(Boolean).map(l => h(l)).join('<br>');
  const cityStateZip = [lead.city, lead.state].filter(Boolean).join(', ') + (lead.postal_code ? ' ' + lead.postal_code : '');
  const addressHtml = !hasAnyAddressField
    ? `<div class="kv-row"><span>Address</span><strong class="text-muted">Not on file</strong></div>`
    : `<div class="kv-row" style="align-items:flex-start"><span>Address</span><strong>
        ${addressLines ? addressLines + '<br>' : ''}${h(cityStateZip.trim())}${cityStateZip.trim() ? '<br>' : ''}${h(countryName)}
        ${!addressComplete ? '<br><span class="badge badge-orange badge-xs" style="margin-top:0.25rem;display:inline-block">⚠ Address incomplete</span>' : ''}
      </strong></div>`;

  // WHAT: renders the wholesale application as the applicant submitted it.
  // WHY: everything the portal collects that has no first-class column here lives in
  //   application_data_json — a column that, before this, was written by nothing and rendered by
  //   nothing. An ingested application would have been invisible on the page, which is precisely
  //   the failure this whole feature exists to fix.
  // CHANGE-GUARD: every value goes through h(). These are UNAUTHENTICATED public-form fields and
  //   are the classic stored-XSS sink in this file. The exemption document is linked through our
  //   own proxy route — never a portal URL and never an on-disk path.
  let application = null;
  try { application = lead.application_data_json ? JSON.parse(lead.application_data_json) : null; }
  catch (_) { application = null; }
  const appRow = (label, value) => (value
    ? `<div class="kv-row"><span>${h(label)}</span><strong>${h(String(value))}</strong></div>` : '');
  const applicationHtml = !(application || lead.fein) ? '' : `<div class="card">
          <div class="card-header"><h2>Wholesale Application</h2></div>
          <div class="kv-list">
            ${appRow('FEIN', lead.fein)}
            ${appRow('Resale tax ID', lead.sales_tax_id)}
            ${appRow('Mailing address', application && application.address)}
            ${appRow('Products of interest', application && application.products)}
            ${application && application.submittedAt ? `<div class="kv-row"><span>Submitted</span><strong class="text-muted">${fmtDate(new Date(application.submittedAt).toISOString())}</strong></div>` : ''}
            <div class="kv-row"><span>Sales tax exemption</span><strong>${
              application && application.hasTaxExemptDoc
                ? `<a href="/leads/${lead.id}/tax-doc" target="_blank" rel="noopener noreferrer" class="link">View document →</a>`
                : '<span class="text-muted">Not provided</span>'
            }</strong></div>
          </div>
          ${application && application.notes ? `<div style="margin-top:0.75rem">
            <div class="field-label">About the business</div>
            <div style="white-space:pre-wrap">${h(application.notes)}</div>
          </div>` : ''}
        </div>`;

  return layout({ title: (lead.business_name || lead.email) + ' — Lead', session, activePath: '/leads',
    extraHead: `<style>
      .timeline-item{padding:0.6rem 0;border-bottom:1px solid #f0f0f0;}
      .timeline-item:last-child{border-bottom:none;}
      .timeline-meta{margin-bottom:0.2rem;}
      .timeline-status .timeline-body{font-size:0.85rem;}
      .badge-xs{font-size:0.7rem;padding:0.15rem 0.4rem;}
      .badge-lime{background:#9BBC0E;color:#fff;}
      .badge-orange{background:#F97316;color:#fff;}
    </style>`,
    content: `
    <div class="breadcrumb-row"><a href="/leads" class="breadcrumb">← Leads</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(lead.business_name || lead.email)}</h1>
        <p class="text-muted">${h(lead.contact_name || '')}${lead.contact_name && lead.email ? ' · ' : ''}${h(lead.email)} <span class="badge badge-${st.color}" style="margin-left:0.5rem">${h(st.label)}</span></p>
      </div>
      <div class="detail-header-actions">
        <a href="/leads/${lead.id}/edit" class="btn btn-secondary">Edit</a>
        ${convertBtn}
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-main">
        <!-- Status change -->
        ${transitions.length > 0 ? `<div class="card">
          <div class="card-header"><h2>Change Status</h2></div>
          <form method="POST" action="/leads/${lead.id}/status" style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
            <div>
              <label class="field-label">New status</label>
              <select name="new_status" class="input input-sm">${transitionOpts}</select>
            </div>
            <div style="flex:1;min-width:160px">
              <label class="field-label">Note (optional)</label>
              <input type="text" name="note" class="input input-sm" placeholder="Reason or context…">
            </div>
            <button type="submit" class="btn btn-secondary btn-sm">Update</button>
          </form>
        </div>` : ''}

        ${applicationHtml}

        <!-- Timeline -->
        <div class="card">
          <div class="card-header"><h2>Activity</h2></div>
          <div id="timeline">${timelineHtml}</div>
        </div>

        <!-- Add note -->
        <div class="card">
          <div class="card-header"><h2>Add Note</h2></div>
          <form method="POST" action="/leads/${lead.id}/note">
            <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center">
              <label class="field-label" style="margin:0">Type:</label>
              <select name="note_type" class="input input-sm" style="width:auto">
                ${['general','call','email','meeting'].map(t => `<option value="${t}">${h(t)}</option>`).join('')}
              </select>
            </div>
            <textarea name="body" class="textarea" rows="3" placeholder="Note about this lead…" required></textarea>
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Add Note</button></div>
          </form>
        </div>
      </div>
      <div class="detail-side">
        <div class="card">
          <div class="card-header"><h2>Profile</h2></div>
          <form method="POST" action="/leads/${lead.id}/profile">
            <div class="kv-list">
              <div class="kv-row"><span>Email</span><strong><a href="mailto:${h(lead.email)}" class="link">${h(lead.email)}</a></strong></div>
              ${lead.phone ? `<div class="kv-row"><span>Phone</span><strong>${h(lead.phone)}</strong></div>` : ''}
              ${lead.website ? `<div class="kv-row"><span>Website</span><strong><a href="${h(safeUrl(lead.website))}" target="_blank" rel="noopener noreferrer" class="link">${h(lead.website)}</a></strong></div>` : ''}
              ${lead.business_type ? `<div class="kv-row"><span>Type</span><strong>${h(lead.business_type)}</strong></div>` : ''}
              ${lead.source ? `<div class="kv-row"><span>Source</span><strong>${h(lead.source)}${lead.source_detail ? ' — ' + h(lead.source_detail) : ''}</strong></div>` : ''}
              ${lead.estimated_monthly_volume_usd ? `<div class="kv-row"><span>Est. volume</span><strong>${fmtMoney(lead.estimated_monthly_volume_usd)}/mo</strong></div>` : ''}
              ${addressHtml}
              ${lead.sales_tax_id ? `<div class="kv-row"><span>Resale tax ID</span><strong>${h(lead.sales_tax_id)}${lead.sales_tax_state ? ` (${h(lead.sales_tax_state)})` : ''}</strong></div>` : ''}
              ${lead.fein ? `<div class="kv-row"><span>FEIN</span><strong>${h(lead.fein)}</strong></div>` : ''}
              <div class="kv-row"><span>Created</span><strong class="text-muted">${fmtDate(new Date(lead.created_at).toISOString())}</strong></div>
            </div>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><h2>Follow-up</h2></div>
          <form method="POST" action="/leads/${lead.id}/followup" style="display:flex;gap:0.5rem;align-items:center">
            <input type="date" name="next_followup_due" value="${h(lead.next_followup_due||'')}" class="input input-sm" style="flex:1">
            <button type="submit" class="btn btn-secondary btn-sm">Save</button>
          </form>
          ${lead.next_followup_due && lead.next_followup_due < new Date().toISOString().split('T')[0]
            ? `<p class="text-danger small-text" style="margin-top:0.35rem">⚠ Overdue</p>` : ''}
        </div>
        ${lead.shopify_customer_id ? `<div class="card"><div class="card-header"><h2>Customer</h2></div>
          <p><a href="/customers/${lead.shopify_customer_id.split('/').pop()}" class="link">View customer →</a></p>
        </div>` : ''}
      </div>
    </div>
  ` });
}

// WHAT: renders GET/POST /leads/:id/edit — contact + address + tax field editor (B2B-1/B2B-2,
//   HANDOFF-2026-08-11). `lead` is the source of truth on GET; on a validation/UNIQUE failure the
//   POST handler passes { ...lead, ...req.body } so the form re-shows what the user just typed
//   rather than snapping back to the stored values.
// CHANGE-GUARD: field names here are consumed verbatim by POST /leads/:id/edit — renaming a field
//   here without updating the handler silently drops that field from every save. country_code
//   is a <select> populated from VALID_LEAD_COUNTRY_CODES, never a free-text input (see that
//   const's comment — order #38656 shipped to NZ marked "United States" from a free-text/defaulted
//   country field in a different app).
// INVARIANT(S): every dynamic value is h()-escaped; email is required, everything else optional.
function renderLeadEdit(session, { lead, flash }) {
  const flashHtml = flash ? `<div class="alert alert-danger">${h(flash)}</div>` : '';
  return layout({ title: 'Edit Lead', session, activePath: '/leads', content: `
    <div class="breadcrumb-row"><a href="/leads/${lead.id}" class="breadcrumb">← ${h(lead.business_name || lead.email)}</a></div>
    <div class="page-header-row"><h1>Edit Lead</h1></div>
    ${flashHtml}
    <div class="card" style="max-width:640px">
      <form method="POST" action="/leads/${lead.id}/edit">
        <div class="settings-grid">
          <label>Email *</label>
          <input type="email" name="email" value="${h(lead.email||'')}" required class="input">
          <label>Business name</label>
          <input type="text" name="business_name" value="${h(lead.business_name||'')}" class="input">
          <label>Contact name</label>
          <input type="text" name="contact_name" value="${h(lead.contact_name||'')}" class="input">
          <label>Phone</label>
          <input type="tel" name="phone" value="${h(lead.phone||'')}" class="input">
          <label>Website</label>
          <input type="url" name="website" value="${h(lead.website||'')}" class="input" placeholder="https://…">
          <label>Business type</label>
          <select name="business_type" class="input">
            <option value="">— select —</option>
            ${['boutique','trainer','kennel','show-vendor','groomer','other'].map(t =>
              `<option value="${t}"${lead.business_type===t?' selected':''}>${h(t)}</option>`
            ).join('')}
          </select>
        </div>

        <h2 style="margin-top:1.5rem;font-size:0.95rem">Address</h2>
        <p class="text-muted small-text" style="margin:0 0 0.5rem">A street address with no city/state/zip yet is fine — it will show as incomplete until filled in.</p>
        <div class="settings-grid">
          <label>Address line 1</label>
          <input type="text" name="address1" value="${h(lead.address1||'')}" class="input">
          <label>Address line 2</label>
          <input type="text" name="address2" value="${h(lead.address2||'')}" class="input">
          <label>City</label>
          <input type="text" name="city" value="${h(lead.city||'')}" class="input">
          <label>State / province</label>
          <input type="text" name="state" value="${h(lead.state||'')}" class="input" placeholder="TX">
          <label>Postal code</label>
          <input type="text" name="postal_code" value="${h(lead.postal_code||'')}" class="input">
          <label>Country</label>
          <select name="country_code" class="input">${countryOptions(lead.country_code)}</select>
        </div>

        <h2 style="margin-top:1.5rem;font-size:0.95rem">Tax</h2>
        <p class="text-muted small-text" style="margin:0 0 0.5rem">Two different IDs — the state resale number and the federal EIN. Some applications label the FEIN as a "Resale Tax ID" by mistake; check the number's shape before filing it.</p>
        <div class="settings-grid">
          <label>Resale tax ID</label>
          <input type="text" name="sales_tax_id" value="${h(lead.sales_tax_id||'')}" class="input">
          <label>Tax-registration state</label>
          <input type="text" name="sales_tax_state" value="${h(lead.sales_tax_state||'')}" class="input" placeholder="TX">
          <label>FEIN</label>
          <input type="text" name="fein" value="${h(lead.fein||'')}" class="input" placeholder="12-3456789">
        </div>

        <div style="margin-top:1.25rem;display:flex;gap:0.75rem">
          <button type="submit" class="btn btn-primary">Save Changes</button>
          <a href="/leads/${lead.id}" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
  ` });
}

// WHAT: renders the lead->Shopify-customer conversion form, defaulting discount % to settings.b2b_discount_pct (or 50).
// CHANGE-GUARD: field names (display_name, email, discount_pct, allow_order_on_invoice, dropship_enabled) are consumed verbatim by POST /leads/:id/convert; checkbox values arrive as 'on' there, so renaming a field breaks the metafield write.
// INVARIANT(S): display_name and email are required; discount_pct is bounded 0..95 in the input but the server should still validate.
function renderLeadConvert(session, { lead, flash, settings }) {
  const discountDefault = settings.b2b_discount_pct || '50';
  const flashHtml = flash ? `<div class="alert alert-danger">${h(flash)}</div>` : '';
  return layout({ title: 'Convert Lead to Customer', session, activePath: '/leads', content: `
    <div class="breadcrumb-row"><a href="/leads/${lead.id}" class="breadcrumb">← ${h(lead.business_name || lead.email)}</a></div>
    <div class="page-header-row"><h1>Convert to B2B Customer</h1></div>
    ${flashHtml}
    <div class="card" style="max-width:640px">
      <p class="text-muted" style="margin-bottom:1rem">This will create a Shopify customer with the <strong>b2b</strong> tag and configure their B2B settings. The lead will be marked as converted.</p>
      <form method="POST" action="/leads/${lead.id}/convert">
        <div class="settings-grid">
          <label>Display name *</label>
          <input type="text" name="display_name" value="${h(lead.contact_name || lead.business_name || '')}" required class="input">
          <label>Email *</label>
          <input type="email" name="email" value="${h(lead.email)}" required class="input">
          <label>Phone</label>
          <input type="tel" name="phone" value="${h(lead.phone||'')}" class="input">
          <label>B2B discount %</label>
          <input type="number" name="discount_pct" value="${h(discountDefault)}" min="0" max="95" class="input" style="width:100px">
          <label>Allow order on invoice</label>
          <label class="toggle-label"><input type="checkbox" name="allow_order_on_invoice" class="toggle" checked></label>
          <label>Drop-ship allowed</label>
          <label class="toggle-label"><input type="checkbox" name="dropship_enabled" class="toggle"></label>
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:0.75rem">
          <button type="submit" class="btn btn-primary">Convert to Customer</button>
          <a href="/leads/${lead.id}" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
  ` });
}

// Leads routes
// WHAT: GET /leads — lead index with optional ?status filter and ?q free-text search; computes per-status counts.
// CHANGE-GUARD: status='all' is normalized to null before getLeads(); q is trimmed and passed as search||undefined; flash maps ?flash=created|saved to messages — add new flash codes in both this map and the writers.
// INVARIANT(S): read-only; getLeads/getLeadCounts back the table and chips.
app.get('/leads', requireAuth, (req, res) => {
  // Pull anything new off the portal's public application form before rendering, so a wholesale
  // application submitted on fuzzywumpets.com shows up here without any manual step.
  syncPortalWholesaleLeads();
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const q      = String(req.query.q || '').trim();
  const leads  = getLeads({ status, search: q || undefined });
  const counts = getLeadCounts();
  const flash  = req.query.flash === 'created' ? 'Lead created.' : req.query.flash === 'saved' ? 'Lead updated.' : null;
  res.send(renderLeadsList(req.adminSession, { leads, counts, flash, q, status: req.query.status || 'all' }));
});

// WHAT: GET /leads/new — renders the empty New Lead form.
// CHANGE-GUARD: pure render; the matching POST does the validation.
// INVARIANT(S): requireAuth-gated like all lead routes.
app.get('/leads/new', requireAuth, (req, res) => {
  res.send(renderLeadNew(req.adminSession, { flash: null }));
});

// WHAT: POST /leads/new — creates a lead from the whole req.body, seeds status history as null->'new', and redirects to the detail page.
// CHANGE-GUARD: createLead(req.body) trusts the entire body object — it must whitelist columns internally; the catch maps a UNIQUE-constraint error to a friendly 'email already exists' message, so changing the email unique index changes this UX.
// INVARIANT(S): validated by the shared validateLeadInput() (D5, HANDOFF-2026-08-11) before any
//   write — same rules as POST /leads/:id/edit; a created lead always gets exactly one initial
//   status-history row and an auditLog lead:create.
app.post('/leads/new', requireAuth, (req, res) => {
  const err = validateLeadInput(req.body);
  if (err) return res.send(renderLeadNew(req.adminSession, { flash: err, prefill: req.body }));
  try {
    const id = createLead(req.body);
    addLeadStatusHistory(id, null, 'new', 'Lead created', req.adminSession.email);
    auditLog(req.adminSession.email, 'lead:create', String(id), null, { email: String(req.body.email || '').trim() });
    res.redirect('/leads/' + id + '?flash=created');
  } catch (err) {
    const msg = err.message.includes('UNIQUE') ? 'A lead with that email already exists.' : err.message;
    res.send(renderLeadNew(req.adminSession, { flash: msg, prefill: req.body }));
  }
});

// WHAT: GET /leads/:id — lead detail with notes + status history; 404s with a styled page when the id is unknown.
// CHANGE-GUARD: :id is passed straight to getLead (must be parameterized in the DB layer to avoid injection); flash codes created|saved|status_changed map to messages here.
// INVARIANT(S): read-only; notes and history are loaded by lead.id (the canonical id from getLead, not the raw param).
app.get('/leads/:id', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/leads',
    content: '<h1>Lead not found</h1><a href="/leads" class="btn btn-secondary">← Leads</a>' }));
  const notes   = getLeadNotes(lead.id);
  const history = getLeadStatusHistory(lead.id);
  const flash   = req.query.flash === 'created' ? 'Lead created.' : req.query.flash === 'saved' ? 'Saved.' : req.query.flash === 'status_changed' ? 'Status updated.' : null;
  res.send(renderLeadDetail(req.adminSession, { lead, notes, history, flash }));
});

// WHAT: GET /leads/:id/edit — renders the contact/address/tax editor, pre-filled from the lead.
// CHANGE-GUARD: pure render; the matching POST does the validation and write.
// INVARIANT(S): 404s (redirect to /leads) when the lead is unknown.
app.get('/leads/:id/edit', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  res.send(renderLeadEdit(req.adminSession, { lead, flash: null }));
});

// WHAT: POST /leads/:id/edit — validates via the shared validateLeadInput() (same rules as
//   POST /leads/new, D5 HANDOFF-2026-08-11), then writes through updateLead()'s allow-list.
// CHANGE-GUARD: `email` is UNIQUE on `leads` — changing it to one that collides with another lead
//   must show a clean flash message here, never a 500 (mirrors the /leads/new duplicate-email UX).
//   Every field written here must be present in updateLead()'s `allowed` array (db.mjs) or it
//   silently no-ops — this exact trap is why sales_tax_id/sales_tax_state/fein were unwritable
//   before this branch (see HANDOFF-2026-08-11 "Verified starting facts" #3).
// INVARIANT(S): on any rejection (validation or UNIQUE collision) the form re-renders with the
//   submitted values (not the stale stored ones) so nothing the user typed is lost.
app.post('/leads/:id/edit', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');

  const err = validateLeadInput(req.body);
  if (err) return res.send(renderLeadEdit(req.adminSession, { lead: { ...lead, ...req.body }, flash: err }));

  const fields = {
    email: String(req.body.email || '').trim(),
    business_name: req.body.business_name || null,
    contact_name: req.body.contact_name || null,
    phone: req.body.phone || null,
    website: req.body.website || null,
    business_type: req.body.business_type || null,
    address1: req.body.address1 || null,
    address2: req.body.address2 || null,
    city: req.body.city || null,
    state: req.body.state || null,
    postal_code: req.body.postal_code || null,
    country_code: String(req.body.country_code || '').trim().toUpperCase() || null,
    sales_tax_id: req.body.sales_tax_id || null,
    sales_tax_state: req.body.sales_tax_state || null,
    fein: req.body.fein || null,
  };
  try {
    updateLead(lead.id, fields);
    auditLog(req.adminSession.email, 'lead:edit', String(lead.id), null, fields);
    res.redirect('/leads/' + lead.id + '?flash=saved');
  } catch (writeErr) {
    const msg = writeErr.message.includes('UNIQUE') ? 'A lead with that email already exists.' : writeErr.message;
    res.send(renderLeadEdit(req.adminSession, { lead: { ...lead, ...req.body }, flash: msg }));
  }
});

// WHAT: GET /leads/:id/tax-doc — streams the applicant's optional sales-tax-exemption PDF by
//   proxying the portal's bearer-gated /__internal__/leads/:id/tax-doc.
// WHY: the file lives on the portal's filesystem and this process has no session there. Proxying
//   (rather than reading the path out of the portal db and opening it directly) keeps the
//   filesystem layout entirely on the portal's side and avoids a path-traversal surface here.
// CHANGE-GUARD: requireAuth-gated like every other lead route — this is applicant tax paperwork and
//   must never be publicly reachable. The PORTAL lead id is used, not this table's id; they are
//   different numbers and swapping them serves the wrong applicant's document. callPortalInternal is
//   deliberately NOT used: it parses the response as JSON and would corrupt a PDF body.
// INVARIANT(S): 404s when the lead is unknown, was never ingested from the portal, or the portal
//   has no document for it; never echoes an applicant-supplied filename.
app.get('/leads/:id/tax-doc', requireAuth, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || !lead.portal_lead_id) return res.status(404).send('Not found');
  if (!PORTAL_INTERNAL_TOKEN) return res.status(503).send('Portal link not configured');
  try {
    const r = await fetch(`${PORTAL_INTERNAL_URL}/__internal__/leads/${lead.portal_lead_id}/tax-doc`, {
      headers: { Authorization: `Bearer ${PORTAL_INTERNAL_TOKEN}` },
    });
    if (!r.ok) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="lead-${lead.id}-tax-exemption.pdf"`);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (_) {
    res.status(502).send('Could not reach the portal');
  }
});

// WHAT: POST /leads/:id/status — transitions a lead, recording status history, a system note, and an audit entry.
// CHANGE-GUARD: this is a read-modify-write (getLead then updateLead) with NO transaction/lock (see bugs[]) — two concurrent status changes can interleave and the audit `from` may not match the actual prior state; the transition is validated against LEAD_TRANSITIONS[lead.status] and rejected with flash=invalid_status if illegal.
// INVARIANT(S): an illegal transition makes zero writes; a legal one writes history + a 'system' note + updateLead atomically-enough only if the DB serializes them; every change is auditLog'd lead:status with from/to.
app.post('/leads/:id/status', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  const newStatus = req.body.new_status;
  const allowed = LEAD_TRANSITIONS[lead.status] || [];
  if (!allowed.includes(newStatus)) return res.redirect('/leads/' + lead.id + '?flash=invalid_status');
  const note = String(req.body.note || '').trim();
  addLeadStatusHistory(lead.id, lead.status, newStatus, note || null, req.adminSession.email);
  addLeadNote(lead.id, req.adminSession.email, `Status changed to ${LEAD_STATUSES[newStatus]?.label || newStatus}${note ? ': ' + note : ''}`, 'system');
  updateLead(lead.id, { status: newStatus });
  auditLog(req.adminSession.email, 'lead:status', String(lead.id), lead.status, newStatus);
  res.redirect('/leads/' + lead.id + '?flash=status_changed');
});

// WHAT: POST /leads/:id/note — appends a free-text note (type general|call|email|meeting) to a lead's timeline.
// CHANGE-GUARD: note_type is whitelisted against the 4 allowed values (defaults to 'general'); the updateLead(lead.id,{status:lead.status}) no-op call exists only to bump updated_at — don't remove it if list ordering depends on last-activity.
// INVARIANT(S): empty body is rejected (redirect, no write); author is req.adminSession.email.
app.post('/leads/:id/note', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  const body = String(req.body.body || '').trim();
  if (!body) return res.redirect('/leads/' + lead.id);
  const noteType = ['general','call','email','meeting'].includes(req.body.note_type) ? req.body.note_type : 'general';
  addLeadNote(lead.id, req.adminSession.email, body, noteType);
  updateLead(lead.id, { status: lead.status });
  res.redirect('/leads/' + lead.id + '?flash=saved');
});

// WHAT: POST /leads/:id/followup — sets or clears the next_followup_due date.
// CHANGE-GUARD: an empty date stores null (clears the follow-up); the value is YYYY-MM-DD compared lexicographically elsewhere to flag overdue — keep that format.
// INVARIANT(S): unknown lead id redirects to /leads with no write.
app.post('/leads/:id/followup', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  const date = String(req.body.next_followup_due || '').trim();
  updateLead(lead.id, { next_followup_due: date || null });
  res.redirect('/leads/' + lead.id + '?flash=saved');
});

// WHAT: GET /leads/:id/convert — renders the conversion form, but ONLY for leads in status 'approved' (otherwise redirects back).
// CHANGE-GUARD: the 'approved' gate is enforced here and again in the POST; both must stay aligned with LEAD_TRANSITIONS (only 'approved' transitions to 'converted').
// INVARIANT(S): settings come from getGlobalSettings() to seed the default discount; read-only.
app.get('/leads/:id/convert', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  if (lead.status !== 'approved') return res.redirect('/leads/' + lead.id);
  res.send(renderLeadConvert(req.adminSession, { lead, flash: null, settings: getGlobalSettings() }));
});

// WHAT: POST /leads/:id/convert — creates a Shopify customer with the `b2b` tag + 3 b2b metafields (discount_pct, allow_order_on_invoice, dropship_enabled), fires a non-blocking Xero contact sync, then marks the lead converted.
// CHANGE-GUARD: re-asserts status==='approved' server-side; metafields are written in a SEPARATE shopifyFetch AFTER customerCreate, so a failure there leaves a customer with the tag but no/partial metafields and the lead still gets marked converted — no rollback (see bugs[]); checkbox flags arrive as 'on'. MOCK fabricates a gid://shopify/Customer/MOCK_<leadId>.
// INVARIANT(S): customerCreate userErrors short-circuit back to the form (no lead mutation); on success the lead is set status:'converted' + converted_at + shopify_customer_id, status-history and a system note are added, and auditLog lead:convert fires; the Xero sync is .catch'd so its failure never blocks the redirect.
app.post('/leads/:id/convert', requireAuth, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  if (lead.status !== 'approved') return res.redirect('/leads/' + lead.id);

  const email   = String(req.body.email || lead.email).trim();
  const name    = String(req.body.display_name || '').trim();
  const phone   = String(req.body.phone || '').trim();
  const discPct = parseInt(req.body.discount_pct || '50', 10);
  const allowInv = req.body.allow_order_on_invoice === 'on';
  const dropship = req.body.dropship_enabled === 'on';

  let shopifyCustomerId = null;

  if (!MOCK) {
    try {
      // Create Shopify customer with b2b tag
      const createResult = await shopifyFetch(`
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }`, {
        input: {
          email, firstName: name.split(' ')[0] || name, lastName: name.split(' ').slice(1).join(' ') || '',
          phone: phone || undefined,
          tags: ['b2b'],
          emailMarketingConsent: { marketingState: 'NOT_SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN' },
        }
      });
      const errors = createResult.data?.customerCreate?.userErrors || [];
      if (errors.length > 0) {
        return res.send(renderLeadConvert(req.adminSession, { lead, flash: errors[0].message, settings: getGlobalSettings() }));
      }
      shopifyCustomerId = createResult.data?.customerCreate?.customer?.id;

      // Set B2B metafields
      if (shopifyCustomerId) {
        const metafields = [
          { ownerId: shopifyCustomerId, namespace: 'b2b', key: 'discount_pct',           value: String(discPct), type: 'number_integer' },
          { ownerId: shopifyCustomerId, namespace: 'b2b', key: 'allow_order_on_invoice',  value: String(allowInv), type: 'boolean' },
          { ownerId: shopifyCustomerId, namespace: 'b2b', key: 'dropship_enabled',        value: String(dropship), type: 'boolean' },
        ];
        await shopifyFetch(`mutation metafieldsSet($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{field message} } }`, { m: metafields });
      }
    } catch (err) {
      return res.send(renderLeadConvert(req.adminSession, { lead, flash: 'Shopify error: ' + err.message, settings: getGlobalSettings() }));
    }
  } else {
    shopifyCustomerId = 'gid://shopify/Customer/MOCK_' + lead.id;
  }

  // Phase 21C: sync new B2B customer to Xero (non-blocking)
  const numIdForXero = shopifyCustomerId ? shopifyCustomerId.split('/').pop() : null;
  if (numIdForXero) {
    // [XERO-DISABLED] dryRun when writes off — see xeroRequest backstop note.
    syncCustomerToXero(numIdForXero, {
      email: email, firstName: name.split(' ')[0] || name,
      lastName: name.split(' ').slice(1).join(' ') || '',
      displayName: name,
    }, xeroRequest, { dryRun: MOCK || !XERO_WRITES_ENABLED }).then(r => {
      if (r.created) auditLog(req.adminSession.email, 'xero:customer_sync', shopifyCustomerId, null, { xeroContactId: r.xeroContactId, via: 'lead_convert' });
    }).catch(e => console.error('[xero-sync] lead convert sync failed:', e.message));
  }

  updateLead(lead.id, { status: 'converted', converted_at: Date.now(), shopify_customer_id: shopifyCustomerId });
  addLeadStatusHistory(lead.id, 'approved', 'converted', 'Customer created', req.adminSession.email);
  addLeadNote(lead.id, req.adminSession.email, 'Converted to Shopify customer ' + shopifyCustomerId, 'system');
  auditLog(req.adminSession.email, 'lead:convert', String(lead.id), { status: 'approved' }, { status: 'converted', shopifyCustomerId });

  const numId = shopifyCustomerId ? shopifyCustomerId.split('/').pop() : null;
  if (numId) return res.redirect('/customers/' + numId);
  res.redirect('/leads/' + lead.id);
});

// ── Xero accounting routes ────────────────────────────────────────────────────

// WHAT: renders the Xero account-code mapping form (sales/AR/checking/stripe/fees/discounts/terms) plus a connection-test panel; warns when retries are pending.
// CHANGE-GUARD: the `field()` keys MUST match the setting keys read/written as 'xero_'+f in POST /settings/xero and getXeroAccountMap(); the inline testXeroConnection() script POSTs /api/admin/xero/test and expects {ok,accounts,error}.
// INVARIANT(S): account-map values render via accountMap[key] (defaults applied in getXeroAccountMap); XERO_BEARER presence drives the Configured/Not-configured badge only (not actual connectivity).
function renderXeroSettings(session, flash) {
  const accountMap = getXeroAccountMap();
  const flashHtml  = flash ? `<div class="alert ${flash.ok ? 'alert-success' : 'alert-error'}" style="margin-bottom:1rem">${h(flash.msg)}</div>` : '';
  const field = (key, label, help = '') => `
    <div class="settings-field">
      <label class="settings-label">${h(label)}</label>
      <input type="text" name="${key}" value="${h(accountMap[key])}" class="filter-input" style="width:160px">
      ${help ? `<span class="text-muted" style="font-size:12px;margin-left:8px">${h(help)}</span>` : ''}
    </div>`;
  const pendingCount = getXeroPendingCount();
  return layout({ title: 'Xero Settings', session, activePath: '/settings', content: `
    <div class="page-header">
      <h1>Xero Integration Settings</h1>
      <a href="/settings" class="btn btn-ghost btn-sm">← Back to Settings</a>
    </div>
    ${flashHtml}
    ${pendingCount > 0 ? `<div class="alert alert-warning" style="margin-bottom:1rem">⚠ ${pendingCount} Xero action(s) pending retry. <a href="/accounting" class="link">View in Accounting →</a></div>` : ''}
    <div class="card" style="max-width:640px">
      <div class="card-header"><h2>Account Code Mapping</h2></div>
      <p class="text-muted" style="margin-bottom:1rem;font-size:13px">Map FWW concepts to your Xero account codes. These are the numeric codes from your chart of accounts (e.g., "200" for Sales).</p>
      <form method="POST" action="/settings/xero">
        <div class="settings-grid" style="gap:12px">
          ${field('sales_revenue',       'Sales Revenue',           'Default: 200')}
          ${field('accounts_receivable', 'Accounts Receivable (A/R)', 'Default: 610')}
          ${field('chase_checking',      'Chase Business Checking', 'Default: 1110')}
          ${field('stripe_clearing',     'Stripe Clearing',         'Default: 1120')}
          ${field('processing_fees',     'Payment Processing Fees', 'Default: 6100')}
          ${field('discounts',           'Discounts Given',         'Default: 400')}
          ${field('payment_terms_days',  'Default Payment Terms (days)', 'Default: 30 (NET 30)')}
        </div>
        <div style="margin-top:1.5rem;display:flex;gap:8px">
          <button type="submit" class="btn btn-primary">Save account mapping</button>
          <a href="/accounting" class="btn btn-ghost">View reconciliation →</a>
        </div>
      </form>
    </div>
    <div class="card" style="max-width:640px;margin-top:1rem">
      <div class="card-header"><h2>Connection</h2></div>
      <p class="text-muted" style="font-size:13px">Bridge: <code>fww-xero-bridge.alex-037.workers.dev</code></p>
      <p class="text-muted" style="font-size:13px">Bearer: ${XERO_BEARER ? '<span class="badge badge-paid">Configured</span>' : '<span class="badge badge-pending">Not configured (XERO_BRIDGE_BEARER)</span>'}</p>
      <div style="margin-top:12px;display:flex;gap:8px">
        <form method="POST" action="/api/admin/xero/test" id="xero-test-form">
          <button type="submit" class="btn btn-secondary btn-sm" onclick="testXeroConnection(event)">Test connection</button>
        </form>
        <span id="xero-test-result" style="font-size:13px;line-height:32px"></span>
      </div>
    </div>
    <script>
    async function testXeroConnection(e) {
      e.preventDefault();
      const el = document.getElementById('xero-test-result');
      el.textContent = 'Testing…';
      try {
        const r = await fetch('/api/admin/xero/test', { method: 'POST' });
        const j = await r.json();
        el.textContent = j.ok ? '✓ Connected — ' + j.accounts + ' accounts found' : '✗ ' + (j.error || 'Failed');
        el.style.color = j.ok ? 'var(--lime)' : 'var(--danger)';
      } catch (err) { el.textContent = '✗ ' + err.message; el.style.color = 'var(--danger)'; }
    }
    </script>
  ` });
}

// WHAT: renders the accounting reconciliation page — the Xero invoice map table and the pending/failed actions queue, with retry-all buttons.
// CHANGE-GUARD: badge status strings ('synced','pending_retry','done','failed') are matched literally — keep them aligned with what getXeroInvoiceMaps/getXeroPending emit; payload_json is JSON.parsed per row (a malformed payload would throw and 500 the whole page).
// INVARIANT(S): error_text is sliced to 60-80 chars and h()-escaped; order links are built from r.order_id (gid form) by .split('/').pop() elsewhere.
function renderAccounting(session, data) {
  const { invoiceMaps, pendingActions, pendingCount } = data;
  const pendingCountBadge = pendingCount > 0 ? `<span class="badge badge-pending">${pendingCount}</span>` : '<span class="badge badge-paid">0</span>';

  const invoiceRows = invoiceMaps.map(r => `<tr>
    <td><span class="mono">${h(r.order_id)}</span></td>
    <td>${r.xero_invoice_id ? `<span class="mono">${h(r.xero_invoice_id)}</span>` : '<span class="text-muted">—</span>'}</td>
    <td><span class="badge badge-${r.status === 'synced' ? 'paid' : r.status === 'pending_retry' ? 'warning' : 'pending'}">${h(r.status)}</span></td>
    <td class="text-muted">${r.synced_at ? fmtDate(new Date(r.synced_at).toISOString()) : '—'}</td>
    <td class="text-sm" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${r.error_text ? h(r.error_text.slice(0,80)) : '—'}</td>
    <td><a href="/orders/${h(r.order_id)}" class="link">View order</a></td>
  </tr>`).join('') || '<tr><td colspan="6" class="text-muted text-center">No orders synced to Xero yet.</td></tr>';

  const pendingRows = pendingActions.map(r => {
    const payload = JSON.parse(r.payload_json || '{}');
    return `<tr>
      <td>${h(r.action_type)}</td>
      <td>${r.retries}</td>
      <td><span class="badge badge-${r.status === 'done' ? 'paid' : r.status === 'failed' ? 'danger' : 'pending'}">${h(r.status)}</span></td>
      <td class="text-muted">${fmtDate(new Date(r.created_at).toISOString())}</td>
      <td class="text-sm" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${r.error_text ? h(r.error_text.slice(0,60)) : '—'}</td>
      <td>${payload.orderId ? `<a href="/orders/${h(payload.orderId)}" class="link">#${h(payload.orderId)}</a>` : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="text-muted text-center">No pending actions.</td></tr>';

  return layout({ title: 'Accounting', session, activePath: '/accounting', content: `
    <div class="page-header">
      <h1>Accounting Reconciliation</h1>
      <div style="display:flex;gap:8px">
        <form method="POST" action="/api/admin/xero/sync">
          <button class="btn btn-primary btn-sm" onclick="this.textContent='Syncing…'">Retry pending actions</button>
        </form>
        <a href="/settings/xero" class="btn btn-ghost btn-sm">Xero settings →</a>
      </div>
    </div>
    <div class="report-stats" style="margin-bottom:1.5rem">
      <div class="stat-card">
        <div class="stat-value">${invoiceMaps.filter(r => r.status === 'synced').length}</div>
        <div class="stat-label">Synced to Xero</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${pendingCountBadge}</div>
        <div class="stat-label">Pending retry</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${invoiceMaps.length}</div>
        <div class="stat-label">Total tracked</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header"><h2>Xero Invoice Map</h2></div>
      <div class="table-wrap">
        <table class="data-table data-table-sm">
          <thead><tr><th>Order ID</th><th>Xero Invoice ID</th><th>Status</th><th>Last Synced</th><th>Error</th><th></th></tr></thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <h2>Pending Actions</h2>
        ${pendingCount > 0 ? `<form method="POST" action="/api/admin/xero/sync" style="display:inline"><button class="btn btn-primary btn-xs">Retry all</button></form>` : ''}
      </div>
      <div class="table-wrap">
        <table class="data-table data-table-sm">
          <thead><tr><th>Action</th><th>Retries</th><th>Status</th><th>Created</th><th>Error</th><th>Order</th></tr></thead>
          <tbody>${pendingRows}</tbody>
        </table>
      </div>
    </div>
  ` });
}

// WHAT: GET /settings/xero — Xero settings page (account-code mapping + connection test).
// CHANGE-GUARD: flash parsed from ?flash=ok|err&msg; pure render otherwise.
// INVARIANT(S): read-only.
app.get('/settings/xero', requireAuth, (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || '' } : null;
  res.send(renderXeroSettings(req.adminSession, flash));
});

// WHAT: POST /settings/xero — persists the 7 Xero account-code fields as settings keyed 'xero_'+field (each trimmed + capped to 20 chars).
// CHANGE-GUARD: the `fields` array is the whitelist — only these keys are written; adding a field requires updating both this array and renderXeroSettings' field() calls and getXeroAccountMap.
// INVARIANT(S): values are global settings (no per-admin scope passed); the whole save is auditLog'd settings:xero with the field map.
app.post('/settings/xero', requireAuth, (req, res) => {
  const fields = ['sales_revenue','accounts_receivable','chase_checking','stripe_clearing','processing_fees','discounts','payment_terms_days'];
  try {
    for (const f of fields) {
      if (req.body[f] !== undefined) setSetting('xero_' + f, String(req.body[f]).trim().slice(0, 20));
    }
    auditLog(req.adminSession.email, 'settings:xero', null, null, Object.fromEntries(fields.map(f => ['xero_'+f, req.body[f]])));
    res.redirect('/settings/xero?flash=ok&msg=Xero+settings+saved.');
  } catch (err) {
    res.redirect(`/settings/xero?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

// WHAT: GET /accounting — reconciliation dashboard combining the Xero invoice map and the pending+failed action queue.
// CHANGE-GUARD: pendingActions concatenates getXeroPending('pending') and getXeroPending('failed') — if a third retry state is added, include it here or it won't surface.
// INVARIANT(S): read-only view; the retry buttons POST to /api/admin/xero/sync.
app.get('/accounting', requireAuth, (req, res) => {
  const invoiceMaps = getXeroInvoiceMaps();
  const pendingActions = getXeroPending('pending').concat(getXeroPending('failed'));
  const pendingCount = getXeroPendingCount();
  res.send(renderAccounting(req.adminSession, { invoiceMaps, pendingActions, pendingCount }));
});

// WHAT: POST /api/admin/xero/test — pings the Xero bridge (GET /api.xro/2.0/Accounts) and returns {ok,accounts} or {ok:false,error}.
// CHANGE-GUARD: always responds 200 with an `ok` boolean (never a 4xx/5xx) — clients must branch on body.ok, not HTTP status; depends on xeroRequest() and a configured XERO_BEARER.
// INVARIANT(S): read-only probe; counts result.body.Accounts.length as the connectivity signal.
app.post('/api/admin/xero/test', requireAuth, async (req, res) => {
  try {
    const result = await xeroRequest('GET', '/api.xro/2.0/Accounts');
    const accounts = result.body?.Accounts?.length || 0;
    res.json({ ok: true, accounts, message: `Connected — ${accounts} accounts found` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// WHAT: POST /api/admin/xero/sync — drains the Xero pending-action queue via retryXeroPending() and returns done/failed/skipped counts.
// CHANGE-GUARD: content negotiation — returns JSON when req.accepts('json') AND no _redirect flag, else redirects to /accounting with a flash; both branches must stay in sync with retryXeroPending's result shape.
// INVARIANT(S): the whole run is auditLog'd xero:sync; errors are reported (JSON {ok:false} or err flash) rather than thrown to the client.
app.post('/api/admin/xero/sync', requireAuth, async (req, res) => {
  try {
    const results = await retryXeroPending();
    auditLog(req.adminSession.email, 'xero:sync', null, null, results);
    if (req.accepts('json') && !req.body._redirect) {
      return res.json({ ok: true, ...results });
    }
    res.redirect(`/accounting?flash=ok&msg=${encodeURIComponent(`Sync complete: ${results.done} done, ${results.failed} failed, ${results.skipped} skipped.`)}`);
  } catch (err) {
    if (req.accepts('json')) return res.json({ ok: false, error: err.message });
    res.redirect(`/accounting?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

// WHAT: manually pushes one Shopify order to Xero as an ACCREC invoice via syncOrderToXero (which queues to xero_pending_actions on failure).
// CHANGE-GUARD: the catch branch redirects with `success=xero_failed` instead of `error=` (see bugs[]) so the UI shows a green flash on failure — fix the query key when touching this.
// INVARIANT(S): createXeroInvoice is idempotent via getXeroMap (status:synced short-circuits); insiders are skipped upstream; failures must enqueue a pending retry, never silently drop.
// WHAT: POST /orders/:id/xero/sync — manually pushes one order to Xero as an ACCREC invoice via syncOrderToXero (which enqueues to xero_pending_actions on failure).
// CHANGE-GUARD: BUG — the catch branch redirects with `?success=xero_failed` (success= key, not error=), so the order page shows a green/success flash even when the sync failed (see bugs[]); fix the query key when touching this.
// INVARIANT(S): syncOrderToXero is idempotent via getXeroMap (status:synced short-circuits); insiders are skipped upstream; a failure must enqueue a pending retry, never silently drop the invoice.
app.post('/orders/:id/xero/sync', requireAuth, async (req, res) => {
  const numId = req.params.id;
  try {
    const result = await syncOrderToXero(numId, req.adminSession.email);
    res.redirect(`/orders/${numId}?success=xero_synced`);
  } catch (err) {
    res.redirect(`/orders/${numId}?success=xero_failed`);
  }
});

// ── Phase 21: Xero customer sync endpoints ────────────────────────────────────

// WHAT: GET /api/admin/customers/:id/xero-status — returns the Xero contact-sync state for a customer (dryRun in MOCK).
// CHANGE-GUARD: always 200 with {ok}; on error returns {ok:false,state:'error',error} rather than a 5xx — UI must read .ok/.state.
// INVARIANT(S): delegates to getXeroSyncStatus(id, xeroRequest); read-only.
app.get('/api/admin/customers/:id/xero-status', requireAuth, async (req, res) => {
  try {
    const status = await getXeroSyncStatus(req.params.id, xeroRequest, { dryRun: MOCK });
    res.json({ ...status, ok: true });
  } catch (e) {
    res.json({ ok: false, state: 'error', error: e.message });
  }
});

// WHAT: POST /api/admin/customers/:id/xero-sync — fetches the Shopify customer (or MOCK), then upserts them as a Xero contact via syncCustomerToXero.
// CHANGE-GUARD: the firstName/lastName split (displayName.split(' ')) is naive and duplicated across this file (lead-convert, xero-sync) — multi-word last names land in lastName but single-word names get an empty lastName; keep the splits consistent if you refactor.
// INVARIANT(S): 404 if the customer is missing; result.skipped short-circuits without auditing; a real create/update is auditLog'd xero:customer_sync; 500 on unexpected error.
app.post('/api/admin/customers/:id/xero-sync', requireAuth, async (req, res) => {
  const numId = req.params.id;
  try {
    let customer;
    if (MOCK) {
      const c = MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === numId);
      customer = c ? { ...c, firstName: (c.displayName||'').split(' ')[0], lastName: (c.displayName||'').split(' ').slice(1).join(' ') } : null;
    } else {
      const r = await shopifyFetch(`query($id:ID!){customer(id:$id){id displayName email firstName lastName
        defaultAddress{company address1 city province zip country}}}`, { id: shopifyCustomerGid(numId) });
      customer = r.data?.customer;
    }
    if (!customer) return res.status(404).json({ ok: false, error: 'Customer not found' });
    // [XERO-DISABLED] dryRun when writes off — PUT blocked by xeroRequest backstop;
    // dryRun prevents a fake local mapping-file entry. Reports ok/created to the UI.
    const result = await syncCustomerToXero(numId, customer, xeroRequest, { dryRun: MOCK || !XERO_WRITES_ENABLED });
    if (result.skipped) return res.json({ ok: true, skipped: result.skipped });
    auditLog(req.adminSession.email, 'xero:customer_sync', shopifyCustomerGid(numId), null, { xeroContactId: result.xeroContactId, created: result.created });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Impersonation ─────────────────────────────────────────────────────────────

// WHAT: builds a base64url(payload).hex(hmac) impersonation token, HMAC-SHA256-signed with IMPERSONATION_SECRET; payload carries v:1, nonce, customer id/email/name, admin email, ro flag, and exp.
// CHANGE-GUARD: the portal's verifier MUST use the identical secret + algorithm + payload field names (v,nonce,cid,email,name,ae,ro,exp) — any drift breaks impersonation with a generic portal error; the signature covers the base64url payload string, not the decoded object, so canonicalization matters.
// INVARIANT(S): token is opaque/tamper-evident but NOT encrypted (payload is readable base64url); single-use is enforced separately via the persisted nonce, and expiry via `exp`.
function makeImpersonationToken({ nonce, customerId, customerEmail, customerDisplayName, adminEmail, readOnly, exp }) {
  const payload = Buffer.from(JSON.stringify({ v: 1, nonce, cid: customerId, email: customerEmail, name: customerDisplayName, ae: adminEmail, ro: readOnly ? 1 : 0, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', IMPERSONATION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// WHAT: mints a single-use, 1-hour HMAC-signed impersonation token (nonce persisted in impersonation_nonces) and returns a portal __impersonate__ URL.
// CHANGE-GUARD: token format is base64url(payload).hex(hmac) with IMPERSONATION_SECRET — the portal's verifier must use the identical secret + algorithm; changing either breaks impersonation silently with a generic portal error.
// INVARIANT(S): refuses when IMPERSONATION_SECRET unset (503); blocks impersonating insider accounts (tags intersect ALLOWED_EMAILS); nonce is single-use + expiring (consumed portal-side); every issuance is audit-logged; default readOnly:true unless read_only explicitly false.
// WHAT: POST /api/admin/customers/:id/impersonate — mints a single-use, 1-hour HMAC token (nonce persisted via createImpersonationNonce) and returns a portal __impersonate__ URL.
// CHANGE-GUARD: refuses (503) when IMPERSONATION_SECRET is unset; the insider-block compares the CUSTOMER's Shopify tags against ALLOWED_EMAILS (admin emails) which is almost certainly a mismatch and unlikely to ever block a real insider (see bugs[]) — re-examine that check; readOnly defaults to true unless read_only is explicitly the string/false 'false'.
// INVARIANT(S): every issuance is auditLog'd impersonate:token_issued; gcImpersonationNonces() prunes expired nonces on each mint; nonce is crypto.randomBytes(20) hex and consumed portal-side (single use); exp is Date.now()+1h.
app.post('/api/admin/customers/:id/impersonate', requireAuth, async (req, res) => {
  if (!IMPERSONATION_SECRET) return res.status(503).json({ ok: false, error: 'B2B_IMPERSONATION_SECRET not configured' });
  const numId = req.params.id;
  const readOnly = req.body.read_only !== 'false' && req.body.read_only !== false;
  const session = req.adminSession;

  let customerEmail = '';
  let customerDisplayName = '';
  if (MOCK) {
    const mc = MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === numId);
    if (!mc) return res.status(404).json({ ok: false, error: 'Customer not found' });
    customerEmail = mc.email || '';
    customerDisplayName = mc.displayName || '';
  } else {
    try {
      const r = await shopifyFetch('query($id:ID!){customer(id:$id){id displayName email tags}}', { id: shopifyCustomerGid(numId) });
      const c = r.data?.customer;
      if (!c) return res.status(404).json({ ok: false, error: 'Customer not found' });
      // Block impersonating an insider/admin: compare the customer's EMAIL to the admin allowlist
      // (the old check compared customer TAGS to admin emails — they never intersect, so it never fired).
      if (c.email && currentAllowedEmails().some(e => e.toLowerCase() === c.email.toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'Cannot impersonate insider accounts' });
      }
      customerEmail = c.email || '';
      customerDisplayName = c.displayName || '';
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  const nonce = crypto.randomBytes(20).toString('hex');
  const exp = Date.now() + 60 * 60 * 1000; // 1 hour
  const customerId = shopifyCustomerGid(numId);

  createImpersonationNonce({ nonce, customerId, customerEmail, customerDisplayName, adminEmail: session.email, readOnly, expiresAt: exp });
  gcImpersonationNonces();

  const token = makeImpersonationToken({ nonce, customerId, customerEmail, customerDisplayName, adminEmail: session.email, readOnly, exp });
  const url = `${PORTAL_BASE_URL}/__impersonate__?tok=${encodeURIComponent(token)}`;

  auditLog(session.email, 'impersonate:token_issued', customerId, null, { customerEmail, customerDisplayName, readOnly, exp: new Date(exp).toISOString() });

  res.json({ ok: true, url, customerDisplayName, readOnly });
});

// ── Phase 23: Customer activity warehouse viewer ──────────────────────────────

// WHAT: GET /api/admin/customers/:id/activity — proxies the portal activity warehouse (getCustomerActivityFromPortal) with the raw query as filters; returns JSON.
// CHANGE-GUARD: passes req.query through to the warehouse reader untouched — that function owns pagination/limit bounds, so validate there; this route does no clamping.
// INVARIANT(S): read-only; always {ok:true,...data}.
app.get('/api/admin/customers/:id/activity', requireAuth, (req, res) => {
  const data = getCustomerActivityFromPortal(req.params.id, req.query);
  res.json({ ok: true, ...data });
});

// WHAT: GET .../activity/lookup?date=YYYY-MM-DD — answers 'did this customer place an order on date?'; returns the matching order events or falls back to last-login/last-cart context.
// CHANGE-GUARD: the day window is [date T00:00:00Z, date T23:59:59Z] in UTC — a customer in another timezone may have a placed order attributed to the adjacent UTC day; events are matched on eventSubtype==='placed' within ts range.
// INVARIANT(S): 400 when date is missing; read-only; the 23:59:59Z bound omits the final second's milliseconds but that's negligible.
app.get('/api/admin/customers/:id/activity/lookup', requireAuth, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const dayStart = new Date(date + 'T00:00:00Z').getTime();
  const dayEnd   = new Date(date + 'T23:59:59Z').getTime();
  const data = getCustomerActivityFromPortal(req.params.id, {
    from: new Date(date), to: new Date(date),
    type: 'order',
    limit: 10,
  });
  const placed = data.rows.filter(r => r.eventSubtype === 'placed' && r.ts >= dayStart && r.ts <= dayEnd);
  if (placed.length > 0) {
    return res.json({ ok: true, found: true, events: placed });
  }
  // Not found — return context (last login, last cart)
  const context = getCustomerActivityFromPortal(req.params.id, { limit: 1 });
  res.json({ ok: true, found: false, lastLogin: context.lastLogin, lastCart: context.lastCart, date });
});

// WHAT: GET .../active-cart — returns the customer's current cart snapshot from the portal warehouse (getActiveCartFromPortal).
// CHANGE-GUARD: thin pass-through; the cart shape is owned by getActiveCartFromPortal — keep the consuming UI aligned with it.
// INVARIANT(S): read-only; always {ok:true,...cart}.
app.get('/api/admin/customers/:id/active-cart', requireAuth, (req, res) => {
  const cart = getActiveCartFromPortal(req.params.id);
  res.json({ ok: true, ...cart });
});

// WHAT: GET /customers/:id/activity — full HTML activity-log page with date presets, type filter, free-text path search, expandable per-row detail (IP hash, UA, session, impersonation admin), and a 'did they order on date?' quick-lookup widget.
// CHANGE-GUARD: defaults to a 7-day window; pagination is 50/page (totalPages from data.total) and pagination links re-encode from/to/type/q — add any new filter to BOTH the form and the pagination/canned-view query strings or it drops on page change; the inline script fetches the /activity/lookup endpoint by interpolated numId.
// INVARIANT(S): customer displayName is best-effort (falls back to 'Customer <id>' on Shopify error, swallowed); row detail JSON is h()-escaped into a data-detail attribute and re-parsed client-side; this page is read-only.
app.get('/customers/:id/activity', requireAuth, async (req, res) => {
  const numId = req.params.id;
  let customerName = `Customer ${numId}`;
  if (MOCK) {
    customerName = 'Mock Customer';
  } else {
    try {
      const r = await shopifyFetch(`query($id:ID!){customer(id:$id){displayName}}`, { id: `gid://shopify/Customer/${numId}` });
      customerName = r.data?.customer?.displayName || customerName;
    } catch (_) {}
  }

  const now = new Date();
  const ymd = d => d.toISOString().split('T')[0];
  const daysAgo = n => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };

  const fromParam = req.query.from || ymd(daysAgo(7));
  const toParam   = req.query.to   || ymd(now);
  const typeParam = req.query.type  || 'all';
  const qParam    = req.query.q     || '';
  const pageParam = Number(req.query.page) || 1;

  const data = getCustomerActivityFromPortal(numId, {
    from: fromParam, to: toParam, type: typeParam, q: qParam, page: pageParam, limit: 50,
  });

  function fmtTs(ts) {
    return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '—';
  }
  function eventBadge(type, subtype) {
    const colors = { auth:'#2086ba', page_view:'#555', api_call:'#777', cart:'#9BBC0E',
      checkout:'#e07b00', order:'#2086ba', account:'#555', error:'#c00', impersonation:'#900' };
    const color = colors[type] || '#666';
    const label = subtype ? `${type}.${subtype}` : type;
    return `<span style="font-size:0.78rem;padding:2px 6px;border-radius:3px;background:${color}1a;color:${color};font-family:monospace">${h(label)}</span>`;
  }

  const typeOptions = ['all','page_view','api_call','auth','cart','checkout','order','account','error','impersonation'];
  const datePresets = [
    { label: 'Today',      from: ymd(now),        to: ymd(now) },
    { label: 'Last 24h',   from: ymd(daysAgo(1)), to: ymd(now) },
    { label: 'Last 7d',    from: ymd(daysAgo(7)), to: ymd(now) },
    { label: 'Last 30d',   from: ymd(daysAgo(30)),to: ymd(now) },
    { label: 'Last 90d',   from: ymd(daysAgo(90)),to: ymd(now) },
  ];

  const rows = data.rows.map(r => `
    <tr class="activity-row" data-detail='${h(JSON.stringify({
      eventData: r.eventData, ipHash: r.ipHash, ipCountry: r.ipCountry,
      userAgent: r.userAgent, impersonationAdmin: r.impersonationAdmin,
      sessionId: r.sessionId ? r.sessionId.slice(0, 12) : null,
    }))}'>
      <td class="text-muted mono" style="font-size:0.8rem;white-space:nowrap">${fmtTs(r.ts)}</td>
      <td>${eventBadge(r.eventType, r.eventSubtype)}</td>
      <td class="mono" style="font-size:0.85rem">${h(r.path || '—')}</td>
      <td class="text-muted mono" style="font-size:0.8rem">${r.httpStatus || '—'}</td>
      <td class="text-muted mono" style="font-size:0.8rem">${r.durationMs != null ? r.durationMs + 'ms' : '—'}</td>
    </tr>
    <tr class="activity-detail-row" style="display:none">
      <td colspan="5" style="padding:0.5rem 1rem;background:#f8f9fa;font-size:0.82rem;border-top:none">
        <span class="text-muted">Loading…</span>
      </td>
    </tr>`).join('');

  const totalPages = Math.ceil(data.total / 50) || 1;
  const pagination = totalPages > 1 ? `
    <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.75rem">
      ${pageParam > 1 ? `<a href="?from=${h(fromParam)}&to=${h(toParam)}&type=${h(typeParam)}&q=${h(qParam)}&page=${pageParam - 1}" class="btn btn-sm btn-secondary">← Prev</a>` : ''}
      <span class="text-muted" style="font-size:0.85rem">Page ${pageParam} / ${totalPages}</span>
      ${pageParam < totalPages ? `<a href="?from=${h(fromParam)}&to=${h(toParam)}&type=${h(typeParam)}&q=${h(qParam)}&page=${pageParam + 1}" class="btn btn-sm btn-secondary">Next →</a>` : ''}
    </div>` : '';

  res.send(layout({ title: `Activity — ${customerName}`, session: req.adminSession, activePath: '/customers',
    extraHead: `<style>
      .activity-row{cursor:pointer;transition:background 0.1s}
      .activity-row:hover{background:#f0f4ff}
      .activity-row.expanded + .activity-detail-row{display:table-row!important}
      .activity-detail-row td{color:#333}
      .quick-lookup-box{background:#f8f9fa;border:1px solid #e0e0e0;border-radius:8px;padding:1rem;margin-bottom:1rem}
      .quick-lookup-result{margin-top:0.75rem;font-size:0.9rem}
    </style>`,
    content: `
    <div class="breadcrumb-row">
      <a href="/customers" class="breadcrumb">← Customers</a>
      <span class="breadcrumb-sep"> / </span>
      <a href="/customers/${h(numId)}" class="breadcrumb">${h(customerName)}</a>
    </div>
    <div class="page-header"><h1>Activity log — ${h(customerName)}</h1>
      <a href="/customers/${h(numId)}" class="btn btn-secondary btn-sm">← Profile</a>
    </div>

    <!-- Quick lookup -->
    <div class="quick-lookup-box">
      <strong style="font-size:0.9rem">Quick lookup: did customer place an order on…</strong>
      <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem">
        <input type="date" id="lookup-date" class="input input-sm" value="${ymd(daysAgo(1))}">
        <button class="btn btn-secondary btn-sm" id="lookup-btn">Check</button>
      </div>
      <div id="lookup-result" class="quick-lookup-result"></div>
    </div>

    <!-- Filters -->
    <div class="filter-bar" style="margin-bottom:1rem">
      <form method="GET" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        <select name="from" class="input input-sm" title="From date" onchange="this.form.submit()">
          ${datePresets.map(p => `<option value="${h(p.from)}"${p.from === fromParam && p.to === toParam ? ' selected' : ''}>${h(p.label)}</option>`).join('')}
          <option value="${h(fromParam)}"${!datePresets.some(p => p.from === fromParam) ? ' selected' : ''}>Custom</option>
        </select>
        <input type="date" name="from" class="input input-sm" value="${h(fromParam)}" style="width:130px">
        <span style="font-size:0.85rem;color:#666">to</span>
        <input type="date" name="to"   class="input input-sm" value="${h(toParam)}"   style="width:130px">
        <select name="type" class="input input-sm" onchange="this.form.submit()">
          ${typeOptions.map(t => `<option${t === typeParam ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <input type="text" name="q" class="input input-sm" placeholder="Search path…" value="${h(qParam)}" style="width:160px">
        <button type="submit" class="btn btn-secondary btn-sm">Filter</button>
        <a href="/customers/${h(numId)}/activity" class="btn btn-ghost btn-sm">Reset</a>
      </form>
      <!-- Canned views -->
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
        <a href="?type=order&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Orders placed</a>
        <a href="?type=checkout&q=failed&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Failed checkouts</a>
        <a href="?type=error&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Errors</a>
        <a href="?type=auth&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Recent logins</a>
      </div>
    </div>

    <div class="card" style="padding:0">
      <div style="padding:0.75rem 1rem;border-bottom:1px solid #eee;font-size:0.85rem;color:#555">
        Showing ${data.rows.length} of ${data.total} events
        ${data.lastLogin ? `· Last login: ${fmtTs(data.lastLogin.ts)}` : ''}
      </div>
      <table class="data-table">
        <thead><tr><th>Timestamp</th><th>Event</th><th>Path</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:2rem">No activity in this range.</td></tr>'}</tbody>
      </table>
      ${pagination}
    </div>

    <script>
    (function(){
      // Row expand/collapse
      document.querySelectorAll('.activity-row').forEach(function(row){
        row.addEventListener('click', function(){
          row.classList.toggle('expanded');
          var detail = row.nextElementSibling;
          if (!detail) return;
          if (row.classList.contains('expanded') && detail.querySelector('span.text-muted')) {
            try {
              var d = JSON.parse(row.dataset.detail || '{}');
              var parts = [];
              if (d.eventData) parts.push('<strong>Data:</strong> <code style="word-break:break-all">' + JSON.stringify(d.eventData) + '</code>');
              if (d.ipHash)    parts.push('<strong>IP hash:</strong> <code>' + d.ipHash + '</code>');
              if (d.ipCountry) parts.push('<strong>Country:</strong> ' + d.ipCountry);
              if (d.userAgent) parts.push('<strong>UA:</strong> <span style="color:#666">' + d.userAgent.slice(0,100) + '</span>');
              if (d.sessionId) parts.push('<strong>Session:</strong> <code>' + d.sessionId + '…</code>');
              if (d.impersonationAdmin) parts.push('<strong style="color:#900">Impersonated by:</strong> ' + d.impersonationAdmin);
              detail.querySelector('td').innerHTML = parts.length ? parts.join(' &nbsp;·&nbsp; ') : '<em>No extra data</em>';
            } catch(e) { detail.querySelector('td').textContent = 'Parse error'; }
          }
        });
      });

      // Quick lookup
      document.getElementById('lookup-btn').addEventListener('click', function(){
        var date = document.getElementById('lookup-date').value;
        var resultEl = document.getElementById('lookup-result');
        if (!date) return;
        resultEl.innerHTML = '<em>Checking…</em>';
        fetch('/api/admin/customers/${h(numId)}/activity/lookup?date=' + encodeURIComponent(date))
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.found) {
              resultEl.innerHTML = '<span style="color:#2a7;font-weight:600">✓ Order placed on ' + date + '</span>: ' +
                d.events.map(function(e){ return '<a href="/orders/' + (e.eventData && e.eventData.order_id ? e.eventData.order_id : '') + '">' +
                  (e.eventData && e.eventData.order_name ? e.eventData.order_name : 'Order') + '</a>' +
                  ' at ' + new Date(e.ts).toISOString().replace('T',' ').slice(0,19);
                }).join(', ');
            } else {
              var msg = '<span style="color:#b00">✗ No order placed on ' + date + '</span>';
              if (d.lastLogin) msg += ' &nbsp;·&nbsp; Last login: ' + new Date(d.lastLogin.ts).toISOString().replace('T',' ').slice(0,16);
              if (d.lastCart)  msg += ' &nbsp;·&nbsp; Last cart activity: ' + new Date(d.lastCart.ts).toISOString().replace('T',' ').slice(0,16);
              resultEl.innerHTML = msg;
            }
          })
          .catch(function(e){ resultEl.textContent = 'Error: ' + e.message; });
      });
    })();
    </script>
  ` }));
});

// ── Phase 24C: Shopify webhook receiver ───────────────────────────────────────

// WHAT: Shopify webhook receiver that HMAC-verifies then upserts customers/orders/products into the local SQLite cache via setImmediate (returns 200 immediately).
// CHANGE-GUARD: must mount express.raw BEFORE the global express.json (which it does, being defined late) or the rawBody HMAC will be over re-serialized JSON and never match; re-test signature rejection on tamper.
// INVARIANT(S): SECURITY — verification is skipped when the x-shopify-hmac-sha256 header is absent even though a secret is set (see bugs[]); comparison is plain !== (not timing-safe); cache upsert errors are swallowed so a 200 does NOT mean the row persisted.
// WHAT: POST /webhooks/shopify — HMAC-verifies Shopify webhooks then upserts customers/orders/products into the local SQLite cache via setImmediate (returns 200 immediately).
// SECURITY (fixed 2026-07-02): HMAC is verified over req.rawBody — the EXACT bytes captured by the
// global express.json({verify}) hook — NOT a re-serialization. The old code mounted express.raw here,
// but the app-level express.json runs first (registration order), so req.body was already a parsed
// object and the HMAC was computed over Buffer.from(JSON.stringify(...)) → it never matched Shopify's
// signature and ALL real webhooks were rejected. A missing signature now fails closed; compare is timing-safe.
// INVARIANT(S): cache upserts run in setImmediate AFTER the 200 is sent, and their errors are swallowed (console.error only) — a 200 does NOT mean the row persisted; topic prefixes 'customers/', 'orders/', 'products/(create|update)' route the upsert; money fields use shop_money/total_*; tags are normalized from array-or-CSV; every dispatch is auditLog'd webhook:<topic>.
app.post('/webhooks/shopify', (req, res) => {
  const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {})));
  const sig = req.headers['x-shopify-hmac-sha256'];
  if (SHOPIFY_WEBHOOK_SECRET) {
    if (!sig) return res.status(401).json({ error: 'missing signature' });
    const expected = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
    const a = Buffer.from(String(sig));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'HMAC mismatch' });
  } else if (!MOCK) {
    return res.status(401).json({ error: 'No webhook secret configured' });
  }
  const topic = req.headers['x-shopify-topic'] || '';
  let payload;
  try { payload = JSON.parse(rawBody.toString()); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // Dispatch to cache upsert (non-blocking)
  setImmediate(() => {
    try {
      if (topic.startsWith('customers/')) {
        const c = payload;
        const shopifyId = String(c.id);
        const tags = Array.isArray(c.tags) ? c.tags : (c.tags || '').split(',').map(s => s.trim()).filter(Boolean);
        upsertCustomerCache({
          shopify_id: shopifyId,
          gid: `gid://shopify/Customer/${shopifyId}`,
          email: c.email, first_name: c.first_name, last_name: c.last_name,
          display_name: c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : (c.email || shopifyId),
          company: c.default_address?.company || null,
          tags,
          amount_spent_total: parseFloat(c.total_spent) || 0,
          orders_count: c.orders_count || 0,
          default_address_json: c.default_address || null,
          created_at: c.created_at ? new Date(c.created_at).getTime() : null,
          updated_at: c.updated_at ? new Date(c.updated_at).getTime() : null,
        });
      } else if (topic.startsWith('orders/')) {
        const o = payload;
        const shopifyId = String(o.id);
        const custId = o.customer?.id ? String(o.customer.id) : null;
        upsertOrderCache({
          shopify_id: shopifyId,
          gid: `gid://shopify/Order/${shopifyId}`,
          name: o.name, customer_shopify_id: custId,
          created_at: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
          updated_at: o.updated_at ? new Date(o.updated_at).getTime() : null,
          processed_at: o.processed_at ? new Date(o.processed_at).getTime() : null,
          cancelled_at: o.cancelled_at ? new Date(o.cancelled_at).getTime() : null,
          financial_status: o.financial_status, fulfillment_status: o.fulfillment_status,
          display_financial_status: o.financial_status?.toUpperCase(),
          display_fulfillment_status: o.fulfillment_status?.toUpperCase(),
          total_price: parseFloat(o.total_price) || 0,
          subtotal_price: parseFloat(o.subtotal_price) || 0,
          // CURRENT-TOTALS (2026-06-29): the REST orders webhook returns CURRENT (post-edit) totals in
          // total_price/subtotal_price, so they double as current_total/current_subtotal for the list.
          current_total: o.total_price != null ? parseFloat(o.total_price) || 0 : null,
          current_subtotal: o.subtotal_price != null ? parseFloat(o.subtotal_price) || 0 : null,
          total_tax: parseFloat(o.total_tax) || 0,
          total_shipping: parseFloat(o.total_shipping_price_set?.shop_money?.amount || o.total_shipping_price || 0),
          total_discounts: parseFloat(o.total_discounts) || 0,
          currency: o.currency || 'USD',
          tags: Array.isArray(o.tags) ? o.tags : (o.tags || '').split(',').map(s => s.trim()).filter(Boolean),
          source_name: o.source_name || null,
          note: o.note || null,
          customer_email: o.email || o.customer?.email || null,
          customer_phone: o.phone || o.customer?.phone || null,
        });
        if (o.line_items?.length) {
          upsertOrderLineItemsCache(shopifyId, o.line_items.map(li => ({
            line_id: String(li.id),
            variant_shopify_id: li.variant_id ? String(li.variant_id) : null,
            product_shopify_id: li.product_id ? String(li.product_id) : null,
            sku: li.sku, title: li.title, variant_title: li.variant_title,
            quantity: li.quantity, price: parseFloat(li.price) || 0,
            // DISCOUNT-AWARE (2026-08-05): prefer Σ discount_allocations over total_discount.
            // VERIFIED on live order #38611: REST reports total_discount "0.00" while
            // discount_allocations carries the real 37.99 (pre_tax_price 3.00 = 40.99 − 37.99).
            // `price` is the PRE-discount unit price, so caching a 0 discount here makes
            // getReportsFromCache over-state B2B product revenue by the full discount on every
            // discounted order — which order discounts now are, since they stopped being their own
            // negative-priced cached row.
            // SYNC: same rule as scripts/backfill-shopify.mjs + scripts/backfill-orders-per-customer.mjs.
            // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).
            total_discount: (li.discount_allocations || []).length
              ? (li.discount_allocations || []).reduce((s, a) => s + (parseFloat(a?.amount ?? a?.amount_set?.shop_money?.amount ?? 0) || 0), 0)
              : parseFloat(li.total_discount) || 0,
            taxable: li.taxable ? 1 : 0, vendor: li.vendor || null,
          })));
        }
      } else if (topic === 'products/update' || topic === 'products/create') {
        const p = payload;
        const shopifyId = String(p.id);
        upsertProductCache({
          shopify_id: shopifyId, gid: `gid://shopify/Product/${shopifyId}`,
          handle: p.handle, title: p.title, vendor: p.vendor,
          product_type: p.product_type, status: p.status,
          tags: Array.isArray(p.tags) ? p.tags : (p.tags || '').split(',').map(s => s.trim()).filter(Boolean),
          variants_json: p.variants || [],
          created_at: p.created_at ? new Date(p.created_at).getTime() : null,
          updated_at: p.updated_at ? new Date(p.updated_at).getTime() : null,
        });
      }
      auditLog('webhook', `webhook:${topic}`, String(payload.id || ''), null, null);
    } catch (err) {
      console.error('[webhook] cache upsert error:', err.message);
    }
  });

  res.status(200).json({ ok: true, topic });
});

// ── Phase 24C: Background polling sync ────────────────────────────────────────

// WHAT: incremental order poller — pulls orders updated since last_synced_at (minus 60s overlap) into orders_cache; the backstop for missed webhooks.
// CHANGE-GUARD: it queries shopMoney (not presentmentMoney) and assumes currency 'USD'; the webhook path and backfill scripts use different money fields — keep the three in sync or cached totals diverge.
// INVARIANT(S): runs only when dashboardActive() and at most every FRESH_TARGET_MS (~3min) guarded by the _syncing flag; the 60s lookback overlap is required so updates landing between polls aren't lost; never runs in MOCK or without SHOPIFY_BEARER.
// WHAT: incremental order backstop poller — pulls orders updated since last_synced_at (minus a 60s overlap, or 6min on cold start) into orders_cache; covers webhooks that were missed.
// CHANGE-GUARD: it reads totalPriceSet/subtotalPriceSet/totalTaxSet.shopMoney and HARDCODES currency:'USD' — the webhook path and any backfill must use the same money fields or cached totals diverge; query is sortKey:UPDATED_AT reverse with first:50 (no pagination loop, so a burst of >50 updates between polls can drop the oldest — the 60s overlap only helps at the boundary).
// INVARIANT(S): no-ops in MOCK or without SHOPIFY_BEARER; the 60s lookback overlap is REQUIRED so updates landing between polls aren't lost; success and error both call setSyncState so last_synced_at always advances (an error still moves the cursor, meaning a failed page is not retried — intentional best-effort).
async function syncRecentFromShopify() {
  if (MOCK || !SHOPIFY_BEARER) return;
  try {
    const state = getSyncState('orders_recent');
    const since = state?.last_synced_at
      ? new Date(state.last_synced_at - 60000).toISOString()
      : new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const result = await shopifyFetch(`
      query($q:String!){
        orders(first:50,query:$q,sortKey:UPDATED_AT,reverse:true){
          edges{node{
            id name processedAt updatedAt createdAt cancelledAt
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet{shopMoney{amount}}
            subtotalPriceSet{shopMoney{amount}}
            currentTotalPriceSet{shopMoney{amount}}
            currentSubtotalPriceSet{shopMoney{amount}}
            totalTaxSet{shopMoney{amount}}
            customer{id email firstName lastName}
            tags sourceName note
          }}
          pageInfo{hasNextPage}
        }
      }`, { q: `updated_at:>${since}` });
    const edges = result.data?.orders?.edges || [];
    for (const { node: o } of edges) {
      const shopifyId = shopifyNumericId(o.id);
      const custId = o.customer?.id ? shopifyNumericId(o.customer.id) : null;
      upsertOrderCache({
        shopify_id: shopifyId, gid: o.id, name: o.name,
        customer_shopify_id: custId,
        created_at: o.createdAt ? new Date(o.createdAt).getTime() : Date.now(),
        updated_at: o.updatedAt ? new Date(o.updatedAt).getTime() : null,
        processed_at: o.processedAt ? new Date(o.processedAt).getTime() : null,
        cancelled_at: o.cancelledAt ? new Date(o.cancelledAt).getTime() : null,
        financial_status: o.displayFinancialStatus || null,
        fulfillment_status: o.displayFulfillmentStatus || null,
        display_financial_status: o.displayFinancialStatus,
        display_fulfillment_status: o.displayFulfillmentStatus,
        total_price: parseFloat(o.totalPriceSet?.shopMoney?.amount) || 0,
        subtotal_price: parseFloat(o.subtotalPriceSet?.shopMoney?.amount) || 0,
        // CURRENT-TOTALS (2026-06-29): post-edit truth — totalPriceSet/subtotalPriceSet stay FROZEN at the
        // original on an edited order, so the LIST must carry the current* totals to show e.g. #37639's $601.24.
        current_total: o.currentTotalPriceSet?.shopMoney?.amount != null ? parseFloat(o.currentTotalPriceSet.shopMoney.amount) : null,
        current_subtotal: o.currentSubtotalPriceSet?.shopMoney?.amount != null ? parseFloat(o.currentSubtotalPriceSet.shopMoney.amount) : null,
        total_tax: parseFloat(o.totalTaxSet?.shopMoney?.amount) || 0,
        currency: 'USD',
        tags: o.tags || [], source_name: o.sourceName || null, note: o.note || null,
        customer_email: o.customer?.email || null,
      });
    }
    setSyncState('orders_recent', { lastSyncedAt: Date.now(), totalSynced: edges.length });
  } catch (err) {
    console.error('[sync] polling error:', err.message);
    setSyncState('orders_recent', { lastSyncedAt: Date.now(), lastError: err.message });
  }
}

// Activity-gated polling (was a flat 5-min interval). Syncs every ~3 min WHILE the
// dashboard is being used (fresher than before); zero Shopify calls when idle, and
// refreshes within ~60s when someone returns after an idle period.
// WHAT: activity-gated background scheduler — every 60s, if the dashboard is active and >=FRESH_TARGET_MS (~3min) since the last run, invokes syncRecentFromShopify; plus a daily GC of expired impersonation nonces.
// CHANGE-GUARD: the _syncing flag + _lastSyncAt guard prevent overlapping/over-frequent Shopify calls — don't remove them or an idle-return storm could hammer the API; dashboardActive() is the gate that makes it zero-cost when nobody is looking.
// INVARIANT(S): never runs in MOCK (the whole block is !MOCK-gated); a thrown sync error is swallowed (catch{}) and _syncing is always reset in finally so a crash can't wedge the poller permanently; the nonce GC interval is 24h.
if (!MOCK) {
  const FRESH_TARGET_MS = 3 * 60 * 1000;
  let _syncing = false, _lastSyncAt = 0;
  setInterval(async () => {
    if (!dashboardActive()) return;            // quiet when nobody is looking
    if (_syncing || (Date.now() - _lastSyncAt) < FRESH_TARGET_MS) return;
    _syncing = true;
    try { await syncRecentFromShopify(); _lastSyncAt = Date.now(); }
    catch {} finally { _syncing = false; }
  }, 60 * 1000);
  // Daily GC for expired impersonation nonces
  setInterval(() => gcImpersonationNonces(), 24 * 60 * 60 * 1000);
}

// ── Phase 24E: Unified invoices page ──────────────────────────────────────────

// WHAT: GET /invoices — unified invoice list merging cache orders (getAllInvoicesForList), Xero invoice maps, and partial portal invoices, keyed by order number.
// CHANGE-GUARD: cross-references three sources by constructing `gid://shopify/Order/<shopify_id>` to match Xero/partial records — if any source switches between numeric ids and gids this join silently breaks; xeroSet is a Set of x.order_id for O(1) membership.
// INVARIANT(S): read-only aggregation; partialInvs is the subset of partials whose order_id matches this order's gid; hasXero/xero are derived purely from the gid join.
app.get('/invoices', requireAuth, (req, res) => {
  const partials  = getPartialInvoicesAll();
  const xeroMaps  = getXeroInvoiceMaps();
  const cacheOrds = getAllInvoicesForList();
  const xeroSet   = new Set(xeroMaps.map(x => x.order_id));

  const rows = cacheOrds.map(o => {
    const ordNum     = o.shopify_id;
    const hasXero    = xeroSet.has(`gid://shopify/Order/${ordNum}`);
    const xero       = hasXero ? xeroMaps.find(x => x.order_id === `gid://shopify/Order/${ordNum}`) : null;
    const partialInvs = partials.filter(p => p.order_id === `gid://shopify/Order/${ordNum}`);
    return `<tr>
      <td><a href="/orders/${h(ordNum)}" class="link">${h(o.name || `#${ordNum}`)}</a></td>
      <td>${o.customer_name ? `<a href="/customers/${h(o.customer_shopify_id)}" class="link">${h(o.customer_name)}</a>` : h(o.customer_email || '—')}</td>
      <td class="text-muted">${fmtDate(o.created_at ? new Date(o.created_at).toISOString() : null)}</td>
      <td class="text-right mono">${fmtMoney(o.total_price)}</td>
      <td><span class="badge badge-${(o.financial_status||'').toLowerCase()}">${h(o.display_financial_status||o.financial_status||'—')}</span></td>
      <td>${hasXero ? `<span class="badge badge-success">Xero ✓</span> <small class="text-muted">${(xero?.xero_invoice_id||'').slice(0,8)}…</small>` : '<span class="badge badge-secondary">No Xero</span>'}</td>
      <td>${partialInvs.length ? partialInvs.map(p => `<a href="/orders/${h(ordNum)}/invoice?letter=${p.invoice_letter}" target="_blank" rel="noopener" class="link">#${ordNum}-${p.invoice_letter}</a>`).join(' ') : `<a href="/orders/${h(ordNum)}/invoice" target="_blank" rel="noopener" class="link btn btn-ghost btn-xs">PDF</a>`}</td>
    </tr>`;
  });

  const emptyState = cacheOrds.length === 0
    ? '<tr><td colspan="7" class="empty-state">No invoices cached yet. Run the backfill script to import order history.</td></tr>'
    : '';

  res.send(layout({ title: 'Invoices', session: req.adminSession, activePath: '/invoices', content: `
    <h1>Invoices</h1>
    <p class="text-muted">Unified view across all orders, Xero invoices, and partial invoices.</p>
    <div class="table-wrap">
      <table class="data-table" id="invoices-table">
        <thead><tr>
          <th>Order</th><th>Customer</th><th>Date</th>
          <th class="text-right">Total</th><th>Status</th><th>Xero</th><th>Invoice PDF</th>
        </tr></thead>
        <tbody>${rows.join('') || emptyState}</tbody>
      </table>
    </div>
  ` }));
});

// Static
app.use(express.static(path.join(__dirname, 'public')));

// fww-error-sink: error middleware must be LAST (after all routes + static)
app.use(expressErrorMiddleware());

app.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT} (MOCK=${MOCK})`);
});
