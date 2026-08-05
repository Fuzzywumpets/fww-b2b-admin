// Standalone unit test (no server): portal wholesale_leads -> admin.db.leads ingest.
//
// This runs against the in-memory MOCK database, because the ingest cannot be exercised through
// the mock HTTP server at all: getPortalDb() short-circuits to null under MOCK, so
// syncPortalWholesaleLeads() is a no-op there and the API suite would report a false green.
//
// The rule under test that actually matters is the LAST one. upsertPortalLead runs on every single
// /leads page render, so if it ever refreshed the descriptive fields, a staff member's edits would
// be silently reverted on the next page load — an invisible data-loss bug rather than a visible one.

process.env.B2B_ADMIN_MOCK = '1';

const { upsertPortalLead, getLead, updateLead, getLeads } = await import('../db.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// A row shaped exactly like the portal's wholesale_leads table hands it over.
function portalRow(overrides = {}) {
  return {
    id: 1,
    business_name: 'Paws & Claws',
    contact_name: 'Dana Reyes',
    email: 'dana@pawsandclaws.example',
    phone: '555-0100',
    website: 'https://pawsandclaws.example',
    state: 'TX',
    address: 'Austin, TX 78701',
    tax_id: 'TX-99887',
    fein: '12-3456789',
    tax_exempt_doc_path: '/srv/uploads/lead-tax-exempt/lead_1.pdf',
    products: 'Collars, Toys',
    notes: 'Brick and mortar pet supply store.',
    submitted_at: 1754300000000,
    ...overrides,
  };
}

console.log('\n── Unit: portal wholesale-lead ingest (standalone, no server) ──');

await test('a new application is inserted with the portal fields mapped', async () => {
  const r = upsertPortalLead(portalRow());
  assertEqual(r.action, 'inserted', 'first ingest must insert');
  const lead = getLead(r.id);
  assertEqual(lead.email, 'dana@pawsandclaws.example');
  assertEqual(lead.business_name, 'Paws & Claws');
  assertEqual(lead.fein, '12-3456789', 'FEIN must land in its own column');
  assertEqual(lead.sales_tax_id, 'TX-99887', 'the state resale number is NOT the FEIN');
  assertEqual(lead.sales_tax_state, 'TX');
  assertEqual(lead.source, 'wholesale_form');
  assertEqual(lead.portal_lead_id, 1, 'the portal id is required to send an invite later');
  assertEqual(lead.status, 'new');
  assertEqual(lead.created_at, 1754300000000, 'created_at must be the applicant submission time');
});

await test('everything without a first-class column survives in application_data_json', async () => {
  const lead = getLeads({ search: 'dana@pawsandclaws.example' })[0];
  const app = JSON.parse(lead.application_data_json);
  assertEqual(app.address, 'Austin, TX 78701');
  assertEqual(app.products, 'Collars, Toys');
  assertEqual(app.notes, 'Brick and mortar pet supply store.');
  assertEqual(app.hasTaxExemptDoc, true, 'the attached document must be flagged');
  // The portal's on-disk path is its own business and must not be copied across.
  assert(!lead.application_data_json.includes('/srv/uploads'),
    'the portal filesystem path must never be stored here');
});

await test('re-ingesting the same application is a no-op', async () => {
  const before = getLeads({ limit: 500 }).length;
  const r = upsertPortalLead(portalRow());
  assertEqual(r.action, 'skipped', 'an already-ingested application must be skipped');
  assertEqual(getLeads({ limit: 500 }).length, before, 'must not create a duplicate lead');
});

// The load-bearing one: the sync runs on every /leads render.
await test('re-ingesting NEVER reverts staff edits', async () => {
  const lead = getLeads({ search: 'dana@pawsandclaws.example' })[0];
  updateLead(lead.id, {
    status: 'contacted',
    assigned_to: 'alex@fuzzywumpets.com',
    next_followup_due: '2026-09-01',
    business_name: 'Paws & Claws (corrected)',
  });
  upsertPortalLead(portalRow());
  const after = getLead(lead.id);
  assertEqual(after.status, 'contacted', 'a staff status change must survive the next page load');
  assertEqual(after.assigned_to, 'alex@fuzzywumpets.com', 'assignment must survive');
  assertEqual(after.next_followup_due, '2026-09-01', 'follow-up date must survive');
  assertEqual(after.business_name, 'Paws & Claws (corrected)', 'a staff correction must not be overwritten');
});

await test('an application matching an existing lead by email LINKS instead of erroring', async () => {
  // leads.email is UNIQUE, so a naive insert would throw here.
  const { createLead } = await import('../db.mjs');
  const manualId = createLead({ email: 'manual@example.com', business_name: 'Manually Added Co' });
  updateLead(manualId, { status: 'qualified' });

  const r = upsertPortalLead(portalRow({ id: 77, email: 'manual@example.com', business_name: 'Ignored Name' }));
  assertEqual(r.action, 'linked', 'a same-email application must link, not insert');
  assertEqual(r.id, manualId, 'it must link to the EXISTING lead');
  const after = getLead(manualId);
  assertEqual(after.portal_lead_id, 77, 'linking must record the portal id so an invite can be sent');
  assertEqual(after.status, 'qualified', 'linking must not reset a staff-set status');
  assertEqual(after.business_name, 'Manually Added Co', 'linking must not overwrite the existing name');
  assert(after.application_data_json, 'linking must still attach the submitted application');
});

// The portal has no UNIQUE constraint on wholesale_leads.email, so it really can hand us two rows
// for one applicant. They must collapse rather than blow up on this table's UNIQUE index.
await test('duplicate applications from the portal collapse onto one lead', async () => {
  const before = getLeads({ limit: 500 }).length;
  upsertPortalLead(portalRow({ id: 900, email: 'dupe@example.com' }));
  upsertPortalLead(portalRow({ id: 901, email: 'dupe@example.com' }));
  assertEqual(getLeads({ limit: 500 }).length, before + 1, 'two applications, one lead row');
});

// Regression: /leads calls this sync on EVERY render. Before this fix, a second (or later)
// duplicate portal row for the same email re-ran the UPDATE every single time it was
// re-ingested, rewriting portal_lead_id/application_data_json and bumping updated_at forever --
// which both spammed writes and reordered the ORDER BY updated_at DESC lead list on every page
// view. A duplicate must be a true no-op after the first link, however many times it is re-seen.
await test('re-ingesting a duplicate portal row NEVER rewrites the linked lead', async () => {
  const first = upsertPortalLead(portalRow({ id: 910, email: 'dupe2@example.com' }));
  assertEqual(first.action, 'inserted', 'first portal row for this email inserts');
  const linkedBefore = getLead(first.id);

  const dupe = upsertPortalLead(portalRow({ id: 911, email: 'dupe2@example.com', business_name: 'Should Not Win' }));
  assertEqual(dupe.action, 'duplicate_portal_row', 'a second portal row for the same email must be a no-op, not a re-link');
  assertEqual(dupe.id, first.id, 'the no-op must still report the lead it collided with');

  const linkedAfter = getLead(first.id);
  assertEqual(linkedAfter.portal_lead_id, 910, 'portal_lead_id must stay pinned to the FIRST portal row that linked');
  assertEqual(linkedAfter.updated_at, linkedBefore.updated_at, 'a duplicate must not bump updated_at (or it reorders the leads list on every render)');
  assertEqual(linkedAfter.business_name, linkedBefore.business_name, 'a duplicate must not overwrite fields from the first application');

  // Re-ingesting the SAME duplicate row again (simulating a second /leads render) must be
  // identical -- this is the "every render" repro, not just a single extra call.
  const dupeAgain = upsertPortalLead(portalRow({ id: 911, email: 'dupe2@example.com' }));
  assertEqual(dupeAgain.action, 'duplicate_portal_row', 'repeated re-ingestion of the same duplicate stays a no-op');
  assertEqual(getLead(first.id).updated_at, linkedBefore.updated_at, 'still no updated_at churn after a second render');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
