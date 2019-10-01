const path = require('path');
const config = require('config');
const { stat } = require('fs').promises;
const { dirtyTiles } = require('./dirtyTilesRegister');
const { tile2key } = require('./tileCalc');
const { tileRangeGenerator } = require('./tileCalc');
const { prerenderPolygon } = require('./config');

const rerenderOlderThanMs = config.get('rerenderOlderThanMs');

/** @type string */
const extension = config.get('format.extension');

/** @type {number[]} */
const limitScales = config.get('limits.scales');

module.exports = {
  fillDirtyTilesRegister,
};

const prerenderConfig = config.get('prerender');
const tilesDir = config.get('dirs.tiles');

async function fillDirtyTilesRegister() {
  console.log('Scanning dirty tiles.');

  const { minZoom, maxZoom } = prerenderConfig;

  for (const { zoom, x, y } of tileRangeGenerator(
    prerenderPolygon,
    minZoom,
    maxZoom,
  )) {
    /** @type {number} */
    let mtimeMs;
    try {
      // find oldest
      const proms = limitScales.map(scale =>
        stat(
          path.join(
            tilesDir,
            `${zoom}/${x}/${y}${scale === 1 ? '' : `@${scale}x`}.${extension}`,
          ),
        ),
      );
      mtimeMs = Math.min(
        ...(await Promise.all(proms)).map(stat => stat.mtimeMs),
      );
    } catch (e) {
      const v = { zoom, x, y, ts: 0, dt: 0 };
      dirtyTiles.set(tile2key(v), v);
      continue;
    }

    if (rerenderOlderThanMs && mtimeMs < rerenderOlderThanMs) {
      const v = { zoom, x, y, ts: mtimeMs, dt: 0 };
      dirtyTiles.set(tile2key(v), v);
      continue;
    }

    try {
      const { mtimeMs } = await stat(
        path.join(tilesDir, `${zoom}/${x}/${y}.dirty`),
      );
      const v = { zoom, x, y, ts: mtimeMs, dt: mtimeMs };
      dirtyTiles.set(tile2key(v), v);
    } catch (e) {
      // fresh
    }
  }

  console.log('Dirty tiles scanned.');
}
