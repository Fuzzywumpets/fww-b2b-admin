/**
 * fww-b2b-admin — Fuzzywumpets internal ops dashboard.
 * Phase 1: Google OAuth + dashboard MVP.
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, getSession, deleteSession, auditLog } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.B2B_ADMIN_MOCK === '1';
const PORT = Number(process.env.PORT || 8794);

const GOOGLE_CLIENT_ID     = process.env.B2B_ADMIN_GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.B2B_ADMIN_GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS       = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const SHOPIFY_BEARER       = process.env.SHOPIFY_BRIDGE_BEARER           || '';
const REDIRECT_URI         = MOCK
  ? `http://127.0.0.1:${PORT}/auth/google/callback`
  : 'https://b2badmin.fuzzywumpets.com/auth/google/callback';
const COOKIE_NAME = 'b2b_admin_sid';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
  const val = expire ? '' : encodeURIComponent(sid);
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function fmtMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount) || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── HTML layout & views ───────────────────────────────────────────────────────
function gfonts() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">`;
}

function layout({ title, session, activePath = '/', content }) {
  const navItems = [
    ['/','Dashboard'], ['/orders','Orders'], ['/customers','Customers'],
    ['/catalog','Catalog'], ['/reports','Reports'], ['/settings','Settings'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(title)} — FWW Admin</title>
  ${gfonts()}
  <link rel="stylesheet" href="/admin.css">
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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — FWW Admin</title>
  ${gfonts()}
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo">
      <span class="logo-fw">FW</span><span class="logo-admin">admin</span>
    </div>
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
</body>
</html>`;
}

function renderUnauthorized(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied — FWW Admin</title>
  ${gfonts()}
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo">
      <span class="logo-fw">FW</span><span class="logo-admin">admin</span>
    </div>
    <div class="alert alert-error" style="margin-top:1.5rem;text-align:left">
      <strong>Not authorized.</strong><br>
      <span style="word-break:break-all">${h(email)}</span> is not on the admin allowlist.
      Contact Alexa to request access.
    </div>
    <a href="/login" class="btn-google" style="margin-top:1.25rem;background:#f5f5f5;color:#374151;border-color:#e5e7eb">
      ← Back to login
    </a>
  </div>
</body>
</html>`;
}

function renderComingSoon(session, label, path) {
  return layout({
    title: label,
    session,
    activePath: path,
    content: `
      <div class="page-header"><h1>${h(label)}</h1></div>
      <div class="coming-soon">
        <h2>${h(label)}</h2>
        <p>Coming in the next phase — check back soon.</p>
      </div>
    `,
  });
}

function renderDashboard(session, data) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const openOrdersTable = data.openOrders?.length > 0 ? `
    <table class="mini-table">
      <thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>
        ${data.openOrders.map(o => `
          <tr>
            <td><a href="/orders/${encodeURIComponent(o.id)}">${h(o.name)}</a></td>
            <td>${h(o.customer?.displayName || '—')}</td>
            <td>${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount, o.totalPriceSet?.presentmentMoney?.currencyCode)}</td>
            <td><span class="badge badge-${h(o.displayFinancialStatus?.toLowerCase())}">${h(o.displayFinancialStatus)}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>
  ` : '<p class="empty-state">No open orders</p>';

  const topCustomersTable = data.topCustomers?.length > 0 ? `
    <table class="mini-table">
      <thead><tr><th>Customer</th><th>Spend (90d)</th></tr></thead>
      <tbody>
        ${data.topCustomers.map(c => `
          <tr>
            <td><a href="/customers/${encodeURIComponent(c.id)}">${h(c.name)}</a><br><small>${h(c.email)}</small></td>
            <td>${fmtMoney(c.spend)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  ` : '<p class="empty-state">No customer data</p>';

  const lowStockTable = data.lowStockItems?.length > 0 ? `
    <table class="mini-table">
      <thead><tr><th>Product / Variant</th><th>SKU</th><th>Qty</th></tr></thead>
      <tbody>
        ${data.lowStockItems.map(item => `
          <tr class="${item.qty === 0 ? 'row-critical' : item.qty <= 3 ? 'row-warning' : ''}">
            <td>
              <a href="/catalog/${encodeURIComponent(item.productId)}">${h(item.productTitle)}</a>
              ${item.variantTitle && item.variantTitle !== 'Default Title' ? `<small>${h(item.variantTitle)}</small>` : ''}
            </td>
            <td class="mono">${h(item.sku || '—')}</td>
            <td class="${item.qty === 0 ? 'qty-zero' : item.qty <= 3 ? 'qty-critical' : 'qty-low'}">${item.qty}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  ` : '<p class="empty-state">All items well-stocked ✓</p>';

  const content = `
    <div class="page-header">
      <h1>Dashboard</h1>
      <span class="text-muted">${h(today)}</span>
    </div>

    ${data.error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(data.error)}</div>` : ''}

    <div class="widget-grid">
      <div class="widget">
        <div class="widget-header">
          <h2>Open Orders</h2>
          <a href="/orders?status=open" class="widget-link">View all →</a>
        </div>
        <div class="widget-stat">${data.openOrdersCount ?? 0}</div>
        <p class="widget-subtext">awaiting payment</p>
        ${openOrdersTable}
      </div>

      <div class="widget">
        <div class="widget-header">
          <h2>This Week</h2>
          <a href="/orders?date=7d" class="widget-link">View →</a>
        </div>
        <div class="widget-stat">${data.weekOrdersCount ?? 0}</div>
        <p class="widget-subtext">B2B orders in last 7 days</p>
      </div>

      <div class="widget">
        <div class="widget-header">
          <h2>Top Customers</h2>
          <a href="/customers" class="widget-link">View all →</a>
        </div>
        ${topCustomersTable}
      </div>

      <div class="widget">
        <div class="widget-header">
          <h2>Low Stock (B2B)</h2>
          <a href="/catalog?stock=low" class="widget-link">Catalog →</a>
        </div>
        ${lowStockTable}
      </div>
    </div>
  `;

  return layout({ title: 'Dashboard', session, activePath: '/', content });
}

// ── Shopify ───────────────────────────────────────────────────────────────────
async function shopifyFetch(query, variables = {}) {
  const res = await fetch('https://shopify-bridge.alex-037.workers.dev/api/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SHOPIFY_BEARER}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`shopify-bridge ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json;
}

// ── Dashboard data ────────────────────────────────────────────────────────────
async function getDashboardData() {
  if (MOCK) {
    return {
      openOrdersCount: 3,
      openOrders: [
        { id: 'gid://shopify/Order/1001', name: '#1001', processedAt: '2026-05-24T10:00:00Z', customer: { displayName: 'Acme Pet Supply', email: 'buyer@acme.com' }, displayFinancialStatus: 'PENDING', totalPriceSet: { presentmentMoney: { amount: '450.00', currencyCode: 'USD' } } },
        { id: 'gid://shopify/Order/1002', name: '#1002', processedAt: '2026-05-23T14:00:00Z', customer: { displayName: 'Happy Paws Boutique', email: 'orders@happypaws.com' }, displayFinancialStatus: 'PENDING', totalPriceSet: { presentmentMoney: { amount: '285.50', currencyCode: 'USD' } } },
        { id: 'gid://shopify/Order/1003', name: '#1003', processedAt: '2026-05-22T09:30:00Z', customer: { displayName: 'Doggo Depot', email: 'wholesale@doggo.com' }, displayFinancialStatus: 'AUTHORIZED', totalPriceSet: { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } } },
      ],
      weekOrdersCount: 5,
      topCustomers: [
        { id: 'gid://shopify/Customer/101', name: 'Acme Pet Supply',      email: 'buyer@acme.com',          spend: 4520.00 },
        { id: 'gid://shopify/Customer/102', name: 'Happy Paws Boutique',  email: 'orders@happypaws.com',    spend: 2890.00 },
        { id: 'gid://shopify/Customer/103', name: 'Doggo Depot',          email: 'wholesale@doggo.com',     spend: 1850.00 },
        { id: 'gid://shopify/Customer/104', name: 'Pet Paradise',         email: 'buy@petparadise.com',     spend: 1200.00 },
        { id: 'gid://shopify/Customer/105', name: 'Paw Central',          email: 'orders@pawcentral.com',   spend: 890.00  },
      ],
      lowStockItems: [
        { productId: 'gid://shopify/Product/201', productTitle: 'Elite Collar (Small)',    variantTitle: 'Small / Navy',   sku: 'EC-001-S-NV',  qty: 2 },
        { productId: 'gid://shopify/Product/202', productTitle: 'Luxe Leash',             variantTitle: 'Default Title',  sku: 'LL-005',        qty: 5 },
        { productId: 'gid://shopify/Product/203', productTitle: 'Simplicity Collar',      variantTitle: 'Medium / Red',   sku: 'SC-002-M-RD',  qty: 7 },
        { productId: 'gid://shopify/Product/204', productTitle: 'Everyday Collar Bundle', variantTitle: 'XL',             sku: 'ECB-010-XL',   qty: 8 },
      ],
    };
  }

  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [ordersResult, productsResult] = await Promise.all([
      shopifyFetch(`
        query($q: String!) {
          orders(first: 50, query: $q, sortKey: PROCESSED_AT, reverse: true) {
            edges { node {
              id name processedAt
              customer { id displayName email }
              displayFinancialStatus
              totalPriceSet { presentmentMoney { amount currencyCode } }
              tags
            }}
            pageInfo { hasNextPage }
          }
        }
      `, { q: `tag:b2b-portal created_at:>${ninetyDaysAgo}` }),

      shopifyFetch(`
        query {
          products(first: 100, query: "published_status:published") {
            edges { node {
              id title handle
              publishedOnPublication(publicationId: "gid://shopify/Publication/199709720811")
              variants(first: 10) {
                edges { node { sku title inventoryQuantity } }
              }
            }}
          }
        }
      `),
    ]);

    const orders = ordersResult.data?.orders?.edges?.map(e => e.node) || [];
    const openStatuses = new Set(['PENDING', 'AUTHORIZED', 'PARTIALLY_PAID']);
    const openOrders = orders.filter(o => openStatuses.has(o.displayFinancialStatus));
    const weekOrders = orders.filter(o => o.processedAt >= sevenDaysAgo);

    const customerSpend = new Map();
    for (const o of orders) {
      if (!o.customer) continue;
      const { id, displayName, email } = o.customer;
      const amt = parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
      if (!customerSpend.has(id)) customerSpend.set(id, { id, name: displayName, email, spend: 0 });
      customerSpend.get(id).spend += amt;
    }
    const topCustomers = [...customerSpend.values()].sort((a, b) => b.spend - a.spend).slice(0, 5);

    const allProducts = productsResult.data?.products?.edges?.map(e => e.node) || [];
    const lowStockItems = [];
    for (const p of allProducts) {
      if (!p.publishedOnPublication) continue;
      for (const ve of (p.variants?.edges || [])) {
        const v = ve.node;
        if (typeof v.inventoryQuantity === 'number' && v.inventoryQuantity < 10) {
          lowStockItems.push({ productId: p.id, productTitle: p.title, variantTitle: v.title, sku: v.sku, qty: v.inventoryQuantity });
        }
      }
    }
    lowStockItems.sort((a, b) => a.qty - b.qty);

    return {
      openOrdersCount: openOrders.length,
      openOrders: openOrders.slice(0, 5),
      weekOrdersCount: weekOrders.length,
      topCustomers,
      lowStockItems: lowStockItems.slice(0, 10),
    };
  } catch (err) {
    console.error('getDashboardData error:', err.message);
    return { error: err.message, openOrdersCount: 0, openOrders: [], weekOrdersCount: 0, topCustomers: [], lowStockItems: [] };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, app: 'fww-b2b-admin', ts: Date.now() });
});

// Mock-only: seed a session for testing
app.get('/__test__/session', (req, res) => {
  if (!MOCK) return res.status(404).json({ error: 'not found' });
  const email       = req.query.email || 'alex@fuzzywumpets.com';
  const displayName = req.query.name  || 'Alex (Test)';
  const sid = crypto.randomBytes(32).toString('hex');
  createSession(sid, email, displayName, '');
  res.setHeader('Set-Cookie', sessionCookie(sid));
  res.json({ ok: true, sid, email });
});

// Initiate Google OAuth
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
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  if (MOCK) return res.redirect('/');

  const { code, state, error } = req.query;

  if (error) return res.redirect(`/login?error=${encodeURIComponent('Google: ' + error)}`);

  const storedState = getCookie(req, 'oauth_state');
  if (!state || state !== storedState) {
    return res.redirect('/login?error=Invalid+OAuth+state+%E2%80%94+please+try+again');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) {
      console.error('token exchange failed:', await tokenRes.text());
      return res.redirect('/login?error=OAuth+token+exchange+failed');
    }
    const tokens = await tokenRes.json();

    // Get user info
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) return res.redirect('/login?error=Failed+to+fetch+user+info');
    const user = await userRes.json();

    if (!user.email_verified) {
      return res.redirect('/login?error=Google+email+not+verified');
    }

    // Check allowlist
    const emailLower = (user.email || '').toLowerCase();
    const allowed = ALLOWED_EMAILS.some(e => e.toLowerCase() === emailLower);
    if (!allowed) {
      return res.status(403).send(renderUnauthorized(user.email));
    }

    const sid = crypto.randomBytes(32).toString('hex');
    createSession(sid, user.email, user.name || user.email, user.picture || '');
    auditLog(user.email, 'login', null, null, { ip: req.ip });

    res.setHeader('Set-Cookie', [
      'oauth_state=; Path=/; HttpOnly; Max-Age=0',
      sessionCookie(sid),
    ]);
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`/login?error=${encodeURIComponent('Authentication error: ' + err.message)}`);
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  const sid = getCookie(req, COOKIE_NAME);
  if (sid) {
    const session = getSession(sid);
    if (session) {
      auditLog(session.email, 'logout', null, null, null);
      deleteSession(sid);
    }
  }
  res.setHeader('Set-Cookie', sessionCookie(null, true));
  res.redirect('/login');
});

// Login page
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
    console.error('Dashboard error:', err.message);
    res.status(500).send(renderDashboard(req.adminSession, { error: err.message, openOrdersCount: 0, openOrders: [], weekOrdersCount: 0, topCustomers: [], lowStockItems: [] }));
  }
});

// Coming-soon stubs for Phase 2+
const comingSoon = [
  ['/orders',    'Orders'],
  ['/customers', 'Customers'],
  ['/catalog',   'Catalog'],
  ['/reports',   'Reports'],
  ['/settings',  'Settings'],
];
for (const [p, label] of comingSoon) {
  app.get(p, requireAuth, (req, res) => res.send(renderComingSoon(req.adminSession, label, p)));
}

// Static files (CSS, etc.) — must come after route definitions
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT} (MOCK=${MOCK})`);
});
