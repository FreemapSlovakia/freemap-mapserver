// @ts-check

const config = require('config');
const path = require('path');
const { readdir, readFile, unlink, open, access } = require('fs').promises;
const {
  computeZoomedTiles,
  tile2key,
  tileOverlapsLimits,
} = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { prerenderPolygon } = require('./config');
const { flock } = require('fs-ext');
const { promisify } = require('util');

const flockAsync = promisify(flock);

/** @type string */
const expiresDir = config.get('dirs.expires');

/** @type number[] */
const limitScales = config.get('limits.scales');

/** @type number */
const minZoom = config.get('limits.minZoom');

/** @type string */
const extension = config.get('format.extension');

const prerenderConfig = config.get('prerender');

const minExpiredBatchSize = config.get('minExpiredBatchSize');

const expiresZoom = config.get('expiresZoom');

module.exports = { processExpireFiles };

/**
 * @param {string} tilesDir
 */
async function processExpireFiles(tilesDir) {
  console.log('Processing expire files.');

  const dirs = await readdir(expiresDir);

  const expireFiles = [].concat(
    ...(await Promise.all(
      dirs
        .map((dirs) => path.join(expiresDir, dirs))
        .map(async (dir) =>
          readdir(dir).then((tileFiles) =>
            tileFiles.map((tileFile) => path.join(dir, tileFile)),
          ),
        ),
    )),
  );

  const expireFilesLen = expireFiles.length;

  expireFiles.sort();

  /** @type Set<import('./types').Tile> */
  const tiles = new Set();

  let n = 0;

  for (const expireFile of expireFiles) {
    n++;

    const expireLines = (await readFile(expireFile, 'utf8')).trim().split('\n');

    expireLines
      .map((tile) => tile.split('/').map((x) => Number(x)))
      .map(([zoom, x, y]) => ({ x, y, zoom }))
      .filter((tile) => tileOverlapsLimits(prerenderPolygon, tile))
      .forEach((tile) => {
        tiles.add(tile);
      });

    if (
      typeof minExpiredBatchSize === 'number' &&
      tiles.size >= minExpiredBatchSize
    ) {
      break;
    }
  }

  expireFiles.splice(n, expireFiles.length - n);

  const outzoomExpiredTiles = new Set();

  const collect = ({ zoom, x, y }) => {
    outzoomExpiredTiles.add(`${zoom}/${x}/${y}`);
  };

  for (const tile of tiles) {
    computeZoomedTiles(collect, tile, minZoom, prerenderConfig.maxZoom);
  }

  console.log('Processing expired out-zoom tiles:', outzoomExpiredTiles.size);

  // we do it sequentially to not to kill IO
  for (const tile of outzoomExpiredTiles) {
    const [zoom, x, y] = tile.split('/').map((x) => Number(x));

    const checkIfTileExists = async () => {
      const t = Date.now();

      const res = await exists(path.resolve(tilesDir, `${tile}.${extension}`));

      return res && [Date.now() - t];
    };

    let tt;

    if (
      !tileOverlapsLimits(prerenderPolygon, { zoom, x, y }) ||
      zoom < prerenderConfig.minZoom ||
      zoom > prerenderConfig.maxZoom
    ) {
      for (const scale of limitScales) {
        const tileFile = `${tile}${
          scale === 1 ? '' : `@${scale}x`
        }.${extension}`;

        try {
          await unlink(path.resolve(tilesDir, tileFile));

          console.log('Removed expired tile:', tileFile);
        } catch (_) {
          // ignore
        }
      }
    } else if ((tt = await checkIfTileExists())) {
      const dirtyFile = `${tile}.dirty`;

      let t = Date.now();

      await (await open(path.resolve(tilesDir, dirtyFile), 'w')).close();

      console.log('Created dirty-file:', dirtyFile, tt[0], Date.now() - t);

      const v = { zoom, x, y, ts: Date.now(), dt: Date.now() };

      dirtyTiles.set(tile2key(v), v);
    }

    if (zoom === expiresZoom) {
      let len = 0;

      let fh;

      const t = Date.now();

      try {
        fh = await open(path.resolve(tilesDir, `${tile}.index`), 'r+');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      if (fh) {
        await flockAsync(fh.fd, 'ex');

        const items = (await fh.readFile('UTF-8'))
          .split('\n')
          .filter((line) => line);

        len = items.length;

        for (const item of items) {
          const p = path.resolve(tilesDir, `${item}.${extension}`);

          try {
            await unlink(p);
          } catch (err) {
            console.warn('Error deleting on-demand tile: ', p, err);
          }
        }

        await fh.truncate();

        await fh.close();
      }

      console.log('Deleted on-demand dirty tiles:', len, Date.now() - t);
    }
  }

  // we do it sequentially to not to kill IO
  for (const ff of expireFiles) {
    await unlink(ff);
  }

  console.log(
    `Finished processing expire files (${expireFiles.length} of ${expireFilesLen}).`,
  );

  return expireFiles.length !== expireFilesLen;
}

async function exists(file) {
  try {
    await access(file);

    return true;
  } catch (_) {
    return false;
  }
}
