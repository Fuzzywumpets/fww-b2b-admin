# B2B estate — how the two apps fit together

**Canonical.** Both repos' `CLAUDE.md` point here. If this file and your memory disagree, this file
wins — update it in the same PR as the change that made it wrong.

Every fact below was verified against running production on 2026-08-11, not inferred from source.
Where something is unverified it says so.

---

## 1. Two apps, and which is which

| | `fww-b2b-portal` | `fww-b2b-admin` |
|---|---|---|
| For | **customers** | **staff** |
| Domain | b2b.fuzzyreporting.com | b2badmin.fuzzywumpets.com |
| Port (localhost only) | 8793 | 8794 |
| DB | `data/portal.db` | `data/admin.db` |
| Login | **Shopify** Customer Account OAuth | **Google** OAuth |
| Unit | `fww-b2b-portal.service` | `fww-b2b-admin.service` |

`fww-b2b-admin` is **not** a duplicate of the portal's admin pages. It is the intended standalone
internal tool. Its impersonation feature ("drop into a customer's account to troubleshoot") is
deliberate. The portal's own `/admin/*` pages are the accident — see §6.

---

## 2. THE ORDER OF OPERATIONS (this is the one that keeps getting lost)

**The invitation goes first. The Shopify customer account is created at the END of onboarding, by
the customer completing it.**

```
wholesale application            fuzzywumpets.com/pages/wholesale-1
  -> POST /api/leads/apply       portal; row in portal.db.wholesale_leads; mirrored to Re:amaze
  -> ingested into admin.db.leads on every /leads render (read-only, one way)
  -> staff work the lead in b2badmin, set it to `approved`
  -> "Send Portal Invite"        b2badmin POST /leads/:id/invite
                                 -> portal POST /__internal__/invites
                                 -> emails a one-time /onboard/<token>, 14-day expiry
  -> customer sets a password, fills the profile, agreement is signed
  -> portal POST /api/onboard/complete
        customerCreate + tagsAdd 'b2b'      <-- THE SHOPIFY CUSTOMER IS BORN HERE
        portal_credentials activated, session minted, dropped into /catalog
```

### Convert is the EXCEPTION, never a step in the above
`b2badmin /leads/:id/convert` creates the Shopify customer **immediately** — tagged `b2b`, with
discount / order-on-invoice / dropship metafields and a Xero contact — but with **no portal login,
no password, no agreement**. It is for a customer who will never use the portal and whose orders
staff key in themselves (phone, email, trade show).

**Do not do both.** Converting first prepares nothing: `/api/onboard/complete` then finds the email
taken and falls back to reusing that record. The tell that someone did both is a `converted` lead
whose invite is still `pending`.

The lead page reflects this: Invite is the primary button, Convert is a ghost button labelled
"Create customer without portal access…", and once an invite exists the button becomes an
"Invited · <status>" badge.

---

## 3. Auth — and why staff cannot use the portal's admin pages

**b2badmin (staff):** Google OAuth. Admitted only if `email_verified` AND the address matches
`B2B_ADMIN_ALLOWED_EMAILS`, which lives in **Doppler**, not `.env`. An entry is either a whole
address or a bare domain with a leading `@`. Live value: `@fuzzywumpets.com,erin.m.karson@gmail.com`
— so every Workspace account has full access with no list to maintain. Matching is
`isAllowedAdminEmail()`; it compares the substring after the LAST `@` for equality (never
endsWith/includes — see `test/admin-allowlist.test.mjs` for the four bypasses that defeats).

**portal (customers):** Shopify Customer Account OAuth. `/auth/callback` rejects anyone whose
Shopify customer record lacks the **`b2b` tag**, *before* any admin check runs. No member of staff
is a tagged B2B customer, so the portal's `/admin/*` pages are unreachable by staff. Real example:

> `alex@fuzzywumpets.com is not authorized for the B2B portal. (Required tag: "b2b". Found:
> lapsed-15for15-2026, Login with Shop, Shop.)`

**Never "fix" this by tagging a staff member `b2b`.** Staff should not have to become customers to
use a staff tool, and the live theme's `b2b-redirect` snippet falls back to that same tag — a tagged
staff member gets bounced off fuzzywumpets.com whenever logged in. The correct fix is to expose the
operation to b2badmin over `/__internal__/*`, which is how invites now work.

---

## 4. Secrets: NEVER grep `.env`

Both services start under `doppler run`, so secrets exist **only in the live process environment**.
`.env` greps return false negatives — this has produced wrong "it's unset in prod" conclusions more
than once. Correct check:

The Helcim credit-card invoice action additionally requires `HELCIM_API_TOKEN` and
`HELCIM_SUBDOMAIN_URL` (`https://fuzzywumpets.myhelcim.com`) from the shared Doppler config. The API
token remains server-side; customers receive only Helcim's per-invoice online-view URL.

```sh
P=$(systemctl show -p MainPID --value <unit>)
C=$(pgrep -P $P -f node | head -1)   # MainPID is doppler/bash; the CHILD holds the env
sudo cat /proc/${C:-$P}/environ | tr "\0" "\n" | grep "^NAME="
```

Env presence still isn't proof a feature works. Prove the path with a **negative control**:

```sh
curl -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOK" http://127.0.0.1:8793/__internal__/invites  # 200
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8793/__internal__/invites                                   # 401
```

---

## 5. The cross-app channel

b2badmin → portal over `/__internal__/*`, bearer `B2B_PORTAL_INTERNAL_TOKEN` (shared, in Doppler),
via `callPortalInternal()` → `PORTAL_INTERNAL_URL` (default `http://127.0.0.1:8793`). It returns
`{ ok, ...json }` and **fails closed** to `{ok:false}` — it never throws.

Live endpoints: `visible-note`, `customer-messages`, `conversations/:slug/messages`,
`tax-exempt/:id/{approve,reject}`, `settings`, `leads/:id/tax-doc`, `theme-feedback`,
**`invites` (POST create + GET list)**.

Rules for adding one: share the implementation with the session-authenticated route (a drifting
invite path is how you email a second live token to someone who already has one); require the
caller's human email so the audit trail names a person, not the tool; and note that
`admin_audit_log.admin_customer_id` is `NOT NULL`, so internal callers pass a `system:b2badmin`
sentinel — passing `null` throws and 500s the request.

### `visible-note` and the credit-card invoice email

`POST /__internal__/visible-note` stores a customer-visible order note and optionally emails it
(`emailCustomer`, default true). Ordinary notes go out through Re:amaze (`sendAs`, optional `subject`).
The **Send Credit Card Invoice** button (`POST /orders/:id/send-credit-card-invoice`) additionally
passes a structured **`creditCardInvoice`** object, which switches the Portal to a direct Gmail send:

```
creditCardInvoice: { orderName, amount, currency, payUrl, staffNote }
```

- Producer: Admin `lib/helcim-note.mjs` `buildCreditCardInvoicePayload`. Receiver: Portal
  `gmail-invoice.mjs` `validateCreditCardInvoiceInput`. The Portal validates the shape and answers
  **400 before storing anything** (`orderName` string ≤100, `amount` finite ≥0, `currency` three
  uppercase letters, `staffNote` ≤500 chars, `payUrl` on an allow-listed host: exactly
  `b2b.fuzzywumpets.com/pay/<token>` or `fuzzywumpets.myhelcim.com/order/?token=<token>`).
  Change a field name or the host rule on one side and you must change the other in the same release.
- `staffNote` is the optional note the staffer types in the modal. It is HTML-escaped in the email
  (rendered as a quote block, `> ` lines in the text part), so Markdown or tags in it show literally.
- Sender identity: **From `Fuzzywumpets Wholesale <help@fuzzywumpets.com>`, Reply-To
  `wholesale@fuzzywumpets.com`**, sent through the `fww-bill-scanner` broker (`account=alex`,
  `gmail.send` token; Portal env `BILL_SCANNER_WORKER_URL` + `BILL_SCANNER_BRIDGE_BEARER`). The
  Portal owns this identity; the `sendAs: 'wholesale'` Admin still sends only affects the legacy
  Re:amaze path and is ignored on the Gmail path. `wholesale@` is a Google **Group**, not a send-as
  alias, so it cannot be the From (Gmail silently rewrites From to `alex@`). **`help@` must stay a
  verified send-as on `alex@`'s Gmail**, or the From reverts to `alex@` with no error.
- The subject is built by Admin (`Your invoice from Fuzzywumpets is ready - order #NNNNN`, no
  forced `Re:`); keep the `#NNNNN` token in it, because the Portal scopes Re:amaze threads to an
  order by that order name (`getCustomerWholesaleThreads`).
- Failure: a Gmail/broker error comes back as `email:{sent:false,error}` and Admin records
  `helcim_invoice_email_failed` (with `hasNote` and `note`). There is deliberately **no fallback to
  Re:amaze**, because that would bring the `Re:` prefix back and double-send on retry. A Gmail 401
  drops the Portal's cached broker token, so the next staff retry recovers.
- Gmail-sent invoices are not Re:amaze conversations, so they do not appear in the order page's
  customer-messages box; the Portal still stores the body as a customer-visible order note.
- Compatibility: an absent `creditCardInvoice` keeps the legacy Re:amaze path unchanged, so an old
  Admin with a new Portal is safe. A new Admin with an old Portal sends the legacy Re:amaze email
  with the staff note unescaped, so **deploy the Portal first**.

---

## 6. Settled decisions — do not re-litigate

- Nothing lead/onboarding/invite-related belongs in the customer-facing portal. The portal still
  carries `/admin/*` pages; removing them is tracked, and **portal PR #9 must not be merged until
  b2badmin fully replaces what it deletes** — it is the REMOVE half of a two-repo move.
- Promo codes: never offered, never applied, invisible to B2B customers.
- Selling channels on the wholesale form are checkboxes composed into `notes`. **No `channels`
  column.** ("Notes is fine — just need them to choose one/many. Don't need a table.")
- The wholesale application requires **both** the resale tax ID number and a FEIN/EIN. The exemption
  **certificate** is optional at application time — it is only needed once we consent to doing
  business.
- `approved` is reachable directly from `new` and from every `waiting_*` state. Review is available,
  not compulsory.
- Admin (company team role) cannot be granted through the app; team revoke is removed entirely. Both
  are Fuzzywumpets actions.
- Pre-order badge: removed for good 2026-07-02, guarded by `REGRESSION:` tests. Products are In
  stock / Out of stock only.
- **The Orders list (`GET /orders`) is served from the local `orders_cache`, not from Shopify.** The cache
  is refreshed by the Shopify `orders/updated` webhook (lands 2–3 s after a change) and a ~3-minute poller.
  So anything that changes an order's status and then redirects to the list must write that status through
  itself, or the page paints the old one under a success banner (the 2026-10-27 "Mark Paid does nothing"
  report: Shopify had marked #39748 paid, the list still said PENDING). `POST /orders/bulk` (Mark Paid)
  does this via `setOrderFinancialStatusInCache` — two columns, fail-open, never `synced_at`; the webhook
  and poller still own the row and overwrite it whole. The success banner (`?success=marked_paid`) is
  reachable only after a mark-paid that moved at least one order: no ids → `?error=mark_paid_none`,
  unknown action → `?error=bulk_unknown_action`, any refusal → `?error=mark_paid_partial`. The bulk bar is
  hidden until a row is ticked (`.bulk-bar[hidden]` in `public/admin.css`). Pinned end to end, in a real
  browser against the real server, by `test/orders-bulk-markpaid.test.mjs`.

---

## 7. Deploying

```sh
ssh alexa@5.161.212.16
cd ~/projects/<repo> && git pull --ff-only origin main
sudo systemctl restart <unit>
```

Then verify — a 200 is not proof. Check the deployed commit equals `origin/main`, the service is
active, the log has no startup errors, and **grep the deployed file for the thing you shipped**.

Traps:
- `./run-tests.sh` must be green before merging (both repos).
- The portal's real entrypoint is `scripts/start-prod.sh` (now tracked). It runs a dependency guard
  then `exec doppler run -- node server.mjs`.
- Leaving a browser/preview pane open makes the portal's UX suite fail — it contends for the browser.
- On Windows, `git` may store CRLF; `*.sh` is pinned to LF via `.gitattributes` because a CRLF
  shebang makes systemd fail with "bad interpreter".

---

## 8. Known-open

- Portal `/admin/*` removal (blocked on the above), and whether `/onboard/{token}` moves to the
  b2badmin domain.
- A team `member` can still invite/revoke other members: `req.session` carries no company role
  (`getSess` omits `company_data`; `getSessWithCompany` is dead code) and a team-member session is
  bound to the company's PRIMARY `customerId`, so the endpoints cannot tell a member from the owner.
  The escalation half (granting admin) is closed.
- Staff **Mark Paid** is two code paths with different side effects: `POST /orders/bulk` (Orders list)
  writes the status through to `orders_cache` but does **not** record the payment in Xero;
  `POST /orders/:id/mark-paid` (order page) records it in Xero but does not touch `orders_cache` (it
  redirects to the order page, which reads Shopify live, so only the list is stale for the 2–3 s webhook
  window). Neither notifies anyone — a "payment received" notification is a separate, undecided item.
  Both paths leave the same breadcrumb on the order itself: a `[date UTC] Marked paid manually by <who>`
  line **appended** to the **Admin-only** order note (`order_internal_notes`, via `notePaidManually` →
  `lib/paid-note.mjs`), plus the `mark_paid` audit row, which the order history shows as "marked the order
  paid manually". It is deliberately **not** the Shopify order note (that holds customer instructions and
  reaches packing slips and the CSV export). Only an order Shopify accepted is annotated; a note failure
  never fails the payment. If a Helcim card invoice is linked to the order the line names its number and says
  the click did not check it with Helcim — a manual click proves nothing about Helcim, and the customer could
  still pay that invoice. The Helcim-confirmed form (`Paid by card via Helcim: transaction <id>…`) exists in
  `buildPaidNoteLine({source:'helcim'})` for the Helcim paid-sync to call; nothing calls it yet, and the sync
  does not currently read a transaction id from Helcim (`getInvoice` returns status/amount/currency only).
  Per Helcim's Invoices docs the invoice object carries no transactions; the id comes from the card-transactions
  endpoint filtered by `invoiceNumber`, so the sync needs that second read before it can write the Helcim form.
- The Electron installer is unsigned; a real CA certificate is needed for it to install anywhere.
  Note `electron-updater` compares the cert subject against `win.publisherName` and refuses
  mismatched updates — so changing certs later orphans existing installs. Do it once, properly.
