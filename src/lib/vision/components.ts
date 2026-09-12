/**
 * Connected-component labeling for the visual stock counter.
 *
 * Two-pass labeling with a union-find structure over provisional labels — the
 * textbook algorithm, chosen because it runs in a single linear sweep with
 * near-linear union-find and returns exact per-blob statistics (area, bounding
 * box, centroid) that the counting strategies reason about directly.
 *
 * 8-connectivity (diagonals count as connected) matches how a photographed
 * item's mask behaves: a cup's rim shadow can slice its mask diagonally, and
 * 4-connectivity would then split one cup into two blobs.
 */

import type { Box } from "./image";
import type { BinaryMask } from "./morphology";

export interface BlobInfo {
  label: number;
  area: number;
  box: Box;
  cx: number;
  cy: number;
}

/** Union-find with path compression and union by size. */
class DisjointSets {
  private parent: Int32Array;
  private size: Int32Array;

  constructor(capacity: number) {
    this.parent = new Int32Array(capacity);
    this.size = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.parent[i] = i;
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[i] !== root) {
      const next = this.parent[i];
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) {
      this.parent[ra] = rb;
      this.size[rb] += this.size[ra];
    } else {
      this.parent[rb] = ra;
      this.size[ra] += this.size[rb];
    }
  }
}

/**
 * Labels `mask` and returns blobs with at least `minArea` pixels, sorted by
 * area (largest first). Labels passed by neighbours during the second pass are
 * resolved through the union-find, so a blob straddling a label seam still
 * reports one area and one bounding box.
 */
export function findComponents(
  mask: BinaryMask,
  { width, height }: { width: number; height: number },
  minArea = 1,
): BlobInfo[] {
  const labels = new Int32Array(mask.length); // 0 = background
  const sets = new DisjointSets(width * height + 1);
  let nextLabel = 1;

  // Pass 1: provisional labels; merge with any labelled neighbour.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      const west = x > 0 ? labels[i - 1] : 0;
      const northWest = x > 0 && y > 0 ? labels[i - width - 1] : 0;
      const north = y > 0 ? labels[i - width] : 0;
      const northEast = x < width - 1 && y > 0 ? labels[i - width + 1] : 0;
      const neighbours = [west, northWest, north, northEast].filter((n) => n > 0);
      if (neighbours.length === 0) {
        labels[i] = nextLabel++;
      } else {
        let label = neighbours[0];
        for (const n of neighbours.slice(1)) sets.union(label, n);
        labels[i] = label;
      }
    }
  }

  // Pass 2: resolve roots and accumulate statistics.
  const stats = new Map<number, { area: number; minX: number; minY: number; maxX: number; maxY: number; sumX: number; sumY: number }>();
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      const root = sets.find(labels[i]);
      let s = stats.get(root);
      if (!s) {
        s = { area: 0, minX: x, minY: y, maxX: x, maxY: y, sumX: 0, sumY: 0 };
        stats.set(root, s);
      }
      s.area++;
      if (x < s.minX) s.minX = x;
      if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y;
      if (y > s.maxY) s.maxY = y;
      s.sumX += x;
      s.sumY += y;
    }
  }

  const blobs: BlobInfo[] = [];
  let label = 0;
  for (const [root, s] of stats) {
    if (s.area < minArea) continue;
    blobs.push({
      label: label++,
      area: s.area,
      box: { x: s.minX, y: s.minY, w: s.maxX - s.minX + 1, h: s.maxY - s.minY + 1 },
      cx: s.sumX / s.area,
      cy: s.sumY / s.area,
    });
    void root;
  }
  blobs.sort((a, b) => b.area - a.area);
  return blobs;
}
