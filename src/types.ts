export type Role = "admin" | "manager" | "receptionist";
export type PaymentMode = "cash" | "upi";
export type StationMode = "timed" | "unit_sale";
export type SessionStatus = "active" | "paused" | "closed";
export type BillStatus = "issued" | "voided" | "refunded" | "replaced";
export type LineType = "session_charge" | "inventory_item" | "manual_charge";
export type DiscountType = "amount" | "percentage";
export type PlayMode = "group" | "solo";
export type LtpOutcome = "won" | "lost";
export type StockMovementType =
  | "restock"
  | "sale"
  | "adjustment"
  | "void_refund_reversal";

export interface User {
  id: string;
  name: string;
  username: string;
  password?: string;
  role: Role;
  active: boolean;
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
}

export interface Session {
  id: string;
  stationId: string;
  stationNameSnapshot: string;
  mode: StationMode;
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  customerName?: string;
  customerPhone?: string;
  playMode: PlayMode;
  ltpEligible: boolean;
  ltpOutcome?: LtpOutcome;
  ltpDiscountApplied?: boolean;
  pricingSnapshot: PricingRule[];
  items: SessionItem[];
  pauseLogIds: string[];
  closedBillId?: string;
  closeDisposition?: "billed" | "rejected";
  closeReason?: string;
}

export interface CustomerTabItem {
  id: string;
  inventoryItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  addedAt: string;
}

export interface CustomerTab {
  id: string;
  customerName: string;
  customerPhone?: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  items: CustomerTabItem[];
  closedBillId?: string;
  closeDisposition?: "billed" | "rejected";
  closeReason?: string;
}

export interface Customer {
  id: string;
  name?: string;
  phone?: string;
  lastVisitAt: string;
  notes?: string;
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
}

export interface Bill {
  id: string;
  billNumber: string;
  status: BillStatus;
  createdAt: string;
  issuedAt: string;
  issuedByUserId: string;
  customerName?: string;
  customerPhone?: string;
  paymentMode: PaymentMode;
  stationId?: string;
  sessionId?: string;
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
}

export interface Payment {
  id: string;
  billId: string;
  mode: PaymentMode;
  amount: number;
  createdAt: string;
  receivedByUserId: string;
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
  stockMovements: StockMovement[];
  bills: Bill[];
  payments: Payment[];
  auditLogs: AuditLog[];
  expenses: Expense[];
  expenseTemplates: ExpenseTemplate[];
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
}
