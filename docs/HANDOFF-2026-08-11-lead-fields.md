# HANDOFF — B2B-1 + B2B-2: lead contact editing + address/tax fields

**Repo:** `fww-b2b-admin` (the standalone INTERNAL staff tool — *not* a duplicate of the customer
portal; treat it as the system of record for staff lead work).
**Branch:** `feat/lead-address-and-edit` (off `main` @ `aae9343`)
**Ship as:** one PR to `Fuzzywumpets/fww-b2b-admin`.

## Why this exists (real, current pain)

Chrissy is travelling and working wholesale leads right now. Lead **#3, Hydref K-9**
(Joanne White, hydrefk9@yahoo.com) came in with an **incomplete address** — the applicant supplied
only `604 Vengeance Creek Road`, no city/state/zip — and a resale tax ID `87-3951696`.

**Neither of those can be stored anywhere in the app today.** They currently survive only as free
text inside a lead note I hand-wrote. When she phones Joanne and gets the missing city/state/zip,
there is no field to put it in and no way to correct anything.

This directly caused a real incident once already: order #38656 shipped to Auckland NZ with the
country stored as "United States". **Do not add address fields that accept anything.** See
"Validation" below.

## Verified starting facts (confirmed by reading the code, 2026-08-11)

1. **There is NO lead edit route.** The complete set is:
   `/leads`, `/leads/new` (GET+POST), `/leads/:id`, `/leads/:id/tax-doc`, `/leads/:id/status`,
   `/leads/:id/note`, `/leads/:id/followup`, `/leads/:id/convert` (GET+POST).
   Verified via `grep -nE "app\.(get|post|put|patch)\(\s*'/leads" server.mjs`.
   So a wrong email/name/phone is permanent.
2. **`leads` has no address columns at all.** Schema (`db.mjs` ~line 90): id, email (UNIQUE),
   business_name, contact_name, phone, website, business_type, estimated_monthly_volume_usd,
   source, source_detail, status, application_data_json, sales_tax_state, sales_tax_id,
   custom_tags, assigned_to, next_followup_due, created_at, updated_at, converted_at,
   shopify_customer_id, rejected_reason — **plus `portal_lead_id` AND `fein`, both added by
   migration** (`db.mjs:356`), so read the migration block, not just the CREATE TABLE.
3. **`sales_tax_id`, `sales_tax_state` and `fein` exist but are UNWRITABLE.** `updateLead()`
   (`db.mjs` ~595) filters against an `allowed` array that omits all three. Adding columns is not
   enough — fix the allow-list too, or the fields will silently no-op.
4. **`createLead()` (`db.mjs` ~487) cannot write them either.** Only `upsertPortalLead()` can.
   **This is the concrete bug behind Hydref K-9:** she was entered by hand, so her tax ID
   was unstorable and had to go in a note. A manually-created lead can never carry a tax ID or FEIN.

## Scope

### 1. Migration — add address columns to `leads`
`address1, address2, city, state, postal_code, country_code`.
Follow the existing migration style in `db.mjs` (idempotent `ALTER TABLE` guarded by a
`PRAGMA table_info` check — match whatever `portal_lead_id` did; do not invent a new mechanism).

### 2. Fix `updateLead()` and `createLead()`
Add the six new columns **plus `sales_tax_id` and `sales_tax_state`** to `updateLead()`'s `allowed`
array and to `createLead()`'s insert. Point 3 above is the trap — verify with a test that a written
value actually reads back.

### 3. New route: `GET/POST /leads/:id/edit`
Server-rendered, matching the existing page style exactly (`layout()`, `renderLeadDetail`
conventions, `h()` escaping on every dynamic value — `content` is injected RAW by `layout()`, so the
caller escapes). Editable: business_name, contact_name, email, phone, website, business_type,
the six address fields, sales_tax_id, sales_tax_state.

- `email` is `UNIQUE` — changing it to one that already exists must fail with a clean flash message,
  not a 500.
- Add an **Edit** button on the lead detail page (`renderLeadDetail`, ~10429).
- Follow the flash convention already used by `/leads/:id/status` (`?flash=` codes mapped in both
  the writer and the renderer).

### 4. Validation — this is the point of the task, not a nicety
Do **not** accept free-text country or state. Reuse the pattern already proven in the portal
(`fww-b2b-portal/server.mjs`: `VALID_SHIP_COUNTRY_CODES`, `PROVINCE_REQUIRED_COUNTRY_CODES`,
`validateShipAddress()` — read it before writing your own):

- country: a **select** of valid ISO-2 codes, never a text input;
- state/province: **required** when country ∈ {US, CA, AU, MX};
- postal code: required; validate US ZIP shape when country is US;
- an address that is partially filled must be rejected with a specific message naming the missing
  field — *not* silently defaulted. **Never default an unknown country to `US`.**

Partial addresses must remain storable as long as they are honestly incomplete (Hydref K-9 has a
street and nothing else) — the rule is: reject *contradictory/invalid* input, allow *incomplete*
input, and make incompleteness visible on the lead page.

### 5. Show it
Surface the address + tax ID in the lead detail PROFILE panel, and flag visibly when the address is
incomplete (Hydref K-9 must read as "address incomplete" at a glance).

## DISCREPANCIES — flag, do not silently "fix"

All verified in code on 2026-08-11. Several are **product decisions for Alex**, not bugs to guess
at. Where a decision is needed, implement the safe option and raise it in the PR body.

### D1. The portal's address never reaches this app — silent UI-level data loss
`portal.db.wholesale_leads` HAS an `address` column ("free-text City/State/Zip from the storefront
form"), plus `products` and `notes`. `upsertPortalLead()` maps **none of them** into `leads` — it
maps only email, business_name, contact_name, phone, website, state, tax_id, fein. The rest survive
only inside the `application_data_json` blob, which no UI renders.
→ **In scope:** when adding address columns, parse/carry `row.address` across (keep the raw text
too — it is free-form "City/State/Zip" and may not parse cleanly). Surface `products`/`notes` on the
lead page, or explicitly say in the PR why not.

### D2. `state` is being stored as a sales-tax state — semantic mismatch
`upsertPortalLead` maps portal `row.state` → `leads.sales_tax_state`. But the portal's `state` is
the **business's location**, while `sales_tax_state` means the state a resale certificate is
registered in. A business in NC registered for sales tax in GA is recorded wrongly today.
→ These are two different fields. The new address `state` should hold location; `sales_tax_state`
should stay the tax-registration state and stop being auto-filled from location. **Flag in the PR** —
changing the existing mapping affects rows already ingested.

### D3. Two tax-ID concepts, and the storefront form conflates them
The portal deliberately separates `tax_id` (STATE resale number) from `fein` (FEDERAL employer id).
But Hydref K-9's submission is labelled **"Resale Tax ID #: 87-3951696"** — and `XX-XXXXXXX` is FEIN
shape, not a state resale number. So the storefront form's label is ambiguous and values are
probably landing in the wrong column across many leads.
→ Do not auto-classify by regex. Surface **both** fields, clearly labelled, and let staff place the
value. Alex decides whether the storefront form gets relabelled (that is B2B-6 territory).

### D4. Two intake channels, only one wired
`upsertPortalLead` hardcodes `source_detail = 'fuzzywumpets.com/pages/wholesale-1'`, implying a wired
form at that page. Yet Hydref K-9 arrived as a **Re:amaze email** and never appeared in Leads at all.
So at least two intake paths exist and only one reaches the database.
→ Out of scope here; recorded for **B2B-6**. Do not attempt to fix intake in this branch.

### D5. `/leads/new` barely validates
`POST /leads/new` checks only that `email` is non-empty, then passes `req.body` straight to
`createLead`. No email-format check, no phone normalisation. (Not a mass-assignment hole —
`createLead` picks fields explicitly — but bad data enters freely.)
→ **In scope:** apply the same validation to `/leads/new` as to `/leads/:id/edit`. One shared
validator, not two copies. Mark it `// SYNC:` if it ends up duplicated.

### D6. `business_type` is being used as free text — **CORRECTED 2026-08-11, this was wrong**
Originally reported as free text because lead #3 held prose ("dog grooming and supply shop, dog
show vendor booth"). That was a false read: `renderLeadNew` already renders `business_type` as a
constrained `<select>` (`boutique`/`trainer`/`kennel`/`show-vendor`/`groomer`/`other`) — lead #3
only looked like free text because it was entered by hand via `createLead()`, bypassing the form
entirely. Nothing enforces the vocabulary at the DB/ingest layer, so `createLead`/`upsertPortalLead`
can still write anything; the two `<select>`s are the only actual enforcement. Lead #3 has since
been corrected in the live DB to `business_type='groomer'` with `custom_tags='show-vendor,retail'`.
→ The edit page (`/leads/:id/edit`) uses the SAME option list as `/leads/new`, factored into the
shared `LEAD_BUSINESS_TYPES` constant (marked `// SYNC:`) so the two forms can't drift.
→ Real product question, not a bug: the vocabulary is single-select, but a real business can be
several at once (this one is a groomer *and* a show vendor *and* a retail shop). `custom_tags` is
the current escape hatch. Left as a question for Alex, not redesigned here.

### D7. No merge/delete path for leads
`leads.email` is UNIQUE while portal `wholesale_leads.email` is NOT, so duplicate applications
collapse onto one admin row silently, and there is no way to merge or remove a lead created in error.
→ Out of scope. Noted for the backlog.

## Out of scope — do not touch
- `/leads/:id/convert` (passing the address into Shopify is **B2B-7**, a separate task, blocked on this one).
- The invite/onboarding flow (**B2B-5**) — no invite work in this branch.
- The lead status machine (**B2B-4**).
- Anything in `fww-b2b-portal`.
- `HANDOFF.md` at the repo root — 3,515 lines of build history, leave it alone.

## Testing (required)
```bash
npm ci          # worktrees do NOT share node_modules with the main checkout
./run-tests.sh  # must be green before the PR
```
Add tests for: the migration is idempotent; `updateLead` actually persists each new field (the
allow-list trap); a bad/absent country is rejected rather than defaulted; a duplicate email fails
cleanly.

**Live verification, not just selectors:** drive the real page and confirm the values persist —
scripted `.value` assignment bypasses focus and gives a false pass. Test with a hostile value in a
text field (e.g. a business name containing `"` and `'`) to confirm escaping holds.

## House rules that apply
- Ship as a **PR**, never a direct push to `main`.
- Mark real coupling with `// DEPENDS:` / `// SYNC:` comments in the same change that creates it.
- Before changing anything shared, grep for consumers and update them in the same change.
- Match the surrounding comment style — this repo uses `// WHAT:` / `// CHANGE-GUARD:` /
  `// INVARIANT(S):` headers on non-trivial functions. Follow it.
- Do not "while I'm in here" refactor. List suggestions in the PR body instead.

## Definition of done
- [ ] Migration applied idempotently; existing rows unaffected
- [ ] All eight fields writable and reading back (verified by test)
- [ ] `/leads/:id/edit` reachable from lead detail; saves; rejects invalid country/state
- [ ] Hydref K-9 (lead #3) can have city/state/zip added and her tax ID recorded
- [ ] `./run-tests.sh` green
- [ ] PR opened with the incomplete-address rationale in the body
