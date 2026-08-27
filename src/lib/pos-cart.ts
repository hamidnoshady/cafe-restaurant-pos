/**
 * Pure cart-line operations for the till.
 *
 * A cart line is *one configuration* of a menu item — a given menu item can sit
 * on several lines, one per distinct add-on/note combination. «دو قهوه، یکی با
 * شکلات و یکی بدون آن» is therefore two lines, each with its own quantity and
 * its own number selector. These helpers are the only place lines are merged,
 * grown or replaced, so the POS screen can't grow a customised line by mistake
 * (the bug where tapping + on a tile silently added another unit *with* an
 * add-on the new unit was not supposed to carry).
 *
 * Everything here is a plain function over the cart array and is unit-tested;
 * the component only wires these into state.
 */

/** The fields two lines must share to count as the same sellable configuration. */
export interface PosCartLineConfig {
  menuItemId: string;
  /** Modifier ids, already sorted — see `cartLineSignature`. */
  modifierIds: string[];
  note: string;
}

export interface PosCartLine extends PosCartLineConfig {
  key: string;
  name: string;
  unitPrice: number;
  quantity: number;
  taxRatePercent: number;
  modifiers: { name: string; priceDelta: number }[];
}

/**
 * An ordered, value-wise comparison of the fields that make a line a distinct
 * configuration. Two lines merge only when they are the same item, carry the
 * same add-ons in the same shape, and share a note — otherwise they stay apart
 * by design (coffee with chocolate vs. coffee without is two lines).
 */
export function sameLineConfig(
  a: PosCartLineConfig,
  b: PosCartLineConfig,
): boolean {
  return (
    a.menuItemId === b.menuItemId &&
    a.note === b.note &&
    a.modifierIds.length === b.modifierIds.length &&
    a.modifierIds.every((id, index) => id === b.modifierIds[index])
  );
}

/**
 * Puts a freshly configured line into the cart: merges into an identical line
 * (same item + add-ons + note) by adding the quantity, otherwise appends it as
 * a new, separate line. Used when the add-on picker confirms — including when
 * it confirms a configuration the cart already holds, so two «coffee without
 * anything» adds become one line of two rather than two one-unit cards.
 */
export function addOrMergeLine(
  lines: readonly PosCartLine[],
  incoming: PosCartLine,
): PosCartLine[] {
  const existingIndex = lines.findIndex((line) =>
    sameLineConfig(line, incoming),
  );
  if (existingIndex === -1) return [...lines, incoming];
  return lines.map((line, index) =>
    index === existingIndex
      ? { ...line, quantity: line.quantity + incoming.quantity }
      : line,
  );
}

/**
 * Replaces a line being edited (`targetKey`), then re-merges: if the edited
 * configuration now matches another line, the two collapse into one with the
 * quantities added; otherwise the edited line keeps its position in the cart.
 * This is what makes «edit this line's add-ons» safe — removing the chocolate
 * from one of two coffees merges it with the plain coffee already in the cart
 * instead of leaving a duplicated card.
 */
export function upsertLine(
  lines: readonly PosCartLine[],
  targetKey: string,
  updated: PosCartLine,
): PosCartLine[] {
  const currentIndex = lines.findIndex((line) => line.key === targetKey);
  if (currentIndex === -1) return addOrMergeLine(lines, updated);

  const remaining = lines.filter((line) => line.key !== targetKey);
  const mergeIndex = remaining.findIndex((line) =>
    sameLineConfig(line, updated),
  );
  if (mergeIndex === -1) {
    // Keep the edited line where it stood; rebuild without reordering.
    const next = [...remaining];
    next.splice(Math.min(currentIndex, next.length), 0, updated);
    return next;
  }
  return remaining.map((line, index) =>
    index === mergeIndex
      ? { ...line, quantity: line.quantity + updated.quantity }
      : line,
  );
}

/**
 * Steps one line's quantity, removing the line when it reaches zero. Returns
 * the cart untouched when the key is unknown, so a double-tap on a line that
 * just disappeared can't crash the till.
 */
export function stepLineQuantity(
  lines: readonly PosCartLine[],
  key: string,
  delta: number,
): PosCartLine[] {
  return lines.flatMap((line) => {
    if (line.key !== key) return [line];
    const nextQuantity = line.quantity + delta;
    return nextQuantity <= 0 ? [] : [{ ...line, quantity: nextQuantity }];
  });
}

/**
 * The − on a product tile undoes the cashier's *last* touch of that product: it
 * steps the most recent line carrying the item, which is the one they just
 * added. Earlier lines — e.g. a differently-customised coffee — are left alone,
 * because the tile cannot show which of them a tap is meant for.
 */
export function stepLastLineForItem(
  lines: readonly PosCartLine[],
  menuItemId: string,
  delta: number,
): PosCartLine[] {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].menuItemId !== menuItemId) continue;
    return stepLineQuantity(lines, lines[index].key, delta);
  }
  return [...lines];
}

/**
 * How many *distinct configurations* of a product the cart currently holds.
 * The tile's + uses it: with 0 or 1 lines the next unit is unambiguous and the
 * tile can add it in place; with 2+ (e.g. one coffee with chocolate, one
 * without) a bare + cannot know which configuration to grow, so it opens the
 * add-on picker instead of guessing.
 */
export function countLinesForItem(
  lines: readonly PosCartLine[],
  menuItemId: string,
): number {
  return lines.reduce(
    (count, line) =>
      line.menuItemId === menuItemId ? count + 1 : count,
    0,
  );
}
