import { useState, useEffect } from "react";
import type { NumericInputMode } from "../types";

function sanitizeNumericDraft(value: string, mode: NumericInputMode) {
  if (mode === "integer") {
    return value.replace(/[^\d]/g, "");
  }
  const stripped = value.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const parts = stripped.split(".");
  if (parts.length <= 1) {
    return stripped;
  }
  return `${parts[0]}.${parts.slice(1).join("")}`;
}

function normalizeNumericValue(value: number, mode: NumericInputMode, min?: number) {
  if (!Number.isFinite(value)) {
    return min ?? 0;
  }
  const clampedValue = Math.max(min ?? 0, value);
  if (mode === "integer") {
    return Math.trunc(clampedValue);
  }
  return Math.round(clampedValue * 100) / 100;
}

function formatNumericDraft(value: number, mode: NumericInputMode) {
  return mode === "decimal" ? `${value}` : `${Math.trunc(value)}`;
}

export function NumericInput(props: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  mode?: NumericInputMode;
  defaultValue?: number;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const mode = props.mode ?? "integer";
  const fallbackValue = props.defaultValue ?? props.min ?? 0;
  const [draftValue, setDraftValue] = useState(() => formatNumericDraft(props.value, mode));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setDraftValue(formatNumericDraft(props.value, mode));
    }
  }, [props.value, mode, isFocused]);

  function commitValue(nextDraft: string) {
    if (!nextDraft || nextDraft === ".") {
      const normalizedFallback = normalizeNumericValue(fallbackValue, mode, props.min);
      setDraftValue(formatNumericDraft(normalizedFallback, mode));
      props.onValueChange(normalizedFallback);
      return;
    }
    const normalizedValue = normalizeNumericValue(Number(nextDraft), mode, props.min);
    setDraftValue(formatNumericDraft(normalizedValue, mode));
    props.onValueChange(normalizedValue);
  }

  return (
    <input
      type="text"
      inputMode={mode === "decimal" ? "decimal" : "numeric"}
      value={draftValue}
      required={props.required}
      disabled={props.disabled}
      className={props.className}
      placeholder={props.placeholder}
      onFocus={() => {
        setIsFocused(true);
        if (draftValue === formatNumericDraft(fallbackValue, mode)) {
          setDraftValue("");
        }
      }}
      onChange={(event) => {
        const sanitizedValue = sanitizeNumericDraft(event.target.value, mode);
        setDraftValue(sanitizedValue);
        if (sanitizedValue && sanitizedValue !== ".") {
          props.onValueChange(normalizeNumericValue(Number(sanitizedValue), mode, props.min));
        }
      }}
      onBlur={() => {
        setIsFocused(false);
        commitValue(draftValue);
      }}
    />
  );
}
