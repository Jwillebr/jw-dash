#!/usr/bin/env node
// Offline checks for the review-page extractors.  `node scripts/test-parse.mjs`
// These fixtures stand in for the three markup shapes the site has used: a page with
// schema.org JSON-LD, a plain prose page, and a page with almost nothing on it.
import assert from 'node:assert/strict';
import { parsePage } from './scrape.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const JSONLD = `<!doctype html><html><head>
<title>Larkmead Vineyards - The Napa Wine Project</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Winery","name":"Larkmead Vineyards",
  "address":{"@type":"PostalAddress","streetAddress":"1100 Larkmead Lane",
             "addressLocality":"Calistoga","addressRegion":"CA","postalCode":"94515"},
  "geo":{"@type":"GeoCoordinates","latitude":38.5566,"longitude":-122.5185},
  "telephone":"(707) 942-0167"}]}</script></head>
<body><h1>Larkmead Vineyards</h1>
<p>Visits are by appointment only. <a href="https://larkmead.com/">Website</a>
<a href="https://facebook.com/larkmead">Facebook</a></p></body></html>`;

const PROSE = `<!doctype html><html><head><title>Fake Hill Cellars | The Napa Wine Project</title>
<meta property="og:title" content="Fake Hill Cellars"></head><body>
<h1>Fake Hill Cellars</h1>
<p>Located on Howell Mountain, the tasting room sits at
2345 White Cottage Road, Angwin, CA 94508 &ndash; walk-ins are welcome
daily. Call 707.965.1234 to confirm.</p>
<p><a href="https://www.fakehillcellars.com">Visit their site</a></p>
</body></html>`;

const SPARSE = `<!doctype html><html><head><title>Ghost Brand - The Napa Wine Project</title>
</head><body><h1>Ghost Brand</h1><p>This winery is archived; the brand is no longer
produced.</p></body></html>`;

test('JSON-LD page yields address, coords and policy', () => {
  const r = parsePage(JSONLD, 'https://www.napawineproject.com/larkmead-vineyards/', null);
  assert.equal(r.name, 'Larkmead Vineyards');
  assert.equal(r.slug, 'larkmead-vineyards');
  assert.equal(r.address, '1100 Larkmead Lane, Calistoga, CA, 94515');
  assert.equal(r.city, 'Calistoga');
  assert.equal(r.lat, 38.5566);
  assert.equal(r.lng, -122.5185);
  assert.equal(r.phone, '(707) 942-0167');
  assert.equal(r.visiting, 'By appointment only');
  assert.equal(r.appellation, 'Calistoga');
  assert.equal(r.website, 'https://larkmead.com/');   // facebook is skipped
  assert.equal(r.archived, false);
});

test('prose page yields address from running text', () => {
  const r = parsePage(PROSE, 'https://www.napawineproject.com/fake-hill-cellars/', null);
  assert.equal(r.name, 'Fake Hill Cellars');
  assert.equal(r.address, '2345 White Cottage Road, Angwin, CA 94508');
  assert.equal(r.city, 'Angwin');
  assert.equal(r.phone, '(707) 965-1234');
  assert.equal(r.visiting, 'Walk-ins welcome');
  assert.equal(r.appellation, 'Howell Mountain');
  assert.equal(r.website, 'https://www.fakehillcellars.com');
});

test('sparse page degrades to nulls rather than guesses', () => {
  const r = parsePage(SPARSE, 'https://www.napawineproject.com/ghost-brand/', null);
  assert.equal(r.name, 'Ghost Brand');
  assert.equal(r.address, null);
  assert.equal(r.lat, null);
  assert.equal(r.phone, null);
  assert.equal(r.archived, true);
});

test('title suffix is stripped and the index link is a name fallback', () => {
  const r = parsePage('<html><head><title>Odd One - The Napa Wine Project</title></head><body></body></html>',
    'https://www.napawineproject.com/odd-one/', 'Odd One Wines');
  assert.equal(r.name, 'Odd One');
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
