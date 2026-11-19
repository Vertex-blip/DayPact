import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { FileSource, PMTiles, Protocol } from 'pmtiles';
import type { Locale } from '../../shared/contracts';
import { mapArchiveFile, readMapResource, type OfflineManifest } from './offlinePackage';

const protocol = new Protocol();
let registered = false;
export async function offlineStyle(
  manifest: OfflineManifest,
  locale: Locale,
  light: boolean,
  buildings: boolean,
): Promise<StyleSpecification> {
  if (!registered) {
    // Vite emits the worker as a same-origin asset, including in production/offline.
    maplibregl.setWorkerUrl(workerUrl);
    maplibregl.addProtocol('pmtiles', protocol.tile);
    maplibregl.addProtocol('daypactasset', async (request, abortController) => {
      const url = new URL(request.url);
      const response = await readMapResource(
        `/${url.hostname}${url.pathname}`,
        abortController.signal,
      );
      return {
        data: request.type === 'json' ? await response.json() : await response.arrayBuffer(),
      };
    });
    registered = true;
  }
  const key = `${manifest.id}.pmtiles`;
  if (!protocol.get(key)) protocol.add(new PMTiles(new FileSource(await mapArchiveFile(manifest))));
  const flavor = namedFlavor(light ? 'light' : 'dark');
  // Keep the provider's ready-made cartography and palette. DayPact only adds
  // localized labels, plan markers and the optional building extrusion layer.
  const mapLayers = layers('astana', flavor, { lang: locale });
  // Only local Kazakh/Russian/Latin glyphs are shipped. Prefer a localized name,
  // then the actual local OSM name; don't synthesize translated place names.
  for (const layer of mapLayers)
    if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      if (!layer.id.includes('shield') && !layer.id.includes('address')) {
        layer.layout['text-field'] = [
          'coalesce',
          ['get', `name:${locale}`],
          ['get', 'name'],
          ['get', 'name:en'],
          '',
        ];
      }
      // Country/city labels belong to an overview, not on top of street-level POIs.
      if (layer.id === 'places_locality') layer.maxzoom = 14;
      if (layer.id === 'places_region') layer.maxzoom = 12;
      if (layer.id === 'places_country') layer.maxzoom = 10;
      if (!light && !layer.id.includes('shield')) {
        layer.paint = {
          ...layer.paint,
          'text-color': layer.id === 'pois' ? '#c2cad6' : '#acb4c0',
          'text-halo-color': '#1b2027',
          'text-halo-width': 1.1,
        };
      }
    }
  const firstSymbol = mapLayers.findIndex((layer) => layer.type === 'symbol');
  mapLayers.splice(firstSymbol < 0 ? mapLayers.length : firstSymbol, 0, {
    id: 'daypact-buildings-3d',
    type: 'fill-extrusion',
    source: 'astana',
    'source-layer': 'buildings',
    minzoom: 14,
    filter: ['in', 'kind', 'building', 'building_part'],
    layout: { visibility: buildings ? 'visible' : 'none' },
    paint: {
      'fill-extrusion-color': flavor.buildings,
      'fill-extrusion-opacity': 0.9,
      'fill-extrusion-height': [
        'max',
        2,
        [
          'case',
          ['all', ['has', 'height'], ['>', ['to-number', ['get', 'height'], 0], 0]],
          ['to-number', ['get', 'height'], 6],
          6,
        ],
      ],
      'fill-extrusion-base': ['max', 0, ['coalesce', ['to-number', ['get', 'min_height']], 0]],
      'fill-extrusion-vertical-gradient': true,
    },
  });
  return {
    version: 8,
    glyphs: 'daypactasset://map-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `daypactasset://map-assets/sprites/${light ? 'light' : 'dark'}`,
    sources: {
      astana: {
        type: 'vector',
        url: `pmtiles://${key}`,
        attribution:
          '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a> · <a href="https://protomaps.com" target="_blank" rel="noopener noreferrer">Protomaps</a>',
      },
    },
    layers: mapLayers as StyleSpecification['layers'],
    light: {
      anchor: 'viewport',
      color: light ? '#ffffff' : '#c9dded',
      intensity: 0.45,
      position: [1.5, 210, 35],
    },
  };
}
