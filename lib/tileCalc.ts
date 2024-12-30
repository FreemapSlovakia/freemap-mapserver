import {
  bbox,
  bboxPolygon,
  booleanContains,
  booleanDisjoint,
} from '@turf/turf';
import { Tile } from './types.js';
import { GeometryObject, Polygon } from 'geojson';

export function long2tile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

export function lat2tile(lat: number, zoom: number): number {
  return Math.floor(
    ((1 -
      Math.log(
        Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180),
      ) /
        Math.PI) /
      2) *
      Math.pow(2, zoom),
  );
}

export function tile2long(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function computeZoomedTiles(
  collect: (tile: Tile) => void,
  tile: Tile,
  minZoom: number,
  maxZoom: number,
) {
  const { zoom, x, y } = tile;
  collectZoomedOutTiles(minZoom, collect, zoom, x, y);
  collectZoomedInTiles(maxZoom, collect, zoom, x, y);
}

function collectZoomedOutTiles(
  minZoom: number,
  collect: (tile: Tile) => void,
  zoom: number,
  x: number,
  y: number,
) {
  collect({ zoom, x, y });

  if (zoom > minZoom) {
    collectZoomedOutTiles(
      minZoom,
      collect,
      zoom - 1,
      Math.floor(x / 2),
      Math.floor(y / 2),
    );
  }
}

function collectZoomedInTiles(
  maxZoom: number,
  collect: (tile: Tile) => void,
  zoom: number,
  x: number,
  y: number,
) {
  collect({ zoom, x, y });

  if (zoom < maxZoom) {
    for (const [dx, dy] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      collectZoomedInTiles(maxZoom, collect, zoom + 1, x * 2 + dx, y * 2 + dy);
    }
  }
}

export function* tileRangeGenerator(
  polygon: Polygon,
  minZoom: number,
  maxZoom: number,
) {
  const [minLon, minLat, maxLon, maxLat] = bbox(polygon);

  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const minX = long2tile(minLon, zoom);
    const maxX = long2tile(maxLon, zoom);
    const minY = lat2tile(maxLat, zoom);
    const maxY = lat2tile(minLat, zoom);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const tilePoly = tileToPoly({ x, y, zoom });
        if (!booleanDisjoint(tilePoly, polygon)) {
          yield { zoom, x, y };
        }
      }
    }
  }
}

export function tile2key({ zoom, x, y }: Tile): number {
  let r = 0;

  for (let z = 0; z < zoom; z++) {
    const d = Math.pow(2, z);
    r += d * d;
  }

  return r + Math.pow(2, zoom) * y + x;
}

export function key2tile(key: number): Tile {
  for (let zoom = 0; ; zoom++) {
    const d = Math.pow(2, zoom);
    const sq = d * d;

    if (key === sq) {
      return { zoom, x: 0, y: 0 };
    } else if (key < sq) {
      return { zoom, x: key % d, y: Math.floor(key / d) };
    }

    key -= sq;
  }
}

function tileToPoly({ zoom, x, y }: Tile) {
  return bboxPolygon([
    tile2long(x, zoom),
    tile2lat(y + 1, zoom),
    tile2long(x + 1, zoom),
    tile2lat(y, zoom),
  ]);
}

export function tileOverlapsLimits(limits: GeometryObject, tile: Tile) {
  return !booleanDisjoint(limits, tileToPoly(tile));
}

export function tileWithinLimits(limits: GeometryObject, tile: Tile) {
  return booleanContains(limits, tileToPoly(tile));
}
