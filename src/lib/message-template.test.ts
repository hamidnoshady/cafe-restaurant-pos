import { describe, expect, it } from "vitest";
import {
  MESSAGE_TEMPLATE_VARIABLES,
  renderMessageTemplate,
  unknownTemplateVariables,
  templateVariableTokens,
} from "./message-template";

describe("unknownTemplateVariables", () => {
  it("accepts a body with no placeholders", () => {
    expect(unknownTemplateVariables("فقط متن")).toEqual([]);
  });

  it("accepts every recognised variable", () => {
    const body = "سلام {{نام}} عزیز، امتیاز شما {{امتیاز}} و اعتبارتان {{اعتبار}} است.";
    expect(unknownTemplateVariables(body)).toEqual([]);
  });

  it("rejects an unknown variable at save time (#374 exit #4)", () => {
    expect(unknownTemplateVariables("سلام {{نام}} {{حساب_بانکی}}")).toEqual(["حساب_بانکی"]);
    expect(unknownTemplateVariables("{{foo}} و {{نام}}")).toEqual(["foo"]);
  });

  it("treats the closed set as exhaustive", () => {
    const names = templateVariableTokens(
      MESSAGE_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(" "),
    );
    expect(names.sort()).toEqual([...MESSAGE_TEMPLATE_VARIABLES].sort());
  });
});

describe("renderMessageTemplate", () => {
  it("substitutes known variables", () => {
    const out = renderMessageTemplate("سلام {{نام}}، فروشگاه {{نام_فروشگاه}}", {
      نام: "سارا",
      نام_فروشگاه: "کافه مرکزی",
    });
    expect(out).toBe("سلام سارا، فروشگاه کافه مرکزی");
  });

  it("tolerates padding whitespace inside braces", () => {
    expect(renderMessageTemplate("{{  نام  }}", { نام: "سارا" })).toBe("سارا");
  });

  it("leaves an unrecognised placeholder untouched (validation is the gate)", () => {
    expect(renderMessageTemplate("{{نام}} {{ناشناخته}}", { نام: "سارا" })).toBe(
      "سارا {{ناشناخته}}",
    );
  });

  it("renders Persian-digit money values exactly as provided", () => {
    // The caller formats with formatToman; substitution must be byte-identical.
    const out = renderMessageTemplate("اعتبار شما {{اعتبار}} تومان است", {
      اعتبار: "۲۳٬۴۵۰",
    });
    expect(out).toBe("اعتبار شما ۲۳٬۴۵۰ تومان است");
  });
});
