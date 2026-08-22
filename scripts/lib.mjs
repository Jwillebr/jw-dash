// Shared helpers for the Napa Wine Project scraper / geocoder.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA = path.join(ROOT, 'data');

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).
// Re-export a fetch with retries, a real UA and a timeout so a flaky hop doesn't kill a
// 900-page crawl.
export async function fetchText(url, { retries = 3, timeout = 30000, ua } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': ua || 'napa-winery-map/1.0 (personal mapping project)',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (res.status === 404 || res.status === 410) return { status: res.status, body: '' };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, body: await res.text(), url: res.url };
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetch failed for ${url}: ${lastErr?.message || lastErr}`);
}

// Minimal, dependency-free HTML -> text. Good enough for pulling addresses and phone
// numbers out of a WordPress page.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#8212;|&mdash;/gi, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&[a-z#0-9]{2,8};/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function decodeEntities(s) {
  return htmlToText(s).replace(/\s+/g, ' ').trim();
}

export function slugFromUrl(u) {
  try {
    return new URL(u).pathname.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
  } catch {
    return '';
  }
}

// Towns and AVAs of Napa County, used to recognise an address line and to place a
// marker approximately when a street address will not geocode.
export const NAPA_PLACES = {
  'napa': [38.2975, -122.2869],
  'yountville': [38.4016, -122.3608],
  'oakville': [38.4319, -122.4014],
  'rutherford': [38.4599, -122.4222],
  'st. helena': [38.5052, -122.4703],
  'saint helena': [38.5052, -122.4703],
  'st helena': [38.5052, -122.4703],
  'calistoga': [38.5788, -122.5797],
  'american canyon': [38.1749, -122.2608],
  'angwin': [38.5760, -122.4494],
  'deer park': [38.5330, -122.4681],
  'pope valley': [38.6135, -122.4247],
  'oak knoll': [38.3600, -122.3300],
  'coombsville': [38.2900, -122.2350],
  'carneros': [38.2400, -122.3600],
  'los carneros': [38.2400, -122.3600],
  'spring mountain': [38.5300, -122.5250],
  'howell mountain': [38.5800, -122.4300],
  'diamond mountain': [38.5650, -122.5600],
  'mount veeder': [38.4000, -122.4600],
  'atlas peak': [38.4100, -122.2200],
  'chiles valley': [38.5300, -122.3300],
  'wild horse valley': [38.2900, -122.1900],
  'stags leap': [38.4100, -122.3300],
  'stags leap district': [38.4100, -122.3300],
};

export const NAPA_TOWN_RE =
  /(american canyon|angwin|calistoga|deer park|napa|oakville|pope valley|rutherford|saint helena|st\.?\s*helena|yountville)/i;
