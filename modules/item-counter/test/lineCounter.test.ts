import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LineCounter } from "../src/index.ts";
import type { Detection, LineCountState, Point } from "../src/index.ts";

const LINE = { from: { x: 0, y: 100 }, to: { x: 200, y: 100 } };

function at(center: Point, extra: Partial<Detection> = {}): Detection {
  return {
    box: { x: center.x - 10, y: center.y - 10, width: 20, height: 20 },
    center,
    areaPx: 400,
    ...extra,
  };
}

/** Feeds one list of detections per frame at 30 fps. */
function run(counter: LineCounter, frames: Detection[][]): LineCountState[] {
  return frames.map((detections, f) =>
    counter.update(detections, (f * 1000) / 30),
  );
}

const path = (x: number, ys: number[]): Detection[][] =>
  ys.map((y) => [at({ x, y })]);
const range = (from: number, to: number, step: number): number[] =>
  Array.from(
    { length: Math.floor((to - from) / step) + 1 },
    (_, i) => from + i * step,
  );

describe("LineCounter crossings", () => {
  it("counts an object once when it crosses", () => {
    const states = run(
      new LineCounter({ line: LINE }),
      path(100, range(40, 160, 8)),
    );
    assert.equal(states.at(-1)!.count, 1);
    const events = states.flatMap((s) => s.newEvents);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.direction, "left-to-right");
    assert.equal(events[0]!.intervalMs, undefined);
  });

  it("reports the interval between consecutive items", () => {
    const counter = new LineCounter({ line: LINE });
    const first = path(60, range(40, 160, 10));
    const gap: Detection[][] = Array.from({ length: 10 }, () => []);
    const second = path(140, range(40, 160, 10));
    const states = run(counter, [...first, ...gap, ...second]);
    const events = states.flatMap((s) => s.newEvents);
    assert.equal(events.length, 2);
    assert.ok(Math.abs(events[1]!.intervalMs! - (13 + 10) * (1000 / 30)) < 1);
  });

  it("does not count again when the object jitters on the line", () => {
    const ys = [60, 80, 95, 104, 97, 105, 96, 106, 98, 110, 130];
    assert.equal(
      run(new LineCounter({ line: LINE }), path(100, ys)).at(-1)!.count,
      1,
    );
  });

  it("does not count an object that approaches and backs away", () => {
    const states = run(
      new LineCounter({ line: LINE }),
      path(100, [40, 55, 70, 85, 92, 80, 60]),
    );
    assert.equal(states.at(-1)!.count, 0);
    assert.equal(states[3]!.approaching, 1);
    assert.equal(states.at(-1)!.approaching, 0);
  });

  it("counts only the selected direction", () => {
    const counter = new LineCounter({ line: LINE, direction: "right-to-left" });
    const down = path(50, range(40, 160, 10));
    const up = path(150, range(160, 40, -10));
    const states = run(counter, [
      ...down,
      ...Array.from({ length: 10 }, () => []),
      ...up,
    ]);
    const events = states.flatMap((s) => s.newEvents);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.direction, "right-to-left");
  });

  it("ignores crossings beyond the ends of the line", () => {
    const short = { from: { x: 0, y: 100 }, to: { x: 80, y: 100 } };
    assert.equal(
      run(new LineCounter({ line: short }), path(150, range(40, 160, 8))).at(
        -1,
      )!.count,
      0,
    );
  });
});

describe("LineCounter tracking", () => {
  it("counts side-by-side objects separately", () => {
    const frames = range(40, 160, 8).map((y) => [
      at({ x: 40, y }),
      at({ x: 160, y: y + 4 }),
    ]);
    const states = run(new LineCounter({ line: LINE }), frames);
    const events = states.flatMap((s) => s.newEvents);
    assert.equal(states.at(-1)!.count, 2);
    assert.notEqual(events[0]!.trackId, events[1]!.trackId);
  });

  it("keeps an object through a short occlusion", () => {
    const frames = path(100, range(40, 160, 8));
    for (const f of [7, 8, 9]) frames[f] = [];
    assert.equal(run(new LineCounter({ line: LINE }), frames).at(-1)!.count, 1);
  });

  it("ignores one-frame flashes on the line", () => {
    const frames: Detection[][] = [
      [at({ x: 100, y: 95 })],
      [],
      [at({ x: 30, y: 106 })],
      [],
      [],
    ];
    assert.equal(run(new LineCounter({ line: LINE }), frames).at(-1)!.count, 0);
  });

  it("carries detector labels and scores into the event", () => {
    const frames = range(40, 160, 8).map((y) => [
      at({ x: 100, y }, { label: "saco", score: 0.6 }),
    ]);
    const event = run(new LineCounter({ line: LINE }), frames).flatMap(
      (s) => s.newEvents,
    )[0]!;
    assert.equal(event.label, "saco");
    assert.ok(event.confidence > 0.5 && event.confidence < 1);
  });

  it("resets the count", () => {
    const counter = new LineCounter({ line: LINE });
    run(counter, path(100, range(40, 160, 8)));
    counter.reset();
    assert.equal(counter.update([], 0).count, 0);
  });
});
