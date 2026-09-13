import { describe, expect, it, vi } from "vitest";
import {
  buildNormalizedCatalogData,
  buildNormalizedComboData,
  buildNormalizedConfigData,
  buildNormalizedLiveData,
  loadNormalizedStockMovements,
  mapNormalizedAuditLog
} from "./normalizedReads";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("normalized critical bootstrap graph", () => {
  it("resolves organization once, parallelizes core slices, and excludes financial/audit history", () => {
    const reads = readFileSync(path.join(process.cwd(), "src/dataGateway/normalizedReads.ts"), "utf8");
    const gateway = readFileSync(path.join(process.cwd(), "src/dataGateway/normalizedGateway.ts"), "utf8");
    const overlayBody = reads.match(/export async function loadNormalizedAppDataOverlay[\s\S]*?return \{ organizationId, appData: overlay \};/i)?.[0] ?? "";
    const snapshotStart = gateway.indexOf("async function loadNormalizedBootstrapSnapshot");
    const snapshotEnd = gateway.indexOf("export function createNormalizedRemoteDataGateway", snapshotStart);
    const snapshotBody = gateway.slice(snapshotStart, snapshotEnd);
    expect(overlayBody).toContain("await loadNormalizedActiveOrganization(client)");
    expect(overlayBody).toContain("await Promise.all");
    expect(snapshotBody).not.toContain("loadNormalizedBootstrapHistory");
    expect(snapshotBody).not.toContain("loadNormalizedAuditLogs");
    expect(snapshotBody).toContain("bills: []");
    expect(gateway).toContain("loadDeferredNormalizedDashboardContext");
  });
});

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

describe("normalized stock-movement pagination", () => {
  const movementRow = (id: string, movementAt: string) => ({
    id,
    item_id: "item-1",
    type: "restock",
    quantity: 1,
    reason: null,
    movement_at: movementAt,
    user_id: "user-1",
    related_bill_id: null,
    raw_data: null,
    created_at: movementAt
  });

  type MovementRow = ReturnType<typeof movementRow>;
  type PageResult = {
    data?: MovementRow[] | null | unknown;
    count?: unknown;
    error?: Error | null;
    delayMs?: number;
  };

  const orderedRows = (count: number, idOffset = 0) => Array.from({ length: count }, (_, index) =>
    movementRow(
      `movement-${String(idOffset + index).padStart(5, "0")}`,
      new Date(Date.parse("2026-09-13T23:59:59.999Z") - (idOffset + index)).toISOString()
    ));

  const pagesFor = (totalCount: number, requestedLimit = 5_000) => {
    const rows = orderedRows(Math.min(totalCount, requestedLimit));
    if (rows.length === 0) return [{ data: [], count: totalCount }];
    const pages: PageResult[] = [];
    for (let offset = 0; offset < rows.length; offset += 1_000) {
      pages.push({ data: rows.slice(offset, offset + 1_000), count: totalCount });
    }
    return pages;
  };

  function pagedClient(pages: PageResult[]) {
    const ranges: Array<[number, number]> = [];
    const selectOptions: unknown[] = [];
    const eqCalls: Array<[string, string]> = [];
    const orderCalls: Array<[string, unknown]> = [];
    const gteCalls: Array<[string, string]> = [];
    const ltCalls: Array<[string, string]> = [];
    let pageIndex = 0;
    const client = {
      from: vi.fn(() => {
        const builder = {
          select: vi.fn((_columns: string, options: unknown) => {
            selectOptions.push(options);
            return builder;
          }),
          eq: vi.fn((column: string, value: string) => {
            eqCalls.push([column, value]);
            return builder;
          }),
          order: vi.fn((column: string, options: unknown) => {
            orderCalls.push([column, options]);
            return builder;
          }),
          gte: vi.fn((column: string, value: string) => {
            gteCalls.push([column, value]);
            return builder;
          }),
          lt: vi.fn((column: string, value: string) => {
            ltCalls.push([column, value]);
            return builder;
          }),
          range: vi.fn((from: number, to: number) => {
            ranges.push([from, to]);
            const page = pages[pageIndex++];
            const result: Record<string, unknown> = {
              data: page && Object.hasOwn(page, "data") ? page.data : [],
              error: page?.error ?? null
            };
            if (page && Object.hasOwn(page, "count")) result.count = page.count;
            if ((page?.delayMs ?? 0) > 0) {
              return new Promise((resolve) => setTimeout(() => resolve(result), page!.delayMs));
            }
            return Promise.resolve(result);
          })
        };
        return builder;
      })
    };
    return { client, ranges, selectOptions, eqCalls, orderCalls, gteCalls, ltCalls };
  }

  it.each([0, 999, 1_000, 1_001, 1_506])("loads %i rows through exact bounded pages", async (count) => {
    const fake = pagedClient(pagesFor(count));

    const result = await loadNormalizedStockMovements("org-primary", {
      fromIso: "2026-08-01T00:00:00.000Z",
      toIsoExclusive: "2026-09-14T00:00:00.000Z",
      limit: 5_000
    }, fake.client as never);

    const expectedPageCount = Math.max(1, Math.ceil(count / 1_000));
    expect(result).toHaveLength(count);
    expect(fake.ranges).toEqual(Array.from({ length: expectedPageCount }, (_, index) => [index * 1_000, index * 1_000 + 999]));
    expect(fake.selectOptions).toEqual(Array.from({ length: expectedPageCount }, () => ({ count: "exact" })));
    expect(fake.eqCalls).toEqual(Array.from({ length: expectedPageCount }, () => ["organization_id", "org-primary"]));
    expect(fake.orderCalls).toEqual(Array.from({ length: expectedPageCount }, () => [
      ["movement_at", { ascending: false, nullsFirst: false }],
      ["id", { ascending: false }]
    ]).flat());
    expect(fake.gteCalls).toEqual(Array.from({ length: expectedPageCount }, () => ["movement_at", "2026-08-01T00:00:00.000Z"]));
    expect(fake.ltCalls).toEqual(Array.from({ length: expectedPageCount }, () => ["movement_at", "2026-09-14T00:00:00.000Z"]));
  });

  it("honors a smaller requested limit and clamps at the caller-safe 5,000-row ceiling", async () => {
    const small = pagedClient(pagesFor(1_506, 25));
    await expect(loadNormalizedStockMovements("org-primary", { limit: 25 }, small.client as never)).resolves.toHaveLength(25);
    expect(small.ranges).toEqual([[0, 24]]);

    const exactLimit = pagedClient(pagesFor(5_000));
    await expect(loadNormalizedStockMovements("org-primary", { limit: 5_000 }, exactLimit.client as never)).resolves.toHaveLength(5_000);
    expect(exactLimit.ranges).toEqual([[0, 999], [1_000, 1_999], [2_000, 2_999], [3_000, 3_999], [4_000, 4_999]]);
    expect(exactLimit.client.from).toHaveBeenCalledTimes(5);
    const overLimit = pagedClient(pagesFor(6_000));
    await expect(loadNormalizedStockMovements("org-primary", { limit: 9_000 }, overLimit.client as never)).resolves.toHaveLength(5_000);
    expect(overLimit.ranges).toEqual([[0, 999], [1_000, 1_999], [2_000, 2_999], [3_000, 3_999], [4_000, 4_999]]);
    expect(overLimit.client.from).toHaveBeenCalledTimes(5);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects invalid limit %s", async (limit) => {
    await expect(loadNormalizedStockMovements("org-primary", { limit }, pagedClient([]).client as never))
      .rejects.toThrow("invalid row limit");
  });

  it.each([undefined, null, -1, 1.5, Number.NaN])("rejects missing or invalid exact count %s", async (count) => {
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([{ data: [], count }]).client as never))
      .rejects.toThrow("did not return an exact row count");
  });

  it("fails closed on count drift, unavailable data, duplicate IDs, short pages, and oversized pages", async () => {
    const fullPage = orderedRows(1_000);
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: fullPage, count: 1_001 },
      { data: orderedRows(1, 1_000), count: 1_002 }
    ]).client as never)).rejects.toThrow("changed while it was being loaded");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: null, count: 0 }
    ]).client as never)).rejects.toThrow("Normalized data was unavailable");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: undefined, count: 0 }
    ]).client as never)).rejects.toThrow("Normalized data was unavailable");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: { not: "an array" }, count: 0 }
    ]).client as never)).rejects.toThrow("Normalized data was unavailable");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [fullPage[0], fullPage[0]], count: 2 }
    ]).client as never)).rejects.toThrow("overlapped while it was being loaded");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: fullPage, count: 1_001 },
      { data: [fullPage.at(-1)!], count: 1_001 }
    ]).client as never)).rejects.toThrow("overlapped while it was being loaded");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: orderedRows(999), count: 1_001 }
    ]).client as never)).rejects.toThrow("ended before the expected row count");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: fullPage, count: 1_001 },
      { data: [], count: 1_001 }
    ]).client as never)).rejects.toThrow("ended before the expected row count");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: fullPage, count: 1_506 },
      { data: orderedRows(505, 1_000), count: 1_506 }
    ]).client as never)).rejects.toThrow("ended before the expected row count");
    await expect(loadNormalizedStockMovements("org-primary", { limit: 2 }, pagedClient([
      { data: orderedRows(3), count: 3 }
    ]).client as never)).rejects.toThrow("exceeded the requested page size");
  });

  it("rejects invalid timestamps and ascending movement times", async () => {
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [movementRow("movement-1", "not-a-timestamp")], count: 1 }
    ]).client as never)).rejects.toThrow("invalid timestamp");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [
        movementRow("movement-1", "2026-09-13T09:00:00.000Z"),
        movementRow("movement-2", "2026-09-13T10:00:00.000Z")
      ], count: 2 }
    ]).client as never)).rejects.toThrow("stable descending order");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [
        movementRow("movement-1", null as never),
        movementRow("movement-2", "2026-09-13T10:00:00.000Z")
      ], count: 2 }
    ]).client as never)).rejects.toThrow("stable descending order");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [
        movementRow("movement-a", "2026-09-13T10:00:00.000Z"),
        movementRow("movement-z", "2026-09-13T10:00:00.000Z"),
        movementRow("movement-null", null as never)
      ], count: 3 }
    ]).client as never)).resolves.toHaveLength(3);
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [
        movementRow("movement-a", "2026-09-13T10:00:00.000001Z"),
        movementRow("movement-z", "2026-09-13T15:30:00.000001+05:30")
      ], count: 2 }
    ]).client as never)).resolves.toHaveLength(2);
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [
        movementRow("movement-1", "2026-09-13T10:00:00.000001Z"),
        movementRow("movement-2", "2026-09-13T10:00:00.000002Z")
      ], count: 2 }
    ]).client as never)).rejects.toThrow("stable descending order");
  });

  it("rejects cross-page order violations and propagates first or later-page API failures", async () => {
    const firstPage = orderedRows(1_000);
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: firstPage, count: 1_001 },
      { data: [movementRow("movement-newer", "2026-09-14T00:00:00.000Z")], count: 1_001 }
    ]).client as never)).rejects.toThrow("stable descending order");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: [], count: 0, error: new Error("page one failed") }
    ]).client as never)).rejects.toThrow("page one failed");
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: firstPage, count: 1_001 },
      { data: [], count: 1_001, error: new Error("page two failed") }
    ]).client as never)).rejects.toThrow("page two failed");
  });

  it("rejects downward exact-count drift", async () => {
    await expect(loadNormalizedStockMovements("org-primary", {}, pagedClient([
      { data: orderedRows(1_000), count: 1_001 },
      { data: orderedRows(1, 1_000), count: 1_000 }
    ]).client as never)).rejects.toThrow("changed while it was being loaded");
  });

  it("enforces one 15-second deadline across all pages", async () => {
    vi.useFakeTimers();
    try {
      const promise = loadNormalizedStockMovements("org-primary", {}, pagedClient([
        { data: orderedRows(1_000), count: 1_001, delayMs: 10_000 },
        { data: orderedRows(1, 1_000), count: 1_001, delayMs: 10_000 }
      ]).client as never);
      const rejection = expect(promise).rejects.toThrow("Unable to reach normalized data while loading normalized stock movements");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
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

  it("uses normalized session timing while retaining the legacy null-start fallback", () => {
    const baseSession = {
      station_id: "station-playstation",
      station_name_snapshot: "Playstation",
      mode: "timed",
      status: "closed",
      customer_id: "customer-1",
      customer_name: "QA Multi Hop Race",
      customer_phone: null,
      play_mode: "group",
      ltp_eligible: false,
      ltp_outcome: null,
      ltp_discount_applied: false,
      pricing_snapshot: [],
      pause_log_ids: [],
      continued_from_session_ids: [],
      closed_bill_id: null,
      close_disposition: "hopped",
      close_reason: null,
      created_at: "2026-08-24T11:53:15.991Z"
    };
    const result = buildNormalizedLiveData({
      sessions: [
        {
          ...baseSession,
          id: "session-carried",
          started_at: "2026-08-24T11:41:00.000Z",
          ended_at: "2026-08-24T11:44:00.000Z",
          raw_data: {
            startedAt: "2026-08-24T11:53:15.991Z",
            endedAt: "2026-08-24T11:59:00.000Z"
          }
        },
        {
          ...baseSession,
          id: "session-open",
          started_at: "2026-08-24T12:00:00.000Z",
          ended_at: null,
          status: "active",
          close_disposition: null,
          raw_data: { endedAt: "2026-08-24T12:05:00.000Z", status: "active" }
        },
        {
          ...baseSession,
          id: "session-legacy-null-start",
          started_at: null,
          ended_at: "2026-08-24T11:40:00.000Z",
          raw_data: { startedAt: "2026-08-24T11:39:00.000Z" }
        }
      ],
      sessionPauseLogs: [],
      sessionItems: [],
      sessionComboApplications: [],
      customerTabs: [],
      customerTabItems: [],
      customerTabComboApplications: []
    });

    expect(result.sessions[0]).toMatchObject({
      id: "session-carried",
      startedAt: "2026-08-24T11:41:00.000Z",
      endedAt: "2026-08-24T11:44:00.000Z",
      status: "closed",
      customerName: "QA Multi Hop Race",
      closeDisposition: "hopped"
    });
    expect(result.sessions[1]).toMatchObject({
      id: "session-open",
      startedAt: "2026-08-24T12:00:00.000Z",
      endedAt: undefined
    });
    expect(result.sessions[2]).toMatchObject({
      id: "session-legacy-null-start",
      startedAt: "2026-08-24T11:39:00.000Z",
      endedAt: "2026-08-24T11:40:00.000Z"
    });
  });
});
