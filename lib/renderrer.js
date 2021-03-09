const path = require('path');
const config = require('config');
const mapnik = require('mapnik');
const { rename, mkdir, unlink, stat, writeFile, open } = require('fs').promises;
const { flock } = require('fs-ext');
const { promisify } = require('util');
const { mercSrs } = require('./projections');
const { tile2key, tileOverlapsLimits } = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { getPool, getImagePool } = require('./mapnikPool');
const { spawn } = require('promisify-child-process');
const pngquant = require('pngquant-bin');
const { prerenderPolygon } = require('./config');

const flockAsync = promisify(flock);

const forceTileRendering = config.get('forceTileRendering');

const rerenderOlderThanMs = config.get('rerenderOlderThanMs');

const renderToPdfConcurrency = config.get('renderToPdfConcurrency');

/** @type number[] */
const limitScales = config.get('limits.scales');

const pngquantOptions = config.get('pngquantOptions');

let tilesDir = config.get('dirs.tiles');

/** @type string */
const extension = config.get('format.extension');

/** @type string */
const codec = config.get('format.codec');

const expiresZoom = config.get('expiresZoom');

const prerenderMaxZoom = config.get('prerenderMaxZoom');

const prerenderDelayWhenExpiring = config.get('prerenderDelayWhenExpiring');

const merc = new mapnik.Projection(mercSrs);

module.exports = { renderTile, exportMap };

mapnik.registerFonts(config.get('dirs.fonts'), { recurse: true });

const white = new mapnik.Color('white');

let cnt = 0;

// TODO if out of prerender area and reqScale is provided then render only that scale
/**
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 * @param {number} [reqScale]
 * @returns {Promise<string | undefined>}
 */
async function renderTile(zoom, x, y, reqScale) {
  const frags = [tilesDir, zoom.toString(10), x.toString(10)];

  const p = path.join(...frags, y.toString(10));

  const reasons = [];

  if (forceTileRendering) {
    reasons.push('forced');
  } else if (!reqScale) {
    reasons.push('noReqScale');
  } else {
    await shouldRender(p, { zoom, x, y, reqScale }, reasons);
  }

  if (reasons.length) {
    await mkdir(path.join(...frags), { recursive: true });

    await Promise.all(
      (reqScale ? [reqScale] : limitScales).map((scale) =>
        renderSingleScale(p, zoom, x, y, scale, !reqScale, reasons),
      ),
    );

    if (!reqScale) {
      try {
        await unlink(`${p}.dirty`);
      } catch (_) {
        // ignore
      }

      dirtyTiles.delete(tile2key({ zoom, x, y }));
    }
  }

  return reqScale
    ? `${p}${reqScale === 1 ? '' : `@${reqScale}x`}.${extension}`
    : undefined;
}

let coolDownPromise;

/**
 *
 * @param {string} p
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 * @param {boolean} prerender
 * @param {steing[]} reasons
 */
async function renderSingleScale(p, zoom, x, y, scale, prerender, reasons) {
  if (global.processingExpiredTiles && prerenderDelayWhenExpiring) {
    if (coolDownPromise) {
      await coolDownPromise;
    } else {
      coolDownPromise = new Promise((resolve) => {
        setTimeout(() => {
          coolDownPromise = null;
          resolve();
        }, prerenderDelayWhenExpiring);
      });
    }
  }

  const s = scale === 1 ? '' : `@${scale}x`;

  const spec = `${zoom}/${x}/${y}${s}`;

  const ps = `${p}${s}`;

  const logPrefix = `${
    prerender ? 'Pre-rendering' : 'Rendering'
  } tile ${spec}: `;

  if (prerender) {
    const dirtyTile = dirtyTiles.get(tile2key({ zoom, x, y }));

    if (!dirtyTile) {
      console.warn(`${logPrefix}no dirty meta found`);

      return;
    }

    reasons.push('dirty');

    try {
      const { mtimeMs } = await stat(`${ps}.${extension}`);

      if (
        mtimeMs > dirtyTile.dt &&
        (!rerenderOlderThanMs || mtimeMs > rerenderOlderThanMs)
      ) {
        console.log(`${logPrefix}fresh`);

        return;
      }
    } catch (_) {
      // nothing
    }
  }

  console.log(`${logPrefix}rendering`, reasons);

  const pool = getPool(scale);

  const map = await pool.acquire(prerender ? 1 : 0);

  const imagePool = getImagePool('main', scale);

  let im = await imagePool.acquire();

  let bgImagePool;

  let bgIm;

  let buffer;

  /** @type number */
  let t;

  try {
    try {
      t = Date.now();

      map.zoomToBox(
        merc.forward([
          ...transformCoords(zoom, x, y + 1),
          ...transformCoords(zoom, x + 1, y),
        ]),
      );

      // await map.renderFileAsync(tmpName, { format: 'png', buffer_size: 256, scale });
      await map.renderAsync(im, {
        buffer_size: 256 * scale,
        scale,
        variables: {
          zoom,
          scale_denominator: 559082264.028 / Math.pow(2, zoom),
        },
      });

      measure('render', Date.now() - t);

      // this is to get rid of transparency because of edge blurring and JPEG

      bgImagePool = getImagePool('bg', scale);

      bgIm = await bgImagePool.acquire();

      await Promise.all([
        im.premultiplyAsync(),
        (async () => {
          await bgIm.fill(white);
          await bgIm.premultiplyAsync();
        })(),
      ]);

      await bgIm.compositeAsync(im);

      await bgIm.demultiplyAsync();
    } finally {
      pool.release(map);
      // TODO release image pool on error
    }

    t = Date.now();

    buffer = await bgIm.encodeAsync(codec);

    measure('encode', Date.now() - t);
  } finally {
    imagePool.release(im);

    if (bgImagePool && bgIm) {
      bgImagePool.release(bgIm);
    }
  }

  const tmpName = `${ps}_${cnt++}_tmp.${extension}`;

  t = Date.now();

  if (pngquantOptions) {
    // @ts-ignore
    const child = spawn(pngquant, [...pngquantOptions, '-o', tmpName, '-'], {
      encoding: 'buffer',
    });

    child.stdin.write(buffer);

    const { /*stdout, stderr,*/ code } = await child;

    if (code) {
      throw new Error(`pngquant exit code: ${code}`);
    }
  } else {
    await writeFile(tmpName, buffer);
  }

  if (typeof expiresZoom === 'number' && zoom > prerenderMaxZoom) {
    const div = 2 ** (zoom - expiresZoom);

    await mkdir(
      path.resolve(tilesDir, String(expiresZoom), String(Math.floor(x / div))),
      {
        recursive: true,
      },
    );

    const fh = await open(
      path.resolve(
        tilesDir,
        String(expiresZoom),
        String(Math.floor(x / div)),
        Math.floor(y / div) + '.index',
      ),
      'a',
    );

    await flockAsync(fh.fd, 'sh');

    await fh.write(spec + '\n');

    await fh.close();
  }

  await rename(tmpName, `${ps}.${extension}`);

  measure('write', Date.now() - t);
}

/**
 * @type {Map<string, { count: number, duration: number }>}
 */
const measureMap = new Map();

let lastMeasureResult = Date.now();

/**
 * @param {string} operation
 * @param {number} duration
 */
function measure(operation, duration) {
  let a = measureMap.get(operation);

  if (!a) {
    a = { count: 0, duration: 0 };

    measureMap.set(operation, a);
  }

  a.duration += duration;

  a.count++;

  if (Date.now() - lastMeasureResult > 60000) {
    console.log(
      'Measurement:',
      [...measureMap]
        .map(
          ([operation, { count, duration }]) =>
            `${operation}: ${count}x ${duration / count}`,
        )
        .sort(),
    );

    measureMap.clear();

    lastMeasureResult = Date.now();
  }
}

// used for requested single scale
/**
 * @param {string} p
 * @param {object} tile
 * @param {string[]} reasons
 */
async function shouldRender(p, tile, reasons) {
  let s;
  try {
    s = await stat(
      `${p}${tile.reqScale === 1 ? '' : `@${tile.reqScale}x`}.${extension}`,
    );
  } catch (err) {
    reasons.push('doesntExist');
    return;
  }

  // return prerenderPolygon && isOld && !tileOverlapsLimits(prerenderPolygon, tile)
  //   || prerender && (isOld || dirtyTiles.has(tile2key(tile)));

  if (prerenderPolygon) {
    if (
      rerenderOlderThanMs &&
      s.mtimeMs < rerenderOlderThanMs &&
      !tileOverlapsLimits(prerenderPolygon, tile)
    ) {
      reasons.push('shouldRender');
    }
  } else {
    // reasons.push('???');
  }
}

let pdfLockCount = 0;
const pdfUnlocks = [];

// scale: my screen is 96 dpi, pdf is 72 dpi; 72 / 96 = 0.75
/**
 * @param {string} destFile
 * @param {string} xml
 * @param {number} zoom
 * @param {[number, number, number, number]} bbox0
 * @param {number} scale
 * @param {number | undefined | null} width
 * @param {{ cancelled: boolean; } | undefined} cancelHolder
 * @param {string | undefined} format
 */
async function exportMap(
  destFile,
  xml,
  zoom,
  bbox0,
  scale = 1,
  width,
  cancelHolder,
  format,
) {
  if (pdfLockCount >= renderToPdfConcurrency) {
    await new Promise((unlock) => {
      pdfUnlocks.push(unlock);
    });
  }

  if (cancelHolder && cancelHolder.cancelled) {
    throw new Error('Cancelled');
  }

  pdfLockCount++;

  try {
    const bbox = merc.forward(bbox0);

    // manually found constant; very close to 1e12 / 6378137 (radius of earth in m) = 156785.594289
    const q = Math.pow(2, zoom) / 156543; /* manually found constant */

    const map = new mapnik.Map(
      width || (bbox[2] - bbox[0]) * q * scale,
      width
        ? ((bbox[3] - bbox[1]) / (bbox[2] - bbox[0])) * width
        : (bbox[3] - bbox[1]) * q * scale,
    );

    await map.fromStringAsync(xml);

    map.zoomToBox(bbox);

    const scale_denominator =
      559082264.028 / Math.pow(2, Math.round(zoom + Math.log2(scale)));

    if (destFile) {
      await map.renderFileAsync(destFile, {
        format,
        buffer_size: 256,
        scale_denominator,
        scale,
        variables: {
          zoom,
          scale_denominator,
        },
      });
    } else {
      const im = new mapnik.Image(map.width, map.height);

      await map.renderAsync(im, {
        buffer_size: 256,
        scale,
        scale_denominator,
        variables: { zoom, scale_denominator },
      }); // TODO buffer_size * scale?

      return await im.encodeAsync(format);
    }
  } finally {
    const unlock = pdfUnlocks.shift();

    if (unlock) {
      unlock();
    }

    pdfLockCount--;

    if (global.gc) {
      global.gc();
    }
  }
}

/**
 * @param {number} zoom
 * @param {number} xtile
 * @param {number} ytile
 * @returns {[number, number]}
 */
function transformCoords(zoom, xtile, ytile) {
  const n = Math.pow(2, zoom);

  const lon_deg = (xtile / n) * 360.0 - 180.0;

  const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * ytile) / n)));

  const lat_deg = (lat_rad * 180.0) / Math.PI;

  return [lon_deg, lat_deg];
}

// for (let i = 0; i < 1000000; i++) {
//   new mapnik.Image(256, 256);
// }
