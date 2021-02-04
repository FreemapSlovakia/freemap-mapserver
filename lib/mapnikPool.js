const { promisify } = require('util');
const { cpus } = require('os');

const mapnik = require('mapnik');
const config = require('config');
const genericPool = require('generic-pool');

const workers = config.get('workers');

const nCpus = cpus().length;

let mapnikConfig1;

function initPool(mapnikConfig) {
  mapnikConfig1 = mapnikConfig;

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
}

const poolMap = new Map();

function getPool(scale) {
  let pool = poolMap.get('map-' + scale);

  if (!pool) {
    const factory = {
      async create() {
        const map = new mapnik.Map(256 * scale, 256 * scale);

        await map.fromStringAsync(mapnikConfig1);

        return map;
      },

      async destroy() {
        // nothing to do
      },
    };

    pool = genericPool.createPool(factory, {
      max: 'max' in workers ? workers.max : nCpus,
      min: 'min' in workers ? workers.min : nCpus,
      priorityRange: 2,
    });

    poolMap.set('map-' + scale, pool);
  }

  return pool;
}

const imagePoolMap = new Map();

function getImagePool(key, scale) {
  let pool = imagePoolMap.get(key + '-' + scale);

  if (!pool) {
    const imageFactory = {
      async create() {
        return new mapnik.Image(256 * scale, 256 * scale);
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
