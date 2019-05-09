const path = require('path');
const config = require('config');
const mapnik = require('mapnik');
const { rename, mkdir, unlink, stat, writeFile } = require('fs').promises;
const { mercSrs } = require('./projections');
const { tile2key, tileOverlapsLimits, zoomDenoms, tileWithinLimits } = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { getPool } = require('./mapnikPool');
const { spawn } = require('promisify-child-process');
const pngquant = require('pngquant-bin');

const forceTileRendering = config.get('forceTileRendering');
const rerenderOlderThanMs = config.get('rerenderOlderThanMs');
const prerenderConfig = config.get('prerender');
const renderToPdfConcurrency = config.get('renderToPdfConcurrency');
const scales = config.get('limits.scales');
const pngquantOptions = config.get('pngquantOptions');
const crop = config.get('crop');

let tilesDir = config.get('dirs.tiles');
const limits = config.get('limits');

const merc = new mapnik.Projection(mercSrs);

module.exports = { renderTile, toPdf };

mapnik.registerFonts(config.get('dirs.fonts'), { recurse: true} );

let cnt = 0;

// TODO if out of prerender area and reqScale is provided then render only that scale
async function renderTile(zoom, x, y, reqScale) {
  const frags = [tilesDir, zoom.toString(10), x.toString(10)];

  const p = path.join(...frags, y.toString(10));
  if (forceTileRendering || !reqScale || await shouldRender(p, { zoom, x, y, reqScale })) {
    await mkdir(path.join(...frags), { recursive: true });

    await Promise.all((reqScale ? [reqScale] : scales).map(scale => renderSingleScale(p, zoom, x, y, scale, !reqScale)));

    if (!reqScale) {
      try {
        await unlink(`${p}.dirty`);
      } catch (_) {
        // ignore
      }

      dirtyTiles.delete(tile2key({ zoom, x, y }));
    }
  }

  return reqScale && `${p}${reqScale === 1 ? '' : `@${reqScale}x`}.png`;
}

async function renderSingleScale(p, zoom, x, y, scale, prerender) {
  const s = scale === 1 ? '' : `@${scale}x`;
  const spec = `${zoom}/${x}/${y}${s}`;
  const logPrefix = `${prerender ? 'Pre-rendering' : 'Rendering'} tile ${spec}: `;
  const ps = `${p}${s}`;

  if (prerender) {
    const a = dirtyTiles.get(tile2key({ zoom, x, y }));
    if (!a) {
      console.warn(`${logPrefix}no dirty meta found`);
      return;
    }

    try {
      const { mtimeMs } = await stat(`${ps}.png`);
      if (mtimeMs > a.dt && (!rerenderOlderThanMs || mtimeMs > rerenderOlderThanMs)) {
        console.log(`${logPrefix}fresh`);
        return;
      }
    } catch (_) {
      // nothing
    }
  }

  console.log(`${logPrefix}rendering`);

  let im = new mapnik.Image(256 * scale, 256 * scale);

  const maps = await (getPool().acquire(prerender ? 1 : 0));
  const { map, cropMap } = maps;
  let t;
  try {
    t = Date.now();
    map.resize(256 * scale, 256 * scale);
    map.zoomToBox(merc.forward([...transformCoords(zoom, x, y + 1), ...transformCoords(zoom, x + 1, y)]));
    // await map.renderFileAsync(tmpName, { format: 'png', buffer_size: 256, scale });
    await map.renderAsync(im, { buffer_size: 256, scale });
    measure('render', Date.now() - t);
  } finally {
    getPool().release(maps);
  }

  if (crop && !tileWithinLimits(limits, { zoom, x, y }) /* TODO narrow down limiting because of edge blurring */) {
    t = Date.now();
    const cropIm = new mapnik.Image(256 * scale, 256 * scale);
    cropMap.zoomToBox(merc.forward([...transformCoords(zoom, x, y + 1), ...transformCoords(zoom, x + 1, y)]));
    await Promise.all([
      cropMap.renderAsync(cropIm, { buffer_size: 256, scale }),
      im.premultiply(),
    ]);
    measure('crop', Date.now() - t);

    t = Date.now();

    await Promise.all([
      crop.blurRadius && cropIm.filterAsync(`agg-stack-blur(${crop.blurRadius},${crop.blurRadius})`),
    ]);

    await cropIm.premultiply();

    // src.compositeAsync(dst,
    await cropIm.compositeAsync(im, {
      comp_op: mapnik.compositeOp.src_in,
    });

    await cropIm.demultiply();
    im = cropIm;

    measure('merge', Date.now() - t);
  }

  let tmpName = `${ps}_${cnt++}_tmp.png`;

  t = Date.now();

  const buffer = await im.encodeAsync('png');

  measure('encode', Date.now() - t);

  t = Date.now();

  if (pngquantOptions) {
    const child = spawn(pngquant, [...pngquantOptions, '-o', tmpName, '-'], { encoding: 'buffer' });
    child.stdin.write(buffer);
    const { /*stdout, stderr,*/ code } = await child;

    if (code) {
      throw new Error(`pngquant exit code: ${code}`);
    }
  } else {
    await writeFile(tmpName, buffer);
  }

  await rename(tmpName, `${ps}.png`);

  measure('fs', Date.now() - t);
}

const measureMap = new Map();
let lastMeasureResult = Date.now();

function measure(operation, duration) {
  let a = measureMap.get(operation);
  if (!a) {
    a = { count: 0, duration: 0 };
    measureMap.set(operation, a);
  }

  a.duration += duration;
  a.count ++;

  if (Date.now() - lastMeasureResult > 60000) {
    console.log('Measurement:', [...measureMap].map(([operation, { count, duration }]) => `${operation}: ${count}x ${duration / count}`).sort());
    measureMap.clear();
    lastMeasureResult = Date.now();
  }
}

// used for requested single scale
async function shouldRender(p, tile) {
  let s;
  try {
    s = await stat(`${p}${tile.reqScale === 1 ? '' : `@${tile.reqScale}x`}.png`);
  } catch (err) {
    return true; // doesn't exist
  }

  // return prerenderConfig && isOld && !tileOverlapsLimits(prerenderConfig, tile)
  //   || prerender && (isOld || dirtyTiles.has(tile2key(tile)));

  return prerenderConfig ? rerenderOlderThanMs && s.mtimeMs < rerenderOlderThanMs && !tileOverlapsLimits(prerenderConfig, tile)
    : true /* TODO other conds */;
}

let pdfLockCount = 0;
let pdfUnlocks = [];

// scale: my screen is 96 dpi, pdf is 72 dpi; 72 / 96 = 0.75
async function toPdf(destFile, xml, zoom, bbox0, scale = 1, width, cancelHolder) {
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
    const q = Math.pow(2, zoom) / 200000;
    const map = new mapnik.Map(
      width || (bbox[2] - bbox[0]) * q,
      width ? (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]) * width : (bbox[3] - bbox[1]) * q,
    );
    await map.fromStringAsync(xml);
    map.zoomToBox(bbox);
    await map.renderFileAsync(destFile, { format: 'pdf', buffer_size: 256, scale_denominator: zoomDenoms[zoom], scale });
  } finally {
    const unlock = pdfUnlocks.shift();
    if (unlock) {
      unlock();
    }
    pdfLockCount--;
  }
}

function transformCoords(zoom, xtile, ytile) {
  const n = Math.pow(2, zoom);
  const lon_deg = xtile / n * 360.0 - 180.0;
  const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ytile / n)));
  const lat_deg = lat_rad * 180.0 / Math.PI;
  return [lon_deg, lat_deg];
}
