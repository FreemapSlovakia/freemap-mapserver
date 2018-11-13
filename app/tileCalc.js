module.exports = {
  long2tile,
  lat2tile,
  tile2long,
  tile2lat,
  parseTile,
  computeZoomedTiles,
};

function long2tile(lon, zoom) {
  return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
}

function lat2tile(lat, zoom) {
  return (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));
}

function tile2long(x, z) {
  return (x / Math.pow(2, z) * 360 - 180);
}

function tile2lat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
}

function parseTile(tile) {
  const [zoom, x, y] = tile.split('/');
  return {
    zoom: Number.parseInt(zoom, 10),
    x: Number.parseInt(x, 10),
    y: Number.parseInt(y, 10),
  };
}

function computeZoomedTiles(tile, minZoom, maxZoom) {
  const {zoom, x, y} = parseTile(tile);
  const tiles = [];
  collectZoomedOutTiles(minZoom, tiles, zoom, x, y);
  collectZoomedInTiles(maxZoom, tiles, zoom, x, y);
  return tiles;
};

function collectZoomedOutTiles(minZoom, tiles, zoom, x, y) {
  tiles.push(`${zoom}/${x}/${y}`);
  if (zoom > minZoom) {
    collectZoomedOutTiles(minZoom, tiles, zoom - 1, Math.floor(x / 2), Math.floor(y / 2));
  }
}

function collectZoomedInTiles(maxZoom, tiles, zoom, x, y) {
  tiles.push(`${zoom}/${x}/${y}`);
  if (zoom < maxZoom) {
    for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      collectZoomedInTiles(maxZoom, tiles, zoom + 1, x * 2 + dx, y * 2 + dy);
    }
  }
}
