"use client";

import * as React from "react";
import {
  formatPersianNumericText,
  normalizeNumericText,
  type NumericTextOptions,
} from "@/lib/digits";

/**
 * A text input that *looks* like a Persian numeric field while keeping the
 * value handed to React state/API code as plain ASCII. Native `type="number"`
 * controls cannot reliably accept or render Persian digits, nor can they show
 * a thousands separator, so numeric application fields use this text control
 * with a numeric keyboard instead.
 *
 * The visible value is e.g. «۱٬۲۵۰٬۰۰۰٫۵», while `onChange` and `onBlur`
 * receive `"1250000.5"`. Existing form handlers can consequently keep using
 * `Number(event.target.value)` or the money parsing helpers without learning
 * about display-only glyphs and separators.
 */
export interface PersianNumberInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "type" | "value" | "defaultValue" | "onChange" | "onBlur" | "pattern"
  > {
  /** A canonical ASCII numeric value, or a number supplied by an existing controlled field. */
  value?: string | number | readonly string[];
  /** Same as `value`, for an uncontrolled field. */
  defaultValue?: string | number | readonly string[];
  /**
   * Let callers explicitly opt into or out of decimals. When omitted, it is
   * inferred from `inputMode="decimal"` or a fractional `step` value.
   */
  allowDecimal?: boolean;
  /** Opt in for genuinely signed domains (for example a balance adjustment). Defaults to false. */
  allowNegative?: boolean;
  /** Thousand separators are useful for values and prices; turn them off only for compact numeric codes. */
  grouping?: boolean;
  /** Accepted for drop-in migration; the rendered control is always text. */
  type?: React.HTMLInputTypeAttribute;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
}

type NumericValue = PersianNumberInputProps["value"];

function valueAsText(value: NumericValue): string {
  if (Array.isArray(value)) return value.join(",");
  return value == null ? "" : String(value);
}

function decimalStep(step: React.ComponentPropsWithoutRef<"input">["step"]): boolean {
  if (step == null || step === "any") return step === "any";
  const numeric = Number(step);
  return Number.isFinite(numeric) && !Number.isInteger(numeric);
}

function optionsFor({
  allowDecimal,
  allowNegative = false,
  grouping = true,
}: Pick<PersianNumberInputProps, "allowDecimal" | "allowNegative" | "grouping">): NumericTextOptions {
  return { allowDecimal, allowNegative, grouping };
}

/**
 * React handlers conventionally read `event.target.value`. The DOM must retain
 * the formatted Persian text, but application state must retain ASCII, so give
 * the callback a lightweight event view whose target/currentTarget expose the
 * canonical value. All other input/event properties and methods still forward
 * to the original objects.
 */
function eventWithCanonicalValue<E extends React.SyntheticEvent<HTMLInputElement>>(
  event: E,
  canonical: string,
): E {
  const input = event.currentTarget;
  const inputView = new Proxy(input, {
    get(target, property) {
      if (property === "value") return canonical;
      const result = Reflect.get(target, property, target);
      return typeof result === "function" ? result.bind(target) : result;
    },
  });

  return new Proxy(event, {
    get(target, property) {
      if (property === "target" || property === "currentTarget") return inputView;
      const result = Reflect.get(target, property, target);
      return typeof result === "function" ? result.bind(target) : result;
    },
  }) as E;
}

/**
 * Return the displayed-string position immediately after `semanticOffset`
 * canonical characters. Separators are deliberately skipped, so typing and
 * deleting in the middle of a grouped number does not make the caret jump.
 */
function displayCaretOffset(display: string, semanticOffset: number): number {
  if (semanticOffset <= 0) return 0;

  let seen = 0;
  for (let index = 0; index < display.length; index += 1) {
    const char = display[index];
    if (/[۰-۹0-9.-]|٫/.test(char)) seen += 1;
    if (seen >= semanticOffset) return index + 1;
  }
  return display.length;
}

/**
 * A drop-in replacement for numeric raw inputs. It intentionally renders
 * `type="text"`: browser number controls reject localized digits and cannot
 * render grouping punctuation. `inputMode` still opens the numeric keyboard on
 * touch devices.
 */
export const PersianNumberInput = React.forwardRef<HTMLInputElement, PersianNumberInputProps>(
  function PersianNumberInput(
    {
      value,
      defaultValue,
      onChange,
      onBlur,
      allowDecimal: allowDecimalProp,
      allowNegative = false,
      grouping = true,
      inputMode,
      step,
      // Deliberately discarded. See the component docblock: this must be a
      // text control to support Persian digits and thousands grouping. Native
      // pattern validation would inspect the localized DOM value rather than
      // the canonical value exposed to application code.
      type: _type,
      dir = "ltr",
      ...props
    },
    ref,
  ) {
    const allowDecimal = allowDecimalProp ?? (inputMode === "decimal" || decimalStep(step));
    const options = optionsFor({ allowDecimal, allowNegative, grouping });
    // Preserve an attempted sign/fraction in canonical state so domain
    // validation can reject it with useful feedback. Silently turning `-5`
    // into `5` or `12.5` into `12` changes the value the person entered.
    const editingOptions = { ...options, allowDecimal: true, allowNegative: true };
    const keyboard = inputMode ?? (allowDecimal ? "decimal" : "numeric");
    // A spread from JavaScript can bypass the public TypeScript contract. Do
    // not let a canonical-value pattern reach the localized DOM in that case.
    const { pattern: _pattern, ...safeProps } = props as typeof props & { pattern?: string };

    function format(valueToFormat: NumericValue): string {
      return formatPersianNumericText(valueAsText(valueToFormat), editingOptions);
    }

    function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
      const input = event.currentTarget;
      const raw = input.value;
      const selectionStart = input.selectionStart ?? raw.length;
      const selectionEnd = input.selectionEnd ?? selectionStart;
      const canonical = normalizeNumericText(raw, editingOptions);
      const display = formatPersianNumericText(canonical, editingOptions);

      // Count canonical characters before the selection rather than copying a
      // pixel/character offset from the ungrouped text. A new «٬» can appear on
      // every fourth digit.
      const canonicalStart = normalizeNumericText(raw.slice(0, selectionStart), editingOptions).length;
      const canonicalEnd = normalizeNumericText(raw.slice(0, selectionEnd), editingOptions).length;

      if (input.value !== display) {
        input.value = display;
        // `setSelectionRange` is unavailable for a few exotic input types;
        // this component always renders text, but keep the field robust when a
        // browser implementation says otherwise.
        try {
          input.setSelectionRange(
            displayCaretOffset(display, canonicalStart),
            displayCaretOffset(display, canonicalEnd),
          );
        } catch {
          // no-op
        }
      }

      onChange?.(eventWithCanonicalValue(event, canonical));
    }

    function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
      const canonical = normalizeNumericText(event.currentTarget.value, editingOptions);
      onBlur?.(eventWithCanonicalValue(event, canonical));
    }

    return (
      <input
        {...safeProps}
        ref={ref}
        type="text"
        dir={dir}
        inputMode={keyboard}
        step={step}
        value={value === undefined ? undefined : format(value)}
        defaultValue={value === undefined && defaultValue !== undefined ? format(defaultValue) : undefined}
        onChange={handleChange}
        onBlur={handleBlur}
      />
    );
  },
);

PersianNumberInput.displayName = "PersianNumberInput";
