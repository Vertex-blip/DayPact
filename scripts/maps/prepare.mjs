/** Reproducible packaging of an official Protomaps extract and its offline resources. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PMTiles, FileSource } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const date = process.argv[2] ?? '20261117';
if (!/^\d{8}$/.test(date)) throw new Error('Pass an eight-digit Protomaps build date.');
const filename = `astana-${date}.pmtiles`;
const path = resolve(root, 'public/maps', filename);
const bytes = await readFile(path);
if (bytes.length > 25 * 1024 * 1024) throw new Error('Archive exceeds the hosting file limit.');
const archive = new PMTiles(new FileSource(new File([bytes], filename)));
const header = await archive.getHeader();
const metadata = await archive.getMetadata();
if (header.tileType !== 1 || header.maxZoom !== 15)
  throw new Error('Expected MVT data through zoom 15.');
const bounds = [71.2179735, 50.8576076, 71.7851913, 51.3511101];
const assetCommit = '028c18f713baecad011301ff7a69acc39bcc2ae7';
const base = `https://raw.githubusercontent.com/protomaps/basemaps-assets/${assetCommit}`;
const resources = [];
for (const font of ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']) {
  for (const first of [0, 256, 512, 768, 1024, 1280, 8192, 8448, 9984, 65024]) {
    resources.push([
      `${base}/fonts/${encodeURIComponent(font)}/${first}-${first + 255}.pbf`,
      `/map-assets/fonts/${encodeURIComponent(font)}/${first}-${first + 255}.pbf`,
    ]);
  }
}
for (const theme of ['dark', 'light'])
  for (const scale of ['', '@2x'])
    for (const ext of ['json', 'png']) {
      resources.push([
        `${base}/sprites/v4/${theme}${scale}.${ext}`,
        `/map-assets/sprites/${theme}${scale}.${ext}`,
      ]);
    }
resources.push([`${base}/fonts/OFL.txt`, '/map-assets/licenses/Noto-OFL.txt']);
resources.push([
  'https://raw.githubusercontent.com/tangrams/icons/master/LICENSE.md',
  '/map-assets/licenses/icons-MIT.txt',
]);
resources.push([`${base}/README.md`, '/map-assets/licenses/basemaps-assets-README.md']);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const supportAssets = [];
for (let i = 0; i < resources.length; i += 4) {
  await Promise.all(
    resources.slice(i, i + 4).map(async ([source, url]) => {
      const target = resolve(root, 'public', decodeURIComponent(url.slice(1)));
      await mkdir(dirname(target), { recursive: true });
      let content;
      try {
        content = await readFile(target);
      } catch {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`${response.status} downloading ${source}`);
        content = Buffer.from(await response.arrayBuffer());
        await writeFile(target, content);
      }
      supportAssets.push({ url, bytes: content.length, sha256: hash(content) });
    }),
  );
}

// Build the local place search from the same real vector tiles; no third-party geocoder.
const tx = (lng) => Math.floor(((lng + 180) / 360) * 32768);
const ty = (lat) =>
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 32768);
const places = new Map();
let buildingCount = 0,
  heightCount = 0;
for (let x = tx(bounds[0]); x <= tx(bounds[2]); x++) {
  for (let y = ty(bounds[3]); y <= ty(bounds[1]); y++) {
    const raw = await archive.getZxy(15, x, y);
    if (!raw) continue;
    const tile = new VectorTile(new PbfReader(new Uint8Array(raw.data)));
    const buildings = tile.layers.buildings;
    if (buildings)
      for (let i = 0; i < buildings.length; i++) {
        const p = buildings.feature(i).properties;
        if (p.kind === 'building' || p.kind === 'building_part') {
          buildingCount++;
          if (typeof p.height === 'number' && p.height > 0) heightCount++;
        }
      }
    for (const layerName of ['pois', 'places']) {
      const layer = tile.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i),
          p = f.properties;
        if (f.type !== 1 || typeof p.name !== 'string') continue;
        const geo = f.toGeoJSON(x, y, 15);
        if (geo.geometry.type !== 'Point') continue;
        const [lng, lat] = geo.geometry.coordinates;
        if (lng < bounds[0] || lng > bounds[2] || lat < bounds[1] || lat > bounds[3]) continue;
        const id = `${lng.toFixed(5)},${lat.toFixed(5)}:${p.name}`;
        places.set(id, {
          lng: +lng.toFixed(6),
          lat: +lat.toFixed(6),
          label: p.name,
          kk: typeof p['name:kk'] === 'string' ? p['name:kk'] : null,
          ru: typeof p['name:ru'] === 'string' ? p['name:ru'] : null,
          kind: p.kind ?? 'place',
        });
      }
    }
  }
}
const placeData = Buffer.from(
  JSON.stringify([...places.values()].sort((a, b) => a.label.localeCompare(b.label))),
);
await writeFile(resolve(root, 'public/map-assets/places.json'), placeData);
supportAssets.push({
  url: '/map-assets/places.json',
  bytes: placeData.length,
  sha256: hash(placeData),
});
supportAssets.sort((a, b) => a.url.localeCompare(b.url));
const manifest = {
  id: `astana-${date}`,
  city: 'Астана',
  url: `/maps/${filename}`,
  bytes: bytes.length,
  sha256: hash(bytes),
  bounds,
  center: [71.4304, 51.1282],
  minZoom: 0,
  maxZoom: 15,
  attribution: '© OpenStreetMap contributors · Protomaps',
  source: `https://build.protomaps.com/${date}.pmtiles`,
  dataDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
  generatedAt: new Date().toISOString(),
  tilesetVersion: metadata.version ?? '4.15.2',
  assetCommit,
  supportAssets,
  totalBytes: bytes.length + supportAssets.reduce((n, a) => n + a.bytes, 0),
  placeCount: places.size,
  buildingFeaturesAtZ15: buildingCount,
  buildingFeaturesWithHeightAtZ15: heightCount,
};
await writeFile(
  resolve(root, 'public/maps/manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  resolve(root, 'public/maps/source-metadata.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    archiveBytes: bytes.length,
    packageBytes: manifest.totalBytes,
    places: places.size,
    buildings: buildingCount,
    withHeight: heightCount,
    sha256: manifest.sha256,
  }),
);
