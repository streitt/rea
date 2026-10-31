/** RGBA pixels in row-major order, compatible with the browser `ImageData`. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** Axis-aligned pixel rectangle inside the image. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Direction of the joints between sheets as seen in the photo.
 * `horizontal`: sheets are stacked top-to-bottom (the usual pallet photo).
 * `vertical`: sheets stand side by side (joints run top-to-bottom).
 */
export type JointOrientation = "horizontal" | "vertical";

/**
 * Whether the narrow joint between two sheets is darker or lighter than the
 * sheet edge. `auto` decides from the profile asymmetry.
 */
export type JointPolarity = "auto" | "dark" | "bright";

export interface CountOptions {
  /** Area that frames the stack edge. Defaults to the full image. */
  readonly region?: Region;
  readonly orientation?: JointOrientation;
  readonly jointPolarity?: JointPolarity;
  /** Bounds for one sheet's thickness in pixels, when the caller knows them. */
  readonly thicknessPx?: { readonly min?: number; readonly max?: number };
  /** Number of independent strips across the stack. Default 12. */
  readonly strips?: number;
  /** Infer joints hidden inside intervals of 2+ sheet thicknesses. Default true. */
  readonly fillGaps?: boolean;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * How a sheet was established:
 * - `between-joints`: bounded by two observed joints.
 * - `gap-split`: bounded by at least one joint inferred from a regular gap.
 * - `stack-edge`: first or last sheet, bounded by one joint and the region edge.
 */
export type SheetBasis = "between-joints" | "gap-split" | "stack-edge";

export interface DetectedSheet {
  /** 1-based position along the stack (top-to-bottom or left-to-right). */
  readonly index: number;
  /** Marker position in image coordinates. */
  readonly center: Point;
  readonly basis: SheetBasis;
  /** 0..1, from joint prominence and agreement across independent strips. */
  readonly confidence: number;
}

export interface DetectedJoint {
  /** Joint line in image coordinates, spanning the region. */
  readonly start: Point;
  readonly end: Point;
  readonly inferred: boolean;
  /** Fraction of strips where the joint is independently visible. */
  readonly stripAgreement: number;
}

export type CountWarning =
  | "weak-periodicity"
  | "gaps-filled"
  | "low-confidence-sheets"
  | "irregular-spacing";

export interface SheetCount {
  readonly count: number;
  readonly breakdown: Readonly<Record<SheetBasis, number>>;
  readonly sheets: readonly DetectedSheet[];
  readonly joints: readonly DetectedJoint[];
  /** Estimated sheet thickness in pixels along the stack axis. */
  readonly thicknessPx: number;
  /** Joint slope across the region (pixels along per pixel across). */
  readonly skew: number;
  readonly jointPolarity: "dark" | "bright";
  /** Normalized autocorrelation at the sheet period, 0..1. */
  readonly periodicity: number;
  readonly warnings: readonly CountWarning[];
}

export type CountError =
  | { readonly kind: "invalid-image"; readonly message: string }
  | { readonly kind: "invalid-region"; readonly message: string }
  | { readonly kind: "region-too-small"; readonly message: string }
  | { readonly kind: "no-periodic-structure"; readonly message: string };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
