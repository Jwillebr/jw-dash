# jw-dash

> **The winery map has moved to [Jwillebr/NapaWineMap](https://github.com/Jwillebr/NapaWineMap)**
> (live at https://jwillebr.github.io/NapaWineMap/). This copy still serves at its old URL
> but no longer refreshes its data automatically; new development happens in the new repo.

Two independent static pages:

| Page | What it is |
|------|------------|
| `index.html` | Key-protected dashboard loader (fetches its markup from a Supabase function). Unchanged. |
| `map.html` | **Interactive map of every winery reviewed by [The Napa Wine Project](https://www.napawineproject.com/reviews/).** |

---

## The winery map

`map.html` is a self-contained page: Leaflet and its marker-cluster plugin are
vendored into `vendor/`, so the only thing it fetches at runtime is
`data/wineries.json` (same origin) and basemap tiles from CARTO.

**Data does not ship with the repo** — `data/wineries.json` is generated from the
review site by the scripts below, so the map always reflects a run you did yourself
rather than a stale snapshot baked into git.

### Getting the data

```bash
npm run build     # scrape the review index + every review page, then geocode
npm run serve     # http://localhost:8080/map.html
```

`npm run build` is two steps you can also run separately:

```bash
npm run scrape    # crawls /reviews/, writes data/wineries.raw.json
npm run geocode   # resolves addresses, writes data/wineries.json
```

Useful flags while iterating:

```bash
node scripts/scrape.mjs --limit 25          # smoke test on 25 reviews
node scripts/scrape.mjs --index-only        # just list the review URLs it found
node scripts/scrape.mjs --dump larkmead-vineyards   # save one page's HTML + parse it
node scripts/geocode.mjs --refresh          # ignore the geocode cache
node scripts/geocode.mjs --no-fallback      # drop wineries that won't geocode
```

The crawl is polite by default (4 workers, 250 ms apart) and takes roughly 10–15
minutes for ~850 reviews. Geocoding is cached in `data/geocode-cache.json`, so a
second run costs almost nothing.

Commit `data/wineries.json` when you're happy with it — that file plus `map.html`
and `vendor/` is the whole deployable site (GitHub Pages, S3, anything static).

### How the data is produced

**Scrape** (`scripts/scrape.mjs`) discovers review URLs from `/reviews/` and reads
each review page for the fields the pages actually carry: name, review URL, the
prose visiting policy, archived status, and (as fallbacks) website and address.

**Join** — review pages rarely publish addresses, so the build also downloads the
site's own winery spreadsheet (`Wineries-Napa-Valley.xls`, refreshed by its author)
and `scripts/xls-to-json.py` converts it. `scripts/geocode.mjs` joins the two by
winery name (accent/`&`/suffix-tolerant): the spreadsheet is authoritative for
address, town, website, phone and wine-cave status; the review page for the review
link, visiting wording and archived flag. Anything undetermined stays `null`,
never guessed, and each run prints match and coverage counts —
`node scripts/debug-dump.mjs <slug>` shows exactly what one live page parses to.

**Geocode** (`scripts/geocode.mjs`) resolves each address with the US Census
geocoder, falling back to OpenStreetMap Nominatim (rate-limited to 1 req/s, as its
policy requires). Results outside a Napa County bounding box are rejected as bad
matches. An address that still won't resolve falls back to its town centroid and is
tagged `precision: "town"` — the map draws those faded and says so in the popup, so
an approximate pin never passes as an exact one. Markers that land on identical
coordinates are spread onto a small deterministic ring so each stays clickable.

`npm test` runs offline checks of the extractors against fixture markup — run it
after any change to the parsing regexes.

### Using the map

- **Search** name, town, appellation or visiting policy — press `/` to jump to the box.
- **Filter** by town and by visiting policy; a wine-cave toggle; toggles for
  archived/closed brands and approximate locations.
- **The list follows the map** by default; switch that off to list every match.
- **Click a pin or a row** to open the winery, with its address, phone, site, a link
  to its review and a directions link. `Esc` clears the selection.
- **Pin colour** encodes visiting policy (walk-in / by appointment / not open /
  unrecorded) — four values, which is what a categorical palette can carry legibly.
  Towns filter rather than colour.
- The URL tracks search, filters and selection, so any view can be linked or bookmarked.

Light and dark themes both follow the OS setting, and the layout collapses to a
map with a pull-up list sheet on phones.

### On your phone

The map is a PWA. Once it's hosted (below), open it on your phone and add it to
the home screen — **Share → Add to Home Screen** on iOS, **⋮ → Add to Home
screen** on Android — and it launches full-screen like an app.

A service worker makes it resilient to the valley's patchy cell coverage: the
app itself and the full winery dataset are cached on first visit, and any map
area you've already viewed stays available offline. With no signal you can still
search, filter, browse every winery and read addresses/phones; only unvisited
basemap areas need a connection. After you publish new data, a reload picks it
up (the data fetch is network-first).

### Hosting (GitHub Pages)

`.github/workflows/pages.yml` deploys the repo root to GitHub Pages on every
push to `main` — no settings to click; the first run creates the site. After
merging this branch and committing `data/wineries.json`, the map lives at:

```
https://jwillebr.github.io/jw-dash/map.html
```

(`index.html`, the dashboard loader, is served unchanged alongside it.)

### Automatic refresh

The scrape workflow also runs on a weekly schedule (Mondays ~6am Pacific). When
the site has new or changed wineries it commits the refreshed data and redeploys
the map; when nothing changed it exits quietly. Manual runs via Actions → "Scrape
winery data" still work any time. (If the repository sees no commits for 60 days,
GitHub pauses scheduled workflows and emails you a re-enable link.)

### Attribution

Winery reviews, names and details are the work of
[The Napa Wine Project](https://www.napawineproject.com/reviews/); every pin links
back to its source review. Basemap © OpenStreetMap contributors, © CARTO.
Geocoding by the US Census Bureau and OpenStreetMap Nominatim.
