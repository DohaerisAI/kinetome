/** Minimal RGBA bitmap, structurally compatible with the browser's ImageData. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function srgbToLinear(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Oklab: perceptually uniform, so "nearest palette color" matches what the eye expects. */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export class PaletteMatcher {
  private readonly rgb: [number, number, number][];
  private readonly lab: [number, number, number][];
  private readonly exact = new Set<number>();
  private readonly cache = new Map<number, number>();

  constructor(readonly palette: string[]) {
    this.rgb = palette.map(hexToRgb);
    this.lab = this.rgb.map(([r, g, b]) => rgbToOklab(r, g, b));
    for (const [r, g, b] of this.rgb) this.exact.add((r << 16) | (g << 8) | b);
  }

  has(r: number, g: number, b: number): boolean {
    return this.exact.has((r << 16) | (g << 8) | b);
  }

  nearest(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const [L, A, B] = rgbToOklab(r, g, b);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.lab.length; i++) {
      const [l, a, bb] = this.lab[i];
      const d = (L - l) ** 2 + (A - a) ** 2 + (B - bb) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.cache.set(key, best);
    return best;
  }

  rgbAt(i: number): [number, number, number] {
    return this.rgb[i];
  }
}

/** Counts opaque colors (alpha >= threshold) in the image, keyed by hex. */
export function countColors(img: PixelImage, alphaThreshold = 128): Map<string, number> {
  const counts = new Map<number, number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < alphaThreshold) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [k, n] of counts) out.set(rgbToHex((k >> 16) & 255, (k >> 8) & 255, k & 255), n);
  return out;
}

/** Returns a copy with every opaque pixel mapped to its nearest palette color. */
export function snapToPalette(img: PixelImage, palette: string[]): PixelImage {
  const m = new PaletteMatcher(palette);
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [r, g, b] = m.rgbAt(m.nearest(data[i], data[i + 1], data[i + 2]));
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return { width: img.width, height: img.height, data };
}

/** Pixel art has no partial transparency: alpha becomes 0 or 255. */
export function hardenAlpha(img: PixelImage, threshold = 128): PixelImage {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= threshold ? 255 : 0;
  return { width: img.width, height: img.height, data };
}

/**
 * Integer downscale for sprites drawn at k× pixel density. Each k×k block becomes its most
 * common opaque color (mode pooling), which undoes blurry upscales far better than resampling.
 */
export function downscale(img: PixelImage, k: number): PixelImage {
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
  const data = new Uint8ClampedArray(w * h * 4);
  const counts = new Map<number, number>();
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      counts.clear();
      let opaque = 0;
      for (let y = by * k; y < by * k + k; y++)
        for (let x = bx * k; x < bx * k + k; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i + 3] < 128) continue;
          opaque++;
          const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      if (opaque * 2 < k * k) continue;
      let best = 0, bestN = -1;
      for (const [key, n] of counts) if (n > bestN) { best = key; bestN = n; }
      const o = (by * w + bx) * 4;
      data[o] = (best >> 16) & 255; data[o + 1] = (best >> 8) & 255; data[o + 2] = best & 255; data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Moves hue angle `h` toward `target` by up to `deg` degrees along the shorter arc. */
function shiftHue(h: number, target: number, deg: number): number {
  let d = ((target - h + 540) % 360) - 180;
  d = Math.max(-deg, Math.min(deg, d));
  return (h + d + 360) % 360;
}

export interface Ramp { shadow: string; base: string; light: string }

/**
 * A 3-shade pixel-art ramp from one color, the way pixel artists build them: shadows get
 * darker AND shift toward cool blue-violet, highlights get lighter and shift toward warm
 * yellow, instead of just mixing in black/white (which looks muddy).
 */
export function rampFor(hex: string): Ramp {
  const [r, g, b] = hexToRgb(hex);
  const [L, A, B] = rgbToOklab(r, g, b);
  const C = Math.hypot(A, B);
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  const shift = Math.min(1, C / 0.08) * 14; // greys barely shift
  const make = (l: number, c: number, hue: number) => {
    const rad = (hue * Math.PI) / 180;
    return rgbToHex(...oklabToRgb(Math.max(0.05, Math.min(0.98, l)), Math.cos(rad) * c, Math.sin(rad) * c));
  };
  return {
    shadow: make(L - Math.max(0.1, L * 0.2), C * 1.05, shiftHue(h, 280, shift)),
    base: hex.toLowerCase(),
    light: make(L + Math.max(0.08, (1 - L) * 0.35), C * 0.85, shiftHue(h, 95, shift)),
  };
}
