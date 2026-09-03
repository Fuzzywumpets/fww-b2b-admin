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
token remains server-side; customers receive only Helcim's per-invoice online-view URL. Admin owns
itemized invoice creation and its durable duplicate-prevention ledger; Portal renders and sends the
branded message through its existing Gmail broker. See `docs/HELCIM-INVOICE-CONTRACT.md` for the
verified API and arithmetic invariants. Portal PR #42 must deploy before the Admin structured-message consumer.

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
- The Electron installer is unsigned; a real CA certificate is needed for it to install anywhere.
  Note `electron-updater` compares the cert subject against `win.publisherName` and refuses
  mismatched updates — so changing certs later orphans existing installs. Do it once, properly.
