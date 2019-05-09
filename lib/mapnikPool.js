const { promisify } = require('util');
const { cpus } = require('os');
const process = require('process');

const mapnik = require('mapnik');
const config = require('config');
const genericPool = require('generic-pool');

const { mercSrs } = require('./projections');

let pool;

const workers = config.get('workers');
const crop = config.get('crop');

function initPool(mapnikConfig) {
  mapnik.register_default_fonts();
  mapnik.register_default_input_plugins();

  const mp = mapnik.Map.prototype;
  mp.fromStringAsync = promisify(mp.fromString);
  mp.renderFileAsync = promisify(mp.renderFile);
  mp.renderAsync = promisify(mp.render);
  mapnik.Image.prototype.encodeAsync = promisify(mapnik.Image.prototype.encode);
  mapnik.Image.prototype.compositeAsync = promisify(mapnik.Image.prototype.composite);
  mapnik.Image.prototype.premultiplyAsync = promisify(mapnik.Image.prototype.premultiply);
  mapnik.Image.prototype.demultiplyAsync = promisify(mapnik.Image.prototype.demultiply);
  mapnik.Image.prototype.filterAsync = promisify(mapnik.Image.prototype.filter);

  const nCpus = cpus().length;

  process.env.UV_THREADPOOL_SIZE = (workers.max || nCpus) + 4; // see https://github.com/mapnik/mapnik-support/issues/114

  const factory = {
    async create() {
      const map = new mapnik.Map(256, 256);
      await map.fromStringAsync(mapnikConfig);

      let cropMap;
      if (crop) {
        cropMap = new mapnik.Map(256, 256);
        await cropMap.fromStringAsync(`
          <Map srs="${mercSrs}" background-color="#ffffff00">
            <Style name="crop">
              <Rule>
                <PolygonSymbolizer fill="white" />
              </Rule>
            </Style>
            <Layer srs="+init=epsg:4326">
              <StyleName>crop</StyleName>
              <Datasource>
                <Parameter name="type">geojson</Parameter>
                <Parameter name="file">${crop.geojsonFile}</Parameter>
              </Datasource>
            </Layer>
          </Map>
        `);
      }

      return { map, cropMap };
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

  return pool;
}

function getPool() {
  return pool;
}

module.exports = { getPool, initPool };