import { useEffect, useMemo, useState } from "react";
import type { SellableInventoryOption } from "../types";
import { currency } from "../utils";

function normalizeSearchText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function getOptionSearchText(option: SellableInventoryOption) {
  return normalizeSearchText(
    [
      option.name,
      option.sourceName,
      option.category,
      option.barcode ?? "",
      option.sourceBarcode ?? ""
    ].join(" ")
  );
}

export function SellableInventoryPicker(props: {
  options: SellableInventoryOption[];
  value: string;
  onChange: (optionId: string) => void;
  getOptionDetail: (option: SellableInventoryOption) => string;
  isOptionDisabled?: (option: SellableInventoryOption) => boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const selectedOption = props.options.find((option) => option.id === props.value) ?? null;
  const [query, setQuery] = useState(() => selectedOption?.name ?? "");
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setQuery(selectedOption?.name ?? "");
    }
  }, [isOpen, selectedOption?.name]);

  const normalizedQuery = normalizeSearchText(query);
  const visibleOptions = useMemo(() => {
    if (!normalizedQuery) {
      return props.options.slice(0, 12);
    }
    return props.options
      .filter((option) => getOptionSearchText(option).includes(normalizedQuery))
      .slice(0, 20);
  }, [props.options, normalizedQuery]);

  const firstEnabledOption = visibleOptions.find((option) => !props.isOptionDisabled?.(option));

  return (
    <div className="sellable-picker">
      <input
        type="text"
        value={query}
        placeholder={props.placeholder ?? "Search items..."}
        disabled={props.disabled}
        aria-label="Search inventory item"
        aria-expanded={isOpen}
        onFocus={() => setIsOpen(true)}
        onBlur={() => window.setTimeout(() => setIsOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
          if (!event.target.value.trim() && props.value) {
            props.onChange("");
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setIsOpen(false);
            setQuery(selectedOption?.name ?? "");
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (firstEnabledOption) {
              props.onChange(firstEnabledOption.id);
              setQuery(firstEnabledOption.name);
              setIsOpen(false);
            }
          }
        }}
      />
      {isOpen && !props.disabled && (
        <div className="sellable-picker-list">
          {visibleOptions.length === 0 && <div className="sellable-picker-empty">No matching items.</div>}
          {visibleOptions.map((option) => {
            const disabled = Boolean(props.isOptionDisabled?.(option));
            const detail = props.getOptionDetail(option);
            return (
              <button
                key={option.id}
                className={`sellable-picker-option${props.value === option.id ? " is-selected" : ""}`}
                type="button"
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  props.onChange(option.id);
                  setQuery(option.name);
                  setIsOpen(false);
                }}
              >
                <span>
                  <strong>{option.name}</strong>
                  {!option.isBaseItem && <em>from {option.sourceName}</em>}
                </span>
                <span>{option.category} - {currency(option.price)}</span>
                <span className={disabled ? "warning-text" : "muted"}>{detail}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
