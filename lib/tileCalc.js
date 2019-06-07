const turf = require('@turf/turf');

/**
 * @typedef {import('./types').Tile} Tile
 */

const zoomDenoms = [
  1000000000,
  500000000,
  200000000,
  100000000,
  50000000,
  25000000,
  12500000,
  6500000,
  3000000,
  1500000,
  750000, // 10
  400000,
  200000,
  100000,
  50000,
  25000,
  12500,
  5000,
  2500,
  1500,
  750, // 20
  500,
  250,
  100,
  50,
  25,
  12.5,
];

module.exports = {
  zoomDenoms,
  long2tile,
  lat2tile,
  tile2long,
  tile2lat,
  parseTile,
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
  return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
}

/**
 * @param {number} lat
 * @param {number} zoom
 * @returns {number}
 */
function lat2tile(lat, zoom) {
  return (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));
}

/**
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
function tile2long(x, z) {
  return (x / Math.pow(2, z) * 360 - 180);
}

/**
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
function tile2lat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
}

/**
 *
 * @param {string} tile
 * @returns {Tile}
 */
function parseTile(tile) {
  const [zoom, x, y] = tile.split('/');
  return {
    zoom: parseInt(zoom, 10),
    x: parseInt(x, 10),
    y: parseInt(y, 10),
  };
}

/**
 * @param {string[]} tiles
 * @param {string} tile
 * @param {number} minZoom
 * @param {number} maxZoom
 */
function computeZoomedTiles(tiles, tile, minZoom, maxZoom) {
  const {zoom, x, y} = parseTile(tile);
  collectZoomedOutTiles(minZoom, tiles, zoom, x, y);
  collectZoomedInTiles(maxZoom, tiles, zoom, x, y);
}

/**
 * @param {number} minZoom
 * @param {string[]} tiles
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 */
function collectZoomedOutTiles(minZoom, tiles, zoom, x, y) {
  tiles.push(`${zoom}/${x}/${y}`);
  if (zoom > minZoom) {
    collectZoomedOutTiles(minZoom, tiles, zoom - 1, Math.floor(x / 2), Math.floor(y / 2));
  }
}

/**
 *
 * @param {number} maxZoom
 * @param {string[]} tiles
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 */
function collectZoomedInTiles(maxZoom, tiles, zoom, x, y) {
  tiles.push(`${zoom}/${x}/${y}`);
  if (zoom < maxZoom) {
    for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      collectZoomedInTiles(maxZoom, tiles, zoom + 1, x * 2 + dx, y * 2 + dy);
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
