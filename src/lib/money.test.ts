import { describe, expect, it } from "vitest";
import {
  formatRial,
  formatToman,
  parseToRial,
  rialToToman,
  tomanToRial,
} from "./money";

describe("money", () => {
  it("converts between rial and toman", () => {
    expect(rialToToman(1_250_000)).toBe(125_000);
    expect(tomanToRial(125_000)).toBe(1_250_000);
  });

  it("formats integer rial as Toman for display", () => {
    expect(formatToman(1_250_000)).toBe("۱۲۵٬۰۰۰ تومان");
    expect(formatToman(1_250_000, { withUnit: false })).toBe("۱۲۵٬۰۰۰");
    expect(formatToman(0)).toBe("۰ تومان");
  });

  it("formats integer rial as Rial for display", () => {
    expect(formatRial(1_250_000)).toBe("۱٬۲۵۰٬۰۰۰ ریال");
  });

  it("parses user input (Persian digits, separators) to integer rial", () => {
    expect(parseToRial("۱۲۵٬۰۰۰")).toBe(1_250_000); // toman by default
    expect(parseToRial("125000", "toman")).toBe(1_250_000);
    expect(parseToRial("۱٬۲۵۰٬۰۰۰", "rial")).toBe(1_250_000);
    expect(() => parseToRial("abc")).toThrow();
  });
});
