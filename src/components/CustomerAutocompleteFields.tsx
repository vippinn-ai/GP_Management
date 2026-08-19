import { useState } from "react";
import type { Customer } from "../types";

export interface CustomerAutocompleteSuggestionProps {
  serverSuggestionsEnabled?: boolean;
  suggestionCustomers?: Customer[];
  suggestionQuery?: string;
  suggestionsLoading?: boolean;
  suggestionsError?: string;
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
  const [activeSuggestionField, setActiveSuggestionField] = useState<"name" | "phone" | null>(null);
  const activeQuery = activeSuggestionField === "phone" ? props.customerPhone : props.customerName;
  const normalizedQuery = activeQuery.trim().replace(/\s+/g, " ").toLowerCase();
  const normalizedPhoneQuery = (activeQuery.match(/[\d+]+/g)?.join("") ?? "").replace(/(?!^)\+/g, "");
  const serverSuggestionsMatch = props.suggestionQuery?.trim() === activeQuery.trim();
  const useServerSuggestions = Boolean(props.serverSuggestionsEnabled || props.suggestionCustomers !== undefined);
  const suggestions = (() => {
    if (useServerSuggestions) {
      return props.suggestionCustomers && serverSuggestionsMatch ? props.suggestionCustomers : [];
    }
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
    props.suggestionsLoading && serverSuggestionsMatch && activeSuggestionField && (normalizedQuery || normalizedPhoneQuery)
  );
  const canShowErrorState = Boolean(
    useServerSuggestions && props.suggestionsError && activeSuggestionField && (normalizedQuery || normalizedPhoneQuery)
  );
  const suggestionList = activeSuggestionField && (suggestions.length > 0 || canShowLoadingState || canShowErrorState) ? (
    <div className="customer-suggestion-list">
      {canShowLoadingState && <div className="customer-suggestion muted">Searching customers...</div>}
      {canShowErrorState && <div className="customer-suggestion muted">Customer search unavailable. Please retry typing.</div>}
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
            setActiveSuggestionField(null);
          }}
        >
          <strong>{customer.name}</strong>
          <span>{customer.phone || "No phone"}</span>
        </button>
      ))}
    </div>
  ) : null;

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
              setActiveSuggestionField("name");
              props.onSuggestionQueryChange?.(props.customerName);
            }}
            onBlur={() => window.setTimeout(() => setActiveSuggestionField(null), 120)}
            onChange={(event) => {
              props.onSuggestionQueryChange?.(event.target.value);
              props.onChange({
                customerId: undefined,
                customerName: event.target.value,
                customerPhone: props.customerPhone
              });
            }}
          />
          {activeSuggestionField === "name" && suggestionList}
        </div>
      </label>
      <label className={props.phoneFieldClassName}>
        <span>Customer Phone</span>
        <div className="customer-autocomplete">
          <input
            disabled={props.disabled}
            value={props.customerPhone}
            placeholder={props.phonePlaceholder}
            onFocus={() => {
              setActiveSuggestionField("phone");
              props.onSuggestionQueryChange?.(props.customerPhone);
            }}
            onBlur={() => window.setTimeout(() => setActiveSuggestionField(null), 120)}
            onChange={(event) => {
              props.onSuggestionQueryChange?.(event.target.value);
              props.onChange({
                customerId: undefined,
                customerName: props.customerName,
                customerPhone: event.target.value
              });
            }}
          />
          {activeSuggestionField === "phone" && suggestionList}
        </div>
      </label>
    </>
  );
}
