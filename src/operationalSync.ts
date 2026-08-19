import type {
  AppData,
  AuditLog,
  Customer,
  CustomerTab,
  CustomerTabItem,
  Session,
  SessionComboApplication,
  SessionItem,
  SessionPauseLog,
  StockMovement
} from "./types";
import {
  cloneValue,
  findCustomerProfileMatch,
  getCustomerDisplayName,
  getLineStockQuantity,
  normalizeCustomerName,
  normalizeCustomerPhone,
  sumBy
} from "./utils";

export const PENDING_OPERATION_STORAGE_KEY = "game-parlour-management-system/pending-operations/v1";

export type OperationalMutationKind =
  | "startSession"
  | "pauseSession"
  | "resumeSession"
  | "editPauseLog"
  | "deletePauseLog"
  | "recordSessionAudit"
  | "addSessionItem"
  | "removeSessionItem"
  | "hopSession"
  | "rejectSession"
  | "repeatSessionCombo"
  | "openCustomerTab"
  | "linkCustomerTabContinuation"
  | "applyCustomerTabCombo"
  | "addCustomerTabItem"
  | "updateCustomerTabItemQuantity"
  | "removeCustomerTabItem"
  | "rejectCustomerTab"
  | "saveLiveSessionDetails"
  | "saveLiveCustomerTabDetails";

export type OperationalSyncStatus = "pending" | "syncing" | "failed" | "conflict";

export type OperationalMutationAcknowledgement =
  | { status: "synced" }
  | { status: "failed" | "conflict"; failureReason: string };

export function createOperationalMutationAcknowledgementRegistry() {
  const settledOutcomes = new Map<string, OperationalMutationAcknowledgement>();
  const waiters = new Map<
    string,
    {
      promise: Promise<OperationalMutationAcknowledgement>;
      resolve: (outcome: OperationalMutationAcknowledgement) => void;
      timeoutId?: number;
    }
  >();

  return {
    waitFor(mutationId: string, timeoutMs?: number): Promise<OperationalMutationAcknowledgement> {
      const settledOutcome = settledOutcomes.get(mutationId);
      if (settledOutcome) {
        settledOutcomes.delete(mutationId);
        return Promise.resolve(settledOutcome);
      }
      const existing = waiters.get(mutationId);
      if (existing) {
        return existing.promise;
      }
      let resolveOutcome!: (outcome: OperationalMutationAcknowledgement) => void;
      const promise = new Promise<OperationalMutationAcknowledgement>((resolve) => {
        resolveOutcome = resolve;
      });
      const timeoutId = timeoutMs === undefined
        ? undefined
        : window.setTimeout(() => {
            const waiter = waiters.get(mutationId);
            if (!waiter) {
              return;
            }
            waiters.delete(mutationId);
            waiter.resolve({
              status: "failed",
              failureReason: "The server did not confirm this action in time. Review the latest state before retrying."
            });
          }, timeoutMs);
      waiters.set(mutationId, { promise, resolve: resolveOutcome, timeoutId });
      return promise;
    },
    settle(mutationId: string, outcome: OperationalMutationAcknowledgement) {
      const waiter = waiters.get(mutationId);
      if (!waiter) {
        settledOutcomes.set(mutationId, outcome);
        if (settledOutcomes.size > 100) {
          const oldestMutationId = settledOutcomes.keys().next().value;
          if (oldestMutationId) {
            settledOutcomes.delete(oldestMutationId);
          }
        }
        return;
      }
      waiters.delete(mutationId);
      if (waiter.timeoutId !== undefined) {
        window.clearTimeout(waiter.timeoutId);
      }
      waiter.resolve(outcome);
    },
    discard(mutationId: string) {
      settledOutcomes.delete(mutationId);
      const waiter = waiters.get(mutationId);
      if (!waiter) {
        return;
      }
      waiters.delete(mutationId);
      if (waiter.timeoutId !== undefined) {
        window.clearTimeout(waiter.timeoutId);
      }
    },
    has(mutationId: string) {
      return waiters.has(mutationId) || settledOutcomes.has(mutationId);
    }
  };
}

interface OperationalCustomerPayload {
  id: string;
  name?: string;
  phone?: string;
  visitAt: string;
}

interface StartSessionPayload {
  session: Session;
  customer?: OperationalCustomerPayload;
  stockMovements: StockMovement[];
  auditLogs: AuditLog[];
}

interface PauseSessionPayload {
  sessionId: string;
  pauseLog: SessionPauseLog;
  auditLog: AuditLog;
}

interface ResumeSessionPayload {
  sessionId: string;
  pauseLogId?: string;
  resumedAt: string;
  auditLog: AuditLog;
}

interface EditPauseLogPayload {
  sessionId: string;
  pauseLog: SessionPauseLog;
  auditLog: AuditLog;
}

interface DeletePauseLogPayload {
  sessionId: string;
  pauseLogId: string;
  auditLog: AuditLog;
}

interface RecordSessionAuditPayload {
  auditLog: AuditLog;
}

interface AddSessionItemPayload {
  sessionId: string;
  item: SessionItem;
  stockMovement?: StockMovement;
  auditLog: AuditLog;
}

interface RemoveSessionItemPayload {
  sessionId: string;
  sessionItemId: string;
  stockMovement?: StockMovement;
  auditLog?: AuditLog;
}

interface RejectSessionPayload {
  session: Session;
  pauseLog?: SessionPauseLog;
  auditLog: AuditLog;
}

interface RepeatSessionComboPayload {
  sessionId: string;
  comboApplication: SessionComboApplication;
  items: SessionItem[];
  stockMovements: StockMovement[];
  auditLog: AuditLog;
}

interface OpenCustomerTabPayload {
  tab: CustomerTab;
  customer?: OperationalCustomerPayload;
  auditLog: AuditLog;
}

interface LinkCustomerTabContinuationPayload {
  customerTabId: string;
  continuedFromSessionIds: string[];
  auditLogs: AuditLog[];
}

interface ApplyCustomerTabComboPayload {
  customerTabId: string;
  comboApplication: SessionComboApplication;
  items: CustomerTabItem[];
  auditLog: AuditLog;
}

interface AddCustomerTabItemPayload {
  customerTabId: string;
  line: CustomerTabItem;
  quantityDelta: number;
  auditLog: AuditLog;
}

interface UpdateCustomerTabItemQuantityPayload {
  customerTabId: string;
  lineId: string;
  quantity: number;
}

interface RemoveCustomerTabItemPayload {
  customerTabId: string;
  lineId: string;
  auditLog?: AuditLog;
}

interface RejectCustomerTabPayload {
  tab: CustomerTab;
  auditLog: AuditLog;
}

interface SaveLiveSessionDetailsPayload {
  sessionId: string;
  customer?: OperationalCustomerPayload;
  customerName?: string;
  customerPhone?: string;
  startedAt?: string;
  auditLog?: AuditLog;
}

interface SaveLiveCustomerTabDetailsPayload {
  customerTabId: string;
  customer?: OperationalCustomerPayload;
  customerName: string;
  customerPhone?: string;
  auditLog?: AuditLog;
}

export type OperationalMutationPayload =
  | StartSessionPayload
  | PauseSessionPayload
  | ResumeSessionPayload
  | EditPauseLogPayload
  | DeletePauseLogPayload
  | RecordSessionAuditPayload
  | AddSessionItemPayload
  | RemoveSessionItemPayload
  | RejectSessionPayload
  | RepeatSessionComboPayload
  | OpenCustomerTabPayload
  | LinkCustomerTabContinuationPayload
  | ApplyCustomerTabComboPayload
  | AddCustomerTabItemPayload
  | UpdateCustomerTabItemQuantityPayload
  | RemoveCustomerTabItemPayload
  | RejectCustomerTabPayload
  | SaveLiveSessionDetailsPayload
  | SaveLiveCustomerTabDetailsPayload;

export interface OperationalMutation {
  id: string;
  kind: OperationalMutationKind;
  label: string;
  userId: string;
  createdAt: string;
  baseVersion: number;
  status: OperationalSyncStatus;
  entityType: "session" | "customer_tab";
  entityId: string;
  payload: OperationalMutationPayload;
  failureReason?: string;
  retryPolicy?: "automatic" | "manual";
  optimistic?: boolean;
  acknowledgementRequired?: boolean;
}

export interface OperationalValidationResult {
  ok: boolean;
  reason?: string;
}

export interface OperationalRebaseResult {
  appData: AppData;
  pendingMutations: OperationalMutation[];
  conflicts: OperationalMutation[];
}

export function isOperationalMutationSyncable(mutation: OperationalMutation) {
  return (
    mutation.status === "pending" ||
    (mutation.status === "failed" && mutation.retryPolicy !== "manual")
  );
}

export function getOperationalMutationForDispatch(
  mutations: OperationalMutation[],
  mutationId: string
) {
  const mutation = mutations.find((entry) => entry.id === mutationId);
  if (
    !mutation ||
    (mutation.status !== "syncing" && !isOperationalMutationSyncable(mutation))
  ) {
    return undefined;
  }
  return mutation;
}

function insertFirstUnique<T extends { id: string }>(collection: T[], entry: T) {
  if (collection.some((candidate) => candidate.id === entry.id)) {
    return;
  }
  collection.unshift(cloneValue(entry));
}

function pushUnique<T extends { id: string }>(collection: T[], entry: T) {
  if (collection.some((candidate) => candidate.id === entry.id)) {
    return;
  }
  collection.push(cloneValue(entry));
}

function getSessionReservedQuantity(appData: AppData, itemId: string, ignoreSessionId?: string) {
  return sumBy(
    appData.sessions.filter((session) => session.status !== "closed" && session.id !== ignoreSessionId),
    (session) =>
      sumBy(
        session.items.filter((item) => item.inventoryItemId === itemId),
        (item) => getLineStockQuantity(item)
      )
  );
}

function getCustomerTabReservedQuantity(
  appData: AppData,
  itemId: string,
  options?: { ignoreCustomerTabId?: string; ignoreCustomerTabItemId?: string }
) {
  return sumBy(
    appData.customerTabs.filter((tab) => {
      if (tab.status !== "open") {
        return false;
      }
      if (options?.ignoreCustomerTabItemId) {
        return true;
      }
      return tab.id !== options?.ignoreCustomerTabId;
    }),
    (tab) =>
      sumBy(
        tab.items.filter(
          (item) =>
            item.inventoryItemId === itemId &&
            !(
              options?.ignoreCustomerTabItemId &&
              tab.id === options.ignoreCustomerTabId &&
              item.id === options.ignoreCustomerTabItemId
            )
        ),
        (item) => getLineStockQuantity(item)
      )
  );
}

function getAvailableStockFromData(
  appData: AppData,
  itemId: string,
  options?: { ignoreSessionId?: string; ignoreCustomerTabId?: string; ignoreCustomerTabItemId?: string }
) {
  const item = appData.inventoryItems.find((entry) => entry.id === itemId);
  if (!item) {
    return 0;
  }
  return Math.max(
    0,
    item.stockQty -
      getSessionReservedQuantity(appData, itemId, options?.ignoreSessionId) -
      getCustomerTabReservedQuantity(appData, itemId, {
        ignoreCustomerTabId: options?.ignoreCustomerTabId,
        ignoreCustomerTabItemId: options?.ignoreCustomerTabItemId
      })
  );
}

function sameOptionalValue(left: string | number | undefined, right: string | number | undefined) {
  return (left ?? null) === (right ?? null);
}

function isSameInventorySaleLine(
  left: Pick<CustomerTabItem | SessionItem, "inventoryItemId" | "soldAsPackOf" | "saleVariantId" | "comboApplicationId" | "comboId">,
  right: Pick<CustomerTabItem | SessionItem, "inventoryItemId" | "soldAsPackOf" | "saleVariantId" | "comboApplicationId" | "comboId">
) {
  return (
    left.inventoryItemId === right.inventoryItemId &&
    sameOptionalValue(left.soldAsPackOf, right.soldAsPackOf) &&
    sameOptionalValue(left.saleVariantId, right.saleVariantId) &&
    sameOptionalValue(left.comboApplicationId, right.comboApplicationId) &&
    sameOptionalValue(left.comboId, right.comboId)
  );
}

function getRequiredStockByItem(lines: Array<{ inventoryItemId: string; quantity: number; soldAsPackOf?: number; stockUnitsPerSale?: number }>) {
  return lines.reduce<Record<string, number>>((totals, line) => {
    totals[line.inventoryItemId] = (totals[line.inventoryItemId] ?? 0) + getLineStockQuantity(line);
    return totals;
  }, {});
}

function validateStockRequirements(
  appData: AppData,
  lines: Array<{ inventoryItemId: string; quantity: number; soldAsPackOf?: number; stockUnitsPerSale?: number }>,
  options?: { ignoreSessionId?: string; ignoreCustomerTabId?: string; ignoreCustomerTabItemId?: string }
): OperationalValidationResult {
  const requiredByItem = getRequiredStockByItem(lines);
  for (const [itemId, required] of Object.entries(requiredByItem)) {
    const item = appData.inventoryItems.find((entry) => entry.id === itemId);
    if (!item) {
      return { ok: false, reason: "An inventory item used by this action no longer exists." };
    }
    if (required > getAvailableStockFromData(appData, itemId, options)) {
      return { ok: false, reason: `${item.name} no longer has enough available stock.` };
    }
  }
  return { ok: true };
}

function resolveOperationalCustomer(appData: AppData, customer?: OperationalCustomerPayload) {
  const name = customer?.name?.trim() ?? "";
  const phone = customer?.phone?.trim() ?? "";
  if (!customer || (!name && !phone)) {
    return undefined;
  }
  const existing = findCustomerProfileMatch(appData, name, phone);
  if (existing) {
    existing.name = getCustomerDisplayName(name, phone);
    existing.phone = phone || existing.phone;
    existing.createdAt = existing.createdAt || existing.lastVisitAt || customer.visitAt;
    existing.lastVisitAt = customer.visitAt;
    return existing.id;
  }
  const nextCustomer: Customer = {
    id: customer.id,
    name: getCustomerDisplayName(name, phone),
    phone: phone || undefined,
    createdAt: customer.visitAt,
    lastVisitAt: customer.visitAt
  };
  appData.customers.unshift(nextCustomer);
  return nextCustomer.id;
}

function hasOpenMatchingCustomerTab(appData: AppData, tab: CustomerTab) {
  const normalizedName = normalizeCustomerName(tab.customerName);
  const normalizedPhone = normalizeCustomerPhone(tab.customerPhone);
  return appData.customerTabs.some((entry) => {
    if (entry.id === tab.id || entry.status !== "open") {
      return false;
    }
    if (tab.customerId && entry.customerId === tab.customerId) {
      return true;
    }
    if (normalizedPhone && normalizeCustomerPhone(entry.customerPhone) === normalizedPhone) {
      return true;
    }
    return normalizedName !== "" && normalizeCustomerName(entry.customerName) === normalizedName;
  });
}

function getSessionPayload(mutation: OperationalMutation): StartSessionPayload {
  return mutation.payload as StartSessionPayload;
}

export function validateOperationalMutation(appData: AppData, mutation: OperationalMutation): OperationalValidationResult {
  switch (mutation.kind) {
    case "startSession": {
      const payload = getSessionPayload(mutation);
      if (appData.sessions.some((session) => session.id === payload.session.id)) {
        return { ok: true };
      }
      const station = appData.stations.find((entry) => entry.id === payload.session.stationId && entry.active);
      if (!station) {
        return { ok: false, reason: "The station is no longer available." };
      }
      const occupied = appData.sessions.some(
        (session) => session.stationId === payload.session.stationId && session.status !== "closed"
      );
      if (occupied) {
        return { ok: false, reason: `${station.name} already has an open session.` };
      }
      return validateStockRequirements(appData, payload.session.items);
    }
    case "pauseSession": {
      const payload = mutation.payload as PauseSessionPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId);
      if (!session || session.status === "closed") {
        return { ok: false, reason: "The session is no longer open." };
      }
      return session.status === "active" || session.pauseLogIds.includes(payload.pauseLog.id)
        ? { ok: true }
        : { ok: false, reason: "The session is not active." };
    }
    case "resumeSession": {
      const payload = mutation.payload as ResumeSessionPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId);
      if (!session || session.status === "closed") {
        return { ok: false, reason: "The session is no longer open." };
      }
      return session.status === "paused" || session.status === "active"
        ? { ok: true }
        : { ok: false, reason: "The session cannot be resumed." };
    }
    case "editPauseLog": {
      const payload = mutation.payload as EditPauseLogPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      const pauseLog = appData.sessionPauseLogs.find((entry) => entry.id === payload.pauseLog.id && entry.sessionId === payload.sessionId);
      return session && pauseLog ? { ok: true } : { ok: false, reason: "The pause log is no longer editable." };
    }
    case "deletePauseLog": {
      const payload = mutation.payload as DeletePauseLogPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      return session ? { ok: true } : { ok: false, reason: "The pause log is no longer editable." };
    }
    case "recordSessionAudit": {
      const payload = mutation.payload as RecordSessionAuditPayload;
      return payload.auditLog.entityId === mutation.entityId
        ? { ok: true }
        : { ok: false, reason: "The session audit is invalid." };
    }
    case "addSessionItem": {
      const payload = mutation.payload as AddSessionItemPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      if (!session) {
        return { ok: false, reason: "The session is no longer open." };
      }
      if (session.items.some((item) => item.id === payload.item.id)) {
        return { ok: true };
      }
      return validateStockRequirements(appData, [payload.item]);
    }
    case "removeSessionItem": {
      const payload = mutation.payload as RemoveSessionItemPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      return session ? { ok: true } : { ok: false, reason: "The session is no longer open." };
    }
    case "hopSession": {
      const payload = mutation.payload as RejectSessionPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.session.id && entry.status !== "closed");
      return session ? { ok: true } : { ok: false, reason: "The session is no longer open." };
    }
    case "rejectSession": {
      const payload = mutation.payload as RejectSessionPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.session.id && entry.status !== "closed");
      return session ? { ok: true } : { ok: false, reason: "The session is no longer open." };
    }
    case "repeatSessionCombo": {
      const payload = mutation.payload as RepeatSessionComboPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      if (!session) {
        return { ok: false, reason: "The session is no longer open." };
      }
      if ((session.comboApplications ?? []).some((combo) => combo.id === payload.comboApplication.id)) {
        return { ok: true };
      }
      return validateStockRequirements(appData, payload.items);
    }
    case "openCustomerTab": {
      const payload = mutation.payload as OpenCustomerTabPayload;
      if (appData.customerTabs.some((tab) => tab.id === payload.tab.id)) {
        return { ok: true };
      }
      return hasOpenMatchingCustomerTab(appData, payload.tab)
        ? { ok: false, reason: "A matching customer tab is already open." }
        : { ok: true };
    }
    case "linkCustomerTabContinuation": {
      const payload = mutation.payload as LinkCustomerTabContinuationPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (!tab) {
        return { ok: false, reason: "The customer tab is no longer open." };
      }
      const continuationIds = Array.from(new Set(payload.continuedFromSessionIds.filter(Boolean)));
      if (continuationIds.length === 0) {
        return { ok: false, reason: "No hopped session was selected for this customer tab." };
      }
      const alreadyLinked = new Set(tab.continuedFromSessionIds ?? []);
      for (const sessionId of continuationIds) {
        if (alreadyLinked.has(sessionId)) {
          continue;
        }
        const session = appData.sessions.find((entry) => entry.id === sessionId);
        if (!session || session.closeDisposition !== "hopped" || session.closedBillId) {
          return { ok: false, reason: "The hopped session is no longer available for this customer tab." };
        }
      }
      return { ok: true };
    }
    case "applyCustomerTabCombo": {
      const payload = mutation.payload as ApplyCustomerTabComboPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (!tab) {
        return { ok: false, reason: "The customer tab is no longer open." };
      }
      if ((tab.comboApplications ?? []).some((combo) => combo.id === payload.comboApplication.id)) {
        return { ok: true };
      }
      return validateStockRequirements(appData, payload.items);
    }
    case "addCustomerTabItem": {
      const payload = mutation.payload as AddCustomerTabItemPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (!tab) {
        return { ok: false, reason: "The customer tab is no longer open." };
      }
      if (tab.items.some((line) => line.id === payload.line.id)) {
        return { ok: true };
      }
      return validateStockRequirements(appData, [{ ...payload.line, quantity: payload.quantityDelta }]);
    }
    case "updateCustomerTabItemQuantity": {
      const payload = mutation.payload as UpdateCustomerTabItemQuantityPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      const line = tab?.items.find((entry) => entry.id === payload.lineId);
      if (!tab || !line) {
        return { ok: false, reason: "The customer tab item is no longer available." };
      }
      return validateStockRequirements(appData, [{ ...line, quantity: payload.quantity }], {
        ignoreCustomerTabId: payload.customerTabId,
        ignoreCustomerTabItemId: payload.lineId
      });
    }
    case "removeCustomerTabItem": {
      const payload = mutation.payload as RemoveCustomerTabItemPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      return tab ? { ok: true } : { ok: false, reason: "The customer tab is no longer open." };
    }
    case "rejectCustomerTab": {
      const payload = mutation.payload as RejectCustomerTabPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.tab.id && entry.status === "open");
      return tab ? { ok: true } : { ok: false, reason: "The customer tab is no longer open." };
    }
    case "saveLiveSessionDetails": {
      const payload = mutation.payload as SaveLiveSessionDetailsPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      return session ? { ok: true } : { ok: false, reason: "The session is no longer open." };
    }
    case "saveLiveCustomerTabDetails": {
      const payload = mutation.payload as SaveLiveCustomerTabDetailsPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      return tab ? { ok: true } : { ok: false, reason: "The customer tab is no longer open." };
    }
    default:
      return { ok: false, reason: "Unsupported pending operation." };
  }
}

export function applyOperationalMutation(
  source: AppData,
  mutation: OperationalMutation,
  options?: { skipValidation?: boolean }
): AppData {
  const appData = cloneValue(source);
  if (!options?.skipValidation) {
    const validation = validateOperationalMutation(appData, mutation);
    if (!validation.ok) {
      throw new Error(validation.reason ?? "Pending operation cannot be applied.");
    }
  }

  switch (mutation.kind) {
    case "startSession": {
      const payload = mutation.payload as StartSessionPayload;
      if (!appData.sessions.some((session) => session.id === payload.session.id)) {
        const session = cloneValue(payload.session);
        session.customerId = resolveOperationalCustomer(appData, payload.customer);
        appData.sessions.unshift(session);
      }
      for (const stockMovement of payload.stockMovements) {
        insertFirstUnique(appData.stockMovements, stockMovement);
      }
      for (const auditLog of payload.auditLogs) {
        insertFirstUnique(appData.auditLogs, auditLog);
      }
      break;
    }
    case "pauseSession": {
      const payload = mutation.payload as PauseSessionPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId);
      if (session && !session.pauseLogIds.includes(payload.pauseLog.id)) {
        pushUnique(appData.sessionPauseLogs, payload.pauseLog);
        session.pauseLogIds.push(payload.pauseLog.id);
        session.status = "paused";
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "resumeSession": {
      const payload = mutation.payload as ResumeSessionPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId);
      const openPause =
        (payload.pauseLogId
          ? appData.sessionPauseLogs.find((entry) => entry.id === payload.pauseLogId)
          : undefined) ??
        appData.sessionPauseLogs.find((entry) => entry.sessionId === payload.sessionId && !entry.resumedAt);
      if (openPause) {
        openPause.resumedAt = payload.resumedAt;
      }
      if (session) {
        session.status = "active";
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "editPauseLog": {
      const payload = mutation.payload as EditPauseLogPayload;
      const pauseLog = appData.sessionPauseLogs.find((entry) => entry.id === payload.pauseLog.id);
      if (pauseLog) {
        pauseLog.pausedAt = payload.pauseLog.pausedAt;
        pauseLog.resumedAt = payload.pauseLog.resumedAt;
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "deletePauseLog": {
      const payload = mutation.payload as DeletePauseLogPayload;
      const pauseLog = appData.sessionPauseLogs.find((entry) => entry.id === payload.pauseLogId);
      appData.sessionPauseLogs = appData.sessionPauseLogs.filter((entry) => entry.id !== payload.pauseLogId);
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId);
      if (session) {
        session.pauseLogIds = session.pauseLogIds.filter((id) => id !== payload.pauseLogId);
        if (pauseLog && !pauseLog.resumedAt && session.status === "paused") {
          session.status = "active";
        }
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "recordSessionAudit": {
      const payload = mutation.payload as RecordSessionAuditPayload;
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "addSessionItem": {
      const payload = mutation.payload as AddSessionItemPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      if (session && !session.items.some((item) => item.id === payload.item.id)) {
        session.items.push(cloneValue(payload.item));
      }
      if (payload.stockMovement) {
        insertFirstUnique(appData.stockMovements, payload.stockMovement);
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "removeSessionItem": {
      const payload = mutation.payload as RemoveSessionItemPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId);
      if (session) {
        session.items = session.items.filter((item) => item.id !== payload.sessionItemId);
      }
      if (payload.stockMovement) {
        insertFirstUnique(appData.stockMovements, payload.stockMovement);
      }
      if (payload.auditLog) {
        insertFirstUnique(appData.auditLogs, payload.auditLog);
      }
      break;
    }
    case "hopSession": {
      const payload = mutation.payload as RejectSessionPayload;
      const sessionIndex = appData.sessions.findIndex((entry) => entry.id === payload.session.id);
      if (sessionIndex >= 0) {
        appData.sessions[sessionIndex] = cloneValue(payload.session);
      }
      if (payload.pauseLog) {
        const pauseIndex = appData.sessionPauseLogs.findIndex((entry) => entry.id === payload.pauseLog?.id);
        if (pauseIndex >= 0) {
          appData.sessionPauseLogs[pauseIndex] = cloneValue(payload.pauseLog);
        } else {
          pushUnique(appData.sessionPauseLogs, payload.pauseLog);
        }
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "rejectSession": {
      const payload = mutation.payload as RejectSessionPayload;
      const sessionIndex = appData.sessions.findIndex((entry) => entry.id === payload.session.id);
      if (sessionIndex >= 0) {
        appData.sessions[sessionIndex] = cloneValue(payload.session);
      }
      if (payload.pauseLog) {
        const pauseIndex = appData.sessionPauseLogs.findIndex((entry) => entry.id === payload.pauseLog?.id);
        if (pauseIndex >= 0) {
          appData.sessionPauseLogs[pauseIndex] = cloneValue(payload.pauseLog);
        } else {
          pushUnique(appData.sessionPauseLogs, payload.pauseLog);
        }
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "repeatSessionCombo": {
      const payload = mutation.payload as RepeatSessionComboPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      if (session) {
        session.comboApplications = session.comboApplications ?? [];
        if (!session.comboApplications.some((combo) => combo.id === payload.comboApplication.id)) {
          session.comboApplications.push(cloneValue(payload.comboApplication));
        }
        for (const item of payload.items) {
          if (!session.items.some((entry) => entry.id === item.id)) {
            session.items.push(cloneValue(item));
          }
        }
      }
      for (const stockMovement of payload.stockMovements) {
        insertFirstUnique(appData.stockMovements, stockMovement);
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "openCustomerTab": {
      const payload = mutation.payload as OpenCustomerTabPayload;
      if (!appData.customerTabs.some((tab) => tab.id === payload.tab.id)) {
        const tab = cloneValue(payload.tab);
        tab.customerId = resolveOperationalCustomer(appData, payload.customer);
        appData.customerTabs.unshift(tab);
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "linkCustomerTabContinuation": {
      const payload = mutation.payload as LinkCustomerTabContinuationPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (tab) {
        tab.continuedFromSessionIds = Array.from(new Set([
          ...(tab.continuedFromSessionIds ?? []),
          ...payload.continuedFromSessionIds.filter(Boolean)
        ]));
      }
      for (const auditLog of payload.auditLogs) {
        insertFirstUnique(appData.auditLogs, auditLog);
      }
      break;
    }
    case "applyCustomerTabCombo": {
      const payload = mutation.payload as ApplyCustomerTabComboPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (tab) {
        tab.comboApplications = tab.comboApplications ?? [];
        if (!tab.comboApplications.some((combo) => combo.id === payload.comboApplication.id)) {
          tab.comboApplications.push(cloneValue(payload.comboApplication));
        }
        for (const item of payload.items) {
          if (!tab.items.some((entry) => entry.id === item.id)) {
            tab.items.push(cloneValue(item));
          }
        }
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "addCustomerTabItem": {
      const payload = mutation.payload as AddCustomerTabItemPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (tab && !tab.items.some((line) => line.id === payload.line.id)) {
        const existing = tab.items.find(
          (line) => isSameInventorySaleLine(line, payload.line)
        );
        if (existing) {
          existing.quantity += payload.quantityDelta;
        } else {
          tab.items.push(cloneValue(payload.line));
        }
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "updateCustomerTabItemQuantity": {
      const payload = mutation.payload as UpdateCustomerTabItemQuantityPayload;
      const line = appData.customerTabs
        .find((tab) => tab.id === payload.customerTabId && tab.status === "open")
        ?.items.find((entry) => entry.id === payload.lineId);
      if (line) {
        line.quantity = payload.quantity;
      }
      break;
    }
    case "removeCustomerTabItem": {
      const payload = mutation.payload as RemoveCustomerTabItemPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (tab) {
        tab.items = tab.items.filter((line) => line.id !== payload.lineId);
      }
      if (payload.auditLog) {
        insertFirstUnique(appData.auditLogs, payload.auditLog);
      }
      break;
    }
    case "rejectCustomerTab": {
      const payload = mutation.payload as RejectCustomerTabPayload;
      const tabIndex = appData.customerTabs.findIndex((entry) => entry.id === payload.tab.id);
      if (tabIndex >= 0) {
        appData.customerTabs[tabIndex] = cloneValue(payload.tab);
      }
      insertFirstUnique(appData.auditLogs, payload.auditLog);
      break;
    }
    case "saveLiveSessionDetails": {
      const payload = mutation.payload as SaveLiveSessionDetailsPayload;
      const session = appData.sessions.find((entry) => entry.id === payload.sessionId && entry.status !== "closed");
      if (session) {
        session.customerId = resolveOperationalCustomer(appData, payload.customer);
        session.customerName = payload.customerName?.trim() || undefined;
        session.customerPhone = payload.customerPhone?.trim() || undefined;
        if (payload.startedAt) {
          session.startedAt = payload.startedAt;
        }
      }
      if (payload.auditLog) {
        insertFirstUnique(appData.auditLogs, payload.auditLog);
      }
      break;
    }
    case "saveLiveCustomerTabDetails": {
      const payload = mutation.payload as SaveLiveCustomerTabDetailsPayload;
      const tab = appData.customerTabs.find((entry) => entry.id === payload.customerTabId && entry.status === "open");
      if (tab) {
        tab.customerId = resolveOperationalCustomer(appData, payload.customer);
        tab.customerName = payload.customerName;
        tab.customerPhone = payload.customerPhone?.trim() || undefined;
      }
      if (payload.auditLog) {
        insertFirstUnique(appData.auditLogs, payload.auditLog);
      }
      break;
    }
  }

  return appData;
}

export function rebasePendingMutations(remoteData: AppData, mutations: OperationalMutation[]): OperationalRebaseResult {
  let appData = cloneValue(remoteData);
  const pendingMutations: OperationalMutation[] = [];
  const conflicts: OperationalMutation[] = [];

  for (const mutation of mutations.filter((entry) => entry.status !== "conflict")) {
    const validation = validateOperationalMutation(appData, mutation);
    if (!validation.ok) {
      conflicts.push({
        ...mutation,
        status: "conflict",
        failureReason: validation.reason ?? "This pending operation conflicts with the latest server data."
      });
      continue;
    }
    if (mutation.optimistic !== false) {
      appData = applyOperationalMutation(appData, mutation);
    }
    pendingMutations.push({
      ...mutation,
      status:
        mutation.retryPolicy === "manual" && mutation.status === "failed"
          ? "failed"
          : "pending",
      failureReason:
        mutation.retryPolicy === "manual" && mutation.status === "failed"
          ? mutation.failureReason
          : undefined
    });
  }

  return { appData, pendingMutations, conflicts };
}

export function hasPendingOperationalMutationForEntity(
  mutations: OperationalMutation[],
  entityType: OperationalMutation["entityType"],
  entityId?: string
) {
  if (!entityId) {
    return false;
  }
  return mutations.some(
    (mutation) =>
      mutation.entityType === entityType &&
      mutation.entityId === entityId &&
      (mutation.status === "pending" || mutation.status === "syncing" || mutation.status === "failed")
  );
}

export function getOperationalConflictMessages(mutations: OperationalMutation[]) {
  return mutations
    .filter((mutation) => mutation.status === "conflict")
    .map((mutation) => `${mutation.label}: ${mutation.failureReason ?? "Conflicts with the latest server data."}`);
}

export function loadPendingOperationalMutations(): OperationalMutation[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const storedValue = window.localStorage.getItem(PENDING_OPERATION_STORAGE_KEY);
    if (!storedValue) {
      return [];
    }
    const parsed = JSON.parse(storedValue) as OperationalMutation[];
    return Array.isArray(parsed)
      ? parsed.filter((mutation) => mutation.id && mutation.kind && mutation.payload)
      : [];
  } catch {
    return [];
  }
}

export function savePendingOperationalMutations(mutations: OperationalMutation[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PENDING_OPERATION_STORAGE_KEY, JSON.stringify(mutations));
  } catch (error) {
    console.warn("Unable to cache pending operational mutations locally.", error);
  }
}
