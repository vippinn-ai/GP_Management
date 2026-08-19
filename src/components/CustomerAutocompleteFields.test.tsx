import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomerAutocompleteFields } from "./CustomerAutocompleteFields";
import type { Customer } from "../types";

const customer = (id: string, name: string, phone?: string): Customer => ({
  id,
  name,
  phone,
  createdAt: "2026-06-01T07:00:00.000Z",
  lastVisitAt: "2026-06-01T07:00:00.000Z"
});

describe("CustomerAutocompleteFields", () => {
  it("requests suggestions from the phone field and selects a returned profile", () => {
    const onChange = vi.fn();
    const onSuggestionQueryChange = vi.fn();
    render(
      <CustomerAutocompleteFields
        customers={[]}
        customerName=""
        customerPhone="8800"
        suggestionCustomers={[customer("customer-1", "Vipin Kumar", "8800")]}
        suggestionQuery="8800"
        onSuggestionQueryChange={onSuggestionQueryChange}
        onChange={onChange}
      />
    );

    fireEvent.focus(screen.getByLabelText("Customer Phone"));
    expect(onSuggestionQueryChange).toHaveBeenCalledWith("8800");

    fireEvent.click(screen.getByRole("button", { name: /Vipin Kumar/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      customerId: "customer-1",
      customerName: "Vipin Kumar",
      customerPhone: "8800"
    });
  });

  it("clears a selected customer id when phone is manually edited", () => {
    const onChange = vi.fn();
    render(
      <CustomerAutocompleteFields
        customers={[]}
        customerId="customer-1"
        customerName="Vipin Kumar"
        customerPhone="8800"
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText("Customer Phone"), { target: { value: "9900" } });

    expect(onChange).toHaveBeenLastCalledWith({
      customerId: undefined,
      customerName: "Vipin Kumar",
      customerPhone: "9900"
    });
  });

  it("clears a selected customer id when name is manually edited", () => {
    const onChange = vi.fn();
    render(
      <CustomerAutocompleteFields
        customers={[]}
        customerId="customer-1"
        customerName="Vipin Kumar"
        customerPhone="8800"
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText("Customer Name"), { target: { value: "Vipin K" } });

    expect(onChange).toHaveBeenLastCalledWith({
      customerId: undefined,
      customerName: "Vipin K",
      customerPhone: "8800"
    });
  });

  it("does not fall back to cached customers when normalized search fails", () => {
    render(
      <CustomerAutocompleteFields
        customers={[customer("cached-customer", "Cached Vipin", "8800")]}
        customerName="Vipin"
        customerPhone=""
        serverSuggestionsEnabled
        suggestionsError="Backend read failed."
        suggestionQuery="Vipin"
        onChange={vi.fn()}
      />
    );

    fireEvent.focus(screen.getByLabelText("Customer Name"));
    expect(screen.getByText("Customer search unavailable. Please retry typing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cached Vipin/i })).not.toBeInTheDocument();
  });
});
