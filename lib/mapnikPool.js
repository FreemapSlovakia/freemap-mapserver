const { promisify } = require('util');
const { cpus } = require('os');

const mapnik = require('mapnik');
const config = require('config');
const genericPool = require('generic-pool');

/** @type {ReturnType<typeof genericPool.createPool>} */
let pool;

const workers = config.get('workers');
const maxMapUseCount = config.get('maxMapUseCount');

function initPool(mapnikConfig) {
  mapnik.register_default_fonts();
  mapnik.register_default_input_plugins();

  const mp = mapnik.Map.prototype;

  mp.fromStringAsync = promisify(mp.fromString);

  mp.renderFileAsync = promisify(mp.renderFile);

  mp.renderAsync = promisify(mp.render);

  mapnik.Image.prototype.encodeAsync = promisify(mapnik.Image.prototype.encode);

  mapnik.Image.prototype.compositeAsync = promisify(
    mapnik.Image.prototype.composite,
  );

  mapnik.Image.prototype.premultiplyAsync = promisify(
    mapnik.Image.prototype.premultiply,
  );

  mapnik.Image.prototype.demultiplyAsync = promisify(
    mapnik.Image.prototype.demultiply,
  );

  mapnik.Image.prototype.resizeAsync = promisify(mapnik.Image.prototype.resize);

  mapnik.Image.prototype.fillAsync = promisify(mapnik.Image.prototype.fill);

  mapnik.Image.prototype.filterAsync = promisify(mapnik.Image.prototype.filter);

  mapnik.Image.prototype.clearAsync = promisify(mapnik.Image.prototype.clear);

  const nCpus = cpus().length;

  const factory = {
    async create() {
      const map = new mapnik.Map(256, 256);

      await map.fromStringAsync(mapnikConfig);

      return {
        map,
        useCount: 0,
      };
    },

    async destroy() {
      // nothing to do
    },

    async validate(obj) {
      obj.useCount++;

      return obj.useCount < maxMapUseCount;
    },
  };

  pool = genericPool.createPool(factory, {
    testOnBorrow: !!maxMapUseCount,
    max: 'max' in workers ? workers.max : nCpus,
    min: 'min' in workers ? workers.min : nCpus,
    priorityRange: 2,
  });
}

function getPool() {
  return pool;
}

const imagePoolMap = new Map();

function getImagePool(key, scale) {
  let pool = imagePoolMap.get(key + '-' + scale);

  if (!pool) {
    const imageFactory = {
      async create() {
        return new mapnik.Image(256, 256);
      },

      async destroy() {
        // nothing to do
      },

      async validate(obj) {
        await obj.clearAsync();

        return true;
      },
    };

    pool = genericPool.createPool(imageFactory, {
      testOnBorrow: true,
      max: 100, // TODO configurable
    });

    imagePoolMap.set(key + '-' + scale, pool);
  }

  return pool;
}

module.exports = { getPool, initPool, getImagePool };
