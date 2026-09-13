import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient, type RemoteOrganization, type RemoteProfile } from "../backend";
import { rememberNormalizedOrganizationId } from "./normalizedOrganization";
import type {
  AppData,
  AuditLog,
  BusinessProfile,
  ComboChoiceGroup,
  ComboFixedItem,
  ComboPackage,
  ComboType,
  ComboAppliedChoice,
  ComboInventorySelection,
  Expense,
  ExpensePaymentMode,
  ExpenseTemplate,
  ExpenseTemplateOverride,
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
  Station,
  StockMovement,
  StockMovementType
} from "../types";

const NORMALIZED_READ_TIMEOUT_MS = 15_000;
const NORMALIZED_READ_PAGE_SIZE = 1_000;
const NORMALIZED_READ_MAX_PAGES = 5;
export const OPERATIONAL_BOOTSTRAP_CONTRACT_VERSION = 1;
export const OPERATIONAL_BOOTSTRAP_MAX_PAYLOAD_BYTES = 160_992;

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

export type OperationalBootstrapRpcResult =
  | {
      status: "inactive-or-missing";
      actorId: string;
    }
  | {
      status: "active";
      actorId: string;
      profile: RemoteProfile;
      organization: RemoteOrganization;
      version: number;
      appData: Partial<AppData>;
    };

interface ExpenseRow {
  id: string;
  title: string;
  category: string | null;
  amount: number | string;
  payment_mode: string | null;
  cash_amount: number | string | null;
  upi_amount: number | string | null;
  spent_at: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  raw_data: Record<string, unknown> | null;
}

interface ExpenseTemplateRow {
  id: string;
  title: string;
  category: string | null;
  amount: number | string;
  frequency: string;
  start_month: string | null;
  active: boolean;
  notes: string | null;
  created_by_user_id: string | null;
  raw_data: Record<string, unknown> | null;
}

interface ExpenseTemplateOverrideRow {
  id: string;
  template_id: string | null;
  month_key: string | null;
  amount: number | string | null;
  skip_reason: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  updated_at_source: string | null;
  raw_data: Record<string, unknown> | null;
}

interface AuditLogRow {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  message: string | null;
  audit_at: string | null;
  user_id: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface StockMovementRow {
  id: string;
  item_id: string | null;
  type: string;
  quantity: number | string;
  reason: string | null;
  movement_at: string | null;
  user_id: string | null;
  related_bill_id: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

interface NormalizedQueryResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
  count?: number | null;
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

export interface NormalizedExpenseAdminData {
  expenses: Expense[];
  expenseTemplates: ExpenseTemplate[];
  expenseTemplateOverrides: ExpenseTemplateOverride[];
}

export interface NormalizedStockMovementQuery {
  fromIso?: string;
  toIsoExclusive?: string;
  limit?: number;
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

async function withNormalizedReadTimeout<T>(
  request: PromiseLike<T>,
  action: string,
  timeoutMs = NORMALIZED_READ_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach normalized data while ${action}.`));
    }, timeoutMs);
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
    // Financial validation compares these values with the typed normalized
    // columns. Prefer those columns so stale compatibility JSON cannot corrupt
    // a carried-session checkout. A legacy NULL start may still use raw data.
    startedAt: toStringValue(row.started_at, toStringValue(raw.startedAt, row.created_at)),
    endedAt: row.ended_at === undefined ? toOptionalString(raw.endedAt) : toOptionalString(row.ended_at),
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

function toExpensePaymentMode(value: unknown): ExpensePaymentMode | undefined {
  return value === "cash" || value === "upi" || value === "split" ? value : undefined;
}

export function mapNormalizedExpense(row: ExpenseRow): Expense {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    title: toStringValue(raw.title, row.title),
    category: toStringValue(raw.category, row.category ?? "Miscellaneous"),
    amount: toNumberValue(raw.amount, row.amount),
    paymentMode: toExpensePaymentMode(raw.paymentMode) ?? toExpensePaymentMode(row.payment_mode),
    cashAmount:
      raw.cashAmount !== undefined || row.cash_amount !== null
        ? toNumberValue(raw.cashAmount, row.cash_amount)
        : undefined,
    upiAmount:
      raw.upiAmount !== undefined || row.upi_amount !== null
        ? toNumberValue(raw.upiAmount, row.upi_amount)
        : undefined,
    spentAt: toStringValue(raw.spentAt, row.spent_at ?? ""),
    notes: toOptionalString(raw.notes) ?? toOptionalString(row.notes),
    createdByUserId: toStringValue(raw.createdByUserId, row.created_by_user_id ?? "")
  };
}

export function mapNormalizedExpenseTemplate(row: ExpenseTemplateRow): ExpenseTemplate {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    title: toStringValue(raw.title, row.title),
    category: toStringValue(raw.category, row.category ?? "Miscellaneous"),
    amount: toNumberValue(raw.amount, row.amount),
    frequency: "monthly",
    startMonth: toStringValue(raw.startMonth, row.start_month ?? ""),
    active: toBooleanValue(raw.active, row.active),
    notes: toOptionalString(raw.notes) ?? toOptionalString(row.notes),
    createdByUserId: toStringValue(raw.createdByUserId, row.created_by_user_id ?? "")
  };
}

export function mapNormalizedExpenseTemplateOverride(row: ExpenseTemplateOverrideRow): ExpenseTemplateOverride {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    templateId: toStringValue(raw.templateId, row.template_id ?? ""),
    monthKey: toStringValue(raw.monthKey, row.month_key ?? ""),
    amount:
      raw.amount === null || row.amount === null
        ? null
        : toNumberValue(raw.amount, row.amount),
    skipReason: toOptionalString(raw.skipReason) ?? toOptionalString(row.skip_reason),
    notes: toOptionalString(raw.notes) ?? toOptionalString(row.notes),
    createdByUserId: toStringValue(raw.createdByUserId, row.created_by_user_id ?? ""),
    updatedAt: toStringValue(raw.updatedAt, row.updated_at_source ?? "")
  };
}

export function buildNormalizedExpenseAdminData(params: {
  expenses: ExpenseRow[];
  expenseTemplates: ExpenseTemplateRow[];
  expenseTemplateOverrides: ExpenseTemplateOverrideRow[];
}): NormalizedExpenseAdminData {
  return {
    expenses: params.expenses.map(mapNormalizedExpense),
    expenseTemplates: params.expenseTemplates.map(mapNormalizedExpenseTemplate),
    expenseTemplateOverrides: params.expenseTemplateOverrides.map(mapNormalizedExpenseTemplateOverride)
  };
}

function toStockMovementType(value: unknown): StockMovementType {
  return value === "restock" ||
    value === "sale" ||
    value === "adjustment" ||
    value === "void_refund_reversal" ||
    value === "session_reservation" ||
    value === "session_reservation_void"
    ? value
    : "adjustment";
}

export function mapNormalizedStockMovement(row: StockMovementRow): StockMovement {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    itemId: toStringValue(raw.itemId, row.item_id ?? ""),
    type: toStockMovementType(raw.type ?? row.type),
    quantity: toNumberValue(raw.quantity, row.quantity),
    reason: toStringValue(raw.reason, row.reason ?? ""),
    createdAt: toStringValue(raw.createdAt, row.movement_at ?? row.created_at),
    userId: toStringValue(raw.userId, row.user_id ?? ""),
    relatedBillId: toOptionalString(raw.relatedBillId) ?? toOptionalString(row.related_bill_id)
  };
}

export function mapNormalizedAuditLog(row: AuditLogRow): AuditLog {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    action: toStringValue(raw.action, row.action),
    entityType: toStringValue(raw.entityType, row.entity_type ?? ""),
    entityId: toStringValue(raw.entityId, row.entity_id ?? ""),
    message: toStringValue(raw.message, row.message ?? ""),
    // The typed timestamp is the normalized source of truth. Legacy/raw JSON may
    // contain a timezone-less value, which browsers otherwise interpret as local
    // time and display several hours away from the actual audit event.
    createdAt: toStringValue(row.audit_at, toStringValue(raw.createdAt, row.created_at)),
    userId: toStringValue(raw.userId, row.user_id ?? "")
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

function requireBootstrapRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireBootstrapText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
  return value;
}

const BOOTSTRAP_ROW_KEYS: Record<string, readonly string[]> = {
  profiles: ["organization_id", "id", "name", "username", "role", "active", "tabPermissions"],
  inventory_categories: ["organization_id", "name"],
  stations: ["organization_id", "id", "name", "mode", "active", "ltp_enabled", "notes", "raw_data"],
  pricing_rules: ["organization_id", "id", "station_id", "label", "start_minute", "end_minute", "hourly_rate", "raw_data"],
  inventory_items: [
    "organization_id", "id", "name", "category", "price", "stock_qty", "low_stock_threshold", "unit",
    "is_reusable", "barcode", "active", "archived_at", "archived_by_user_id", "archive_reason",
    "sell_base_item", "cigarette_pack", "raw_data"
  ],
  sale_variants: [
    "organization_id", "inventory_item_id", "id", "name", "price", "stock_units_per_sale",
    "barcode", "active", "raw_data"
  ],
  combos: [
    "organization_id", "id", "name", "type", "active", "price", "included_minutes", "raw_data",
    "created_at", "updated_at"
  ],
  combo_station_targets: ["organization_id", "combo_id", "station_id"],
  combo_fixed_items: [
    "organization_id", "combo_id", "id", "sellable_option_id", "quantity", "raw_data", "created_at"
  ],
  combo_choice_groups: [
    "organization_id", "combo_id", "id", "label", "required_quantity", "raw_data", "created_at"
  ],
  combo_choice_options: ["organization_id", "combo_id", "choice_group_id", "option_id"],
  sessions: [
    "organization_id", "id", "station_id", "station_name_snapshot", "mode", "started_at", "ended_at",
    "status", "customer_id", "customer_name", "customer_phone", "play_mode", "ltp_eligible", "ltp_outcome",
    "ltp_discount_applied", "pricing_snapshot", "pause_log_ids", "continued_from_session_ids", "closed_bill_id",
    "close_disposition", "close_reason", "raw_data", "created_at"
  ],
  session_pause_logs: ["organization_id", "id", "session_id", "paused_at", "resumed_at", "raw_data", "created_at"],
  session_items: [
    "organization_id", "session_id", "id", "inventory_item_id", "name", "quantity", "unit_price", "added_at",
    "sold_as_pack_of", "sale_variant_id", "stock_units_per_sale", "combo_application_id", "combo_id", "raw_data",
    "created_at"
  ],
  session_combo_applications: [
    "organization_id", "session_id", "id", "combo_id", "combo_name", "price", "included_minutes", "applied_at",
    "fixed_items", "choices", "raw_data", "created_at"
  ],
  customer_tabs: [
    "organization_id", "id", "customer_id", "customer_name", "customer_phone", "status", "opened_at", "closed_at",
    "continued_from_session_ids", "closed_bill_id", "close_disposition", "close_reason", "raw_data", "created_at"
  ],
  customer_tab_items: [
    "organization_id", "customer_tab_id", "id", "inventory_item_id", "name", "quantity", "unit_price", "added_at",
    "sold_as_pack_of", "sale_variant_id", "stock_units_per_sale", "combo_application_id", "combo_id", "raw_data",
    "created_at"
  ],
  customer_tab_combo_applications: [
    "organization_id", "customer_tab_id", "id", "combo_id", "combo_name", "price", "included_minutes", "applied_at",
    "fixed_items", "choices", "raw_data", "created_at"
  ]
};

function requireBootstrapRows<T>(
  payload: Record<string, unknown>,
  key: string,
  limit: number
): T[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`Operational bootstrap returned an invalid or oversized ${key} collection.`);
  }
  const expectedKeys = BOOTSTRAP_ROW_KEYS[key];
  if (!expectedKeys) throw new Error(`Operational bootstrap has no row contract for ${key}.`);
  return value.map((entry, index) => {
    const record = requireBootstrapRecord(entry, `${key}[${index}]`);
    const actualKeys = Object.keys(record).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    if (
      actualKeys.length !== sortedExpectedKeys.length
      || actualKeys.some((actualKey, keyIndex) => actualKey !== sortedExpectedKeys[keyIndex])
    ) {
      throw new Error(`Operational bootstrap returned malformed or unexpected ${key}[${index}] fields.`);
    }
    return record as unknown as T;
  });
}

function assertNoUnexpectedBootstrapKeys(
  payload: Record<string, unknown>,
  expectedKeys: readonly string[]
) {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(payload).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Operational bootstrap returned unexpected response fields: ${unexpected.join(", ")}.`);
  }
}

function assertBootstrapOrganizationRows(
  rows: readonly unknown[],
  organizationId: string,
  label: string
) {
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    if (record.organization_id !== organizationId) {
      throw new Error(`Operational bootstrap returned cross-tenant ${label} data.`);
    }
  }
}

function assertUniqueBootstrapRows<T>(rows: T[], identity: (row: T) => string, label: string) {
  const identities = new Set<string>();
  for (const row of rows) {
    const id = identity(row);
    if (!id || identities.has(id)) {
      throw new Error(`Operational bootstrap returned duplicate or missing ${label} identity.`);
    }
    identities.add(id);
  }
}

function mapBootstrapProfile(value: unknown, label: string): RemoteProfile {
  const row = requireBootstrapRecord(value, label);
  const role = requireBootstrapText(row.role, `${label}.role`);
  if (role !== "admin" && role !== "manager" && role !== "receptionist") {
    throw new Error(`Operational bootstrap returned an invalid ${label}.role.`);
  }
  if (typeof row.active !== "boolean") {
    throw new Error(`Operational bootstrap returned an invalid ${label}.active.`);
  }
  const tabPermissions = row.tabPermissions;
  if (tabPermissions !== undefined && tabPermissions !== null && (
    !Array.isArray(tabPermissions) || tabPermissions.some((entry) => typeof entry !== "string")
  )) {
    throw new Error(`Operational bootstrap returned invalid ${label}.tabPermissions.`);
  }
  return {
    id: requireBootstrapText(row.id, `${label}.id`),
    name: requireBootstrapText(row.name, `${label}.name`),
    username: requireBootstrapText(row.username, `${label}.username`),
    role,
    active: row.active,
    tabPermissions: tabPermissions as RemoteProfile["tabPermissions"]
  };
}

export function buildOperationalBootstrapRpcResult(rawPayload: unknown): OperationalBootstrapRpcResult {
  const serialized = JSON.stringify(rawPayload);
  if (new TextEncoder().encode(serialized).byteLength > OPERATIONAL_BOOTSTRAP_MAX_PAYLOAD_BYTES) {
    throw new Error("Operational bootstrap payload exceeded the safe byte limit.");
  }
  const payload = requireBootstrapRecord(rawPayload, "response envelope");
  if (payload.contract_version !== OPERATIONAL_BOOTSTRAP_CONTRACT_VERSION) {
    throw new Error("Operational bootstrap returned an unsupported contract version.");
  }
  const actorId = requireBootstrapText(payload.actor_id, "actor_id");
  if (payload.status === "inactive-or-missing") {
    assertNoUnexpectedBootstrapKeys(payload, ["contract_version", "status", "actor_id"]);
    const protectedKeys = [
      "profiles", "organization", "inventory_categories", "stations", "pricing_rules",
      "inventory_items", "sale_variants", "combos", "sessions", "customer_tabs"
    ];
    if (protectedKeys.some((key) => key in payload)) {
      throw new Error("Inactive operational bootstrap response included protected application data.");
    }
    return { status: "inactive-or-missing", actorId };
  }
  if (payload.status !== "active") {
    throw new Error("Operational bootstrap returned an invalid status.");
  }
  assertNoUnexpectedBootstrapKeys(payload, [
    "contract_version", "status", "actor_id", "organization_id", "actor_profile", "organization",
    "app_state_metadata", "profiles", "inventory_categories", "stations", "pricing_rules",
    "inventory_items", "sale_variants", "combos", "combo_station_targets", "combo_fixed_items",
    "combo_choice_groups", "combo_choice_options", "sessions", "session_pause_logs", "session_items",
    "session_combo_applications", "customer_tabs", "customer_tab_items",
    "customer_tab_combo_applications"
  ]);

  const organizationId = requireBootstrapText(payload.organization_id, "organization_id");
  assertNoUnexpectedBootstrapKeys(
    requireBootstrapRecord(payload.actor_profile, "actor_profile"),
    ["id", "name", "username", "role", "active", "tabPermissions"]
  );
  const actorProfile = mapBootstrapProfile(payload.actor_profile, "actor_profile");
  if (!actorProfile.active || actorProfile.id !== actorId) {
    throw new Error("Operational bootstrap actor identity did not match the authenticated response.");
  }
  const organizationRow = requireBootstrapRecord(payload.organization, "organization") as unknown as OrganizationRow;
  assertNoUnexpectedBootstrapKeys(
    organizationRow as unknown as Record<string, unknown>,
    ["id", "name", "business_profile"]
  );
  if (requireBootstrapText(organizationRow.id, "organization.id") !== organizationId) {
    throw new Error("Operational bootstrap organization identity did not match its row.");
  }
  requireBootstrapText(organizationRow.name, "organization.name");
  if (
    organizationRow.business_profile !== null
    && (typeof organizationRow.business_profile !== "object" || Array.isArray(organizationRow.business_profile))
  ) {
    throw new Error("Operational bootstrap returned an invalid organization business profile.");
  }
  const metadata = requireBootstrapRecord(payload.app_state_metadata, "app_state_metadata");
  assertNoUnexpectedBootstrapKeys(metadata, ["version", "updated_at"]);
  const version = Number(metadata.version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Operational bootstrap returned an invalid app-state version.");
  }

  const profileRows = requireBootstrapRows<Record<string, unknown>>(payload, "profiles", 100);
  const profiles = profileRows.map((row, index) => mapBootstrapProfile(row, `profiles[${index}]`));
  assertUniqueBootstrapRows(profiles, (profile) => profile.id, "profile");
  const collectionActor = profiles.find((profile) => profile.id === actorId);
  if (!collectionActor?.active) {
    throw new Error("Operational bootstrap staff collection omitted the active actor.");
  }
  if (
    collectionActor.name !== actorProfile.name
    || collectionActor.username !== actorProfile.username
    || collectionActor.role !== actorProfile.role
    || JSON.stringify(collectionActor.tabPermissions ?? null) !== JSON.stringify(actorProfile.tabPermissions ?? null)
  ) {
    throw new Error("Operational bootstrap actor profile diverged from the staff collection.");
  }

  const inventoryCategories = requireBootstrapRows<InventoryCategoryRow>(payload, "inventory_categories", 100);
  const stations = requireBootstrapRows<StationRow>(payload, "stations", 100);
  const pricingRules = requireBootstrapRows<PricingRuleRow>(payload, "pricing_rules", 500);
  const inventoryItems = requireBootstrapRows<InventoryItemRow>(payload, "inventory_items", 2_000);
  const saleVariants = requireBootstrapRows<SaleVariantRow>(payload, "sale_variants", 5_000);
  const combos = requireBootstrapRows<ComboRow>(payload, "combos", 1_000);
  const stationTargets = requireBootstrapRows<ComboStationTargetRow>(payload, "combo_station_targets", 5_000);
  const fixedItems = requireBootstrapRows<ComboFixedItemRow>(payload, "combo_fixed_items", 5_000);
  const choiceGroups = requireBootstrapRows<ComboChoiceGroupRow>(payload, "combo_choice_groups", 5_000);
  const choiceOptions = requireBootstrapRows<ComboChoiceOptionRow>(payload, "combo_choice_options", 10_000);
  const sessions = requireBootstrapRows<SessionRow>(payload, "sessions", 500);
  const sessionPauseLogs = requireBootstrapRows<SessionPauseLogRow>(payload, "session_pause_logs", 5_000);
  const sessionItems = requireBootstrapRows<SessionItemRow>(payload, "session_items", 5_000);
  const sessionComboApplications = requireBootstrapRows<SessionComboApplicationRow>(payload, "session_combo_applications", 5_000);
  const customerTabs = requireBootstrapRows<CustomerTabRow>(payload, "customer_tabs", 500);
  const customerTabItems = requireBootstrapRows<CustomerTabItemRow>(payload, "customer_tab_items", 5_000);
  const customerTabComboApplications = requireBootstrapRows<CustomerTabComboApplicationRow>(
    payload,
    "customer_tab_combo_applications",
    5_000
  );

  for (const [rows, label] of [
    [profileRows, "profiles"],
    [inventoryCategories, "inventory_categories"],
    [stations, "stations"],
    [pricingRules, "pricing_rules"],
    [inventoryItems, "inventory_items"],
    [saleVariants, "sale_variants"],
    [combos, "combos"],
    [stationTargets, "combo_station_targets"],
    [fixedItems, "combo_fixed_items"],
    [choiceGroups, "combo_choice_groups"],
    [choiceOptions, "combo_choice_options"],
    [sessions, "sessions"],
    [sessionPauseLogs, "session_pause_logs"],
    [sessionItems, "session_items"],
    [sessionComboApplications, "session_combo_applications"],
    [customerTabs, "customer_tabs"],
    [customerTabItems, "customer_tab_items"],
    [customerTabComboApplications, "customer_tab_combo_applications"]
  ] as const) {
    assertBootstrapOrganizationRows(rows, organizationId, label);
  }

  assertUniqueBootstrapRows(inventoryCategories, (row) => requireBootstrapText(row.name, "inventory category name"), "inventory category");
  assertUniqueBootstrapRows(stations, (row) => requireBootstrapText(row.id, "station id"), "station");
  assertUniqueBootstrapRows(pricingRules, (row) => requireBootstrapText(row.id, "pricing rule id"), "pricing rule");
  assertUniqueBootstrapRows(inventoryItems, (row) => requireBootstrapText(row.id, "inventory item id"), "inventory item");
  assertUniqueBootstrapRows(saleVariants, (row) => `${requireBootstrapText(row.inventory_item_id, "sale variant item id")}:${requireBootstrapText(row.id, "sale variant id")}`, "sale variant");
  assertUniqueBootstrapRows(combos, (row) => requireBootstrapText(row.id, "combo id"), "combo");
  assertUniqueBootstrapRows(stationTargets, (row) => `${requireBootstrapText(row.combo_id, "combo target combo id")}:${requireBootstrapText(row.station_id, "combo target station id")}`, "combo station target");
  assertUniqueBootstrapRows(fixedItems, (row) => `${requireBootstrapText(row.combo_id, "fixed item combo id")}:${requireBootstrapText(row.id, "fixed item id")}`, "combo fixed item");
  assertUniqueBootstrapRows(choiceGroups, (row) => `${requireBootstrapText(row.combo_id, "choice group combo id")}:${requireBootstrapText(row.id, "choice group id")}`, "combo choice group");
  assertUniqueBootstrapRows(choiceOptions, (row) => `${requireBootstrapText(row.combo_id, "choice option combo id")}:${requireBootstrapText(row.choice_group_id, "choice option group id")}:${requireBootstrapText(row.option_id, "choice option id")}`, "combo choice option");
  assertUniqueBootstrapRows(sessions, (row) => requireBootstrapText(row.id, "session id"), "session");
  assertUniqueBootstrapRows(sessionPauseLogs, (row) => `${requireBootstrapText(row.session_id, "pause session id")}:${requireBootstrapText(row.id, "pause id")}`, "session pause");
  assertUniqueBootstrapRows(sessionItems, (row) => `${requireBootstrapText(row.session_id, "session item session id")}:${requireBootstrapText(row.id, "session item id")}`, "session item");
  assertUniqueBootstrapRows(sessionComboApplications, (row) => `${requireBootstrapText(row.session_id, "session combo session id")}:${requireBootstrapText(row.id, "session combo id")}`, "session combo application");
  assertUniqueBootstrapRows(customerTabs, (row) => requireBootstrapText(row.id, "customer tab id"), "customer tab");
  assertUniqueBootstrapRows(customerTabItems, (row) => `${requireBootstrapText(row.customer_tab_id, "customer tab item tab id")}:${requireBootstrapText(row.id, "customer tab item id")}`, "customer tab item");
  assertUniqueBootstrapRows(customerTabComboApplications, (row) => `${requireBootstrapText(row.customer_tab_id, "customer tab combo tab id")}:${requireBootstrapText(row.id, "customer tab combo id")}`, "customer tab combo application");

  const inventoryItemIds = new Set(inventoryItems.map((row) => row.id));
  const comboIds = new Set(combos.map((row) => row.id));
  const choiceGroupKeys = new Set(choiceGroups.map((row) => `${row.combo_id}:${row.id}`));
  const sessionIds = new Set(sessions.map((row) => row.id));
  const customerTabIds = new Set(customerTabs.map((row) => row.id));
  if (saleVariants.some((row) => !inventoryItemIds.has(row.inventory_item_id))) {
    throw new Error("Operational bootstrap returned a sale variant for an unknown inventory item.");
  }
  if (
    stationTargets.some((row) => !comboIds.has(row.combo_id))
    || fixedItems.some((row) => !comboIds.has(row.combo_id))
    || choiceGroups.some((row) => !comboIds.has(row.combo_id))
    || choiceOptions.some((row) => !comboIds.has(row.combo_id) || !choiceGroupKeys.has(`${row.combo_id}:${row.choice_group_id}`))
  ) {
    throw new Error("Operational bootstrap returned an orphaned combo child row.");
  }
  if (
    sessionPauseLogs.some((row) => !row.session_id || !sessionIds.has(row.session_id))
    || sessionItems.some((row) => !sessionIds.has(row.session_id))
    || sessionComboApplications.some((row) => !sessionIds.has(row.session_id))
  ) {
    throw new Error("Operational bootstrap returned an orphaned session child row.");
  }
  if (
    customerTabItems.some((row) => !customerTabIds.has(row.customer_tab_id))
    || customerTabComboApplications.some((row) => !customerTabIds.has(row.customer_tab_id))
  ) {
    throw new Error("Operational bootstrap returned an orphaned customer-tab child row.");
  }

  const configData = buildNormalizedConfigData({ organization: organizationRow, inventoryCategories, stations, pricingRules });
  const catalogData = buildNormalizedCatalogData({ inventoryItems, saleVariants });
  const comboData = buildNormalizedComboData({ combos, stationTargets, fixedItems, choiceGroups, choiceOptions });
  const liveData = buildNormalizedLiveData({
    sessions,
    sessionPauseLogs,
    sessionItems,
    sessionComboApplications,
    customerTabs,
    customerTabItems,
    customerTabComboApplications
  });
  return {
    status: "active",
    actorId,
    profile: actorProfile,
    organization: {
      id: organizationId,
      name: organizationRow.name,
      businessProfile: organizationRow.business_profile
    },
    version,
    appData: {
      users: profiles.map((profile) => ({
        ...profile,
        tabPermissions: Array.isArray(profile.tabPermissions) ? profile.tabPermissions : undefined
      })),
      businessProfile: configData.businessProfile,
      inventoryCategories: configData.inventoryCategories,
      stations: configData.stations,
      pricingRules: configData.pricingRules,
      inventoryItems: catalogData.inventoryItems,
      combos: comboData.combos,
      sessions: liveData.sessions,
      sessionPauseLogs: liveData.sessionPauseLogs,
      customerTabs: liveData.customerTabs
    }
  };
}

export async function loadNormalizedActiveOrganization(client: SupabaseClient = getSupabaseClient()): Promise<OrganizationRow> {
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
  rememberNormalizedOrganizationId(organization.id);
  return organization;
}

async function loadNormalizedConfigDataForOrganization(
  organization: OrganizationRow,
  client: SupabaseClient
): Promise<NormalizedConfigData> {
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

function stockMovementInstantMicros(value: string | null): bigint | null {
  if (value === null) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new Error("Normalized stock-movement history returned an invalid timestamp.");
  const wholeSecondMs = Date.parse(`${match[1]}.000${match[3]}`);
  if (!Number.isFinite(wholeSecondMs)) throw new Error("Normalized stock-movement history returned an invalid timestamp.");
  return BigInt(wholeSecondMs) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function assertStockMovementOrder(previous: StockMovementRow | undefined, current: StockMovementRow) {
  const currentInstant = stockMovementInstantMicros(current.movement_at);
  if (!previous) return;
  const previousInstant = stockMovementInstantMicros(previous.movement_at);
  const timestampsOutOfOrder = previousInstant === null
    ? currentInstant !== null
    : currentInstant !== null && previousInstant < currentInstant;
  if (timestampsOutOfOrder) {
    throw new Error("Normalized stock-movement history was not returned in stable descending order.");
  }
}

export async function loadNormalizedConfigData(client: SupabaseClient = getSupabaseClient()): Promise<NormalizedConfigData> {
  const organization = await loadNormalizedActiveOrganization(client);
  return loadNormalizedConfigDataForOrganization(organization, client);
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

export async function loadNormalizedInventoryItemsByIds(
  organizationId: string,
  itemIds: string[],
  client: SupabaseClient = getSupabaseClient()
): Promise<InventoryItem[]> {
  const requestedItemIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (requestedItemIds.length === 0) {
    return [];
  }
  const [inventoryItems, saleVariants] = await Promise.all([
    readMany<InventoryItemRow>(
      client
        .from("inventory_items")
        .select(
          "id, name, category, price, stock_qty, low_stock_threshold, unit, is_reusable, barcode, active, archived_at, archived_by_user_id, archive_reason, sell_base_item, cigarette_pack, raw_data"
        )
        .eq("organization_id", organizationId)
        .in("id", requestedItemIds),
      "loading changed inventory items"
    ),
    readMany<SaleVariantRow>(
      client
        .from("sale_variants")
        .select("inventory_item_id, id, name, price, stock_units_per_sale, barcode, active, raw_data")
        .eq("organization_id", organizationId)
        .in("inventory_item_id", requestedItemIds)
        .order("inventory_item_id", { ascending: true })
        .order("name", { ascending: true }),
      "loading changed inventory sale variants"
    )
  ]);
  return buildNormalizedCatalogData({ inventoryItems, saleVariants }).inventoryItems;
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

export async function loadNormalizedExpenseAdminData(
  organizationId: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedExpenseAdminData> {
  const [expenses, expenseTemplates, expenseTemplateOverrides] = await Promise.all([
    readMany<ExpenseRow>(
      client
        .from("expenses")
        .select(
          "id, title, category, amount, payment_mode, cash_amount, upi_amount, spent_at, notes, created_by_user_id, raw_data"
        )
        .eq("organization_id", organizationId)
        .order("spent_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(200),
      "loading normalized expenses"
    ),
    readMany<ExpenseTemplateRow>(
      client
        .from("expense_templates")
        .select("id, title, category, amount, frequency, start_month, active, notes, created_by_user_id, raw_data")
        .eq("organization_id", organizationId)
        .order("title", { ascending: true })
        .order("id", { ascending: true }),
      "loading normalized expense templates"
    ),
    readMany<ExpenseTemplateOverrideRow>(
      client
        .from("expense_template_overrides")
        .select("id, template_id, month_key, amount, skip_reason, notes, created_by_user_id, updated_at_source, raw_data")
        .eq("organization_id", organizationId)
        .order("month_key", { ascending: false })
        .order("id", { ascending: true }),
      "loading normalized expense template overrides"
    )
  ]);

  return buildNormalizedExpenseAdminData({ expenses, expenseTemplates, expenseTemplateOverrides });
}

export async function loadNormalizedStockMovements(
  organizationId: string,
  query: NormalizedStockMovementQuery = {},
  client: SupabaseClient = getSupabaseClient()
): Promise<StockMovement[]> {
  const rawLimit = query.limit ?? 5_000;
  if (!Number.isFinite(rawLimit)) {
    throw new Error("Normalized stock-movement history received an invalid row limit.");
  }
  const requestedLimit = Math.max(1, Math.min(5_000, Math.trunc(rawLimit)));
  const rows: StockMovementRow[] = [];
  const rowIds = new Set<string>();
  let expectedCount: number | undefined;
  let offset = 0;
  const deadlineAt = Date.now() + NORMALIZED_READ_TIMEOUT_MS;

  for (let pageIndex = 0; rows.length < requestedLimit; pageIndex += 1) {
    if (pageIndex >= NORMALIZED_READ_MAX_PAGES) {
      throw new Error("Normalized stock-movement history exceeded the bounded pagination limit.");
    }
    const pageLimit = Math.min(NORMALIZED_READ_PAGE_SIZE, requestedLimit - rows.length);
    let request = client
      .from("stock_movements")
      .select("id, item_id, type, quantity, reason, movement_at, user_id, related_bill_id, raw_data, created_at", { count: "exact" })
      .eq("organization_id", organizationId)
      .order("movement_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false });

    if (query.fromIso) {
      request = request.gte("movement_at", query.fromIso);
    }
    if (query.toIsoExclusive) {
      request = request.lt("movement_at", query.toIsoExclusive);
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Unable to reach normalized data while loading normalized stock movements.");
    }
    const result = await withNormalizedReadTimeout<NormalizedQueryResult<StockMovementRow[]>>(
      request.range(offset, offset + pageLimit - 1),
      "loading normalized stock movements",
      remainingMs
    );
    if (result.error) throw result.error;
    if (!Array.isArray(result.data)) {
      throw new Error("Normalized data was unavailable while loading normalized stock movements.");
    }
    if (!Number.isInteger(result.count) || Number(result.count) < 0) {
      throw new Error("Normalized stock-movement history did not return an exact row count.");
    }
    if (expectedCount === undefined) expectedCount = Number(result.count);
    if (expectedCount !== Number(result.count)) {
      throw new Error("Normalized stock-movement history changed while it was being loaded.");
    }

    const page = result.data;
    if (page.length > pageLimit) {
      throw new Error("Normalized stock-movement history exceeded the requested page size.");
    }
    const targetCount = Math.min(expectedCount, requestedLimit);
    const expectedPageLength = Math.min(pageLimit, targetCount - rows.length);
    if (page.length !== expectedPageLength) {
      throw new Error("Normalized stock-movement history ended before the expected row count.");
    }
    for (const row of page) {
      assertStockMovementOrder(rows.at(-1), row);
      if (rowIds.has(row.id)) {
        throw new Error("Normalized stock-movement history overlapped while it was being loaded.");
      }
      rowIds.add(row.id);
      rows.push(row);
    }
    offset += page.length;
    if (rows.length >= targetCount) break;
  }

  if (expectedCount === undefined || rows.length !== Math.min(expectedCount, requestedLimit)) {
    throw new Error("Normalized stock-movement history was incomplete.");
  }
  return rows.map(mapNormalizedStockMovement);
}

export async function loadNormalizedStockMovementsByIds(
  organizationId: string,
  movementIds: string[],
  client: SupabaseClient = getSupabaseClient()
): Promise<StockMovement[]> {
  const ids = Array.from(new Set(movementIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const rows = await readMany<StockMovementRow>(
    client
      .from("stock_movements")
      .select("id, item_id, type, quantity, reason, movement_at, user_id, related_bill_id, raw_data, created_at")
      .eq("organization_id", organizationId)
      .in("id", ids),
    "loading changed stock movements"
  );
  return rows.map(mapNormalizedStockMovement);
}

export async function loadNormalizedAuditLogs(
  organizationId: string,
  query: { limit?: number } = {},
  client: SupabaseClient = getSupabaseClient()
): Promise<AuditLog[]> {
  const rows = await readMany<AuditLogRow>(
    client
      .from("audit_logs")
      .select("id, action, entity_type, entity_id, message, audit_at, user_id, raw_data, created_at")
      .eq("organization_id", organizationId)
      .order("audit_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(Math.max(1, Math.min(100, Math.trunc(query.limit ?? 20)))),
    "loading normalized audit logs"
  );
  return rows.map(mapNormalizedAuditLog);
}

export async function loadNormalizedAuditLogsByIds(
  organizationId: string,
  auditLogIds: string[],
  client: SupabaseClient = getSupabaseClient()
): Promise<AuditLog[]> {
  const ids = Array.from(new Set(auditLogIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const rows = await readMany<AuditLogRow>(
    client
      .from("audit_logs")
      .select("id, action, entity_type, entity_id, message, audit_at, user_id, raw_data, created_at")
      .eq("organization_id", organizationId)
      .in("id", ids),
    "loading changed audit logs"
  );
  return rows.map(mapNormalizedAuditLog);
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
        .or("status.neq.closed,and(status.eq.closed,close_disposition.eq.hopped,closed_bill_id.is.null)")
        .order("started_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading normalized live and recoverable sessions"
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

export async function loadNormalizedLiveDataByIds(
  organizationId: string,
  ids: { sessionIds?: string[]; customerTabIds?: string[] },
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedLiveData> {
  const sessionIds = Array.from(new Set((ids.sessionIds ?? []).filter(Boolean)));
  const customerTabIds = Array.from(new Set((ids.customerTabIds ?? []).filter(Boolean)));

  const [sessions, customerTabs] = await Promise.all([
    sessionIds.length > 0
      ? readMany<SessionRow>(
          client
            .from("sessions")
            .select(
              "id, station_id, station_name_snapshot, mode, started_at, ended_at, status, customer_id, customer_name, customer_phone, play_mode, ltp_eligible, ltp_outcome, ltp_discount_applied, pricing_snapshot, pause_log_ids, continued_from_session_ids, closed_bill_id, close_disposition, close_reason, raw_data, created_at"
            )
            .eq("organization_id", organizationId)
            .in("id", sessionIds),
          "loading normalized changed sessions"
        )
      : Promise.resolve([]),
    customerTabIds.length > 0
      ? readMany<CustomerTabRow>(
          client
            .from("customer_tabs")
            .select(
              "id, customer_id, customer_name, customer_phone, status, opened_at, closed_at, continued_from_session_ids, closed_bill_id, close_disposition, close_reason, raw_data, created_at"
            )
            .eq("organization_id", organizationId)
            .in("id", customerTabIds),
          "loading normalized changed customer tabs"
        )
      : Promise.resolve([])
  ]);

  const loadedSessionIds = sessions.map((session) => session.id);
  const loadedCustomerTabIds = customerTabs.map((tab) => tab.id);

  const [sessionPauseLogs, sessionItems, sessionComboApplications, customerTabItems, customerTabComboApplications] =
    await Promise.all([
      loadedSessionIds.length > 0
        ? readMany<SessionPauseLogRow>(
            client
              .from("session_pause_logs")
              .select("id, session_id, paused_at, resumed_at, raw_data, created_at")
              .eq("organization_id", organizationId)
              .in("session_id", loadedSessionIds)
              .order("paused_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized changed session pause logs"
          )
        : Promise.resolve([]),
      loadedSessionIds.length > 0
        ? readMany<SessionItemRow>(
            client
              .from("session_items")
              .select(
                "session_id, id, inventory_item_id, name, quantity, unit_price, added_at, sold_as_pack_of, sale_variant_id, stock_units_per_sale, combo_application_id, combo_id, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("session_id", loadedSessionIds)
              .order("added_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized changed session items"
          )
        : Promise.resolve([]),
      loadedSessionIds.length > 0
        ? readMany<SessionComboApplicationRow>(
            client
              .from("session_combo_applications")
              .select(
                "session_id, id, combo_id, combo_name, price, included_minutes, applied_at, fixed_items, choices, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("session_id", loadedSessionIds)
              .order("applied_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized changed session combo applications"
          )
        : Promise.resolve([]),
      loadedCustomerTabIds.length > 0
        ? readMany<CustomerTabItemRow>(
            client
              .from("customer_tab_items")
              .select(
                "customer_tab_id, id, inventory_item_id, name, quantity, unit_price, added_at, sold_as_pack_of, sale_variant_id, stock_units_per_sale, combo_application_id, combo_id, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("customer_tab_id", loadedCustomerTabIds)
              .order("added_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized changed customer tab items"
          )
        : Promise.resolve([]),
      loadedCustomerTabIds.length > 0
        ? readMany<CustomerTabComboApplicationRow>(
            client
              .from("customer_tab_combo_applications")
              .select(
                "customer_tab_id, id, combo_id, combo_name, price, included_minutes, applied_at, fixed_items, choices, raw_data, created_at"
              )
              .eq("organization_id", organizationId)
              .in("customer_tab_id", loadedCustomerTabIds)
              .order("applied_at", { ascending: true })
              .order("id", { ascending: true }),
            "loading normalized changed customer tab combo applications"
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
  organization?: RemoteOrganization;
}): Promise<{ organizationId?: string; appData: Partial<AppData> }> {
  const client = params.client ?? getSupabaseClient();
  const overlay: Partial<AppData> = {};
  const needsOrganization =
    params.normalizedConfigReads ||
    params.normalizedCatalogReads ||
    params.normalizedComboReads ||
    Boolean(params.normalizedLiveReads);
  const organization = needsOrganization
    ? params.organization
      ? {
          id: params.organization.id,
          name: params.organization.name,
          business_profile: params.organization.businessProfile
        }
      : await loadNormalizedActiveOrganization(client)
    : undefined;
  if (organization) rememberNormalizedOrganizationId(organization.id);
  const organizationId = organization?.id;

  const [configData, catalogData, comboData, liveData] = organization
    ? await Promise.all([
        params.normalizedConfigReads
          ? loadNormalizedConfigDataForOrganization(organization, client)
          : Promise.resolve(undefined),
        params.normalizedCatalogReads
          ? loadNormalizedCatalogData(organization.id, client)
          : Promise.resolve(undefined),
        params.normalizedComboReads
          ? loadNormalizedComboData(organization.id, client)
          : Promise.resolve(undefined),
        params.normalizedLiveReads
          ? loadNormalizedLiveData(organization.id, client)
          : Promise.resolve(undefined)
      ])
    : [undefined, undefined, undefined, undefined];

  if (configData) {
    overlay.businessProfile = configData.businessProfile;
    overlay.inventoryCategories = configData.inventoryCategories;
    overlay.stations = configData.stations;
    overlay.pricingRules = configData.pricingRules;
  }
  if (catalogData) {
    overlay.inventoryItems = catalogData.inventoryItems;
  }
  if (comboData) {
    overlay.combos = comboData.combos;
  }
  if (liveData) {
    overlay.sessions = liveData.sessions;
    overlay.sessionPauseLogs = liveData.sessionPauseLogs;
    overlay.customerTabs = liveData.customerTabs;
  }

  return { organizationId, appData: overlay };
}
