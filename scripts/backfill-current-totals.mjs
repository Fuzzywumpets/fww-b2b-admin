// ONE-TIME DATA MIGRATION (2026-06-29): backfill orders_cache.current_total / current_subtotal.
//
// WHY: the orders LIST serves from orders_cache via listOrdersFromCache, which only emits
// currentTotalPriceSet when current_total is non-null. Historically the poller populated those
// columns ONLY on future syncs, so the ~1100 pre-existing rows (including every EDITED order such
// as #37639 / #37583) had current_total = NULL and the list fell back to the FROZEN total_price.
//
// WHAT: paginate ALL Shopify orders (250/page) reading name, id, currentSubtotalPriceSet,
// currentTotalPriceSet, and UPDATE only orders_cache.current_total / current_subtotal for the
// matching cache row (matched by numeric shopify_id, the cache PK; name kept as a fallback match).
// Idempotent: re-running just re-writes the same two columns. SQLite is WAL so this is safe to run
// concurrently with the live service.
//
// RUN (from repo root, with secrets):  doppler run -- node scripts/backfill-current-totals.mjs
// Add --dry to report without writing.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'admin.db');
const DRY = process.argv.includes('--dry');

const BRIDGE_URL = 'https://shopify-bridge.alex-037.workers.dev/api/graphql';
const BEARER = process.env.SHOPIFY_BRIDGE_BEARER || '';
if (!BEARER) { console.error('Missing SHOPIFY_BRIDGE_BEARER (run via: doppler run --)'); process.exit(1); }

async function shopifyFetch(query, variables = {}) {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`shopify-bridge ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json;
}

const QUERY = `
  query($first:Int!,$after:String){
    orders(first:$first,after:$after,sortKey:CREATED_AT){
      edges{ cursor node{
        id name
        currentTotalPriceSet{presentmentMoney{amount}}
        currentSubtotalPriceSet{presentmentMoney{amount}}
      }}
      pageInfo{hasNextPage endCursor}
    }
  }`;

function numericId(gid) { const m = String(gid).match(/(\d+)$/); return m ? m[1] : null; }

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Match by PK shopify_id first; fall back to name (with/without leading #) if id miss.
const updById = db.prepare('UPDATE orders_cache SET current_total = ?, current_subtotal = ? WHERE shopify_id = ?');
const updByName = db.prepare('UPDATE orders_cache SET current_total = ?, current_subtotal = ? WHERE name = ? OR name = ?');
const cacheCount = db.prepare('SELECT COUNT(*) n FROM orders_cache').get().n;

let pages = 0, seen = 0, updated = 0, missed = 0;
let after = null, hasNext = true;
const missedNames = [];

while (hasNext) {
  const json = await shopifyFetch(QUERY, { first: 250, after });
  const conn = json.data?.orders;
  const edges = conn?.edges || [];
  pages++;
  for (const { node } of edges) {
    seen++;
    const sid = numericId(node.id);
    const curTot = node.currentTotalPriceSet?.presentmentMoney?.amount;
    const curSub = node.currentSubtotalPriceSet?.presentmentMoney?.amount;
    const tot = curTot != null ? parseFloat(curTot) : null;
    const sub = curSub != null ? parseFloat(curSub) : null;
    if (tot == null && sub == null) continue;
    if (DRY) {
      const row = db.prepare('SELECT shopify_id FROM orders_cache WHERE shopify_id = ?').get(sid);
      if (row) updated++; else { missed++; missedNames.push(node.name); }
      continue;
    }
    let r = updById.run(tot, sub, sid);
    if (r.changes === 0) {
      const withHash = node.name.startsWith('#') ? node.name : `#${node.name}`;
      const noHash = node.name.replace(/^#/, '');
      r = updByName.run(tot, sub, withHash, noHash);
    }
    if (r.changes > 0) updated += r.changes; else { missed++; missedNames.push(node.name); }
  }
  hasNext = conn?.pageInfo?.hasNextPage || false;
  after = conn?.pageInfo?.endCursor || null;
  process.stdout.write(`\rpages=${pages} shopify_orders_seen=${seen} cache_rows_updated=${updated} not_in_cache=${missed}   `);
}

console.log(`\n--- DONE ${DRY ? '(DRY RUN)' : ''} ---`);
console.log(`cache rows total:        ${cacheCount}`);
console.log(`shopify orders scanned:  ${seen} across ${pages} pages`);
console.log(`cache rows updated:      ${updated}`);
console.log(`shopify orders not in cache (skipped): ${missed}`);
if (missedNames.length) console.log(`  (first 10 not-in-cache: ${missedNames.slice(0,10).join(", ")})`);

const remainNull = db.prepare("SELECT COUNT(*) n FROM orders_cache WHERE current_total IS NULL").get().n;
console.log(`cache rows STILL current_total NULL after backfill: ${remainNull}`);
db.close();
