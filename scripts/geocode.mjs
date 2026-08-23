#!/usr/bin/env node
// Turn data/wineries.raw.json into the map's data/wineries.json by resolving each
// address to a coordinate.
//
//   node scripts/geocode.mjs                # geocode everything missing a coord
//   node scripts/geocode.mjs --refresh      # ignore the cache and re-resolve
//   node scripts/geocode.mjs --no-fallback  # leave un-geocodable wineries off the map
//
// Two free, key-less services are used in order:
//   1. US Census geocoder  - exact, fast, US street addresses only
//   2. OpenStreetMap Nominatim - broader, rate limited to 1 request/second
// Anything still unresolved falls back to the centroid of its town and is flagged
// `precision: "town"` so the map can show it as approximate rather than pretend.
//
// Results are cached in data/geocode-cache.json; re-runs only hit the network for
// addresses that are genuinely new.

import path from 'node:path';
import { DATA, fetchText, readJson, writeJson, sleep, NAPA_PLACES } from './lib.mjs';

const argv = process.argv.slice(2);
const REFRESH = argv.includes('--refresh');
const NO_FALLBACK = argv.includes('--no-fallback');

const RAW = path.join(DATA, 'wineries.raw.json');
const SOURCE_LIST = path.join(DATA, 'source-list.json');
const OUT = path.join(DATA, 'wineries.json');
const CACHE_FILE = path.join(DATA, 'geocode-cache.json');

// Napa County, generously bounded. Anything outside is a bad match, not a winery.
const BOUNDS = { minLat: 38.0, maxLat: 38.95, minLng: -122.75, maxLng: -122.0 };
const inNapa = (lat, lng) =>
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng;

/* --- join with the site's spreadsheet ------------------------------------- */
// The spreadsheet (see scripts/xls-to-json.py) is authoritative for address,
// town, website and phone; review pages are authoritative for the review URL,
// prose visiting notes and archived status. Rows are joined by winery name.

const nameKey = (v) =>
  String(v || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // Château -> Chateau
    .replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

const GENERIC = /\b(the|and|winery|wines|wine|vineyards|vineyard|cellars|cellar|estate|estates|caves|cave|co|company|napa|valley|family)\b/g;
const looseKey = (v) => nameKey(v).replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();

function buildIndex(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const k = keyFn(row.name);
    if (!k) continue;
    map.set(k, map.has(k) ? null : row);   // null marks an ambiguous key
  }
  return map;
}

function joinSpreadsheet(wineries) {
  const src = readJson(SOURCE_LIST);
  if (!src?.wineries?.length) {
    console.warn('No data/source-list.json — run scripts/xls-to-json.py first. Continuing without the spreadsheet.');
    return { matched: 0, total: wineries.length };
  }
  const exact = buildIndex(src.wineries, nameKey);
  const loose = buildIndex(src.wineries, looseKey);
  let matched = 0;
  for (const w of wineries) {
    const row = exact.get(nameKey(w.name)) ||
                exact.get(nameKey(w.slug.replace(/-/g, ' '))) ||
                loose.get(looseKey(w.name)) || null;
    if (!row) continue;
    matched++;
    // Spreadsheet wins where it has a value; page extraction remains the fallback.
    if (row.address) {
      w.address = `${row.address}, ${row.city || 'Napa'}, CA`;
      w.street = row.address;
      w.city = row.city || w.city;
      w.lat = null; w.lng = null;              // re-resolve from the better address
    } else if (row.city) {
      w.city = w.city || row.city;
    }
    w.website = row.website || w.website;
    w.phone = row.phone || w.phone;
    w.visiting = w.visiting || row.visiting;   // prose wording is more precise
    w.cave = row.cave;
    w.archived = false;                        // the sheet lists active wineries only
  }
  return { matched, total: wineries.length };
}

const normalize = (a) =>
  a.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\bst\b/g, 'saint').replace(/\bhwy\b/g, 'highway').trim();

async function census(address) {
  const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  u.searchParams.set('address', address);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('format', 'json');
  const { body } = await fetchText(u.toString(), { retries: 1, timeout: 20000 });
  const m = JSON.parse(body)?.result?.addressMatches?.[0];
  if (!m) return null;
  return { lat: Number(m.coordinates.y), lng: Number(m.coordinates.x), precision: 'rooftop', via: 'census' };
}

async function nominatim(address) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', address);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('countrycodes', 'us');
  u.searchParams.set('limit', '1');
  const { body } = await fetchText(u.toString(), {
    retries: 1,
    timeout: 20000,
    ua: 'napa-winery-map/1.0 (https://github.com/jwillebr/jw-dash)',
  });
  const m = JSON.parse(body)?.[0];
  if (!m) return null;
  return {
    lat: Number(m.lat),
    lng: Number(m.lon),
    precision: /house|building|amenity|shop/i.test(m.category || m.type || '') ? 'rooftop' : 'street',
    via: 'nominatim',
  };
}

function townFallback(w) {
  const hay = `${w.city || ''} ${w.address || ''} ${w.appellation || ''}`.toLowerCase();
  const hit = Object.keys(NAPA_PLACES)
    .sort((a, b) => b.length - a.length)
    .find((place) => hay.includes(place));
  if (!hit) return null;
  const [lat, lng] = NAPA_PLACES[hit];
  return { lat, lng, precision: 'town', via: `centroid:${hit}` };
}

// Spread same-coordinate markers (a shared town centroid, or two brands at one
// address) onto a tiny deterministic ring so every pin stays clickable.
function dejitter(list) {
  const groups = new Map();
  for (const w of list) {
    if (w.lat == null) continue;
    const key = `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const radius = group[0].precision === 'town' ? 0.010 : 0.00025;
    group.forEach((w, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      w.lat = Number((w.lat + radius * Math.sin(angle)).toFixed(6));
      w.lng = Number((w.lng + radius * Math.cos(angle) * 1.27).toFixed(6));
      w.offset = true;
    });
  }
}

async function main() {
  const raw = readJson(RAW);
  if (!raw?.wineries?.length) {
    console.error(`No input. Run \`npm run scrape\` first (expected ${path.relative(process.cwd(), RAW)}).`);
    process.exit(1);
  }
  const join = joinSpreadsheet(raw.wineries);
  console.log(`Spreadsheet join: ${join.matched}/${join.total} reviews matched`);

  const cache = (!REFRESH && readJson(CACHE_FILE)) || {};
  const stats = { cached: 0, census: 0, nominatim: 0, town: 0, embedded: 0, failed: 0 };
  const out = [];
  let nominatimCalls = 0;

  for (const [i, w] of raw.wineries.entries()) {
    const rec = {
      slug: w.slug, name: w.name, url: w.url, address: w.address, city: w.city,
      appellation: w.appellation, phone: w.phone, website: w.website,
      visiting: w.visiting, cave: !!w.cave, archived: !!w.archived,
      lat: null, lng: null, precision: null,
    };

    if (w.lat != null && w.lng != null && inNapa(w.lat, w.lng)) {
      Object.assign(rec, { lat: w.lat, lng: w.lng, precision: 'rooftop' });
      stats.embedded++;
    } else if (w.address) {
      const key = normalize(w.address);
      let hit = cache[key];
      const fromCache = hit !== undefined;
      if (!fromCache) {
        for (const [fn, label] of [[census, 'census'], [nominatim, 'nominatim']]) {
          if (label === 'nominatim') { await sleep(nominatimCalls++ ? 1100 : 0); }
          try {
            const r = await fn(`${w.address}${/\bCA\b/i.test(w.address) ? '' : ', CA'}`);
            if (r && inNapa(r.lat, r.lng)) { hit = r; break; }
          } catch (err) {
            console.warn(`\n  ! ${label} ${w.name}: ${err.message}`);
          }
        }
        cache[key] = hit || null;
        if (i % 20 === 0) writeJson(CACHE_FILE, cache);   // checkpoint a long run
      }
      if (hit) {
        Object.assign(rec, { lat: hit.lat, lng: hit.lng, precision: hit.precision });
        if (fromCache) stats.cached++;
        else if (hit.via === 'census') stats.census++;
        else if (hit.via === 'nominatim') stats.nominatim++;
      }
    }

    if (rec.lat == null && !NO_FALLBACK) {
      const fb = townFallback(w);
      if (fb) { Object.assign(rec, fb); stats.town++; }
    }
    if (rec.lat == null) stats.failed++;

    out.push(rec);
    process.stdout.write(`\r  ${i + 1}/${raw.wineries.length} geocoded`);
  }
  process.stdout.write('\n');
  writeJson(CACHE_FILE, cache);

  const mapped = out.filter((w) => w.lat != null);
  dejitter(mapped);

  writeJson(OUT, {
    source: raw.source,
    scrapedAt: raw.scrapedAt,
    geocodedAt: new Date().toISOString(),
    count: out.length,
    mapped: mapped.length,
    wineries: out,
  });

  console.log(`\nWrote ${out.length} wineries (${mapped.length} on the map) -> data/wineries.json`);
  console.log(`  exact from page   : ${stats.embedded}`);
  console.log(`  census geocoder   : ${stats.census}`);
  console.log(`  nominatim         : ${stats.nominatim}`);
  console.log(`  cached            : ${stats.cached}`);
  console.log(`  town centroid     : ${stats.town}   (shown as approximate)`);
  console.log(`  no location       : ${stats.failed}`);
  console.log('\nOpen the map with:  npm run serve');
}

main().catch((err) => { console.error(err); process.exit(1); });
