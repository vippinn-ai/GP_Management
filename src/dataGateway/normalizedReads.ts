import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import type { AppData, BusinessProfile, InventoryItem, PricingRule, SaleVariant, Station } from "../types";

const NORMALIZED_READ_TIMEOUT_MS = 15_000;

interface OrganizationRow {
  id: string;
  name: string;
  business_profile: Record<string, unknown> | null;
}

interface InventoryCategoryRow {
  name: string;
}

interface StationRow {
  id: string;
  name: string;
  mode: string;
  active: boolean;
  ltp_enabled: boolean;
  notes: string | null;
  raw_data: Record<string, unknown> | null;
}

interface PricingRuleRow {
  id: string;
  station_id: string | null;
  label: string;
  start_minute: number | string;
  end_minute: number | string;
  hourly_rate: number | string;
  raw_data: Record<string, unknown> | null;
}

interface InventoryItemRow {
  id: string;
  name: string;
  category: string | null;
  price: number | string;
  stock_qty: number | string;
  low_stock_threshold: number | string;
  unit: string;
  is_reusable: boolean;
  barcode: string | null;
  active: boolean;
  archived_at: string | null;
  archived_by_user_id: string | null;
  archive_reason: string | null;
  sell_base_item: boolean;
  cigarette_pack: Record<string, unknown> | null;
  raw_data: Record<string, unknown> | null;
}

interface SaleVariantRow {
  inventory_item_id: string;
  id: string;
  name: string;
  price: number | string;
  stock_units_per_sale: number | string;
  barcode: string | null;
  active: boolean;
  raw_data: Record<string, unknown> | null;
}

interface NormalizedQueryResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

export interface NormalizedConfigData {
  organizationId: string;
  businessProfile: BusinessProfile;
  inventoryCategories: string[];
  stations: Station[];
  pricingRules: PricingRule[];
}

export interface NormalizedCatalogData {
  inventoryItems: InventoryItem[];
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toStringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function toNumberValue(value: unknown, fallback: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return fallback;
  }
  if (typeof fallback === "string" && fallback.trim()) {
    const parsed = Number(fallback);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return fallback;
}

async function withNormalizedReadTimeout<T>(request: PromiseLike<T>, action: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach normalized data while ${action}.`));
    }, NORMALIZED_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function assertNormalizedResult<T>(result: NormalizedQueryResult<T>, action: string): T {
  if (result.error) {
    throw result.error;
  }
  if (result.data === null) {
    throw new Error(`Normalized data was unavailable while ${action}.`);
  }
  return result.data;
}

async function readMany<T>(request: PromiseLike<NormalizedQueryResult<T[]>>, action: string): Promise<T[]> {
  const result = await withNormalizedReadTimeout(request, action);
  if (result.error) {
    throw result.error;
  }
  return result.data ?? [];
}

export function mapNormalizedBusinessProfile(row: OrganizationRow): BusinessProfile {
  const raw = toRecord(row.business_profile);
  return {
    name: toStringValue(raw.name, row.name),
    logoText: toStringValue(raw.logoText, ""),
    address: toStringValue(raw.address, ""),
    primaryPhone: toStringValue(raw.primaryPhone, ""),
    secondaryPhone: toOptionalString(raw.secondaryPhone),
    receiptFooter: toStringValue(raw.receiptFooter, "")
  };
}

export function mapNormalizedStation(row: StationRow): Station {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    name: row.name,
    mode: toStringValue(raw.mode, row.mode) as Station["mode"],
    active: toBooleanValue(raw.active, row.active),
    ltpEnabled: toBooleanValue(raw.ltpEnabled, row.ltp_enabled),
    notes: toOptionalString(raw.notes) ?? toOptionalString(row.notes)
  };
}

export function mapNormalizedPricingRule(row: PricingRuleRow): PricingRule {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    stationId: toStringValue(raw.stationId, row.station_id ?? ""),
    label: row.label,
    startMinute: toNumberValue(raw.startMinute, row.start_minute),
    endMinute: toNumberValue(raw.endMinute, row.end_minute),
    hourlyRate: toNumberValue(raw.hourlyRate, row.hourly_rate)
  };
}

export function mapNormalizedSaleVariant(row: SaleVariantRow): SaleVariant {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    name: row.name,
    price: toNumberValue(raw.price, row.price),
    stockUnitsPerSale: toNumberValue(raw.stockUnitsPerSale, row.stock_units_per_sale),
    barcode: toOptionalString(raw.barcode) ?? toOptionalString(row.barcode),
    active: toBooleanValue(raw.active, row.active)
  };
}

export function mapNormalizedInventoryItem(row: InventoryItemRow, saleVariants: SaleVariant[] = []): InventoryItem {
  const raw = toRecord(row.raw_data);
  const cigarettePack = toRecord(row.cigarette_pack);
  return {
    id: row.id,
    name: row.name,
    category: toStringValue(raw.category, row.category ?? ""),
    price: toNumberValue(raw.price, row.price),
    stockQty: toNumberValue(raw.stockQty, row.stock_qty),
    lowStockThreshold: toNumberValue(raw.lowStockThreshold, row.low_stock_threshold),
    unit: toStringValue(raw.unit, row.unit),
    isReusable: toBooleanValue(raw.isReusable, row.is_reusable),
    barcode: toOptionalString(raw.barcode) ?? toOptionalString(row.barcode),
    active: toBooleanValue(raw.active, row.active),
    archivedAt: toOptionalString(raw.archivedAt) ?? toOptionalString(row.archived_at),
    archivedByUserId: toOptionalString(raw.archivedByUserId) ?? toOptionalString(row.archived_by_user_id),
    archiveReason: toOptionalString(raw.archiveReason) ?? toOptionalString(row.archive_reason),
    cigarettePack:
      Object.keys(cigarettePack).length > 0
        ? {
            size: toNumberValue(cigarettePack.size, 0),
            packPrice: toNumberValue(cigarettePack.packPrice, 0)
          }
        : undefined,
    sellBaseItem: toBooleanValue(raw.sellBaseItem, row.sell_base_item),
    saleVariants
  };
}

export function buildNormalizedConfigData(params: {
  organization: OrganizationRow;
  inventoryCategories: InventoryCategoryRow[];
  stations: StationRow[];
  pricingRules: PricingRuleRow[];
}): NormalizedConfigData {
  return {
    organizationId: params.organization.id,
    businessProfile: mapNormalizedBusinessProfile(params.organization),
    inventoryCategories: params.inventoryCategories.map((row) => row.name).filter(Boolean),
    stations: params.stations.map(mapNormalizedStation),
    pricingRules: params.pricingRules.map(mapNormalizedPricingRule)
  };
}

export function buildNormalizedCatalogData(params: {
  inventoryItems: InventoryItemRow[];
  saleVariants: SaleVariantRow[];
}): NormalizedCatalogData {
  const variantsByItemId = new Map<string, SaleVariant[]>();
  params.saleVariants.forEach((row) => {
    const variants = variantsByItemId.get(row.inventory_item_id) ?? [];
    variants.push(mapNormalizedSaleVariant(row));
    variantsByItemId.set(row.inventory_item_id, variants);
  });
  return {
    inventoryItems: params.inventoryItems.map((row) => mapNormalizedInventoryItem(row, variantsByItemId.get(row.id) ?? []))
  };
}

export async function loadNormalizedConfigData(client: SupabaseClient = getSupabaseClient()): Promise<NormalizedConfigData> {
  const organization = assertNormalizedResult(
    await withNormalizedReadTimeout(
      client
        .from("organizations")
        .select("id, name, business_profile")
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      "loading the active organization"
    ),
    "loading the active organization"
  ) as OrganizationRow;

  const organizationId = organization.id;
  const [inventoryCategories, stations, pricingRules] = await Promise.all([
    readMany<InventoryCategoryRow>(
      client
        .from("inventory_categories")
        .select("name")
        .eq("organization_id", organizationId)
        .order("name", { ascending: true }),
      "loading normalized inventory categories"
    ),
    readMany<StationRow>(
      client
        .from("stations")
        .select("id, name, mode, active, ltp_enabled, notes, raw_data")
        .eq("organization_id", organizationId)
        .order("name", { ascending: true }),
      "loading normalized stations"
    ),
    readMany<PricingRuleRow>(
      client
        .from("pricing_rules")
        .select("id, station_id, label, start_minute, end_minute, hourly_rate, raw_data")
        .eq("organization_id", organizationId)
        .order("station_id", { ascending: true })
        .order("start_minute", { ascending: true }),
      "loading normalized pricing rules"
    )
  ]);

  return buildNormalizedConfigData({ organization, inventoryCategories, stations, pricingRules });
}

export async function loadNormalizedCatalogData(
  organizationId: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedCatalogData> {
  const [inventoryItems, saleVariants] = await Promise.all([
    readMany<InventoryItemRow>(
      client
        .from("inventory_items")
        .select(
          "id, name, category, price, stock_qty, low_stock_threshold, unit, is_reusable, barcode, active, archived_at, archived_by_user_id, archive_reason, sell_base_item, cigarette_pack, raw_data"
        )
        .eq("organization_id", organizationId)
        .order("category", { ascending: true })
        .order("name", { ascending: true }),
      "loading normalized inventory items"
    ),
    readMany<SaleVariantRow>(
      client
        .from("sale_variants")
        .select("inventory_item_id, id, name, price, stock_units_per_sale, barcode, active, raw_data")
        .eq("organization_id", organizationId)
        .order("inventory_item_id", { ascending: true })
        .order("name", { ascending: true }),
      "loading normalized sale variants"
    )
  ]);

  return buildNormalizedCatalogData({ inventoryItems, saleVariants });
}

export async function loadNormalizedAppDataOverlay(params: {
  normalizedConfigReads: boolean;
  normalizedCatalogReads: boolean;
  client?: SupabaseClient;
}): Promise<{ organizationId?: string; appData: Partial<AppData> }> {
  const client = params.client ?? getSupabaseClient();
  const overlay: Partial<AppData> = {};
  let organizationId: string | undefined;

  if (params.normalizedConfigReads || params.normalizedCatalogReads) {
    const configData = await loadNormalizedConfigData(client);
    organizationId = configData.organizationId;
    if (params.normalizedConfigReads) {
      overlay.businessProfile = configData.businessProfile;
      overlay.inventoryCategories = configData.inventoryCategories;
      overlay.stations = configData.stations;
      overlay.pricingRules = configData.pricingRules;
    }
  }

  if (params.normalizedCatalogReads) {
    if (!organizationId) {
      throw new Error("Normalized catalog reads require an active organization.");
    }
    const catalogData = await loadNormalizedCatalogData(organizationId, client);
    overlay.inventoryItems = catalogData.inventoryItems;
  }

  return { organizationId, appData: overlay };
}
