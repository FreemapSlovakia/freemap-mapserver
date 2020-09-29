// @ts-check

const chokidar = require('chokidar');
const config = require('config');

const { prerender, resume } = require('./prerenderrer');
const { fillDirtyTilesRegister } = require('./dirtyTilesScanner');
const { processExpireFiles } = require('./expireFilesProcessor');
const {
  listenHttp,
  closeServer,
  setMapnikConfigFactory,
} = require('./httpServer');
const { getPool, initPool } = require('./mapnikPool');
const { cleanupOutOfBoundTiles } = require('./outOfBoundsCleaner');

const cleanup = config.get('limits.cleanup');

module.exports = { startMapserver };

function startMapserver(mapnikConfig, mapnikConfigFactory, legend) {
  const prerenderConfig = config.get('prerender');
  const tilesDir = config.get('dirs.tiles');
  const expiresDir = config.get('dirs.expires');

  setMapnikConfigFactory(mapnikConfigFactory, legend);

  initPool(mapnikConfig);

  const pool = getPool();

  /** @type {chokidar.FSWatcher} */
  let watcher;

  pool.on('factoryCreateError', async (error) => {
    console.error('Error creating or configuring Mapnik:', error);

    process.exitCode = 1;

    if (watcher) {
      watcher.close();
    }

    closeServer();

    await pool.drain();
    await pool.clear();
  });

  let depth = 0;

  function processNewDirties() {
    console.info(`Processing new expire files (depth: ${depth}).`);

    depth++;
    if (depth > 1) {
      return;
    }

    processExpireFiles(tilesDir).then((retry) => {
      resume();

      retry |= depth > 1;

      depth = 0;

      if (retry) {
        processNewDirties();
      }
    });
  }

  // TODO we could maybe await
  if (cleanup) {
    cleanupOutOfBoundTiles().catch((err) => {
      console.error('Error in cleanupOutOfBoundTiles:', err);
    });
  }

  if (prerenderConfig) {
    processNewDirties();

    fillDirtyTilesRegister()
      .then(() => {
        listenHttp();

        watcher = chokidar.watch(expiresDir);
        watcher.on('add', processNewDirties);

        return prerender();
      })
      .catch((err) => {
        console.error('Error filling dirty tiles register', err);
        process.exit(1);
      });
  } else {
    listenHttp();
  }
}
