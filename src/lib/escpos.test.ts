import { describe, expect, it } from "vitest";
import {
  buildDrawerKickJob,
  buildPrintJob,
  cutPaper,
  GS,
  initPrinter,
  lineFeed,
  openDrawerPin,
  packMonochromeRaster,
  rasterImageCommands,
} from "./escpos";

describe("initPrinter / lineFeed / cutPaper", () => {
  it("emits the documented control bytes", () => {
    expect(initPrinter()).toEqual(Buffer.from([0x1b, 0x40]));
    expect(lineFeed(3)).toEqual(Buffer.from([0x1b, 0x64, 3]));
    expect(lineFeed(500)).toEqual(Buffer.from([0x1b, 0x64, 255])); // clamped
    expect(cutPaper(true)).toEqual(Buffer.from([0x1d, 0x56, 0x01]));
    expect(cutPaper(false)).toEqual(Buffer.from([0x1d, 0x56, 0x00]));
  });
});

describe("openDrawerPin", () => {
  it("converts ms to 2ms units and clamps to a byte", () => {
    expect(openDrawerPin(0, 20, 200)).toEqual(Buffer.from([0x1b, 0x70, 0, 10, 100]));
    expect(openDrawerPin(1, 1000, 1000)).toEqual(Buffer.from([0x1b, 0x70, 1, 255, 255]));
  });
});

describe("packMonochromeRaster", () => {
  it("packs a 1x1 black pixel as the top bit set, padded to a byte", () => {
    const raster = packMonochromeRaster(Uint8Array.from([0]), 1, 1);
    expect(raster).toEqual({ widthBytes: 1, heightPx: 1, data: Uint8Array.from([0b1000_0000]) });
  });

  it("packs a known 8x1 checkerboard row", () => {
    // black, white, black, white, black, white, black, white
    const pixels = Uint8Array.from([0, 255, 0, 255, 0, 255, 0, 255]);
    const raster = packMonochromeRaster(pixels, 8, 1);
    expect(raster.data).toEqual(Uint8Array.from([0b1010_1010]));
  });

  it("thresholds mid-gray pixels", () => {
    const raster = packMonochromeRaster(Uint8Array.from([100, 200]), 2, 1, 128);
    // first pixel < 128 -> black (bit set), second >= 128 -> white
    expect(raster.data).toEqual(Uint8Array.from([0b1000_0000]));
  });

  it("pads width up to a multiple of 8 without touching the padding bits", () => {
    const pixels = Uint8Array.from([0, 0, 0]); // 3 black pixels
    const raster = packMonochromeRaster(pixels, 3, 1);
    expect(raster.widthBytes).toBe(1);
    expect(raster.data).toEqual(Uint8Array.from([0b1110_0000]));
  });

  it("stacks multiple rows contiguously", () => {
    const pixels = Uint8Array.from([0, 255, 255, 0]); // row0: black,white; row1: white,black
    const raster = packMonochromeRaster(pixels, 2, 2);
    expect(raster.heightPx).toBe(2);
    expect(raster.data).toEqual(Uint8Array.from([0b1000_0000, 0b0100_0000]));
  });
});

describe("rasterImageCommands", () => {
  it("emits a single GS v 0 header + data for a small image", () => {
    const raster = packMonochromeRaster(Uint8Array.from([0]), 1, 1);
    const [chunk] = rasterImageCommands(raster);
    expect(chunk.subarray(0, 8)).toEqual(Buffer.from([GS, 0x76, 0x30, 0x00, 1, 0, 1, 0]));
    expect(chunk.subarray(8)).toEqual(Buffer.from(raster.data));
  });

  it("splits tall images into multiple chunks respecting maxChunkRows", () => {
    const raster = { widthBytes: 1, heightPx: 10, data: new Uint8Array(10).fill(0xff) };
    const chunks = rasterImageCommands(raster, 4);
    expect(chunks).toHaveLength(3); // 4 + 4 + 2 rows
    expect(chunks[0].subarray(6, 8)).toEqual(Buffer.from([4, 0])); // yL/yH = 4
    expect(chunks[0]).toHaveLength(8 + 4);
    expect(chunks[2].subarray(6, 8)).toEqual(Buffer.from([2, 0]));
    expect(chunks[2]).toHaveLength(8 + 2);
  });
});

describe("buildPrintJob", () => {
  it("concatenates init, raster, feed, and cut by default", () => {
    const raster = packMonochromeRaster(Uint8Array.from([0]), 1, 1);
    const job = buildPrintJob(raster);
    const [rasterChunk] = rasterImageCommands(raster);
    const expected = Buffer.concat([initPrinter(), rasterChunk, lineFeed(3), cutPaper(true)]);
    expect(job).toEqual(expected);
  });

  it("prepends a drawer kick and skips the cut when asked", () => {
    const raster = packMonochromeRaster(Uint8Array.from([0]), 1, 1);
    const job = buildPrintJob(raster, { kickDrawer: true, cut: false, feedLines: 1 });
    const [rasterChunk] = rasterImageCommands(raster);
    const expected = Buffer.concat([initPrinter(), openDrawerPin(), rasterChunk, lineFeed(1)]);
    expect(job).toEqual(expected);
  });
});

describe("buildDrawerKickJob", () => {
  it("is init + open-drawer only", () => {
    expect(buildDrawerKickJob()).toEqual(Buffer.concat([initPrinter(), openDrawerPin(0)]));
  });
});
