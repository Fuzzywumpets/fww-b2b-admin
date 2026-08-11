// WHAT: shared reader/asserter for Shopify GraphQL per-mutation `userErrors`.
// WHY: shopifyFetch only throws on transport/top-level `errors[]` — a per-mutation userError comes
// back inside a 200 OK body. Any caller that ignores the response therefore treats a REJECTED write
// as a success. On the order-edit path that over-bills the customer: a failed remove stays on the
// order, the batch still commits, and the invoice/Xero payment includes the line staff deleted.
// DEPENDS: server.mjs order-edit handlers import assertNoUserErrors — it must keep throwing
// (not returning) so callers abandon the edit session BEFORE orderEditCommit.

/**
 * Pull the userErrors array for one mutation field out of a shopifyFetch response.
 * Tolerates a null/partial response shape (returns []).
 */
export function collectUserErrors(res, mutationField) {
  const errs = res?.data?.[mutationField]?.userErrors;
  return Array.isArray(errs) ? errs : [];
}

/**
 * Throw if the mutation reported any userError. `context` identifies the failing line/entity so the
 * banner and the [order-edit] log name what actually broke.
 */
export function assertNoUserErrors(res, mutationField, context = '') {
  const errs = collectUserErrors(res, mutationField);
  if (!errs.length) return;
  const detail = errs.map(e => e?.message || JSON.stringify(e)).join('; ');
  const label = context ? `${mutationField} ${context}` : mutationField;
  console.error(`[shopify] ${label} userErrors:`, JSON.stringify(errs));
  throw new Error(`${label}: ${detail}`);
}
