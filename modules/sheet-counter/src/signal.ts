// One-dimensional signal primitives used on stack profiles.

export function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return values.length === 0 ? 0 : sum / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Weighted median; entries with non-positive weight are ignored. */
export function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values
    .map((value, i) => ({ value, weight: weights[i] ?? 0 }))
    .filter((pair) => pair.weight > 0)
    .sort((a, b) => a.value - b.value);
  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  let running = 0;
  for (const pair of pairs) {
    running += pair.weight;
    if (running >= total / 2) return pair.value;
  }
  return 0;
}

/** Linear interpolation with edge clamping. */
export function sampleAt(signal: Float64Array, position: number): number {
  const last = signal.length - 1;
  if (position <= 0) return signal[0]!;
  if (position >= last) return signal[last]!;
  const i = Math.floor(position);
  const t = position - i;
  return signal[i]! * (1 - t) + signal[i + 1]! * t;
}

/** Centered moving average with edge clamping. */
export function boxFilter(signal: Float64Array, width: number): Float64Array {
  const half = Math.max(0, width / 2);
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    // Integrate a continuous window so non-integer periods cancel fully.
    const steps = Math.max(1, Math.ceil(width * 2));
    let sum = 0;
    for (let k = 0; k <= steps; k++) {
      sum += sampleAt(signal, i - half + (k / steps) * 2 * half);
    }
    out[i] = sum / (steps + 1);
  }
  return out;
}

export function gaussianSmooth(
  signal: Float64Array,
  sigma: number,
): Float64Array {
  if (sigma <= 0.3) return Float64Array.from(signal);
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  let norm = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    norm += w;
  }
  const out = new Float64Array(signal.length);
  const last = signal.length - 1;
  for (let i = 0; i < signal.length; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = Math.min(last, Math.max(0, i + k));
      sum += signal[j]! * kernel[k + radius]!;
    }
    out[i] = sum / norm;
  }
  return out;
}

/** Central difference. */
export function derivative(signal: Float64Array): Float64Array {
  const out = new Float64Array(signal.length);
  for (let i = 1; i < signal.length - 1; i++) {
    out[i] = (signal[i + 1]! - signal[i - 1]!) / 2;
  }
  return out;
}

/** Normalized cross-correlation of `a[i]` with `b[i + lag]` over their overlap. */
export function correlationAt(
  a: Float64Array,
  b: Float64Array,
  lag: number,
): number {
  const start = Math.max(0, -lag);
  const end = Math.min(a.length, b.length - lag);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  let ma = 0;
  let mb = 0;
  const n = end - start;
  if (n < 2) return 0;
  for (let i = start; i < end; i++) {
    ma += a[i]!;
    mb += b[i + lag]!;
  }
  ma /= n;
  mb /= n;
  for (let i = start; i < end; i++) {
    const x = a[i]! - ma;
    const y = b[i + lag]! - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb);
}

/** Offset of the vertex of the parabola through three samples, in [-0.5, 0.5]. */
export function parabolicOffset(
  left: number,
  center: number,
  right: number,
): number {
  const denominator = left - 2 * center + right;
  if (denominator >= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
}

export function skewness(values: Float64Array): number {
  const m = mean(values);
  let m2 = 0;
  let m3 = 0;
  for (const value of values) {
    const d = value - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= values.length;
  m3 /= values.length;
  return m2 === 0 ? 0 : m3 / Math.pow(m2, 1.5);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
