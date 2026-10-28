# Handoff (rev 2): Helcim credit card invoice hotfix, 2026-10-26

Written after a live end-to-end test of **Send Credit Card Invoice** on prod. "Verified" means observed
on 2026-10-26; "Inferred" means read from code but not exercised. Nothing here is committed; this file is
untracked on `fix/orders-cache-poller-completeness`.

**Part A is the hotfix to build now** (note field + better email subject). Part B is the remaining
follow-ups. Do not build Part A on the currently checked-out branch; see "Branch setup".

## What the live test showed (Verified)

| Step | Result |
|---|---|
| Test order | Shopify **#40089**, id `18974312857835`, $1.00, PENDING, tag `TEST-helcim-invoice`, customer *Spark ReproTEST* `alex+sparkrepro@fuzzywumpets.com` (tags `b2b`, `TEMP-DELETE-ME`) |
| Button click | OK. Ledger `helcim_invoice_map`: `INV001002`, Helcim id `73759349`, delivery `sent`. Audit `helcim_invoice_sent` by alex@ 22:05:29 UTC |
| Email | Landed in alex@fuzzywumpets.com 22:05:30 UTC. From "Fuzzywumpets Wholesale" `wholesale-e-mail@fuzzywumpets.reamaze.com` (Re:amaze, not wholesale@). **Subject: "Re: Update on your wholesale order #40089"**. Body: portal link, one sentence with the amount, raw `myhelcim.com/order/?token=...` link |
| Payment | Helcim API: `INV001002` **PAID**, $1.00, amountDue 0 (created 16:05:28, paid 16:07:40, Helcim clock) |
| Pickup | **None.** Shopify #40089 still PENDING, no new transaction; Admin has no paid field and no code that reads Helcim payment status |

Side effects: creating the order made Shopify send "Order #40089 confirmed" to the test address and a
"[Fuzzywumpets] Order #40089 placed" staff alert.

## What is actually deployed (corrects earlier assumptions)

- **Admin prod** (`alexa@5.161.212.16`, `~/projects/fww-b2b-admin`): VPS-local branch `deploy/prod-plus-sortkey`
  at **`6d967a0`**, which equals `origin/hotfix/backorder-shopify-invoice`. The same-named remote branch
  `origin/deploy/prod-plus-sortkey` is at `d646df0`, **11 commits behind** prod, so do not base work on it.
  Prod has only PR #37 (one "Balance due" line, raw Helcim link through Portal's Re:amaze note). It lacks
  PR #38 (itemized) and PR #39 (public checkout handoff).
- **Portal prod** (`~/projects/fww-b2b-portal`): detached HEAD **`15157bf`** (reachable from
  `origin/fix/storefront-restock-20260921`), 10 untracked `.bak` files (harmless). It lacks Portal PR #42/#43
  (branded email, `creditCardInvoice`, `/pay/<id>`).
- `main` in both repos has the full itemized + branded + `/pay/` flow, undeployed (prerequisites in
  `docs/HELCIM-INVOICE-CONTRACT.md`, "Operations and rollback").

## Part A: the hotfix

### A1. Optional note on Send Credit Card Invoice
Staff can type a comment that is included in the payment-request email.

**Admin, based on `6d967a0` (line numbers are at that commit):**
- **Button** `server.mjs:3080`: today a `<form method="POST" action="/orders/:id/send-credit-card-invoice">`
  with an `onsubmit` `confirm()`. Replace with a button that opens a small modal (copy the existing modal
  pattern, e.g. the invoice or record-payment modal) containing a textarea `name="note"` (`maxlength=500`),
  the recipient email and amount, and Send/Cancel. It must still POST to the same route; JSON callers keep working.
- **Handler** `server.mjs:6521` (`app.post('/orders/:id/send-credit-card-invoice'`): read `req.body.note`,
  normalize, and build the email body. Today `noteBody` is
  `` `Your credit card invoice for ${order.name} is ready for ${fmtMoney(outstanding)} ${currency}.\n\nPay securely with Helcim:\n${invoice.url}` ``.
  New shape (note only when present):
  ```
  Your invoice for order #40089 is ready for $1.00 USD.

  > <note line 1>
  > <note line 2>

  Pay securely with Helcim:
  https://fuzzywumpets.myhelcim.com/order/?token=...
  ```
- **Normalizer** (new `lib/helcim-note.mjs`, pure functions so `main` can reuse them): `normalizeStaffNote(raw)` =
  string, CRLF to LF, strip control characters except `\n`, collapse 3+ newlines to 2, trim, cap at 500.
  `quoteForMarkdown(note)` = escape Markdown and HTML specials (``\ ` * _ [ ] ( ) < > # + - . ! | ~``), prefix each
  line with `> `. Reason: Portal passes the body into **Markdown** (`renderNoteBody`, `reamaze.mjs:226`), so an
  unescaped note could render links or formatting. Also export
  `buildLegacyInvoiceEmail({ orderName, amountText, currency, url, note })` returning `{ subject, body }` so the
  text is unit-testable without a server (MOCK mode never calls Portal, so API tests cannot see the body).
- **Audit:** add `hasNote` and `note` (already capped) to `helcim_invoice_sent` and `helcim_invoice_email_failed`.
  Never log the invoice token or URL (existing rule).
- **Resends:** a resend reuses the mapped invoice and takes whatever note is typed that time. The note is not
  stored on the ledger and is not sent to Helcim (Helcim's invoice `notes` is set only at creation).
- **Known behavior, not a bug:** Portal stores this body as a customer-visible order note
  (`addVisibleNote`), so the note, and the pay link already, also appear on the customer's portal order page.
- Add `// DEPENDS:` markers: the handler depends on Portal accepting `subject` (A2); `lib/helcim-note.mjs`
  depends on Portal rendering the body as Markdown.

### A2. Better email subject
Today: `Update on your wholesale order #40089`, hard-coded at `15157bf:server.mjs:3195` in Portal's
`/__internal__/visible-note`, and shown as "Re: ..." in the inbox.

- **Target:** `Your invoice from Fuzzywumpets is ready - order #40089` (Alex's wording, plus the order token).
- **The order number must stay in the subject.** Portal's `getCustomerWholesaleThreads`
  (`reamaze.mjs:358-373`) keeps only Re:amaze threads whose subject contains the exact `#NNNNN` token, with a
  strict-empty fallback. A subject without it would make the invoice thread vanish from the order page's
  customer-messages chat box. Add a regression test for exactly this.
- **Admin:** build the subject in the handler/`buildLegacyInvoiceEmail` and send it in the existing
  `callPortalInternal('POST', '/__internal__/visible-note', {...})` payload as `subject`.
- **Portal, based on `15157bf`:** at line 3176 destructure an optional `subject` and use
  `` subject || `Update on your wholesale order ${order.name}` `` at line 3195 (and keep the admin-session route at
  line 3142 unchanged). Port `normalizeOutboundSubject` from `origin/main:reamaze.mjs:247` (strips CR/LF,
  collapses whitespace, caps at 160, has a fallback) and apply it inside `sendWholesaleEmail` so every caller is
  protected against header injection. `main` already has this, so this is a cherry-pick, not new design.
- **"Re:" will stay (Inferred).** `sendWholesaleEmail` creates a Re:amaze conversation with this subject and then
  posts the real message as a staff reply, and the "Re:" almost certainly comes from Re:amaze's reply email. The
  final inbox subject should read `Re: Your invoice from Fuzzywumpets is ready - order #40089`. Removing "Re:"
  would need the direct-Gmail template from Portal PR #42 (in the full `main` deploy) or a change to the Re:amaze
  flow. Confirm with Alex that "Re:" is acceptable for the hotfix.
- `main`'s own wording is `Your Fuzzywumpets invoice for order ${name}` (`lib/helcim-invoice-message.mjs`). Pick
  one wording and align `main` when the full version ships.

### Branch setup (do not touch the current checkout)
The Admin checkout is on `fix/orders-cache-poller-completeness` (a `main`-line branch). Build the hotfix in
worktrees so that checkout is untouched:
```sh
git -C C:/Users/AlexLass/projects/commerce-b2b/fww-b2b-admin worktree add C:/Users/AlexLass/projects/_worktrees/b2b-admin-helcim-note -b hotfix/helcim-invoice-note-subject 6d967a0
git -C C:/Users/AlexLass/projects/commerce-b2b/fww-b2b-portal worktree add C:/Users/AlexLass/projects/_worktrees/b2b-portal-invoice-subject -b hotfix/invoice-email-subject 15157bf
```
Repo rules (Admin `CLAUDE.md`): ships as a PR, never a direct push to `main`; `./run-tests.sh` green; non-trivial
functions carry `WHAT / CHANGE-GUARD / INVARIANT(S)` headers; mark coupling with `DEPENDS:` / `SYNC:`.
PR base: the branch each prod commit lives on (Admin `hotfix/backorder-shopify-invoice`; Portal the branch that
contains `15157bf`). Ask Alex if unsure. Then carry the same changes onto `main` as small follow-up PRs: Portal
needs nothing there (`subject` and `normalizeOutboundSubject` exist), Admin needs the note as `staffNote` (see A4).

### A3. Tests
- Admin: new standalone `test/helcim-note.test.mjs`, registered in `run-tests.sh` beside the existing
  `test/helcim.test.mjs` block (about line 98). Cover: empty/whitespace note, 500 cap, CRLF and control
  characters, Markdown/HTML escaping, blockquote lines, subject contains the `#NNNNN` token, no note means the
  old body shape.
- Admin API tests in `test/api.test.mjs` "Phase 13: Helcim credit card invoice" (about line 1958): the order page
  contains the note textarea; POST with a form-encoded `note` and with a JSON `note` both succeed; an over-long
  note is truncated, not rejected; the existing retry/reuse and auth tests still pass.
- Portal: unit test for `normalizeOutboundSubject`; extend `test/reamaze-scoping.test.mjs` so a thread titled
  `Your invoice from Fuzzywumpets is ready - order #40089` is kept when scoping on order `#40089`.

### A4. Deploy (architecture doc section 7 applies)
1. Deploy **Portal first** (an old Portal ignores the extra `subject` field, so either order is safe, but the
   subject only changes once Portal is deployed). On the VPS: `git fetch origin && git checkout <portal sha>`,
   `sudo systemctl restart fww-b2b-portal.service`. Portal prod is a detached HEAD, so there is no
   `git pull`. Entrypoint is `scripts/start-prod.sh`.
2. Then Admin: `git fetch origin && git merge --ff-only <hotfix sha>` on the VPS-local `deploy/prod-plus-sortkey`,
   `sudo systemctl restart fww-b2b-admin.service`.
3. Verify, because a 200 proves nothing: services active, no startup errors in `journalctl`, and **grep the
   deployed files for the new strings** (`name="note"`, `normalizeOutboundSubject`, `Your invoice from Fuzzywumpets`).
4. Read-only prod DB access for checks: the ledger and audit log are in
   `~/projects/fww-b2b-admin/data/admin.db` (open with `mode=ro`).

### A5. Live acceptance (small real invoice; the test env cannot reach Helcim)
1. Create a fresh unpaid $1.00 custom-line order on the same b2b test customer (`draftOrderCreate`, line
   `requiresShipping:false`, `taxable:false`, tag `TEST-helcim-invoice`; then `draftOrderComplete` with
   `paymentPending:true`). Shopify will email an order confirmation to that address again.
2. Open the order in Admin, click Send Credit Card Invoice, confirm the modal, type a two-line note including
   `*bold*` and `[x](http://example.com)`, send.
3. In alex@ mail: subject `Re: Your invoice from Fuzzywumpets is ready - order #<n>`; the note appears as literal
   quoted text (no bold, no live link); the pay link is present and goes to `myhelcim.com`.
4. The order page's customer-messages box still lists this thread.
5. Ledger row is `sent`; audit row has `hasNote: true`.
6. Click again with no note: it resends the same invoice with the old-style body.
7. Do the partial-payment check (B0) on this invoice before paying it.

## Part B: remaining follow-ups

### B0. Disable partial payment in Helcim (account setting, NOT done)
- Why: Admin bills the exact outstanding balance and cannot apply a partial payment to a Shopify order.
- Where: Helcim dashboard, All Tools, Settings, **Invoice Settings**, "Allow Partial Payment". Helcim's docs name this
  setting for HelcimPay.js partial payments. The Create Invoice API (`devdocs.helcim.com/reference/createinvoice`)
  has no partial-payment, minimum-payment or terms field, so it cannot be set per invoice.
- **Not verified:** that it also removes the partial option on the hosted `myhelcim.com/order/?token=` page v1
  emails. Check with the A5 test invoice before and after; ask Helcim support if the option remains.
- It changes a Helcim account setting, so it needs Alex's go-ahead and a logged-in dashboard session.

### B1. Mark #40089 paid in Shopify
Use Admin so the audit log is right (`server.mjs` on the checked-out branch):
- `POST /orders/:id/record-payment` (about line 8088): `paymentMethod=Helcim`, note `Helcim INV001002, paid
  2026-10-26`. Runs `orderMarkAsPaid`; method/note live only in the audit log. **No Xero.**
- `POST /orders/:id/mark-paid` (about line 5986): same plus Xero (creates a Xero invoice if none, records a payment
  to `chase_checking`, skips insiders). `xero_invoice_map` has no row for #40089 and Spark ReproTEST was not found
  on an insider list, so this route would put a $1.00 test sale into the live books.
- Recommendation: `record-payment`. **Open question for Alex:** the $1.00 is real money settling from Helcim, so
  should Xero record it, or should it be refunded in Helcim?
- Done when Shopify #40089 shows PAID with $0 outstanding.

### B2. "Mark as paid in B2B" (ambiguous; ask Alex)
- (a) Admin and Portal order pages show PAID. Admin reads Shopify live and the orders cache follows the
  `orders/updated` webhook, so this should follow B1 by itself. Verify on both pages.
- (b) Admin tracks Helcim payment itself. `helcim_invoice_map` records only creation and delivery. Possible fix:
  a paid marker plus a reconcile step calling `GET /v2/invoices/{invoice_id}` for unpaid rows and, on `PAID` with
  `amountPaid` equal to the row amount in the same currency, record the payment in Shopify and stamp the row.
  `main`'s public checkout already validates exact invoice, amount and currency before a local paid state (see
  `docs/HELCIM-INVOICE-CONTRACT.md`); check Portal PR #43 for whether that writes back to Shopify first.

### B3. Forward the invoice email to alex@fuzzywumpets.com: no action needed
The Gmail connector's mailbox is **alex@fuzzywumpets.com** and the plus-address mail landed there: message
`1a17a3f4b1e84df6` (the invoice), `1a17a3381f9e3679` (order confirmed), `1a17a337ed0a6d99` (staff alert).
Forwarding was impossible anyway: the readable connector is read-only and the other is disconnected and draft-only.

### B4. Full `main` deploy (later)
Reconcile the diverged deploy branches (Admin 46 ahead / 60 behind `main`; Portal 8 ahead / 15 behind), deploy
Portal before Admin, enable HelcimPay checkout permission and allow-list `https://b2b.fuzzywumpets.com` in
Helcim. Carry the note across as `creditCardInvoice.staffNote` (optional string, max 500): Portal
`validateInvoiceCheckoutContract` plus template (escape, newlines to `<br>`), `lib/helcim-invoice-message.mjs`
and its `DEPENDS:` header. Confirm Portal tolerates the extra key before Admin sends it.

## Cleanup and open items
- #40089 stays as a paid test order (tag `TEST-helcim-invoice`). Spark ReproTEST can no longer be deleted
  because it has an order; remove `TEMP-DELETE-ME` or cancel/refund per Alex.
- Helcim `INV001002` is PAID. A refund, if wanted, is done in Helcim.
- Admin never voids a Helcim invoice, and v1 keeps reusing a mapped invoice for an order while the amount
  matches, even if it was cancelled or paid in Helcim. Worth a guard.
- Decisions needed from Alex: "Re:" prefix acceptable? Xero for the $1.00? Meaning of "mark as paid in B2B"?

## Constraints
- Prod secrets come from Doppler; never print `HELCIM_API_TOKEN`.
- The test environment `fww-b2b-admin-test` refuses to start with a Helcim token, so Helcim changes can only be
  tested against prod with a small real invoice.
