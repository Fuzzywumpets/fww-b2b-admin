/**
 * Xero customer sync helpers for Phase 21.
 *
 * Bidirectional mapping between Shopify customer IDs and Xero ContactIDs.
 * Mapping file: data/shopify_to_xero_mapping.json (in-repo, safe to commit).
 *
 * xeroRequest(method, path, body) must be injected by callers (from server.mjs)
 * so mock mode works transparently without this module knowing about env vars.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir         = dirname(fileURLToPath(import.meta.url));
const MAPPING_PATH  = join(__dir, '../data/shopify_to_xero_mapping.json');

const INSIDER_IDS         = ['4742401425601', '5163530813633'];
const B2B_CONTACT_GROUP   = 'c5afb0f1-8a59-4db8-be57-83548c361669';

// ── mapping I/O ───────────────────────────────────────────────────────────────

function loadMapping() {
  try { return JSON.parse(readFileSync(MAPPING_PATH, 'utf8')); }
  catch { return { by_shopify_id: {}, by_xero_contact_id: {} }; }
}

function saveMapping(m, { dryRun = false } = {}) {
  if (!dryRun) {
    try { writeFileSync(MAPPING_PATH, JSON.stringify(m, null, 2) + '\n'); }
    catch (e) { console.error('[xero-sync] could not write mapping:', e.message); }
  }
}

// ── exports ───────────────────────────────────────────────────────────────────

export function isInsider(shopifyCustomerId) {
  return INSIDER_IDS.includes(String(shopifyCustomerId));
}

/**
 * Resolve a Shopify customer ID → Xero contact.
 * Checks mapping file first; if not found and xeroRequest is supplied, queries live.
 * Returns { xeroContactId, xeroName, isMerged, source } or null.
 */
// WHAT: resolves a Shopify customer id to its Xero contact, checking the local mapping file first and falling back to a live Xero query by AccountNumber, caching any live hit back into the mapping.
// CHANGE-GUARD: the live query interpolates the id into a Xero where-clause (AccountNumber=="<id>") — ids are numeric Shopify ids so injection risk is low, but never pass unsanitized free text here; re-test the URL-encoding of the where param.
// INVARIANT(S): returns null for insiders and on any error (callers treat null as not_synced); a successful live lookup MUST update both by_shopify_id and by_xero_contact_id halves of the mapping to keep them consistent.
export async function resolveXeroContact(shopifyCustomerId, xeroRequest = null, { dryRun = false } = {}) {
  const id = String(shopifyCustomerId);
  if (isInsider(id)) return null;

  const m     = loadMapping();
  const entry = m.by_shopify_id[id];
  if (entry) {
    return {
      xeroContactId: entry.xero_contact_id,
      xeroName:      entry.xero_name,
      isMerged:      !!entry.merged,
      source:        'mapping',
    };
  }

  if (!xeroRequest) return null;

  try {
    const res     = await xeroRequest('GET', `/api.xro/2.0/Contacts?where=AccountNumber%3D%3D%22${id}%22`);
    const contact = res.body?.Contacts?.[0];
    if (contact?.ContactID) {
      const fresh = loadMapping();
      fresh.by_shopify_id[id] = {
        xero_contact_id: contact.ContactID,
        xero_name:       contact.Name,
        merged:          false,
      };
      const cEntry = fresh.by_xero_contact_id[contact.ContactID];
      if (!cEntry) {
        fresh.by_xero_contact_id[contact.ContactID] = { name: contact.Name, shopify_customer_ids: [id] };
      } else if (!cEntry.shopify_customer_ids.includes(id)) {
        cEntry.shopify_customer_ids.push(id);
      }
      saveMapping(fresh, { dryRun });
      return { xeroContactId: contact.ContactID, xeroName: contact.Name, isMerged: false, source: 'live' };
    }
  } catch (e) {
    console.error('[xero-sync] live lookup failed:', e.message);
  }

  return null;
}

/**
 * Create a Xero contact for a Shopify customer (b2b-tagged).
 * Idempotent — checks mapping + live first; no-op if already exists.
 * Returns { xeroContactId, xeroName, created: bool } or { xeroContactId: null, skipped }.
 */
// WHAT: idempotently creates a B2B-tagged Xero contact for a Shopify customer (AccountNumber = numeric Shopify id), adds it to the B2B ContactGroup, and persists the bidirectional mapping file.
// CHANGE-GUARD: idempotency relies on resolveXeroContact (mapping file + live AccountNumber lookup) running first — if the mapping file is lost or the AccountNumber convention changes, this will create DUPLICATE Xero contacts; re-test against an already-synced customer after any change.
// INVARIANT(S): insiders (INSIDER_IDS) are always skipped; AccountNumber must stay the numeric Shopify id (cross-service join key with resolveXeroContact); ContactGroup add is non-fatal; mapping write is skipped under dryRun.
export async function syncCustomerToXero(shopifyCustomerId, customerData, xeroRequest, { dryRun = false } = {}) {
  const id = String(shopifyCustomerId);

  if (isInsider(id)) {
    return { xeroContactId: null, skipped: 'insider' };
  }

  const existing = await resolveXeroContact(id, xeroRequest, { dryRun });
  if (existing) {
    return { xeroContactId: existing.xeroContactId, xeroName: existing.xeroName, created: false };
  }

  // Derive best display name: company > full name > email
  const name = (customerData.defaultAddress?.company || '').trim()
    || ([customerData.firstName, customerData.lastName].filter(Boolean).join(' ').trim())
    || (customerData.displayName || '').trim()
    || customerData.email
    || 'Unknown';

  const contactPayload = {
    Name:                    name,
    AccountNumber:           id,
    EmailAddress:            customerData.email || '',
    DefaultCurrency:         'USD',
    SalesDefaultAccountCode: '4150',
    SalesTrackingCategories: [{
      TrackingCategoryName: 'Customer Type',
      TrackingOptionName:   'B2B',
    }],
  };

  if (customerData.firstName && customerData.lastName) {
    contactPayload.ContactPersons = [{
      FirstName:        customerData.firstName,
      LastName:         customerData.lastName,
      EmailAddress:     customerData.email || '',
      IncludeInEmails:  true,
    }];
  }

  const a = customerData.defaultAddress;
  if (a) {
    contactPayload.Addresses = [{
      AddressType: 'STREET',
      AddressLine1: a.address1 || '',
      City:         a.city     || '',
      Region:       a.province || '',
      PostalCode:   a.zip      || '',
      Country:      a.country  || '',
    }];
  }

  const createRes = await xeroRequest('PUT', '/api.xro/2.0/Contacts', { Contacts: [contactPayload] });
  const contact   = createRes.body?.Contacts?.[0];
  if (!contact?.ContactID) {
    throw new Error('Xero contact creation failed: ' + JSON.stringify(createRes.body).slice(0, 300));
  }

  // Add to B2B ContactGroup (non-fatal if it fails)
  try {
    await xeroRequest('PUT', `/api.xro/2.0/ContactGroups/${B2B_CONTACT_GROUP}/Contacts`, {
      Contacts: [{ ContactID: contact.ContactID }],
    });
  } catch (e) {
    console.error('[xero-sync] ContactGroup add failed:', e.message);
  }

  // Persist to mapping
  const fresh = loadMapping();
  fresh.by_shopify_id[id] = {
    xero_contact_id: contact.ContactID,
    xero_name:       contact.Name || name,
    merged:          false,
  };
  if (!fresh.by_xero_contact_id[contact.ContactID]) {
    fresh.by_xero_contact_id[contact.ContactID] = { name: contact.Name || name, shopify_customer_ids: [id] };
  }
  saveMapping(fresh, { dryRun });

  return { xeroContactId: contact.ContactID, xeroName: contact.Name || name, created: true };
}

/**
 * Return a UI-friendly status object for a customer's Xero sync state.
 * state: 'insider' | 'synced' | 'merged' | 'not_synced'
 */
export async function getXeroSyncStatus(shopifyCustomerId, xeroRequest, { dryRun = false } = {}) {
  const id = String(shopifyCustomerId);

  if (isInsider(id)) {
    return { state: 'insider', xeroContactId: null, xeroName: null, isMerged: false };
  }

  const resolved = await resolveXeroContact(id, xeroRequest, { dryRun });
  if (!resolved) {
    return { state: 'not_synced', xeroContactId: null, xeroName: null, isMerged: false };
  }

  // Find the primary Shopify customer for a merged contact
  let primaryShopifyId = null;
  if (resolved.isMerged) {
    const m     = loadMapping();
    const cEntry = m.by_xero_contact_id[resolved.xeroContactId];
    if (cEntry) {
      // Primary = the one with merged: false for this contactId
      const allIds  = cEntry.shopify_customer_ids || [];
      const primary = allIds.find(sid => {
        const e = m.by_shopify_id[sid];
        return e && !e.merged && e.xero_contact_id === resolved.xeroContactId;
      });
      primaryShopifyId = primary || null;
    }
  }

  return {
    state:           resolved.isMerged ? 'merged' : 'synced',
    xeroContactId:   resolved.xeroContactId,
    xeroName:        resolved.xeroName,
    isMerged:        resolved.isMerged,
    primaryShopifyId,
    source:          resolved.source,
  };
}
