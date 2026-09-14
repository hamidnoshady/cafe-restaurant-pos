/**
 * png.ts — the PNG → grayscale decode between the Chromium screenshot and
 * the ESC/POS raster packer. The one behaviour worth pinning beyond "it
 * decodes" is the alpha compositing: a transparent screenshot background
 * must come out WHITE (255), not black, or every receipt prints as a solid
 * black bar.
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { decodePngToGrayscale } from "./png";

function pngOf(pixels: [r: number, g: number, b: number, a: number][], width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  pixels.forEach(([r, g, b, a], i) => {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = a;
  });
  return PNG.sync.write(png);
}

describe("decodePngToGrayscale", () => {
  it("reports the image's dimensions and one byte per pixel", () => {
    const image = decodePngToGrayscale(pngOf(Array(6).fill([0, 0, 0, 255]), 3, 2));
    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    expect(image.pixels).toHaveLength(6);
  });

  it("maps opaque black to 0 and opaque white to 255", () => {
    const image = decodePngToGrayscale(
      pngOf(
        [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        2,
        1,
      ),
    );
    expect(image.pixels[0]).toBe(0);
    expect(image.pixels[1]).toBe(255);
  });

  it("composites transparency over white — a transparent background prints as paper, not ink", () => {
    const image = decodePngToGrayscale(pngOf([[0, 0, 0, 0]], 1, 1));
    expect(image.pixels[0]).toBe(255);
  });

  it("half-transparent black lands mid-gray (composited, then luminance)", () => {
    const image = decodePngToGrayscale(pngOf([[0, 0, 0, 128]], 1, 1));
    // 0 * (128/255) + 255 * (1 - 128/255) = 127.
    expect(image.pixels[0]).toBeGreaterThan(120);
    expect(image.pixels[0]).toBeLessThan(135);
  });

  it("uses the Rec. 601 luminance weights, so green reads brighter than red or blue", () => {
    const red = decodePngToGrayscale(pngOf([[255, 0, 0, 255]], 1, 1)).pixels[0];
    const green = decodePngToGrayscale(pngOf([[0, 255, 0, 255]], 1, 1)).pixels[0];
    const blue = decodePngToGrayscale(pngOf([[0, 0, 255, 255]], 1, 1)).pixels[0];
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(red).toBe(Math.round(0.299 * 255));
    expect(green).toBe(Math.round(0.587 * 255));
    expect(blue).toBe(Math.round(0.114 * 255));
  });
});
