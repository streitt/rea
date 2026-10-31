import {
  boxFilter,
  correlationAt,
  derivative,
  gaussianSmooth,
  median,
  parabolicOffset,
  round,
  sampleAt,
  weightedMedian,
} from "./signal.ts";
import type { JointOrientation, Point, Region, RgbaImage } from "./types.ts";

// Light blur keeps whole-pixel joint jitter from splitting the period peak.
function gradientsOf(strips: Strip[]): Float64Array[] {
  return strips.map((strip) => derivative(gaussianSmooth(strip.profile, 1.2)));
}

/** Luminance of a region addressed as (along the stack, across the stack). */
export class StackView {
  readonly along: number;
  readonly across: number;
  readonly #image: RgbaImage;
  readonly #region: Region;
  readonly #horizontal: boolean;

  constructor(image: RgbaImage, region: Region, orientation: JointOrientation) {
    this.#image = image;
    this.#region = region;
    this.#horizontal = orientation === "horizontal";
    this.along = this.#horizontal ? region.height : region.width;
    this.across = this.#horizontal ? region.width : region.height;
  }

  luminance(along: number, across: number): number {
    const x = this.#region.x + (this.#horizontal ? across : along);
    const y = this.#region.y + (this.#horizontal ? along : across);
    const offset = (y * this.#image.width + x) * 4;
    const data = this.#image.data;
    return (
      0.299 * data[offset]! +
      0.587 * data[offset + 1]! +
      0.114 * data[offset + 2]!
    );
  }

  /** Linear interpolation along the stack, clamped to the region. */
  sample(along: number, across: number): number {
    const clamped = Math.max(0, Math.min(this.along - 1, along));
    const i = Math.floor(clamped);
    const t = clamped - i;
    if (t === 0) return this.luminance(i, across);
    return (
      this.luminance(i, across) * (1 - t) + this.luminance(i + 1, across) * t
    );
  }

  toImage(along: number, across: number): Point {
    const x = this.#region.x + (this.#horizontal ? across : along);
    const y = this.#region.y + (this.#horizontal ? along : across);
    return { x: round(x, 1), y: round(y, 1) };
  }
}

export interface Strip {
  /** Center of the strip across the stack. */
  readonly position: number;
  readonly profile: Float64Array;
}

/**
 * Mean luminance per strip. With a known skew each column is sampled along
 * its joint slope relative to the strip center, so joints stay sharp, and the
 * strips keep their mutual offsets for later alignment.
 */
function stripProfiles(view: StackView, count: number, skew: number): Strip[] {
  const strips: Strip[] = [];
  for (let s = 0; s < count; s++) {
    const from = Math.floor((s * view.across) / count);
    const to = Math.floor(((s + 1) * view.across) / count);
    const position = (from + to - 1) / 2;
    const profile = new Float64Array(view.along);
    for (let u = 0; u < view.along; u++) {
      let sum = 0;
      for (let v = from; v < to; v++)
        sum += view.sample(u + skew * (v - position), v);
      profile[u] = sum / (to - from);
    }
    strips.push({ position, profile });
  }
  return strips;
}

/**
 * Sheet period from the strip-median autocorrelation of the luminance
 * gradient. Autocorrelation is independent of each strip's offset, so skew
 * does not blur it.
 */
function estimatePeriod(
  gradients: Float64Array[],
  minLag: number,
  maxLag: number,
): { lag: number; strength: number } {
  const lags = Math.floor(maxLag) + 2;
  const curve = new Float64Array(lags);
  // The median ignores strips whose occluder carries its own texture period.
  for (let lag = 1; lag < lags; lag++) {
    curve[lag] = median(
      gradients.map((gradient) => correlationAt(gradient, gradient, lag)),
    );
  }
  const peaks: number[] = [];
  for (let lag = Math.ceil(minLag); lag <= Math.floor(maxLag); lag++) {
    if (curve[lag]! > curve[lag - 1]! && curve[lag]! >= curve[lag + 1]!)
      peaks.push(lag);
  }
  if (peaks.length === 0) return { lag: minLag, strength: 0 };
  const best = peaks.reduce((a, b) => (curve[b]! > curve[a]! ? b : a));
  // A peak can split across two integer lags while its multiples line up, so
  // test exact sub-multiples of the strongest lag, finest first.
  let lag = best;
  for (let k = Math.floor(best / minLag); k >= 2; k--) {
    const target = best / k;
    const near = peaks.filter(
      (candidate) => Math.abs(candidate - target) <= 1.5,
    );
    const strongest = near.sort((a, b) => curve[b]! - curve[a]!)[0];
    if (strongest !== undefined && curve[strongest]! >= 0.45 * curve[best]!) {
      lag = strongest;
      break;
    }
  }
  return {
    lag: lag + parabolicOffset(curve[lag - 1]!, curve[lag]!, curve[lag + 1]!),
    strength: Math.max(0, curve[lag]!),
  };
}

/**
 * Joint slope from neighbouring strips. Adjacent strips are close enough that
 * their shift stays under half a period; occluded strips correlate weakly and
 * carry little weight in the median.
 */
function estimateSkew(
  strips: Strip[],
  gradients: Float64Array[],
  period: number,
): number {
  if (strips.length < 2) return 0;
  const maxShift = Math.max(1, Math.floor(period * 0.45));
  const slopes: number[] = [];
  const weights: number[] = [];
  for (let s = 0; s + 1 < strips.length; s++) {
    const a = gradients[s]!;
    const b = gradients[s + 1]!;
    const scores: number[] = [];
    for (let shift = -maxShift - 1; shift <= maxShift + 1; shift++) {
      scores.push(correlationAt(a, b, shift));
    }
    let bestIndex = 1;
    for (let i = 2; i < scores.length - 1; i++) {
      if (scores[i]! > scores[bestIndex]!) bestIndex = i;
    }
    const shift =
      bestIndex -
      maxShift -
      1 +
      parabolicOffset(
        scores[bestIndex - 1]!,
        scores[bestIndex]!,
        scores[bestIndex + 1]!,
      );
    slopes.push(shift / (strips[s + 1]!.position - strips[s]!.position));
    weights.push(Math.max(0, scores[bestIndex]!) ** 2);
  }
  return weightedMedian(slopes, weights);
}

/** Per-row median across strips after removing skew; robust to occluders. */
export function alignedMedianProfile(
  strips: Strip[],
  skew: number,
  center: number,
  length: number,
): Float64Array {
  const out = new Float64Array(length);
  const column: number[] = [];
  for (let u = 0; u < length; u++) {
    column.length = 0;
    for (const strip of strips) {
      const position = u + skew * (strip.position - center);
      if (position >= 0 && position <= length - 1) {
        column.push(sampleAt(strip.profile, position));
      }
    }
    out[u] =
      column.length > 0 ? median(column) : sampleAt(strips[0]!.profile, u);
  }
  return out;
}

/** Removes lighting gradients; a one-period box filter cancels the sheet pattern. */
export function detrend(profile: Float64Array, period: number): Float64Array {
  const trend = boxFilter(profile, period);
  const out = new Float64Array(profile.length);
  for (let i = 0; i < profile.length; i++) out[i] = profile[i]! - trend[i]!;
  return gaussianSmooth(out, Math.max(0.5, period / 12));
}

export interface StackMeasurement {
  readonly strips: Strip[];
  readonly period: { readonly lag: number; readonly strength: number };
  readonly skew: number;
}

/**
 * Sheet period and joint slope. Joints that slope across a strip blur when
 * averaged, so a strong skew triggers a deskewed second measurement.
 */
export function measureStack(
  view: StackView,
  stripCount: number,
  periodBounds: { readonly min: number; readonly max: number },
): StackMeasurement {
  let strips = stripProfiles(view, stripCount, 0);
  let period = estimatePeriod(
    gradientsOf(strips),
    periodBounds.min,
    periodBounds.max,
  );
  let skew = estimateSkew(strips, gradientsOf(strips), period.lag);
  if (Math.abs(skew) * (view.across / stripCount) > 0.5) {
    const deskewed = stripProfiles(view, stripCount, skew);
    const refined = estimatePeriod(
      gradientsOf(deskewed),
      periodBounds.min,
      periodBounds.max,
    );
    if (refined.strength >= period.strength) {
      strips = deskewed;
      period = refined;
      skew = estimateSkew(strips, gradientsOf(strips), period.lag);
    }
  }
  return { strips, period, skew };
}
