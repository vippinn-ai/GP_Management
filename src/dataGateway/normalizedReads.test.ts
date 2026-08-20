import { describe, expect, it } from "vitest";
import {
  buildNormalizedCatalogData,
  buildNormalizedComboData,
  buildNormalizedConfigData,
  buildNormalizedLiveData,
  mapNormalizedAuditLog
} from "./normalizedReads";

describe("normalized audit mapping", () => {
  it("uses the typed audit timestamp instead of a timezone-less raw timestamp", () => {
    expect(mapNormalizedAuditLog({
      id: "audit-pause-delete",
      action: "pause_log_deleted",
      entity_type: "session",
      entity_id: "session-1",
      message: "Deleted pause log entry for 8 Ball Pool.",
      audit_at: "2026-08-20T06:45:00.000Z",
      user_id: "user-1",
      raw_data: {
        id: "audit-pause-delete",
        action: "pause_log_deleted",
        entityType: "session",
        entityId: "session-1",
        message: "Deleted pause log entry for 8 Ball Pool.",
        createdAt: "2026-08-20T06:45:00",
        userId: "user-1"
      },
      created_at: "2026-08-20T06:45:00.000Z"
    }).createdAt).toBe("2026-08-20T06:45:00.000Z");
  });
});

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

describe("normalized live read mapping", () => {
  it("maps open sessions, pause logs, customer tabs, item stock fields, and combo snapshots", () => {
    const result = buildNormalizedLiveData({
      sessions: [
        {
          id: "session-1",
          station_id: "pool-1",
          station_name_snapshot: "Pool 1",
          mode: "timed",
          started_at: "2026-06-20T10:00:00.000Z",
          ended_at: null,
          status: "paused",
          customer_id: "customer-1",
          customer_name: "Vipin",
          customer_phone: "8800",
          play_mode: "group",
          ltp_eligible: true,
          ltp_outcome: null,
          ltp_discount_applied: null,
          pricing_snapshot: [
            {
              id: "price-1",
              stationId: "pool-1",
              label: "First hour",
              startMinute: 0,
              endMinute: 60,
              hourlyRate: 300
            }
          ],
          pause_log_ids: [],
          continued_from_session_ids: [],
          closed_bill_id: null,
          close_disposition: null,
          close_reason: null,
          raw_data: null,
          created_at: "2026-06-20T10:00:00.000Z"
        }
      ],
      sessionPauseLogs: [
        {
          id: "pause-1",
          session_id: "session-1",
          paused_at: "2026-06-20T10:20:00.000Z",
          resumed_at: null,
          raw_data: null,
          created_at: "2026-06-20T10:20:00.000Z"
        }
      ],
      sessionItems: [
        {
          session_id: "session-1",
          id: "item-1",
          inventory_item_id: "momo",
          name: "Momo Plate",
          quantity: "2",
          unit_price: "0",
          added_at: "2026-06-20T10:05:00.000Z",
          sold_as_pack_of: null,
          sale_variant_id: "plate",
          stock_units_per_sale: "8",
          combo_application_id: "combo-app-1",
          combo_id: "combo-pot",
          raw_data: null,
          created_at: "2026-06-20T10:05:00.000Z"
        }
      ],
      sessionComboApplications: [
        {
          session_id: "session-1",
          id: "combo-app-1",
          combo_id: "combo-pot",
          combo_name: "Pool Pot Combo",
          price: "799",
          included_minutes: "60",
          applied_at: "2026-06-20T10:00:00.000Z",
          fixed_items: [
            {
              inventoryItemId: "momo",
              saleVariantId: "plate",
              name: "Momo Plate",
              sourceName: "Momo",
              quantity: 2,
              unitPrice: 80,
              stockUnitsPerSale: 8
            }
          ],
          choices: [
            {
              groupId: "drink",
              groupLabel: "Drinks",
              selections: [
                {
                  inventoryItemId: "coke",
                  name: "Coke",
                  sourceName: "Coke",
                  quantity: 1,
                  unitPrice: 40,
                  stockUnitsPerSale: 1
                }
              ]
            }
          ],
          raw_data: null,
          created_at: "2026-06-20T10:00:00.000Z"
        }
      ],
      customerTabs: [
        {
          id: "tab-1",
          customer_id: "customer-2",
          customer_name: "Amit",
          customer_phone: "9900",
          status: "open",
          opened_at: "2026-06-20T11:00:00.000Z",
          closed_at: null,
          continued_from_session_ids: [],
          closed_bill_id: null,
          close_disposition: null,
          close_reason: null,
          raw_data: null,
          created_at: "2026-06-20T11:00:00.000Z"
        }
      ],
      customerTabItems: [
        {
          customer_tab_id: "tab-1",
          id: "tab-item-1",
          inventory_item_id: "coke",
          name: "Coke",
          quantity: "1",
          unit_price: "40",
          added_at: "2026-06-20T11:01:00.000Z",
          sold_as_pack_of: null,
          sale_variant_id: null,
          stock_units_per_sale: "1",
          combo_application_id: null,
          combo_id: null,
          raw_data: null,
          created_at: "2026-06-20T11:01:00.000Z"
        }
      ],
      customerTabComboApplications: []
    });

    expect(result.sessions).toEqual([
      {
        id: "session-1",
        stationId: "pool-1",
        stationNameSnapshot: "Pool 1",
        mode: "timed",
        startedAt: "2026-06-20T10:00:00.000Z",
        endedAt: undefined,
        status: "paused",
        customerId: "customer-1",
        customerName: "Vipin",
        customerPhone: "8800",
        playMode: "group",
        ltpEligible: true,
        ltpOutcome: undefined,
        ltpDiscountApplied: undefined,
        pricingSnapshot: [
          {
            id: "price-1",
            stationId: "pool-1",
            label: "First hour",
            startMinute: 0,
            endMinute: 60,
            hourlyRate: 300
          }
        ],
        items: [
          {
            id: "item-1",
            inventoryItemId: "momo",
            name: "Momo Plate",
            quantity: 2,
            unitPrice: 0,
            addedAt: "2026-06-20T10:05:00.000Z",
            soldAsPackOf: undefined,
            saleVariantId: "plate",
            stockUnitsPerSale: 8,
            comboApplicationId: "combo-app-1",
            comboId: "combo-pot"
          }
        ],
        comboApplications: [
          {
            id: "combo-app-1",
            comboId: "combo-pot",
            comboName: "Pool Pot Combo",
            price: 799,
            includedMinutes: 60,
            appliedAt: "2026-06-20T10:00:00.000Z",
            fixedItems: [
              {
                inventoryItemId: "momo",
                saleVariantId: "plate",
                name: "Momo Plate",
                sourceName: "Momo",
                quantity: 2,
                unitPrice: 80,
                stockUnitsPerSale: 8
              }
            ],
            choices: [
              {
                groupId: "drink",
                groupLabel: "Drinks",
                selections: [
                  {
                    inventoryItemId: "coke",
                    name: "Coke",
                    sourceName: "Coke",
                    quantity: 1,
                    unitPrice: 40,
                    stockUnitsPerSale: 1
                  }
                ],
                selection: undefined
              }
            ]
          }
        ],
        pauseLogIds: ["pause-1"],
        continuedFromSessionIds: undefined,
        closedBillId: undefined,
        closeDisposition: undefined,
        closeReason: undefined
      }
    ]);
    expect(result.sessionPauseLogs).toEqual([
      {
        id: "pause-1",
        sessionId: "session-1",
        pausedAt: "2026-06-20T10:20:00.000Z",
        resumedAt: undefined
      }
    ]);
    expect(result.customerTabs).toEqual([
      {
        id: "tab-1",
        customerId: "customer-2",
        customerName: "Amit",
        customerPhone: "9900",
        status: "open",
        createdAt: "2026-06-20T11:00:00.000Z",
        closedAt: undefined,
        items: [
          {
            id: "tab-item-1",
            inventoryItemId: "coke",
            name: "Coke",
            quantity: 1,
            unitPrice: 40,
            addedAt: "2026-06-20T11:01:00.000Z",
            soldAsPackOf: undefined,
            saleVariantId: undefined,
            stockUnitsPerSale: 1,
            comboApplicationId: undefined,
            comboId: undefined
          }
        ],
        comboApplications: [],
        continuedFromSessionIds: undefined,
        closedBillId: undefined,
        closeDisposition: undefined,
        closeReason: undefined
      }
    ]);
  });
});
