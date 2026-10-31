import type { Box, Detection, RgbaImage } from "./types.ts";

export interface MotionDetectorOptions {
  /** Width of the internal working image; frames are downscaled to it. Default 192. */
  readonly workWidth?: number;
  /** Background adaptation per frame where nothing moves. Default 0.04. */
  readonly learningRate?: number;
  /**
   * Adaptation under detected objects. Kept low so an object that pauses
   * (a bag being filled) is not absorbed into the background. Default 0.002.
   */
  readonly foregroundLearningRate?: number;
  /** Minimum per-channel difference from the background. Default 28. */
  readonly threshold?: number;
  /** Smallest object as a fraction of the frame area. Default 0.002. */
  readonly minAreaFraction?: number;
}

/**
 * Finds moving or newly appeared objects against a learned background. Needs
 * a fixed camera; the first frames teach it the empty scene.
 */
export class MotionDetector {
  readonly #workWidth: number;
  readonly #learningRate: number;
  readonly #foregroundRate: number;
  readonly #threshold: number;
  readonly #minAreaFraction: number;
  #background: Float32Array | undefined;
  #shape = { width: 0, height: 0, sourceWidth: 0, sourceHeight: 0 };

  constructor(options: MotionDetectorOptions = {}) {
    this.#workWidth = Math.max(32, Math.floor(options.workWidth ?? 192));
    this.#learningRate = options.learningRate ?? 0.04;
    this.#foregroundRate = options.foregroundLearningRate ?? 0.002;
    this.#threshold = options.threshold ?? 28;
    this.#minAreaFraction = options.minAreaFraction ?? 0.002;
  }

  /** Forget the background, e.g. after the camera moves. */
  reset(): void {
    this.#background = undefined;
  }

  detect(frame: RgbaImage): Detection[] {
    const small = this.#downscale(frame);
    const { width, height } = this.#shape;
    if (
      this.#background === undefined ||
      this.#background.length !== small.length
    ) {
      this.#background = small;
      return [];
    }
    const background = this.#background;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
      const o = i * 3;
      const diff = Math.max(
        Math.abs(small[o]! - background[o]!),
        Math.abs(small[o + 1]! - background[o + 1]!),
        Math.abs(small[o + 2]! - background[o + 2]!),
      );
      mask[i] = diff > this.#threshold ? 1 : 0;
    }
    const cleaned = close(open(mask, width, height), width, height);
    for (let i = 0; i < cleaned.length; i++) {
      const rate = cleaned[i] === 1 ? this.#foregroundRate : this.#learningRate;
      for (let c = 0; c < 3; c++) {
        const o = i * 3 + c;
        background[o] = background[o]! + rate * (small[o]! - background[o]!);
      }
    }
    const minArea = this.#minAreaFraction * width * height;
    return blobs(cleaned, width, height)
      .filter((blob) => blob.area >= minArea)
      .map((blob) => this.#toImage(blob));
  }

  /** Box-averaged RGB at the working resolution. */
  #downscale(frame: RgbaImage): Float32Array {
    const width = Math.min(this.#workWidth, frame.width);
    const scale = frame.width / width;
    const height = Math.max(1, Math.round(frame.height / scale));
    this.#shape = {
      width,
      height,
      sourceWidth: frame.width,
      sourceHeight: frame.height,
    };
    const out = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * scale);
      const y1 = Math.min(
        frame.height,
        Math.max(y0 + 1, Math.floor((y + 1) * scale)),
      );
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * scale);
        const x1 = Math.min(
          frame.width,
          Math.max(x0 + 1, Math.floor((x + 1) * scale)),
        );
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        // Sample a 2x2 lattice of the cell: enough for averaging, cheap per frame.
        for (let sy = y0; sy < y1; sy += Math.max(1, (y1 - y0) >> 1)) {
          for (let sx = x0; sx < x1; sx += Math.max(1, (x1 - x0) >> 1)) {
            const o = (sy * frame.width + sx) * 4;
            r += frame.data[o]!;
            g += frame.data[o + 1]!;
            b += frame.data[o + 2]!;
            n += 1;
          }
        }
        const o = (y * width + x) * 3;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
      }
    }
    return out;
  }

  #toImage(blob: BlobStats): Detection {
    const sx = this.#shape.sourceWidth / this.#shape.width;
    const sy = this.#shape.sourceHeight / this.#shape.height;
    const box: Box = {
      x: Math.round(blob.minX * sx),
      y: Math.round(blob.minY * sy),
      width: Math.round((blob.maxX - blob.minX + 1) * sx),
      height: Math.round((blob.maxY - blob.minY + 1) * sy),
    };
    return {
      box,
      center: {
        x: (blob.sumX / blob.area + 0.5) * sx,
        y: (blob.sumY / blob.area + 0.5) * sy,
      },
      areaPx: Math.round(blob.area * sx * sy),
    };
  }
}

interface BlobStats {
  area: number;
  sumX: number;
  sumY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 8-connected components with their area, centroid sums and bounds. */
function blobs(mask: Uint8Array, width: number, height: number): BlobStats[] {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const out: BlobStats[] = [];
  const flood = { mask, seen, queue, width, height };
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    const stats: BlobStats = {
      area: 0,
      sumX: 0,
      sumY: 0,
      minX: width,
      minY: height,
      maxX: 0,
      maxY: 0,
    };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % width;
      const y = (i - x) / width;
      stats.area += 1;
      stats.sumX += x;
      stats.sumY += y;
      stats.minX = Math.min(stats.minX, x);
      stats.minY = Math.min(stats.minY, y);
      stats.maxX = Math.max(stats.maxX, x);
      stats.maxY = Math.max(stats.maxY, y);
      tail = enqueueNeighbours(flood, i, tail);
    }
    out.push(stats);
  }
  return out;
}

/** Whether the pixel or one of its 8-neighbours has `value`. */
function nearValue(
  grid: { mask: Uint8Array; width: number; height: number },
  index: number,
  value: number,
): boolean {
  const { mask, width, height } = grid;
  const x = index % width;
  const y = (index - x) / width;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
      if (mask[ny * width + nx] === value) return true;
    }
  }
  return false;
}

/** Queues the unseen foreground 8-neighbours of `index`; returns the new tail. */
function enqueueNeighbours(
  flood: {
    mask: Uint8Array;
    seen: Uint8Array;
    queue: Int32Array;
    width: number;
    height: number;
  },
  index: number,
  tail: number,
): number {
  const { mask, seen, queue, width, height } = flood;
  const x = index % width;
  const y = (index - x) / width;
  let next = tail;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
      const j = ny * width + nx;
      if (mask[j] === 1 && seen[j] === 0) {
        seen[j] = 1;
        queue[next++] = j;
      }
    }
  }
  return next;
}

function morph(
  mask: Uint8Array,
  width: number,
  height: number,
  dilate: boolean,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  const target = dilate ? 1 : 0;
  const grid = { mask, width, height };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const found = nearValue(grid, y * width + x, target);
      out[y * width + x] = found ? target : 1 - target;
    }
  }
  return out;
}

/** Removes isolated noise pixels. */
function open(mask: Uint8Array, width: number, height: number): Uint8Array {
  return morph(morph(mask, width, height, false), width, height, true);
}

/** Joins an object split by a thin band of background-coloured pixels. */
function close(mask: Uint8Array, width: number, height: number): Uint8Array {
  let out = mask;
  for (let i = 0; i < 2; i++) out = morph(out, width, height, true);
  for (let i = 0; i < 2; i++) out = morph(out, width, height, false);
  return out;
}
