const { tmpdir } = require('os');
const path = require('path');
const http = require('http');
const { stat, unlink } = require('fs').promises;

const config = require('config');
const Koa = require('koa');
const Router = require('koa-router');
const send = require('koa-send');

const { renderTile, toPdf } = require('./renderrer');
const { tileOverlapsLimits } = require('./tileCalc');

const app = new Koa();
const router = new Router();

const limits = config.get('limits');
const serverPort = config.get('server.port');
const tilesDir = config.get('dirs.tiles');
const notFoundAsTransparent = config.get('notFoundAsTransparent');

let generateMapnikConfig;

router.get('/:zz/:xx/:yy', async (ctx) => {
  const { zz, xx, yy } = ctx.params;

  const yyMatch = /(\d+)(?:@(\d+(?:\.\d+)?)x)?/.exec(yy);

  if (!yyMatch) {
    ctx.status = 400;
    return;
  }

  const x = Number.parseInt(xx, 10);
  const y = Number.parseInt(yyMatch[1], 10);
  const zoom = Number.parseInt(zz, 10);
  const scale = yyMatch[2] ? Number.parseFloat(yyMatch[2], 10) : 1;

  if (Number.isNaN(zoom) || Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(scale)) {
    ctx.status = 400;
    return;
  }

  if (!tileOverlapsLimits(limits, { zoom, x, y }) || !limits.scales.includes(scale)) {
    if (notFoundAsTransparent) {
      ctx.type = 'image/png';
      ctx.body = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff,
        0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
    } else {
      ctx.status = 404;
    }
    return;
  }

  const file = await renderTile(zoom, Number.parseInt(x, 10), y, scale);

  ctx.status = 200;

  const stats = await stat(file);
  ctx.set('Last-Modified', stats.mtime.toUTCString());

  if (ctx.fresh) {
    ctx.status = 304;
    return;
  }

  await send(ctx, path.relative(tilesDir, file), { root: tilesDir });
});

let tmpIndex = Date.now();

// example: http://localhost:4000/pdf?zoom=13&bbox=21.4389,48.6531,21.6231,48.7449&scale=0.75
router.get('/pdf', async (ctx) => {
  const q = ctx.query;
  const zoom = Number.parseInt(q.zoom, 10);
  const bbox = (q.bbox || '').split(',').map((c) => Number.parseFloat(c));
  if (zoom < 0 || zoom > 20 || bbox.length !== 4 || bbox.some((c) => Number.isNaN(c))) {
    ctx.status = 400;
    return;
  }
  const filename = `export-${tmpIndex++}.pdf`;
  const exportFile = path.resolve(tmpdir(), filename);
  const mapnikConfig = generateMapnikConfig(
    b(q.shading),
    b(q.contours),
    b(q.hikingTrails),
    b(q.bicycleTrails),
    b(q.skiTrails),
  );

  const cancelHolder = {};
  const cancelHandler = () => {
    cancelHolder.cancelled = true;
  };

  ctx.req.on('close', cancelHandler);

  try {
    try {
      await toPdf(
        exportFile, mapnikConfig, zoom, bbox,
        Number.parseFloat(q.scale) || undefined,
        Number.parseFloat(q.width) || undefined,
        cancelHolder,
      );
    } finally {
      ctx.req.off('close', cancelHandler);
    }

    ctx.status = 200;
    await send(ctx, filename, { root: tmpdir() });
  } finally {
    await unlink(exportFile);
  }
});

function b(value) {
  return value === undefined ? undefined : !/^(0|false|no)$/.test(value);
}

app
  .use(router.routes())
  .use(router.allowedMethods());

const server = http.createServer(app.callback());

function listenHttp() {
  server.listen(serverPort, () => {
    console.log(`Listening on port ${serverPort}.`);
  });
}

function closeServer() {
  server.close();
}

// TODO ugly as hell
function setMapnikConfigFactory(mcf) {
  generateMapnikConfig = mcf;
}

module.exports = { listenHttp, closeServer, setMapnikConfigFactory };