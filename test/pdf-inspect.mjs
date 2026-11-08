// Test helper (not a suite): reads back what a pdfkit-generated invoice actually draws.
//
// pageContentHashes(pdf) -> [sha256 of each page's INFLATED content stream]
//   pdfkit output is not byte-stable (CreationDate, compressed streams), so the "no backorders => unchanged"
//   goldens hash what decides the visible result: positions, glyph ids, colours, rules. Font programs and
//   the logo are deliberately NOT hashed, so a fontkit/pdfkit patch release does not flip the suite.
//
// extractPdfText(pdf) -> [{ page, x, y, size, text }]  (one entry per drawn text run, in draw order)
//   Decodes the Identity-H glyph strings through each font's ToUnicode CMap. `y` is the baseline measured
//   DOWN from the top of the page, in points. Only valid for pdfkit's own output shape (embedded TrueType
//   fonts, one Tm + Tf + TJ per run) — which is all the invoice generator produces.

import zlib from 'node:zlib';
import crypto from 'node:crypto';

const PAGE_H = 792; // LETTER — the invoice's only page size

function indexObjects(pdf) {
  const s = pdf.toString('latin1'); // 1 char == 1 byte, so string offsets are Buffer offsets
  const starts = new Map();
  const re = /(\d+) 0 obj\r?\n/g;
  for (let m; (m = re.exec(s));) starts.set(Number(m[1]), m.index + m[0].length);
  return { s, starts };
}

// Inflated bytes of the stream object `id`.
function streamOf(pdf, ctx, id) {
  const at = ctx.starts.get(id);
  const len = Number(/\/Length\s+(\d+)/.exec(ctx.s.slice(at, at + 200))[1]);
  const kw = ctx.s.indexOf('stream', at);
  const body = kw + 'stream'.length + (ctx.s[kw + 6] === '\r' ? 2 : 1);
  return zlib.inflateSync(pdf.subarray(body, body + len));
}

function pageObjects(ctx) {
  return [...ctx.s.matchAll(/\/Type\s+\/Page\s+\/Parent\s+\d+ 0 R\s+\/MediaBox\s+\[[^\]]*\]\s+\/Contents\s+(\d+) 0 R\s+\/Resources\s+(\d+) 0 R/g)]
    .map(m => ({ contents: Number(m[1]), resources: Number(m[2]) }));
}

export function pageContentHashes(pdf) {
  const ctx = indexObjects(pdf);
  return pageObjects(ctx).map(p => crypto.createHash('sha256').update(streamOf(pdf, ctx, p.contents)).digest('hex'));
}

// ToUnicode CMap: pdfkit writes `beginbfrange <lo> <hi> [<u> <u> ...]` blocks (one unicode per glyph id).
function parseToUnicode(cmap) {
  const map = new Map();
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]*)\]/gi)) {
      let gid = parseInt(r[1], 16);
      for (const u of r[3].matchAll(/<([0-9a-f]+)>/gi)) map.set(gid++, String.fromCodePoint(parseInt(u[1], 16)));
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const r of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) map.set(parseInt(r[1], 16), String.fromCodePoint(parseInt(r[2], 16)));
  }
  return map;
}

export function extractPdfText(pdf) {
  const ctx = indexObjects(pdf);
  const runs = [];
  pageObjects(ctx).forEach((p, pageIdx) => {
    const res = ctx.s.slice(ctx.starts.get(p.resources), ctx.starts.get(p.resources) + 800);
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(res)?.[1] || '';
    const cmaps = new Map(); // resource name (F2) -> Map(gid -> char)
    for (const f of fontBlock.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
      const fAt = ctx.starts.get(Number(f[2]));
      const tu = /\/ToUnicode\s+(\d+) 0 R/.exec(ctx.s.slice(fAt, fAt + 400));
      cmaps.set(f[1], tu ? parseToUnicode(streamOf(pdf, ctx, Number(tu[1])).toString('latin1')) : new Map());
    }
    const content = streamOf(pdf, ctx, p.contents).toString('latin1');
    for (const bt of content.matchAll(/BT\s+1 0 0 1 ([\d.\-]+) ([\d.\-]+) Tm\s+\/(F\d+) ([\d.]+) Tf\s+(?:[\d.\-]+ Tc\s+)?\[([^\]]*)\] TJ/g)) {
      const cmap = cmaps.get(bt[3]) || new Map();
      let text = '';
      for (const h of bt[5].matchAll(/<([0-9a-f]+)>/gi)) {
        for (let i = 0; i < h[1].length; i += 4) text += cmap.get(parseInt(h[1].slice(i, i + 4), 16)) ?? '�';
      }
      runs.push({ page: pageIdx + 1, x: Number(bt[1]), y: PAGE_H - Number(bt[2]), size: Number(bt[4]), text });
    }
  });
  return runs;
}
