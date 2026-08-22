# jw-dash

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

**Scrape** (`scripts/scrape.mjs`) discovers review URLs from `/reviews/`, its
letter pages and its pagination, then reads each review page. Every field is
extracted by trying the most reliable source first and falling back:

- **name** — schema.org JSON-LD → `<h1>` → `og:title` → `<title>` → index link text
- **address** — JSON-LD `PostalAddress` → an address line in the prose that names a
  Napa County town
- **coordinates** — JSON-LD `geo` → coordinates in an embedded map link
- **phone / website / appellation / visiting policy / archived** — JSON-LD where the
  site publishes it, pattern matching otherwise

Anything it can't determine is left `null`, never guessed. The run prints how many
records got each field; if the site's markup shifts, that summary is the tell, and
`--dump <slug>` shows you exactly what one page parsed to.

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
- **Filter** by appellation and by visiting policy; toggle archived/closed brands and
  approximate locations.
- **The list follows the map** by default; switch that off to list every match.
- **Click a pin or a row** to open the winery, with its address, phone, site, a link
  to its review and a directions link. `Esc` clears the selection.
- **Pin colour** encodes visiting policy (walk-in / by appointment / not open /
  unrecorded) — four values, which is what a categorical palette can carry legibly.
  Appellation has sixteen values, so it filters rather than colours.
- The URL tracks search, filters and selection, so any view can be linked or bookmarked.

Light and dark themes both follow the OS setting, and the layout collapses to a
map with a pull-up list sheet on phones.

### Attribution

Winery reviews, names and details are the work of
[The Napa Wine Project](https://www.napawineproject.com/reviews/); every pin links
back to its source review. Basemap © OpenStreetMap contributors, © CARTO.
Geocoding by the US Census Bureau and OpenStreetMap Nominatim.
