# SCRATCH — cross-iteration notes for fww-b2b-admin overnight loop

(Seed file. Append your own notes as you work. Future iterations have NO in-context memory
of prior runs — write down anything you'll need.)

## Critical IDs (don't re-discover these)

- **B2B publication** ("Fuzzywumpets B2B"): `gid://shopify/Publication/199709720811`
- **SparkLayer publication** (read-only, transition only): `gid://shopify/Publication/107823366379`
- **Online Store publication**: `gid://shopify/Publication/71671611585`
- **GCP project**: `fww-bill-scanner`
- **OAuth client name**: `fww-b2b-admin`
- **Google OAuth redirect URI**: `https://b2badmin.fuzzywumpets.com/auth/google/callback`

## Tag conventions (Shopify customers)

- `b2b` — required for portal login (separate app)
- `b2b-admin` — extra signal for admin users (we ALSO check email allowlist in Doppler)
- `b2b-tier:gold` / `b2b-tier:silver` etc. — pricing tier (informational only for now; flat 50% applies)
- `b2b-dropship` will appear on orders when customer's dropship is enabled

## Shopify Admin API via shopify-bridge (ONLY path for Shopify writes)

```
POST https://shopify-bridge.alex-037.workers.dev/api/graphql
Authorization: Bearer $SHOPIFY_BRIDGE_BEARER
Content-Type: application/json
{ "query": "...", "variables": {...} }
```

## Google OAuth flow (auth that you're building)

- Authorization endpoint: `https://accounts.google.com/o/oauth2/v2/auth`
  - params: client_id, redirect_uri, response_type=code, scope="openid email profile", access_type=offline, prompt=consent, state=<csrf>
- Token endpoint: `https://oauth2.googleapis.com/token`
  - POST form: grant_type=authorization_code, code, redirect_uri, client_id, client_secret
- Userinfo endpoint: `https://openidconnect.googleapis.com/v1/userinfo`
  - GET with Bearer access_token; returns { email, email_verified, name, picture, sub }
- After verify email is in allowlist: mint own session, set cookie, redirect /

## Reading b2b-portal SQLite (read-only)

```js
import Database from 'better-sqlite3';
const portalDb = new Database('/home/alexa/projects/fww-b2b-portal/data/portal.db', { readonly: true, fileMustExist: true });
// portal tables: sessions, carts, cart_items, orders_log, admin_audit_log, saved_lists, saved_list_items, favorites
```

## Useful GraphQL queries (tested-working as of 2026-05-26)

### Orders tagged `b2b-portal` (the orders the b2b portal creates)
```graphql
query($q: String!, $after: String) {
  orders(first: 50, query: $q, after: $after, sortKey: PROCESSED_AT, reverse: true) {
    edges { cursor node {
      id name processedAt customer { id displayName email }
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { presentmentMoney { amount currencyCode } }
      lineItems(first: 5) { edges { node { title quantity variant { sku } } } }
      note tags
    }}
    pageInfo { hasNextPage }
  }
}
# variables: { "q": "tag:b2b-portal created_at:>2026-04-01" }
```

### Customer detail with tags + metafields
```graphql
query($id: ID!) {
  customer(id: $id) {
    id email displayName phone tags
    addresses(first: 5) { id firstName lastName address1 city province zip country }
    defaultAddress { id firstName lastName address1 city province zip country phone }
    metafields(first: 20, namespace: "b2b") { edges { node { id namespace key value type } } }
  }
}
```

### Set metafield (dropship config)
```graphql
mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id key namespace value }
    userErrors { field message }
  }
}
# variables: { "metafields": [
#   { "ownerId": "gid://shopify/Customer/...", "namespace": "b2b", "key": "dropship_enabled", "value": "true", "type": "boolean" },
#   { "ownerId": "gid://shopify/Customer/...", "namespace": "b2b", "key": "dropship_margin_pct", "value": "30", "type": "number_integer" }
# ]}
```

### Mark order as paid
```graphql
mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus }
    userErrors { field message }
  }
}
# variables: { "input": { "id": "gid://shopify/Order/..." } }
```

### Add note to order
```graphql
mutation orderUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id note }
    userErrors { field message }
  }
}
# variables: { "input": { "id": "gid://shopify/Order/...", "note": "Marked paid via admin 2026-05-26" } }
```

### Add tags to customer (idempotent)
```graphql
mutation tagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}
```

### Publish a product TO the B2B publication
```graphql
mutation pub($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
# variables: { "id": "gid://shopify/Product/...", "input": [{ "publicationId": "gid://shopify/Publication/199709720811" }] }
```

### Unpublish a product FROM the B2B publication
```graphql
mutation unpub($id: ID!, $input: [PublicationInput!]!) {
  publishableUnpublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
```

## Brand kit

Colors: Lime Light `#9BBC0E`, Ivory Curtain `#FFFFFF`, Marquee Blue `#D9E8FF`,
Curtain Call Blue `#2086BA`, Backstage Black `#000000`.
Fonts: Inter (body), Playfair Display (headings).
Google Fonts: `family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700`

For admin (vs portal), lean denser + more utilitarian. Use:
- Smaller heading sizes
- More monospace-feel data tables
- Sticky table headers
- Lime accent on active row / selected state
- Marquee Blue for header background instead of pure white

## Service management

```
sudo systemctl restart fww-b2b-admin.service
sudo systemctl status fww-b2b-admin.service
journalctl -u fww-b2b-admin.service -n 100
tail -n 100 ~/projects/fww-b2b-admin/runs/serverlog.log
```

After editing server.mjs: restart the service to pick up changes.

## File layout

```
fww-b2b-admin/
├── HANDOFF.md
├── SCRATCH.md            # this file
├── STATUS.md
├── RESEARCH.md           # Phase 0 output (you write this)
├── README.md
├── server.mjs            # Express app
├── db.mjs                # SQLite migrations + helpers (build in Phase 1)
├── public/
│   └── index.html        # placeholder for now; replace with login page
├── test/
│   ├── api.test.mjs      # build in Phase 1
│   └── ui.test.mjs       # build in Phase 1
├── data/                 # gitignored — admin.db lives here
├── runs/                 # gitignored — logs, screenshots
├── package.json
├── run-tests.sh
└── loop.sh
```

## Append below this line, future iterations
---
