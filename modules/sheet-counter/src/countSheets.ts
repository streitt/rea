import {
  detectJoints,
  fillGaps,
  isIrregular,
  sheetsBetween,
} from "./joints.ts";
import type { Joint } from "./joints.ts";
import {
  alignedMedianProfile,
  measureStack,
  StackView,
} from "./stackProfile.ts";
import { round } from "./signal.ts";
import type {
  CountError,
  CountOptions,
  CountWarning,
  DetectedJoint,
  Region,
  Result,
  RgbaImage,
  SheetBasis,
  SheetCount,
} from "./types.ts";

const DEFAULT_STRIPS = 12;
const MIN_STRIP_WIDTH = 3;
const MIN_PERIOD = 3;
/** Autocorrelation below this means the region shows no stacked structure. */
const MIN_PERIODICITY = 0.12;
const WEAK_PERIODICITY = 0.3;
const LOW_CONFIDENCE = 0.5;

/**
 * Counts stacked sheets (drywall, plywood, MDF, metal plates, paper) in a
 * photo of the stack edge. The region should frame the stack from its first
 * to its last sheet; each sheet appears as a band separated by a narrow joint.
 */
export function countSheets(
  image: RgbaImage,
  options: CountOptions = {},
): Result<SheetCount, CountError> {
  const imageError = validateImage(image);
  if (imageError !== undefined) return { ok: false, error: imageError };
  const region = options.region ?? {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  };
  const regionError = validateRegion(image, region);
  if (regionError !== undefined) return { ok: false, error: regionError };

  const view = new StackView(
    image,
    region,
    options.orientation ?? "horizontal",
  );
  const stripCount = Math.max(
    1,
    Math.min(
      options.strips ?? DEFAULT_STRIPS,
      Math.floor(view.across / MIN_STRIP_WIDTH),
    ),
  );
  const minPeriod = Math.max(
    MIN_PERIOD,
    options.thicknessPx?.min ?? MIN_PERIOD,
  );
  const maxPeriod = Math.min(
    Math.floor(view.along / 2.5),
    options.thicknessPx?.max ?? Number.POSITIVE_INFINITY,
  );
  if (maxPeriod < minPeriod + 1) {
    return {
      ok: false,
      error: {
        kind: "region-too-small",
        message: `The region spans ${view.along}px along the stack; at least three sheets must be visible.`,
      },
    };
  }

  const { strips, period, skew } = measureStack(view, stripCount, {
    min: minPeriod,
    max: maxPeriod,
  });
  if (period.strength < MIN_PERIODICITY) {
    return {
      ok: false,
      error: {
        kind: "no-periodic-structure",
        message: "No repeating sheet pattern was found in the region.",
      },
    };
  }
  const thickness = period.lag;
  const center = (view.across - 1) / 2;
  const aligned = alignedMedianProfile(strips, skew, center, view.along);
  const { polarity, observed } = detectJoints(
    { strips, aligned, skew, center, thickness },
    options.jointPolarity ?? "auto",
  );
  const joints =
    options.fillGaps === false
      ? observed
      : fillGaps(observed, thickness, aligned);
  const sheets = sheetsBetween(joints, aligned, thickness, view.along);

  const breakdown: Record<SheetBasis, number> = {
    "between-joints": 0,
    "gap-split": 0,
    "stack-edge": 0,
  };
  for (const sheet of sheets) breakdown[sheet.basis] += 1;

  return {
    ok: true,
    value: {
      count: sheets.length,
      breakdown,
      sheets: sheets.map((sheet, i) => ({
        index: i + 1,
        center: view.toImage(sheet.at, center),
        basis: sheet.basis,
        confidence: round(sheet.confidence),
      })),
      joints: joints.map((joint) => jointLine(view, joint, skew, center)),
      thicknessPx: round(thickness),
      skew: round(skew, 4),
      jointPolarity: polarity,
      periodicity: round(period.strength),
      warnings: warningsFor(period.strength, joints, sheets, thickness),
    },
  };
}

function warningsFor(
  periodicity: number,
  joints: readonly Joint[],
  sheets: readonly { confidence: number }[],
  thickness: number,
): CountWarning[] {
  const warnings: CountWarning[] = [];
  if (periodicity < WEAK_PERIODICITY) warnings.push("weak-periodicity");
  if (joints.some((joint) => joint.inferred)) warnings.push("gaps-filled");
  if (sheets.some((sheet) => sheet.confidence < LOW_CONFIDENCE)) {
    warnings.push("low-confidence-sheets");
  }
  if (isIrregular(joints, thickness)) warnings.push("irregular-spacing");
  return warnings;
}

function validateImage(image: RgbaImage): CountError | undefined {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    return {
      kind: "invalid-image",
      message: "Image dimensions must be positive integers.",
    };
  }
  if (image.data.length !== image.width * image.height * 4) {
    return {
      kind: "invalid-image",
      message: `Expected ${image.width * image.height * 4} RGBA bytes, received ${image.data.length}.`,
    };
  }
  return undefined;
}

function validateRegion(
  image: RgbaImage,
  region: Region,
): CountError | undefined {
  const values = [region.x, region.y, region.width, region.height];
  if (
    !values.every(Number.isInteger) ||
    region.width <= 0 ||
    region.height <= 0
  ) {
    return {
      kind: "invalid-region",
      message: "Region coordinates must be integers with positive size.",
    };
  }
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > image.width ||
    region.y + region.height > image.height
  ) {
    return {
      kind: "invalid-region",
      message: "Region extends beyond the image.",
    };
  }
  return undefined;
}

function jointLine(
  view: StackView,
  joint: Joint,
  skew: number,
  center: number,
): DetectedJoint {
  return {
    start: view.toImage(joint.at + skew * (0 - center), 0),
    end: view.toImage(
      joint.at + skew * (view.across - 1 - center),
      view.across - 1,
    ),
    inferred: joint.inferred,
    stripAgreement: round(joint.stripAgreement),
  };
}
