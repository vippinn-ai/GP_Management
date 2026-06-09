export type Role = "admin" | "manager" | "receptionist";
export type PaymentMode = "cash" | "upi";
export type BillPaymentMode = "cash" | "upi" | "split" | "deferred";
export type ExpensePaymentMode = PaymentMode | "split";
export type StationMode = "timed" | "unit_sale";
export type SessionStatus = "active" | "paused" | "closed";
export type BillStatus = "issued" | "pending" | "voided" | "refunded" | "replaced";
export type LineType = "session_charge" | "inventory_item" | "manual_charge" | "combo_package" | "combo_detail";
export type DiscountType = "amount" | "percentage";
export type PlayMode = "group" | "solo";
export type LtpOutcome = "won" | "lost";
export type ComboType = "game" | "consumables";
export type StockMovementType =
  | "restock"
  | "sale"
  | "adjustment"
  | "void_refund_reversal"
  | "session_reservation"
  | "session_reservation_void";

export interface User {
  id: string;
  name: string;
  username: string;
  password?: string;
  role: Role;
  active: boolean;
  tabPermissions?: TabId[];
}

export interface BusinessProfile {
  name: string;
  logoText: string;
  address: string;
  primaryPhone: string;
  secondaryPhone?: string;
  receiptFooter: string;
}

export interface Station {
  id: string;
  name: string;
  mode: StationMode;
  active: boolean;
  ltpEnabled: boolean;
  notes?: string;
}

export interface PricingRule {
  id: string;
  stationId: string;
  label: string;
  startMinute: number;
  endMinute: number;
  hourlyRate: number;
}

export interface SessionPauseLog {
  id: string;
  sessionId: string;
  pausedAt: string;
  resumedAt?: string;
}

export interface SessionItem {
  id: string;
  inventoryItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  addedAt: string;
  soldAsPackOf?: number;
  saleVariantId?: string;
  stockUnitsPerSale?: number;
  comboApplicationId?: string;
  comboId?: string;
}

export interface ComboInventorySelection {
  inventoryItemId: string;
  saleVariantId?: string;
  name: string;
  sourceName: string;
  quantity: number;
  unitPrice: number;
  stockUnitsPerSale: number;
}

export interface ComboFixedItem {
  id: string;
  sellableOptionId: string;
  quantity: number;
}

export interface ComboChoiceGroup {
  id: string;
  label: string;
  requiredQuantity: number;
  optionIds: string[];
}

export interface ComboPackage {
  id: string;
  name: string;
  type?: ComboType;
  active: boolean;
  stationIds: string[];
  price: number;
  includedMinutes: number;
  fixedItems: ComboFixedItem[];
  choiceGroups: ComboChoiceGroup[];
  createdAt: string;
  updatedAt: string;
}

export interface ComboAppliedChoice {
  groupId: string;
  groupLabel: string;
  selections: ComboInventorySelection[];
  selection?: ComboInventorySelection;
}

export interface SessionComboApplication {
  id: string;
  comboId: string;
  comboName: string;
  price: number;
  includedMinutes: number;
  appliedAt: string;
  fixedItems: ComboInventorySelection[];
  choices: ComboAppliedChoice[];
}

export interface Session {
  id: string;
  stationId: string;
  stationNameSnapshot: string;
  mode: StationMode;
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  playMode: PlayMode;
  ltpEligible: boolean;
  ltpOutcome?: LtpOutcome;
  ltpDiscountApplied?: boolean;
  pricingSnapshot: PricingRule[];
  items: SessionItem[];
  comboApplications?: SessionComboApplication[];
  pauseLogIds: string[];
  continuedFromSessionIds?: string[];
  closedBillId?: string;
  closeDisposition?: "billed" | "rejected" | "hopped";
  closeReason?: string;
}

export interface CustomerTabItem {
  id: string;
  inventoryItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  addedAt: string;
  soldAsPackOf?: number;
  saleVariantId?: string;
  stockUnitsPerSale?: number;
  comboApplicationId?: string;
  comboId?: string;
}

export interface CustomerTab {
  id: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  items: CustomerTabItem[];
  comboApplications?: SessionComboApplication[];
  continuedFromSessionIds?: string[];
  closedBillId?: string;
  closeDisposition?: "billed" | "rejected";
  closeReason?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  createdAt: string;
  lastVisitAt: string;
  notes?: string;
}

export interface CigarettePack {
  size: number;
  packPrice: number;
}

export interface SaleVariant {
  id: string;
  name: string;
  price: number;
  stockUnitsPerSale: number;
  barcode?: string;
  active: boolean;
}

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  price: number;
  stockQty: number;
  lowStockThreshold: number;
  unit: string;
  isReusable: boolean;
  barcode?: string;
  active: boolean;
  archivedAt?: string;
  archivedByUserId?: string;
  archiveReason?: string;
  cigarettePack?: CigarettePack;
  sellBaseItem?: boolean;
  saleVariants?: SaleVariant[];
}

export interface SellableInventoryOption {
  id: string;
  inventoryItemId: string;
  saleVariantId?: string;
  name: string;
  sourceName: string;
  category: string;
  price: number;
  barcode?: string;
  sourceBarcode?: string;
  isBaseItem: boolean;
  stockUnitsPerSale: number;
  item: InventoryItem;
}

export interface StockMovement {
  id: string;
  itemId: string;
  type: StockMovementType;
  quantity: number;
  reason: string;
  createdAt: string;
  userId: string;
  relatedBillId?: string;
}

export interface AppliedDiscount {
  id: string;
  scope: "bill" | "line";
  targetId: string;
  type: DiscountType;
  value: number;
  amount: number;
  reason: string;
  appliedByUserId: string;
  appliedAt: string;
}

export interface BillLine {
  id: string;
  type: LineType;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  discountAmount: number;
  total: number;
  linkedSessionId?: string;
  inventoryItemId?: string;
  soldAsPackOf?: number;
  saleVariantId?: string;
  stockUnitsPerSale?: number;
  comboApplicationId?: string;
  comboId?: string;
}

export interface Bill {
  id: string;
  billNumber: string;
  status: BillStatus;
  createdAt: string;
  issuedAt: string;
  issuedByUserId: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  paymentMode: BillPaymentMode;
  stationId?: string;
  sessionId?: string;
  amountPaid: number;
  amountDue: number;
  subtotal: number;
  totalDiscountAmount: number;
  billDiscountAmount: number;
  roundOffEnabled: boolean;
  roundOffAmount: number;
  total: number;
  lineDiscounts: AppliedDiscount[];
  billDiscount?: AppliedDiscount;
  lines: BillLine[];
  receiptType: "digital";
  replacementOfBillId?: string;
  replacedByBillId?: string;
  replacedAt?: string;
  replacedByUserId?: string;
  replaceReason?: string;
  voidedAt?: string;
  voidedByUserId?: string;
  voidReason?: string;
  settledAt?: string;
  settledByUserId?: string;
}

export interface Payment {
  id: string;
  billId: string;
  mode: PaymentMode;
  amount: number;
  createdAt: string;
  receivedByUserId: string;
  settlementGroupId?: string;
  relatedCheckoutBillId?: string;
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  message: string;
  createdAt: string;
  userId: string;
}

export interface Expense {
  id: string;
  title: string;
  category: string;
  amount: number;
  paymentMode?: ExpensePaymentMode;
  cashAmount?: number;
  upiAmount?: number;
  spentAt: string;
  notes?: string;
  createdByUserId: string;
}

export interface ExpenseTemplate {
  id: string;
  title: string;
  category: string;
  amount: number;
  frequency: "monthly";
  startMonth: string;
  active: boolean;
  notes?: string;
  createdByUserId: string;
}

export interface ExpenseTemplateOverride {
  id: string;
  templateId: string;
  monthKey: string;
  amount: number | null;
  skipReason?: string;
  notes?: string;
  createdByUserId: string;
  updatedAt: string;
}

export interface AppData {
  users: User[];
  businessProfile: BusinessProfile;
  inventoryCategories: string[];
  stations: Station[];
  pricingRules: PricingRule[];
  sessions: Session[];
  sessionPauseLogs: SessionPauseLog[];
  customers: Customer[];
  customerTabs: CustomerTab[];
  inventoryItems: InventoryItem[];
  combos: ComboPackage[];
  stockMovements: StockMovement[];
  bills: Bill[];
  payments: Payment[];
  auditLogs: AuditLog[];
  expenses: Expense[];
  expenseTemplates: ExpenseTemplate[];
  expenseTemplateOverrides: ExpenseTemplateOverride[];
}

export interface SessionChargeSummary {
  subtotal: number;
  billedHours: number;
  billedMinutes: number;
  pauseMinutes: number;
  segments: Array<{
    label: string;
    hourlyRate: number;
    minutes: number;
    subtotal: number;
  }>;
}

export interface DraftDiscountInput {
  type: DiscountType;
  value: number;
  reason: string;
}

export interface DraftBillLine {
  id: string;
  type: LineType;
  description: string;
  quantity: number;
  unitPrice: number;
  linkedSessionId?: string;
  inventoryItemId?: string;
  discount?: DraftDiscountInput;
  soldAsPackOf?: number;
  saleVariantId?: string;
  stockUnitsPerSale?: number;
  comboApplicationId?: string;
  comboId?: string;
}

export type TabId = "dashboard" | "sale" | "inventory" | "bills" | "reports" | "customers" | "settings" | "users";
export type NumericInputMode = "integer" | "decimal";
export type ReportPreset = "today" | "yesterday" | "last_7_days" | "this_month" | "last_month" | "this_year" | "custom";
export type InventoryReportPreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
export type InventoryState = "out" | "low" | "healthy" | "occupied" | "available";

export interface StartSessionDraft {
  stationId: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  playMode: PlayMode;
  arcadeItemId: string;
  arcadeQuantity: number;
  comboId?: string;
  comboChoices?: Record<string, string[]>;
}

export interface DraftLineDiscountMap {
  [lineId: string]: DraftDiscountInput | undefined;
}

export interface CheckoutState {
  mode: "session" | "customer_tab" | "bill_replacement";
  sessionId?: string;
  customerTabId?: string;
  replacementBillId?: string;
  closedAt?: string;
  sessionStartedAt?: string;
  sessionEndedAt?: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  paymentMode: BillPaymentMode;
  splitCashAmount: number;
  splitUpiAmount: number;
  collectAmount: number;
  collectMode: PaymentMode;
  roundOffEnabled: boolean;
  lineDiscounts: DraftLineDiscountMap;
  billDiscount?: DraftDiscountInput;
  ltpOutcome?: LtpOutcome;
  hoppedSessionIds?: string[];
  replacementLines?: DraftBillLine[];
  replaceReason?: string;
  pendingSettlement?: PendingSettlementDraft;
}

export interface CustomerTabDraft {
  customerId?: string;
  customerName: string;
  customerPhone: string;
}

export interface SessionEditDraft {
  sessionId: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  startedAt: string;
}

export interface CustomerTabEditDraft {
  customerTabId: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
}

export interface CustomerProfileEditDraft {
  customerId: string;
  name: string;
  phone: string;
}

export interface StationEditDraft {
  id: string;
  name: string;
  mode: StationMode;
  active: boolean;
  ltpEnabled: boolean;
}

export interface UserEditDraft {
  id: string;
  name: string;
  username: string;
  role: Role;
  tabPermissions?: TabId[];
}

export interface UserPasswordDraft {
  userId: string;
  password: string;
  confirmPassword: string;
}

export interface ReportFilterState {
  preset: ReportPreset;
  fromDate?: string;
  toDate?: string;
}

export interface InventoryReportFilterState {
  preset: InventoryReportPreset;
  fromDate?: string;
  toDate?: string;
}

export interface InventoryReportSummary {
  added: number;
  deducted: number;
  manualAdjustments: number;
  reversals: number;
  netChange: number;
  reserved: number;
  touchedItems: number;
}

export interface InventoryReportRow {
  itemId: string;
  itemName: string;
  category: string;
  active: boolean;
  added: number;
  deducted: number;
  manualAdjustments: number;
  reversals: number;
  netChange: number;
  currentStock: number;
  reserved: number;
  movementCount: number;
}

export interface InventoryReportMovementDetail {
  id: string;
  businessDate: string;
  createdAt: string;
  itemId: string;
  itemName: string;
  category: string;
  type: StockMovementType;
  quantity: number;
  reason: string;
  relatedBillId?: string;
  relatedBillNumber?: string;
}

export interface InventoryReportModel {
  summary: InventoryReportSummary;
  rows: InventoryReportRow[];
  details: InventoryReportMovementDetail[];
}

export interface SettlementDraft {
  billId?: string;
  billIds?: string[];
  paymentMode: PaymentMode | "split";
  cashAmount: number;
  upiAmount: number;
}

export interface VoidPendingDraft {
  billId: string;
  reason: string;
}

export interface PendingSettlementDraft {
  availableBillIds?: string[];
  billIds: string[];
  paymentMode: PaymentMode | "split";
  cashAmount: number;
  upiAmount: number;
}

export interface VoidPendingGroupDraft {
  billIds: string[];
  reason: string;
  customerLabel: string;
}

export interface PendingReceivable {
  bill: Bill;
  businessDate: string;
  daysOverdue: number;
}

export interface PendingReceivableGroup {
  id: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  label: string;
  isUngrouped: boolean;
  bills: Bill[];
  totalDue: number;
  totalPaid: number;
  totalBillValue: number;
  oldestBusinessDate: string;
  daysOverdue: number;
}
