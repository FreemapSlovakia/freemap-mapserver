// @ts-check

const config = require('config');
const path = require('path');
const {
  readdir,
  readFile,
  unlink,
  open,
  access,
  stat,
} = require('fs').promises;
const {
  parseTile,
  computeZoomedTiles,
  tile2key,
  tileOverlapsLimits,
} = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { prerenderPolygon } = require('./config');

/** @type string */
const expiresDir = config.get('dirs.expires');

/** @type number[] */
const limitScales = config.get('limits.scales');

/** @type number */
const minZoom = config.get('limits.minZoom');

/** @type number */
const maxZoom = config.get('limits.maxZoom');

/** @type string */
const extension = config.get('format.extension');

const prerenderConfig = config.get('prerender');

const markExpiredAllAtOnce = config.get('markExpiredAllAtOnce');

module.exports = { processExpireFiles };

/**
 * @param {string} tilesDir
 */
async function processExpireFiles(tilesDir) {
  console.log('Processing expire files.');

  const dirs = await readdir(expiresDir);

  const fullFiles = [].concat(
    ...(await Promise.all(
      dirs
        .map((dirs) => path.join(expiresDir, dirs))
        .map(async (fd) =>
          readdir(fd).then((x) => x.map((xx) => path.join(fd, xx))),
        ),
    )),
  );

  const expireFilesLen = fullFiles.length;

  if (!markExpiredAllAtOnce && fullFiles.length > 0) {
    fullFiles.splice(1, fullFiles.length - 1);
  }

  const contents = await Promise.all(
    fullFiles.map((ff) => readFile(ff, 'utf8')),
  );

  /** @type Set<import('./types').Tile> */
  const tiles = new Set();

  contents
    .join('\n')
    .split('\n')
    .filter((tile) => tile.trim())
    .map((tile) => parseTile(tile))
    .filter((tile) => tileOverlapsLimits(prerenderPolygon, tile))
    .forEach((tile) => {
      tiles.add(tile);
    });

  /** @type Array<import('./types').Tile> */
  const deepTiles = [];

  tiles.forEach((tile) => {
    computeZoomedTiles(deepTiles, tile, minZoom, maxZoom);
  });

  console.log('Processing expired tiles:', deepTiles.length);

  let i = 0;
  let lastLog = 0;

  // we do it sequentially to not to kill IO
  for (const til of deepTiles) {
    const tile = `${til.zoom}/${til.x}/${til.y}`;

    const now = Date.now();

    if (now - lastLog > 15000) {
      console.log(
        `Processing expired tile ${i} of ${deepTiles.length} (${(
          (i / deepTiles.length) *
          100
        ).toFixed()} %)`,
      );

      lastLog = now;
    }

    i++;

    if (
      !tileOverlapsLimits(prerenderPolygon, til) ||
      til.zoom < prerenderConfig.minZoom ||
      til.zoom > prerenderConfig.maxZoom
    ) {
      for (const scale of limitScales) {
        try {
          await stat(path.resolve(tilesDir, `${til.zoom}/${til.x}`));

          await unlink(
            path.resolve(
              tilesDir,
              `${tile}${scale === 1 ? '' : `@${scale}x`}.${extension}`,
            ),
          );
        } catch (_) {
          // ignore
        }
      }
    } else if (await exists(path.resolve(tilesDir, `${tile}.${extension}`))) {
      // TODO this seems to be very slow if rendering is in progress (CPU)
      await (await open(path.resolve(tilesDir, `${tile}.dirty`), 'w')).close();
      const v = { ...til, ts: Date.now(), dt: Date.now() };
      dirtyTiles.set(tile2key(v), v);
    }
  }

  // we do it sequentially to not to kill IO
  for (const ff of fullFiles) {
    await unlink(ff);
  }

  console.log(
    `Finished processing expire files (${fullFiles.length} of ${expireFilesLen}).`,
  );

  return !markExpiredAllAtOnce && expireFilesLen > 1;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (_) {
    return false;
  }
}
