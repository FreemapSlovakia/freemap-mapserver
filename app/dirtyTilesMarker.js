const config = require('config');
const path = require('path');
const { readdir, readFile, unlink, open, close, exists } = require('fs').promises;
const { parseTile, computeZoomedTiles } = require('./tileCalc');

const expiresDir = path.resolve(__dirname, '..', config.get('dirs.expires'));
const minZoom = config.get('zoom.min');
const maxZoom = config.get('zoom.max');
const prerender = config.get('prerender');

module.exports = async (tilesDir) => {
  console.time('SCAN');
  console.timeLog('SCAN', 'PHASE 1');

  const dirs = await readdir(expiresDir);
  const fullFiles = [].concat(...await Promise.all(
    dirs
      .map((dirs) => path.join(expiresDir, dirs))
      .map(async (fd) => readdir(fd).then((x) => x.map((xx) => path.join(fd, xx)))),
  ));

  console.timeLog('SCAN', 'PHASE 2');

  const contents = await Promise.all(fullFiles.map((ff) => readFile(ff, 'utf8')));

  console.timeLog('SCAN', 'PHASE 3');

  const tiles = new Set();

  contents
    .join('\n')
    .split('\n')
    .filter((tile) => tile.trim())
    .forEach((tile) => {
      tiles.add(tile);
    });

  const deepTiles = [];
  tiles.forEach((tile) => {
    computeZoomedTiles(deepTiles, tile, minZoom, maxZoom);
  });

  console.timeLog('SCAN', 'PHASE 4');

  console.log('Processing dirty tiles:', deepTiles.length);

  // we do it sequentially to not to kill IO
  for (const tile of deepTiles) {
    const { zoom } = parseTile(tile);
    if (!prerender || zoom < prerender.minZoom || zoom > prerender.maxZoom) {
      try {
        await unlink(path.resolve(tilesDir, `${tile}.png`));
      } catch (_) {
        // ignore
      }
    } else if (await exists(path.resolve(tilesDir, `${tile}.png`))) {
      await close(await open(path.resolve(tilesDir, `${tile}.dirty`), 'w'));
    }
  }

  console.timeLog('SCAN', 'PHASE 5');

  // we do it sequentially to not to kill IO
  for (const ff of fullFiles) {
    await unlink(ff);
  }

  console.timeEnd('SCAN');
};

// function isTileInBbox(tile) {
//   const { zoom, x, y } = parseTile(tile);
//   const minLon = tile2long(x, zoom);
//   const maxLon = tile2long(x + 1, zoom);
//   const maxLat = tile2lat(y, zoom);
//   const minLat = tile2lat(y + 1, zoom);
//   console.log(zoom, minLat, maxLat);
//   return prerender.minLon >= minLon
//     && prerender.maxLon <= maxLon
//     && prerender.minLat >= minLat
//     && prerender.maxLat <= maxLat;
// }
