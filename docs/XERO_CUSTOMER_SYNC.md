# Xero Customer Sync — FWW B2B Admin (Phase 21)

This document describes the bidirectional Shopify ↔ Xero customer sync
for `fww-b2b-admin`. Written 2026-05-26.

## Key facts

- **Primary mapping key:** Xero `Contact.AccountNumber` = numeric Shopify customer ID
  (e.g. `"8902606455019"`). This is stable and survives Xero contact merges.
- **Mapping file:** `data/shopify_to_xero_mapping.json` — in-repo, safe to commit.
  Contains all 40 B2B contacts migrated 2026-05-26.
- **B2B ContactGroup:** `c5afb0f1-8a59-4db8-be57-83548c361669`
  All new B2B customers are automatically added here on sync.
- **Tracking category:** Customer Type → B2B  
  Category ID: `d7d93d75-877a-4e9e-89de-69e7159dc9d2`  
  Option ID: `5fe38929-9904-412c-8e43-ecb410d6749d`
- **Wholesale income account:** `4150` (Sales:B2B Sales)
- **Default currency:** USD
- **Xero bridge URL:** `https://fww-xero-bridge.alex-037.workers.dev/xero`
  Bearer token: `XERO_BRIDGE_BEARER` in Doppler

## Insider exclusions (NEVER sync)

| Name | Shopify customer ID |
|------|---------------------|
| Alexander Lass | `4742401425601` |
| Mason Flowers | `5163530813633` |

These are internal accounts. Attempting to sync them returns `{ skipped: 'insider' }`.

## Merged contacts

Two Shopify customers map to a single Xero contact:

| Shopify ID | Name | Xero Contact | Primary? |
|------------|------|--------------|----------|
| `6909696999659` | Angie Roe | Pro-Mohs Canine Supply | merged (child) |
| `5462357967041` | Mike Ward | Pro-Mohs Canine Supply | primary |
| `7669502509291` | Bradley Phifer | The Dog Shoppe | merged (child) |
| `8902606455019` | The Dog Shoppe | The Dog Shoppe | primary |

The admin shows a "⚭ Merged contact" badge with a link to the primary.

## Sync triggers (Phase 21C)

1. **Lead conversion** (`/leads/:id/convert`): non-blocking async sync fires after
   Shopify customer creation.
2. **Manual b2b tag add** (`/customers/:id/tags/add` with `tag=b2b`): non-blocking
   async sync fires after the tag is saved.
3. **Manual sync button** on `/customers/:id`: POST `/api/admin/customers/:id/xero-sync`

## Lookup order (resolveXeroContact)

1. Local `data/shopify_to_xero_mapping.json` by Shopify customer ID → O(1) hash lookup
2. Live Xero query: `GET /Contacts?where=AccountNumber=="<id>"` via bridge
3. Returns `null` if not found

When a live query finds the contact, the mapping file is updated for future requests.

## Pat Walsh — pending review

Pat Walsh (Shopify ID — confirm from Shopify admin, check top-15 by spend) still pending
in `approved.json` on alexa's local at `~/projects/qbo-to-xero/b2b-push/`. Action:
run `node review.mjs` from that directory to push her contact. Then:

```bash
# Re-export mapping and update VPS copy
scp ~/projects/qbo-to-xero/b2b-push/output/shopify_to_xero_mapping.json \
    fww-vps-1:~/projects/fww-b2b-admin/data/shopify_to_xero_mapping.json
cd ~/projects/fww-b2b-admin && git add data/shopify_to_xero_mapping.json && git commit -m "update Xero mapping: add Pat Walsh"
```

## Xero API operations used

```
# Create/upsert contact
PUT /api.xro/2.0/Contacts
{ "Contacts": [{ Name, AccountNumber, EmailAddress, DefaultCurrency, SalesDefaultAccountCode, ... }] }

# Add to B2B ContactGroup
PUT /api.xro/2.0/ContactGroups/{groupId}/Contacts
{ "Contacts": [{ "ContactID": "..." }] }

# Look up contact by AccountNumber
GET /api.xro/2.0/Contacts?where=AccountNumber=="<shopify_id>"
```

## Integration with Phase 18 (Xero invoice booking)

`createXeroInvoice` in `server.mjs` calls `resolveXeroContact` before creating a
new contact, ensuring no duplicate contacts are created for existing B2B customers.
If a customer has the `b2b` tag but is not yet in Xero, `syncCustomerToXero` is
triggered first via the tag-add hook.
