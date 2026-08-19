import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import type { AuditLog, Bill, Customer, CustomerTab, InventoryItem, Payment, Session, SessionPauseLog, StockMovement } from "../types";
import { loadNormalizedBillsByIds } from "./normalizedBillRegister";
import { loadNormalizedCustomersByIds } from "./normalizedCustomerSearch";
import { resolveNormalizedOrganizationId } from "./normalizedOrganization";
import {
  loadNormalizedAuditLogsByIds,
  loadNormalizedInventoryItemsByIds,
  loadNormalizedLiveDataByIds,
  loadNormalizedStockMovementsByIds
} from "./normalizedReads";

export interface NormalizedFinancialDeltaQuery {
  billIds?: string[];
  paymentIds?: string[];
  sessionIds?: string[];
  customerTabIds?: string[];
  inventoryItemIds?: string[];
  customerIds?: string[];
  stockMovementIds?: string[];
  auditLogIds?: string[];
}

export interface NormalizedFinancialDelta {
  bills: Bill[];
  payments: Payment[];
  sessions: Session[];
  sessionPauseLogs: SessionPauseLog[];
  customerTabs: CustomerTab[];
  inventoryItems: InventoryItem[];
  customers: Customer[];
  stockMovements: StockMovement[];
  auditLogs: AuditLog[];
}

export async function loadNormalizedFinancialDelta(
  query: NormalizedFinancialDeltaQuery,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedFinancialDelta> {
  const organizationId = await resolveNormalizedOrganizationId(client);
  const [financial, live, inventoryItems, customers, stockMovements, auditLogs] = await Promise.all([
    loadNormalizedBillsByIds(
      { organizationId, billIds: query.billIds, paymentIds: query.paymentIds },
      client
    ),
    loadNormalizedLiveDataByIds(
      organizationId,
      { sessionIds: query.sessionIds, customerTabIds: query.customerTabIds },
      client
    ),
    loadNormalizedInventoryItemsByIds(organizationId, query.inventoryItemIds ?? [], client),
    loadNormalizedCustomersByIds(organizationId, query.customerIds ?? [], client),
    loadNormalizedStockMovementsByIds(organizationId, query.stockMovementIds ?? [], client),
    loadNormalizedAuditLogsByIds(organizationId, query.auditLogIds ?? [], client)
  ]);
  return { ...financial, ...live, inventoryItems, customers, stockMovements, auditLogs };
}
