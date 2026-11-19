# Astana offline map

DayPact renders an actual OpenStreetMap/Protomaps vector extract with MapLibre GL JS. It does not use 2GIS assets or scrape public OpenStreetMap raster tiles. No map-provider account or API key is required for the checked-in package.

The map uses the provider's ready-made Protomaps light/dark cartography and palettes. It starts as a readable north-up 2D map; 3D is an optional 32-degree view. Language and light/dark/system appearance come from application Settings, with no separate in-map language or theme switch. Street-level labels use one selected language with source-name fallback, and city/country overview labels stop before street zoom. Plan markers are DayPact's overlay on the existing map.

## Checked-in data

| Item                          | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| City                          | Astana, Kazakhstan                                                 |
| Bounds, west/south/east/north | `71.2179735,50.8576076,71.7851913,51.3511101`                      |
| Source                        | `https://build.protomaps.com/20261117.pmtiles`                     |
| OSM replication timestamp     | `2026-11-17T04:00:00Z`                                             |
| Protomaps tileset             | `4.15.2`                                                           |
| Tile zoom levels              | 0–15; the viewer can overzoom to 19                                |
| Archive                       | 9,775,568 bytes, approximately 9.8 MB / 9.3 MiB                    |
| Complete package              | 12,865,003 bytes, approximately 12.9 MB / 12.3 MiB                 |
| Local place index             | 5,673 named points extracted from the same tiles                   |
| Archive SHA-256               | `9569ecfc21b687bb6e6b6e4b0ca4e48e5421a749045d47563f7bd9aa2c8f300b` |

The complete package includes the archive, local Kazakh/Russian/Latin glyph ranges, light/dark sprites, place index and asset licenses. The manifest lists every resource's size and SHA-256. HTTP headers, the manifest itself and application JavaScript are not included in the package-size figure. The app shell and browser storage overhead need additional space.

The archive is a city bounding-box extract, not all of Kazakhstan. OpenStreetMap coverage is community-maintained: not every business, address or building has complete data. Search covers named places in this package and the user's plans, not a worldwide address service. Names use the chosen language when the source provides it, otherwise the original local name; no translations or landmarks are fabricated.

## Real geometry and 3D

The `buildings` vector layer supplies actual building footprints. Optional extrusions use its numeric `height` and `min_height` when available. A building with no height is displayed at a clearly disclosed, illustrative 6 metres. The map information panel states this limitation. These are map extrusions, not photorealistic architectural models or surveyed heights for every building.

At zoom 15 the extracted tiles contain 80,244 building/building-part features, including tile-boundary repetitions; 31,217 features contain positive heights. These are **feature counts, not unique building counts**. Heights in Protomaps can themselves derive from OSM building levels. The UI must not promise that every depicted height is measured.

## Offline implementation

The map component is lazy-loaded by the app. The large package is downloaded only when the user first opens the map or selects its download action. Each file is streamed with progress, bounded to its declared length and verified with Web Crypto SHA-256 before it is put into `daypact-public-map-v1` CacheStorage. Interrupted downloads retain only previously verified complete files, allowing a retry without re-downloading those files.

MapLibre reads the cached archive using PMTiles `FileSource` and `Blob.slice`. It does **not** issue HTTP Range requests for tiles. This matters because Cloudflare Workers Static Assets do not provide Range responses: feeding that host URL directly to a PMTiles `FetchSource` would repeatedly transfer the entire archive or fail.

Glyphs and sprites use a custom local `daypactasset` protocol backed by the same cache. A same-origin bundled MapLibre worker is emitted by Vite. The app service worker precaches built JavaScript, CSS and `.mjs` workers during shell installation, including lazy map code. Downloading the package from Settings therefore supports a first map opening offline. Keep `/maps/` and `/map-assets/` excluded from generic service-worker caching; this module owns their integrity and deletion.

The settings screen shows exact package size, data date, progress, cancellation, deletion, quota/integrity errors and a persistent-storage request. Persistence is browser-controlled. Clearing site data or browser eviction can remove the map. Storage quota is checked before downloads; an actual quota error is also handled. Download speed and mobile memory/performance depend on the device and connection; no fixed time or universal frame-rate guarantee is made.

Map geolocation is requested only by pressing the location button. The watch ends after the first result, cancellation or timeout. Accuracy is shown. There is no background tracking or upload of the current location. A result outside the included city bounds is explained instead of pretending the city package covers it.

Saved map places are kept in device-local IndexedDB, partitioned by authenticated user ID, with a limit of 100 places per account on that device. They are labeled as device-local. They are distinct from a plan's location. The component's `onPickPlace` callback supplies coordinates and label to the parent plan editor; the parent application owns authenticated offline creation and synchronization with permitted plan members. Verify that integration separately from this map module. Merely viewing or saving a local point does not share it.

## Reproduce the package

Use Node 24 and the locked npm dependencies. Obtain the [official PMTiles CLI](https://github.com/protomaps/go-pmtiles/releases), checking the release's SHA-256 before executing it. The packaged extract was made with v1.31.2. Its Windows x86-64 zip SHA-256 was `a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1`.

From the repository root:

```text
pmtiles extract https://build.protomaps.com/20261117.pmtiles public/maps/astana-20261117.pmtiles --bbox=71.2179735,50.8576076,71.7851913,51.3511101 --maxzoom=15 --download-threads=4
pmtiles verify public/maps/astana-20261117.pmtiles
node scripts/maps/prepare.mjs 20261117
node scripts/maps/verify.mjs
```

The official build service retains recent builds for a limited period. An old source URL may expire; the committed, verified city archive remains usable. For an update, select an available official build, repeat extraction with the same bounds, and regenerate the manifest/index. Review the data date, file limits, glyph requirements, hashes and visual result before release. Support assets are pinned to `protomaps/basemaps-assets` commit `028c18f713baecad011301ff7a69acc39bcc2ae7`.

`prepare.mjs` preserves existing local support files. To intentionally update them, replace them from the pinned source and regenerate the manifest. Do not use a stale file silently when changing asset versions. Repackaging does not require Java; upstream Protomaps uses the Java Planetiler pipeline, but the runtime is MapLibre/TypeScript and the static PMTiles archive.

## Local browser verification

`node scripts/maps/serve-qa.mjs` builds an isolated QA page and serves it on `127.0.0.1:5179`. It uses the production map component and service worker with a single local fixture plan. It is not an authentication bypass and is never included in the application's production build.

In a second terminal, set `MAP_QA_URL=http://127.0.0.1:5179/`, and run `node scripts/maps/qa.mjs` and `node scripts/maps/failures-qa.mjs`. Set `CHROME_PATH` if Chrome is installed elsewhere. QA uses its own headless browser profile, not a user's signed-in browser. It checks actual rendering, KK/RU, search, 2D/3D switching, foreground geolocation, private saved-place separation, offline remount/reload and offline point creation. Failure checks reject tampered files before caching, cancel downloads without partial files and surface insufficient storage before download. The ignored `scripts/maps/.qa/` directory contains generated screenshots/build output. A normal Vite server can also serve `scripts/maps/qa.html` for online visual development; offline reload verification requires the built service-worker version.

## Attribution and licenses

- Map data: [OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright). Preserve visible attribution and the source link when sharing or distributing the extract. The archive and derived place index are made available with this repository under the underlying ODbL terms, independently of the application's code license.
- Basemap production and styling: [Protomaps basemaps](https://github.com/protomaps/basemaps), [downloads documentation](https://docs.protomaps.com/basemaps/downloads).
- Fonts: Noto Sans Regular, Medium and Italic, SIL Open Font License; included at `public/map-assets/licenses/Noto-OFL.txt`.
- Map icons: derived from Tangram icons, MIT; included at `public/map-assets/licenses/icons-MIT.txt`.
- Asset provenance: `public/map-assets/licenses/basemaps-assets-README.md` and the pinned upstream commit.
- Rendering: [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js), BSD-3-Clause; [PMTiles](https://github.com/protomaps/PMTiles), BSD-3-Clause. npm dependencies retain their own licenses.

Do not bulk-download `tile.openstreetmap.org`: its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) does not permit offline prefetching. This package instead extracts an explicitly downloadable Protomaps archive.
