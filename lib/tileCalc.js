// @ts-check

const turf = require('@turf/turf');

/**
 * @typedef {import('./types').Tile} Tile
 */

module.exports = {
  long2tile,
  lat2tile,
  tile2long,
  tile2lat,
  computeZoomedTiles,
  tileRangeGenerator,
  tile2key,
  key2tile,
  tileOverlapsLimits,
  tileWithinLimits,
};

/**
 *
 * @param {number} lon
 * @param {number} zoom
 * @returns {number}
 */
function long2tile(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

/**
 * @param {number} lat
 * @param {number} zoom
 * @returns {number}
 */
function lat2tile(lat, zoom) {
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

/**
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
function tile2long(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

/**
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
function tile2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * @param {(tile: Tile) => void} collect
 * @param {Tile} tile
 * @param {number} minZoom
 * @param {number} maxZoom
 */
function computeZoomedTiles(collect, tile, minZoom, maxZoom) {
  const { zoom, x, y } = tile;
  collectZoomedOutTiles(minZoom, collect, zoom, x, y);
  collectZoomedInTiles(maxZoom, collect, zoom, x, y);
}

/**
 * @param {number} minZoom
 * @param {(tile: Tile) => void} collect
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 */
function collectZoomedOutTiles(minZoom, collect, zoom, x, y) {
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

/**
 * @param {number} maxZoom
 * @param {(tile: Tile) => void} collect
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 */
function collectZoomedInTiles(maxZoom, collect, zoom, x, y) {
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

/**
 *
 * @param {turf.Feature<turf.Polygon>} polygon
 * @param {number} minZoom
 * @param {number} maxZoom
 */
function* tileRangeGenerator(polygon, minZoom, maxZoom) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(polygon);

  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    const minX = long2tile(minLon, zoom);
    const maxX = long2tile(maxLon, zoom);
    const minY = lat2tile(maxLat, zoom);
    const maxY = lat2tile(minLat, zoom);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const tilePoly = tileToPoly({ x, y, zoom });
        if (!turf.booleanDisjoint(tilePoly, polygon)) {
          yield { zoom, x, y };
        }
      }
    }
  }
}

/**
 * @param {Tile} tile
 * @returns {number}
 */
function tile2key({ zoom, x, y }) {
  let r = 0;

  for (let z = 0; z < zoom; z++) {
    const d = Math.pow(2, z);
    r += d * d;
  }

  return r + Math.pow(2, zoom) * y + x;
}

/**
 * @param {number} key
 * @returns {Tile}
 */
function key2tile(key) {
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

/**
 * @param {Tile} tile
 */
function tileToPoly({ zoom, x, y }) {
  return turf.bboxPolygon([
    tile2long(x, zoom),
    tile2lat(y + 1, zoom),
    tile2long(x + 1, zoom),
    tile2lat(y, zoom),
  ]);
}

/**
 *
 * @param {turf.GeometryObject} limits
 * @param {Tile} tile
 */
function tileOverlapsLimits(limits, tile) {
  return !turf.booleanDisjoint(limits, tileToPoly(tile));
}

/**
 * @param {turf.GeometryObject} limits
 * @param {Tile} tile
 */
function tileWithinLimits(limits, tile) {
  return turf.booleanContains(limits, tileToPoly(tile));
}
