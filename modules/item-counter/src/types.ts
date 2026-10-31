/** RGBA pixels in row-major order, compatible with the browser `ImageData`. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle in image pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One object seen in one frame. Any detector can produce these: the built-in
 * motion detector, or a trained model that also fills `label` and `score`.
 */
export interface Detection {
  readonly box: Box;
  readonly center: Point;
  readonly areaPx: number;
  /** Detector confidence 0..1, when the detector provides one. */
  readonly score?: number;
  /** Class name, when the detector classifies (e.g. "saco"). */
  readonly label?: string;
}

/**
 * Which crossings count. Walking from `line.from` to `line.to`, `left-to-right`
 * counts objects moving from the left side of the line to its right side.
 */
export type CrossingDirection = "either" | "left-to-right" | "right-to-left";

export interface CountingLine {
  readonly from: Point;
  readonly to: Point;
}

export interface TrackedObject {
  readonly id: number;
  readonly box: Box;
  readonly center: Point;
  /** Frames in which the object was matched. */
  readonly seenFrames: number;
  readonly crossed: boolean;
  /** Not yet crossed and moving toward the line. */
  readonly approaching: boolean;
  readonly label?: string;
}

export interface CrossingEvent {
  /** 1-based running count at the time of this crossing. */
  readonly index: number;
  readonly trackId: number;
  readonly timeMs: number;
  /** Time since the previous counted crossing; undefined for the first. */
  readonly intervalMs?: number;
  readonly direction: "left-to-right" | "right-to-left";
  readonly box: Box;
  readonly label?: string;
  /**
   * 0..1 from how long the object was tracked, how steady its size was and,
   * when present, the detector's own scores.
   */
  readonly confidence: number;
}

export interface LineCountState {
  readonly count: number;
  readonly approaching: number;
  readonly tracks: readonly TrackedObject[];
  /** Crossings counted by this update, oldest first. */
  readonly newEvents: readonly CrossingEvent[];
  readonly lastEvent?: CrossingEvent;
}
