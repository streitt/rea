import type { RgbaImage } from "../src/types.ts";

export interface Bag {
  /** Frame at which the bag's center is at `startY`. */
  readonly enterFrame: number;
  readonly x: number;
  readonly startY: number;
  /** Pixels per frame, downward when positive. */
  readonly speed: number;
  readonly rx: number;
  readonly ry: number;
}

export interface Clip {
  readonly width: number;
  readonly height: number;
  readonly bags: readonly Bag[];
  readonly noise?: number;
  /** Global brightness wobble per frame, in RGB units. */
  readonly flicker?: number;
  readonly seed?: number;
}

/**
 * Frame `f` of a fixed-camera clip: a textured machine background with grainy
 * bags (tan granules in a translucent sleeve) falling through it.
 */
export function renderFrame(clip: Clip, f: number): RgbaImage {
  const { width, height } = clip;
  const random = mulberry32((clip.seed ?? 1) * 7919 + f);
  const wobble = (clip.flicker ?? 0) * Math.sin(f / 3);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const steel = 120 + 25 * Math.sin(x / 17) + 15 * Math.cos(y / 23);
      let rgb = [steel, steel + 4, steel + 10];
      if (x > width * 0.15 && x < width * 0.22) rgb = [30, 30, 34];
      for (const bag of clip.bags) {
        const cy = bag.startY + (f - bag.enterFrame) * bag.speed;
        const u = (x - bag.x) / bag.rx;
        const v = (y - cy) / bag.ry;
        if (f >= bag.enterFrame && u * u + v * v <= 1) {
          const grain =
            25 * Math.sin(x * 1.7 + y * 2.3) * Math.cos(x * 0.9 - y * 1.3);
          rgb = [205 + grain, 160 + grain, 105 + grain];
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        data[o + c] =
          rgb[c]! + wobble + (random() - 0.5) * 2 * (clip.noise ?? 0);
      }
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
