/**
 * Phase 27 Wave 3 — the shade × volume variant-matrix builder (pure half).
 *
 * A cosmetics (or accessories) counter thinks of its stock as a grid: every
 * combination of two axes — شید × حجم, رنگ × سایز — is a sellable variant.
 * This computes that grid as plain data (one `variant_child` row per cell)
 * so the service can create them all in one transaction and the names stay
 * deterministic. Two axes only, matching `item_variant_attributes`'s
 * per-item pair shape; a one-axis product simply passes an empty second axis.
 */
import { validateVariantAttributes, type VariantAttributeInput } from "./items";

export interface MatrixAxis {
  name: string;
  values: string[];
}

export interface MatrixCell {
  name: string;
  attributes: VariantAttributeInput[];
}

/** Trimmed, de-duplicated axis values, in input order — empty values dropped. */
function cleanAxis(axis: MatrixAxis): MatrixAxis {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of axis.values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return { name: axis.name.trim(), values };
}

/**
 * The full N×M grid of a variant_parent over two axes. Throws a Persian
 * error when either axis is unnamed or empty, or when the two axes share a
 * name (the unique(item_id, name) constraint would collide).
 */
export function buildVariantMatrix(
  parentName: string,
  axisA: MatrixAxis,
  axisB: MatrixAxis = { name: "", values: [] },
): MatrixCell[] {
  const a = cleanAxis(axisA);
  const b = cleanAxis(axisB);
  const parent = parentName.trim();
  if (!parent) throw new Error("نام خانوادهٔ کالا نمی‌تواند خالی باشد.");
  if (!a.name || a.values.length === 0) {
    throw new Error("محور اول (مثلاً رنگ/سایه) باید نام و حداقل یک مقدار داشته باشد.");
  }
  if (b.name && a.name === b.name) {
    throw new Error("نام دو محور تنوع نمی‌تواند یکسان باشد.");
  }
  // A partially filled second axis is almost always an accidental submission;
  // silently dropping it makes the resulting matrix differ from the preview.
  if ((b.name && b.values.length === 0) || (!b.name && b.values.length > 0)) {
    throw new Error("محور دوم باید هم نام و هم حداقل یک مقدار داشته باشد، یا کاملاً خالی باشد.");
  }
  if (a.values.length * Math.max(1, b.values.length) > 1000) {
    throw new Error("ماتریس نمی‌تواند بیشتر از ۱۰۰۰ تنوع بسازد.");
  }

  const bValues = b.name ? b.values : [null];
  const cells: MatrixCell[] = [];
  for (const aValue of a.values) {
    for (const bValue of bValues) {
      const attributes: VariantAttributeInput[] = bValue
        ? [
            { name: a.name, value: aValue },
            { name: b.name, value: bValue },
          ]
        : [{ name: a.name, value: aValue }];
      const name = [parent, aValue, bValue].filter((v): v is string => Boolean(v)).join(" — ");
      const errors = validateVariantAttributes(attributes);
      if (errors.length > 0) throw new Error(errors.join("؛ "));
      cells.push({ name, attributes });
    }
  }
  return cells;
}
