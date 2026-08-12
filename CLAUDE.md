# fww-b2b-admin — agent instructions

Internal **staff** tool (Node 22 / Express, server-rendered from `server.mjs`). Google OAuth.
Separate from `fww-b2b-portal`, which is the **customer** app.

## Read this first
**`docs/B2B-ARCHITECTURE.md`** is the canonical description of how the two apps fit together —
the onboarding order, the auth models, the cross-app channel, settled decisions, deploy traps.
Read it before any cross-app work. If it disagrees with what you remember, it wins; if it is wrong,
fix it in the same PR.

## The three things most often got wrong

1. **The invitation comes BEFORE any Shopify account exists.** The customer account is created at
   the END of onboarding by the portal's `/api/onboard/complete`. `/leads/:id/convert` is the
   no-portal exception for customers who will never log in — **not** a step in the invite path, and
   never both. Details in §2 of the architecture doc.

2. **This app is not a duplicate of the portal's admin pages.** It is the intended standalone
   internal tool; the portal's `/admin/*` pages are the accident. Never propose tagging a staff
   member as a `b2b` Shopify customer so they can reach the portal's admin UI — staff should not
   have to become customers to use a staff tool, and the storefront's `b2b-redirect` would bounce
   them off fuzzywumpets.com. Expose the operation over `/__internal__/*` instead.

3. **Never grep `.env` for a secret.** This service starts under `doppler run`, so secrets live only
   in the process environment and a grep returns a false negative. Read
   `/proc/<node CHILD pid>/environ` — MainPID is `doppler`, not node. §4 of the architecture doc.

## Tests
`./run-tests.sh` must be green on every commit. `B2B_ADMIN_MOCK=1` is the in-memory mode. Suites that
cannot be reached through the mock HTTP server (anything gated on `if (!MOCK)`, the Google OAuth
gate, DB-level SQL) get their own standalone unit run — follow that pattern rather than adding an
API test that silently exercises nothing.

## House style
- Every change ships as a PR, never a direct push to `main`.
- Non-trivial functions carry `// WHAT:` / `// CHANGE-GUARD:` / `// INVARIANT(S):` headers. Match it.
- Mark real coupling with `// DEPENDS:` or `// SYNC:` in the same change that creates it.
- Before changing anything shared, grep for consumers and update them in the same change.
- Fixing X means touching what X needs. Unrelated cleanup goes in the PR body as a suggestion.
