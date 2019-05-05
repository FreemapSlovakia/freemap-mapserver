const config = require('config');
const path = require('path');
const { readdir, readFile, unlink, open, access } = require('fs').promises;
const { parseTile, computeZoomedTiles, tile2key, tileOverlapsLimits } = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');

const expiresDir = config.get('dirs.expires');
const limits = config.get('limits');
const prerenderConfig = config.get('prerender');

module.exports = { markDirtyTiles };

async function markDirtyTiles(tilesDir) {
  console.log('Marking dirty tiles.');

  const dirs = await readdir(expiresDir);
  const fullFiles = [].concat(...await Promise.all(
    dirs
      .map((dirs) => path.join(expiresDir, dirs))
      .map(async (fd) => readdir(fd).then((x) => x.map((xx) => path.join(fd, xx)))),
  ));

  const contents = await Promise.all(fullFiles.map((ff) => readFile(ff, 'utf8')));

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
    computeZoomedTiles(deepTiles, tile, limits.minZoom, limits.maxZoom);
  });

  console.log('Processing dirty tiles:', deepTiles.length);

  // we do it sequentially to not to kill IO
  for (const tile of deepTiles) {
    const til = parseTile(tile);
    if (!tileOverlapsLimits(prerenderConfig, til)) {
      for (const scale of limits.scales) {
        try {
          await unlink(path.resolve(tilesDir, `${tile}${scale === 1 ? '' : `@${scale}x`}.png`));
        } catch (_) {
          // ignore
        }
      }
    } else if (await exists(path.resolve(tilesDir, `${tile}.png`))) {
      await (await open(path.resolve(tilesDir, `${tile}.dirty`), 'w')).close();
      const v = { ...til, ts: Date.now(), dt: Date.now() };
      dirtyTiles.set(tile2key(v), v);
    }
  }

  // we do it sequentially to not to kill IO
  for (const ff of fullFiles) {
    await unlink(ff);
  }

  console.log('Finished marking dirty tiles.');
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (_) {
    return false;
  }
}
