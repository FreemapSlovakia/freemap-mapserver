const path = require('path');
const config = require('config');
const mapnik = require('mapnik');
const { rename, mkdir, unlink, stat, writeFile } = require('fs').promises;
const { mercSrs } = require('./projections');
const { tile2key, tileOverlapsLimits, zoomDenoms } = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { getPool } = require('./mapnikPool');
const { spawn } = require('promisify-child-process');
const pngquant = require('pngquant-bin');
const { prerenderPolygon } = require('./config');

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

const merc = new mapnik.Projection(mercSrs);

module.exports = { renderTile, exportMap };

mapnik.registerFonts(config.get('dirs.fonts'), { recurse: true });

let cnt = 0;

// TODO if out of prerender area and reqScale is provided then render only that scale
/**
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 * @param {number | undefined} reqScale
 * @returns {string | undefined}
 */
async function renderTile(zoom, x, y, reqScale) {
  const frags = [tilesDir, zoom.toString(10), x.toString(10)];

  const p = path.join(...frags, y.toString(10));
  if (
    forceTileRendering ||
    !reqScale ||
    (await shouldRender(p, { zoom, x, y, reqScale }))
  ) {
    await mkdir(path.join(...frags), { recursive: true });

    await Promise.all(
      (reqScale ? [reqScale] : limitScales).map(scale =>
        renderSingleScale(p, zoom, x, y, scale, !reqScale),
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

/**
 *
 * @param {string} p
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 * @param {boolean} prerender
 */
async function renderSingleScale(p, zoom, x, y, scale, prerender) {
  const s = scale === 1 ? '' : `@${scale}x`;
  const spec = `${zoom}/${x}/${y}${s}`;
  const ps = `${p}${s}`;
  const logPrefix = `${
    prerender ? 'Pre-rendering' : 'Rendering'
  } tile ${spec}: `;

  if (prerender) {
    const a = dirtyTiles.get(tile2key({ zoom, x, y }));
    if (!a) {
      console.warn(`${logPrefix}no dirty meta found`);
      return;
    }

    try {
      const { mtimeMs } = await stat(`${ps}.${extension}`);
      if (
        mtimeMs > a.dt &&
        (!rerenderOlderThanMs || mtimeMs > rerenderOlderThanMs)
      ) {
        console.log(`${logPrefix}fresh`);
        return;
      }
    } catch (_) {
      // nothing
    }
  }

  console.log(`${logPrefix}rendering`);

  let im = new mapnik.Image(256 * scale, 256 * scale);

  const maps = await getPool().acquire(prerender ? 1 : 0);
  const { map } = maps;

  /** @type number */
  let t;
  try {
    t = Date.now();
    map.resize(256 * scale, 256 * scale);
    map.zoomToBox(
      merc.forward([
        ...transformCoords(zoom, x, y + 1),
        ...transformCoords(zoom, x + 1, y),
      ]),
    );

    // await map.renderFileAsync(tmpName, { format: 'png', buffer_size: 256, scale });
    await map.renderAsync(im, {
      buffer_size: 256,
      scale,
      variables: { zoom, scale_denominator: zoomDenoms[zoom] },
    }); // TODO buffer_size * scale?

    measure('render', Date.now() - t);

    // this is to get rid of transparency because of edge blurring and JPEG
    let bgIm = new mapnik.Image(256 * scale, 256 * scale);
    await bgIm.fill(new mapnik.Color('white'));
    await bgIm.premultiplyAsync();
    await im.premultiplyAsync();
    // dst.compositeAsync(src
    await bgIm.compositeAsync(im);
    await bgIm.demultiplyAsync();
    im = bgIm;
  } finally {
    getPool().release(maps);
  }

  let tmpName = `${ps}_${cnt++}_tmp.${extension}`;

  t = Date.now();

  const buffer = await im.encodeAsync(codec);

  measure('encode', Date.now() - t);

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
async function shouldRender(p, tile) {
  let s;
  try {
    s = await stat(
      `${p}${tile.reqScale === 1 ? '' : `@${tile.reqScale}x`}.${extension}`,
    );
  } catch (err) {
    return true; // doesn't exist
  }

  // return prerenderPolygon && isOld && !tileOverlapsLimits(prerenderPolygon, tile)
  //   || prerender && (isOld || dirtyTiles.has(tile2key(tile)));

  return prerenderPolygon
    ? rerenderOlderThanMs &&
        s.mtimeMs < rerenderOlderThanMs &&
        !tileOverlapsLimits(prerenderPolygon, tile)
    : true /* TODO other conds */;
}

let pdfLockCount = 0;
let pdfUnlocks = [];

// scale: my screen is 96 dpi, pdf is 72 dpi; 72 / 96 = 0.75
/**
 * @param {string} destFile
 * @param {string} xml
 * @param {number} zoom
 * @param {[number, number, number, number]} bbox0
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
    await new Promise(unlock => {
      pdfUnlocks.push(unlock);
    });
  }

  if (cancelHolder && cancelHolder.cancelled) {
    throw new Error('Cancelled');
  }

  pdfLockCount++;

  try {
    const bbox = merc.forward(bbox0);
    const q = Math.pow(2, zoom) / 200000;

    const map = new mapnik.Map(
      width || (bbox[2] - bbox[0]) * q * scale,
      (width
        ? ((bbox[3] - bbox[1]) / (bbox[2] - bbox[0])) * width
        : (bbox[3] - bbox[1]) * q) * scale,
    );

    await map.fromStringAsync(xml);

    map.zoomToBox(bbox);

    await map.renderFileAsync(destFile, {
      format,
      buffer_size: 256,
      scale_denominator: zoomDenoms[zoom],
      scale,
      variables: {
        zoom,
        scale_denominator: zoomDenoms[zoom],
      },
    });
  } finally {
    const unlock = pdfUnlocks.shift();
    if (unlock) {
      unlock();
    }

    pdfLockCount--;
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
