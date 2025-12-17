import path from 'path';
import config from 'config';
import { rename, mkdir, unlink, stat, writeFile, open } from 'fs/promises';
import { flock } from 'fs-ext';
import { promisify } from 'util';
import {
  bbox4326To3857,
  tile2key,
  tile2bbox3859,
  tileOverlapsLimits,
} from './tileCalc.js';
import { dirtyTiles } from './dirtyTilesRegister.js';
import { pool } from './mapnikPool.js';
import { prerenderPolygon } from './config.js';
import { Tile } from './types.js';
import { RenderFormat } from './renderWorker.js';

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

let tilesDir: string = config.get('dirs.tiles');

const extension: string = config.get('format.extension');

const expiresZoom = config.get('expiresZoom');

const prerenderMaxZoom: number = config.get('prerenderMaxZoom');

const prerenderDelayWhenExpiring: number | undefined = config.get(
  'prerenderDelayWhenExpiring',
);

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
    } catch {
      // nothing
    }
  }

  console.log(`${logPrefix}rendering`, reasons);

  const renderer = await pool.acquire(prerender ? 1 : 0);

  let buffer: Buffer;

  let t: number;

  try {
    t = Date.now();

    const result = await renderer.render(
      tile2bbox3859(x, y, zoom),
      zoom,
      scale,
      extension as RenderFormat,
    );

    buffer = result.data;

    measure('render', Date.now() - t);
  } finally {
    pool.release(renderer);
    // TODO release image pool on error
  }

  const tmpName = `${ps}_${cnt++}_tmp.${extension}`;

  t = Date.now();

  await writeFile(tmpName, buffer);

  if (typeof expiresZoom === 'number' && zoom > prerenderMaxZoom) {
    const div = 2 ** (zoom - expiresZoom);

    await mkdir(
      path.resolve(tilesDir, String(expiresZoom), String(Math.floor(x / div))),
      { recursive: true },
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
  zoom: number,
  bbox: [number, number, number, number],
  scale = 1,
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

  const renderer = await pool.acquire(1);

  try {
    const result = await renderer.render(
      bbox4326To3857(bbox),
      zoom,
      scale,
      format as RenderFormat,
    );

    if (!destFile) {
      return result.data;
    }

    await writeFile(destFile, result.data);
  } finally {
    pool.release(renderer);

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
