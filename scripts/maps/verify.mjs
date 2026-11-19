import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PMTiles, FileSource } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await readFile(resolve(root, 'public/maps/manifest.json'), 'utf8'));
const files = [
  { url: manifest.url, bytes: manifest.bytes, sha256: manifest.sha256 },
  ...manifest.supportAssets,
];
let total = 0;
for (const file of files) {
  assert.match(file.url, /^\/(maps|map-assets)\//);
  assert(!file.url.includes('..'));
  const bytes = await readFile(resolve(root, 'public', decodeURIComponent(file.url.slice(1))));
  assert.equal(bytes.length, file.bytes, `Size: ${file.url}`);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    file.sha256,
    `Integrity: ${file.url}`,
  );
  assert(bytes.length <= 25 * 1024 * 1024, `Hosting limit: ${file.url}`);
  total += bytes.length;
}
assert.equal(total, manifest.totalBytes);
const bytes = await readFile(resolve(root, 'public', manifest.url.slice(1)));
const pm = new PMTiles(new FileSource(new File([bytes], `${manifest.id}.pmtiles`)));
const header = await pm.getHeader();
assert.equal(header.tileType, 1);
assert.equal(header.maxZoom, 15);
assert(header.numTileEntries > 100);
const [lng, lat] = manifest.center,
  z = 15,
  x = Math.floor(((lng + 180) / 360) * 2 ** z),
  y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const raw = await pm.getZxy(z, x, y);
assert(raw, 'Central Astana tile exists');
const tile = new VectorTile(new PbfReader(new Uint8Array(raw.data)));
assert(tile.layers.buildings?.length > 0, 'Real building footprints');
assert(tile.layers.roads?.length > 0, 'Real roads');
const places = JSON.parse(await readFile(resolve(root, 'public/map-assets/places.json'), 'utf8'));
assert.equal(places.length, manifest.placeCount);
assert(
  places.some(
    (p) =>
      p.kind === 'monument' &&
      Math.abs(p.lng - 71.430455) < 0.001 &&
      Math.abs(p.lat - 51.128287) < 0.001,
  ),
  'Bayterek real POI exists',
);
for (const place of places) {
  assert(Number.isFinite(place.lng) && Number.isFinite(place.lat));
  assert.equal(typeof place.label, 'string');
  assert(
    place.lng >= manifest.bounds[0] &&
      place.lng <= manifest.bounds[2] &&
      place.lat >= manifest.bounds[1] &&
      place.lat <= manifest.bounds[3],
  );
}
for (const name of ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'])
  assert(
    manifest.supportAssets.some(
      (a) => a.url === `/map-assets/fonts/${encodeURIComponent(name)}/1024-1279.pbf`,
    ),
    'Kazakh/Russian glyphs',
  );
console.log(
  JSON.stringify({
    verifiedFiles: files.length,
    totalBytes: total,
    places: places.length,
    centralBuildingFeatures: tile.layers.buildings.length,
    centralRoadFeatures: tile.layers.roads.length,
    archiveSha256: manifest.sha256,
  }),
);
