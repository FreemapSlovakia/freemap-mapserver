import path from 'path';
import config from 'config';
import mapnik from 'mapnik';
import { rename, mkdir, unlink, stat, writeFile, open } from 'fs/promises';
import { flock } from 'fs-ext';
import { promisify } from 'util';
import { mercSrs } from './projections.js';
import { tile2key, tileOverlapsLimits } from './tileCalc.js';
import { dirtyTiles } from './dirtyTilesRegister.js';
import { getPool, getImagePool } from './mapnikPool.js';
import { spawn } from 'promisify-child-process';
import pngquant from 'pngquant-bin';
import { prerenderPolygon } from './config.js';
import { Tile } from './types.js';

const flockAsync = promisify(
  flock as (
    fd: number,
    flags: 'sh' | 'ex' | 'shnb' | 'exnb' | 'un',
    callback: (err: NodeJS.ErrnoException | null) => void,
  ) => void,
);

const forceTileRendering = config.get('forceTileRendering');

const rerenderOlderThanMs: number | undefined = config.get(
  'rerenderOlderThanMs',
);

const renderToPdfConcurrency: number = config.get('renderToPdfConcurrency');

const limitScales: number[] = config.get('limits.scales');

const pngquantOptions: string[] | undefined = config.get('pngquantOptions');

let tilesDir: string = config.get('dirs.tiles');

const extension: string = config.get('format.extension');

const codec: string = config.get('format.codec');

const expiresZoom = config.get('expiresZoom');

const prerenderMaxZoom: number = config.get('prerenderMaxZoom');

const prerenderDelayWhenExpiring: number | undefined = config.get(
  'prerenderDelayWhenExpiring',
);

const merc = new mapnik.Projection(mercSrs);

mapnik.registerFonts(config.get('dirs.fonts'), { recurse: true });

const white = new mapnik.Color('white');

let cnt = 0;

// TODO if out of prerender area and reqScale is provided then render only that scale
export async function renderTile(
  zoom: number,
  x: number,
  y: number,
  reqScale?: number,
): Promise<string | undefined> {
  const frags = [tilesDir, zoom.toString(10), x.toString(10)];

  const p = path.join(...frags, y.toString(10));

  const reasons: string[] = [];

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
        await unlink(p + '.dirty');
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

let coolDownPromise: Promise<void> | null;

async function renderSingleScale(
  p: string,
  zoom: number,
  x: number,
  y: number,
  scale: number,
  prerender: boolean,
  reasons: string[],
) {
  if (
    prerender &&
    global.processingExpiredTiles &&
    prerenderDelayWhenExpiring
  ) {
    if (coolDownPromise) {
      await coolDownPromise;
    } else {
      coolDownPromise = new Promise<void>((resolve) => {
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

  let t: number;

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
          scale,
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
          await bgIm.fillAsync(white);
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
    const child = spawn(pngquant, [...pngquantOptions, '-o', tmpName, '-'], {
      encoding: 'buffer',
    });

    child.stdin!.write(buffer);

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

const measureMap = new Map<string, { count: number; duration: number }>();

let lastMeasureResult = Date.now();

function measure(operation: string, duration: number) {
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
async function shouldRender(
  p: string,
  tile: Tile & { reqScale: number },
  reasons: string[],
) {
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
const pdfUnlocks: (() => void)[] = [];

// scale: my screen is 96 dpi, pdf is 72 dpi; 72 / 96 = 0.75
export async function exportMap(
  destFile: string | undefined,
  xml: string,
  zoom: number,
  bbox0: [number, number, number, number],
  scale = 1,
  width: number | undefined | null,
  cancelHolder: { cancelled: boolean } | undefined,
  format: string,
) {
  if (pdfLockCount >= renderToPdfConcurrency) {
    await new Promise<void>((unlock) => {
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
          scale,
          scale_denominator,
        },
      });
    } else {
      const im = new mapnik.Image(map.width, map.height);

      await map.renderAsync(im, {
        buffer_size: 256,
        scale,
        scale_denominator,
        variables: { zoom, scale, scale_denominator },
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

function transformCoords(zoom: number, xtile: number, ytile: number) {
  const n = Math.pow(2, zoom);

  const lon_deg = (xtile / n) * 360.0 - 180.0;

  const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * ytile) / n)));

  const lat_deg = (lat_rad * 180.0) / Math.PI;

  return [lon_deg, lat_deg];
}

// for (let i = 0; i < 1000000; i++) {
//   new mapnik.Image(256, 256);
// }
