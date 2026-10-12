import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LineCounter, MotionDetector } from "../src/index.ts";
import type { CrossingEvent } from "../src/index.ts";
import { renderFrame } from "./video.ts";
import type { Clip } from "./video.ts";

/** Runs detector and counter over a clip; returns every crossing. */
function countClip(clip: Clip, frames: number, lineY: number): CrossingEvent[] {
  const detector = new MotionDetector();
  const counter = new LineCounter({
    line: { from: { x: 0, y: lineY }, to: { x: clip.width, y: lineY } },
  });
  const events: CrossingEvent[] = [];
  for (let f = 0; f < frames; f++) {
    const state = counter.update(
      detector.detect(renderFrame(clip, f)),
      (f * 1000) / 30,
    );
    events.push(...state.newEvents);
  }
  return events;
}

const bag = (enterFrame: number, x = 160) => ({
  enterFrame,
  x,
  startY: -45,
  speed: 6,
  rx: 22,
  ry: 42,
});

describe("MotionDetector with LineCounter", () => {
  it("counts bags dropping one after another", () => {
    const clip: Clip = {
      width: 320,
      height: 240,
      bags: [bag(5), bag(30), bag(55), bag(80)],
      noise: 8,
    };
    const events = countClip(clip, 115, 150);
    assert.equal(events.length, 4);
    assert.ok(events.every((e) => e.direction === "left-to-right"));
    assert.ok(
      events
        .slice(1)
        .every((e) => Math.abs(e.intervalMs! - (25 * 1000) / 30) < 70),
    );
  });

  it("counts two bags falling side by side", () => {
    const clip: Clip = {
      width: 320,
      height: 240,
      bags: [bag(5, 90), bag(7, 230)],
      noise: 6,
    };
    assert.equal(countClip(clip, 60, 150).length, 2);
  });

  it("counts nothing in a still scene with sensor noise and flicker", () => {
    const clip: Clip = {
      width: 320,
      height: 240,
      bags: [],
      noise: 12,
      flicker: 6,
    };
    assert.equal(countClip(clip, 60, 150).length, 0);
  });

  it("reports boxes and centers in source pixels", () => {
    const detector = new MotionDetector({ workWidth: 160 });
    const clip: Clip = {
      width: 640,
      height: 360,
      bags: [{ ...bag(0, 320), startY: 180, speed: 0 }],
    };
    detector.detect(renderFrame({ ...clip, bags: [] }, 0));
    const [detection] = detector.detect(renderFrame(clip, 1));
    assert.ok(detection !== undefined);
    assert.ok(Math.abs(detection.center.x - 320) < 6);
    assert.ok(Math.abs(detection.center.y - 180) < 6);
    assert.ok(Math.abs(detection.box.width - 44) < 10);
  });
});
