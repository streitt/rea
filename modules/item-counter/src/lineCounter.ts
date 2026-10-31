import type {
  Box,
  CountingLine,
  CrossingDirection,
  CrossingEvent,
  Detection,
  LineCountState,
  Point,
  TrackedObject,
} from "./types.ts";

export interface LineCounterOptions {
  readonly line: CountingLine;
  readonly direction?: CrossingDirection;
  /** Frames an object may go unseen before its track ends. Default 8. */
  readonly maxMissedFrames?: number;
  /** Frames an object must be tracked before a crossing counts. Default 2. */
  readonly minTrackFrames?: number;
  /** Smallest match distance in pixels, for small or slow objects. Default 24. */
  readonly minMatchDistance?: number;
  /** Band around the line, in pixels, where an object keeps its previous side. Default 2. */
  readonly deadZone?: number;
}

interface Track {
  readonly id: number;
  center: Point;
  velocity: Point;
  box: Box;
  seen: number;
  missed: number;
  /** Last definite side of the line: 1 right, -1 left. */
  side: number;
  /** Signed distance to the line at the previous match. */
  distance: number;
  crossed: boolean;
  approaching: boolean;
  readonly areas: number[];
  readonly scores: number[];
  label?: string;
}

const STEADY_TRACK_FRAMES = 8;
const HISTORY = 30;

/**
 * Tracks detections across frames and counts each object once when its
 * center crosses the counting line. Works with any detector.
 */
export class LineCounter {
  #line: CountingLine;
  readonly #direction: CrossingDirection;
  readonly #maxMissed: number;
  readonly #minTrackFrames: number;
  readonly #minMatch: number;
  readonly #deadZone: number;
  #tracks: Track[] = [];
  #nextId = 1;
  #count = 0;
  #lastEvent: CrossingEvent | undefined;

  constructor(options: LineCounterOptions) {
    this.#line = options.line;
    this.#direction = options.direction ?? "either";
    this.#maxMissed = options.maxMissedFrames ?? 8;
    this.#minTrackFrames = options.minTrackFrames ?? 2;
    this.#minMatch = options.minMatchDistance ?? 24;
    this.#deadZone = options.deadZone ?? 2;
  }

  /** Moves the line; tracks keep their identity, sides are re-learned. */
  setLine(line: CountingLine): void {
    this.#line = line;
    for (const track of this.#tracks) {
      track.distance = this.#signedDistance(track.center);
      track.side = Math.sign(track.distance) || track.side;
    }
  }

  /** Zero the count and forget every track. */
  reset(): void {
    this.#tracks = [];
    this.#count = 0;
    this.#lastEvent = undefined;
  }

  update(detections: readonly Detection[], timeMs: number): LineCountState {
    const matches = this.#match(detections);
    const newEvents: CrossingEvent[] = [];
    const matchedTracks = new Set<Track>();
    for (const [track, detection] of matches) {
      matchedTracks.add(track);
      const event = this.#advance(track, detection, timeMs);
      if (event !== undefined) newEvents.push(event);
    }
    for (const track of this.#tracks) {
      if (matchedTracks.has(track)) continue;
      track.missed += 1;
      track.approaching = false;
    }
    this.#tracks = this.#tracks.filter(
      (track) => track.missed <= this.#maxMissed,
    );
    const matchedDetections = new Set(
      matches.map(([, detection]) => detection),
    );
    for (const detection of detections) {
      if (!matchedDetections.has(detection)) this.#start(detection);
    }
    const visible = this.#tracks.filter((track) => track.missed === 0);
    return {
      count: this.#count,
      approaching: visible.filter((track) => track.approaching).length,
      tracks: visible.map((track) => snapshot(track)),
      newEvents,
      ...(this.#lastEvent === undefined ? {} : { lastEvent: this.#lastEvent }),
    };
  }

  /** Greedy nearest-first matching against each track's predicted position. */
  #match(detections: readonly Detection[]): [Track, Detection][] {
    const pairs: { track: Track; detection: Detection; cost: number }[] = [];
    for (const track of this.#tracks) {
      const steps = track.missed + 1;
      const predicted = {
        x: track.center.x + track.velocity.x * steps,
        y: track.center.y + track.velocity.y * steps,
      };
      const gate = Math.max(
        this.#minMatch,
        0.75 * Math.max(track.box.width, track.box.height),
      );
      for (const detection of detections) {
        const cost = Math.hypot(
          detection.center.x - predicted.x,
          detection.center.y - predicted.y,
        );
        if (cost <= gate) pairs.push({ track, detection, cost });
      }
    }
    pairs.sort((p, q) => p.cost - q.cost);
    const usedTracks = new Set<Track>();
    const usedDetections = new Set<Detection>();
    const out: [Track, Detection][] = [];
    for (const pair of pairs) {
      if (usedTracks.has(pair.track) || usedDetections.has(pair.detection))
        continue;
      usedTracks.add(pair.track);
      usedDetections.add(pair.detection);
      out.push([pair.track, pair.detection]);
    }
    return out;
  }

  #start(detection: Detection): void {
    const distance = this.#signedDistance(detection.center);
    this.#tracks.push({
      id: this.#nextId++,
      center: detection.center,
      velocity: { x: 0, y: 0 },
      box: detection.box,
      seen: 1,
      missed: 0,
      side: Math.abs(distance) > this.#deadZone ? Math.sign(distance) : 0,
      distance,
      crossed: false,
      approaching: false,
      areas: [detection.areaPx],
      scores: detection.score === undefined ? [] : [detection.score],
      ...(detection.label === undefined ? {} : { label: detection.label }),
    });
  }

  #advance(
    track: Track,
    detection: Detection,
    timeMs: number,
  ): CrossingEvent | undefined {
    const steps = track.missed + 1;
    const previous = track.center;
    track.velocity = {
      x:
        0.5 * track.velocity.x +
        (0.5 * (detection.center.x - previous.x)) / steps,
      y:
        0.5 * track.velocity.y +
        (0.5 * (detection.center.y - previous.y)) / steps,
    };
    track.center = detection.center;
    track.box = detection.box;
    track.seen += 1;
    track.missed = 0;
    push(track.areas, detection.areaPx);
    if (detection.score !== undefined) push(track.scores, detection.score);
    if (detection.label !== undefined) track.label = detection.label;

    const distance = this.#signedDistance(detection.center);
    track.approaching =
      !track.crossed &&
      Math.abs(distance) < Math.abs(track.distance) &&
      this.#wanted(-Math.sign(distance));
    track.distance = distance;
    if (Math.abs(distance) <= this.#deadZone) return undefined;
    const side = Math.sign(distance);
    const fromSide = track.side;
    track.side = side;
    if (fromSide === 0 || fromSide === side || track.crossed) return undefined;
    if (!this.#withinSegment(previous, detection.center)) return undefined;
    if (!this.#wanted(side) || track.seen < this.#minTrackFrames)
      return undefined;

    track.crossed = true;
    track.approaching = false;
    this.#count += 1;
    const event: CrossingEvent = {
      index: this.#count,
      trackId: track.id,
      timeMs,
      ...(this.#lastEvent === undefined
        ? {}
        : { intervalMs: timeMs - this.#lastEvent.timeMs }),
      direction: side > 0 ? "left-to-right" : "right-to-left",
      box: track.box,
      ...(track.label === undefined ? {} : { label: track.label }),
      confidence: confidence(track),
    };
    this.#lastEvent = event;
    return event;
  }

  /** Whether arriving on `side` (1 right, -1 left) is a counted direction. */
  #wanted(side: number): boolean {
    if (this.#direction === "either") return side !== 0;
    return this.#direction === "left-to-right" ? side > 0 : side < 0;
  }

  /** Positive on the right of the line when walking from `from` to `to`. */
  #signedDistance(point: Point): number {
    const { from, to } = this.#line;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return (dx * (point.y - from.y) - dy * (point.x - from.x)) / length;
  }

  /** The step from `a` to `b` meets the line between its endpoints. */
  #withinSegment(a: Point, b: Point): boolean {
    const da = this.#signedDistance(a);
    const db = this.#signedDistance(b);
    const t = da === db ? 0.5 : da / (da - db);
    const crossing = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const { from, to } = this.#line;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along =
      ((crossing.x - from.x) * dx + (crossing.y - from.y) * dy) /
      (dx * dx + dy * dy || 1);
    return along >= -0.05 && along <= 1.05;
  }
}

function push(values: number[], value: number): void {
  values.push(value);
  if (values.length > HISTORY) values.shift();
}

/** Long, steady tracks and confident detectors make confident counts. */
function confidence(track: Track): number {
  const factors = [Math.min(1, track.seen / STEADY_TRACK_FRAMES)];
  const mean = track.areas.reduce((sum, a) => sum + a, 0) / track.areas.length;
  const sd = Math.sqrt(
    track.areas.reduce((sum, a) => sum + (a - mean) ** 2, 0) /
      track.areas.length,
  );
  factors.push(mean === 0 ? 0 : Math.max(0, 1 - sd / mean));
  if (track.scores.length > 0) {
    factors.push(
      track.scores.reduce((sum, s) => sum + s, 0) / track.scores.length,
    );
  }
  const value = factors.reduce((sum, f) => sum + f, 0) / factors.length;
  return Math.round(value * 100) / 100;
}

function snapshot(track: Track): TrackedObject {
  return {
    id: track.id,
    box: track.box,
    center: track.center,
    seenFrames: track.seen,
    crossed: track.crossed,
    approaching: track.approaching,
    ...(track.label === undefined ? {} : { label: track.label }),
  };
}
