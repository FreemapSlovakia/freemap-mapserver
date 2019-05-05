const path = require('path');
const config = require('config');
const mapnik = require('mapnik');
const { rename, mkdir, unlink, stat } = require('fs').promises;
const { mercSrs } = require('./projections');
const { tile2key, tileOverlapsLimits, zoomDenoms } = require('./tileCalc');
const { dirtyTiles } = require('./dirtyTilesRegister');
const { getPool } = require('./mapnikPool');

const forceTileRendering = config.get('forceTileRendering');
const rerenderOlderThanMs = config.get('rerenderOlderThanMs');
const prerenderConfig = config.get('prerender');
const renderToPdfConcurrency = config.get('renderToPdfConcurrency');
const scales = config.get('limits.scales');

const tilesDir = config.get('dirs.tiles');

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
      if (mtimeMs > a.dt) {
        console.log(`${logPrefix}fresh`);
        return;
      }
    } catch (_) {
      // nothing
    }
  }

  const tmpName = `${ps}_${cnt++}_tmp.png`;

  const map = await (getPool().acquire(prerender ? 1 : 0));
  try {
    console.log(`${logPrefix}rendering`);
    map.resize(256 * scale, 256 * scale);
    map.zoomToBox(merc.forward([...transformCoords(zoom, x, y + 1), ...transformCoords(zoom, x + 1, y)]));
    await map.renderFileAsync(tmpName, { format: 'png', buffer_size: 256, scale });
  } finally {
    getPool().release(map);
  }

  await rename(tmpName, `${ps}.png`).catch((err) => {
    console.error('Error renaming file:', err);
  });
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
