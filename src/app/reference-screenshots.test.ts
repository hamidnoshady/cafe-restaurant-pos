/**
 * Keeps `docs/design-system.md` honest about the approved reference screenshots.
 *
 * The six 2026-09-18 screenshots (Orders, POS, Inventory, Menu/file import,
 * Accounting trial balance, Business settings) are the visual authority for
 * every tenant-facing screen, but they were supplied **in conversation only** —
 * they never arrived as files, so nothing in this repo has been pixel-compared
 * against them. `docs/design-system.md` says exactly that in an availability
 * note, and lists the filename each image should be stored under.
 *
 * That is a claim with a shelf life, and the two ways it rots are opposite:
 *
 *  1. Someone adds the PNGs and leaves the note in place — the canon then tells
 *     every future reader the images are missing when they are sitting right
 *     there, and the "not pixel-compared" caveat becomes a lie.
 *  2. Someone deletes the note while the files are still absent — the document
 *     then implies a verification that never happened, which is the specific
 *     failure this whole design effort was told not to commit.
 *
 * So this test asserts the note and the files agree, in both directions, and
 * names the next action either way. It deliberately checks documentation rather
 * than source: the risk here is a false claim in the canon, not a bad class
 * name.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_DIR = join(fileURLToPath(new URL("./", import.meta.url)), "..", "..");
const DESIGN_SYSTEM = join(REPO_DIR, "docs", "design-system.md");
const REFERENCE_DIR = join(REPO_DIR, "docs", "design", "reference");

/** The filenames `docs/design-system.md` tells people to use. */
const EXPECTED_SCREENSHOTS = [
  "orders-queue.png",
  "pos-sell-screen.png",
  "inventory-warehouses.png",
  "settings-menu-import.png",
  "accounting-trial-balance.png",
  "settings-business.png",
];

/** A distinctive phrase from the availability note, not the whole paragraph. */
const AVAILABILITY_NOTE = "in conversation only";

describe("approved reference screenshots", () => {
  const canon = readFileSync(DESIGN_SYSTEM, "utf8");
  const noteIsPresent = canon.includes(AVAILABILITY_NOTE);
  // Only count images at the top level: the archive-2026-09/ subdirectory holds
  // the *superseded* set, and one of its files shares a name with the new one.
  const present = EXPECTED_SCREENSHOTS.filter((name) =>
    existsSync(join(REFERENCE_DIR, name)),
  );

  it("names every expected filename in the canon, so the slots are unambiguous", () => {
    const missing = EXPECTED_SCREENSHOTS.filter((name) => !canon.includes(name));
    expect(
      missing.join(", "),
      [
        "docs/design-system.md no longer lists every expected screenshot filename.",
        "The availability note tells readers to drop the originals in under these",
        "exact names; a name that is not in the table cannot be found.",
        `Missing from the doc: ${missing.join(", ")}`,
      ].join("\n"),
    ).toBe("");
  });

  it("keeps the availability note in step with what is actually on disk", () => {
    if (present.length === 0) {
      expect(
        noteIsPresent,
        [
          "The six approved screenshots are absent from docs/design/reference/,",
          "but the availability note in docs/design-system.md has been removed.",
          "",
          "Without the note the canon implies its rules were pixel-compared against",
          "the approved images. They were not — they were transcribed by reading the",
          "images in conversation. Restore the note, or add the files.",
        ].join("\n"),
      ).toBe(true);
      return;
    }

    expect(
      present.length,
      [
        `${present.length} of ${EXPECTED_SCREENSHOTS.length} approved screenshots are now present:`,
        present.map((name) => `  - ${name}`).join("\n"),
        "",
        "Add the rest, then do the comparison the note defers:",
        "  1. Open each screenshot beside its baseline in docs/design/visual/.",
        "  2. Record the result in docs/design/test-results.md — including any",
        "     deviation you are choosing to accept.",
        "  3. Delete the availability note from docs/design-system.md and this",
        "     assertion, which exists only to stop the note outliving the files.",
      ].join("\n"),
    ).toBe(EXPECTED_SCREENSHOTS.length);
  });
});
