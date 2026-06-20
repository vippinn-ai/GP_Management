import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import type {
  AppData,
  BusinessProfile,
  ComboChoiceGroup,
  ComboFixedItem,
  ComboPackage,
  ComboType,
  ComboAppliedChoice,
  ComboInventorySelection,
  CustomerTab,
  CustomerTabItem,
  InventoryItem,
  PricingRule,
  SaleVariant,
  Session,
  SessionComboApplication,
  SessionItem,
  SessionPauseLog,
  LtpOutcome,
  PlayMode,
  SessionStatus,
  StationMode,
  Station
} from "../types";

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

interface ComboRow {
  id: string;
  name: string;
  type: string;
  active: boolean;
  price: number | string;
  included_minutes: number | string;
  raw_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface ComboStationTargetRow {
  combo_id: string;
  station_id: string;
}

interface ComboFixedItemRow {
  combo_id: string;
  id: string;
  sellable_option_id: string;
  quantity: number | string;
  raw_data: Record<string, unknown> | null;
}

interface ComboChoiceGroupRow {
  combo_id: string;
  id: string;
  label: string;
  required_quantity: number | string;
  raw_data: Record<string, unknown> | null;
}

interface ComboChoiceOptionRow {
  combo_id: string;
  choice_group_id: string;
  option_id: string;
}

interface SessionRow {
  id: string;
  station_id: string | null;
  station_name_snapshot: string | null;
  mode: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  play_mode: string;
  ltp_eligible: boolean;
  ltp_outcome: string | null;
  ltp_discount_applied: boolean | null;
  pricing_snapshot: unknown;
  pause_log_ids: unknown;
  continued_from_session_ids: unknown;
  closed_bill_id: string | null;
  close_disposition: string | null;
  close_reason: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface SessionPauseLogRow {
  id: string;
  session_id: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface SaleLineRow {
  id: string;
  inventory_item_id: string | null;
  name: string;
  quantity: number | string;
  unit_price: number | string;
  added_at: string | null;
  sold_as_pack_of: number | string | null;
  sale_variant_id: string | null;
  stock_units_per_sale: number | string | null;
  combo_application_id: string | null;
  combo_id: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface SessionItemRow extends SaleLineRow {
  session_id: string;
}

interface ComboApplicationRow {
  id: string;
  combo_id: string | null;
  combo_name: string;
  price: number | string;
  included_minutes: number | string;
  applied_at: string | null;
  fixed_items: unknown;
  choices: unknown;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface SessionComboApplicationRow extends ComboApplicationRow {
  session_id: string;
}

interface CustomerTabRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  status: string;
  opened_at: string | null;
  closed_at: string | null;
  continued_from_session_ids: unknown;
  closed_bill_id: string | null;
  close_disposition: string | null;
  close_reason: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface CustomerTabItemRow extends SaleLineRow {
  customer_tab_id: string;
}

interface CustomerTabComboApplicationRow extends ComboApplicationRow {
  customer_tab_id: string;
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

export interface NormalizedComboData {
  combos: ComboPackage[];
}

export interface NormalizedLiveData {
  sessions: Session[];
  sessionPauseLogs: SessionPauseLog[];
  customerTabs: CustomerTab[];
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(toRecord).filter((entry) => Object.keys(entry).length > 0) : [];
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

function toOptionalNumber(value: unknown, fallback?: unknown): number | undefined {
  const candidates = [value, fallback];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
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

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
}

function toPositiveInteger(value: unknown, fallback: unknown): number {
  return Math.max(1, Math.trunc(toNumberValue(value, fallback)));
}

function toComboType(value: unknown, fallback: ComboType = "game"): ComboType {
  return value === "consumables" || value === "game" ? value : fallback;
}

function toStationMode(value: unknown, fallback: StationMode = "timed"): StationMode {
  return value === "timed" || value === "unit_sale" ? value : fallback;
}

function toSessionStatus(value: unknown, fallback: SessionStatus = "active"): SessionStatus {
  return value === "active" || value === "paused" || value === "closed" ? value : fallback;
}

function toPlayMode(value: unknown, fallback: PlayMode = "group"): PlayMode {
  return value === "group" || value === "solo" ? value : fallback;
}

function toLtpOutcome(value: unknown): LtpOutcome | undefined {
  return value === "won" || value === "lost" ? value : undefined;
}

function toSessionCloseDisposition(value: unknown): Session["closeDisposition"] | undefined {
  return value === "billed" || value === "rejected" || value === "hopped" ? value : undefined;
}

function toCustomerTabCloseDisposition(value: unknown): CustomerTab["closeDisposition"] | undefined {
  return value === "billed" || value === "rejected" ? value : undefined;
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

function mapNormalizedComboFixedItem(row: ComboFixedItemRow): ComboFixedItem {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    sellableOptionId: toStringValue(row.sellable_option_id, toStringValue(raw.sellableOptionId, "")),
    quantity: toPositiveInteger(row.quantity, raw.quantity ?? 1)
  };
}

function mapRawComboFixedItems(value: unknown): ComboFixedItem[] {
  return toRecordArray(value)
    .map((raw) => ({
      id: toStringValue(raw.id, ""),
      sellableOptionId: toStringValue(raw.sellableOptionId, ""),
      quantity: toPositiveInteger(raw.quantity, 1)
    }))
    .filter((item) => item.id);
}

function mapNormalizedComboChoiceGroup(row: ComboChoiceGroupRow, optionIds: string[] = []): ComboChoiceGroup {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    label: toStringValue(row.label, toStringValue(raw.label, "Choice group")),
    requiredQuantity: toPositiveInteger(row.required_quantity, raw.requiredQuantity ?? 1),
    optionIds: optionIds.length > 0 ? optionIds : toStringArray(raw.optionIds)
  };
}

function mapRawComboChoiceGroups(value: unknown): ComboChoiceGroup[] {
  return toRecordArray(value)
    .map((raw) => ({
      id: toStringValue(raw.id, ""),
      label: toStringValue(raw.label, "Choice group"),
      requiredQuantity: toPositiveInteger(raw.requiredQuantity, 1),
      optionIds: toStringArray(raw.optionIds)
    }))
    .filter((group) => group.id);
}

export function mapNormalizedComboPackage(
  row: ComboRow,
  params: {
    stationIds?: string[];
    fixedItems?: ComboFixedItem[];
    choiceGroups?: ComboChoiceGroup[];
  } = {}
): ComboPackage {
  const raw = toRecord(row.raw_data);
  const comboType = toComboType(row.type, toComboType(raw.type, "game"));
  const fixedItems = params.fixedItems && params.fixedItems.length > 0 ? params.fixedItems : mapRawComboFixedItems(raw.fixedItems);
  const choiceGroups =
    params.choiceGroups && params.choiceGroups.length > 0 ? params.choiceGroups : mapRawComboChoiceGroups(raw.choiceGroups);
  const stationIds = params.stationIds && params.stationIds.length > 0 ? params.stationIds : toStringArray(raw.stationIds);

  return {
    id: row.id,
    name: toStringValue(row.name, toStringValue(raw.name, "Unnamed combo")),
    type: comboType,
    active: toBooleanValue(row.active, toBooleanValue(raw.active, true)),
    stationIds: comboType === "consumables" ? [] : stationIds,
    price: toNumberValue(row.price, raw.price),
    includedMinutes: comboType === "consumables" ? 0 : toPositiveInteger(row.included_minutes, raw.includedMinutes ?? 60),
    fixedItems,
    choiceGroups,
    createdAt: toStringValue(row.created_at, toStringValue(raw.createdAt, new Date().toISOString())),
    updatedAt: toStringValue(row.updated_at, toStringValue(raw.updatedAt, toStringValue(raw.createdAt, new Date().toISOString())))
  };
}

function mapComboInventorySelection(raw: Record<string, unknown>): ComboInventorySelection | undefined {
  const inventoryItemId = toStringValue(raw.inventoryItemId, "");
  if (!inventoryItemId) {
    return undefined;
  }
  const name = toStringValue(raw.name, inventoryItemId);
  return {
    inventoryItemId,
    saleVariantId: toOptionalString(raw.saleVariantId),
    name,
    sourceName: toStringValue(raw.sourceName, name),
    quantity: toNumberValue(raw.quantity, 0),
    unitPrice: toNumberValue(raw.unitPrice, 0),
    stockUnitsPerSale: toNumberValue(raw.stockUnitsPerSale, 1)
  };
}

function mapComboInventorySelections(value: unknown): ComboInventorySelection[] {
  return toRecordArray(value)
    .map(mapComboInventorySelection)
    .filter((selection): selection is ComboInventorySelection => Boolean(selection));
}

function mapComboAppliedChoice(raw: Record<string, unknown>): ComboAppliedChoice | undefined {
  const groupId = toStringValue(raw.groupId, "");
  if (!groupId) {
    return undefined;
  }
  const selections = mapComboInventorySelections(raw.selections);
  const legacySelection = mapComboInventorySelection(toRecord(raw.selection));
  return {
    groupId,
    groupLabel: toStringValue(raw.groupLabel, "Choice group"),
    selections: selections.length > 0 ? selections : legacySelection ? [legacySelection] : [],
    selection: legacySelection
  };
}

function mapComboAppliedChoices(value: unknown): ComboAppliedChoice[] {
  return toRecordArray(value)
    .map(mapComboAppliedChoice)
    .filter((choice): choice is ComboAppliedChoice => Boolean(choice));
}

function mapNormalizedSaleLine(row: SaleLineRow): SessionItem {
  const raw = toRecord(row.raw_data);
  const soldAsPackOf = toOptionalNumber(raw.soldAsPackOf, row.sold_as_pack_of);
  const stockUnitsPerSale = toOptionalNumber(raw.stockUnitsPerSale, row.stock_units_per_sale);
  return {
    id: row.id,
    inventoryItemId: toStringValue(raw.inventoryItemId, row.inventory_item_id ?? ""),
    name: toStringValue(raw.name, row.name),
    quantity: toNumberValue(raw.quantity, row.quantity),
    unitPrice: toNumberValue(raw.unitPrice, row.unit_price),
    addedAt: toStringValue(raw.addedAt, row.added_at ?? row.created_at),
    soldAsPackOf,
    saleVariantId: toOptionalString(raw.saleVariantId) ?? toOptionalString(row.sale_variant_id),
    stockUnitsPerSale,
    comboApplicationId: toOptionalString(raw.comboApplicationId) ?? toOptionalString(row.combo_application_id),
    comboId: toOptionalString(raw.comboId) ?? toOptionalString(row.combo_id)
  };
}

function mapNormalizedComboApplication(row: ComboApplicationRow): SessionComboApplication {
  const raw = toRecord(row.raw_data);
  const rawFixedItems = mapComboInventorySelections(raw.fixedItems);
  const rawChoices = mapComboAppliedChoices(raw.choices);
  const fixedItems = rawFixedItems.length > 0 ? rawFixedItems : mapComboInventorySelections(row.fixed_items);
  const choices = rawChoices.length > 0 ? rawChoices : mapComboAppliedChoices(row.choices);
  return {
    id: row.id,
    comboId: toStringValue(raw.comboId, row.combo_id ?? ""),
    comboName: toStringValue(raw.comboName, row.combo_name),
    price: toNumberValue(raw.price, row.price),
    includedMinutes: toNumberValue(raw.includedMinutes, row.included_minutes),
    appliedAt: toStringValue(raw.appliedAt, row.applied_at ?? row.created_at),
    fixedItems,
    choices
  };
}

function mapNormalizedSessionPauseLog(row: SessionPauseLogRow): SessionPauseLog {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    sessionId: toStringValue(raw.sessionId, row.session_id ?? ""),
    pausedAt: toStringValue(raw.pausedAt, row.paused_at ?? row.created_at),
    resumedAt: toOptionalString(raw.resumedAt) ?? toOptionalString(row.resumed_at)
  };
}

function groupByOwnerId<T>(rows: T[], getOwnerId: (row: T) => string | null | undefined): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  rows.forEach((row) => {
    const ownerId = getOwnerId(row);
    if (!ownerId) {
      return;
    }
    const ownerRows = grouped.get(ownerId) ?? [];
    ownerRows.push(row);
    grouped.set(ownerId, ownerRows);
  });
  return grouped;
}

function mapNormalizedSession(
  row: SessionRow,
  params: {
    items?: SessionItemRow[];
    pauseLogs?: SessionPauseLog[];
    comboApplications?: SessionComboApplicationRow[];
  } = {}
): Session {
  const raw = toRecord(row.raw_data);
  const rawPauseLogIds = toStringArray(raw.pauseLogIds);
  const rowPauseLogIds = toStringArray(row.pause_log_ids);
  const groupedPauseLogIds = (params.pauseLogs ?? []).map((log) => log.id);
  return {
    id: row.id,
    stationId: toStringValue(raw.stationId, row.station_id ?? ""),
    stationNameSnapshot: toStringValue(raw.stationNameSnapshot, row.station_name_snapshot ?? ""),
    mode: toStationMode(raw.mode, toStationMode(row.mode)),
    startedAt: toStringValue(raw.startedAt, row.started_at ?? row.created_at),
    endedAt: toOptionalString(raw.endedAt) ?? toOptionalString(row.ended_at),
    status: toSessionStatus(raw.status, toSessionStatus(row.status)),
    customerId: toOptionalString(raw.customerId) ?? toOptionalString(row.customer_id),
    customerName: toOptionalString(raw.customerName) ?? toOptionalString(row.customer_name),
    customerPhone: toOptionalString(raw.customerPhone) ?? toOptionalString(row.customer_phone),
    playMode: toPlayMode(raw.playMode, toPlayMode(row.play_mode)),
    ltpEligible: toBooleanValue(raw.ltpEligible, row.ltp_eligible),
    ltpOutcome: toLtpOutcome(raw.ltpOutcome) ?? toLtpOutcome(row.ltp_outcome),
    ltpDiscountApplied:
      typeof raw.ltpDiscountApplied === "boolean"
        ? raw.ltpDiscountApplied
        : typeof row.ltp_discount_applied === "boolean"
          ? row.ltp_discount_applied
          : undefined,
    pricingSnapshot:
      toRecordArray(raw.pricingSnapshot).length > 0
        ? (raw.pricingSnapshot as PricingRule[])
        : toRecordArray(row.pricing_snapshot).map((entry) => ({
            id: toStringValue(entry.id, ""),
            stationId: toStringValue(entry.stationId, ""),
            label: toStringValue(entry.label, ""),
            startMinute: toNumberValue(entry.startMinute, 0),
            endMinute: toNumberValue(entry.endMinute, 0),
            hourlyRate: toNumberValue(entry.hourlyRate, 0)
          })),
    items: (params.items ?? []).map(mapNormalizedSaleLine),
    comboApplications: (params.comboApplications ?? []).map(mapNormalizedComboApplication),
    pauseLogIds:
      rawPauseLogIds.length > 0 ? rawPauseLogIds : rowPauseLogIds.length > 0 ? rowPauseLogIds : groupedPauseLogIds,
    continuedFromSessionIds: toStringArray(raw.continuedFromSessionIds).length
      ? toStringArray(raw.continuedFromSessionIds)
      : toStringArray(row.continued_from_session_ids).length
        ? toStringArray(row.continued_from_session_ids)
        : undefined,
    closedBillId: toOptionalString(raw.closedBillId) ?? toOptionalString(row.closed_bill_id),
    closeDisposition: toSessionCloseDisposition(raw.closeDisposition) ?? toSessionCloseDisposition(row.close_disposition),
    closeReason: toOptionalString(raw.closeReason) ?? toOptionalString(row.close_reason)
  };
}

function mapNormalizedCustomerTab(
  row: CustomerTabRow,
  params: {
    items?: CustomerTabItemRow[];
    comboApplications?: CustomerTabComboApplicationRow[];
  } = {}
): CustomerTab {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    customerId: toOptionalString(raw.customerId) ?? toOptionalString(row.customer_id),
    customerName: toStringValue(raw.customerName, row.customer_name),
    customerPhone: toOptionalString(raw.customerPhone) ?? toOptionalString(row.customer_phone),
    status: row.status === "closed" || raw.status === "closed" ? "closed" : "open",
    createdAt: toStringValue(raw.createdAt, row.opened_at ?? row.created_at),
    closedAt: toOptionalString(raw.closedAt) ?? toOptionalString(row.closed_at),
    items: (params.items ?? []).map(mapNormalizedSaleLine) as CustomerTabItem[],
    comboApplications: (params.comboApplications ?? []).map(mapNormalizedComboApplication),
    continuedFromSessionIds: toStringArray(raw.continuedFromSessionIds).length
      ? toStringArray(raw.continuedFromSessionIds)
      : toStringArray(row.continued_from_session_ids).length
        ? toStringArray(row.continued_from_session_ids)
        : undefined,
    closedBillId: toOptionalString(raw.closedBillId) ?? toOptionalString(row.closed_bill_id),
    closeDisposition:
      toCustomerTabCloseDisposition(raw.closeDisposition) ?? toCustomerTabCloseDisposition(row.close_disposition),
    closeReason: toOptionalString(raw.closeReason) ?? toOptionalString(row.close_reason)
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

export function buildNormalizedComboData(params: {
  combos: ComboRow[];
  stationTargets: ComboStationTargetRow[];
  fixedItems: ComboFixedItemRow[];
  choiceGroups: ComboChoiceGroupRow[];
  choiceOptions: ComboChoiceOptionRow[];
}): NormalizedComboData {
  const stationIdsByComboId = new Map<string, string[]>();
  params.stationTargets.forEach((row) => {
    const stationIds = stationIdsByComboId.get(row.combo_id) ?? [];
    stationIds.push(row.station_id);
    stationIdsByComboId.set(row.combo_id, stationIds);
  });

  const fixedItemsByComboId = new Map<string, ComboFixedItem[]>();
  params.fixedItems.forEach((row) => {
    const fixedItems = fixedItemsByComboId.get(row.combo_id) ?? [];
    fixedItems.push(mapNormalizedComboFixedItem(row));
    fixedItemsByComboId.set(row.combo_id, fixedItems);
  });

  const optionIdsByGroupKey = new Map<string, string[]>();
  params.choiceOptions.forEach((row) => {
    const groupKey = `${row.combo_id}:${row.choice_group_id}`;
    const optionIds = optionIdsByGroupKey.get(groupKey) ?? [];
    optionIds.push(row.option_id);
    optionIdsByGroupKey.set(groupKey, optionIds);
  });

  const choiceGroupsByComboId = new Map<string, ComboChoiceGroup[]>();
  params.choiceGroups.forEach((row) => {
    const choiceGroups = choiceGroupsByComboId.get(row.combo_id) ?? [];
    choiceGroups.push(mapNormalizedComboChoiceGroup(row, optionIdsByGroupKey.get(`${row.combo_id}:${row.id}`) ?? []));
    choiceGroupsByComboId.set(row.combo_id, choiceGroups);
  });

  return {
    combos: params.combos.map((row) =>
      mapNormalizedComboPackage(row, {
        stationIds: stationIdsByComboId.get(row.id) ?? [],
        fixedItems: fixedItemsByComboId.get(row.id) ?? [],
        choiceGroups: choiceGroupsByComboId.get(row.id) ?? []
      })
    )
  };
}

export function buildNormalizedLiveData(params: {
  sessions: SessionRow[];
  sessionPauseLogs: SessionPauseLogRow[];
  sessionItems: SessionItemRow[];
  sessionComboApplications: SessionComboApplicationRow[];
  customerTabs: CustomerTabRow[];
  customerTabItems: CustomerTabItemRow[];
  customerTabComboApplications: CustomerTabComboApplicationRow[];
}): NormalizedLiveData {
  const sessionItemsBySessionId = groupByOwnerId(params.sessionItems, (row) => row.session_id);
  const sessionComboApplicationsBySessionId = groupByOwnerId(params.sessionComboApplications, (row) => row.session_id);
  const pauseLogs = params.sessionPauseLogs.map(mapNormalizedSessionPauseLog);
  const pauseLogsBySessionId = groupByOwnerId(pauseLogs, (row) => row.sessionId);
  const customerTabItemsByTabId = groupByOwnerId(params.customerTabItems, (row) => row.customer_tab_id);
  const customerTabComboApplicationsByTabId = groupByOwnerId(
    params.customerTabComboApplications,
    (row) => row.customer_tab_id
  );

  return {
    sessions: params.sessions.map((row) =>
      mapNormalizedSession(row, {
        items: sessionItemsBySessionId.get(row.id) ?? [],
        pauseLogs: pauseLogsBySessionId.get(row.id) ?? [],
        comboApplications: sessionComboApplicationsBySessionId.get(row.id) ?? []
      })
    ),
    sessionPauseLogs: pauseLogs,
    customerTabs: params.customerTabs.map((row) =>
      mapNormalizedCustomerTab(row, {
        items: customerTabItemsByTabId.get(row.id) ?? [],
        comboApplications: customerTabComboApplicationsByTabId.get(row.id) ?? []
      })
    )
  };
}

export async function loadNormalizedActiveOrganization(client: SupabaseClient = getSupabaseClient()): Promise<OrganizationRow> {
  return assertNormalizedResult(
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
}

export async function loadNormalizedConfigData(client: SupabaseClient = getSupabaseClient()): Promise<NormalizedConfigData> {
  const organization = await loadNormalizedActiveOrganization(client);

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

export async function loadNormalizedComboData(
  organizationId: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedComboData> {
  const [combos, stationTargets, fixedItems, choiceGroups, choiceOptions] = await Promise.all([
    readMany<ComboRow>(
      client
        .from("combos")
        .select("id, name, type, active, price, included_minutes, raw_data, created_at, updated_at")
        .eq("organization_id", organizationId)
        .order("name", { ascending: true }),
      "loading normalized combos"
    ),
    readMany<ComboStationTargetRow>(
      client
        .from("combo_station_targets")
        .select("combo_id, station_id")
        .eq("organization_id", organizationId)
        .order("combo_id", { ascending: true })
        .order("station_id", { ascending: true }),
      "loading normalized combo station targets"
    ),
    readMany<ComboFixedItemRow>(
      client
        .from("combo_fixed_items")
        .select("combo_id, id, sellable_option_id, quantity, raw_data")
        .eq("organization_id", organizationId)
        .order("combo_id", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      "loading normalized combo fixed items"
    ),
    readMany<ComboChoiceGroupRow>(
      client
        .from("combo_choice_groups")
        .select("combo_id, id, label, required_quantity, raw_data")
        .eq("organization_id", organizationId)
        .order("combo_id", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      "loading normalized combo choice groups"
    ),
    readMany<ComboChoiceOptionRow>(
      client
        .from("combo_choice_options")
        .select("combo_id, choice_group_id, option_id")
        .eq("organization_id", organizationId)
        .order("combo_id", { ascending: true })
        .order("choice_group_id", { ascending: true })
        .order("option_id", { ascending: true }),
      "loading normalized combo choice options"
    )
  ]);

  return buildNormalizedComboData({ combos, stationTargets, fixedItems, choiceGroups, choiceOptions });
}

export async function loadNormalizedLiveData(
  organizationId: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedLiveData> {
  const [sessions, customerTabs] = await Promise.all([
    readMany<SessionRow>(
      client
        .from("sessions")
        .select(
          "id, station_id, station_name_snapshot, mode, started_at, ended_at, status, customer_id, customer_name, customer_phone, play_mode, ltp_eligible, ltp_outcome, ltp_discount_applied, pricing_snapshot, pause_log_ids, continued_from_session_ids, closed_bill_id, close_disposition, close_reason, raw_data, created_at"
        )
        .eq("organization_id", organizationId)
        .neq("status", "closed")
        .order("started_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading normalized open sessions"
    ),
    readMany<CustomerTabRow>(
      client
        .from("customer_tabs")
        .select(
          "id, customer_id, customer_name, customer_phone, status, opened_at, closed_at, continued_from_session_ids, closed_bill_id, close_disposition, close_reason, raw_data, created_at"
        )
        .eq("organization_id", organizationId)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading normalized open customer tabs"
    )
  ]);

  const sessionIds = sessions.map((session) => session.id);
  const customerTabIds = customerTabs.map((tab) => tab.id);

  const [sessionPauseLogs, sessionItems, sessionComboApplications, customerTabItems, customerTabComboApplications] =
    await Promise.all([
      sessionIds.length > 0
        ? readMany<SessionPauseLogRow>(
            client
              .from("session_pause_logs")
              .select("id, session_id, paused_at, resumed_at, raw_data, created_at")
              .eq("organization_id", organizationId)
              .in("session_id", sessionIds)
              .order("paused_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized open session pause logs"
          )
        : Promise.resolve([]),
      sessionIds.length > 0
        ? readMany<SessionItemRow>(
            client
              .from("session_items")
              .select(
                "session_id, id, inventory_item_id, name, quantity, unit_price, added_at, sold_as_pack_of, sale_variant_id, stock_units_per_sale, combo_application_id, combo_id, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("session_id", sessionIds)
              .order("added_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized open session items"
          )
        : Promise.resolve([]),
      sessionIds.length > 0
        ? readMany<SessionComboApplicationRow>(
            client
              .from("session_combo_applications")
              .select(
                "session_id, id, combo_id, combo_name, price, included_minutes, applied_at, fixed_items, choices, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("session_id", sessionIds)
              .order("applied_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized open session combo applications"
          )
        : Promise.resolve([]),
      customerTabIds.length > 0
        ? readMany<CustomerTabItemRow>(
            client
              .from("customer_tab_items")
              .select(
                "customer_tab_id, id, inventory_item_id, name, quantity, unit_price, added_at, sold_as_pack_of, sale_variant_id, stock_units_per_sale, combo_application_id, combo_id, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("customer_tab_id", customerTabIds)
              .order("added_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized open customer tab items"
          )
        : Promise.resolve([]),
      customerTabIds.length > 0
        ? readMany<CustomerTabComboApplicationRow>(
            client
              .from("customer_tab_combo_applications")
              .select(
                "customer_tab_id, id, combo_id, combo_name, price, included_minutes, applied_at, fixed_items, choices, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("customer_tab_id", customerTabIds)
              .order("applied_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized open customer tab combo applications"
          )
        : Promise.resolve([])
    ]);

  return buildNormalizedLiveData({
    sessions,
    sessionPauseLogs,
    sessionItems,
    sessionComboApplications,
    customerTabs,
    customerTabItems,
    customerTabComboApplications
  });
}

export async function loadNormalizedAppDataOverlay(params: {
  normalizedConfigReads: boolean;
  normalizedCatalogReads: boolean;
  normalizedComboReads: boolean;
  normalizedLiveReads?: boolean;
  client?: SupabaseClient;
}): Promise<{ organizationId?: string; appData: Partial<AppData> }> {
  const client = params.client ?? getSupabaseClient();
  const overlay: Partial<AppData> = {};
  let organizationId: string | undefined;

  if (params.normalizedConfigReads) {
    const configData = await loadNormalizedConfigData(client);
    organizationId = configData.organizationId;
    overlay.businessProfile = configData.businessProfile;
    overlay.inventoryCategories = configData.inventoryCategories;
    overlay.stations = configData.stations;
    overlay.pricingRules = configData.pricingRules;
  } else if (params.normalizedCatalogReads || params.normalizedComboReads || params.normalizedLiveReads) {
    const organization = await loadNormalizedActiveOrganization(client);
    organizationId = organization.id;
  }

  if (params.normalizedCatalogReads) {
    if (!organizationId) {
      throw new Error("Normalized catalog reads require an active organization.");
    }
    const catalogData = await loadNormalizedCatalogData(organizationId, client);
    overlay.inventoryItems = catalogData.inventoryItems;
  }

  if (params.normalizedComboReads) {
    if (!organizationId) {
      throw new Error("Normalized combo reads require an active organization.");
    }
    const comboData = await loadNormalizedComboData(organizationId, client);
    overlay.combos = comboData.combos;
  }

  if (params.normalizedLiveReads) {
    if (!organizationId) {
      throw new Error("Normalized live reads require an active organization.");
    }
    const liveData = await loadNormalizedLiveData(organizationId, client);
    overlay.sessions = liveData.sessions;
    overlay.sessionPauseLogs = liveData.sessionPauseLogs;
    overlay.customerTabs = liveData.customerTabs;
  }

  return { organizationId, appData: overlay };
}
