import { describe, expect, it } from "vitest";
import {
  validateInputRequest,
  validateInputResponse,
  formatInputResponseForModel,
  type InputRequestSpec,
} from "./ai-input-protocol";

describe("validateInputRequest — spec validation", () => {
  it("accepts a well-formed choice request", () => {
    const result = validateInputRequest({
      kind: "choice",
      prompt: "کدام تأمین‌کننده؟",
      options: [
        { id: "s1", label: "قهوهٔ آرام" },
        { id: "s2", label: "لبنیات پاک" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.kind).toBe("choice");
      expect(result.spec.options).toHaveLength(2);
    }
  });

  it("rejects an unknown kind outright", () => {
    const result = validateInputRequest({ kind: "slider", prompt: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("invalid_kind");
  });

  it("rejects a choice request with no options", () => {
    const result = validateInputRequest({ kind: "choice", prompt: "x", options: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("choice_options_required");
  });

  it("rejects duplicate option ids", () => {
    const result = validateInputRequest({
      kind: "choice",
      prompt: "x",
      options: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("choice_duplicate_option");
  });

  it("requires a prompt", () => {
    const result = validateInputRequest({ kind: "choice", prompt: "  ", options: [{ id: "a", label: "A" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("prompt_required");
  });

  it("accepts a form with typed fields and rejects one with none", () => {
    const good = validateInputRequest({
      kind: "form",
      prompt: "جزئیات هزینه",
      fields: [
        { key: "amount", label: "مبلغ", type: "number", required: true },
        { key: "date", label: "تاریخ", type: "date", required: false },
      ],
    });
    expect(good.ok).toBe(true);

    const bad = validateInputRequest({ kind: "form", prompt: "x", fields: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("fields_required");
  });

  it("rejects an invalid field type and a duplicate key", () => {
    const badType = validateInputRequest({
      kind: "form",
      prompt: "x",
      fields: [{ key: "a", label: "A", type: "email", required: false }],
    });
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.errors).toContain("invalid_field_type");

    const dup = validateInputRequest({
      kind: "form",
      prompt: "x",
      fields: [
        { key: "a", label: "A", type: "text", required: false },
        { key: "a", label: "B", type: "text", required: false },
      ],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors).toContain("duplicate_field_key");
  });
});

describe("validateInputResponse — the answer must fit the spec", () => {
  const choice: InputRequestSpec = {
    kind: "choice",
    prompt: "کدام؟",
    options: [
      { id: "s1", label: "یک" },
      { id: "s2", label: "دو" },
    ],
  };

  it("accepts a listed choice and rejects an unlisted one", () => {
    expect(validateInputResponse(choice, { choice: "s1" })).toEqual({ ok: true, response: { choice: "s1" } });
    const bad = validateInputResponse(choice, { choice: "s9" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("invalid_choice");
  });

  it("requires a choice when none is given", () => {
    const result = validateInputResponse(choice, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("choice_required");
  });

  it("accepts free text only when the spec allows 'other'", () => {
    const withOther: InputRequestSpec = { ...choice, allowOther: true };
    const ok = validateInputResponse(withOther, { other: "گزینهٔ تازه" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.response).toEqual({ choice: null, other: "گزینهٔ تازه" });

    // Without allowOther, free text is refused.
    const refused = validateInputResponse(choice, { other: "x" });
    expect(refused.ok).toBe(false);
  });

  it("multi_choice keeps only listed, de-duplicated ids", () => {
    const multi: InputRequestSpec = { ...choice, kind: "multi_choice" };
    const result = validateInputResponse(multi, { choices: ["s1", "s1", "s2", "s9"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("invalid_choice");

    const clean = validateInputResponse(multi, { choices: ["s1", "s1", "s2"] });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.response.choices).toEqual(["s1", "s2"]);
  });

  it("form coerces typed values and enforces required + type", () => {
    const form: InputRequestSpec = {
      kind: "form",
      prompt: "x",
      fields: [
        { key: "amount", label: "مبلغ", type: "number", required: true },
        { key: "when", label: "تاریخ", type: "date", required: false },
        { key: "ok", label: "تأیید", type: "boolean", required: false },
      ],
    };
    const good = validateInputResponse(form, { values: { amount: "150000", when: "2026-03-18", ok: "true" } });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.response.values).toEqual({ amount: 150000, when: "2026-03-18", ok: true });

    const missing = validateInputResponse(form, { values: { when: "2026-03-18" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors).toContain("amount:required");

    const badDate = validateInputResponse(form, { values: { amount: 1, when: "18/03/2026" } });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.errors).toContain("when:invalid_date");

    const badNum = validateInputResponse(form, { values: { amount: "abc" } });
    expect(badNum.ok).toBe(false);
    if (!badNum.ok) expect(badNum.errors).toContain("amount:invalid_number");
  });

  it("form select rejects a value outside its own options", () => {
    const form: InputRequestSpec = {
      kind: "form",
      prompt: "x",
      fields: [
        {
          key: "cat",
          label: "دسته",
          type: "select",
          required: true,
          options: [{ id: "food", label: "خوراک" }],
        },
      ],
    };
    expect(validateInputResponse(form, { values: { cat: "food" } }).ok).toBe(true);
    const bad = validateInputResponse(form, { values: { cat: "rent" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("cat:invalid_option");
  });
});

describe("formatInputResponseForModel — labels, not ids, go back", () => {
  it("renders the chosen option's label", () => {
    const spec: InputRequestSpec = {
      kind: "choice",
      prompt: "کدام تأمین‌کننده؟",
      options: [{ id: "s1", label: "قهوهٔ آرام" }],
    };
    const text = formatInputResponseForModel(spec, { choice: "s1" });
    expect(text).toContain("قهوهٔ آرام");
    expect(text).not.toContain("s1");
  });

  it("renders form fields with human labels and boolean words", () => {
    const spec: InputRequestSpec = {
      kind: "form",
      prompt: "جزئیات",
      fields: [
        { key: "amount", label: "مبلغ", type: "number", required: true },
        { key: "ok", label: "تأیید", type: "boolean", required: false },
      ],
    };
    const text = formatInputResponseForModel(spec, { values: { amount: 150000, ok: true } });
    expect(text).toContain("مبلغ: 150000");
    expect(text).toContain("تأیید: بله");
  });
});
