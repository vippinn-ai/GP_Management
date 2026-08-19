import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import type { Bill, Customer, Payment } from "../types";
import { loadNormalizedActiveOrganization } from "./normalizedReads";
import { loadNormalizedBillRegisterPage, type NormalizedBillRegisterCursor } from "./normalizedBillRegister";

const CUSTOMER_SEARCH_READ_TIMEOUT_MS = 15_000;
const DEFAULT_CUSTOMER_SEARCH_LIMIT = 8;
const MAX_CUSTOMER_SEARCH_LIMIT = 25;
const CUSTOMER_DIRECTORY_PAGE_SIZE = 500;
const MAX_CUSTOMER_DIRECTORY_ROWS = 20_000;

const CUSTOMER_SELECT_COLUMNS = "id, name, phone, first_seen_at, last_visit_at, notes, raw_data, created_at, updated_at";

interface NormalizedQueryResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  first_seen_at: string | null;
  last_visit_at: string | null;
  notes: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface NormalizedCustomerSearchQuery {
  organizationId?: string;
  search: string;
  limit?: number;
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

function normalizeCustomerPhoneQuery(value: string): string {
  const digits = value.match(/[\d+]+/g)?.join("") ?? "";
  return digits.replace(/(?!^)\+/g, "");
}

function sanitizePostgrestSearchValue(value: string): string {
  return value.trim().replace(/[%_,()]/g, "").replace(/\s+/g, "%");
}

function resolveCustomerSearchLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_CUSTOMER_SEARCH_LIMIT;
  }
  return Math.min(MAX_CUSTOMER_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

async function withCustomerSearchTimeout<T>(request: PromiseLike<T>, action: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach normalized data while ${action}.`));
    }, CUSTOMER_SEARCH_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function readMany<T>(request: PromiseLike<NormalizedQueryResult<T[]>>, action: string): Promise<T[]> {
  const result = await withCustomerSearchTimeout(request, action);
  if (result.error) {
    throw result.error;
  }
  return result.data ?? [];
}

export function buildCustomerSearchFilter(search: string): string {
  const textQuery = sanitizePostgrestSearchValue(search);
  const phoneQuery = sanitizePostgrestSearchValue(normalizeCustomerPhoneQuery(search));
  const clauses: string[] = [];

  if (textQuery) {
    clauses.push(`name.ilike.%${textQuery}%`);
  }
  if (phoneQuery) {
    clauses.push(`phone.ilike.%${phoneQuery}%`);
  }

  return clauses.join(",");
}

export function mapNormalizedCustomer(row: CustomerRow): Customer {
  const raw = toRecord(row.raw_data);
  const createdAt = toStringValue(raw.createdAt, row.first_seen_at ?? row.created_at);
  return {
    id: row.id,
    name: toStringValue(row.name, toStringValue(raw.name, "Walk-in customer")),
    phone: toOptionalString(row.phone) ?? toOptionalString(raw.phone),
    createdAt,
    lastVisitAt: toStringValue(raw.lastVisitAt, row.last_visit_at ?? row.updated_at ?? createdAt),
    notes: toOptionalString(row.notes) ?? toOptionalString(raw.notes)
  };
}

export async function loadNormalizedCustomerSearch(
  query: NormalizedCustomerSearchQuery,
  client: SupabaseClient = getSupabaseClient()
): Promise<Customer[]> {
  const searchFilter = buildCustomerSearchFilter(query.search);
  if (!searchFilter) {
    return [];
  }

  const organizationId = query.organizationId ?? (await loadNormalizedActiveOrganization(client)).id;
  const rows = await readMany<CustomerRow>(
    client
      .from("customers")
      .select(CUSTOMER_SELECT_COLUMNS)
      .eq("organization_id", organizationId)
      .or(searchFilter)
      .order("last_visit_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(resolveCustomerSearchLimit(query.limit)),
    "searching normalized customers"
  );

  return rows.map(mapNormalizedCustomer);
}

export async function loadNormalizedCustomersByIds(
  organizationId: string,
  customerIds: string[],
  client: SupabaseClient = getSupabaseClient()
): Promise<Customer[]> {
  const ids = Array.from(new Set(customerIds.filter(Boolean)));
  if (ids.length === 0) return [];
  const rows = await readMany<CustomerRow>(
    client
      .from("customers")
      .select(CUSTOMER_SELECT_COLUMNS)
      .eq("organization_id", organizationId)
      .in("id", ids),
    "loading changed customers"
  );
  return rows.map(mapNormalizedCustomer);
}

export async function loadNormalizedCustomerDirectory(
  organizationId: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<Customer[]> {
  const customers: Customer[] = [];
  let exhaustedDirectory = false;
  for (let from = 0; from < MAX_CUSTOMER_DIRECTORY_ROWS; from += CUSTOMER_DIRECTORY_PAGE_SIZE) {
    const rows = await readMany<CustomerRow>(
      client
        .from("customers")
        .select(CUSTOMER_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .order("last_visit_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + CUSTOMER_DIRECTORY_PAGE_SIZE - 1),
      "loading the normalized customer directory"
    );
    customers.push(...rows.map(mapNormalizedCustomer));
    if (rows.length < CUSTOMER_DIRECTORY_PAGE_SIZE) {
      exhaustedDirectory = true;
      break;
    }
  }
  if (!exhaustedDirectory) {
    throw new Error(
      `Normalized customer directory exceeded the safe ${MAX_CUSTOMER_DIRECTORY_ROWS.toLocaleString("en-IN")} row limit. Refine the server reader before showing partial customer history.`
    );
  }
  return customers;
}

export interface NormalizedCustomerHistoryData {
  customers: Customer[];
  bills: Bill[];
  payments: Payment[];
}

export async function loadNormalizedCustomerHistoryData(
  organizationId?: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedCustomerHistoryData> {
  const resolvedOrganizationId = organizationId ?? (await loadNormalizedActiveOrganization(client)).id;
  const customersPromise = loadNormalizedCustomerDirectory(resolvedOrganizationId, client);
  const bills: Bill[] = [];
  const payments: Payment[] = [];
  let cursor: NormalizedBillRegisterCursor | undefined;
  do {
    const page = await loadNormalizedBillRegisterPage({
      organizationId: resolvedOrganizationId,
      cursor,
      limit: 200
    }, client);
    bills.push(...page.bills);
    payments.push(...page.payments);
    cursor = page.hasMore ? page.nextCursor : undefined;
    if (page.hasMore && !cursor) {
      throw new Error("Normalized customer history pagination stopped before all bills were loaded.");
    }
  } while (cursor);
  return { customers: Array.from(new Map((await customersPromise).map((entry) => [entry.id, entry])).values()), bills, payments };
}
