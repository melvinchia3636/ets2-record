import { useColorScheme } from '@mui/joy';
import { BaseMapStyle, GameMapStyle } from '@truckermudgeon/ui';
import type { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useState } from 'react';
import MapGl, {
  AttributionControl,
  NavigationControl,
} from 'react-map-gl/maplibre';
import {
  emptyRoute,
  FitBoundsToRoute,
  IconLoader,
  mapStyleNoSprite,
  RouteLayers,
} from './RecordOverlay';

const Ets2RouteDemo = (props: { tileRootUrl: string }) => {
  const { mode: _maybeMode, systemMode } = useColorScheme();
  const mode = _maybeMode === 'system' ? systemMode : _maybeMode;
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [route, setRoute] = useState<GeoJSON.FeatureCollection>(emptyRoute);

  useEffect(() => {
    fetch('/route.geojson')
      .then(r => (r.ok ? r.json() : emptyRoute))
      .then(setRoute)
      .catch(() => console.error('could not load /route.geojson'));
  }, []);

  return (
    <MapGl
      style={{ width: '100vw', height: '100vh' }}
      minZoom={3}
      maxZoom={15}
      mapStyle={mapStyleNoSprite}
      attributionControl={false}
      initialViewState={{ longitude: 10, latitude: 48, zoom: 5 }}
      onLoad={e => setMap(e.target as MapLibreMap)}
    >
      <BaseMapStyle tileRootUrl={props.tileRootUrl} mode={mode} />
      <GameMapStyle tileRootUrl={props.tileRootUrl} game={'ets2'} mode={mode} />
      <RouteLayers route={route} />
      <IconLoader map={map} />
      <FitBoundsToRoute map={map} route={route} />
      <NavigationControl visualizePitch={true} />
      <AttributionControl
        compact={true}
        customAttribution="&copy; Trucker Mudgeon / SCS Software"
      />
    </MapGl>
  );
};

export default Ets2RouteDemo;
