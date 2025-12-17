import { Renderer } from 'maprender-node';
import { parentPort, workerData } from 'worker_threads';

export type RenderFormat = 'png' | 'jpg' | 'jpeg' | 'pdf' | 'svg';

export type RenderResult = {
  data: Buffer;
  contentType: string;
};

export type RenderRequest = {
  id: number;
  bbox: [number, number, number, number];
  zoom: number;
  scale?: number;
  format?: RenderFormat;
};

export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
};

export type RenderResponse =
  | { type: 'ready' }
  | {
      type: 'error';
      id: number;
      error: SerializedError;
    }
  | {
      type: 'success';
      id: number;
      result: {
        data: Uint8Array;
        contentType: string;
      };
    };

const pp = parentPort;

if (!pp) {
  throw new Error('parentPort is null');
}

const renderer = new Renderer(
  workerData.connectionString,
  workerData.hillshadingBase,
  workerData.svgBase,
);

pp.postMessage({ type: 'ready' } satisfies RenderResponse);

pp.on('message', (message: RenderRequest) => {
  try {
    const result: RenderResult = renderer.render(
      message.bbox,
      message.zoom,
      message.scale,
      message.format,
    );

    const data = Uint8Array.from(result.data);

    pp.postMessage(
      {
        type: 'success',
        id: message.id,
        result: {
          data,
          contentType: result.contentType,
        },
      } satisfies RenderResponse,
      [data.buffer],
    );
  } catch (err) {
    pp.postMessage({
      type: 'error',
      id: message.id,
      error:
        err instanceof Error
          ? { message: err.message, name: err.name, stack: err.stack }
          : { message: String(err) },
    } satisfies RenderResponse);
  }
});
