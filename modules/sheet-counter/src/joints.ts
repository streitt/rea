import { detrend, type Strip } from "./stackProfile.ts";
import { median, parabolicOffset, sampleAt, skewness } from "./signal.ts";
import type { SheetBasis } from "./types.ts";

/** Joints closer than this fraction of a period are the same joint. */
const MIN_JOINT_SPACING = 0.6;

export interface Joint {
  /** Position along the stack at the reference (center) column. */
  readonly at: number;
  readonly inferred: boolean;
  readonly prominence: number;
  readonly stripAgreement: number;
}

/** The measured stack in which joints are searched. */
export interface JointScene {
  readonly strips: Strip[];
  /** Median profile across strips, aligned to the center column. */
  readonly aligned: Float64Array;
  readonly skew: number;
  readonly center: number;
  readonly thickness: number;
}

/** Observed joints for the requested polarity, choosing it when `auto`. */
export function detectJoints(
  scene: JointScene,
  requested: "auto" | "dark" | "bright",
): { polarity: "dark" | "bright"; observed: Joint[] } {
  const detrended = detrend(scene.aligned, scene.thickness);
  const detectFor = (polarity: "dark" | "bright"): Joint[] => {
    const sign = polarity === "dark" ? -1 : 1;
    const stripSignals = scene.strips.map((strip) =>
      signed(detrend(strip.profile, scene.thickness), sign),
    );
    return findJoints(signed(detrended, sign), scene.thickness).map(
      (joint) => ({
        ...joint,
        stripAgreement: stripAgreement(joint.at, scene, stripSignals),
      }),
    );
  };
  return requested === "auto"
    ? choosePolarity(
        detectFor("dark"),
        detectFor("bright"),
        scene.thickness,
        detrended,
      )
    : { polarity: requested, observed: detectFor(requested) };
}

/**
 * True joints repeat at whole multiples of the period and show up in most
 * strips; the opposite polarity lands on sheet faces, whose brightness varies.
 * Profile asymmetry (narrow joints form the tail) breaks near-ties.
 */
function choosePolarity(
  dark: Joint[],
  bright: Joint[],
  period: number,
  detrended: Float64Array,
): { polarity: "dark" | "bright"; observed: Joint[] } {
  const score = (joints: Joint[]): number => {
    if (joints.length < 2) return 0;
    let regular = 0;
    for (let i = 1; i < joints.length; i++) {
      const ratio = (joints[i]!.at - joints[i - 1]!.at) / period;
      if (Math.round(ratio) >= 1 && Math.abs(ratio - Math.round(ratio)) <= 0.15)
        regular += 1;
    }
    const agreement = joints.reduce(
      (sum, joint) => sum + joint.stripAgreement,
      0,
    );
    return regular / (joints.length - 1) + agreement / joints.length;
  };
  const difference = score(dark) - score(bright);
  const brightWins =
    Math.abs(difference) > 0.1 ? difference < 0 : skewness(detrended) > 0.15;
  return brightWins
    ? { polarity: "bright", observed: bright }
    : { polarity: "dark", observed: dark };
}

function signed(signal: Float64Array, sign: number): Float64Array {
  return signal.map((value) => value * sign);
}

/**
 * Greedy non-maximum suppression: the strongest maxima claim their
 * neighbourhood first, so sheet-face texture cannot pose as a joint.
 */
function findJoints(signal: Float64Array, period: number): Joint[] {
  const candidates: number[] = [];
  for (let i = 1; i < signal.length - 1; i++) {
    if (
      signal[i]! > 0 &&
      signal[i]! > signal[i - 1]! &&
      signal[i]! >= signal[i + 1]!
    ) {
      candidates.push(i);
    }
  }
  candidates.sort((a, b) => signal[b]! - signal[a]!);
  const minSpacing = MIN_JOINT_SPACING * period;
  const accepted: number[] = [];
  for (const candidate of candidates) {
    if (accepted.every((at) => Math.abs(at - candidate) >= minSpacing)) {
      accepted.push(candidate);
    }
  }
  const joints = accepted
    .map((at) => ({
      at: at + parabolicOffset(signal[at - 1]!, signal[at]!, signal[at + 1]!),
      prominence: prominence(signal, at, period),
    }))
    .sort((a, b) => a.at - b.at);
  const typical = median(joints.map((joint) => joint.prominence));
  return joints
    .filter((joint) => joint.prominence >= 0.3 * typical)
    .map((joint) => ({
      at: joint.at,
      inferred: false,
      prominence: typical === 0 ? 0 : Math.min(1, joint.prominence / typical),
      stripAgreement: 0,
    }));
}

function prominence(signal: Float64Array, at: number, period: number): number {
  const reach = Math.max(1, Math.round(period * 0.8));
  let leftMin = signal[at]!;
  let rightMin = signal[at]!;
  for (let i = Math.max(0, at - reach); i < at; i++)
    leftMin = Math.min(leftMin, signal[i]!);
  for (let i = at + 1; i <= Math.min(signal.length - 1, at + reach); i++) {
    rightMin = Math.min(rightMin, signal[i]!);
  }
  return signal[at]! - Math.max(leftMin, rightMin);
}

/** Fraction of strips with their own local joint maximum at the skewed position. */
function stripAgreement(
  at: number,
  scene: JointScene,
  signals: Float64Array[],
): number {
  const { strips, skew, center, thickness: period } = scene;
  let agreeing = 0;
  strips.forEach((strip, s) => {
    const signal = signals[s]!;
    const expected = at + skew * (strip.position - center);
    const from = Math.max(0, Math.floor(expected - period * 0.3));
    const to = Math.min(signal.length - 1, Math.ceil(expected + period * 0.3));
    let best = from;
    for (let i = from; i <= to; i++) if (signal[i]! > signal[best]!) best = i;
    if (signal[best]! > 0 && Math.abs(best - expected) <= period * 0.2)
      agreeing += 1;
  });
  return agreeing / strips.length;
}

/**
 * A missing joint leaves an interval of k periods. Split it only when the
 * interval is a near-integer multiple and its body matches the sheet faces,
 * so background beyond the stack is never split into sheets.
 */
export function fillGaps(
  joints: Joint[],
  period: number,
  profile: Float64Array,
): Joint[] {
  if (joints.length < 2) return joints;
  const faces = faceStatistics(joints, profile, period);
  const out: Joint[] = [joints[0]!];
  for (let i = 1; i < joints.length; i++) {
    const previous = joints[i - 1]!;
    const next = joints[i]!;
    const gap = next.at - previous.at;
    const k = Math.round(gap / period);
    if (k >= 2 && Math.abs(gap / k - period) <= 0.2 * period) {
      const step = gap / k;
      const looksLikeSheets = Array.from({ length: k }, (_, j) =>
        faces.matches(
          previous.at + (j + 0.5) * step,
          bandMean(
            profile,
            previous.at + j * step,
            previous.at + (j + 1) * step,
          ),
        ),
      ).every(Boolean);
      if (looksLikeSheets) {
        for (let j = 1; j < k; j++) {
          out.push({
            at: previous.at + j * step,
            inferred: true,
            prominence: 0,
            stripAgreement: 0,
          });
        }
      }
    }
    out.push(next);
  }
  return out;
}

interface FaceStatistics {
  /** Whether a band centered at `at` has the luminance of nearby sheet faces. */
  matches(at: number, value: number): boolean;
}

const NEIGHBOUR_FACES = 4;

/**
 * Luminance of sheet faces bounded by two observed joints about one period
 * apart. Bands are compared with their nearest faces so lighting gradients
 * across the stack do not reject end sheets.
 */
function faceStatistics(
  joints: Joint[],
  profile: Float64Array,
  period: number,
): FaceStatistics {
  const faces: { at: number; value: number }[] = [];
  for (let i = 1; i < joints.length; i++) {
    const from = joints[i - 1]!.at;
    const to = joints[i]!.at;
    if (Math.abs(to - from - period) <= 0.25 * period) {
      faces.push({ at: (from + to) / 2, value: bandMean(profile, from, to) });
    }
  }
  if (faces.length < 2) return { matches: () => true };
  const local = (at: number, exclude?: { at: number }): number =>
    median(
      faces
        .filter((face) => face !== exclude)
        .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))
        .slice(0, NEIGHBOUR_FACES)
        .map((face) => face.value),
    );
  // Leave-one-out residuals measure how much a face differs from its neighbours.
  const residuals = faces.map((face) =>
    Math.abs(face.value - local(face.at, face)),
  );
  const tolerance = Math.max(4 * 1.4826 * median(residuals), 16);
  return { matches: (at, value) => Math.abs(value - local(at)) <= tolerance };
}

/** Mean of the inner 70% of a band, away from the joints themselves. */
function bandMean(profile: Float64Array, from: number, to: number): number {
  const inset = (to - from) * 0.15;
  const start = Math.max(0, Math.ceil(from + inset));
  const end = Math.min(profile.length - 1, Math.floor(to - inset));
  if (end < start) return sampleAt(profile, (from + to) / 2);
  let sum = 0;
  for (let i = start; i <= end; i++) sum += profile[i]!;
  return sum / (end - start + 1);
}

export interface Sheet {
  readonly at: number;
  readonly basis: SheetBasis;
  readonly confidence: number;
}

function jointConfidence(joint: Joint): number {
  return joint.inferred
    ? 0.3
    : 0.5 * joint.stripAgreement + 0.5 * joint.prominence;
}

export function sheetsBetween(
  joints: Joint[],
  profile: Float64Array,
  period: number,
  length: number,
): Sheet[] {
  if (joints.length === 0) return [];
  const faces = faceStatistics(joints, profile, period);
  const sheets: Sheet[] = [];
  const first = joints[0]!;
  const last = joints[joints.length - 1]!;
  const edgeSheet = (
    joint: Joint,
    from: number,
    to: number,
  ): Sheet | undefined => {
    const span = to - from;
    if (
      span < 0.7 * period ||
      !faces.matches((from + to) / 2, bandMean(profile, from, to))
    ) {
      return undefined;
    }
    return {
      at: (from + to) / 2,
      basis: "stack-edge",
      confidence: 0.8 * jointConfidence(joint) * Math.min(1, span / period),
    };
  };

  const leading = edgeSheet(first, Math.max(0, first.at - period), first.at);
  if (leading !== undefined) sheets.push(leading);
  for (let i = 1; i < joints.length; i++) {
    const a = joints[i - 1]!;
    const b = joints[i]!;
    sheets.push({
      at: (a.at + b.at) / 2,
      basis: a.inferred || b.inferred ? "gap-split" : "between-joints",
      confidence: Math.min(jointConfidence(a), jointConfidence(b)),
    });
  }
  const trailing = edgeSheet(
    last,
    last.at,
    Math.min(length - 1, last.at + period),
  );
  if (trailing !== undefined) sheets.push(trailing);
  return sheets;
}

export function isIrregular(joints: readonly Joint[], period: number): boolean {
  let irregular = 0;
  for (let i = 1; i < joints.length; i++) {
    const ratio = (joints[i]!.at - joints[i - 1]!.at) / period;
    if (Math.abs(ratio - Math.round(ratio)) > 0.3) irregular += 1;
  }
  return joints.length > 1 && irregular / (joints.length - 1) > 0.15;
}
