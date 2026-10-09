import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect } from 'react';
import { Layer, Source } from 'react-map-gl/maplibre';

export const emptyRoute: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

// A style with no `sprite`: the demo's sprite sheet is generated from game
// files and isn't committed, so icons are supplied by `IconLoader` instead.
export const mapStyleNoSprite = {
  version: 8 as const,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {},
  layers: [],
};

/**
 * Feed the individual `public/map-icons/*.png` files to MapLibre whenever it
 * reports a missing image (the generated sprite sheet isn't in the repo).
 */
export const IconLoader = (props: { map: MapLibreMap | null }) => {
  useEffect(() => {
    const map = props.map;
    if (!map) return;
    const onMissing = async (event: { id: string }) => {
      const id = event.id;
      if (!id || map.hasImage(id) || id === 'exit-sign') return;
      try {
        const res = await fetch(`/map-icons/${id}.png`);
        if (!res.ok) return;
        const bitmap = await createImageBitmap(await res.blob());
        if (!map.hasImage(id)) map.addImage(id, bitmap);
      } catch {
        // ignore missing icons
      }
    };
    map.on('styleimagemissing', onMissing);
    return () => {
      map.off('styleimagemissing', onMissing);
    };
  }, [props.map]);
  return null;
};

export const RouteLayers = (props: { route: GeoJSON.FeatureCollection }) => (
  <Source id={'record-route'} type={'geojson'} data={props.route}>
    <Layer
      id={'record-route-line'}
      type={'line'}
      filter={['==', ['geometry-type'], 'LineString']}
      layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      paint={{
        'line-color': ['match', ['get', 'kind'], 'session', '#2563eb', '#f97316'],
        'line-width': ['match', ['get', 'kind'], 'session', 4, 3],
        'line-opacity': 0.95,
      }}
    />
    <Layer
      id={'record-route-points'}
      type={'circle'}
      filter={['==', ['geometry-type'], 'Point']}
      paint={{
        'circle-radius': 6,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      }}
    />
  </Source>
);

export const FitBoundsToRoute = (props: {
  map: MapLibreMap | null;
  route: GeoJSON.FeatureCollection;
}) => {
  useEffect(() => {
    const map = props.map;
    if (!map || props.route.features.length === 0) return;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const feature of props.route.features) {
      const g = feature.geometry;
      const coords: number[][] =
        g.type === 'LineString'
          ? g.coordinates
          : g.type === 'Point'
            ? [g.coordinates]
            : [];
      for (const c of coords) {
        minLon = Math.min(minLon, c[0]);
        minLat = Math.min(minLat, c[1]);
        maxLon = Math.max(maxLon, c[0]);
        maxLat = Math.max(maxLat, c[1]);
      }
    }
    if (Number.isFinite(minLon)) {
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
        { padding: 60, duration: 0, maxZoom: 9 },
      );
    }
  }, [props.map, props.route]);
  return null;
};
