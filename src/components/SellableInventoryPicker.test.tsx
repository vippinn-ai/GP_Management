import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SellableInventoryPicker } from "./SellableInventoryPicker";
import type { InventoryItem, SellableInventoryOption } from "../types";

function inventoryItem(patch: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "item-coke",
    name: "Coke",
    category: "Drinks",
    price: 40,
    stockQty: 10,
    lowStockThreshold: 2,
    unit: "bottle",
    isReusable: false,
    active: true,
    ...patch
  };
}

function sellableOption(patch: Partial<SellableInventoryOption> = {}): SellableInventoryOption {
  const item = patch.item ?? inventoryItem();
  return {
    id: item.id,
    inventoryItemId: item.id,
    name: item.name,
    sourceName: item.name,
    category: item.category,
    price: item.price,
    barcode: item.barcode,
    sourceBarcode: item.barcode,
    isBaseItem: true,
    stockUnitsPerSale: 1,
    item,
    ...patch
  };
}

describe("SellableInventoryPicker", () => {
  it("filters by option name and selects a result", () => {
    const onChange = vi.fn();
    render(
      <SellableInventoryPicker
        options={[
          sellableOption({ id: "momo", name: "Fried Momo", category: "Food" }),
          sellableOption({ id: "coke", name: "Coke", category: "Drinks" })
        ]}
        value=""
        onChange={onChange}
        getOptionDetail={() => "Available 10"}
      />
    );

    fireEvent.focus(screen.getByLabelText("Search inventory item"));
    fireEvent.change(screen.getByLabelText("Search inventory item"), { target: { value: "momo" } });
    fireEvent.click(screen.getByRole("button", { name: /Fried Momo/i }));

    expect(onChange).toHaveBeenLastCalledWith("momo");
  });

  it("filters by source name, category, and barcode", () => {
    const onChange = vi.fn();
    render(
      <SellableInventoryPicker
        options={[
          sellableOption({
            id: "momo-plate",
            inventoryItemId: "momo",
            saleVariantId: "plate",
            name: "Plate",
            sourceName: "Momo",
            category: "Food",
            barcode: "PLATE-001",
            sourceBarcode: "MOMO-BASE",
            isBaseItem: false
          }),
          sellableOption({ id: "shake", name: "Shake", category: "Drinks" })
        ]}
        value=""
        onChange={onChange}
        getOptionDetail={() => "Available 10"}
      />
    );

    const input = screen.getByLabelText("Search inventory item");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "momo-base" } });
    expect(screen.getByRole("button", { name: /Plate/i })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "food" } });
    expect(screen.getByRole("button", { name: /Plate/i })).toBeInTheDocument();
  });

  it("does not allow disabled unavailable results to be selected", () => {
    const onChange = vi.fn();
    render(
      <SellableInventoryPicker
        options={[sellableOption({ id: "burger", name: "Burger", category: "Food" })]}
        value=""
        onChange={onChange}
        getOptionDetail={() => "Available 0"}
        isOptionDisabled={() => true}
      />
    );

    fireEvent.focus(screen.getByLabelText("Search inventory item"));
    const option = screen.getByRole("button", { name: /Burger/i });

    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the selected option in the input", () => {
    render(
      <SellableInventoryPicker
        options={[sellableOption({ id: "coke", name: "Coke", category: "Drinks" })]}
        value="coke"
        onChange={vi.fn()}
        getOptionDetail={() => "Available 10"}
      />
    );

    expect(screen.getByLabelText("Search inventory item")).toHaveValue("Coke");
  });
});
