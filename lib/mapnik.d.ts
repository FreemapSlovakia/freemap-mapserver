import { Map, Image } from 'mapnik'; // Adjust this import based on how you import mapnik

type Promisify<T extends (...args: unknown[]) => unknown> = T extends (
  ...args: [...infer Params, (err: unknown, result: infer Result) => void]
) => unknown
  ? (...args: Params) => Promise<undefined extends Result ? void : Result>
  : T extends (...args: [...infer Params, (err: unknown) => void]) => unknown
    ? (...args: Params) => Promise<void>
    : never;

// Extend Map type
declare module 'mapnik' {
  function registerFonts(dir: string, options?: Partial<{ recurse: boolean }>);

  interface Map {
    width: number;
    height: number;
    render(
      image: Image,
      config?: Partial<{
        buffer_size: number;
        scale: number;
        scale_denominator: number;
        variables: Record<string, unknown>;
      }>,
      callback: (err: unknown) => void,
    );
    renderFile(file: string, unknown, callback: (err: unknown) => void);
    fromString(config: string, callback: (err: unknown, map: Map) => void);

    fromStringAsync: Promisify<Map['fromString']>;
    renderFileAsync: Promisify<Map['renderFile']>;
    renderAsync: Promisify<Map['render']>;
  }

  interface Image {
    composite(image: Image, callback: (err: unknown) => void);
    premultiply(callback: (err: unknown) => void);
    demultiply(callback: (err: unknown) => void);
    resize(callback: (err: unknown) => void);
    fill(color: Color, cllback: (err: unknown) => void);
    filter(callback: (err: unknown) => void);
    clear(allback: (err: unknown) => void);

    encodeAsync: Promisify<Image['encode']>;
    compositeAsync: Promisify<Image['composite']>;
    premultiplyAsync: Promisify<Image['premultiply']>;
    demultiplyAsync: Promisify<Image['demultiply']>;
    resizeAsync: Promisify<Image['resize']>;
    fillAsync: Promisify<Image['fill']>;
    filterAsync: Promisify<Image['filter']>;
    clearAsync: Promisify<Image['clear']>;
  }

  class Color {
    constructor(value: string);
  }

  interface ProjTransform {
    forward<T extends [number, number] | [number, number, number, number]>(
      coord: T,
    ): T;
    backwardd<T extends [number, number] | [number, number, number, number]>(
      coord: T,
    ): T;
  }
  // ctor type; avoids overwriting if it already exists
  var ProjTransform: { new (src: Projection, dst: Projection): ProjTransform };
}
