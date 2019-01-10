const chokidar = require('chokidar');
const config = require('config');

const { prerender, resume } = require('./prerenderrer');
const { fillDirtyTilesRegister } = require('./dirtyTilesScanner');
const { markDirtyTiles } = require('./dirtyTilesMarker');
const { listenHttp, closeServer, setMapnikConfigFactory } = require('./httpServer');
const { getPool, initPool } = require('./mapnikPool');

module.exports = { startMapserver };

function startMapserver(mapnikConfig, mapnikConfigFactory) {
  const prerenderConfig = config.get('prerender');
  setMapnikConfigFactory(mapnikConfigFactory);

  const tilesDir = config.get('dirs.tiles');
  const expiresDir = config.get('dirs.expires');

  initPool(mapnikConfig);

  const pool = getPool();

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

  let watcher;

  let depth = 0;

  function processNewDirties() {
    depth++;
    if (depth > 1) {
      return;
    }
    markDirtyTiles(tilesDir).then(() => {
      resume();
      const retry = depth > 1;
      depth = 0;
      if (retry) {
        processNewDirties();
      }
    });
  }

  if (prerenderConfig) {
    processNewDirties();

    fillDirtyTilesRegister().then(() => {
      listenHttp();
      watcher = chokidar.watch(expiresDir);
      watcher.on('add', processNewDirties);
      return prerender();
    }); // TODO catch
  } else {
    listenHttp();
  }
}
