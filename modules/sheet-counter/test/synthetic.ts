import type { Region, RgbaImage } from "../src/types.ts";

export interface StackScene {
  readonly sheets: number;
  readonly thickness: number;
  readonly width?: number;
  /** Background rows above and below the stack. */
  readonly margin?: number;
  readonly jointWidth?: number;
  /** Joint luminance relative to the sheet face; negative is darker. */
  readonly jointContrast?: number;
  readonly noise?: number;
  /** Vertical joint displacement per horizontal pixel. */
  readonly skew?: number;
  /** Fraction of the width covered by an occluder on the right (a hand). */
  readonly occludedFraction?: number;
  /** 1-based joints (below sheet n) that are invisible. */
  readonly hiddenJoints?: readonly number[];
  /** Linear lighting change from top to bottom, in luminance units. */
  readonly lightingGradient?: number;
  readonly seed?: number;
}

export interface RenderedScene {
  readonly image: RgbaImage;
  /** Region framing the stack tightly at the center column. */
  readonly stack: Region;
}

/** Renders a side view of stacked sheets with deterministic noise. */
export function renderStack(scene: StackScene): RenderedScene {
  const width = scene.width ?? 320;
  const margin = scene.margin ?? 20;
  const skew = scene.skew ?? 0;
  const skewRange = Math.ceil(Math.abs(skew) * width);
  const stackHeight = Math.round(scene.sheets * scene.thickness);
  const top = margin + skewRange;
  const height = stackHeight + 2 * margin + 2 * skewRange;
  const jointWidth = scene.jointWidth ?? 2;
  const jointContrast = scene.jointContrast ?? -70;
  const hidden = new Set(scene.hiddenJoints ?? []);
  const random = mulberry32(scene.seed ?? 1);
  const faces = Array.from(
    { length: scene.sheets },
    () => 165 + (random() - 0.5) * 24,
  );
  const occludedFrom = Math.round(width * (1 - (scene.occludedFraction ?? 0)));

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shifted = y - top - skew * (x - width / 2);
      let value: number;
      if (x >= occludedFrom) {
        value = 200 + 10 * Math.sin(x / 7 + y / 11);
      } else if (shifted < 0 || shifted >= stackHeight) {
        value = 55 + 15 * Math.sin(x / 13);
      } else {
        const sheet = Math.min(
          scene.sheets - 1,
          Math.floor(shifted / scene.thickness),
        );
        const within = shifted - sheet * scene.thickness;
        value = faces[sheet]! + 6 * Math.sin(x / 5 + sheet);
        const isJoint =
          within >= scene.thickness - jointWidth &&
          sheet < scene.sheets - 1 &&
          !hidden.has(sheet + 1);
        if (isJoint) value += jointContrast;
        value += ((scene.lightingGradient ?? 0) * y) / height;
      }
      value += (random() - 0.5) * 2 * (scene.noise ?? 0);
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value * 0.98;
      data[offset + 2] = value * 0.93;
      data[offset + 3] = 255;
    }
  }
  return {
    image: { width, height, data },
    stack: { x: 0, y: top, width, height: stackHeight },
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
