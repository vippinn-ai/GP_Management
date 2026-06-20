import type { RemoteAppDataSnapshot, SaveRemoteTelemetryOptions } from "../backend";
import type { OperationalMutation } from "../operationalSync";
import type { AppData, AuditLog, Bill, Customer, CustomerTab, InventoryItem, Payment, Session, StockMovement } from "../types";

export interface OperationalRpcCommitResult {
  mutationId: string;
  rpcName: string;
  organizationId: string;
  entityType: OperationalMutation["entityType"];
  entityId: string;
  eventId?: string;
  serverTime?: string;
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
  raw?: unknown;
}

export interface FinancialCheckoutPatch {
  mutationId: string;
  mode: "session" | "customer_tab";
  entityType: "session" | "customer_tab";
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
  subscribeToAppData(onChange: (snapshot: RemoteAppDataSnapshot) => void): () => void;
}
