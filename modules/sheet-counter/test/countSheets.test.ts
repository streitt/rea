import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countSheets } from "../src/index.ts";
import type { CountOptions, SheetCount } from "../src/index.ts";
import { renderStack } from "./synthetic.ts";
import type { StackScene } from "./synthetic.ts";

function count(scene: StackScene, options: CountOptions = {}): SheetCount {
  const { image, stack } = renderStack(scene);
  const result = countSheets(image, { region: stack, ...options });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  return result.value;
}

describe("countSheets on stacked sheets", () => {
  it("counts a clean stack framed tightly", () => {
    const result = count({ sheets: 20, thickness: 14 });
    assert.equal(result.count, 20);
    assert.equal(result.breakdown["between-joints"], 18);
    assert.equal(result.breakdown["stack-edge"], 2);
    assert.ok(Math.abs(result.thicknessPx - 14) < 0.5);
    assert.equal(result.jointPolarity, "dark");
    assert.deepEqual(result.warnings, []);
  });

  it("counts a 60-sheet pallet with noise, skew and uneven lighting", () => {
    const result = count({
      sheets: 60,
      thickness: 9,
      noise: 14,
      skew: 0.04,
      lightingGradient: -50,
      seed: 7,
    });
    assert.equal(result.count, 60);
    assert.ok(Math.abs(result.skew - 0.04) < 0.01, `skew ${result.skew}`);
  });

  it("ignores a hand covering part of the stack", () => {
    const result = count({
      sheets: 40,
      thickness: 11,
      noise: 8,
      occludedFraction: 0.3,
    });
    assert.equal(result.count, 40);
  });
});

describe("countSheets inference and framing", () => {
  it("infers a hidden joint and reports it as inference", () => {
    const result = count({
      sheets: 25,
      thickness: 12,
      noise: 5,
      hiddenJoints: [9],
    });
    assert.equal(result.count, 25);
    assert.equal(result.breakdown["gap-split"], 2);
    assert.ok(result.warnings.includes("gaps-filled"));
    assert.equal(result.joints.filter((joint) => joint.inferred).length, 1);
  });

  it("keeps hidden joints unresolved when gap filling is disabled", () => {
    const result = count(
      { sheets: 25, thickness: 12, hiddenJoints: [9] },
      { fillGaps: false },
    );
    assert.equal(result.count, 24);
  });

  it("does not count background in a loosely framed region", () => {
    const { image, stack } = renderStack({
      sheets: 30,
      thickness: 10,
      margin: 40,
      noise: 6,
    });
    const loose = { ...stack, y: stack.y - 25, height: stack.height + 50 };
    const result = countSheets(image, { region: loose });
    assert.ok(result.ok);
    assert.equal(result.value.count, 30);
  });

  it("detects bright joints", () => {
    const result = count({
      sheets: 18,
      thickness: 13,
      jointContrast: 60,
      noise: 4,
    });
    assert.equal(result.jointPolarity, "bright");
    assert.equal(result.count, 18);
  });

  it("counts sheets standing side by side", () => {
    const { image, stack } = renderStack({
      sheets: 22,
      thickness: 12,
      noise: 5,
    });
    const rotated = transpose(image);
    const result = countSheets(rotated, {
      orientation: "vertical",
      region: {
        x: stack.y,
        y: stack.x,
        width: stack.height,
        height: stack.width,
      },
    });
    assert.ok(result.ok);
    assert.equal(result.value.count, 22);
  });

  it("places markers inside the stack in order", () => {
    const { image, stack } = renderStack({ sheets: 10, thickness: 16 });
    const result = countSheets(image, { region: stack });
    assert.ok(result.ok);
    const ys = result.value.sheets.map((sheet) => sheet.center.y);
    assert.deepEqual(
      ys,
      [...ys].sort((a, b) => a - b),
    );
    for (const [i, y] of ys.entries()) {
      assert.ok(
        Math.abs(y - (stack.y + (i + 0.5) * 16)) < 4,
        `sheet ${i + 1} at ${y}`,
      );
    }
  });
});

describe("countSheets input validation", () => {
  it("rejects a region without a repeating pattern", () => {
    const width = 100;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4).fill(128);
    const result = countSheets({ width, height, data });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.kind, "no-periodic-structure");
  });

  it("rejects malformed inputs", () => {
    const image = { width: 10, height: 10, data: new Uint8ClampedArray(12) };
    const bad = countSheets(image);
    assert.equal(bad.ok ? "" : bad.error.kind, "invalid-image");
    const { image: valid } = renderStack({ sheets: 5, thickness: 10 });
    const outside = countSheets(valid, {
      region: { x: 0, y: 0, width: valid.width + 1, height: 10 },
    });
    assert.equal(outside.ok ? "" : outside.error.kind, "invalid-region");
    const tiny = countSheets(valid, {
      region: { x: 0, y: 0, width: 50, height: 6 },
    });
    assert.equal(tiny.ok ? "" : tiny.error.kind, "region-too-small");
  });
});

function transpose(image: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}) {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      const to = (x * image.height + y) * 4;
      for (let c = 0; c < 4; c++) data[to + c] = image.data[from + c]!;
    }
  }
  return { width: image.height, height: image.width, data };
}
