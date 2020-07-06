const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const http = require('http');
const koaBody = require('koa-body');
const Ajv = require('ajv');
const shpwrite = require('shp-write');
const crypto = require('crypto');
const config = require('config');
const Koa = require('koa');
const Router = require('koa-router');
const send = require('koa-send');
const cors = require('@koa/cors');
const mapnik = require('mapnik');

const { renderTile, exportMap } = require('./renderrer');
const { tileOverlapsLimits } = require('./tileCalc');
const { limitPolygon } = require('./config');

const writeShapefile = promisify(shpwrite.write);

/**
 * @typedef {import('koa-router').RouterContext} RouterContext
 * @typedef {import('geojson').FeatureCollection} FeatureCollection
 * @typedef {import('json-schema').JSONSchema7} JSONSchema7
 */

const app = new Koa();
const router = new Router();

/** @type number[] */
const limitScales = config.get('limits.scales');
const serverOptions = config.get('server');
const tilesDir = config.get('dirs.tiles');
const notFoundAsTransparent = config.get('notFoundAsTransparent');

/** @type string */
const mimeType = config.get('format.mimeType');

let generateMapnikConfig;
let mapFeatureProperties;

const white = new mapnik.Color('white');

const images = new Map();

router.get('/:zz/:xx/:yy', async (ctx) => {
  const { zz, xx, yy } = ctx.params;

  const yyMatch = /(\d+)(?:@(\d+(?:\.\d+)?)x)?/.exec(yy);

  if (!yyMatch) {
    ctx.throw(400);
  }

  const x = Number.parseInt(xx, 10);
  const y = Number.parseInt(yyMatch[1], 10);
  const zoom = Number.parseInt(zz, 10);
  const scale = yyMatch[2] ? Number.parseFloat(yyMatch[2]) : 1;

  if (
    Number.isNaN(zoom) ||
    Number.isNaN(x) ||
    Number.isNaN(y) ||
    Number.isNaN(scale)
  ) {
    ctx.throw(400);
  }

  if (
    (limitPolygon && !tileOverlapsLimits(limitPolygon, { zoom, x, y })) ||
    !limitScales.includes(scale)
  ) {
    if (!notFoundAsTransparent) {
      ctx.throw(404);
    }

    ctx.type = 'image/png';

    let body = images.get(scale);

    if (!body) {
      const im = new mapnik.Image(256 * scale, 256 * scale);
      await im.fill(white);
      images.set(scale, await im.encodeAsync('png8:c=1:t=0'));
    }

    ctx.body = body;

    // white 1x1
    // ctx.body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    // transparent 1x1:
    // ctx.body = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff,
    //   0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    //   0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);

    return;
  }

  const file = await renderTile(zoom, x, y, scale);

  const stats = await fs.stat(file);

  ctx.set('Last-Modified', stats.mtime.toUTCString());

  if (ctx.fresh) {
    ctx.status = 304;
    return;
  }

  ctx.mimeType = mimeType;

  await send(ctx, path.relative(tilesDir, file), { root: tilesDir });
});

const ajv = new Ajv();

/** @type JSONSchema7 */
const schema = {
  type: 'object',
  required: ['zoom', 'bbox'],
  properties: {
    zoom: { type: 'integer', minimum: 0, maximum: 20 },
    bbox: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: { type: 'number' },
    },
    format: { type: 'string', enum: ['pdf', 'svg', 'jpeg', 'png'] },
    features: {},
    scale: { type: 'number', minimum: 0.1, maximum: 10 },
    width: { type: 'number', minimum: 1, maximum: 10000 },
    shapefile: {
      type: 'object',
      // TODO geojson schema
    },
  },
};

const validate = ajv.compile(schema);

const jobMap = new Map();

const exportRouter = new Router();

exportRouter.post('/', koaBody({ jsonLimit: '16mb' }), async (ctx) => {
  if (!ctx.accepts('application/json')) {
    ctx.throw(406);
  }

  if (!validate(ctx.request.body)) {
    ctx.throw(400, ajv.errorsText(validate.errors));
  }

  const {
    zoom,
    bbox,
    format = 'pdf',
    features,
    scale,
    width,
  } = ctx.request.body;

  const token = crypto.randomBytes(16).toString('hex');

  const filename = `export-${token}.${format}`;

  const exportFile = path.resolve(os.tmpdir(), filename);

  const cancelHolder = {
    cancelled: false,
  };

  const cancelHandler = () => {
    cancelHolder.cancelled = true;
  };

  ctx.req.on('close', cancelHandler);

  let shapefilesDir;

  const shapefiles = {};

  /** @type FeatureCollection */
  const geojson = ctx.request.body.geojson;

  if (geojson) {
    shapefilesDir = path.join(os.tmpdir(), `shapefiles-${token}`);

    await fs.mkdir(shapefilesDir);

    await Promise.all(
      [
        ['Point', 'POINT'],
        ['LineString', 'POLYLINE'],
        ['Polygon', 'POLYGON'],
      ].map(async ([type, shpType]) => {
        const features = geojson.features.filter(
          (feature) => feature.geometry.type === type,
        );

        if (features.length === 0) {
          return;
        }

        const files = await writeShapefile(
          features.map((feature) =>
            fixEncodingForDbf(mapFeatureProperties(feature.properties)),
          ),
          shpType,
          features.map((feature) =>
            type === 'LineString'
              ? [feature.geometry.coordinates]
              : feature.geometry.coordinates,
          ),
        );

        const prefix = path.join(shapefilesDir, shpType.toLowerCase());

        await Promise.all(
          ['shp', 'shx', 'dbf'].map((ext) =>
            fs.writeFile(`${prefix}.${ext}`, Buffer.from(files[ext].buffer)),
          ),
        );

        shapefiles[shpType.toLowerCase()] = `${prefix}.shp`;
      }),
    );
  }

  try {
    jobMap.set(token, {
      exportFile,
      filename,
      cancelHandler,
      shapefilesDir,
      promise: exportMap(
        exportFile,
        generateMapnikConfig({ features, shapefiles, format }),
        zoom,
        bbox,
        scale,
        width,
        cancelHolder,
        format,
      ),
    });
  } finally {
    ctx.req.off('close', cancelHandler);
  }

  ctx.body = { token };
  // TODO periodically delete old temp files
});

function fixEncodingForDbf(props) {
  for (const prop in props) {
    if (typeof props[prop] === 'string') {
      props[prop] = unescape(encodeURIComponent(props[prop]));
    }
  }

  return props;
}

exportRouter.head('/', async (ctx) => {
  const job = jobMap.get(ctx.query.token);

  if (!job) {
    ctx.throw(404);
  }

  await job.promise;

  ctx.status = 200;
});

exportRouter.get('/', async (ctx) => {
  const job = jobMap.get(ctx.query.token);

  if (!job) {
    ctx.throw(404);
  }

  await job.promise;

  await send(ctx, job.filename, { root: os.tmpdir() });
});

exportRouter.delete('/', async (ctx) => {
  const job = jobMap.get(ctx.query.token);

  if (!job) {
    ctx.throw(404);
  }

  job.cancelHandler();

  await Promise.all([
    fs.unlink(job.exportFile),
    job.shapefilesDir && fs.rmdir(job.shapefilesDir, { recursive: true }),
  ]);

  ctx.status = 204;
});

router.use('/export', exportRouter.routes(), exportRouter.allowedMethods());

app.use(cors()).use(router.routes()).use(router.allowedMethods());

// @ts-ignore
const server = http.createServer(app.callback());

function listenHttp() {
  if (serverOptions) {
    server.listen(serverOptions, () => {
      console.log(`HTTP server listening.`);
    });
  }
}

function closeServer() {
  server.close();
}

// TODO ugly as hell
function setMapnikConfigFactory(
  _generateMapnikConfig,
  _mapFeatureProperties = (props) => props,
) {
  generateMapnikConfig = _generateMapnikConfig;
  mapFeatureProperties = _mapFeatureProperties;
}

module.exports = { listenHttp, closeServer, setMapnikConfigFactory };
