#!/usr/bin/env node
// Crawl napawineproject.com/reviews/ and write data/wineries.raw.json.
//
//   node scripts/scrape.mjs                 # full crawl
//   node scripts/scrape.mjs --limit 25      # smoke test on the first 25 reviews
//   node scripts/scrape.mjs --index-only    # just discover review URLs, no detail pages
//   node scripts/scrape.mjs --dump <slug>   # save one page's HTML to data/debug/ and exit
//   node scripts/scrape.mjs --concurrency 4 --delay 250
//
// The site is WordPress and its markup may change, so extraction tries several
// strategies per field and records which one won in `_source`. Anything it cannot
// parse is left null rather than guessed, and listed in the run summary.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DATA, fetchText, htmlToText, decodeEntities, slugFromUrl, sleep, writeJson,
  NAPA_TOWN_RE,
} from './lib.mjs';

const ORIGIN = 'https://www.napawineproject.com';
const INDEX = `${ORIGIN}/reviews/`;

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const LIMIT = Number(flag('limit', 0)) || 0;
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 4)) || 4);
const DELAY = Number(flag('delay', 250)) || 0;
const INDEX_ONLY = argv.includes('--index-only');
const DUMP = flag('dump', null);

// Paths on the site that are pages *about* the project rather than winery reviews.
const NON_REVIEW = new RegExp(
  [
    '^$', 'reviews', 'faq', 'about', 'contact', 'privacy', 'terms', 'sitemap',
    'project-notes', 'blog', 'news', 'press', 'links', 'search', 'shop', 'cart',
    'checkout', 'my-account', 'subscribe', 'newsletter', 'advertise', 'donate',
    'services', 'consulting', 'cellar-curation', 'wine-tasting', 'resources',
    'map', 'discoveries', 'priority-wine-pass', 'sign-up-info', 'sign-up-details',
    'archived-napa-valley-winery-reviews',
    'wp-content', 'wp-admin', 'wp-json', 'feed', 'author', 'category', 'tag',
    'page', 'comments', 'wineries-of-napa-valley', 'napa-valley-wineries',
    'year-in-review', 'index',
  ].map((s) => `^${s}$`).join('|'),
  'i'
);
const isReviewPath = (p) => {
  const seg = p.replace(/^\/+|\/+$/g, '').split('/');
  if (seg.length !== 1) return false;               // reviews live at the site root
  const s = seg[0];
  if (!s || NON_REVIEW.test(s)) return false;
  if (/^\d{4}(-|$)/.test(s)) return false;          // 2024-napa-valley-year-in-review
  if (/-review$|-in-review$/.test(s)) return false;
  if (/^(concierge|sign-up|napa-valley-(wine|tasting))/.test(s)) return false;
  if (/\.(xls|xlsx|pdf|jpg|png|zip|csv)$/i.test(s)) return false;
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(s);
};

function absolute(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function linksIn(html, base) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = absolute(m[1], base);
    if (!url) continue;
    out.push({ url, text: decodeEntities(m[2]) });
  }
  return out;
}

/* ------------------------------------------------------------------ index --- */

async function discoverReviewUrls() {
  const found = new Map();     // url -> link text from the index
  const visited = new Set();
  const queue = [INDEX];

  // The index is alphabetical; depending on the theme it is one long page, a set of
  // letter pages, or paginated. Seed all three shapes and keep whichever respond.
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') queue.push(`${INDEX}${letter}/`);

  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let body;
    try {
      const res = await fetchText(url);
      if (res.status === 404) continue;
      body = res.body;
    } catch (err) {
      console.warn(`  ! index ${url}: ${err.message}`);
      continue;
    }
    if (!body) continue;

    let added = 0;
    for (const { url: href, text } of linksIn(body, url)) {
      const u = new URL(href);
      if (u.host !== new URL(ORIGIN).host) continue;

      // follow pagination of the review index only
      if (/^\/reviews\/(page\/\d+|[a-z])\/?$/i.test(u.pathname) && !visited.has(u.toString())) {
        queue.push(u.toString());
        continue;
      }
      if (!isReviewPath(u.pathname)) continue;

      const clean = `${ORIGIN}${u.pathname.replace(/\/+$/, '')}/`;
      if (!found.has(clean)) { found.set(clean, text); added++; }
    }
    console.log(`  index ${url} -> +${added} (total ${found.size})`);
    if (DELAY) await sleep(DELAY);
  }
  return found;
}

/* ----------------------------------------------------------------- detail --- */

const RE = {
  jsonLd: /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ogTitle: /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  h1: /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  title: /<title[^>]*>([\s\S]*?)<\/title>/i,
  phone: /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/,
  // "1234 Silverado Trail, St. Helena, CA 94574" / "PO Box 123, Napa, CA"
  address: new RegExp(
    String.raw`((?:\d{1,6}[A-Za-z]?\s|P\.?\s?O\.?\s?Box\s)[^,\n]{2,70}?)\s*,\s*` +
    String.raw`([A-Za-z.\s]{3,25}?)\s*,\s*(CA|California)\b\.?\s*(\d{5})?`,
    'i'
  ),
  extLink: /<a\b[^>]*href\s*=\s*["'](https?:\/\/(?!(?:www\.)?napawineproject\.com)[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
};

const AVAS = [
  'Atlas Peak', 'Calistoga', 'Chiles Valley', 'Coombsville', 'Diamond Mountain District',
  'Howell Mountain', 'Los Carneros', 'Mount Veeder', 'Oak Knoll District', 'Oakville',
  'Rutherford', 'Spring Mountain District', "Stags Leap District", 'St. Helena',
  'Wild Horse Valley', 'Yountville',
];

function jsonLdNodes(html) {
  const nodes = [];
  RE.jsonLd.lastIndex = 0;
  let m;
  while ((m = RE.jsonLd.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [parsed];
    while (stack.length) {
      const n = stack.pop();
      if (Array.isArray(n)) { stack.push(...n); continue; }
      if (n && typeof n === 'object') {
        nodes.push(n);
        if (n['@graph']) stack.push(n['@graph']);
      }
    }
  }
  return nodes;
}

function pickName(html, fallbackSlug, indexText) {
  const strip = (s) =>
    decodeEntities(s)
      .replace(/\s*[|–—-]\s*(The\s+)?Napa Wine Project\s*$/i, '')
      .replace(/\s*–\s*Napa Valley.*$/i, '')
      .trim();

  for (const node of jsonLdNodes(html)) {
    if (node.name && /Winery|LocalBusiness|Organization|Place|Product/i.test(String(node['@type'] || ''))) {
      return { value: strip(node.name), _source: 'jsonld' };
    }
  }
  let m = html.match(RE.h1);
  if (m && strip(m[1])) return { value: strip(m[1]), _source: 'h1' };
  m = html.match(RE.ogTitle);
  if (m && strip(m[1])) return { value: strip(m[1]), _source: 'og:title' };
  m = html.match(RE.title);
  if (m && strip(m[1])) return { value: strip(m[1]), _source: 'title' };
  if (indexText) return { value: indexText, _source: 'index-link' };
  return {
    value: fallbackSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    _source: 'slug',
  };
}

function pickAddress(html, text) {
  for (const node of jsonLdNodes(html)) {
    const a = node.address;
    if (a && typeof a === 'object' && (a.streetAddress || a.addressLocality)) {
      const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
        .filter(Boolean).map(String).map((s) => s.trim());
      if (parts.length >= 2) {
        return {
          value: parts.join(', '),
          street: a.streetAddress || null,
          city: a.addressLocality || null,
          zip: a.postalCode || null,
          _source: 'jsonld',
        };
      }
    }
    if (node.geo && node.geo.latitude && node.geo.longitude) {
      // handled separately by pickGeo
    }
  }
  // Prefer an address line that names a Napa County town.
  const lines = text.split('\n');
  let best = null;
  for (const line of lines) {
    const m = line.match(RE.address);
    if (!m) continue;
    const city = m[2].trim().replace(/\s+/g, ' ');
    const cand = {
      value: `${m[1].trim()}, ${city}, CA${m[4] ? ' ' + m[4] : ''}`,
      street: m[1].trim(), city, zip: m[4] || null,
      _source: 'text',
    };
    if (NAPA_TOWN_RE.test(city)) return cand;
    best = best || cand;
  }
  return best;
}

function pickGeo(html) {
  for (const node of jsonLdNodes(html)) {
    const g = node.geo || (node.address && node.address.geo);
    const lat = Number(g?.latitude), lng = Number(g?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat && lng) {
      return { lat, lng, _source: 'jsonld' };
    }
  }
  // Some themes embed a Google Maps iframe/link with coordinates.
  const m = html.match(/[?&@](?:q=|ll=|center=)?(-?3[5-9]\.\d{3,}),\s*(-?12[0-3]\.\d{3,})/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]), _source: 'embed' };
  return null;
}

function pickPhone(html, text) {
  // JSON-LD first: script bodies are stripped before the text scan, so a telephone
  // that only lives in structured data would otherwise be lost.
  for (const node of jsonLdNodes(html)) {
    const m = String(node.telephone || '').match(RE.phone);
    if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  }
  const m = text.match(RE.phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : null;
}

function pickWebsite(html) {
  for (const node of jsonLdNodes(html)) {
    if (!/Winery|LocalBusiness/i.test(String(node['@type'] || ''))) continue;
    const u = node.url || (Array.isArray(node.sameAs) ? node.sameAs[0] : node.sameAs);
    if (typeof u === 'string' && /^https?:\/\//.test(u) && !/napawineproject\.com/.test(u)) {
      return u;
    }
  }
  RE.extLink.lastIndex = 0;
  const skip = /facebook|instagram|twitter|x\.com|youtube|linkedin|pinterest|yelp|tripadvisor|google\.|wordpress|gravatar|vivino|wine-searcher|mailto|daveswines|addtoany|prioritywinepass|migwine|destination-napavalley|akismet|vimeo|davestravel/i;
  const candidates = [];
  let m;
  while ((m = RE.extLink.exec(html))) {
    const url = m[1];
    if (skip.test(url)) continue;
    candidates.push({ url, label: decodeEntities(m[2]) });
  }
  // The site links each winery as <a href="http://www.x.com">www.x.com</a> —
  // an anchor whose text mirrors its own host is the winery's site.
  const self = candidates.find((c) => {
    try {
      const host = new URL(c.url).host.replace(/^www\./, '');
      return c.label.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') === host ||
             c.label.replace(/^www\./, '').startsWith(host);
    } catch { return false; }
  });
  const labelled = candidates.find((c) => /website|visit .*site|official/i.test(c.label));
  return (self || labelled)?.url || null;
}

function pickAppellation(text, address) {
  const hay = `${text.slice(0, 4000)} ${address?.value || ''}`;
  // Longest AVA name first so "St. Helena" doesn't shadow nothing and
  // "Diamond Mountain District" wins over a bare town match.
  for (const ava of [...AVAS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${ava.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\.\s/, '\\.?\\s*')}\\b`, 'i');
    if (re.test(hay)) return ava;
  }
  return null;
}

function pickVisiting(text) {
  const t = text.toLowerCase().replace(/\s+/g, ' ');   // source line breaks split phrases
  if (/\bby appointment only\b|\bappointment only\b/.test(t)) return 'By appointment only';
  if (/\bby appointment\b|\bappointments? (are )?(required|recommended)\b/.test(t)) return 'By appointment';
  if (/\bwalk[- ]?ins? (are )?welcome\b|\bno appointment (is )?(necessary|needed|required)\b/.test(t)) return 'Walk-ins welcome';
  if (/\bnot open to the public\b|\bdoes not (have|offer) (a )?tasting\b|\bno tasting room\b/.test(t)) return 'Not open to the public';
  return null;
}

function pickArchived(html, rawText) {
  const text = rawText.replace(/\s+/g, ' ');
  return /\barchived\b/i.test(text.slice(0, 1500)) ||
    /class=["'][^"']*\barchive[d]?\b/i.test(html.slice(0, 4000)) ||
    /no longer (in business|producing|exists)|winery (is )?closed|brand (is )?no longer/i.test(text);
}

// Exported so scripts/test-parse.mjs can exercise extraction without the network.
export function parsePage(body, url, indexText) {
  const slug = slugFromUrl(url);
  // Everything below the comment form is reader-written; never extract from it.
  const text = htmlToText(body).split(/\n\s*(?:Leave a Reply|Post Comment|Comments\b)/i)[0];

  const name = pickName(body, slug, indexText);
  const address = pickAddress(body, text);
  const geo = pickGeo(body);

  return {
    slug,
    name: name.value,
    url,
    address: address?.value || null,
    street: address?.street || null,
    city: address?.city || null,
    zip: address?.zip || null,
    appellation: pickAppellation(text, address),
    phone: pickPhone(body, text),
    website: pickWebsite(body),
    visiting: pickVisiting(text),
    archived: pickArchived(body, text),
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    _source: {
      name: name._source,
      address: address?._source || null,
      geo: geo?._source || null,
    },
  };
}

async function scrapeOne(url, indexText) {
  const { status, body } = await fetchText(url);
  if (status === 404 || !body) return null;
  return parsePage(body, url, indexText);
}

/* -------------------------------------------------------------------- run --- */

async function main() {
  if (DUMP) {
    const url = String(DUMP).startsWith('http') ? String(DUMP) : `${ORIGIN}/${DUMP}/`;
    const { body } = await fetchText(url);
    const out = path.join(DATA, 'debug', `${slugFromUrl(url) || 'page'}.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    console.log(`Saved ${body.length} bytes to ${path.relative(process.cwd(), out)}`);
    console.log('--- parsed ---');
    console.log(JSON.stringify(await scrapeOne(url, null), null, 2));
    return;
  }

  console.log('Discovering review pages...');
  const index = await discoverReviewUrls();
  let urls = [...index.keys()].sort();
  console.log(`Found ${urls.length} candidate review pages.`);
  writeJson(path.join(DATA, 'review-urls.json'), urls);

  if (!urls.length) {
    console.error(
      '\nNo review links matched. The index markup probably changed.\n' +
      `Run:  node scripts/scrape.mjs --dump reviews\n` +
      'and inspect data/debug/reviews.html to adjust isReviewPath().'
    );
    process.exitCode = 1;
    return;
  }
  if (INDEX_ONLY) return;
  if (LIMIT) urls = urls.slice(0, LIMIT);

  const results = [];
  const failures = [];
  let done = 0;
  const queue = urls.slice();

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const rec = await scrapeOne(url, index.get(url));
        if (rec) results.push(rec);
        else failures.push({ url, reason: 'not found' });
      } catch (err) {
        failures.push({ url, reason: err.message });
      }
      done++;
      if (done % 25 === 0 || done === urls.length) {
        process.stdout.write(`\r  ${done}/${urls.length} pages`);
      }
      if (DELAY) await sleep(DELAY);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');

  results.sort((a, b) => a.name.localeCompare(b.name));
  const withAddress = results.filter((r) => r.address).length;
  const out = {
    source: INDEX,
    scrapedAt: new Date().toISOString(),
    count: results.length,
    wineries: results,
  };
  writeJson(path.join(DATA, 'wineries.raw.json'), out);
  if (failures.length) writeJson(path.join(DATA, 'scrape-failures.json'), failures);

  console.log(`\nScraped ${results.length} wineries -> data/wineries.raw.json`);
  console.log(`  with a street address : ${withAddress}`);
  console.log(`  with coords already   : ${results.filter((r) => r.lat).length}`);
  console.log(`  with an appellation   : ${results.filter((r) => r.appellation).length}`);
  console.log(`  failed to fetch       : ${failures.length}`);
  console.log('\nNext:  npm run geocode');
  if (withAddress < results.length * 0.5) {
    console.log(
      '\nFewer than half the pages yielded an address. Inspect one with:\n' +
      `  node scripts/scrape.mjs --dump ${results[0]?.slug || 'reviews'}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
