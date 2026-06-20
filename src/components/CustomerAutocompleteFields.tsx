import { useState } from "react";
import type { Customer } from "../types";

export interface CustomerAutocompleteSuggestionProps {
  suggestionCustomers?: Customer[];
  suggestionQuery?: string;
  suggestionsLoading?: boolean;
  onSuggestionQueryChange?: (query: string) => void;
}

export function CustomerAutocompleteFields(props: {
  customers: Customer[];
  customerId?: string;
  customerName: string;
  customerPhone: string;
  onChange: (next: { customerId?: string; customerName: string; customerPhone: string }) => void;
  required?: boolean;
  disabled?: boolean;
  namePlaceholder?: string;
  phonePlaceholder?: string;
  nameFieldClassName?: string;
  phoneFieldClassName?: string;
} & CustomerAutocompleteSuggestionProps) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const normalizedQuery = props.customerName.trim().replace(/\s+/g, " ").toLowerCase();
  const normalizedPhoneQuery = (props.customerName.match(/[\d+]+/g)?.join("") ?? "").replace(/(?!^)\+/g, "");
  const serverSuggestionsMatch = props.suggestionQuery?.trim() === props.customerName.trim();
  const suggestions = (() => {
    if (props.suggestionCustomers && serverSuggestionsMatch) {
      return props.suggestionCustomers;
    }
    const normalizedQuery = props.customerName.trim().replace(/\s+/g, " ").toLowerCase();
    const normalizedPhoneQuery = (props.customerName.match(/[\d+]+/g)?.join("") ?? "").replace(/(?!^)\+/g, "");
    if (!normalizedQuery && !normalizedPhoneQuery) {
      return [] as Customer[];
    }
    return [...props.customers]
      .filter((customer) => {
        const customerName = customer.name.trim().replace(/\s+/g, " ").toLowerCase();
        const customerPhone = (customer.phone?.match(/[\d+]+/g)?.join("") ?? "").replace(/(?!^)\+/g, "");
        return (
          customerName.includes(normalizedQuery) ||
          (normalizedPhoneQuery ? customerPhone.includes(normalizedPhoneQuery) : false)
        );
      })
      .sort((left, right) => {
        const leftName = left.name.trim().replace(/\s+/g, " ").toLowerCase();
        const rightName = right.name.trim().replace(/\s+/g, " ").toLowerCase();
        const leftStarts = leftName.startsWith(normalizedQuery) ? 1 : 0;
        const rightStarts = rightName.startsWith(normalizedQuery) ? 1 : 0;
        if (leftStarts !== rightStarts) {
          return rightStarts - leftStarts;
        }
        return new Date(right.lastVisitAt).getTime() - new Date(left.lastVisitAt).getTime();
      })
      .slice(0, 6);
  })();
  const canShowLoadingState = Boolean(
    props.suggestionsLoading && serverSuggestionsMatch && suggestionsOpen && (normalizedQuery || normalizedPhoneQuery)
  );

  return (
    <>
      <label className={props.nameFieldClassName}>
        <span>Customer Name</span>
        <div className="customer-autocomplete">
          <input
            required={props.required}
            disabled={props.disabled}
            value={props.customerName}
            placeholder={props.namePlaceholder}
            onFocus={() => {
              setSuggestionsOpen(true);
              props.onSuggestionQueryChange?.(props.customerName);
            }}
            onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
            onChange={(event) => {
              props.onSuggestionQueryChange?.(event.target.value);
              props.onChange({
                customerId: undefined,
                customerName: event.target.value,
                customerPhone: props.customerPhone
              });
            }}
          />
          {suggestionsOpen && (suggestions.length > 0 || canShowLoadingState) && (
            <div className="customer-suggestion-list">
              {canShowLoadingState && <div className="customer-suggestion muted">Searching customers...</div>}
              {suggestions.map((customer) => (
                <button
                  key={customer.id}
                  className="customer-suggestion"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    props.onChange({
                      customerId: customer.id,
                      customerName: customer.name,
                      customerPhone: customer.phone ?? ""
                    });
                    setSuggestionsOpen(false);
                  }}
                >
                  <strong>{customer.name}</strong>
                  <span>{customer.phone || "No phone"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </label>
      <label className={props.phoneFieldClassName}>
        <span>Customer Phone</span>
        <input
          disabled={props.disabled}
          value={props.customerPhone}
          placeholder={props.phonePlaceholder}
          onChange={(event) =>
            props.onChange({
              customerId: props.customerId,
              customerName: props.customerName,
              customerPhone: event.target.value
            })
          }
        />
      </label>
    </>
  );
}
