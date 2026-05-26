/**
 * fww-b2b-admin — Fuzzywumpets internal ops dashboard.
 * Phase 1: Google OAuth + dashboard MVP.
 * Phase 2: Orders + Customers pages.
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSession, getSession, deleteSession, auditLog,
  getCustomerNotes, setCustomerNotes, getDropshipCache, setDropshipCache,
} from './db.mjs';
import { generateInvoicePdf } from './pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK  = process.env.B2B_ADMIN_MOCK === '1';
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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Mock data ─────────────────────────────────────────────────────────────────
const MOCK_ORDERS = [
  {
    id: 'gid://shopify/Order/1001', name: '#1001', processedAt: '2026-05-24T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '450.00', currencyCode: 'USD' } },
    tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li1', title: 'Elite Collar', quantity: 5, variant: { id: 'v301', sku: 'EC-001-S-NV', price: '36.00', inventoryQuantity: 24 },
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
    tags: ['b2b-portal'], note: 'Ship by Friday',
    lineItems: { edges: [
      { node: { id: 'li3', title: 'Simplicity Collar', quantity: 10, variant: { id: 'v303', sku: 'SC-002-M-RD', price: '22.00', inventoryQuantity: 7 },
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
    tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li4', title: 'Elite Collar Bundle XL', quantity: 20, variant: { id: 'v304', sku: 'ECB-010-XL', price: '60.00', inventoryQuantity: 8 },
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
    tags: ['b2b-portal'], note: 'Partial ship OK',
    lineItems: { edges: [
      { node: { id: 'li5', title: 'Everyday Collar', quantity: 15, variant: { id: 'v305', sku: 'EC-003-L-BK', price: '30.00', inventoryQuantity: 12 },
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
];

// In-memory overrides for mock mutations (mark paid, note changes)
const mockOrderOverrides = new Map(); // numericId → { displayFinancialStatus?, note? }

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
];

const MOCK_PRODUCTS = [
  { id: 'gid://shopify/Product/201', title: 'Elite Collar', handle: 'elite-collar',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/301', title: 'Small / Navy', sku: 'EC-001-S-NV', price: '36.00', inventoryQuantity: 24 } },
      { node: { id: 'gid://shopify/ProductVariant/302', title: 'Medium / Navy', sku: 'EC-001-M-NV', price: '36.00', inventoryQuantity: 12 } },
      { node: { id: 'gid://shopify/ProductVariant/307', title: 'Large / Navy', sku: 'EC-001-L-NV', price: '36.00', inventoryQuantity: 0 } },
    ]}
  },
  { id: 'gid://shopify/Product/202', title: 'Luxe Leash', handle: 'luxe-leash',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/303', title: 'Default Title', sku: 'LL-005', price: '75.00', inventoryQuantity: 5 } },
    ]}
  },
  { id: 'gid://shopify/Product/203', title: 'Simplicity Collar', handle: 'simplicity-collar',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/304', title: 'Medium / Red', sku: 'SC-002-M-RD', price: '22.00', inventoryQuantity: 7 } },
      { node: { id: 'gid://shopify/ProductVariant/305', title: 'Large / Red', sku: 'SC-002-L-RD', price: '22.00', inventoryQuantity: 18 } },
    ]}
  },
  { id: 'gid://shopify/Product/204', title: 'Everyday Collar Bundle', handle: 'everyday-collar-bundle',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/306', title: 'XL', sku: 'ECB-010-XL', price: '60.00', inventoryQuantity: 8 } },
    ]}
  },
];

// ── Cookie helpers ────────────────────────────────────────────────────────────
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

function sessionCookie(sid, expire = false) {
  const val    = expire ? '' : encodeURIComponent(sid);
  const maxAge = expire ? 0 : 604800;
  const secure = !MOCK ? '; Secure' : '';
  return `${COOKIE_NAME}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const session = getSession(getCookie(req, COOKIE_NAME));
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not authenticated' });
    return res.redirect('/login');
  }
  req.adminSession = session;
  next();
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function h(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function fmtMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount) || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shopifyNumericId(gid) {
  return gid ? String(gid).split('/').pop() : null;
}

function shopifyOrderGid(numId)    { return `gid://shopify/Order/${numId}`; }
function shopifyCustomerGid(numId) { return `gid://shopify/Customer/${numId}`; }

// ── HTML layout ───────────────────────────────────────────────────────────────
function gfonts() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">`;
}

function layout({ title, session, activePath = '/', content, extraHead = '' }) {
  const navItems = [
    ['/', 'Dashboard'], ['/orders', 'Orders'], ['/customers', 'Customers'],
    ['/catalog', 'Catalog'], ['/reports', 'Reports'], ['/settings', 'Settings'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(title)} — FWW Admin</title>
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
        <a href="/auth/logout" class="btn-signout">Sign out</a>
      </div>
    </div>
  </header>
  <main class="main-content">
    ${content}
  </main>
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
async function shopifyFetch(query, variables = {}) {
  const res = await fetch('https://shopify-bridge.alex-037.workers.dev/api/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SHOPIFY_BEARER}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`shopify-bridge ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function getDashboardData() {
  if (MOCK) {
    return {
      openOrdersCount: 2,
      openOrders: MOCK_ORDERS.filter(o => ['PENDING','AUTHORIZED'].includes(o.displayFinancialStatus)).slice(0, 5),
      weekOrdersCount: 3,
      topCustomers: MOCK_CUSTOMERS.slice(0, 5).map(c => ({
        id: c.id, name: c.displayName, email: c.email,
        spend: parseFloat(c.amountSpent.amount),
      })),
      lowStockItems: [
        { productId: 'gid://shopify/Product/201', productTitle: 'Elite Collar', variantTitle: 'Large / Navy', sku: 'EC-001-L-NV', qty: 0 },
        { productId: 'gid://shopify/Product/202', productTitle: 'Luxe Leash', variantTitle: 'Default Title', sku: 'LL-005', qty: 5 },
        { productId: 'gid://shopify/Product/203', productTitle: 'Simplicity Collar', variantTitle: 'Medium / Red', sku: 'SC-002-M-RD', qty: 7 },
        { productId: 'gid://shopify/Product/204', productTitle: 'Everyday Collar Bundle', variantTitle: 'XL', sku: 'ECB-010-XL', qty: 8 },
      ],
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
    const topCustomers = [...spend.values()].sort((a, b) => b.spend - a.spend).slice(0, 5);
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
    return { openOrdersCount: openOrders.length, openOrders: openOrders.slice(0, 5), weekOrdersCount: weekOrders.length, topCustomers, lowStockItems: lowStockItems.sort((a,b)=>a.qty-b.qty).slice(0,10) };
  } catch (err) {
    console.error('getDashboardData error:', err.message);
    return { error: err.message, openOrdersCount:0, openOrders:[], weekOrdersCount:0, topCustomers:[], lowStockItems:[] };
  }
}

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
    ? `<table class="mini-table"><thead><tr><th>Customer</th><th>Spend</th></tr></thead><tbody>
      ${data.topCustomers.map(c => `<tr>
        <td><a href="/customers/${shopifyNumericId(c.id)}">${h(c.name)}</a><br><small>${h(c.email)}</small></td>
        <td>${fmtMoney(c.spend)}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">No customer data</p>';

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
        <div class="widget-header"><h2>Low Stock (B2B)</h2><a href="/catalog?stock=low" class="widget-link">Catalog →</a></div>
        ${lowStockTable}
      </div>
    </div>
  ` });
}

// ── Orders list ───────────────────────────────────────────────────────────────
const FINANCIAL_STATUS_FILTER = {
  pending: ['PENDING','AUTHORIZED'],
  paid:    ['PAID','PARTIALLY_PAID'],
  open:    ['PENDING','AUTHORIZED','PARTIALLY_PAID'],
  refunded: ['REFUNDED'],
  voided:   ['VOIDED'],
};

async function getOrdersData(filters) {
  if (MOCK) {
    let orders = MOCK_ORDERS.map(o => {
      const ov = mockOrderOverrides.get(shopifyNumericId(o.id)) || {};
      return { ...o, ...ov };
    });
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
    let qParts = ['tag:b2b-portal'];
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
            note tags
            lineItems(first:3){edges{node{title quantity variant{sku}}}}
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

function renderOrdersList(session, data, filters) {
  const { orders, hasNextPage, endCursor, error } = data;

  const rows = orders.map(o => {
    const numId  = shopifyNumericId(o.id);
    const status = (o.displayFinancialStatus || '').toLowerCase();
    const fstatus = (o.displayFulfillmentStatus || '').toLowerCase().replace(/_/g, '-');
    const lineItemSummary = (o.lineItems?.edges || []).slice(0, 3)
      .map(e => `${e.node.title} ×${e.node.quantity}`).join(', ');
    return `<tr>
      <td class="col-check"><input type="checkbox" name="ids" value="${h(numId)}"></td>
      <td><a href="/orders/${h(numId)}" class="order-link">${h(o.name)}</a></td>
      <td>${o.customer ? `<a href="/customers/${shopifyNumericId(o.customer.id)}">${h(o.customer.displayName)}</a><br><small>${h(o.customer.email)}</small>` : '—'}</td>
      <td class="text-muted">${fmtDate(o.processedAt)}</td>
      <td class="text-muted small-text">${h(lineItemSummary)}</td>
      <td class="text-right mono">${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount)}</td>
      <td><span class="badge badge-${h(status)}">${h(o.displayFinancialStatus)}</span></td>
      <td><span class="badge badge-ff-${h(fstatus)}">${h(o.displayFulfillmentStatus)}</span></td>
      <td><a href="/orders/${h(numId)}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const emptyRow = orders.length === 0
    ? `<tr><td colspan="9" class="empty-state">No orders found${filters.q || filters.status || filters.date ? ' — try clearing filters' : ''}</td></tr>`
    : '';

  const currentParams = new URLSearchParams();
  if (filters.q)      currentParams.set('q', filters.q);
  if (filters.status) currentParams.set('status', filters.status);
  if (filters.date)   currentParams.set('date', filters.date);

  const nextParams = new URLSearchParams(currentParams);
  if (endCursor) nextParams.set('after', endCursor);

  const flash = filters.success === 'marked_paid' ? `<div class="alert alert-success">Order(s) marked as paid.</div>` : '';

  return layout({ title: 'Orders', session, activePath: '/orders', content: `
    <div class="page-header-row">
      <h1>Orders</h1>
      <a href="/orders/new" class="btn btn-primary">+ New Order</a>
    </div>
    ${flash}
    ${error ? `<div class="alert alert-warning">Shopify unavailable: ${h(error)}</div>` : ''}
    <form class="filter-bar" method="GET" action="/orders">
      <input type="search" name="q" value="${h(filters.q||'')}" placeholder="Order #, customer, SKU…" class="filter-input">
      <select name="status" class="filter-select">
        <option value="">All statuses</option>
        <option value="open"    ${filters.status==='open'?'selected':''}>Open (unpaid)</option>
        <option value="pending" ${filters.status==='pending'?'selected':''}>Pending</option>
        <option value="paid"    ${filters.status==='paid'?'selected':''}>Paid</option>
        <option value="refunded" ${filters.status==='refunded'?'selected':''}>Refunded</option>
      </select>
      <select name="date" class="filter-select">
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
        totalShippingPriceSet{presentmentMoney{amount currencyCode}}
        totalTaxSet{presentmentMoney{amount currencyCode}}
        note tags
        shippingAddress{firstName lastName address1 address2 city province zip country}
        billingAddress{firstName lastName address1 address2 city province zip country}
        lineItems(first:50){edges{node{id title quantity
          variant{id sku price inventoryQuantity}
          discountedUnitPriceSet{presentmentMoney{amount currencyCode}}
          originalUnitPriceSet{presentmentMoney{amount currencyCode}}
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

function renderOrderDetail(session, order, flash) {
  const numId    = shopifyNumericId(order.id);
  const isPaid   = order.displayFinancialStatus === 'PAID';
  const isFulfilled = ['FULFILLED','PARTIALLY_FULFILLED'].includes(order.displayFulfillmentStatus);
  const finStatus = (order.displayFinancialStatus || '').toLowerCase();
  const fulStatus = (order.displayFulfillmentStatus || '').toLowerCase().replace(/_/g, '-');

  // Status timeline
  const step1done  = true;
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

  // Line items table
  const lineItems = (order.lineItems?.edges || []).map(e => e.node);
  const lineItemsHtml = lineItems.map(item => {
    const unitPrice = parseFloat(item.discountedUnitPriceSet?.presentmentMoney?.amount ?? item.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
    const rowTotal  = unitPrice * (item.quantity || 0);
    return `<tr>
      <td>${h(item.title)}</td>
      <td class="mono">${h(item.variant?.sku || '—')}</td>
      <td class="text-right">${item.quantity}</td>
      <td class="text-right">${fmtMoney(unitPrice)}</td>
      <td class="text-right">${fmtMoney(rowTotal)}</td>
    </tr>`;
  }).join('');

  const sub   = fmtMoney(order.subtotalPriceSet?.presentmentMoney?.amount);
  const ship  = fmtMoney(order.totalShippingPriceSet?.presentmentMoney?.amount);
  const total = fmtMoney(order.totalPriceSet?.presentmentMoney?.amount);

  // Fulfillments
  const fulfillmentsHtml = (order.fulfillments || []).length > 0
    ? (order.fulfillments || []).map(f => `
        <div class="fulfillment-row">
          <span class="badge badge-ff-${h((f.status||'').toLowerCase())}">${h(f.status)}</span>
          <span class="text-muted">${fmtDate(f.createdAt)}</span>
          ${(f.trackingInfo || []).map(t => `<a href="${t.url ? h(t.url) : '#'}" target="_blank" rel="noopener" class="tracking-link">${h(t.company || '')} ${h(t.number || '')}</a>`).join('')}
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
    : flash === 'note_saved'
    ? `<div class="alert alert-success">Note saved.</div>`
    : '';

  return layout({ title: order.name || 'Order', session, activePath: '/orders', content: `
    <div class="breadcrumb-row"><a href="/orders" class="breadcrumb">← Orders</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(order.name)} <span class="badge badge-${h(finStatus)}">${h(order.displayFinancialStatus)}</span>
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
        <a href="/orders/${h(numId)}/invoice.pdf" class="btn btn-secondary">PDF Invoice</a>
      </div>
    </div>
    ${timeline}
    <div class="detail-grid">
      <div class="detail-main">
        <div class="card">
          <div class="card-header"><h2>Line Items</h2></div>
          <table class="data-table">
            <thead><tr><th>Item</th><th>SKU</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Total</th></tr></thead>
            <tbody>${lineItemsHtml}</tbody>
          </table>
          <div class="totals-block">
            <div class="totals-row"><span>Subtotal</span><span>${sub}</span></div>
            <div class="totals-row"><span>Shipping</span><span>${ship}</span></div>
            <div class="totals-row totals-total"><span>Total</span><span>${total}</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Order Note</h2></div>
          <form method="POST" action="/orders/${h(numId)}/note">
            <textarea name="note" class="textarea" rows="3" placeholder="Add a note for this order…">${h(order.note||'')}</textarea>
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save Note</button></div>
          </form>
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
        </div>
        <div class="card">
          <div class="card-header"><h2>Transactions</h2></div>
          ${txHtml}
        </div>
        <div class="card">
          <div class="card-header"><h2>Tags</h2></div>
          <div class="tags-list">${(order.tags||[]).map(t => `<span class="tag">${h(t)}</span>`).join(' ')}</div>
        </div>
      </div>
    </div>
  ` });
}

// ── Customers list ────────────────────────────────────────────────────────────
async function getCustomersData(filters) {
  if (MOCK) {
    let customers = [...MOCK_CUSTOMERS];
    if (filters.q) {
      const q = filters.q.toLowerCase();
      customers = customers.filter(c =>
        c.displayName.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q)
      );
    }
    if (filters.tag) {
      customers = customers.filter(c => c.tags.includes(filters.tag));
    }
    return { customers, hasNextPage: false, total: customers.length };
  }
  try {
    const qParts = ['tag:b2b'];
    if (filters.q) qParts.push(filters.q);
    if (filters.tag && filters.tag !== 'b2b') qParts.push(`tag:${filters.tag}`);
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

function renderCustomersList(session, data, filters) {
  const { customers, hasNextPage, endCursor, error } = data;

  const rows = customers.map(c => {
    const numId = shopifyNumericId(c.id);
    const dropship = c.metafields?.edges?.find(e => e.node.key === 'dropship_enabled')?.node?.value === 'true';
    const addr     = c.defaultAddress;
    const location = addr ? `${addr.city || ''}${addr.province ? ', '+addr.province : ''}` : '—';
    return `<tr>
      <td><a href="/customers/${h(numId)}" class="link-strong">${h(c.displayName)}</a><br><small>${h(c.email)}</small></td>
      <td class="text-muted">${h(location)}</td>
      <td><div class="tags-mini">${(c.tags||[]).map(t=>`<span class="tag tag-sm">${h(t)}</span>`).join(' ')}</div></td>
      <td class="text-right mono">${fmtMoney(c.amountSpent?.amount, c.amountSpent?.currencyCode)}</td>
      <td class="text-right">${c.numberOfOrders || 0}</td>
      <td>${dropship ? '<span class="badge badge-dropship">Dropship</span>' : ''}</td>
      <td><a href="/customers/${h(numId)}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const emptyRow = customers.length === 0
    ? `<tr><td colspan="7" class="empty-state">No customers found</td></tr>`
    : '';

  const currentParams = new URLSearchParams();
  if (filters.q)   currentParams.set('q', filters.q);
  if (filters.tag) currentParams.set('tag', filters.tag);
  const nextParams = new URLSearchParams(currentParams);
  if (endCursor) nextParams.set('after', endCursor);

  return layout({ title: 'Customers', session, activePath: '/customers', content: `
    <div class="page-header-row"><h1>Customers</h1></div>
    ${error ? `<div class="alert alert-warning">Shopify unavailable: ${h(error)}</div>` : ''}
    <form class="filter-bar" method="GET" action="/customers">
      <input type="search" name="q" value="${h(filters.q||'')}" placeholder="Name, email, phone…" class="filter-input">
      <select name="tag" class="filter-select">
        <option value="">All tags</option>
        <option value="b2b-tier:gold"   ${filters.tag==='b2b-tier:gold'?'selected':''}>Gold tier</option>
        <option value="b2b-tier:silver" ${filters.tag==='b2b-tier:silver'?'selected':''}>Silver tier</option>
        <option value="b2b-dropship"    ${filters.tag==='b2b-dropship'?'selected':''}>Dropship</option>
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
        defaultAddress{id firstName lastName address1 city province zip country phone}
        metafields(first:20,namespace:"b2b"){edges{node{id namespace key value type}}}
      }}`, { id: shopifyCustomerGid(numericId) });
    return result.data?.customer || null;
  } catch (err) {
    console.error('getCustomerDetail error:', err.message);
    return null;
  }
}

async function getCustomerRecentOrders(customerId) {
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
      { q: `tag:b2b-portal customer_id:${customerId}` });
    return result.data?.orders?.edges?.map(e => e.node) || [];
  } catch { return []; }
}

function renderCustomerDetail(session, customer, recentOrders, notes, dropshipCache, flash) {
  const numId      = shopifyNumericId(customer.id);
  const metafields = customer.metafields?.edges?.map(e => e.node) || [];
  const dropshipEnabled = dropshipCache?.enabled
    ? dropshipCache.enabled === 1
    : metafields.find(m => m.key === 'dropship_enabled')?.value === 'true';
  const dropshipMargin  = dropshipCache?.margin_pct
    ?? parseInt(metafields.find(m => m.key === 'dropship_margin_pct')?.value || '0', 10);

  const flashHtml = flash === 'notes_saved'
    ? `<div class="alert alert-success">Notes saved.</div>`
    : flash === 'dropship_saved'
    ? `<div class="alert alert-success">Dropship config updated.</div>`
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

  return layout({ title: customer.displayName || 'Customer', session, activePath: '/customers', content: `
    <div class="breadcrumb-row"><a href="/customers" class="breadcrumb">← Customers</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(customer.displayName)}</h1>
        <p class="text-muted">${h(customer.email)}${customer.phone ? ' · ' + h(customer.phone) : ''}</p>
      </div>
      <div class="detail-header-actions">
        <a href="/orders/new?customer=${h(numId)}" class="btn btn-primary">+ New Order</a>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-main">
        <div class="card">
          <div class="card-header">
            <h2>Recent Orders</h2>
            <a href="/orders?q=${h(customer.email)}" class="widget-link">All orders →</a>
          </div>
          ${recentOrdersHtml}
        </div>
        <div class="card">
          <div class="card-header"><h2>Internal Notes</h2></div>
          <form method="POST" action="/customers/${h(numId)}/notes">
            <textarea name="body" class="textarea" rows="4" placeholder="Internal notes about this customer (not shown to them)…">${h(notes?.body||'')}</textarea>
            ${notes?.updated_at ? `<p class="text-muted small-text" style="margin-top:0.25rem">Last updated ${fmtDate(new Date(notes.updated_at).toISOString())} by ${h(notes.updated_by)}</p>` : ''}
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save Notes</button></div>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><h2>Dropship Config</h2></div>
          <form method="POST" action="/customers/${h(numId)}/dropship">
            <label class="toggle-row">
              <span>Dropship enabled</span>
              <input type="checkbox" name="enabled" class="toggle" ${dropshipEnabled?'checked':''} onchange="this.form.submit()">
            </label>
            <div class="form-row" style="margin-top:0.75rem">
              <label for="margin_pct">Margin %</label>
              <input type="number" id="margin_pct" name="margin_pct" value="${h(String(dropshipMargin))}" min="0" max="100" step="1" class="input input-sm" style="width:80px">
            </div>
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save Dropship Config</button></div>
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
        <div class="card">
          <div class="card-header"><h2>Metafields (b2b)</h2></div>
          ${metafields.length > 0
            ? `<table class="mini-table"><tbody>${metafields.map(m=>`<tr><td class="mono">${h(m.key)}</td><td>${h(m.value)}</td></tr>`).join('')}</tbody></table>`
            : '<p class="text-muted small-text">No b2b metafields</p>'}
        </div>
      </div>
    </div>
  ` });
}

// ── Manual order form ─────────────────────────────────────────────────────────
function renderNewOrderForm(session, prefillCustomer) {
  const customerJson = prefillCustomer ? JSON.stringify({ id: shopifyNumericId(prefillCustomer.id), name: prefillCustomer.displayName, email: prefillCustomer.email }) : 'null';
  return layout({ title: 'New Order', session, activePath: '/orders',
    extraHead: `<style>
      .order-form-grid{display:grid;grid-template-columns:1fr 320px;gap:1rem;}
      #line-items-table tbody tr td{padding:0.35rem 0.5rem;}
      .price-override{width:90px;}
      .qty-input{width:60px;}
      @media(max-width:700px){.order-form-grid{grid-template-columns:1fr;}}
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
              <input type="text" id="product-search" class="input" placeholder="Search product by title or SKU…" autocomplete="off">
              <div id="product-results" class="autocomplete-dropdown" hidden></div>
            </div>
            <table class="data-table" id="line-items-table">
              <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>List Price</th><th>B2B Price</th><th></th></tr></thead>
              <tbody id="line-items-body"><tr id="empty-row"><td colspan="6" class="empty-state">Add line items above</td></tr></tbody>
            </table>
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
            <div class="form-row"><label>Province/State</label><input type="text" name="ship_province" class="input" id="ship-province"></div>
            <div class="form-row"><label>ZIP</label><input type="text" name="ship_zip" class="input" id="ship-zip"></div>
            <div class="form-row"><label>Country</label><input type="text" name="ship_country" class="input" id="ship-country" value="US"></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Submit</h2></div>
            <p class="text-muted small-text" style="margin-bottom:0.75rem">Order will be created as a draft and completed with payment pending.</p>
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
      }

      function esc(s){ var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

      function updateSubmitBtn(){
        var ok = selectedCustomer && lineItems.length>0 && lineItems.every(function(l){return l.qty>0;});
        submitBtn.disabled = !ok;
        submitError.textContent = !selectedCustomer ? 'Select a customer first.' : lineItems.length===0 ? 'Add at least one line item.' : '';
      }

      function updateTotals(){
        var total = lineItems.reduce(function(s,l){ return s + parseFloat(l.price||0)*parseInt(l.qty||0,10); }, 0);
        document.getElementById('order-totals').innerHTML = total>0
          ? '<div class="totals-row totals-total"><span>Est. Total</span><span>'+fmt(total)+'</span></div>' : '';
        lineItemsHidden.value = JSON.stringify(lineItems);
        updateSubmitBtn();
      }

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
                  return '<div class="autocomplete-item" data-json=\''+JSON.stringify(item).replace(/'/g,"&apos;")+'\'>'
                    + esc(item.label) + (item.sublabel?'<small>'+esc(item.sublabel)+'</small>':'') + '</div>';
                }).join('');
                results.hidden=false;
              }).catch(function(){ results.hidden=true; });
          },250);
        });
        results.addEventListener('click',function(e){
          var item = e.target.closest('.autocomplete-item');
          if(!item) return;
          var data = JSON.parse(item.dataset.json.replace(/&apos;/g,"'"));
          results.hidden=true; input.value='';
          onSelect(data);
        });
        document.addEventListener('click',function(e){ if(!input.contains(e.target)&&!results.contains(e.target)) results.hidden=true; });
      }

      setupAutocomplete('customer-search','customer-results','/api/customers/search',function(c){
        selectedCustomer={id:c.id,name:c.label,email:c.sublabel};
        customerIdHidden.value=c.id;
        document.getElementById('customer-selected').hidden=false;
        document.getElementById('customer-selected').innerHTML=
          '<strong>'+esc(c.label)+'</strong> &lt;'+esc(c.sublabel||'')+'&gt; '+
          '<button type="button" onclick="clearCustomer()" class="btn btn-ghost btn-xs">×</button>';
        document.getElementById('customer-search').hidden=true;
        // Fill shipping address from customer default
        if(c.address){
          var a=c.address;
          document.getElementById('ship-first').value=a.firstName||'';
          document.getElementById('ship-last').value=a.lastName||'';
          document.getElementById('ship-addr1').value=a.address1||'';
          document.getElementById('ship-addr2').value=a.address2||'';
          document.getElementById('ship-city').value=a.city||'';
          document.getElementById('ship-province').value=a.province||'';
          document.getElementById('ship-zip').value=a.zip||'';
          document.getElementById('ship-country').value=a.country||'US';
          document.getElementById('default-addr-msg').textContent='Auto-filled from customer default address.';
        }
        updateSubmitBtn();
      });

      setupAutocomplete('product-search','product-results','/api/products/search',function(p){
        // p: {id, label, sublabel, variantId, sku, price}
        var exists = lineItems.findIndex(function(l){ return l.variantId===p.variantId; });
        if(exists>=0){ lineItems[exists].qty++; }
        else {
          lineItems.push({ variantId:p.variantId, title:p.label, sku:p.sku||'', listPrice:parseFloat(p.price||0), price:(parseFloat(p.price||0)*0.5).toFixed(2), qty:1 });
        }
        renderLineItems(); updateTotals();
      });

      // Form submit: validate
      document.getElementById('order-form').addEventListener('submit',function(e){
        if(!selectedCustomer||lineItems.length===0){ e.preventDefault(); updateSubmitBtn(); return; }
        lineItemsHidden.value=JSON.stringify(lineItems);
      });

      updateSubmitBtn();
    })();
    </script>
  ` });
}

async function submitNewOrder(req, session) {
  const { customer_id, line_items, note, po_number,
          ship_first, ship_last, ship_addr1, ship_addr2,
          ship_city, ship_province, ship_zip, ship_country } = req.body;
  let lineItemsParsed = [];
  try { lineItemsParsed = JSON.parse(line_items || '[]'); } catch {}

  if (!customer_id || !lineItemsParsed.length) {
    return { error: 'Missing customer or line items' };
  }

  const shippingAddress = {
    firstName: ship_first || '', lastName: ship_last || '',
    address1: ship_addr1 || '', address2: ship_addr2 || '',
    city: ship_city || '', province: ship_province || '',
    zip: ship_zip || '', country: ship_country || 'US',
  };

  const orderNote = [note || '', po_number ? `PO: ${po_number}` : ''].filter(Boolean).join('\n');

  if (MOCK) {
    auditLog(session.email, 'create_draft_order', `mock-customer-${customer_id}`, null, { customer_id, lineItemsParsed, shippingAddress });
    return { orderId: 'MOCK-9999', orderName: '#MOCK-9999', ok: true };
  }

  try {
    const gidCustomer = shopifyCustomerGid(customer_id);
    const draftInput = {
      customerId: gidCustomer,
      lineItems: lineItemsParsed.map(li => ({
        variantId: `gid://shopify/ProductVariant/${li.variantId}`,
        quantity: parseInt(li.qty, 10),
        appliedDiscount: li.price && li.listPrice && li.price < li.listPrice
          ? { value: parseFloat((((li.listPrice - li.price) / li.listPrice) * 100).toFixed(2)), valueType: 'PERCENTAGE' }
          : undefined,
      })),
      shippingAddress,
      note: orderNote || null,
      tags: ['b2b-portal', 'b2b-manual-order'],
    };
    const createRes = await shopifyFetch(`
      mutation draftOrderCreate($input:DraftOrderInput!){
        draftOrderCreate(input:$input){ draftOrder{id invoiceUrl} userErrors{field message} }
      }`, { input: draftInput });
    const ue = createRes.data?.draftOrderCreate?.userErrors || [];
    if (ue.length) return { error: ue.map(e => e.message).join('; ') };
    const draftId = createRes.data?.draftOrderCreate?.draftOrder?.id;

    const completeRes = await shopifyFetch(`
      mutation draftOrderComplete($id:ID!,$paymentPending:Boolean!){
        draftOrderComplete(id:$id,paymentPending:$paymentPending){
          draftOrder{order{id name}} userErrors{field message}
        }
      }`, { id: draftId, paymentPending: true });
    const ue2 = completeRes.data?.draftOrderComplete?.userErrors || [];
    if (ue2.length) return { error: ue2.map(e => e.message).join('; ') };
    const order = completeRes.data?.draftOrderComplete?.draftOrder?.order;
    auditLog(session.email, 'create_order', order?.id, null, { customer_id, lineItemCount: lineItemsParsed.length });
    return { orderId: shopifyNumericId(order?.id), orderName: order?.name, ok: true };
  } catch (err) {
    console.error('submitNewOrder error:', err.message);
    return { error: err.message };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, app: 'fww-b2b-admin', ts: Date.now() });
});

// Mock: seed session
app.get('/__test__/session', (req, res) => {
  if (!MOCK) return res.status(404).json({ error: 'not found' });
  const email = req.query.email || 'alex@fuzzywumpets.com';
  const displayName = req.query.name || 'Alex (Test)';
  const sid = crypto.randomBytes(32).toString('hex');
  createSession(sid, email, displayName, '');
  res.setHeader('Set-Cookie', sessionCookie(sid));
  res.json({ ok: true, sid, email });
});

// Auth
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

app.get('/auth/google/callback', async (req, res) => {
  if (MOCK) return res.redirect('/');
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent('Google: ' + error)}`);
  const storedState = getCookie(req, 'oauth_state');
  if (!state || state !== storedState)
    return res.redirect('/login?error=Invalid+OAuth+state+%E2%80%94+please+try+again');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET }),
    });
    if (!tokenRes.ok) return res.redirect('/login?error=OAuth+token+exchange+failed');
    const tokens = await tokenRes.json();
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!userRes.ok) return res.redirect('/login?error=Failed+to+fetch+user+info');
    const user = await userRes.json();
    if (!user.email_verified) return res.redirect('/login?error=Google+email+not+verified');
    const emailLower = (user.email || '').toLowerCase();
    if (!ALLOWED_EMAILS.some(e => e.toLowerCase() === emailLower))
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

app.get('/auth/logout', (req, res) => {
  const sid = getCookie(req, COOKIE_NAME);
  if (sid) {
    const session = getSession(sid);
    if (session) { auditLog(session.email, 'logout', null, null, null); deleteSession(sid); }
  }
  res.setHeader('Set-Cookie', sessionCookie(null, true));
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (getSession(getCookie(req, COOKIE_NAME))) return res.redirect('/');
  res.send(renderLogin(req.query.error || null));
});

// Dashboard
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
app.get('/orders', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', status: req.query.status || '', date: req.query.date || '', after: req.query.after || '', success: req.query.success || '' };
  const data = await getOrdersData(filters);
  res.send(renderOrdersList(req.adminSession, data, filters));
});

app.get('/orders/new', requireAuth, async (req, res) => {
  let prefillCustomer = null;
  if (req.query.customer) {
    prefillCustomer = MOCK ? MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === req.query.customer) || null : await getCustomerDetail(req.query.customer);
  }
  res.send(renderNewOrderForm(req.adminSession, prefillCustomer));
});

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

app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await getOrderDetail(req.params.id);
  if (!order) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/orders',
    content: '<div class="page-header"><h1>Order not found</h1></div><a href="/orders" class="btn btn-secondary">← Orders</a>' }));
  res.send(renderOrderDetail(req.adminSession, order, req.query.success || ''));
});

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
  res.redirect(`/orders/${numId}?success=marked_paid`);
});

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

// ── Customers ──
app.get('/customers', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', tag: req.query.tag || '', after: req.query.after || '' };
  const data = await getCustomersData(filters);
  res.send(renderCustomersList(req.adminSession, data, filters));
});

app.get('/customers/:id', requireAuth, async (req, res) => {
  const [customer, recentOrders] = await Promise.all([
    getCustomerDetail(req.params.id),
    getCustomerRecentOrders(req.params.id),
  ]);
  if (!customer) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/customers',
    content: '<div class="page-header"><h1>Customer not found</h1></div><a href="/customers" class="btn btn-secondary">← Customers</a>' }));
  const notes     = getCustomerNotes(shopifyCustomerGid(req.params.id));
  const dropship  = getDropshipCache(shopifyCustomerGid(req.params.id));
  res.send(renderCustomerDetail(req.adminSession, customer, recentOrders, notes, dropship, req.query.success || ''));
});

app.post('/customers/:id/notes', requireAuth, (req, res) => {
  const body = String(req.body.body || '').slice(0, 5000);
  const gid  = shopifyCustomerGid(req.params.id);
  setCustomerNotes(gid, body, req.adminSession.email);
  auditLog(req.adminSession.email, 'update_customer_notes', gid, null, { body: body.slice(0, 100) });
  res.redirect(`/customers/${req.params.id}?success=notes_saved`);
});

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
  res.redirect(`/customers/${req.params.id}?success=tags_added`);
});

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

// ── API search ──
app.get('/api/customers/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const customers = MOCK
    ? MOCK_CUSTOMERS.filter(c => c.displayName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    : await (async () => {
        try {
          const r = await shopifyFetch(`query($q:String!){ customers(first:10,query:$q){
            edges{node{id displayName email defaultAddress{firstName lastName address1 address2 city province zip country}}}}}`,
            { q: `tag:b2b ${q}` });
          return r.data?.customers?.edges?.map(e => e.node) || [];
        } catch { return []; }
      })();
  res.json(customers.slice(0, 10).map(c => ({
    id:       shopifyNumericId(c.id),
    label:    c.displayName,
    sublabel: c.email,
    address:  c.defaultAddress || null,
  })));
});

app.get('/api/products/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  const allVariants = MOCK
    ? MOCK_PRODUCTS.flatMap(p =>
        (p.variants?.edges || []).map(e => ({
          id: shopifyNumericId(p.id),
          productTitle: p.title,
          variantId: shopifyNumericId(e.node.id),
          variantTitle: e.node.title,
          sku: e.node.sku,
          price: e.node.price,
          inventoryQuantity: e.node.inventoryQuantity,
        }))
      ).filter(v =>
        v.productTitle.toLowerCase().includes(q) ||
        (v.sku || '').toLowerCase().includes(q) ||
        v.variantTitle.toLowerCase().includes(q)
      )
    : await (async () => {
        try {
          const r = await shopifyFetch(`query($q:String!){ products(first:10,query:$q){
            edges{node{id title variants(first:5){edges{node{id title sku price inventoryQuantity}}}}}}}`,
            { q });
          return (r.data?.products?.edges || []).flatMap(e =>
            (e.node.variants?.edges || []).map(ve => ({
              id: shopifyNumericId(e.node.id),
              productTitle: e.node.title,
              variantId: shopifyNumericId(ve.node.id),
              variantTitle: ve.node.title,
              sku: ve.node.sku,
              price: ve.node.price,
              inventoryQuantity: ve.node.inventoryQuantity,
            }))
          );
        } catch { return []; }
      })();

  res.json(allVariants.slice(0, 20).map(v => ({
    variantId: v.variantId,
    label:     v.variantTitle === 'Default Title' ? v.productTitle : `${v.productTitle} — ${v.variantTitle}`,
    sublabel:  `${v.sku || '—'} · ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(parseFloat(v.price||0))} list`,
    sku:       v.sku,
    price:     v.price,
  })));
});

// Stubs for Phase 3
for (const [p, label] of [['/catalog','Catalog'],['/reports','Reports'],['/settings','Settings']]) {
  app.get(p, requireAuth, (req, res) => res.send(renderComingSoon(req.adminSession, label, p)));
}

// Static
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT} (MOCK=${MOCK})`);
});
