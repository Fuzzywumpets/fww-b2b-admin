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
} from './db.mjs';
import { generateInvoicePdf } from './pdf.mjs';
import { renderLabelSheet, expandItems, TEMPLATES as LABEL_TEMPLATES, DEFAULT_FIELDS } from './labels.mjs';

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
      { node: { id: 'gid://shopify/ProductVariant/301', title: 'Small / Navy', sku: 'EC-001-S-NV', price: '36.00', compareAtPrice: '54.00', barcode: '012345678901', inventoryQuantity: 24 } },
      { node: { id: 'gid://shopify/ProductVariant/302', title: 'Medium / Navy', sku: 'EC-001-M-NV', price: '36.00', compareAtPrice: '54.00', barcode: '012345678902', inventoryQuantity: 12 } },
      { node: { id: 'gid://shopify/ProductVariant/307', title: 'Large / Navy',  sku: 'EC-001-L-NV', price: '36.00', compareAtPrice: '54.00', barcode: '',             inventoryQuantity: 0  } },
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
      { node: { id: 'gid://shopify/ProductVariant/306', title: 'XL', sku: 'ECB-010-XL', price: '60.00', compareAtPrice: '90.00', barcode: '012345678906', inventoryQuantity: 8 } },
    ]}
  },
];

// Phase 3 mock data ─────────────────────────────────────────────────────────
const MOCK_CATALOG_PRODUCTS = [
  { id: 'gid://shopify/Product/201', title: 'Elite Collar', handle: 'elite-collar',
    vendor: 'Fuzzywumpets', tags: ['Style_Elite', 'b2b'], publishedOnB2B: true,
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/301', sku: 'EC-001-S-NV', title: 'Small / Navy', inventoryQuantity: 24 } },
      { node: { id: 'gid://shopify/ProductVariant/302', sku: 'EC-001-M-NV', title: 'Medium / Navy', inventoryQuantity: 12 } },
      { node: { id: 'gid://shopify/ProductVariant/307', sku: 'EC-001-L-NV', title: 'Large / Navy', inventoryQuantity: 0 } },
    ]}
  },
  { id: 'gid://shopify/Product/202', title: 'Luxe Leash', handle: 'luxe-leash',
    vendor: 'Fuzzywumpets', tags: ['Style_Luxe', 'b2b'], publishedOnB2B: true,
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/303', sku: 'LL-005', title: 'Default Title', inventoryQuantity: 5 } },
    ]}
  },
  { id: 'gid://shopify/Product/203', title: 'Simplicity Collar', handle: 'simplicity-collar',
    vendor: 'Fuzzywumpets', tags: ['Style_Simplicity', 'b2b'], publishedOnB2B: true,
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/304', sku: 'SC-002-M-RD', title: 'Medium / Red', inventoryQuantity: 7 } },
      { node: { id: 'gid://shopify/ProductVariant/305', sku: 'SC-002-L-RD', title: 'Large / Red', inventoryQuantity: 18 } },
    ]}
  },
  { id: 'gid://shopify/Product/204', title: 'Everyday Collar Bundle', handle: 'everyday-collar-bundle',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday', 'b2b'], publishedOnB2B: true,
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/306', sku: 'ECB-010-XL', title: 'XL', inventoryQuantity: 8 } },
    ]}
  },
  { id: 'gid://shopify/Product/205', title: 'Everyday Collar Starter', handle: 'everyday-collar-starter',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday'], publishedOnB2B: false,
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/308', sku: 'EC-STR-S', title: 'Small', inventoryQuantity: 45 } },
      { node: { id: 'gid://shopify/ProductVariant/309', sku: 'EC-STR-M', title: 'Medium', inventoryQuantity: 32 } },
    ]}
  },
  { id: 'gid://shopify/Product/206', title: 'Elite Harness', handle: 'elite-harness',
    vendor: 'Fuzzywumpets', tags: ['Style_Elite', 'b2b'], publishedOnB2B: true,
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/310', sku: 'EH-001-S', title: 'Small', inventoryQuantity: 3 } },
      { node: { id: 'gid://shopify/ProductVariant/311', sku: 'EH-001-M', title: 'Medium', inventoryQuantity: 9 } },
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
    ['/catalog', 'Catalog'], ['/reports', 'Reports'],
    ['/labels', 'Labels'], ['/exports', 'Exports'],
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
        <a href="/auth/logout" class="btn-signout">Sign out</a>
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

async function getB2bConfig(numericId) {
  const defaults = {
    discount_pct:  parseInt(getSetting('b2b_discount_pct') ?? '50', 10),
    min_order_usd: parseInt(getSetting('order_minimum')    ?? '0',  10),
    payment_terms: getSetting('payment_terms')             ?? 'Net 30',
  };

  if (MOCK) {
    const inMemory = mockB2bConfigOverrides.get(numericId) || {};
    const gid = shopifyCustomerGid(numericId);
    const cust = MOCK_CUSTOMERS.find(c => c.id === gid);
    const mfs  = cust?.metafields?.edges?.map(e => e.node) || [];
    // Start from metafields in mock data, then apply in-memory overrides on top
    const fromMf = {};
    const dpStr   = mfs.find(m => m.key === 'discount_pct')?.value;
    const moStr   = mfs.find(m => m.key === 'min_order_usd')?.value;
    const ptStr   = mfs.find(m => m.key === 'payment_terms')?.value;
    if (dpStr !== undefined) fromMf.discount_pct  = parseInt(dpStr, 10);
    if (moStr !== undefined) fromMf.min_order_usd = parseInt(moStr, 10);
    if (ptStr !== undefined) fromMf.payment_terms  = ptStr;

    const overrides = { ...fromMf, ...inMemory };
    // Null entries in inMemory mean "cleared"
    for (const k of Object.keys(inMemory)) {
      if (inMemory[k] === null) delete overrides[k];
    }
    return {
      effective: {
        discount_pct:  overrides.discount_pct  ?? defaults.discount_pct,
        min_order_usd: overrides.min_order_usd ?? defaults.min_order_usd,
        payment_terms: overrides.payment_terms ?? defaults.payment_terms,
      },
      overrides: {
        discount_pct:  overrides.discount_pct  ?? null,
        min_order_usd: overrides.min_order_usd ?? null,
        payment_terms: overrides.payment_terms ?? null,
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
    const moStr  = getVal('min_order_usd');
    const ptStr  = getVal('payment_terms');
    const overrides = {
      discount_pct:  dpStr !== null ? parseInt(dpStr, 10)  : null,
      min_order_usd: moStr !== null ? parseInt(moStr, 10)  : null,
      payment_terms: ptStr !== null ? ptStr                : null,
    };
    return {
      effective: {
        discount_pct:  overrides.discount_pct  ?? defaults.discount_pct,
        min_order_usd: overrides.min_order_usd ?? defaults.min_order_usd,
        payment_terms: overrides.payment_terms ?? defaults.payment_terms,
      },
      overrides,
      defaults,
    };
  } catch (err) {
    console.error('getB2bConfig error:', err.message);
    return {
      effective: defaults,
      overrides: { discount_pct: null, min_order_usd: null, payment_terms: null },
      defaults,
    };
  }
}

async function applyB2bConfigUpdate(numericId, { discount_pct, min_order_usd, payment_terms }) {
  const gid = shopifyCustomerGid(numericId);
  if (MOCK) {
    const cur = { ...(mockB2bConfigOverrides.get(numericId) || {}) };
    if (discount_pct  !== undefined) { cur.discount_pct  = (discount_pct  === null || discount_pct  === '') ? null : parseInt(discount_pct,  10); }
    if (min_order_usd !== undefined) { cur.min_order_usd = (min_order_usd === null || min_order_usd === '') ? null : parseInt(min_order_usd, 10); }
    if (payment_terms !== undefined) { cur.payment_terms = (payment_terms === null || payment_terms === '') ? null : String(payment_terms); }
    mockB2bConfigOverrides.set(numericId, cur);
    return;
  }

  const sets    = [];
  const delKeys = [];
  const fieldDefs = [
    { key: 'discount_pct',  val: discount_pct,  type: 'number_integer' },
    { key: 'min_order_usd', val: min_order_usd, type: 'number_integer' },
    { key: 'payment_terms', val: payment_terms, type: 'single_line_text_field' },
  ];
  for (const f of fieldDefs) {
    if (f.val === undefined) continue;
    if (f.val === null || f.val === '') {
      delKeys.push(f.key);
    } else {
      const valStr = f.type === 'number_integer' ? String(parseInt(f.val, 10)) : String(f.val).slice(0, 100);
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: valStr, type: f.type });
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

function renderCustomerDetail(session, customer, recentOrders, notes, dropshipCache, b2bConfig, flash) {
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
    : flash === 'b2b_config_saved'
    ? `<div class="alert alert-success">B2B pricing config saved.</div>`
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
        <div class="card" id="b2b-pricing-card">
          <div class="card-header"><h2>B2B Pricing &amp; Terms</h2></div>
          <p class="text-muted small-text" style="margin-bottom:0.75rem">Store defaults: ${h(String(b2bConfig.defaults.discount_pct))}% discount · $${h(String(b2bConfig.defaults.min_order_usd))} min order · ${h(b2bConfig.defaults.payment_terms)}. Leave blank to use default.</p>
          <form method="POST" action="/customers/${h(numId)}/b2b-config">
            <div class="form-row" style="margin-bottom:0.5rem;align-items:center">
              <label style="min-width:120px">Discount %</label>
              <div style="display:flex;align-items:center;gap:0.5rem">
                <input type="number" name="discount_pct" value="${b2bConfig.overrides.discount_pct !== null ? h(String(b2bConfig.overrides.discount_pct)) : ''}" min="0" max="100" step="1" class="input input-sm" style="width:80px" placeholder="${h(String(b2bConfig.defaults.discount_pct))}">
                <span class="badge ${b2bConfig.overrides.discount_pct !== null ? 'badge-warning' : 'badge-muted'}">${b2bConfig.overrides.discount_pct !== null ? 'override: ' + h(String(b2bConfig.effective.discount_pct)) + '%' : 'default'}</span>
              </div>
            </div>
            <div class="form-row" style="margin-bottom:0.5rem;align-items:center">
              <label style="min-width:120px">Min order ($)</label>
              <div style="display:flex;align-items:center;gap:0.5rem">
                <input type="number" name="min_order_usd" value="${b2bConfig.overrides.min_order_usd !== null ? h(String(b2bConfig.overrides.min_order_usd)) : ''}" min="0" step="1" class="input input-sm" style="width:100px" placeholder="${h(String(b2bConfig.defaults.min_order_usd))}">
                <span class="badge ${b2bConfig.overrides.min_order_usd !== null ? 'badge-warning' : 'badge-muted'}">${b2bConfig.overrides.min_order_usd !== null ? 'override: $' + h(String(b2bConfig.effective.min_order_usd)) : 'default'}</span>
              </div>
            </div>
            <div class="form-row" style="margin-bottom:0.5rem;align-items:center">
              <label style="min-width:120px">Payment terms</label>
              <div style="display:flex;align-items:center;gap:0.5rem">
                <input type="text" name="payment_terms" value="${h(b2bConfig.overrides.payment_terms ?? '')}" class="input input-sm" style="width:160px" placeholder="${h(b2bConfig.defaults.payment_terms)}">
                <span class="badge ${b2bConfig.overrides.payment_terms !== null ? 'badge-warning' : 'badge-muted'}">${b2bConfig.overrides.payment_terms !== null ? 'override' : 'default'}</span>
              </div>
            </div>
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save B2B Config</button></div>
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

// ── PWA icon generator ────────────────────────────────────────────────────────
// Creates a minimal RGB PNG at startup (lime green #9BBC0E with "FW" approximated).
function generateIconPng(size, r, g, b) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
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

const ICON_PATH = path.join(__dirname, 'public', 'icon-192.png');
if (!fs.existsSync(ICON_PATH)) {
  fs.writeFileSync(ICON_PATH, generateIconPng(192, 0x9B, 0xBC, 0x0E));
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, app: 'fww-b2b-admin', ts: Date.now() });
});

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

// Phase 4: Orders CSV export (must be before /orders/:id to avoid route conflict)
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

// Phase 4: Customers CSV export
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
app.get('/customers', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', tag: req.query.tag || '', after: req.query.after || '' };
  const data = await getCustomersData(filters);
  res.send(renderCustomersList(req.adminSession, data, filters));
});

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
  res.send(renderCustomerDetail(req.adminSession, customer, recentOrders, notes, dropship, b2bConfig, req.query.success || ''));
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

// ── Phase 7: B2B config overrides ─────────────────────────────────────────────

app.post('/customers/:id/b2b-config', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const before = await getB2bConfig(numId);
  await applyB2bConfigUpdate(numId, req.body);
  const after = await getB2bConfig(numId);
  auditLog(req.adminSession.email, 'customer:b2b-config', shopifyCustomerGid(numId), before.overrides, after.overrides);
  res.redirect(`/customers/${numId}?success=b2b_config_saved`);
});

app.get('/api/admin/customers/:id/b2b-config', requireAuth, async (req, res) => {
  res.json(await getB2bConfig(req.params.id));
});

app.put('/api/admin/customers/:id/b2b-config', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const before = await getB2bConfig(numId);
  await applyB2bConfigUpdate(numId, req.body);
  const after = await getB2bConfig(numId);
  auditLog(req.adminSession.email, 'customer:b2b-config', shopifyCustomerGid(numId), before.overrides, after.overrides);
  res.json({ ok: true, ...after });
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

// ── Phase 3 helpers ───────────────────────────────────────────────────────────

function getStyleFromTags(tags) {
  const t = (tags || []).find(t => t.startsWith('Style_'));
  return t ? t.slice(6) : null;
}

function csvLine(cells) {
  return cells.map(c => {
    const s = c == null ? '' : String(c);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',') + '\n';
}

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

async function getCatalogData({ vendor, style, stock, b2b, page = 1 }) {
  if (MOCK) {
    let prods = MOCK_CATALOG_PRODUCTS.map(p => {
      const ov = mockCatalogOverrides.get(shopifyNumericId(p.id)) || {};
      return { ...p, publishedOnB2B: ov.publishedOnB2B !== undefined ? ov.publishedOnB2B : p.publishedOnB2B };
    });
    if (vendor)      prods = prods.filter(p => p.vendor === vendor);
    if (style)       prods = prods.filter(p => (p.tags || []).includes(`Style_${style}`));
    if (b2b === '1') prods = prods.filter(p => p.publishedOnB2B);
    if (b2b === '0') prods = prods.filter(p => !p.publishedOnB2B);
    if (stock === 'low')  prods = prods.filter(p => { const t = (p.variants?.edges||[]).reduce((s,e) => s+(e.node.inventoryQuantity||0),0); return t > 0 && t < 10; });
    if (stock === 'out')  prods = prods.filter(p => { const t = (p.variants?.edges||[]).reduce((s,e) => s+(e.node.inventoryQuantity||0),0); return t === 0; });
    const vendors = [...new Set(MOCK_CATALOG_PRODUCTS.map(p => p.vendor))];
    const styles  = [...new Set(MOCK_CATALOG_PRODUCTS.flatMap(p => (p.tags||[]).filter(t=>t.startsWith('Style_')).map(t=>t.slice(6))))];
    return { products: prods, vendors, styles, total: prods.length, hasNextPage: false };
  }

  try {
    let qParts = ['product_type:*'];
    if (vendor) qParts.push(`vendor:"${vendor}"`);
    const result = await shopifyFetch(`
      query($q:String!,$after:String){
        products(first:50,query:$q,after:$after,sortKey:TITLE){
          edges{node{
            id title handle vendor tags
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
    return { products: prods, vendors: allVendors, styles: allStyles, total: prods.length, hasNextPage: result.data?.products?.pageInfo?.hasNextPage };
  } catch (err) {
    console.error('getCatalogData error:', err.message);
    return { products: [], vendors: [], styles: [], total: 0, hasNextPage: false, error: err.message };
  }
}

function renderCatalog(session, data, filters) {
  const { products, vendors, styles, error } = data;
  const filterBar = `
    <form method="GET" action="/catalog" class="filter-bar">
      <select name="vendor" onchange="this.form.submit()">
        <option value="">All vendors</option>
        ${(vendors||[]).map(v => `<option value="${h(v)}"${filters.vendor===v?' selected':''}>${h(v)}</option>`).join('')}
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
    return `<tr data-id="${h(numId)}">
      <td><input type="checkbox" name="ids" value="${h(numId)}" class="row-check" onchange="updateBulkBar()"></td>
      <td><a href="/catalog/${h(numId)}" class="link-primary">${h(p.title)}</a></td>
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

app.get('/catalog', requireAuth, async (req, res) => {
  const filters = {
    vendor: req.query.vendor || '',
    style:  req.query.style  || '',
    stock:  req.query.stock  || '',
    b2b:    req.query.b2b    || '',
  };
  const data = await getCatalogData(filters);
  res.send(renderCatalog(req.adminSession, data, filters));
});

app.get('/catalog/:id', requireAuth, async (req, res) => {
  // Redirect to catalog with product highlighted — full detail view is a Phase 4 enhancement
  res.redirect(`/catalog?highlight=${encodeURIComponent(req.params.id)}`);
});

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

// ── Reports ───────────────────────────────────────────────────────────────────

async function getReportsData() {
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

app.get('/reports', requireAuth, async (req, res) => {
  const data = await getReportsData();
  res.send(renderReports(req.adminSession, data));
});

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

function getSettingsData(flash) {
  const settings = {
    b2b_discount_pct: getSetting('b2b_discount_pct') ?? '50',
    order_minimum:    getSetting('order_minimum')    ?? '0',
    payment_terms:    getSetting('payment_terms')    ?? 'Net 30',
  };
  const allowlist = MOCK
    ? ['alex@fuzzywumpets.com', 'alexa@fuzzywumpets.com']
    : (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { settings, allowlist, flash };
}

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

app.get('/settings', requireAuth, (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || (req.query.flash === 'ok' ? 'Settings saved.' : 'Error saving settings.') } : null;
  res.send(renderSettings(req.adminSession, getSettingsData(flash)));
});

app.post('/settings', requireAuth, (req, res) => {
  const { b2b_discount_pct, order_minimum, payment_terms } = req.body;
  try {
    if (b2b_discount_pct !== undefined) setSetting('b2b_discount_pct', String(Number(b2b_discount_pct) || 50));
    if (order_minimum    !== undefined) setSetting('order_minimum',    String(Number(order_minimum)    || 0));
    if (payment_terms    !== undefined) setSetting('payment_terms',    String(payment_terms).slice(0, 100));
    auditLog(req.adminSession.email, 'settings:update', null, null, { b2b_discount_pct, order_minimum, payment_terms });
    res.redirect('/settings?flash=ok&msg=Settings+saved.');
  } catch (err) {
    res.redirect(`/settings?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

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

app.get('/migrate', requireAuth, async (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || '' } : null;
  const data = await getMigrateData();
  res.send(renderMigrate(req.adminSession, data, flash));
});

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

app.get('/audit', requireAuth, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;
  const rows  = getAuditLog({ limit, offset });
  const total = getAuditLogCount();
  const pages = Math.ceil(total / limit);

  const tableRows = rows.map(r => `<tr>
    <td class="mono text-sm">${new Date(r.ts).toISOString().replace('T',' ').slice(0,19)}</td>
    <td>${h(r.email)}</td>
    <td class="mono">${h(r.action)}</td>
    <td class="text-sm text-muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${h(r.target||'—')}</td>
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

async function getOrderForLabels(numericId) {
  if (MOCK) {
    const o = MOCK_ORDERS.find(o => shopifyNumericId(o.id) === numericId);
    if (!o) return null;
    return { order: o, items: o.lineItems.edges.map(e => {
      const v = e.node.variant || {};
      return {
        barcode:      v.barcode || '',
        title:        e.node.title,
        variantTitle: v.displayName || v.sku || 'Default Title',
        sku:          v.sku || '',
        price:        v.price || '0.00',
        qty:          e.node.quantity,
      };
    })};
  }
  const result = await shopifyFetch(`
    query($id:ID!){order(id:$id){
      name
      lineItems(first:50){edges{node{
        title quantity
        variant{id sku price barcode displayName}
      }}}
    }}`, { id: `gid://shopify/Order/${numericId}` });
  const o = result.data?.order;
  if (!o) return null;
  return {
    order: o,
    items: o.lineItems.edges.map(e => ({
      barcode:      e.node.variant?.barcode || '',
      title:        e.node.title,
      variantTitle: e.node.variant?.displayName || e.node.variant?.sku || '',
      sku:          e.node.variant?.sku || '',
      price:        e.node.variant?.price || '0.00',
      qty:          e.node.quantity,
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

app.post('/labels/preview', requireAuth, (req, res) => handleLabelsPdf(req, res, 'inline'));
app.post('/labels/print',   requireAuth, (req, res) => handleLabelsPdf(req, res, 'attachment'));

// ── Phase 6: Exports ──────────────────────────────────────────────────────────

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

app.get('/exports', requireAuth, (req, res) => {
  res.send(renderExportsLanding(req.adminSession));
});

app.get('/exports/csv', requireAuth, async (req, res) => {
  const allIds = await getAllB2bProductIds();
  const products = await getProductsForExport(allIds);
  const select = req.query.select;
  const selectedIds = select === 'none' ? [] : select === 'all' ? allIds : allIds;
  const savedCols = getSetting('last_export_csv_cols', req.adminSession.email);
  const columns = savedCols ? savedCols.split(',') : null;
  res.send(renderExportsCsv(req.adminSession, { products, selectedIds, columns, flash: null }));
});

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

app.get('/exports/images', requireAuth, async (req, res) => {
  const allIds = await getAllB2bProductIds();
  const products = await getProductsForExport(allIds);
  const select = req.query.select;
  const selectedIds = select === 'none' ? [] : allIds;
  const savedMode = getSetting('last_export_img_mode', req.adminSession.email) || 'main-only';
  res.send(renderExportsImages(req.adminSession, { products, selectedIds, mode: savedMode, flash: null }));
});

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

// Static
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT} (MOCK=${MOCK})`);
});
