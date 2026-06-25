import type { RemoteAppDataSnapshot, SaveRemoteTelemetryOptions } from "../backend";
import type { OperationalMutation } from "../operationalSync";
import type {
  AppData,
  AuditLog,
  Bill,
  BusinessProfile,
  ComboPackage,
  Customer,
  CustomerTab,
  Expense,
  ExpenseTemplate,
  ExpenseTemplateOverride,
  InventoryItem,
  Payment,
  PricingRule,
  Session,
  Station,
  StockMovement
} from "../types";

export interface OperationalRpcCommitResult {
  mutationId: string;
  rpcName: string;
  organizationId: string;
  entityType: OperationalMutation["entityType"];
  entityId: string;
  eventId?: string;
  serverTime?: string;
  appStateVersion?: number;
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
  raw?: unknown;
}

export type FinancialCheckoutMode = "session" | "customer_tab" | "bill_replacement";
export type FinancialCheckoutEntityType = "session" | "customer_tab" | "bill";

export interface FinancialCheckoutPatch {
  mutationId: string;
  mode: FinancialCheckoutMode;
  entityType: FinancialCheckoutEntityType;
  entityId: string;
  userId: string;
  createdAt: string;
  baseAppStateVersion: number;
  bill: Bill;
  bills: Bill[];
  payments: Payment[];
  stockMovements: StockMovement[];
  auditLogs: AuditLog[];
  customers: Customer[];
  sessions: Session[];
  customerTabs: CustomerTab[];
  inventoryItems: InventoryItem[];
}

export interface FinancialCheckoutCommitResult {
  mutationId: string;
  rpcName: string;
  organizationId: string;
  entityType: FinancialCheckoutPatch["entityType"];
  entityId: string;
  billId: string;
  billNumber?: string;
  appStateVersion?: number;
  eventId?: string;
  serverTime?: string;
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
  raw?: unknown;
}

export type FinancialAdjustmentKind = "settlePendingBills" | "writeOffPendingBills" | "voidBill" | "refundBill";

export interface FinancialAdjustmentPatch {
  mutationId: string;
  kind: FinancialAdjustmentKind;
  entityType: "bill" | "bill_group";
  entityId: string;
  userId: string;
  createdAt: string;
  baseAppStateVersion: number;
  bills: Bill[];
  payments: Payment[];
  stockMovements: StockMovement[];
  auditLogs: AuditLog[];
  inventoryItems: InventoryItem[];
}

export interface FinancialAdjustmentCommitResult {
  mutationId: string;
  rpcName: string;
  organizationId: string;
  kind: FinancialAdjustmentKind;
  entityType: FinancialAdjustmentPatch["entityType"];
  entityId: string;
  appStateVersion?: number;
  eventId?: string;
  serverTime?: string;
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
  raw?: unknown;
}

export interface AdminDataChangePatch {
  mutationId: string;
  entityType: "admin_data";
  entityId: string;
  userId: string;
  createdAt: string;
  baseAppStateVersion: number;
  inventoryCategories?: string[];
  inventoryItems: InventoryItem[];
  inventoryItemIdsToDelete: string[];
  combos: ComboPackage[];
  comboIdsToDelete: string[];
  stockMovements: StockMovement[];
  auditLogs: AuditLog[];
  expenses: Expense[];
  expenseIdsToDelete: string[];
  expenseTemplates: ExpenseTemplate[];
  expenseTemplateIdsToDelete: string[];
  expenseTemplateOverrides: ExpenseTemplateOverride[];
  expenseTemplateOverrideIdsToDelete: string[];
  stations: Station[];
  stationIdsToDelete: string[];
  pricingRules: PricingRule[];
  pricingRuleIdsToDelete: string[];
  customers: Customer[];
  customerIdsToDelete: string[];
  businessProfile?: BusinessProfile;
}

export interface AdminDataChangeCommitResult {
  mutationId: string;
  rpcName: string;
  organizationId: string;
  entityType: AdminDataChangePatch["entityType"];
  entityId: string;
  appStateVersion?: number;
  eventId?: string;
  serverTime?: string;
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
  raw?: unknown;
}

export interface RemoteDataGateway {
  loadAppDataSnapshot(): Promise<RemoteAppDataSnapshot>;
  saveAppData(
    appData: AppData,
    activeUserId: string,
    expectedVersion: number,
    telemetryOptions?: SaveRemoteTelemetryOptions
  ): Promise<number>;
  commitOperationalMutation?(mutation: OperationalMutation): Promise<OperationalRpcCommitResult>;
  commitFinancialCheckout?(patch: FinancialCheckoutPatch): Promise<FinancialCheckoutCommitResult>;
  commitFinancialAdjustment?(patch: FinancialAdjustmentPatch): Promise<FinancialAdjustmentCommitResult>;
  commitAdminDataChange?(patch: AdminDataChangePatch): Promise<AdminDataChangeCommitResult>;
  subscribeToAppData(onChange: (snapshot: RemoteAppDataSnapshot) => void): () => void;
}
