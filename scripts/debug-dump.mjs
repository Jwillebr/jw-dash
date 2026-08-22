#!/usr/bin/env node
// CI-side eyes for parser work: prints, for each slug given, the parts of the live
// page that extraction depends on — head (JSON-LD lives there), every link, the
// text rendering, and what parsePage currently makes of it.
//   node scripts/debug-dump.mjs <slug> [slug...]
import { fetchText, htmlToText, decodeEntities } from './lib.mjs';
import { parsePage } from './scrape.mjs';

const cap = (s, n) => (s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} bytes]` : s);

for (const slug of process.argv.slice(2)) {
  const url = `https://www.napawineproject.com/${slug}/`;
  console.log(`\n\n########## ${url} ##########`);
  let body;
  try { body = (await fetchText(url)).body; }
  catch (err) { console.log('FETCH FAILED:', err.message); continue; }
  console.log(`raw bytes: ${body.length}`);

  const headEnd = body.indexOf('</head>');
  console.log('\n----- HEAD -----');
  console.log(cap(body.slice(0, headEnd > 0 ? headEnd : 8000), 14000));

  console.log('\n----- LINKS -----');
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  let m;
  while ((m = re.exec(body))) {
    const line = `${m[1]}  ::  ${decodeEntities(m[2]).slice(0, 60)}`;
    if (!seen.has(line)) { seen.add(line); console.log(line); }
  }

  console.log('\n----- TEXT -----');
  console.log(cap(htmlToText(body), 16000));

  console.log('\n----- PARSED -----');
  console.log(JSON.stringify(parsePage(body, url, null), null, 2));
}
