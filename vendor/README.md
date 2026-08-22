Third-party assets, vendored so `map.html` has no CDN dependency.

| Path | Package | Version | Licence |
|------|---------|---------|---------|
| `leaflet/` | [leaflet](https://leafletjs.com/) | 1.9.4 | BSD-2-Clause (`leaflet/LICENSE`) |
| `markercluster/` | [leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) | 1.5.3 | MIT (`markercluster/LICENSE`) |

Copied verbatim from each package's `dist/` on npm. To refresh:

```bash
npm pack leaflet@<v> leaflet.markercluster@<v>
```
