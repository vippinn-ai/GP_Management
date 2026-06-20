import { describe, expect, it } from "vitest";
import { buildNormalizedCatalogData, buildNormalizedComboData, buildNormalizedConfigData } from "./normalizedReads";

describe("normalized config read mapping", () => {
  it("maps normalized organization, station, category, and pricing rows into current app models", () => {
    const result = buildNormalizedConfigData({
      organization: {
        id: "org-primary",
        name: "BreakPerfect",
        business_profile: {
          name: "BreakPerfect Gaming Lounge",
          logoText: "BP",
          address: "Rohini",
          primaryPhone: "999",
          receiptFooter: "Good games"
        }
      },
      inventoryCategories: [{ name: "Beverage" }, { name: "Snacks" }],
      stations: [
        {
          id: "station-1",
          name: "Pool 1",
          mode: "timed",
          active: true,
          ltp_enabled: true,
          notes: "Near counter",
          raw_data: {
            mode: "unit",
            ltpEnabled: false
          }
        }
      ],
      pricingRules: [
        {
          id: "price-1",
          station_id: "station-1",
          label: "First hour",
          start_minute: "0",
          end_minute: "60",
          hourly_rate: "300",
          raw_data: {
            startMinute: 0,
            endMinute: 60,
            hourlyRate: 300
          }
        }
      ]
    });

    expect(result).toEqual({
      organizationId: "org-primary",
      businessProfile: {
        name: "BreakPerfect Gaming Lounge",
        logoText: "BP",
        address: "Rohini",
        primaryPhone: "999",
        secondaryPhone: undefined,
        receiptFooter: "Good games"
      },
      inventoryCategories: ["Beverage", "Snacks"],
      stations: [
        {
          id: "station-1",
          name: "Pool 1",
          mode: "unit",
          active: true,
          ltpEnabled: false,
          notes: "Near counter"
        }
      ],
      pricingRules: [
        {
          id: "price-1",
          stationId: "station-1",
          label: "First hour",
          startMinute: 0,
          endMinute: 60,
          hourlyRate: 300
        }
      ]
    });
  });
});

describe("normalized catalog read mapping", () => {
  it("maps inventory rows and groups sale variants by source item", () => {
    const result = buildNormalizedCatalogData({
      inventoryItems: [
        {
          id: "item-momo",
          name: "Momo",
          category: "Food",
          price: "80",
          stock_qty: "100",
          low_stock_threshold: "10",
          unit: "piece",
          is_reusable: false,
          barcode: "SRC",
          active: true,
          archived_at: null,
          archived_by_user_id: null,
          archive_reason: null,
          sell_base_item: false,
          cigarette_pack: null,
          raw_data: {
            sellBaseItem: false
          }
        }
      ],
      saleVariants: [
        {
          inventory_item_id: "item-momo",
          id: "variant-plate",
          name: "Momo Plate",
          price: "80",
          stock_units_per_sale: "8",
          barcode: "PLATE",
          active: true,
          raw_data: null
        }
      ]
    });

    expect(result.inventoryItems).toEqual([
      {
        id: "item-momo",
        name: "Momo",
        category: "Food",
        price: 80,
        stockQty: 100,
        lowStockThreshold: 10,
        unit: "piece",
        isReusable: false,
        barcode: "SRC",
        active: true,
        archivedAt: undefined,
        archivedByUserId: undefined,
        archiveReason: undefined,
        cigarettePack: undefined,
        sellBaseItem: false,
        saleVariants: [
          {
            id: "variant-plate",
            name: "Momo Plate",
            price: 80,
            stockUnitsPerSale: 8,
            barcode: "PLATE",
            active: true
          }
        ]
      }
    ]);
  });
});

describe("normalized combo read mapping", () => {
  it("maps game combos with station targets, fixed items, and choice groups", () => {
    const createdAt = "2026-06-20T09:00:00.000Z";
    const updatedAt = "2026-06-20T10:00:00.000Z";

    const result = buildNormalizedComboData({
      combos: [
        {
          id: "combo-pool-pot",
          name: "Pool Pot Combo",
          type: "game",
          active: true,
          price: "799",
          included_minutes: "60",
          raw_data: {
            stationIds: ["stale-station"],
            fixedItems: [],
            choiceGroups: []
          },
          created_at: createdAt,
          updated_at: updatedAt
        }
      ],
      stationTargets: [
        { combo_id: "combo-pool-pot", station_id: "pool-1" },
        { combo_id: "combo-pool-pot", station_id: "pool-2" }
      ],
      fixedItems: [
        {
          combo_id: "combo-pool-pot",
          id: "fixed-maggi",
          sellable_option_id: "maggi-plain",
          quantity: "2",
          raw_data: null
        }
      ],
      choiceGroups: [
        {
          combo_id: "combo-pool-pot",
          id: "drink-choice",
          label: "Drinks",
          required_quantity: "2",
          raw_data: null
        }
      ],
      choiceOptions: [
        { combo_id: "combo-pool-pot", choice_group_id: "drink-choice", option_id: "coke" },
        { combo_id: "combo-pool-pot", choice_group_id: "drink-choice", option_id: "shake" }
      ]
    });

    expect(result.combos).toEqual([
      {
        id: "combo-pool-pot",
        name: "Pool Pot Combo",
        type: "game",
        active: true,
        stationIds: ["pool-1", "pool-2"],
        price: 799,
        includedMinutes: 60,
        fixedItems: [{ id: "fixed-maggi", sellableOptionId: "maggi-plain", quantity: 2 }],
        choiceGroups: [{ id: "drink-choice", label: "Drinks", requiredQuantity: 2, optionIds: ["coke", "shake"] }],
        createdAt,
        updatedAt
      }
    ]);
  });

  it("maps consumables combos with empty stations and zero included game minutes", () => {
    const result = buildNormalizedComboData({
      combos: [
        {
          id: "combo-snack",
          name: "Snack Combo",
          type: "consumables",
          active: true,
          price: "199",
          included_minutes: "120",
          raw_data: {
            stationIds: ["pool-1"]
          },
          created_at: "2026-06-20T09:00:00.000Z",
          updated_at: "2026-06-20T09:00:00.000Z"
        }
      ],
      stationTargets: [{ combo_id: "combo-snack", station_id: "pool-1" }],
      fixedItems: [
        {
          combo_id: "combo-snack",
          id: "fixed-momo",
          sellable_option_id: "momo-plate",
          quantity: "1",
          raw_data: null
        }
      ],
      choiceGroups: [],
      choiceOptions: []
    });

    expect(result.combos[0]).toMatchObject({
      id: "combo-snack",
      type: "consumables",
      stationIds: [],
      price: 199,
      includedMinutes: 0,
      fixedItems: [{ id: "fixed-momo", sellableOptionId: "momo-plate", quantity: 1 }],
      choiceGroups: []
    });
  });
});
