# fww-b2b-admin — Adversarial security audit (2026-07-02)

> **REMEDIATION STATUS — patched on branch `security/adversarial-fixes-20260702`, suite green (81/81).**
> Fixed + re-verified: #1 prefill (jsonForScript), #2 onclick→data-* (re-tested: click executes nothing, modal still works),
> #3 activity innerHTML (esc), #4 Xero innerHTML (esc), #5 webhook HMAC over `req.rawBody` + timing-safe + fails-closed
> (re-tested: correctly-signed→200, wrong/absent→401), impersonation guard (email-based), live allowlist re-read,
> lead/tracking `href` scheme allowlist, baseline CSP + `X-Content-Type-Options`/`Referrer-Policy`, server-side discount
> clamp (0–95), CSV formula-injection guard, logout→POST (fetch, SameSite-Lax protected). Deferred (documented, not
> code-fixed): `/__test__/session` compile-out (already env-gated), Xero/partial-invoice write idempotency (needs a txn/lock).


Two independent lenses, cross-checked against the running app:
1. **Claude** — static adversarial review of every auth/session/write surface.
2. **GPT-5.5** (`openai.mjs review`, effort=high) — independent core + UI/DOM passes over `server.mjs`+`db.mjs`.
3. **On-screen dynamic** — real headless-Chromium (Playwright) harness against a MOCK server, seeding payloads through the app's own write endpoints.
4. **Baseline** — `./run-tests.sh` = **81/81 green** before/after; no regressions introduced (audit was read-only + MOCK).

Confidence tags: **LIVE** = reproduced in a running browser/HTTP test this session · **CODE** = confirmed by reading the exact sink + a real attacker-controlled source · **PLAUSIBLE** = strong by inspection, not runtime-repro'd.

---

## CRITICAL / HIGH

### 1. Stored XSS — `/orders/new?customer=` prefill JSON  · CRITICAL · CODE
`server.mjs:4257` builds `customerJson = JSON.stringify({ name: prefillCustomer.displayName, email: … })` and `server.mjs:4331` emits it raw inside an inline script: `var selectedCustomer = ${customerJson};`. `JSON.stringify` does **not** escape `</script>`. A wholesale customer whose Shopify **displayName/company/email** is `</script><script>…</script>` gets **auto-executing** script in the admin origin the instant an admin opens the prefilled New-Order form. No click required — most severe.
**Fix:** serialize with `<`→`<` `>`→`>` `&`→`&` (script-safe), or embed in `<script type="application/json">` and `JSON.parse`.

### 2. Stored XSS — order line-item title → inline `onclick`  · HIGH · **LIVE**
`server.mjs:2055`: `onclick="toggleBackorderModal('${h(item.id)}','${h(item.title).replace(/'/g,"\\'")}',…)"`. `h()` HTML-encodes `'`→`&#x27;`, but the browser **decodes entities before compiling the inline handler**, so the quote reappears and breaks the JS string. The `.replace(/'/g,…)` is a no-op (no literal quotes survive `h()`).
**Reproduced this session:** seeded title `zzz');window.__xss_onclick=1;//` via `POST /orders/1001/line/custom`; on `/orders/1001` the rendered handler was
`onclick="toggleBackorderModal('…','zzz');window.__xss_onclick=1;//','1',true)"` and clicking the line's "⚑ Mark backordered" set `window.__xss_onclick=1`.
**Fix:** drop inline handlers; use `data-*` + `addEventListener`. (Source: order/product/custom-line title.)

### 3. Stored DOM XSS — Portal Activity widget `innerHTML`  · HIGH · CODE
`server.mjs:4028` & `4030` concatenate `r.path` and `ed.ua` straight into `innerHTML` (rows built at `4031-4040`). Both come from `/api/admin/customers/:id/activity` → the portal activity warehouse: **`path` = a URL the visitor browsed, `ua` = their `User-Agent` header** — trivially attacker-controlled by any portal visitor. Executes when an admin clicks "Load" on the customer's Portal Activity card (and again on `/customers/:id/activity` row-expand).
**Fix:** build rows with `textContent`/DOM APIs, or escape every field before `innerHTML`.

### 4. Stored DOM XSS — Xero status card `innerHTML`  · HIGH · CODE
`server.mjs:4229` & `4233`: `'…<span…>'+d.xeroName+'</span>'` → `el.innerHTML`. `d.xeroName` is the Xero contact name, synced from the Shopify customer/company name (attacker-controlled). Fires on `/customers/:id` load once the xero-status fetch resolves.
**Fix:** `textContent` / escape `d.xeroName` before `innerHTML`.

### 5. Broken webhook auth — HMAC computed over re-serialized body  · HIGH (functional) · **LIVE**
Global `app.use(express.json())` (`server.mjs:81`) parses the webhook body **before** the route-level `express.raw()` (`server.mjs:10119`) runs, so `req.body` is already an object; `rawBody = Buffer.from(JSON.stringify(req.body))` (`10120`) re-serializes it and the HMAC (`10123`) is computed over bytes that don't match Shopify's signature over the original payload.
**Reproduced this session:** a webhook signed over the *exact bytes on the wire* returned **`HTTP 401 HMAC mismatch`**. Net effect: **every authentic Shopify webhook is rejected** — near-real-time cache sync is dead and silently carried by the 5-min poller. The inline comment's rationale ("raw defined late ⇒ works") is wrong: `app.use` order wins.
**Fix:** mount `express.raw({type:'application/json'})` for this path *before* the global JSON parser (or use `express.json({verify})` to capture `req.rawBody`); then `crypto.timingSafeEqual` equal-length buffers.

---

## MEDIUM

- **Impersonation "insider" guard is a no-op** · CODE — `server.mjs:9851` compares the **customer's Shopify tags** against `ALLOWED_EMAILS` (admin *emails*); they never intersect, so `Cannot impersonate insider accounts` never triggers. Any customer (incl. one tied to an admin's own email) can be impersonated. Gate by customer email / a real `isInsider()`.
- **Allowlist add doesn't take effect until restart** · CODE — `ALLOWED_EMAILS` is frozen at startup (`:65`); `/settings/allowlist/add` only writes Doppler + `process.env` (`:8236`), but the OAuth gate reads the frozen const (`:4771`). Settings shows the new admin as authorized while login 403s them. Re-read env/DB in the callback.
- **Unsafe `href` scheme** · CODE — lead website `server.mjs:9312` (`href="${h(lead.website)}"`) and fulfillment tracking URL both allow `javascript:`/`data:` (h() doesn't validate scheme). Self-served lead `website=javascript:…` → script link in admin UI. Allowlist `http(s):` only; add `rel="noopener noreferrer"`.
- **No Content-Security-Policy** · CODE — heavy inline scripts/handlers with zero CSP fallback, so any of the above XSS = full admin-session takeover. Add a nonce-based CSP; it would blunt findings 1–4.
- **Server-side numeric bounds missing** · PLAUSIBLE — UI caps `discount_pct` at 0–95 but `/settings` and `/customers/:id/b2b-config` accept `999` directly. Clamp server-side.
- **Non-idempotent financial writes** · PLAUSIBLE — `getXeroMap→setXeroMap` (order xero-sync) and `getNextInvoiceLetter→createPartialInvoice` are read-then-write with no lock/txn; double-submit or concurrency can duplicate a Xero invoice or a partial-invoice letter. Add a unique/txn guard + per-form idem key. (Order-*edit* actions already have `order_edit_action.idem_key` — this gap is the money paths.)

---

## LOW / HARDENING

- **`/__test__/session` backdoor** (`:4715`) mints an arbitrary admin session; correctly 404s unless `MOCK` or `B2B_ADMIN_ALLOW_TEST_SESSION=1`. Compile it out of prod builds so a stray env var can't expose it.
- **Timing-unsafe HMAC compare** (`:10124`, `sig !== expected`) — use `crypto.timingSafeEqual`.
- **Logout CSRF via GET** (`:4786`) — SameSite=Lax carries the cookie on a top-level GET; a crafted link force-logs-out an admin. Make it POST.
- **CSV formula injection** — `csvLine` (`:7352`) escapes quotes/commas/newlines but not leading `= + - @`; a Shopify field like `=WEBSERVICE(...)` executes when the export opens in Excel. Prefix risky cells with `'`.
- **Unclamped `/api/admin/customers/:id/activity`** (`:9881`) passes `req.query` to the portal reader with no limit bound.

---

## Notes on the two-model convergence
GPT-5.5 independently reported findings 1–5 plus the impersonation/allowlist/CSP/clamp items; its line numbers were approximate (it estimated offsets), so every finding above is re-anchored to a **verified** line. Nothing it flagged was a hallucination — all high-severity claims checked out against the real sinks. The two live-reproduced items (2, 5) were found by both lenses and proven here.

Clean under the same payloads (h() correct for text context): session email/name in header (`:1251`), order internal note (`:3233`), customer note, lead fields on the New-Lead form (`:9162+`), settings inputs (`:8142+`). SQL layer (`db.mjs`) is fully parameterized; ORDER BY comes from an allowlist — no injection found.
