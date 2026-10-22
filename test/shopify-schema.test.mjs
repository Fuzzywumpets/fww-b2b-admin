// Standalone unit test: every Shopify GraphQL document in the app must validate against the real
// Shopify Admin schema (snapshot in test/fixtures/shopify-admin-schema.json).
//
// Why this exists: every Shopify call is skipped under B2B_ADMIN_MOCK, so the API/UI suites and
// Gauntlet never send a single query to Shopify. Invalid field names / enum values (sortKey
// AMOUNT_SPENT, MetafieldsDeletePayload.deletedMetafieldIds — both 2026-10-22) shipped green and only
// failed in production. This test closes that gap offline.
//
// How: scan source for template literals that look like GraphQL documents, replace `${...}`
// interpolations with a neutral placeholder, parse and validate. Refresh the snapshot with
// scripts/snapshot-shopify-schema.mjs when the bridge's API version changes.
// KNOWN_DYNAMIC: documents whose shape is built from interpolations and cannot be checked statically
// are listed (not silently skipped) so a reader can see what is NOT covered.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { buildClientSchema, parse, validate } from 'graphql';

const root = new URL('../', import.meta.url);
const schemaFile = JSON.parse(readFileSync(new URL('test/fixtures/shopify-admin-schema.json', root), 'utf8'));
const schema = buildClientSchema(schemaFile.data);

const files = ['server.mjs', 'db.mjs',
  ...(existsSync(new URL('lib/', root)) ? readdirSync(new URL('lib/', root)).filter(f => f.endsWith('.mjs')).map(f => 'lib/' + f) : [])];

// Finds string literals that START a GraphQL document (`query…`, `mutation…`, or a backtick `{…`) and
// reads just that literal. Anchoring on each start (instead of tokenizing the whole file) means a regex
// literal or odd quoting elsewhere in a 13k-line file cannot derail the scan.
// ${...} spans are replaced by \u0000. Returns [{ raw, line, quote }].
const BS = String.fromCharCode(92);
function gqlLiterals(src) {
  const out = [];
  const start = /([`'"])(\s*)(query|mutation)\b|(`)(\s*)\{/g;
  let m;
  while ((m = start.exec(src))) {
    const quote = m[1] || m[4];
    let i = m.index + 1, text = '';
    let ok = false;
    while (i < src.length) {
      const c = src[i];
      if (c === BS) { text += src[i + 1] === quote ? quote : c + src[i + 1]; i += 2; continue; }
      if (c === quote) { ok = true; i++; break; }
      if (quote !== '`' && c === '\n') break; // unterminated '/" string: not a literal start after all
      if (quote === '`' && c === '$' && src[i + 1] === '{') {
        let depth = 1; i += 2;
        while (i < src.length && depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
        text += '\u0000'; continue;
      }
      text += c; i++;
    }
    if (!ok) continue;
    out.push({ raw: text, line: src.slice(0, m.index).split('\n').length, quote });
    start.lastIndex = i;
  }
  return out;
}

const results = { ok: 0, dynamic: [], broken: [] };
for (const f of files) {
  const src = readFileSync(new URL(f, root), 'utf8');
  for (const t of gqlLiterals(src)) {
    const where = `${f}:${t.line}`;
    const named = /^\s*(query|mutation)\b/.test(t.raw);
    // prose like 'query failed' / a `query expects …` comment is not a document
    if (named && !/^\s*(query|mutation)\s*([A-Za-z_]\w*)?\s*[({]/.test(t.raw)) continue;
    // Interpolations sit either in a selection set (`${FIELDS}`) or in a value (first:${n},
    // query:"${q}"). Try a field placeholder first, then scalar ones; if none parses, the document's
    // shape is dynamic and is LISTED below rather than silently skipped.
    let doc = null;
    for (const sub of ['__typename', '1', 'x', '']) {
      try { doc = parse(t.raw.replace(/\u0000/g, sub)); break; } catch { /* try next */ }
    }
    if (!doc) {
      if (named) results.dynamic.push(`${where}  ${t.raw.replace(/\s+/g, ' ').slice(0, 70)}`); // a backtick `{` that doesn't parse is just JS/JSON
      continue;
    }
    const isOp = doc.definitions.some(d => d.kind === 'OperationDefinition');
    if (!isOp) continue;
    const errs = validate(schema, doc).map(e => e.message)
      // a placeholder in a VALUE position can't be type-checked; field/enum/argument names still are
      .filter(m => !(t.raw.includes('\u0000') && /Expected value of type|cannot represent|Expected type/.test(m)));
    if (errs.length) results.broken.push({ where, errs });
    else results.ok++;
  }
}

console.log('\n── Unit: Shopify GraphQL documents validate against the Admin schema ──\n');
console.log(`  schema snapshot captured ${schemaFile.capturedAt}`);
console.log(`  ${results.ok} documents valid; ${results.dynamic.length} dynamic (not statically checkable)`);
for (const d of results.dynamic) console.log(`    · dynamic: ${d}`);
for (const b of results.broken) console.log(`  ✗ ${b.where}\n      ${b.errs.join('\n      ')}`);
if (results.ok + results.broken.length === 0) { console.log('  ✗ found no GraphQL documents — extractor broken?'); process.exit(1); }
console.log(`\n  ${results.ok} passed, ${results.broken.length} failed`);
process.exit(results.broken.length ? 1 : 0);
