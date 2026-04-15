import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import brandLogo from "../Branding/Logo.png";
import {
  buildReceiptPreviewModel,
  downloadReceiptPdf,
  exportRowsToCsv,
  exportRowsToPdf,
  exportRowsToXlsx,
  openReceiptWindow,
  type ReportRow
} from "./exporters";
import { calculateSessionCharge } from "./pricing";
import { loadAppData, saveAppData } from "./storage";
import { seedAppData } from "./seed";
import {
  adminChangePasswordRemote,
  adminCreateUserRemote,
  adminToggleUserActiveRemote,
  adminUpdateUserRemote,
  fetchCurrentProfile,
  isBackendConfigured,
  loadRemoteAppDataSnapshot,
  saveRemoteAppData,
  signInWithUsername,
  signOutRemote,
  subscribeToRemoteAppData
} from "./backend";
import type {
  AppData,
  AppliedDiscount,
  BillLine,
  BusinessProfile,
  CustomerTab,
  CustomerTabItem,
  DiscountType,
  DraftBillLine,
  DraftDiscountInput,
  InventoryItem,
  ExpenseTemplate,
  LtpOutcome,
  PaymentMode,
  PlayMode,
  PricingRule,
  Role,
  Session,
  SessionChargeSummary,
  SessionItem,
  Station,
  StockMovementType,
  User
} from "./types";
import {
  clampNumber,
  cloneValue,
  createId,
  currency,
  formatDateTime,
  formatMinutes,
  formatTime,
  isToday,
  minuteToTimeLabel,
  sumBy,
  toMinuteOfDay
} from "./utils";

type TabId = "dashboard" | "sale" | "inventory" | "reports" | "settings" | "users";

interface StartSessionDraft {
  stationId: string;
  customerName: string;
  customerPhone: string;
  playMode: PlayMode;
  arcadeItemId: string;
  arcadeQuantity: number;
}

interface CheckoutState {
  mode: "session" | "customer_tab" | "bill_replacement";
  sessionId?: string;
  customerTabId?: string;
  replacementBillId?: string;
  closedAt?: string;
  customerName: string;
  customerPhone: string;
  paymentMode: PaymentMode;
  roundOffEnabled: boolean;
  lineDiscounts: DraftLineDiscountMap;
  billDiscount?: DraftDiscountInput;
  ltpOutcome?: LtpOutcome;
  replacementLines?: DraftBillLine[];
  replaceReason?: string;
}

interface DraftLineDiscountMap {
  [lineId: string]: DraftDiscountInput | undefined;
}

interface CustomerTabDraft {
  customerName: string;
  customerPhone: string;
}

interface UserEditDraft {
  id: string;
  name: string;
  username: string;
  role: Role;
}

interface UserPasswordDraft {
  userId: string;
  password: string;
  confirmPassword: string;
}

type NumericInputMode = "integer" | "decimal";
type ReportPreset = "today" | "yesterday" | "last_7_days" | "this_month" | "last_month" | "this_year" | "custom";
type InventoryState = "out" | "low" | "healthy" | "occupied" | "available";

interface ReportFilterState {
  preset: ReportPreset;
  fromDate?: string;
  toDate?: string;
}

const DEFAULT_INVENTORY_CATEGORIES = ["Beverages", "Food", "Refill Sheesha", "Arcade"];
const DEFAULT_EXPENSE_CATEGORIES = ["Utilities", "Rent", "Internet", "Salary", "Supplies", "Maintenance"];

const tabsByRole: Record<Role, Array<{ id: TabId; label: string }>> = {
  admin: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Customer Tabs" },
    { id: "inventory", label: "Inventory" },
    { id: "reports", label: "Reports" },
    { id: "settings", label: "Settings" },
    { id: "users", label: "Users" }
  ],
  manager: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Customer Tabs" },
    { id: "inventory", label: "Inventory" },
    { id: "reports", label: "Reports" },
    { id: "settings", label: "Settings" }
  ],
  receptionist: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Customer Tabs" }
  ]
};

function getDiscountAmount(subtotal: number, discount?: DraftDiscountInput): number {
  if (!discount || discount.value <= 0) {
    return 0;
  }
  if (discount.type === "amount") {
    return Math.min(subtotal, discount.value);
  }
  return Math.min(subtotal, (subtotal * discount.value) / 100);
}

function getSessionCheckoutLines(session: Session, chargeSummary: SessionChargeSummary): DraftBillLine[] {
  const lines: DraftBillLine[] = [];
  if (session.mode === "timed") {
    lines.push({
      id: `line-session-${session.id}`,
      type: "session_charge",
      description: `${session.stationNameSnapshot} session (${formatMinutes(chargeSummary.billedMinutes)})`,
      quantity: 1,
      unitPrice: chargeSummary.subtotal,
      linkedSessionId: session.id
    });
  }
  for (const item of session.items) {
    lines.push({
      id: `line-item-${item.id}`,
      type: "inventory_item",
      description: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      inventoryItemId: item.inventoryItemId
    });
  }
  return lines;
}

function getCustomerTabCheckoutLines(items: CustomerTabItem[]): DraftBillLine[] {
  return items.map((item) => ({
    id: item.id,
    type: "inventory_item",
    description: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    inventoryItemId: item.inventoryItemId
  }));
}

function cloneBillLinesForReplacement(bill: AppData["bills"][number]): DraftBillLine[] {
  return bill.lines.map((line) => ({
    id: line.id,
    type: line.type,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    linkedSessionId: line.linkedSessionId,
    inventoryItemId: line.inventoryItemId
  }));
}

function getInventoryQuantityMap(lines: Array<{ inventoryItemId?: string; quantity: number }>) {
  return lines.reduce<Record<string, number>>((totals, line) => {
    if (!line.inventoryItemId) {
      return totals;
    }
    totals[line.inventoryItemId] = (totals[line.inventoryItemId] ?? 0) + line.quantity;
    return totals;
  }, {});
}

function buildBillPreview(
  lines: DraftBillLine[],
  lineDiscounts: DraftLineDiscountMap,
  billDiscount?: DraftDiscountInput,
  roundOffEnabled = false
) {
  const processedLines = lines.map((line) => {
    const subtotal = line.quantity * line.unitPrice;
    const discountAmount = getDiscountAmount(subtotal, lineDiscounts[line.id]);
    return {
      id: line.id,
      type: line.type,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      subtotal,
      discountAmount,
      total: subtotal - discountAmount,
      linkedSessionId: line.linkedSessionId,
      inventoryItemId: line.inventoryItemId
    } satisfies BillLine;
  });
  const subtotal = sumBy(processedLines, (line) => line.subtotal);
  const lineDiscountAmount = sumBy(processedLines, (line) => line.discountAmount);
  const billDiscountAmount = getDiscountAmount(subtotal - lineDiscountAmount, billDiscount);
  const netTotal = subtotal - lineDiscountAmount - billDiscountAmount;
  const roundedTotal = roundOffEnabled ? Math.round(netTotal) : netTotal;
  return {
    processedLines,
    subtotal,
    lineDiscountAmount,
    billDiscountAmount,
    roundOffAmount: roundedTotal - netTotal,
    total: roundedTotal
  };
}

function toLocalDateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getReportRange(filter: ReportFilterState, nowValue: string) {
  const today = new Date(nowValue);
  const todayKey = toLocalDateKey(today);
  const thisMonthStart = toLocalDateKey(startOfMonth(today));
  const thisMonthEnd = toLocalDateKey(endOfMonth(today));
  switch (filter.preset) {
    case "today":
      return { from: todayKey, to: todayKey, label: "Today" };
    case "yesterday": {
      const yesterday = toLocalDateKey(addDays(today, -1));
      return { from: yesterday, to: yesterday, label: "Yesterday" };
    }
    case "last_7_days":
      return { from: toLocalDateKey(addDays(today, -6)), to: todayKey, label: "Last 7 Days" };
    case "this_month":
      return { from: thisMonthStart, to: thisMonthEnd, label: "This Month" };
    case "last_month": {
      const lastMonthAnchor = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return {
        from: toLocalDateKey(startOfMonth(lastMonthAnchor)),
        to: toLocalDateKey(endOfMonth(lastMonthAnchor)),
        label: "Last Month"
      };
    }
    case "this_year":
      return { from: `${today.getFullYear()}-01-01`, to: `${today.getFullYear()}-12-31`, label: "This Year" };
    case "custom":
    default:
      return {
        from: filter.fromDate ?? todayKey,
        to: filter.toDate ?? filter.fromDate ?? todayKey,
        label:
          filter.fromDate && filter.toDate
            ? `${filter.fromDate} to ${filter.toDate}`
            : "Custom Range"
      };
  }
}

function getPreviousRange(from: string, to: string) {
  const fromDate = new Date(`${from}T12:00:00`);
  const toDate = new Date(`${to}T12:00:00`);
  const inclusiveDays = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1);
  const previousTo = addDays(fromDate, -1);
  const previousFrom = addDays(previousTo, -(inclusiveDays - 1));
  return {
    from: toLocalDateKey(previousFrom),
    to: toLocalDateKey(previousTo),
    label: inclusiveDays === 1 ? "previous day" : `previous ${inclusiveDays} days`
  };
}

function getMonthKeysInRange(from: string, to: string) {
  const months: string[] = [];
  const cursor = new Date(`${from}T12:00:00`);
  cursor.setDate(1);
  const end = new Date(`${to}T12:00:00`);
  end.setDate(1);

  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${`${cursor.getMonth() + 1}`.padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function formatMonthLabel(monthKey: string) {
  return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(
    new Date(`${monthKey}-01T12:00:00`)
  );
}

function formatBillNumber(appData: AppData, issuedAt: string): string {
  const date = new Date(issuedAt);
  const dayKey = `${date.getFullYear()}${`${date.getMonth() + 1}`.padStart(2, "0")}${`${date.getDate()}`.padStart(2, "0")}`;
  const sequence = appData.bills.filter((bill) => bill.billNumber.startsWith(`BILL-${dayKey}`)).length + 1;
  return `BILL-${dayKey}-${`${sequence}`.padStart(3, "0")}`;
}

function addAuditLog(
  appData: AppData,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  message: string
) {
  appData.auditLogs.unshift({
    id: createId("audit"),
    action,
    entityType,
    entityId,
    message,
    createdAt: new Date().toISOString(),
    userId
  });
}

function upsertCustomer(appData: AppData, customerName?: string, customerPhone?: string) {
  const name = customerName?.trim();
  const phone = customerPhone?.trim();
  if (!name && !phone) {
    return;
  }
  const existing = appData.customers.find(
    (entry) => (phone && entry.phone === phone) || (name && entry.name === name)
  );
  if (existing) {
    existing.name = name || existing.name;
    existing.phone = phone || existing.phone;
    existing.lastVisitAt = new Date().toISOString();
    return;
  }
  appData.customers.unshift({
    id: createId("customer"),
    name,
    phone,
    lastVisitAt: new Date().toISOString()
  });
}

export default function App() {
  const backendConfigured = isBackendConfigured();
  const [appData, setAppData] = useState<AppData>(() => (backendConfigured ? cloneValue(seedAppData) : loadAppData()));
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [now, setNow] = useState<string>(new Date().toISOString());
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin123");
  const [loginError, setLoginError] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [remoteVersion, setRemoteVersion] = useState(0);
  const [remoteSaving, setRemoteSaving] = useState(false);
  const [startSessionDraft, setStartSessionDraft] = useState<StartSessionDraft>({
    stationId: "",
    customerName: "",
    customerPhone: "",
    playMode: "group",
    arcadeItemId: "",
    arcadeQuantity: 1
  });
  const [showStartSessionModal, setShowStartSessionModal] = useState(false);
  const [manageSessionId, setManageSessionId] = useState<string | null>(null);
  const [checkoutState, setCheckoutState] = useState<CheckoutState | null>(null);
  const [customerTabSearch, setCustomerTabSearch] = useState("");
  const [selectedCustomerTabId, setSelectedCustomerTabId] = useState<string | null>(null);
  const [customerTabDraft, setCustomerTabDraft] = useState<CustomerTabDraft>({
    customerName: "",
    customerPhone: ""
  });
  const [dashboardCustomerTabDraft, setDashboardCustomerTabDraft] = useState<CustomerTabDraft>({
    customerName: "",
    customerPhone: ""
  });
  const [replacementItemForm, setReplacementItemForm] = useState({ itemId: "", quantity: 1 });
  const [sessionItemForm, setSessionItemForm] = useState<Record<string, { itemId: string; quantity: number }>>({});
  const [selectedReceiptBillId, setSelectedReceiptBillId] = useState<string | null>(null);
  const receiptPreviewBlockRef = useRef<HTMLDivElement | null>(null);
  const [receiptPreviewBlockHeight, setReceiptPreviewBlockHeight] = useState<number | null>(null);
  const skipRemotePersistRef = useRef(false);
  const remoteSaveTimerRef = useRef<number | null>(null);
  const todayDateKey = toLocalDateKey(new Date());
  const [reportFilter, setReportFilter] = useState<ReportFilterState>({
    preset: "today",
    fromDate: todayDateKey,
    toDate: todayDateKey
  });
  const [itemForm, setItemForm] = useState<InventoryItem>({
    id: "",
    name: "",
    category: "",
    price: 0,
    stockQty: 0,
    lowStockThreshold: 5,
    unit: "piece",
    isReusable: false,
    barcode: "",
    active: true
  });
  const [useCustomItemCategory, setUseCustomItemCategory] = useState(false);
  const [customItemCategory, setCustomItemCategory] = useState("");
  const [inventoryAction, setInventoryAction] = useState({
    itemId: "",
    quantity: 1,
    reason: ""
  });
  const [stationForm, setStationForm] = useState<Station>({
    id: "",
    name: "",
    mode: "timed",
    active: true,
    ltpEnabled: false
  });
  const [pricingDraft, setPricingDraft] = useState({
    stationId: "",
    label: "",
    startTime: "10:00",
    endTime: "21:00",
    hourlyRate: 0
  });
  const [businessDraft, setBusinessDraft] = useState<BusinessProfile>(appData.businessProfile);
  const [userForm, setUserForm] = useState({
    name: "",
    username: "",
    password: "",
    role: "receptionist" as Role
  });
  const [editUserDraft, setEditUserDraft] = useState<UserEditDraft | null>(null);
  const [passwordDraft, setPasswordDraft] = useState<UserPasswordDraft | null>(null);
  const [expenseForm, setExpenseForm] = useState({
    title: "",
    category: "Utilities",
    amount: 0,
    spentAt: todayDateKey,
    notes: ""
  });
  const [expenseTemplateForm, setExpenseTemplateForm] = useState<ExpenseTemplate>({
    id: "",
    title: "",
    category: "Rent",
    amount: 0,
    frequency: "monthly",
    startMonth: todayDateKey.slice(0, 7),
    active: true,
    notes: "",
    createdByUserId: ""
  });

  async function refreshRemoteState(options?: { keepUser?: boolean }) {
    const snapshot = await loadRemoteAppDataSnapshot();
    skipRemotePersistRef.current = true;
    setAppData(snapshot.appData);
    setRemoteVersion(snapshot.version);
    if (!options?.keepUser) {
      const profile = await fetchCurrentProfile();
      setActiveUserId(profile?.id ?? null);
    }
  }

  async function saveRemoteSnapshot(nextAppData: AppData, expectedVersion = remoteVersion) {
    if (!activeUserId) {
      return;
    }
    setRemoteSaving(true);
    try {
      const nextVersion = await saveRemoteAppData(nextAppData, activeUserId, expectedVersion);
      setRemoteVersion(nextVersion);
      setRemoteError("");
    } catch (error) {
      await refreshRemoteState({ keepUser: true });
      const message =
        error instanceof Error
          ? error.message
          : "Remote data changed in another browser. Please retry after the latest data loads.";
      setRemoteError(message);
      window.alert(message);
      throw error;
    } finally {
      setRemoteSaving(false);
    }
  }

  useEffect(() => {
    if (!backendConfigured) {
      saveAppData(appData);
      return;
    }
    if (!activeUserId || remoteLoading) {
      return;
    }
    if (skipRemotePersistRef.current) {
      skipRemotePersistRef.current = false;
      return;
    }
    if (remoteSaveTimerRef.current) {
      window.clearTimeout(remoteSaveTimerRef.current);
    }
    remoteSaveTimerRef.current = window.setTimeout(() => {
      void saveRemoteSnapshot(appData).catch((error: unknown) => {
        setRemoteError(error instanceof Error ? error.message : "Unable to sync app data.");
      });
    }, 250);
    return () => {
      if (remoteSaveTimerRef.current) {
        window.clearTimeout(remoteSaveTimerRef.current);
      }
    };
  }, [activeUserId, appData, backendConfigured, remoteLoading]);

  useEffect(() => {
    setBusinessDraft(appData.businessProfile);
  }, [appData.businessProfile]);

  useEffect(() => {
    const timerId = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (!backendConfigured) {
      return;
    }
    void signOutRemote().catch(() => undefined);
  }, [backendConfigured]);

  useEffect(() => {
    if (!backendConfigured || !activeUserId) {
      return;
    }
    return subscribeToRemoteAppData((snapshot) => {
      skipRemotePersistRef.current = true;
      setAppData(snapshot.appData);
      setRemoteVersion(snapshot.version);
      setRemoteError("");
    });
  }, [activeUserId, backendConfigured]);

  useEffect(() => {
    const handleOnlineChange = () => setOnline(navigator.onLine);
    window.addEventListener("online", handleOnlineChange);
    window.addEventListener("offline", handleOnlineChange);
    return () => {
      window.removeEventListener("online", handleOnlineChange);
      window.removeEventListener("offline", handleOnlineChange);
    };
  }, []);

  const activeUser = appData.users.find((user) => user.id === activeUserId && user.active) ?? null;
  const visibleTabs = activeUser ? tabsByRole[activeUser.role] : [];
  const canAccessTab = (tabId: TabId) => visibleTabs.some((tab) => tab.id === tabId);
  const canEditInventory = activeUser?.role === "admin";
  const canEditReports = activeUser?.role === "admin";
  const canEditSettings = activeUser?.role === "admin";
  const canManageUsers = activeUser?.role === "admin";
  const canVoidRefundBills = activeUser?.role === "admin";
  const canReplaceIssuedBills = activeUser?.role === "admin";
  const isManagerReadOnly = activeUser?.role === "manager";
  const pageTitle =
    activeTab === "sale"
      ? "Consumables Tab"
      : visibleTabs.find((tab) => tab.id === activeTab)?.label ?? "Game Parlour";
  const stations = appData.stations.filter((station) => station.active);
  const activeSessions = appData.sessions.filter((session) => session.status !== "closed");
  const openCustomerTabs = appData.customerTabs.filter((tab) => tab.status === "open");
  const selectedCustomerTab =
    (selectedCustomerTabId
      ? appData.customerTabs.find((tab) => tab.id === selectedCustomerTabId && tab.status === "open")
      : undefined) ??
    openCustomerTabs[0] ??
    null;
  const resolvedReportRange = getReportRange(reportFilter, now);
  const reportFromDate = resolvedReportRange.from <= resolvedReportRange.to ? resolvedReportRange.from : resolvedReportRange.to;
  const reportToDate = resolvedReportRange.from <= resolvedReportRange.to ? resolvedReportRange.to : resolvedReportRange.from;
  const filteredBills = appData.bills.filter((bill) => {
    const billDate = toLocalDateKey(bill.issuedAt);
    return billDate >= reportFromDate && billDate <= reportToDate;
  });
  const filteredExpenses = appData.expenses.filter((expense) => {
    const expenseDate = toLocalDateKey(expense.spentAt);
    return expenseDate >= reportFromDate && expenseDate <= reportToDate;
  });
  const expenseCategoryOptions = Array.from(
    new Set([
      ...DEFAULT_EXPENSE_CATEGORIES,
      ...appData.expenses.map((expense) => expense.category),
      ...appData.expenseTemplates.map((template) => template.category),
      expenseForm.category,
      expenseTemplateForm.category
    ].filter(Boolean))
  );
  const currentDateLabel = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(now));
  const reportRows: ReportRow[] = filteredBills.map((bill) => ({
    billNumber: bill.billNumber,
    date: formatDateTime(bill.issuedAt),
    station:
      (bill.stationId && appData.stations.find((station) => station.id === bill.stationId)?.name) ||
      (bill.customerName ? "Customer tab" : "Counter sale"),
    customer: bill.customerName || "Walk-in",
    paymentMode: bill.paymentMode,
    total: bill.total,
    status: bill.status
  }));
  const inventoryCategoryOptions = Array.from(
    new Set([
      ...DEFAULT_INVENTORY_CATEGORIES,
      ...appData.inventoryCategories,
      ...appData.inventoryItems.map((item) => item.category),
      itemForm.category
    ].filter(Boolean))
  );
  const arcadeInventoryItems = appData.inventoryItems.filter(
    (item) => item.active && item.category === "Arcade"
  );
  const defaultArcadeInventoryItem = arcadeInventoryItems[0] ?? null;

  useEffect(() => {
    if (selectedCustomerTabId && !openCustomerTabs.some((tab) => tab.id === selectedCustomerTabId)) {
      setSelectedCustomerTabId(openCustomerTabs[0]?.id ?? null);
    }
    if (!selectedCustomerTabId && openCustomerTabs[0]) {
      setSelectedCustomerTabId(openCustomerTabs[0].id);
    }
  }, [openCustomerTabs, selectedCustomerTabId]);

  useEffect(() => {
    if (!activeUser) {
      return;
    }
    if (!canAccessTab(activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [activeTab, activeUser, visibleTabs]);

  function mutateAppData(mutator: (draft: AppData) => void) {
    setAppData((previous) => {
      const next = cloneValue(previous);
      mutator(next);
      return next;
    });
  }

  function getSessionById(sessionId: string) {
    return appData.sessions.find((session) => session.id === sessionId);
  }

  function getActiveSessionForStation(stationId: string) {
    return appData.sessions.find(
      (session) => session.stationId === stationId && session.status !== "closed"
    );
  }

  function getSessionChargeSummary(session: Session, effectiveEndAt = now) {
    return calculateSessionCharge(session, appData.sessionPauseLogs, effectiveEndAt);
  }

  function getSessionItemsSubtotal(session: Session) {
    return sumBy(session.items, (item) => item.quantity * item.unitPrice);
  }

  function getSessionLiveTotal(session: Session, effectiveEndAt = now) {
    return getSessionItemsSubtotal(session) + getSessionChargeSummary(session, effectiveEndAt).subtotal;
  }

  function createStartSessionDraft(station?: Station | null): StartSessionDraft {
    return {
      stationId: station?.id ?? "",
      customerName: "",
      customerPhone: "",
      playMode: station?.ltpEnabled ? "solo" : "group",
      arcadeItemId: station?.mode === "unit_sale" ? defaultArcadeInventoryItem?.id ?? "" : "",
      arcadeQuantity: 1
    };
  }

  function getFrozenEndAtForSession(sessionId: string) {
    return checkoutState?.mode === "session" && checkoutState.sessionId === sessionId
      ? checkoutState.closedAt ?? now
      : now;
  }

  function getSessionReservedQuantity(itemId: string, ignoreSessionId?: string) {
    return sumBy(
      appData.sessions.filter((session) => session.status !== "closed" && session.id !== ignoreSessionId),
      (session) => sumBy(session.items.filter((item) => item.inventoryItemId === itemId), (item) => item.quantity)
    );
  }

  function getCustomerTabReservedQuantity(itemId: string, ignoreCustomerTabId?: string) {
    return sumBy(
      appData.customerTabs.filter((tab) => tab.status === "open" && tab.id !== ignoreCustomerTabId),
      (tab) => sumBy(tab.items.filter((item) => item.inventoryItemId === itemId), (item) => item.quantity)
    );
  }

  function getReservedQuantity(
    item: InventoryItem,
    options?: { ignoreSessionId?: string; ignoreCustomerTabId?: string }
  ) {
    const sessionReserved = getSessionReservedQuantity(item.id, options?.ignoreSessionId);
    if (!item.isReusable) {
      return sessionReserved;
    }
    return sessionReserved + getCustomerTabReservedQuantity(item.id, options?.ignoreCustomerTabId);
  }

  function getOccupiedQuantity(
    item: InventoryItem,
    options?: { ignoreSessionId?: string; ignoreCustomerTabId?: string }
  ) {
    if (!item.isReusable) {
      return 0;
    }
    return getReservedQuantity(item, options);
  }

  function getAvailableStock(
    item: InventoryItem,
    ignoreSessionId?: string,
    ignoreCustomerTabId?: string
  ) {
    return Math.max(
      0,
      item.stockQty - getReservedQuantity(item, { ignoreSessionId, ignoreCustomerTabId })
    );
  }

  function getCustomerTabById(customerTabId: string) {
    return appData.customerTabs.find((tab) => tab.id === customerTabId);
  }

  function getBillById(billId: string) {
    return appData.bills.find((bill) => bill.id === billId);
  }

  function getCustomerTabTotal(tab: CustomerTab) {
    return sumBy(tab.items, (item) => item.quantity * item.unitPrice);
  }

  function resetItemForm() {
    setItemForm({
      id: "",
      name: "",
      category: "",
      price: 0,
      stockQty: 0,
      lowStockThreshold: 5,
      unit: "piece",
      isReusable: false,
      barcode: "",
      active: true
    });
    setUseCustomItemCategory(false);
    setCustomItemCategory("");
  }

  function beginEditInventoryItem(item: InventoryItem) {
    setItemForm(item);
    const isKnownCategory = inventoryCategoryOptions.includes(item.category);
    setUseCustomItemCategory(!isKnownCategory);
    setCustomItemCategory(isKnownCategory ? "" : item.category);
  }

  function getInventoryState(item: InventoryItem): InventoryState {
    if (item.isReusable) {
      return getOccupiedQuantity(item) > 0 ? "occupied" : "available";
    }
    if (item.stockQty <= 0) {
      return "out";
    }
    if (item.stockQty <= item.lowStockThreshold) {
      return "low";
    }
    return "healthy";
  }

  function getInventoryStateLabel(state: InventoryState) {
    if (state === "occupied") {
      return "Occupied";
    }
    if (state === "available") {
      return "Available";
    }
    if (state === "out") {
      return "Out";
    }
    if (state === "low") {
      return "Low";
    }
    return "Healthy";
  }

  function getInventoryStatusDetail(item: InventoryItem) {
    if (item.isReusable) {
      const occupied = getOccupiedQuantity(item);
      const available = getAvailableStock(item);
      return `${occupied} in use · ${available} available`;
    }
    return `${item.stockQty} left · threshold ${item.lowStockThreshold}`;
  }

  function getInventoryPickerDetail(
    item: InventoryItem,
    ignoreSessionId?: string,
    ignoreCustomerTabId?: string
  ) {
    const available = getAvailableStock(item, ignoreSessionId, ignoreCustomerTabId);
    if (item.isReusable) {
      const occupied = getOccupiedQuantity(item, { ignoreSessionId, ignoreCustomerTabId });
      return `${available} available · ${occupied} in use`;
    }
    return `Available ${available}`;
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (backendConfigured) {
      setRemoteLoading(true);
      void signInWithUsername(loginUsername, loginPassword)
        .then(async (profile) => {
          const snapshot = await loadRemoteAppDataSnapshot();
          skipRemotePersistRef.current = true;
          setAppData(snapshot.appData);
          setRemoteVersion(snapshot.version);
          setActiveUserId(profile.id);
          setLoginError("");
          setRemoteError("");
          setActiveTab("dashboard");
        })
        .catch((error: unknown) => {
          setLoginError(error instanceof Error ? error.message : "Invalid username or password.");
        })
        .finally(() => {
          setRemoteLoading(false);
        });
      return;
    }
    const matchedUser = appData.users.find(
      (user) =>
        user.active &&
        user.username.toLowerCase() === loginUsername.trim().toLowerCase() &&
        user.password === loginPassword
    );
    if (!matchedUser) {
      setLoginError("Invalid username or password.");
      return;
    }
    setLoginError("");
    setActiveUserId(matchedUser.id);
    setActiveTab("dashboard");
  }

  function handleLogout() {
    if (backendConfigured) {
      void signOutRemote().finally(() => {
        setActiveUserId(null);
      });
      return;
    }
    setActiveUserId(null);
  }

  function startSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !startSessionDraft.stationId) {
      return;
    }
    const station = appData.stations.find((entry) => entry.id === startSessionDraft.stationId);
    if (!station || getActiveSessionForStation(station.id)) {
      return;
    }
    const pricingSnapshot = appData.pricingRules.filter((rule) => rule.stationId === station.id);
    const sessionPlayMode = station.ltpEnabled ? startSessionDraft.playMode : "group";
    const initialItems: SessionItem[] = [];
    if (station.mode === "unit_sale") {
      const arcadeItem = appData.inventoryItems.find(
        (entry) => entry.id === startSessionDraft.arcadeItemId && entry.active
      );
      if (!arcadeItem) {
        window.alert("Select an arcade coin pack before starting this session.");
        return;
      }
      const upfrontQuantity = clampNumber(startSessionDraft.arcadeQuantity, 1);
      if (getAvailableStock(arcadeItem) < upfrontQuantity) {
        window.alert("Not enough arcade coin packs available.");
        return;
      }
      initialItems.push({
        id: createId("session-item"),
        inventoryItemId: arcadeItem.id,
        name: arcadeItem.name,
        quantity: upfrontQuantity,
        unitPrice: arcadeItem.price,
        addedAt: new Date().toISOString()
      });
    }
    mutateAppData((draft) => {
      draft.sessions.unshift({
        id: createId("session"),
        stationId: station.id,
        stationNameSnapshot: station.name,
        mode: station.mode,
        startedAt: new Date().toISOString(),
        status: "active",
        customerName: startSessionDraft.customerName.trim() || undefined,
        customerPhone: startSessionDraft.customerPhone.trim() || undefined,
        playMode: sessionPlayMode,
        ltpEligible: station.ltpEnabled,
        pricingSnapshot,
        items: initialItems,
        pauseLogIds: []
      });
      addAuditLog(
        draft,
        activeUser.id,
        "session_started",
        "station",
        station.id,
        `Started ${sessionPlayMode} session on ${station.name}${station.mode === "unit_sale" ? ` with ${initialItems[0]?.quantity ?? 0} ${initialItems[0]?.name ?? "coin pack(s)"}.` : station.ltpEnabled ? " with LTP enabled." : "."}`
      );
    });
    setStartSessionDraft(createStartSessionDraft());
    setShowStartSessionModal(false);
  }

  function toggleSessionPause(sessionId: string, shouldPause: boolean) {
    if (!activeUser) {
      return;
    }
    mutateAppData((draft) => {
      const session = draft.sessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return;
      }
      if (shouldPause && session.status === "active") {
        const pauseLogId = createId("pause");
        draft.sessionPauseLogs.push({
          id: pauseLogId,
          sessionId,
          pausedAt: new Date().toISOString()
        });
        session.pauseLogIds.push(pauseLogId);
        session.status = "paused";
      }
      if (!shouldPause && session.status === "paused") {
        const openPause = draft.sessionPauseLogs.find((entry) => entry.sessionId === sessionId && !entry.resumedAt);
        if (openPause) {
          openPause.resumedAt = new Date().toISOString();
        }
        session.status = "active";
      }
      addAuditLog(
        draft,
        activeUser.id,
        shouldPause ? "session_paused" : "session_resumed",
        "session",
        sessionId,
        `${shouldPause ? "Paused" : "Resumed"} ${session.stationNameSnapshot}.`
      );
    });
  }

  function addItemToSession(sessionId: string) {
    const form = sessionItemForm[sessionId];
    if (!activeUser || !form?.itemId) {
      return;
    }
    const item = appData.inventoryItems.find((entry) => entry.id === form.itemId && entry.active);
    if (!item || getAvailableStock(item, sessionId) < form.quantity) {
      window.alert(item?.isReusable ? `${item.name} is currently occupied.` : "Not enough stock available for that item.");
      return;
    }
    mutateAppData((draft) => {
      const session = draft.sessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return;
      }
      session.items.push({
        id: createId("session-item"),
        inventoryItemId: item.id,
        name: item.name,
        quantity: clampNumber(form.quantity, 1),
        unitPrice: item.price,
        addedAt: new Date().toISOString()
      });
      addAuditLog(draft, activeUser.id, "session_item_added", "session", sessionId, `Added ${item.name} to ${session.stationNameSnapshot}.`);
    });
    setSessionItemForm((previous) => ({
      ...previous,
      [sessionId]: { itemId: form.itemId, quantity: 1 }
    }));
  }

  function removeItemFromSession(sessionId: string, sessionItemId: string) {
    if (!activeUser) {
      return;
    }
    mutateAppData((draft) => {
      const session = draft.sessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return;
      }
      const item = session.items.find((entry) => entry.id === sessionItemId);
      session.items = session.items.filter((entry) => entry.id !== sessionItemId);
      if (item) {
        addAuditLog(
          draft,
          activeUser.id,
          "session_item_removed",
          "session",
          sessionId,
          `Removed ${item.name} from ${session.stationNameSnapshot}.`
        );
      }
    });
  }

  function openSessionCheckout(sessionId: string) {
    const session = getSessionById(sessionId);
    if (!session) {
      return;
    }
    const closedAt = new Date().toISOString();
    setCheckoutState({
      mode: "session",
      sessionId,
      closedAt,
      customerName: session.customerName || "",
      customerPhone: session.customerPhone || "",
      paymentMode: "cash",
      roundOffEnabled: true,
      lineDiscounts: {},
      ltpOutcome:
        session.ltpEligible && session.playMode === "solo"
          ? session.ltpOutcome ?? "lost"
          : undefined
    });
  }

  function createOrSelectCustomerTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openOrCreateCustomerTab(customerTabDraft, {
      updateSaleDraft: true,
      clearDraft: true,
      switchToSale: false
    });
  }

  function openOrCreateCustomerTab(
    draftValue: CustomerTabDraft,
    options?: { updateSaleDraft?: boolean; clearDraft?: boolean; switchToSale?: boolean }
  ) {
    if (!activeUser) {
      return;
    }
    const customerName = draftValue.customerName.trim();
    const customerPhone = draftValue.customerPhone.trim();
    if (!customerName) {
      window.alert("Customer name is required to open a tab.");
      return;
    }
    const existing = appData.customerTabs.find(
      (tab) =>
        tab.status === "open" &&
        (tab.customerName.trim().toLowerCase() === customerName.toLowerCase() ||
          (customerPhone && tab.customerPhone?.trim() === customerPhone))
    );
    if (existing) {
      setSelectedCustomerTabId(existing.id);
      if (options?.updateSaleDraft) {
        setCustomerTabDraft({ customerName: existing.customerName, customerPhone: existing.customerPhone ?? "" });
      }
      if (options?.clearDraft) {
        setDashboardCustomerTabDraft({ customerName: "", customerPhone: "" });
      }
      if (options?.switchToSale) {
        setActiveTab("sale");
      }
      return;
    }

    const tabId = createId("customer-tab");
    mutateAppData((draft) => {
      draft.customerTabs.unshift({
        id: tabId,
        customerName,
        customerPhone: customerPhone || undefined,
        status: "open",
        createdAt: new Date().toISOString(),
        items: []
      });
      addAuditLog(draft, activeUser.id, "customer_tab_opened", "customer_tab", tabId, `Opened customer tab for ${customerName}.`);
    });
    setSelectedCustomerTabId(tabId);
    if (options?.updateSaleDraft) {
      setCustomerTabDraft({ customerName, customerPhone });
    }
    if (options?.clearDraft) {
      setDashboardCustomerTabDraft({ customerName: "", customerPhone: "" });
    }
    if (options?.switchToSale) {
      setActiveTab("sale");
    }
  }

  function createDashboardCustomerTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openOrCreateCustomerTab(dashboardCustomerTabDraft, {
      updateSaleDraft: true,
      clearDraft: true,
      switchToSale: false
    });
  }

  function addItemToCustomerTab(item: InventoryItem) {
    if (!activeUser || !selectedCustomerTab) {
      window.alert("Open or select a customer tab first.");
      return;
    }
    if (getAvailableStock(item) < 1) {
      window.alert(item.isReusable ? `${item.name} is currently occupied.` : "That item is out of stock.");
      return;
    }
    mutateAppData((draft) => {
      const tab = draft.customerTabs.find((entry) => entry.id === selectedCustomerTab.id && entry.status === "open");
      if (!tab) {
        return;
      }
      const existing = tab.items.find((entry) => entry.inventoryItemId === item.id);
      if (existing) {
        existing.quantity += 1;
      } else {
        tab.items.push({
          id: createId("customer-tab-item"),
          inventoryItemId: item.id,
          name: item.name,
          quantity: 1,
          unitPrice: item.price,
          addedAt: new Date().toISOString()
        });
      }
      addAuditLog(draft, activeUser.id, "customer_tab_item_added", "customer_tab", tab.id, `Added ${item.name} to ${tab.customerName}'s tab.`);
    });
  }

  function updateCustomerTabItemQuantity(lineId: string, quantity: number) {
    if (!activeUser || !selectedCustomerTab) {
      return;
    }
    const nextQuantity = clampNumber(quantity, 1);
    const currentLine = selectedCustomerTab.items.find((entry) => entry.id === lineId);
    const currentItem = currentLine
      ? appData.inventoryItems.find((entry) => entry.id === currentLine.inventoryItemId && entry.active)
      : undefined;
    if (
      currentLine &&
      currentItem &&
      nextQuantity > getAvailableStock(currentItem, undefined, selectedCustomerTab.id)
    ) {
      window.alert(`Only ${getAvailableStock(currentItem, undefined, selectedCustomerTab.id)} available for ${currentItem.name}.`);
      return;
    }
    mutateAppData((draft) => {
      const tab = draft.customerTabs.find((entry) => entry.id === selectedCustomerTab.id && entry.status === "open");
      const line = tab?.items.find((entry) => entry.id === lineId);
      if (!tab || !line) {
        return;
      }
      line.quantity = nextQuantity;
    });
  }

  function removeItemFromCustomerTab(lineId: string) {
    if (!activeUser || !selectedCustomerTab) {
      return;
    }
    mutateAppData((draft) => {
      const tab = draft.customerTabs.find((entry) => entry.id === selectedCustomerTab.id && entry.status === "open");
      if (!tab) {
        return;
      }
      const line = tab.items.find((entry) => entry.id === lineId);
      tab.items = tab.items.filter((entry) => entry.id !== lineId);
      if (line) {
        addAuditLog(draft, activeUser.id, "customer_tab_item_removed", "customer_tab", tab.id, `Removed ${line.name} from ${tab.customerName}'s tab.`);
      }
    });
  }

  function beginCustomerTabCheckout() {
    if (!selectedCustomerTab || selectedCustomerTab.items.length === 0) {
      window.alert("Open a customer tab and add items first.");
      return;
    }
    setCheckoutState({
      mode: "customer_tab",
      customerTabId: selectedCustomerTab.id,
      customerName: selectedCustomerTab.customerName,
      customerPhone: selectedCustomerTab.customerPhone ?? "",
      paymentMode: "cash",
      roundOffEnabled: true,
      lineDiscounts: {}
    });
  }

  function openCustomerTabWorkspace(customerTabId: string) {
    const tab = getCustomerTabById(customerTabId);
    if (!tab || tab.status !== "open") {
      return;
    }
    setSelectedCustomerTabId(tab.id);
    setCustomerTabDraft({
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? ""
    });
    setActiveTab("sale");
  }

  function beginCustomerTabCheckoutById(customerTabId: string) {
    const tab = getCustomerTabById(customerTabId);
    if (!tab || tab.status !== "open" || tab.items.length === 0) {
      window.alert("Open a customer tab and add items first.");
      return;
    }
    setSelectedCustomerTabId(tab.id);
    setCustomerTabDraft({
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? ""
    });
    setCheckoutState({
      mode: "customer_tab",
      customerTabId: tab.id,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? "",
      paymentMode: "cash",
      roundOffEnabled: true,
      lineDiscounts: {}
    });
  }

  function rejectSession(sessionId: string) {
    if (!activeUser) {
      return;
    }
    const session = getSessionById(sessionId);
    if (!session || session.status === "closed") {
      return;
    }
    const reason = window.prompt("Enter reason for rejecting this session:");
    if (!reason?.trim()) {
      return;
    }
    const rejectedAt = new Date().toISOString();
    mutateAppData((draft) => {
      const targetSession = draft.sessions.find((entry) => entry.id === sessionId);
      if (!targetSession || targetSession.status === "closed") {
        return;
      }
      if (targetSession.status === "paused") {
        const openPause = draft.sessionPauseLogs.find((entry) => entry.sessionId === sessionId && !entry.resumedAt);
        if (openPause) {
          openPause.resumedAt = rejectedAt;
        }
      }
      targetSession.status = "closed";
      targetSession.endedAt = rejectedAt;
      targetSession.closeDisposition = "rejected";
      targetSession.closeReason = reason.trim();
      addAuditLog(draft, activeUser.id, "session_rejected", "session", sessionId, `Rejected ${targetSession.stationNameSnapshot}. Reason: ${reason.trim()}`);
    });
    setCheckoutState((previous) =>
      previous?.mode === "session" && previous.sessionId === sessionId ? null : previous
    );
    setManageSessionId((previous) => (previous === sessionId ? null : previous));
  }

  function rejectCustomerTab(customerTabId: string) {
    if (!activeUser) {
      return;
    }
    const tab = getCustomerTabById(customerTabId);
    if (!tab || tab.status !== "open") {
      return;
    }
    const reason = window.prompt("Enter reason for rejecting this consumables tab:");
    if (!reason?.trim()) {
      return;
    }
    const rejectedAt = new Date().toISOString();
    mutateAppData((draft) => {
      const targetTab = draft.customerTabs.find((entry) => entry.id === customerTabId);
      if (!targetTab || targetTab.status !== "open") {
        return;
      }
      targetTab.status = "closed";
      targetTab.closedAt = rejectedAt;
      targetTab.closeDisposition = "rejected";
      targetTab.closeReason = reason.trim();
      addAuditLog(draft, activeUser.id, "customer_tab_rejected", "customer_tab", customerTabId, `Rejected ${targetTab.customerName}'s tab. Reason: ${reason.trim()}`);
    });
    setCheckoutState((previous) =>
      previous?.mode === "customer_tab" && previous.customerTabId === customerTabId ? null : previous
    );
    setSelectedCustomerTabId((previous) => (previous === customerTabId ? null : previous));
  }

  function openBillReplacement(billId: string) {
    if (!activeUser || !canReplaceIssuedBills) {
      return;
    }
    const bill = getBillById(billId);
    if (!bill || bill.status !== "issued") {
      return;
    }
    const replacementLines = cloneBillLinesForReplacement(bill);
    const replacementLineDiscounts: DraftLineDiscountMap = {};
    for (const originalLine of bill.lines) {
      const originalDiscount = bill.lineDiscounts.find((discount) => discount.targetId === originalLine.id);
      if (originalDiscount) {
        replacementLineDiscounts[originalLine.id] = {
          type: originalDiscount.type,
          value: originalDiscount.value,
          reason: originalDiscount.reason
        };
      }
    }
    setReplacementItemForm({ itemId: "", quantity: 1 });
    setCheckoutState({
      mode: "bill_replacement",
      replacementBillId: billId,
      customerName: bill.customerName ?? "",
      customerPhone: bill.customerPhone ?? "",
      paymentMode: bill.paymentMode,
      roundOffEnabled: bill.roundOffEnabled,
      lineDiscounts: replacementLineDiscounts,
      billDiscount: bill.billDiscount
        ? {
            type: bill.billDiscount.type,
            value: bill.billDiscount.value,
            reason: bill.billDiscount.reason
          }
        : undefined,
      replacementLines,
      replaceReason: bill.replaceReason ?? ""
    });
  }

  function addItemToReplacementBill() {
    if (!checkoutState || checkoutState.mode !== "bill_replacement" || !replacementItemForm.itemId) {
      return;
    }
    const item = appData.inventoryItems.find((entry) => entry.id === replacementItemForm.itemId && entry.active);
    if (!item) {
      return;
    }
    const originalBill = checkoutState.replacementBillId ? getBillById(checkoutState.replacementBillId) : undefined;
    const originalQuantities = getInventoryQuantityMap(originalBill?.lines ?? []);
    const currentQuantities = getInventoryQuantityMap(checkoutState.replacementLines ?? []);
    const nextQuantity = (currentQuantities[item.id] ?? 0) + clampNumber(replacementItemForm.quantity, 1);
    const requiredDelta = nextQuantity - (originalQuantities[item.id] ?? 0);
    if (!item.isReusable && requiredDelta > item.stockQty) {
      window.alert(`Only ${item.stockQty} additional ${item.name} available for replacement.`);
      return;
    }
    if (item.isReusable && requiredDelta > getAvailableStock(item)) {
      window.alert(`${item.name} is currently occupied.`);
      return;
    }
    setCheckoutState((previous) =>
      previous && previous.mode === "bill_replacement"
        ? {
            ...previous,
            replacementLines: [
              ...(previous.replacementLines ?? []),
              {
                id: createId("replacement-line"),
                type: "inventory_item",
                description: item.name,
                quantity: clampNumber(replacementItemForm.quantity, 1),
                unitPrice: item.price,
                inventoryItemId: item.id
              }
            ]
          }
        : previous
    );
    setReplacementItemForm({ itemId: replacementItemForm.itemId, quantity: 1 });
  }

  function updateReplacementLineQuantity(lineId: string, quantity: number) {
    if (!checkoutState || checkoutState.mode !== "bill_replacement") {
      return;
    }
    const nextQuantity = clampNumber(quantity, 1);
    const replacementLines = checkoutState.replacementLines ?? [];
    const targetLine = replacementLines.find((line) => line.id === lineId);
    if (!targetLine || targetLine.type !== "inventory_item" || !targetLine.inventoryItemId) {
      return;
    }
    const item = appData.inventoryItems.find((entry) => entry.id === targetLine.inventoryItemId && entry.active);
    if (!item) {
      return;
    }
    const originalBill = checkoutState.replacementBillId ? getBillById(checkoutState.replacementBillId) : undefined;
    const originalQuantities = getInventoryQuantityMap(originalBill?.lines ?? []);
    const otherReplacementLines = replacementLines.filter((line) => line.id !== lineId);
    const currentQuantities = getInventoryQuantityMap(otherReplacementLines);
    const totalAfterChange = (currentQuantities[item.id] ?? 0) + nextQuantity;
    const requiredDelta = totalAfterChange - (originalQuantities[item.id] ?? 0);
    if (!item.isReusable && requiredDelta > item.stockQty) {
      window.alert(`Only ${item.stockQty} additional ${item.name} available for replacement.`);
      return;
    }
    if (item.isReusable && requiredDelta > getAvailableStock(item)) {
      window.alert(`${item.name} is currently occupied.`);
      return;
    }
    setCheckoutState((previous) =>
      previous && previous.mode === "bill_replacement"
        ? {
            ...previous,
            replacementLines: (previous.replacementLines ?? []).map((line) =>
              line.id === lineId ? { ...line, quantity: nextQuantity } : line
            )
          }
        : previous
    );
  }

  function removeReplacementLine(lineId: string) {
    setCheckoutState((previous) =>
      previous && previous.mode === "bill_replacement"
        ? {
            ...previous,
            replacementLines: (previous.replacementLines ?? []).filter((line) => line.id !== lineId),
            lineDiscounts: Object.fromEntries(
              Object.entries(previous.lineDiscounts).filter(([key]) => key !== lineId)
            )
          }
        : previous
    );
  }

  async function finalizeCheckout() {
    if (!activeUser || !checkoutState) {
      return;
    }
    let baseAppData = appData;
    let baseVersion = remoteVersion;
    if (backendConfigured) {
      const snapshot = await loadRemoteAppDataSnapshot();
      baseAppData = snapshot.appData;
      baseVersion = snapshot.version;
      setRemoteVersion(baseVersion);
      if (checkoutState.mode === "session" && checkoutState.sessionId) {
        const remoteSession = baseAppData.sessions.find((entry) => entry.id === checkoutState.sessionId);
        if (!remoteSession || remoteSession.status === "closed") {
          skipRemotePersistRef.current = true;
          setAppData(baseAppData);
          setCheckoutState(null);
          setManageSessionId(null);
          window.alert("This session was already closed from another browser. Latest data has been loaded.");
          return;
        }
      }
      if (checkoutState.mode === "customer_tab" && checkoutState.customerTabId) {
        const remoteTab = baseAppData.customerTabs.find((entry) => entry.id === checkoutState.customerTabId);
        if (!remoteTab || remoteTab.status === "closed") {
          skipRemotePersistRef.current = true;
          setAppData(baseAppData);
          setCheckoutState(null);
          window.alert("This consumables tab was already closed from another browser. Latest data has been loaded.");
          return;
        }
      }
      if (checkoutState.mode === "bill_replacement" && checkoutState.replacementBillId) {
        const remoteBill = baseAppData.bills.find((entry) => entry.id === checkoutState.replacementBillId);
        if (!remoteBill || remoteBill.status !== "issued") {
          skipRemotePersistRef.current = true;
          setAppData(baseAppData);
          setCheckoutState(null);
          window.alert("This bill was already changed from another browser. Latest data has been loaded.");
          return;
        }
      }
      skipRemotePersistRef.current = true;
      setAppData(baseAppData);
    }
    function getAvailableStockFromData(
      data: AppData,
      item: InventoryItem,
      ignoreSessionId?: string,
      ignoreCustomerTabId?: string
    ) {
      const sessionReserved = sumBy(
        data.sessions.filter((entry) => entry.status !== "closed" && entry.id !== ignoreSessionId),
        (entry) => sumBy(entry.items.filter((line) => line.inventoryItemId === item.id), (line) => line.quantity)
      );
      const tabReserved = item.isReusable
        ? sumBy(
            data.customerTabs.filter((entry) => entry.status === "open" && entry.id !== ignoreCustomerTabId),
            (entry) => sumBy(entry.items.filter((line) => line.inventoryItemId === item.id), (line) => line.quantity)
          )
        : 0;
      return Math.max(0, item.stockQty - sessionReserved - tabReserved);
    }
    const issuedAt = new Date().toISOString();
    const effectiveClosedAt =
      checkoutState.mode === "session" ? checkoutState.closedAt ?? issuedAt : issuedAt;
    const session =
      checkoutState.mode === "session" && checkoutState.sessionId
        ? baseAppData.sessions.find((entry) => entry.id === checkoutState.sessionId)
        : undefined;
    const customerTab =
      checkoutState.mode === "customer_tab" && checkoutState.customerTabId
        ? baseAppData.customerTabs.find((entry) => entry.id === checkoutState.customerTabId)
        : undefined;
    const replacementBill =
      checkoutState.mode === "bill_replacement" && checkoutState.replacementBillId
        ? baseAppData.bills.find((entry) => entry.id === checkoutState.replacementBillId)
        : undefined;
    const sourceLines =
      checkoutState.mode === "session" && session
        ? getSessionCheckoutLines(session, calculateSessionCharge(session, baseAppData.sessionPauseLogs, effectiveClosedAt))
        : checkoutState.mode === "customer_tab"
          ? getCustomerTabCheckoutLines(customerTab?.items ?? [])
          : checkoutState.replacementLines ?? [];
    if (customerTab) {
      const unavailableLine = sourceLines.find((line) => {
        if (!line.inventoryItemId) {
          return false;
        }
        const inventoryItem = baseAppData.inventoryItems.find((item) => item.id === line.inventoryItemId);
        return !inventoryItem || getAvailableStockFromData(baseAppData, inventoryItem, undefined, customerTab.id) < line.quantity;
      });
      if (unavailableLine) {
        window.alert(`Not enough stock available for ${unavailableLine.description}. Update the tab before billing.`);
        return;
      }
    }
    if (replacementBill) {
      if (!checkoutState.replaceReason?.trim()) {
        window.alert("Replacement reason is required.");
        return;
      }
      const originalQuantities = getInventoryQuantityMap(replacementBill.lines);
      const replacementQuantities = getInventoryQuantityMap(sourceLines);
      for (const [itemId, nextQuantity] of Object.entries(replacementQuantities)) {
        const item = baseAppData.inventoryItems.find((entry) => entry.id === itemId);
        if (!item) {
          window.alert("One of the replacement bill items no longer exists.");
          return;
        }
        const requiredDelta = nextQuantity - (originalQuantities[itemId] ?? 0);
        if (item.isReusable) {
          if (requiredDelta > getAvailableStockFromData(baseAppData, item)) {
            window.alert(`${item.name} is currently occupied.`);
            return;
          }
          continue;
        }
        if (requiredDelta > item.stockQty) {
          window.alert(`Only ${item.stockQty} additional ${item.name} available for replacement.`);
          return;
        }
      }
    }
    const effectiveLineDiscounts: DraftLineDiscountMap = { ...checkoutState.lineDiscounts };
    const ltpWinningSession =
      Boolean(session?.ltpEligible) &&
      session?.playMode === "solo" &&
      checkoutState.ltpOutcome === "won";
    if (ltpWinningSession) {
      const sessionLine = sourceLines.find((line) => line.type === "session_charge");
      if (sessionLine) {
        effectiveLineDiscounts[sessionLine.id] = {
          type: "amount",
          value: sessionLine.unitPrice,
          reason: "LTP win - game charge waived"
        };
      }
    }
    const preview = buildBillPreview(
      sourceLines,
      effectiveLineDiscounts,
      checkoutState.billDiscount,
      checkoutState.roundOffEnabled
    );
    const discountEntries = Object.values(checkoutState.lineDiscounts).filter(
      (discount) => discount && discount.value > 0
    );
    if (discountEntries.some((discount) => !discount?.reason.trim())) {
      window.alert("Every applied line discount needs a reason.");
      return;
    }
    if (checkoutState.billDiscount && checkoutState.billDiscount.value > 0 && !checkoutState.billDiscount.reason.trim()) {
      window.alert("Bill discount reason is required.");
      return;
    }

    const billId = createId("bill");
    const lineDiscounts: AppliedDiscount[] = [];
    for (const [lineId, discount] of Object.entries(effectiveLineDiscounts)) {
      if (!discount || discount.value <= 0) {
        continue;
      }
      const matchingLine = preview.processedLines.find((line) => line.id === lineId);
      if (!matchingLine) {
        continue;
      }
      lineDiscounts.push({
        id: createId("discount"),
        scope: "line",
        targetId: lineId,
        type: discount.type,
        value: discount.value,
        amount: matchingLine.discountAmount,
        reason: discount.reason,
        appliedByUserId: activeUser.id,
        appliedAt: issuedAt
      });
    }
    const billDiscount =
      checkoutState.billDiscount && checkoutState.billDiscount.value > 0
        ? {
            id: createId("discount"),
            scope: "bill" as const,
            targetId: billId,
            type: checkoutState.billDiscount.type,
            value: checkoutState.billDiscount.value,
            amount: preview.billDiscountAmount,
            reason: checkoutState.billDiscount.reason,
            appliedByUserId: activeUser.id,
            appliedAt: issuedAt
          }
        : undefined;
    const billNumber = formatBillNumber(baseAppData, issuedAt);
    const issuedBill = {
      id: billId,
      billNumber,
      status: "issued" as const,
      createdAt: issuedAt,
      issuedAt,
      issuedByUserId: activeUser.id,
      customerName: checkoutState.customerName.trim() || undefined,
      customerPhone: checkoutState.customerPhone.trim() || undefined,
      paymentMode: checkoutState.paymentMode,
      stationId: session?.stationId ?? replacementBill?.stationId,
      sessionId: session?.id ?? replacementBill?.sessionId,
      subtotal: preview.subtotal,
      totalDiscountAmount: preview.lineDiscountAmount + preview.billDiscountAmount,
      billDiscountAmount: preview.billDiscountAmount,
      roundOffEnabled: checkoutState.roundOffEnabled,
      roundOffAmount: preview.roundOffAmount,
      total: preview.total,
      lineDiscounts,
      billDiscount,
      lines: preview.processedLines,
      receiptType: "digital" as const,
      replacementOfBillId: replacementBill?.id,
      replaceReason: replacementBill ? checkoutState.replaceReason?.trim() : undefined
    };

    const nextAppData = cloneValue(baseAppData);
    const draft = nextAppData;
      draft.bills.unshift(issuedBill);
      draft.payments.unshift({
        id: createId("payment"),
        billId,
        mode: checkoutState.paymentMode,
        amount: preview.total,
        createdAt: issuedAt,
        receivedByUserId: activeUser.id
      });
      if (replacementBill) {
        const originalBill = draft.bills.find((entry) => entry.id === replacementBill.id);
        if (originalBill && originalBill.status === "issued") {
          originalBill.status = "replaced";
          originalBill.replacedByBillId = billId;
          originalBill.replacedAt = issuedAt;
          originalBill.replacedByUserId = activeUser.id;
          originalBill.replaceReason = checkoutState.replaceReason?.trim();
        }
        const originalQuantities = getInventoryQuantityMap(replacementBill.lines);
        const replacementQuantities = getInventoryQuantityMap(preview.processedLines);
        const itemIds = Array.from(new Set([...Object.keys(originalQuantities), ...Object.keys(replacementQuantities)]));
        for (const itemId of itemIds) {
          const item = draft.inventoryItems.find((entry) => entry.id === itemId);
          if (!item || item.isReusable) {
            continue;
          }
          const delta = (replacementQuantities[itemId] ?? 0) - (originalQuantities[itemId] ?? 0);
          if (delta === 0) {
            continue;
          }
          item.stockQty -= delta;
          draft.stockMovements.unshift({
            id: createId("stock"),
            itemId: item.id,
            type: delta > 0 ? "sale" : "void_refund_reversal",
            quantity: -delta,
            reason: `Replacement adjustment from ${replacementBill.billNumber} to ${billNumber}`,
            createdAt: issuedAt,
            userId: activeUser.id,
            relatedBillId: billId
          });
        }
      } else {
        for (const line of preview.processedLines) {
          if (!line.inventoryItemId) {
            continue;
          }
          const item = draft.inventoryItems.find((entry) => entry.id === line.inventoryItemId);
          if (!item || item.isReusable) {
            continue;
          }
          item.stockQty -= line.quantity;
          draft.stockMovements.unshift({
            id: createId("stock"),
            itemId: item.id,
            type: "sale",
            quantity: -line.quantity,
            reason: `Sold in ${billNumber}`,
            createdAt: issuedAt,
            userId: activeUser.id,
            relatedBillId: billId
          });
        }
      }
      if (session) {
        const targetSession = draft.sessions.find((entry) => entry.id === session.id);
        if (targetSession) {
          targetSession.status = "closed";
          targetSession.endedAt = effectiveClosedAt;
          targetSession.closedBillId = billId;
          targetSession.closeDisposition = "billed";
          targetSession.closeReason = undefined;
          targetSession.ltpOutcome = checkoutState.ltpOutcome;
          targetSession.ltpDiscountApplied = ltpWinningSession;
        }
      }
      if (customerTab) {
        const targetTab = draft.customerTabs.find((entry) => entry.id === customerTab.id);
        if (targetTab) {
          targetTab.status = "closed";
          targetTab.closedAt = issuedAt;
          targetTab.closedBillId = billId;
          targetTab.closeDisposition = "billed";
          targetTab.closeReason = undefined;
        }
      }
      upsertCustomer(draft, checkoutState.customerName, checkoutState.customerPhone);
      addAuditLog(
        draft,
        activeUser.id,
        replacementBill ? "bill_replaced" : "bill_issued",
        "bill",
        billId,
        replacementBill
          ? `Issued replacement ${billNumber} for ${replacementBill.billNumber}.`
          : `Issued ${billNumber}.`
      );
      if (ltpWinningSession && session) {
        addAuditLog(draft, activeUser.id, "ltp_discount_applied", "session", session.id, `Applied LTP win discount to ${session.stationNameSnapshot}.`);
      }
    if (backendConfigured) {
      skipRemotePersistRef.current = true;
      setAppData(nextAppData);
      await saveRemoteSnapshot(nextAppData, baseVersion);
    } else {
      setAppData(nextAppData);
    }

    setSelectedReceiptBillId(billId);
    setCheckoutState(null);
    setManageSessionId(null);
    setSelectedCustomerTabId(null);
    setCustomerTabDraft({ customerName: "", customerPhone: "" });
    setReplacementItemForm({ itemId: "", quantity: 1 });
    openReceiptWindow(nextAppData.businessProfile, issuedBill, nextAppData.bills);
    downloadReceiptPdf(nextAppData.businessProfile, issuedBill, nextAppData.bills);
  }

  function upsertInventoryItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditInventory) {
      return;
    }
    const resolvedCategory = (useCustomItemCategory ? customItemCategory : itemForm.category).trim();
    if (!resolvedCategory) {
      window.alert("Category is required.");
      return;
    }
    mutateAppData((draft) => {
      if (itemForm.id) {
        const existing = draft.inventoryItems.find((item) => item.id === itemForm.id);
        if (!existing) {
          return;
        }
        Object.assign(existing, {
          ...itemForm,
          name: itemForm.name.trim(),
          category: resolvedCategory,
          unit: "piece",
          barcode: itemForm.barcode?.trim() || undefined
        });
        addAuditLog(draft, activeUser.id, "inventory_updated", "inventory_item", existing.id, `Updated ${existing.name}.`);
      } else {
        const newId = createId("inventory");
        draft.inventoryItems.unshift({
          ...itemForm,
          id: newId,
          name: itemForm.name.trim(),
          category: resolvedCategory,
          unit: "piece",
          barcode: itemForm.barcode?.trim() || undefined
        });
        addAuditLog(draft, activeUser.id, "inventory_created", "inventory_item", newId, `Created ${itemForm.name.trim()}.`);
      }
      if (!draft.inventoryCategories.includes(resolvedCategory)) {
        draft.inventoryCategories.push(resolvedCategory);
      }
    });
    resetItemForm();
  }

  function recordStockMovement(type: StockMovementType) {
    if (!activeUser || !canEditInventory || !inventoryAction.itemId || inventoryAction.quantity <= 0 || !inventoryAction.reason.trim()) {
      return;
    }
    mutateAppData((draft) => {
      const item = draft.inventoryItems.find((entry) => entry.id === inventoryAction.itemId);
      if (!item) {
        return;
      }
      const signedQuantity = type === "restock" ? inventoryAction.quantity : -inventoryAction.quantity;
      if (item.stockQty + signedQuantity < 0) {
        return;
      }
      item.stockQty += signedQuantity;
      draft.stockMovements.unshift({
        id: createId("stock"),
        itemId: item.id,
        type,
        quantity: signedQuantity,
        reason: inventoryAction.reason.trim(),
        createdAt: new Date().toISOString(),
        userId: activeUser.id
      });
      addAuditLog(draft, activeUser.id, "stock_movement", "inventory_item", item.id, `${type} for ${item.name}.`);
    });
    setInventoryAction({ itemId: "", quantity: 1, reason: "" });
  }

  function upsertStation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings) {
      return;
    }
    mutateAppData((draft) => {
      if (stationForm.id) {
        const existing = draft.stations.find((station) => station.id === stationForm.id);
        if (!existing) {
          return;
        }
        Object.assign(existing, stationForm, { name: stationForm.name.trim() });
      } else {
        draft.stations.unshift({
          ...stationForm,
          id: createId("station"),
          name: stationForm.name.trim()
        });
      }
    });
    setStationForm({ id: "", name: "", mode: "timed", active: true, ltpEnabled: false });
  }

  function deleteStation(stationId: string) {
    if (!activeUser || !canEditSettings) {
      return;
    }
    if (appData.sessions.some((session) => session.stationId === stationId && session.status !== "closed")) {
      window.alert("Close the active session first.");
      return;
    }
    mutateAppData((draft) => {
      draft.stations = draft.stations.filter((station) => station.id !== stationId);
      draft.pricingRules = draft.pricingRules.filter((rule) => rule.stationId !== stationId);
    });
  }

  function addPricingRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings || !pricingDraft.stationId) {
      return;
    }
    mutateAppData((draft) => {
      draft.pricingRules.push({
        id: createId("pricing"),
        stationId: pricingDraft.stationId,
        label: pricingDraft.label.trim(),
        startMinute: toMinuteOfDay(pricingDraft.startTime),
        endMinute: toMinuteOfDay(pricingDraft.endTime),
        hourlyRate: clampNumber(pricingDraft.hourlyRate)
      });
    });
    setPricingDraft({
      stationId: pricingDraft.stationId,
      label: "",
      startTime: "10:00",
      endTime: "21:00",
      hourlyRate: 0
    });
  }

  function deletePricingRule(ruleId: string) {
    if (!canEditSettings) {
      return;
    }
    mutateAppData((draft) => {
      draft.pricingRules = draft.pricingRules.filter((rule) => rule.id !== ruleId);
    });
  }

  function saveBusinessProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings) {
      return;
    }
    mutateAppData((draft) => {
      draft.businessProfile = {
        ...businessDraft,
        name: businessDraft.name.trim(),
        logoText: businessDraft.logoText.trim(),
        address: businessDraft.address.trim(),
        primaryPhone: businessDraft.primaryPhone.trim(),
        secondaryPhone: businessDraft.secondaryPhone?.trim() || undefined,
        receiptFooter: businessDraft.receiptFooter.trim()
      };
    });
  }

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canManageUsers) {
      return;
    }
    const nextName = userForm.name.trim();
    const nextUsername = userForm.username.trim();
    if (!nextName || !nextUsername || !userForm.password) {
      return;
    }
    if (appData.users.some((user) => user.username.toLowerCase() === nextUsername.toLowerCase())) {
      window.alert("Username already exists.");
      return;
    }
    if (backendConfigured) {
      void adminCreateUserRemote({
        name: nextName,
        username: nextUsername,
        password: userForm.password,
        role: userForm.role
      })
        .then(async () => {
          setUserForm({ name: "", username: "", password: "", role: "receptionist" });
          await refreshRemoteState({ keepUser: true });
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : "Unable to create user.");
        });
      return;
    }
    mutateAppData((draft) => {
      const userId = createId("user");
      draft.users.push({
        id: userId,
        name: nextName,
        username: nextUsername,
        password: userForm.password,
        role: userForm.role,
        active: true
      });
      addAuditLog(draft, activeUser.id, "user_created", "user", userId, `Created ${userForm.role} user ${nextUsername}.`);
    });
    setUserForm({ name: "", username: "", password: "", role: "receptionist" });
  }

  function getActiveAdminCount(users = appData.users) {
    return users.filter((user) => user.active && user.role === "admin").length;
  }

  function beginEditUser(user: User) {
    if (!canManageUsers) {
      return;
    }
    setEditUserDraft({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    });
  }

  function saveUserEdits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canManageUsers || !editUserDraft) {
      return;
    }
    const nextName = editUserDraft.name.trim();
    const nextUsername = editUserDraft.username.trim();
    if (!nextName || !nextUsername) {
      return;
    }
    const existingUser = appData.users.find((user) => user.id === editUserDraft.id);
    if (!existingUser) {
      return;
    }
    if (
      appData.users.some(
        (user) => user.id !== editUserDraft.id && user.username.toLowerCase() === nextUsername.toLowerCase()
      )
    ) {
      window.alert("Username already exists.");
      return;
    }
    if (
      existingUser.active &&
      existingUser.role === "admin" &&
      editUserDraft.role !== "admin" &&
      getActiveAdminCount() === 1
    ) {
      window.alert("At least one active admin account must remain in the system.");
      return;
    }
    if (backendConfigured) {
      void adminUpdateUserRemote({
        id: editUserDraft.id,
        name: nextName,
        username: nextUsername,
        role: editUserDraft.role
      })
        .then(async () => {
          setEditUserDraft(null);
          await refreshRemoteState({ keepUser: true });
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : "Unable to update user.");
        });
      return;
    }
    mutateAppData((draft) => {
      const user = draft.users.find((entry) => entry.id === editUserDraft.id);
      if (!user) {
        return;
      }
      user.name = nextName;
      user.username = nextUsername;
      user.role = editUserDraft.role;
      addAuditLog(draft, activeUser.id, "user_updated", "user", user.id, `Updated user ${user.username}.`);
    });
    setEditUserDraft(null);
  }

  function openChangePassword(user: User) {
    if (!canManageUsers) {
      return;
    }
    setPasswordDraft({
      userId: user.id,
      password: "",
      confirmPassword: ""
    });
  }

  function saveUserPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canManageUsers || !passwordDraft) {
      return;
    }
    const nextPassword = passwordDraft.password;
    if (!nextPassword.trim()) {
      return;
    }
    if (passwordDraft.password !== passwordDraft.confirmPassword) {
      window.alert("Password confirmation does not match.");
      return;
    }
    const targetUser = appData.users.find((user) => user.id === passwordDraft.userId);
    if (!targetUser) {
      return;
    }
    if (backendConfigured) {
      void adminChangePasswordRemote(passwordDraft.userId, nextPassword)
        .then(() => {
          setPasswordDraft(null);
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : "Unable to update password.");
        });
      return;
    }
    mutateAppData((draft) => {
      const user = draft.users.find((entry) => entry.id === passwordDraft.userId);
      if (!user) {
        return;
      }
      user.password = nextPassword;
      addAuditLog(draft, activeUser.id, "user_password_changed", "user", user.id, `Changed password for ${user.username}.`);
    });
    setPasswordDraft(null);
  }

  function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditReports || expenseForm.amount <= 0 || !expenseForm.title.trim()) {
      return;
    }
    mutateAppData((draft) => {
      const expenseId = createId("expense");
      draft.expenses.unshift({
        id: expenseId,
        title: expenseForm.title.trim(),
        category: expenseForm.category.trim(),
        amount: expenseForm.amount,
        spentAt: new Date(`${expenseForm.spentAt}T12:00:00`).toISOString(),
        notes: expenseForm.notes.trim() || undefined,
        createdByUserId: activeUser.id
      });
      addAuditLog(
        draft,
        activeUser.id,
        "expense_created",
        "expense",
        expenseId,
        `Logged expense ${expenseForm.title.trim()} for ${currency(expenseForm.amount)}.`
      );
    });
    setExpenseForm({
      title: "",
      category: "Utilities",
      amount: 0,
      spentAt: toLocalDateKey(new Date(now)),
      notes: ""
    });
  }

  function saveExpenseTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditReports || expenseTemplateForm.amount <= 0 || !expenseTemplateForm.title.trim()) {
      return;
    }
    mutateAppData((draft) => {
      if (expenseTemplateForm.id) {
        const existing = draft.expenseTemplates.find((entry) => entry.id === expenseTemplateForm.id);
        if (!existing) {
          return;
        }
        Object.assign(existing, {
          ...expenseTemplateForm,
          title: expenseTemplateForm.title.trim(),
          category: expenseTemplateForm.category.trim(),
          notes: expenseTemplateForm.notes?.trim() || undefined
        });
        addAuditLog(draft, activeUser.id, "expense_template_updated", "expense_template", existing.id, `Updated monthly template ${existing.title}.`);
      } else {
        const templateId = createId("expense-template");
        draft.expenseTemplates.unshift({
          ...expenseTemplateForm,
          id: templateId,
          title: expenseTemplateForm.title.trim(),
          category: expenseTemplateForm.category.trim(),
          notes: expenseTemplateForm.notes?.trim() || undefined,
          createdByUserId: activeUser.id
        });
        addAuditLog(draft, activeUser.id, "expense_template_created", "expense_template", templateId, `Created monthly template ${expenseTemplateForm.title.trim()}.`);
      }
    });
    setExpenseTemplateForm({
      id: "",
      title: "",
      category: "Rent",
      amount: 0,
      frequency: "monthly",
      startMonth: reportToDate.slice(0, 7),
      active: true,
      notes: "",
      createdByUserId: ""
    });
  }

  function deleteExpense(expenseId: string) {
    if (!activeUser || !canEditReports) {
      return;
    }
    mutateAppData((draft) => {
      const expense = draft.expenses.find((entry) => entry.id === expenseId);
      draft.expenses = draft.expenses.filter((entry) => entry.id !== expenseId);
      if (expense) {
        addAuditLog(
          draft,
          activeUser.id,
          "expense_deleted",
          "expense",
          expenseId,
          `Removed expense ${expense.title}.`
        );
      }
    });
  }

  function beginEditExpenseTemplate(template: ExpenseTemplate) {
    if (!canEditReports) {
      return;
    }
    setExpenseTemplateForm({
      ...template,
      notes: template.notes ?? ""
    });
  }

  function toggleExpenseTemplateActive(templateId: string) {
    if (!activeUser || !canEditReports) {
      return;
    }
    mutateAppData((draft) => {
      const template = draft.expenseTemplates.find((entry) => entry.id === templateId);
      if (!template) {
        return;
      }
      template.active = !template.active;
      addAuditLog(draft, activeUser.id, template.active ? "expense_template_activated" : "expense_template_deactivated", "expense_template", templateId, `${template.active ? "Activated" : "Deactivated"} monthly template ${template.title}.`);
    });
  }

  function deleteExpenseTemplate(templateId: string) {
    if (!activeUser || !canEditReports) {
      return;
    }
    mutateAppData((draft) => {
      const template = draft.expenseTemplates.find((entry) => entry.id === templateId);
      draft.expenseTemplates = draft.expenseTemplates.filter((entry) => entry.id !== templateId);
      if (template) {
        addAuditLog(draft, activeUser.id, "expense_template_deleted", "expense_template", templateId, `Deleted monthly template ${template.title}.`);
      }
    });
    if (expenseTemplateForm.id === templateId) {
      setExpenseTemplateForm({
        id: "",
        title: "",
        category: "Rent",
        amount: 0,
        frequency: "monthly",
        startMonth: reportToDate.slice(0, 7),
        active: true,
        notes: "",
        createdByUserId: ""
      });
    }
  }

  function toggleUserActive(userId: string) {
    if (!activeUser || !canManageUsers) {
      return;
    }
    const targetUser = appData.users.find((user) => user.id === userId);
    if (!targetUser) {
      return;
    }
    if (targetUser.active && targetUser.role === "admin" && getActiveAdminCount() === 1) {
      window.alert("At least one active admin account must remain in the system.");
      return;
    }
    if (backendConfigured) {
      void adminToggleUserActiveRemote(userId)
        .then(async () => {
          await refreshRemoteState({ keepUser: true });
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : "Unable to update user access.");
        });
      return;
    }
    mutateAppData((draft) => {
      const user = draft.users.find((entry) => entry.id === userId);
      if (user) {
        user.active = !user.active;
        addAuditLog(
          draft,
          activeUser.id,
          user.active ? "user_enabled" : "user_disabled",
          "user",
          user.id,
          `${user.active ? "Enabled" : "Disabled"} user ${user.username}.`
        );
      }
    });
  }

  function voidOrRefundBill(billId: string) {
    if (!activeUser || !canVoidRefundBills) {
      return;
    }
    const reason = window.prompt("Enter reason for void/refund:");
    if (!reason?.trim()) {
      return;
    }
    const refund = window.confirm("OK = refund, Cancel = void");
    mutateAppData((draft) => {
      const bill = draft.bills.find((entry) => entry.id === billId);
      if (!bill || bill.status !== "issued") {
        return;
      }
      bill.status = refund ? "refunded" : "voided";
      bill.voidReason = reason.trim();
      bill.voidedAt = new Date().toISOString();
      bill.voidedByUserId = activeUser.id;
      for (const line of bill.lines) {
        if (!line.inventoryItemId) {
          continue;
        }
        const item = draft.inventoryItems.find((entry) => entry.id === line.inventoryItemId);
        if (!item || item.isReusable) {
          continue;
        }
        item.stockQty += line.quantity;
        draft.stockMovements.unshift({
          id: createId("stock"),
          itemId: item.id,
          type: "void_refund_reversal",
          quantity: line.quantity,
          reason,
          createdAt: new Date().toISOString(),
          userId: activeUser.id,
          relatedBillId: bill.id
        });
      }
    });
  }

  const selectedReceiptBill = appData.bills.find((bill) => bill.id === selectedReceiptBillId) ?? appData.bills[0] ?? null;
  const receiptPreviewModel = selectedReceiptBill
    ? buildReceiptPreviewModel(appData.businessProfile, selectedReceiptBill, appData.bills)
    : null;
  const managedSession = manageSessionId ? getSessionById(manageSessionId) ?? null : null;
  const managedSessionCharge = managedSession ? getSessionChargeSummary(managedSession, getFrozenEndAtForSession(managedSession.id)) : null;
  const selectedStartStation =
    startSessionDraft.stationId ? appData.stations.find((station) => station.id === startSessionDraft.stationId) ?? null : null;
  const selectedArcadeStartItem =
    startSessionDraft.arcadeItemId
      ? arcadeInventoryItems.find((item) => item.id === startSessionDraft.arcadeItemId) ?? null
      : defaultArcadeInventoryItem;

  useEffect(() => {
    if (activeTab !== "reports") {
      return;
    }

    const node = receiptPreviewBlockRef.current;
    if (!node) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      setReceiptPreviewBlockHeight(nextHeight > 0 ? nextHeight : null);
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateHeight)
        : null;
    resizeObserver?.observe(node);

    return () => {
      window.removeEventListener("resize", updateHeight);
      resizeObserver?.disconnect();
    };
  }, [activeTab, selectedReceiptBillId, receiptPreviewModel]);

  useEffect(() => {
    if (!selectedStartStation || selectedStartStation.mode !== "unit_sale") {
      return;
    }
    const hasSelectedArcadeItem = arcadeInventoryItems.some((item) => item.id === startSessionDraft.arcadeItemId);
    if (!hasSelectedArcadeItem && defaultArcadeInventoryItem) {
      setStartSessionDraft((previous) => ({
        ...previous,
        arcadeItemId: defaultArcadeInventoryItem.id
      }));
    }
  }, [
    arcadeInventoryItems,
    defaultArcadeInventoryItem,
    selectedStartStation,
    startSessionDraft.arcadeItemId
  ]);

  const checkoutLines =
    checkoutState?.mode === "session" && checkoutState.sessionId
      ? (() => {
          const session = getSessionById(checkoutState.sessionId);
          return session
            ? getSessionCheckoutLines(
                session,
                getSessionChargeSummary(session, checkoutState.closedAt ?? now)
              )
            : [];
        })()
      : checkoutState?.mode === "customer_tab" && checkoutState.customerTabId
        ? getCustomerTabCheckoutLines(getCustomerTabById(checkoutState.customerTabId)?.items ?? [])
        : checkoutState?.mode === "bill_replacement"
          ? checkoutState.replacementLines ?? []
          : [];
  const checkoutSession =
    checkoutState?.mode === "session" && checkoutState.sessionId
      ? getSessionById(checkoutState.sessionId) ?? null
      : null;
  const checkoutReplacementBill =
    checkoutState?.mode === "bill_replacement" && checkoutState.replacementBillId
      ? getBillById(checkoutState.replacementBillId) ?? null
      : null;
  const checkoutLineDiscounts: DraftLineDiscountMap = checkoutState ? { ...checkoutState.lineDiscounts } : {};
  if (
    checkoutState?.mode === "session" &&
    checkoutSession?.ltpEligible &&
    checkoutSession.playMode === "solo" &&
    checkoutState.ltpOutcome === "won"
  ) {
    const sessionLine = checkoutLines.find((line) => line.type === "session_charge");
    if (sessionLine) {
      checkoutLineDiscounts[sessionLine.id] = {
        type: "amount",
        value: sessionLine.unitPrice,
        reason: "LTP win - game charge waived"
      };
    }
  }
  const checkoutPreview = checkoutState
    ? buildBillPreview(
        checkoutLines,
        checkoutLineDiscounts,
        checkoutState.billDiscount,
        checkoutState.roundOffEnabled
      )
    : null;

  const issuedBills = filteredBills.filter((bill) => bill.status === "issued");
  const grossRevenue = sumBy(issuedBills, (bill) => bill.total);
  const sessionRevenue = sumBy(
    issuedBills.flatMap((bill) => bill.lines.filter((line) => line.type === "session_charge")),
    (line) => line.total
  );
  const itemRevenue = sumBy(
    issuedBills.flatMap((bill) => bill.lines.filter((line) => line.type === "inventory_item")),
    (line) => line.total
  );
  const totalDiscounts = sumBy(issuedBills, (bill) => bill.totalDiscountAmount);
  const cashExpenses = sumBy(filteredExpenses, (expense) => expense.amount);
  const reportMonthKeys = getMonthKeysInRange(reportFromDate, reportToDate);
  const normalizedExpenseEntries = appData.expenseTemplates
    .filter((template) => template.active)
    .flatMap((template) =>
      reportMonthKeys
        .filter((monthKey) => monthKey >= template.startMonth)
        .map((monthKey) => ({
          templateId: template.id,
          title: template.title,
          category: template.category,
          amount: template.amount,
          monthKey,
          notes: template.notes
        }))
    );
  const normalizedExpenses = sumBy(normalizedExpenseEntries, (entry) => entry.amount);
  const netCashEarnings = grossRevenue - cashExpenses;
  const normalizedNetProfit = grossRevenue - normalizedExpenses;
  const previousRange = getPreviousRange(reportFromDate, reportToDate);
  const previousRangeRevenue = sumBy(
    appData.bills.filter((bill) => {
      const billDate = toLocalDateKey(bill.issuedAt);
      return bill.status === "issued" && billDate >= previousRange.from && billDate <= previousRange.to;
    }),
    (bill) => bill.total
  );
  const revenueGrowthPct =
    previousRangeRevenue > 0 ? ((grossRevenue - previousRangeRevenue) / previousRangeRevenue) * 100 : null;
  const averageBillValue = issuedBills.length > 0 ? grossRevenue / issuedBills.length : 0;
  const topStation =
    Object.entries(
      issuedBills.reduce<Record<string, number>>((totals, bill) => {
        const stationName = bill.stationId
          ? appData.stations.find((station) => station.id === bill.stationId)?.name ?? "Unknown station"
          : "Customer tab";
        totals[stationName] = (totals[stationName] ?? 0) + bill.total;
        return totals;
      }, {})
    ).sort((left, right) => right[1] - left[1])[0] ?? null;
  const paymentModeTotals = {
    cash: sumBy(issuedBills.filter((bill) => bill.paymentMode === "cash"), (bill) => bill.total),
    upi: sumBy(issuedBills.filter((bill) => bill.paymentMode === "upi"), (bill) => bill.total)
  };
  const cashExpenseByCategory = Object.entries(
    filteredExpenses.reduce<Record<string, number>>((totals, expense) => {
      totals[expense.category] = (totals[expense.category] ?? 0) + expense.amount;
      return totals;
    }, {})
  ).sort((left, right) => right[1] - left[1]);
  const normalizedExpenseByCategory = Object.entries(
    normalizedExpenseEntries.reduce<Record<string, number>>((totals, expense) => {
      totals[expense.category] = (totals[expense.category] ?? 0) + expense.amount;
      return totals;
    }, {})
  ).sort((left, right) => right[1] - left[1]);
  const expenseByCategory = cashExpenseByCategory;
  const outOfStockItems = appData.inventoryItems.filter((item) => item.active && getInventoryState(item) === "out");
  const lowStockItems = appData.inventoryItems.filter((item) => item.active && getInventoryState(item) === "low");
  const occupiedItems = appData.inventoryItems.filter((item) => item.active && getInventoryState(item) === "occupied");

  if (backendConfigured && remoteLoading) {
    return (
      <LoginScreen
        loginUsername={loginUsername}
        loginPassword={loginPassword}
        loginError={remoteError || loginError || "Connecting to production backend..."}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
      />
    );
  }

  if (!activeUser) {
    return (
      <LoginScreen
        loginUsername={loginUsername}
        loginPassword={loginPassword}
        loginError={remoteError || loginError}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand app-brand">
          <div className="brand-mark image-mark">
            <img src={brandLogo} alt={`${appData.businessProfile.name} logo`} />
          </div>
        </div>
        <nav className="nav-list">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`nav-button ${activeTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className={`status-pill ${online ? "is-online" : "is-offline"}`}>
            {remoteSaving ? "Syncing" : online ? "Online" : "Offline fallback"}
          </div>
          <div className="helper-text">
            {backendConfigured
              ? "Live data is synced through the production backend."
              : "Bills, sessions, and settings are persisted on this device for fallback use."}
          </div>
          <div className="sidebar-user-card" tabIndex={0}>
            <div className="sidebar-user-summary">
              <div>
                <strong>{activeUser.name}</strong>
                <div className="muted">{activeUser.role.toUpperCase()}</div>
              </div>
            </div>
            <button className="secondary-button sidebar-user-action" type="button" onClick={handleLogout}>
              Log Out
            </button>
          </div>
        </div>
      </aside>

      <main className={`main-content ${activeTab === "dashboard" ? "is-dashboard-tab" : ""}`}>
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <div className="muted">{activeUser.name}</div>
          </div>
          <div className="topbar-actions">
            <TodayMetricCard
              value={currency(sumBy(appData.bills.filter((bill) => isToday(bill.issuedAt) && bill.status === "issued"), (bill) => bill.total))}
              timeLabel={formatTime(now)}
              dateLabel={currentDateLabel}
            />
            <MetricCard label="Open Sessions" value={`${activeSessions.length + openCustomerTabs.length}`} />
          </div>
        </header>

        {activeTab === "dashboard" && (
          <section className="section-grid dashboard-grid">
            <div className="panel dashboard-column">
              <div className="dashboard-tile">
                <div className="panel-header">
                  <div>
                    <h2>Live Sessions</h2>
                    <p>Monitor gaming sessions and open consumables tabs so nothing is left unbilled.</p>
                  </div>
                </div>
                <div className="dashboard-tile-body panel-scroll">
                  <div className="station-grid">
                {stations.map((station) => {
                  const session = getActiveSessionForStation(station.id);
                  const isBillingFrozen =
                    session &&
                    checkoutState?.mode === "session" &&
                    checkoutState.sessionId === session.id;
                  return (
                    <article key={station.id} className={`station-card ${session ? `is-${session.status}` : "is-available"}`}>
                      <div className="station-card-header">
                        <div>
                          <h3>{station.name}</h3>
                          <p>{session ? (isBillingFrozen ? "Billing" : session.status === "paused" ? "Paused" : "Running") : "Available"}</p>
                        </div>
                        <button
                          className={session ? "ghost-button" : "station-start-link"}
                          type="button"
                          onClick={() =>
                            session
                              ? setManageSessionId(session.id)
                              : (() => {
                                  setStartSessionDraft(createStartSessionDraft(station));
                                  setShowStartSessionModal(true);
                                })()
                          }
                        >
                          {session ? "Manage" : "Start"}
                        </button>
                      </div>
                      {session ? (
                        <>
                          <div className="station-metrics">
                            <div>
                              <span className="muted">Started</span>
                              <strong>{formatTime(session.startedAt)}</strong>
                            </div>
                            <div>
                              <span className="muted">Live bill</span>
                              <strong>{currency(getSessionLiveTotal(session, getFrozenEndAtForSession(session.id)))}</strong>
                            </div>
                            <div>
                              <span className="muted">Customer</span>
                              <strong>{session.customerName || "Walk-in"}</strong>
                            </div>
                          </div>
                          <div className="button-row">
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => setManageSessionId(session.id)}
                            >
                              Consumables
                            </button>
                            {session.mode === "timed" &&
                              (session.status === "active" ? (
                                <button type="button" onClick={() => toggleSessionPause(session.id, true)}>
                                  Pause
                                </button>
                              ) : (
                                <button type="button" onClick={() => toggleSessionPause(session.id, false)}>
                                  Resume
                                </button>
                              ))}
                            <button className="ghost-button danger" type="button" onClick={() => rejectSession(session.id)}>
                              Reject
                            </button>
                            <button className="primary-button" type="button" onClick={() => openSessionCheckout(session.id)}>
                              Close Bill
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="empty-card-copy">
                          Click <strong>Start</strong> to open the session form for this station.
                        </div>
                      )}
                    </article>
                  );
                })}
                {openCustomerTabs.map((tab) => (
                  <article key={tab.id} className="station-card is-active customer-tab-live-card">
                    <div className="station-card-header">
                      <div>
                        <h3>{tab.customerName}</h3>
                        <p>Consumables tab</p>
                      </div>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => openCustomerTabWorkspace(tab.id)}
                      >
                        Manage
                      </button>
                    </div>
                    <div className="station-metrics">
                      <div>
                        <span className="muted">Opened</span>
                        <strong>{formatTime(tab.createdAt)}</strong>
                      </div>
                      <div>
                        <span className="muted">Live bill</span>
                        <strong>{currency(getCustomerTabTotal(tab))}</strong>
                      </div>
                      <div>
                        <span className="muted">Items</span>
                        <strong>{`${tab.items.length}`}</strong>
                      </div>
                    </div>
                    <div className="button-row">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => openCustomerTabWorkspace(tab.id)}
                      >
                        Manage Items
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => beginCustomerTabCheckoutById(tab.id)}
                      >
                        Close Bill
                      </button>
                      <button className="ghost-button danger" type="button" onClick={() => rejectCustomerTab(tab.id)}>
                        Reject
                      </button>
                    </div>
                  </article>
                ))}
                {stations.length === 0 && openCustomerTabs.length === 0 && (
                  <div className="empty-state">No live stations or open consumables tabs right now.</div>
                )}
                  </div>
                </div>
              </div>

              <div className="dashboard-tile">
                <div className="panel-header">
                  <div>
                    <h2>Recent Activity</h2>
                    <p>Discounts, stock movements, and billing actions are all logged.</p>
                  </div>
                </div>
                <div className="dashboard-tile-body panel-scroll">
                  <div className="activity-list">
                    {appData.auditLogs.slice(0, 8).map((entry) => (
                      <div key={entry.id} className="activity-row">
                        <strong>{entry.message}</strong>
                        <span className="muted">{formatDateTime(entry.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel dashboard-column">
              <div className="dashboard-tile">
              <div className="panel-header">
                <div>
                  <h2>Start New Gaming Session</h2>
                  <p>Use the station card Start button for the quickest flow, or start manually here.</p>
                </div>
              </div>
              <div className="dashboard-tile-body panel-scroll">
              <form className="form-grid dashboard-starter-form" onSubmit={startSession}>
                <label>
                  <span>Station</span>
                  <select
                    value={startSessionDraft.stationId}
                    onChange={(event) =>
                      setStartSessionDraft((previous) => {
                        const nextStation = appData.stations.find((station) => station.id === event.target.value);
                        return {
                          ...previous,
                          stationId: event.target.value,
                          playMode: nextStation?.ltpEnabled ? previous.playMode : "group",
                          arcadeItemId: nextStation?.mode === "unit_sale" ? defaultArcadeInventoryItem?.id ?? "" : "",
                          arcadeQuantity: 1
                        };
                      })
                    }
                  >
                    <option value="">Select station</option>
                    {stations
                      .filter((station) => !getActiveSessionForStation(station.id))
                      .map((station) => (
                        <option key={station.id} value={station.id}>
                          {station.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>Customer Name</span>
                  <input
                    value={startSessionDraft.customerName}
                    onChange={(event) =>
                      setStartSessionDraft((previous) => ({ ...previous, customerName: event.target.value }))
                    }
                    placeholder="Optional"
                  />
                </label>
                <label>
                  <span>Customer Phone</span>
                  <input
                    value={startSessionDraft.customerPhone}
                    onChange={(event) =>
                      setStartSessionDraft((previous) => ({ ...previous, customerPhone: event.target.value }))
                    }
                    placeholder="Optional"
                  />
                </label>
                {selectedStartStation?.ltpEnabled && (
                  <label>
                    <span>Play Mode</span>
                    <select
                      value={startSessionDraft.playMode}
                      onChange={(event) =>
                        setStartSessionDraft((previous) => ({
                          ...previous,
                          playMode: event.target.value as PlayMode
                        }))
                      }
                    >
                      <option value="solo">Solo (LTP)</option>
                      <option value="group">Group</option>
                    </select>
                  </label>
                )}
                {selectedStartStation?.mode === "unit_sale" && (
                  <>
                    {arcadeInventoryItems.length === 0 && (
                      <div className="field-span-full error-text">
                        Add an active `Arcade` inventory item first so this station can start with coin packs.
                      </div>
                    )}
                    <label>
                      <span>Coin Pack</span>
                      <select
                        value={startSessionDraft.arcadeItemId}
                        onChange={(event) =>
                          setStartSessionDraft((previous) => ({
                            ...previous,
                            arcadeItemId: event.target.value
                          }))
                        }
                      >
                        <option value="">Select coin pack</option>
                        {arcadeInventoryItems.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {currency(item.price)} · {getInventoryPickerDetail(item)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Upfront Packs</span>
                      <NumericInput
                        min={1}
                        defaultValue={1}
                        value={startSessionDraft.arcadeQuantity}
                        onValueChange={(value) =>
                          setStartSessionDraft((previous) => ({
                            ...previous,
                            arcadeQuantity: value
                          }))
                        }
                      />
                    </label>
                    {selectedArcadeStartItem && (
                      <div className="field-span-full helper-text">
                        Default arcade entry: {selectedArcadeStartItem.name} at {currency(selectedArcadeStartItem.price)} each.
                        Increase packs here if the customer wants more coins upfront.
                      </div>
                    )}
                  </>
                )}
                <div className="starter-submit-slot">
                  <button className="primary-button" type="submit" disabled={selectedStartStation?.mode === "unit_sale" && arcadeInventoryItems.length === 0}>
                    Start Gaming Session
                  </button>
                </div>
              </form>
              <div className="section-block section-block-muted dashboard-subsection">
                <div className="section-block-header">
                  <h3>Start New Consumables Session</h3>
                  <p>Open a food, drink, or sheesha tab directly from the dashboard.</p>
                </div>
                <form className="form-grid dashboard-starter-form" onSubmit={createDashboardCustomerTab}>
                  <label>
                    <span>Customer Name</span>
                    <input
                      required
                      value={dashboardCustomerTabDraft.customerName}
                      onChange={(event) =>
                        setDashboardCustomerTabDraft((previous) => ({ ...previous, customerName: event.target.value }))
                      }
                      placeholder="Enter customer name"
                    />
                  </label>
                  <label>
                    <span>Customer Phone</span>
                    <input
                      value={dashboardCustomerTabDraft.customerPhone}
                      onChange={(event) =>
                        setDashboardCustomerTabDraft((previous) => ({ ...previous, customerPhone: event.target.value }))
                      }
                      placeholder="Optional"
                    />
                  </label>
                  <div className="starter-submit-slot">
                    <button className="primary-button" type="submit">
                      Start Consumable Session
                    </button>
                  </div>
                </form>
              </div>
              </div>
              </div>

              <div className="dashboard-tile">
              <div className="panel-header">
                <div>
                  <h2>Inventory Alerts</h2>
                  <p>Quick restock reminder for low, out-of-stock, and reusable occupied items.</p>
                </div>
              </div>
              <div className="dashboard-tile-body panel-scroll">
              <div className="metrics-row">
                <MetricCard label="Low Stock" value={`${lowStockItems.length}`} />
                <MetricCard label="Out of Stock" value={`${outOfStockItems.length}`} />
                <MetricCard label="Occupied" value={`${occupiedItems.length}`} />
              </div>
              <div className="inventory-alert-list">
                {appData.inventoryItems
                  .filter((item) => item.active)
                  .sort((left, right) => {
                    const priority: Record<InventoryState, number> = {
                      occupied: 0,
                      out: 1,
                      low: 2,
                      available: 3,
                      healthy: 4
                    };
                    const stateDelta = priority[getInventoryState(left)] - priority[getInventoryState(right)];
                    if (stateDelta !== 0) {
                      return stateDelta;
                    }
                    return getAvailableStock(left) - getAvailableStock(right);
                  })
                  .slice(0, 6)
                  .map((item) => {
                    const state = getInventoryState(item);
                    return (
                      <div key={item.id} className={`inventory-alert-row is-${state}`}>
                        <div>
                          <strong>{item.name}</strong>
                          <div className="muted">
                            {getInventoryStatusDetail(item)}
                          </div>
                        </div>
                        <span className={`inventory-badge is-${state}`}>
                          {getInventoryStateLabel(state)}
                        </span>
                      </div>
                    );
                  })}
              </div>
              </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "sale" && (
          <section className="section-grid sales-layout">
            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Consumables Catalog</h2>
                  <p>Search by name or barcode and add items to the selected customer tab.</p>
                </div>
              </div>
              <input
                className="search-input"
                value={customerTabSearch}
                onChange={(event) => setCustomerTabSearch(event.target.value)}
                placeholder="Search items..."
              />
              <div className="catalog-grid">
                {appData.inventoryItems
                  .filter((item) => item.active)
                  .filter((item) =>
                    `${item.name} ${item.category} ${item.barcode ?? ""}`.toLowerCase().includes(customerTabSearch.toLowerCase())
                  )
                  .map((item) => (
                    <button key={item.id} type="button" className="catalog-card" onClick={() => addItemToCustomerTab(item)}>
                      <strong>{item.name}</strong>
                      <span>{item.category}</span>
                      <span>{currency(item.price)}</span>
                      <span className="muted">{getInventoryPickerDetail(item, undefined, selectedCustomerTab?.id)}</span>
                    </button>
                  ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Consumables Tab</h2>
                  <p>Track sheesha, food, and drink items for customers who pay when they leave.</p>
                </div>
              </div>
              <div className="section-block">
                <div className="section-block-header">
                  <h3>Open or Find Customer Tab</h3>
                  <p>One active tab per customer. Reusing a customer automatically opens their current tab.</p>
                </div>
                <form className="form-grid" onSubmit={createOrSelectCustomerTab}>
                  <label>
                    <span>Customer Name</span>
                    <input
                      required
                      value={customerTabDraft.customerName}
                      onChange={(event) =>
                        setCustomerTabDraft((previous) => ({ ...previous, customerName: event.target.value }))
                      }
                      placeholder="Enter customer name"
                    />
                  </label>
                  <label>
                    <span>Customer Phone</span>
                    <input
                      value={customerTabDraft.customerPhone}
                      onChange={(event) =>
                        setCustomerTabDraft((previous) => ({ ...previous, customerPhone: event.target.value }))
                      }
                      placeholder="Optional"
                    />
                  </label>
                  <button className="primary-button" type="submit">
                    Open / Find Tab
                  </button>
                </form>
                <div className="tab-chip-grid">
                  {openCustomerTabs.length === 0 && <div className="empty-state">No open customer tabs yet.</div>}
                  {openCustomerTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`tab-chip ${selectedCustomerTab?.id === tab.id ? "is-active" : ""}`}
                      onClick={() => {
                        setSelectedCustomerTabId(tab.id);
                        setCustomerTabDraft({
                          customerName: tab.customerName,
                          customerPhone: tab.customerPhone ?? ""
                        });
                      }}
                    >
                      <strong>{tab.customerName}</strong>
                      <span>{currency(getCustomerTabTotal(tab))}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="section-block section-block-muted">
                <div className="section-block-header">
                  <h3>{selectedCustomerTab ? `${selectedCustomerTab.customerName}'s Tab` : "Current Tab"}</h3>
                  <p>{selectedCustomerTab ? "Add items from the left panel and finalize when the customer leaves." : "Open a tab to begin tracking consumables."}</p>
                </div>
                <div className="line-items">
                  {!selectedCustomerTab && <div className="empty-state">Open or select a customer tab first.</div>}
                  {selectedCustomerTab && selectedCustomerTab.items.length === 0 && (
                    <div className="empty-state">Add items from the left panel.</div>
                  )}
                  {selectedCustomerTab?.items.map((item: CustomerTabItem) => (
                    <div key={item.id} className="line-item-row">
                      <div>
                        <strong>{item.name}</strong>
                        <div className="muted">{currency(item.unitPrice)} each</div>
                      </div>
                      <label className="inline-field small">
                        <span>Qty</span>
                        <NumericInput
                          value={item.quantity}
                          min={1}
                          defaultValue={1}
                          onValueChange={(value) => updateCustomerTabItemQuantity(item.id, value)}
                        />
                      </label>
                      <div className="button-row dense">
                        <strong>{currency(item.unitPrice * item.quantity)}</strong>
                        <button className="ghost-button danger" type="button" onClick={() => removeItemFromCustomerTab(item.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="checkout-footer">
                  <div className="checkout-total-block">
                    <span className="muted">Tab total</span>
                    <strong>{currency(selectedCustomerTab ? getCustomerTabTotal(selectedCustomerTab) : 0)}</strong>
                  </div>
                  <div className="button-row">
                    {selectedCustomerTab && (
                      <button className="ghost-button danger" type="button" onClick={() => rejectCustomerTab(selectedCustomerTab.id)}>
                        Reject Tab
                      </button>
                    )}
                    <button className="primary-button" type="button" onClick={beginCustomerTabCheckout}>
                      Proceed to Checkout
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "inventory" && (activeUser.role === "manager" || activeUser.role === "admin") && (
          <section className="section-grid">
            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Inventory Catalog</h2>
                  <p>{canEditInventory ? "Create items, update prices, and keep barcode/search billing flexible." : "Review catalog, stock levels, and barcode setup in read-only mode."}</p>
                </div>
              </div>
              {isManagerReadOnly && <div className="read-only-banner">Manager view: read-only access on this page.</div>}
              {canEditInventory && (
              <div className="section-block reports-summary-block">
                <div className="section-block-header">
                  <h3>{itemForm.id ? "Update Item" : "Add New Item"}</h3>
                  <p>Define price, opening stock, barcode, alert threshold, and reusable behavior.</p>
                </div>
              <form className="form-grid" onSubmit={upsertInventoryItem}>
                <label><span>Item Name</span><input required value={itemForm.name} onChange={(event) => setItemForm((p) => ({ ...p, name: event.target.value }))} /></label>
                <label>
                  <span>Category</span>
                  <select
                    value={useCustomItemCategory ? "__other__" : itemForm.category}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      if (nextValue === "__other__") {
                        setUseCustomItemCategory(true);
                        setCustomItemCategory(itemForm.category);
                        return;
                      }
                      setUseCustomItemCategory(false);
                      setCustomItemCategory("");
                      setItemForm((p) => ({ ...p, category: nextValue }));
                    }}
                  >
                    <option value="">Select category</option>
                    {inventoryCategoryOptions.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                    <option value="__other__">Other</option>
                  </select>
                </label>
                {useCustomItemCategory && (
                  <label>
                    <span>New Category</span>
                    <input
                      required
                      value={customItemCategory}
                      onChange={(event) => {
                        setCustomItemCategory(event.target.value);
                        setItemForm((p) => ({ ...p, category: event.target.value }));
                      }}
                      placeholder="Enter new category"
                    />
                  </label>
                )}
                <label><span>Price</span><NumericInput required mode="decimal" min={0} value={itemForm.price} onValueChange={(value) => setItemForm((p) => ({ ...p, price: value }))} /></label>
                <label><span>Opening Stock</span><NumericInput required min={0} value={itemForm.stockQty} onValueChange={(value) => setItemForm((p) => ({ ...p, stockQty: value }))} /></label>
                <label><span>Low Stock Threshold</span><NumericInput required min={0} value={itemForm.lowStockThreshold} onValueChange={(value) => setItemForm((p) => ({ ...p, lowStockThreshold: value }))} /></label>
                <label><span>Barcode</span><input value={itemForm.barcode} onChange={(event) => setItemForm((p) => ({ ...p, barcode: event.target.value }))} /></label>
                <label className="checkbox-field"><input type="checkbox" checked={itemForm.isReusable} onChange={(event) => setItemForm((p) => ({ ...p, isReusable: event.target.checked }))} /><span>Reusable item</span></label>
                <label className="checkbox-field"><input type="checkbox" checked={itemForm.active} onChange={(event) => setItemForm((p) => ({ ...p, active: event.target.checked }))} /><span>Item active</span></label>
                <div className="button-row">
                  <button className="primary-button" type="submit">{itemForm.id ? "Update Item" : "Create Item"}</button>
                  {itemForm.id && <button className="secondary-button" type="button" onClick={resetItemForm}>Clear</button>}
                </div>
              </form>
              </div>
              )}
              <div className="section-block section-block-muted">
                <div className="section-block-header">
                  <h3>Current Items</h3>
                  <p>{canEditInventory ? "Review stock position, barcode setup, and quick edit access." : "Review stock position, barcode setup, and alert status."}</p>
                </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Item</th><th>Category</th><th>Type</th><th>Price</th><th>Stock</th><th>Threshold</th><th>Status</th><th>Barcode</th>{canEditInventory && <th />}</tr></thead>
                  <tbody>
                    {appData.inventoryItems.map((item) => (
                      <tr key={item.id}>
                        <td>{item.name}</td>
                        <td>{item.category}</td>
                        <td>{item.isReusable ? "Reusable" : "Consumable"}</td>
                        <td>{currency(item.price)}</td>
                        <td>{item.stockQty}</td>
                        <td>{item.lowStockThreshold}</td>
                        <td><span className={`inventory-badge is-${getInventoryState(item)}`}>{getInventoryStateLabel(getInventoryState(item))}</span></td>
                        <td>{item.barcode || "—"}</td>
                        {canEditInventory && <td><button className="ghost-button" type="button" onClick={() => beginEditInventoryItem(item)}>Edit</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2>Stock Movements</h2>
                  <p>{canEditInventory ? "Restock or manually deduct stock with required reasons." : "Review the latest stock deductions, sales, and adjustments."}</p>
                </div>
              </div>
              {canEditInventory && (
              <div className="section-block">
                <div className="section-block-header">
                  <h3>Record Movement</h3>
                  <p>Capture restock and adjustment entries with a clear reason.</p>
                </div>
              <div className="form-grid">
                <label><span>Item</span><select value={inventoryAction.itemId} onChange={(event) => setInventoryAction((p) => ({ ...p, itemId: event.target.value }))}><option value="">Select item</option>{appData.inventoryItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label><span>Quantity</span><NumericInput min={1} defaultValue={1} value={inventoryAction.quantity} onValueChange={(value) => setInventoryAction((p) => ({ ...p, quantity: value }))} /></label>
                <label className="field-span-full"><span>Reason</span><input value={inventoryAction.reason} onChange={(event) => setInventoryAction((p) => ({ ...p, reason: event.target.value }))} placeholder="damage, expiry, correction, opening stock..." /></label>
                <div className="button-row field-span-full">
                  <button className="primary-button" type="button" onClick={() => recordStockMovement("restock")}>Restock</button>
                  <button className="secondary-button" type="button" onClick={() => recordStockMovement("adjustment")}>Deduct / Adjust</button>
                </div>
              </div>
              </div>
              )}
              <div className="section-block section-block-muted">
                <div className="section-block-header">
                  <h3>Recent Movements</h3>
                  <p>Latest stock deductions, sales, and manual corrections.</p>
                </div>
              <div className="activity-list">
                {appData.stockMovements.slice(0, 10).map((movement) => (
                  <div key={movement.id} className="activity-row">
                    <strong>{appData.inventoryItems.find((item) => item.id === movement.itemId)?.name || "Item"}</strong>
                    <span className="muted">{movement.type} · {movement.quantity} · {movement.reason}</span>
                  </div>
                ))}
              </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "reports" && (activeUser.role === "manager" || activeUser.role === "admin") && (
          <>
            <div className="reports-toolbar">
              <div className="reports-toolbar-copy">
                <h2>Operational Reports</h2>
                <p>Range-based revenue, expense, and profit insights for owners.</p>
                {isManagerReadOnly && <div className="read-only-banner compact">Manager view: read-only access on this page.</div>}
              </div>
              <div className="report-filter-inline">
                <label>
                  <span>Range</span>
                  <select value={reportFilter.preset} onChange={(event) => setReportFilter((previous) => ({ ...previous, preset: event.target.value as ReportPreset }))}>
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="last_7_days">Last 7 Days</option>
                    <option value="this_month">This Month</option>
                    <option value="last_month">Last Month</option>
                    <option value="this_year">This Year</option>
                    <option value="custom">Custom Range</option>
                  </select>
                </label>
                {reportFilter.preset === "custom" && (
                  <>
                    <label>
                      <span>From</span>
                      <input type="date" value={reportFilter.fromDate ?? reportFromDate} onChange={(event) => setReportFilter((previous) => ({ ...previous, fromDate: event.target.value }))} />
                    </label>
                    <label>
                      <span>To</span>
                      <input type="date" value={reportFilter.toDate ?? reportToDate} onChange={(event) => setReportFilter((previous) => ({ ...previous, toDate: event.target.value }))} />
                    </label>
                  </>
                )}
                <div className="report-range-chip">
                  <div className="report-range-chip-head">
                    <span className="muted">Selected Period</span>
                    <strong>{resolvedReportRange.label}</strong>
                  </div>
                  <div className="muted">{reportFromDate} to {reportToDate}</div>
                </div>
              </div>
            </div>
          <section className="section-grid reports-layout">
            <div className="panel">
              <div className="section-block reports-summary-block">
              <div className="section-block-header">
                <h3>Performance Snapshot</h3>
                <p>Primary range KPIs first, followed by supporting revenue and profit signals.</p>
              </div>
              <div className="reports-kpi-grid">
                <div className="report-kpi-card is-primary">
                  <span className="muted">Gross Revenue</span>
                  <strong>{currency(grossRevenue)}</strong>
                </div>
                <div className="report-kpi-card is-primary">
                  <span className="muted">Net Cash Earnings</span>
                  <strong>{currency(netCashEarnings)}</strong>
                </div>
                <div className="report-kpi-card is-primary">
                  <span className="muted">Net Profit (Normalized)</span>
                  <strong>{currency(normalizedNetProfit)}</strong>
                </div>
              </div>
              <div className="reports-support-grid">
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Bills</span>
                  <strong>{`${issuedBills.length}`}</strong>
                </div>
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Cash Expenses</span>
                  <strong>{currency(cashExpenses)}</strong>
                </div>
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Normalized Monthly Expenses</span>
                  <strong>{currency(normalizedExpenses)}</strong>
                </div>
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Session Revenue</span>
                  <strong>{currency(sessionRevenue)}</strong>
                </div>
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Consumable Revenue</span>
                  <strong>{currency(itemRevenue)}</strong>
                </div>
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Discounts</span>
                  <strong>{currency(totalDiscounts)}</strong>
                </div>
              </div>
              <div className="insight-grid">
                <div className="insight-card">
                  <span className="muted">Revenue Growth vs {previousRange.label}</span>
                  <strong>
                    {revenueGrowthPct === null
                      ? "No comparable prior data"
                      : `${revenueGrowthPct >= 0 ? "+" : ""}${revenueGrowthPct.toFixed(1)}%`}
                  </strong>
                  <div className="muted">
                    Previous range revenue: {currency(previousRangeRevenue)}
                  </div>
                </div>
                <div className="insight-card">
                  <span className="muted">Average Bill Value</span>
                  <strong>{currency(averageBillValue)}</strong>
                  <div className="muted">
                    Discount given: {currency(totalDiscounts)}
                  </div>
                </div>
                <div className="insight-card">
                  <span className="muted">Top Earning Channel</span>
                  <strong>{topStation?.[0] ?? "No sales yet"}</strong>
                  <div className="muted">
                    {topStation ? currency(topStation[1]) : "No revenue in selected period"}
                  </div>
                </div>
              </div>
              </div>
              <div className="section-block section-block-muted">
              <div className="panel-header">
                <div>
                  <h2>Selected Period Analysis</h2>
                  <p>Compare actual spend and normalized operating cost for the chosen range.</p>
                </div>
              </div>
              <div className="analysis-list">
                <div className="activity-row">
                  <strong>Gross Revenue</strong>
                  <span className="muted">{currency(grossRevenue)}</span>
                </div>
                <div className="activity-row">
                  <strong>Cash Expenses</strong>
                  <span className="muted">{currency(cashExpenses)}</span>
                </div>
                <div className="activity-row">
                  <strong>Normalized Monthly Expenses</strong>
                  <span className="muted">{currency(normalizedExpenses)}</span>
                </div>
                <div className="activity-row">
                  <strong>Net Cash Earnings</strong>
                  <span className="muted">{currency(netCashEarnings)}</span>
                </div>
                <div className="activity-row">
                  <strong>Net Profit (Normalized)</strong>
                  <span className="muted">{currency(normalizedNetProfit)}</span>
                </div>
                <div className="activity-row">
                  <strong>Payment Mix</strong>
                  <span className="muted">
                    Cash {currency(paymentModeTotals.cash)} · UPI {currency(paymentModeTotals.upi)}
                  </span>
                </div>
              </div>
              </div>
              <div className="reports-workspace">
                <div
                  className="section-block bill-register-block"
                  style={receiptPreviewBlockHeight ? { height: `${receiptPreviewBlockHeight}px` } : undefined}
                >
                  <div className="section-block-header">
                    <h3>Bill Register</h3>
                    <p>Export and review bills for the selected period without stretching the full page.</p>
                  </div>
                  <div className="button-row">
                    <button className="secondary-button" type="button" onClick={() => exportRowsToCsv(reportRows, `report-${reportFromDate}-${reportToDate}.csv`)}>Export CSV</button>
                    <button className="secondary-button" type="button" onClick={() => exportRowsToXlsx(reportRows, `report-${reportFromDate}-${reportToDate}.xlsx`)}>Export Excel</button>
                    <button className="secondary-button" type="button" onClick={() => exportRowsToPdf(reportRows, `report-${reportFromDate}-${reportToDate}.pdf`, appData.businessProfile.name)}>Export PDF</button>
                  </div>
                  <div className="table-wrap bill-register-wrap">
                    <table>
                      <thead><tr><th>Bill</th><th>Date</th><th>Station</th><th>Customer</th><th>Payment</th><th>Total</th><th>Status</th><th /></tr></thead>
                      <tbody>
                        {filteredBills.length === 0 && (
                          <tr>
                            <td colSpan={8}><div className="empty-state">No bills found for the selected period.</div></td>
                          </tr>
                        )}
                        {filteredBills.map((bill) => (
                          <tr key={bill.id}>
                            <td>{bill.billNumber}</td>
                            <td>{formatDateTime(bill.issuedAt)}</td>
                            <td>{bill.stationId ? appData.stations.find((station) => station.id === bill.stationId)?.name || "Station" : "Customer tab"}</td>
                            <td>{bill.customerName || "Walk-in"}</td>
                            <td>{bill.paymentMode.toUpperCase()}</td>
                            <td>{currency(bill.total)}</td>
                            <td>{bill.status}</td>
                            <td>
                              <div className="button-row dense">
                                <button className="ghost-button" type="button" onClick={() => setSelectedReceiptBillId(bill.id)}>View</button>
                                {canReplaceIssuedBills && bill.status === "issued" && (
                                  <button className="ghost-button" type="button" onClick={() => openBillReplacement(bill.id)}>Replace Bill</button>
                                )}
                                {canVoidRefundBills && bill.status === "issued" && (
                                  <button className="ghost-button danger" type="button" onClick={() => voidOrRefundBill(bill.id)}>Void/Refund</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="section-block receipt-preview-block" ref={receiptPreviewBlockRef}>
                  <div className="section-block-header">
                    <h3>Receipt Preview</h3>
                    <p>Select a bill from the register to preview it here.</p>
                  </div>
                  {selectedReceiptBill && receiptPreviewModel ? (
                    <div className="receipt-preview thermal-receipt-preview">
                      <div className="thermal-receipt-brand">
                        <div className="thermal-receipt-logo-shell">
                          <img className="thermal-receipt-logo" src={brandLogo} alt={`${appData.businessProfile.name} logo`} />
                        </div>
                        <div className="thermal-receipt-title">{receiptPreviewModel.brandTitle}</div>
                        <div className="thermal-receipt-subtitle">{receiptPreviewModel.brandSubtitle}</div>
                      </div>
                      <div className="thermal-receipt-info">
                        {receiptPreviewModel.infoLines.map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                      <div className="thermal-receipt-divider" />
                      <div className="thermal-receipt-meta">
                        {receiptPreviewModel.metaRows.map((row) => (
                          <div key={row.label} className="thermal-receipt-meta-row">
                            <span>{row.label}</span>
                            <strong>{row.value}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="thermal-receipt-divider" />
                      <div className="thermal-receipt-entries">
                        {receiptPreviewModel.entries.map((entry) => (
                          <div key={entry.id} className={`thermal-receipt-entry ${entry.isDiscount ? "is-discount" : ""}`}>
                            <div className="thermal-receipt-entry-head">
                              <strong>{entry.title}</strong>
                              <strong>{entry.amount}</strong>
                            </div>
                            <div className="thermal-receipt-entry-detail">{entry.detail}</div>
                          </div>
                        ))}
                      </div>
                      <div className="thermal-receipt-divider" />
                      <div className="thermal-receipt-totals">
                        <div><span>Subtotal</span><strong>{receiptPreviewModel.subtotal}</strong></div>
                        <div><span>Discount</span><strong>{receiptPreviewModel.discount}</strong></div>
                        {receiptPreviewModel.roundOff && <div><span>Round Off</span><strong>{receiptPreviewModel.roundOff}</strong></div>}
                        <div className="is-grand-total"><span>Total</span><strong>{receiptPreviewModel.total}</strong></div>
                      </div>
                      <div className="thermal-receipt-divider" />
                      <div className="thermal-receipt-footer">{receiptPreviewModel.footer}</div>
                      <button className="secondary-button" type="button" onClick={() => openReceiptWindow(appData.businessProfile, selectedReceiptBill, appData.bills)}>Open Receipt Window</button>
                    </div>
                  ) : <div className="empty-state">Select a bill to view its receipt.</div>}
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="section-block section-block-muted">
              <div className="panel-header">
                <div><h2>Expense Breakdown</h2><p>Separate actual paid expenses from normalized monthly operating cost.</p></div>
              </div>
              <div className="expense-breakdown-grid">
                <div className="expense-breakdown-card">
                  <strong>Cash Expenses</strong>
                  {expenseByCategory.length > 0 ? (
                    <div className="activity-list compact-list">
                      {expenseByCategory.map(([category, amount]) => (
                        <div key={category} className="activity-row">
                          <strong>{category}</strong>
                          <span className="muted">{currency(amount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">No one-time expenses in this period.</div>
                  )}
                </div>
                <div className="expense-breakdown-card">
                  <strong>Normalized Monthly Expenses</strong>
                  {normalizedExpenseByCategory.length > 0 ? (
                    <div className="activity-list compact-list">
                      {normalizedExpenseByCategory.map(([category, amount]) => (
                        <div key={category} className="activity-row">
                          <strong>{category}</strong>
                          <span className="muted">{currency(amount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">No active monthly templates affecting this period.</div>
                  )}
                </div>
              </div>
              </div>
              {canEditReports && (
                <>
                  <div className="section-block">
                  <div className="panel-header">
                    <div><h2>One-Time Expense</h2><p>Log actual paid expenses for a specific date inside the selected range.</p></div>
                  </div>
                  <form className="form-grid" onSubmit={createExpense}>
                    <label><span>Title</span><input required value={expenseForm.title} onChange={(event) => setExpenseForm((p) => ({ ...p, title: event.target.value }))} placeholder="Milk restock, electricity, rent..." /></label>
                    <label><span>Category</span><select value={expenseForm.category} onChange={(event) => setExpenseForm((p) => ({ ...p, category: event.target.value }))}>{expenseCategoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
                    <label><span>Amount</span><NumericInput required mode="decimal" min={0} value={expenseForm.amount} onValueChange={(value) => setExpenseForm((p) => ({ ...p, amount: value }))} /></label>
                    <label><span>Date</span><input type="date" value={expenseForm.spentAt} onChange={(event) => setExpenseForm((p) => ({ ...p, spentAt: event.target.value }))} /></label>
                    <label className="field-span-full"><span>Notes</span><input value={expenseForm.notes} onChange={(event) => setExpenseForm((p) => ({ ...p, notes: event.target.value }))} placeholder="Optional details" /></label>
                    <button className="primary-button field-span-full" type="submit">Add One-Time Expense</button>
                  </form>
                  <div className="activity-list">
                    {filteredExpenses.length > 0 ? filteredExpenses.slice(0, 8).map((expense) => (
                      <div key={expense.id} className="line-item-row">
                        <div>
                          <strong>{expense.title}</strong>
                          <div className="muted">{expense.category} · {formatDateTime(expense.spentAt)}</div>
                        </div>
                        <div className="button-row dense">
                          <span>{currency(expense.amount)}</span>
                          <button className="ghost-button danger" type="button" onClick={() => deleteExpense(expense.id)}>Delete</button>
                        </div>
                      </div>
                    )) : <div className="empty-state">No one-time expenses logged for this period.</div>}
                  </div>
                  </div>
                  <div className="section-block section-block-muted">
                  <div className="panel-header">
                    <div><h2>Monthly Expense Templates</h2><p>Track repeating monthly costs like rent and internet without creating fake daily entries.</p></div>
                  </div>
                  <form className="form-grid" onSubmit={saveExpenseTemplate}>
                    <label><span>Title</span><input required value={expenseTemplateForm.title} onChange={(event) => setExpenseTemplateForm((p) => ({ ...p, title: event.target.value }))} placeholder="Rent, internet, salaries..." /></label>
                    <label><span>Category</span><select value={expenseTemplateForm.category} onChange={(event) => setExpenseTemplateForm((p) => ({ ...p, category: event.target.value }))}>{expenseCategoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
                    <label><span>Monthly Amount</span><NumericInput required mode="decimal" min={0} value={expenseTemplateForm.amount} onValueChange={(value) => setExpenseTemplateForm((p) => ({ ...p, amount: value }))} /></label>
                    <label><span>Start Month</span><input type="month" value={expenseTemplateForm.startMonth} onChange={(event) => setExpenseTemplateForm((p) => ({ ...p, startMonth: event.target.value }))} /></label>
                    <label className="field-span-full"><span>Notes</span><input value={expenseTemplateForm.notes ?? ""} onChange={(event) => setExpenseTemplateForm((p) => ({ ...p, notes: event.target.value }))} placeholder="Optional details" /></label>
                    <label className="checkbox-field"><input type="checkbox" checked={expenseTemplateForm.active} onChange={(event) => setExpenseTemplateForm((p) => ({ ...p, active: event.target.checked }))} /><span>Template active</span></label>
                    <div className="button-row field-span-full">
                      <button className="primary-button" type="submit">{expenseTemplateForm.id ? "Update Monthly Template" : "Create Monthly Template"}</button>
                      {expenseTemplateForm.id && <button className="secondary-button" type="button" onClick={() => setExpenseTemplateForm({ id: "", title: "", category: "Rent", amount: 0, frequency: "monthly", startMonth: reportToDate.slice(0, 7), active: true, notes: "", createdByUserId: "" })}>Clear</button>}
                    </div>
                  </form>
                  <div className="activity-list">
                    {appData.expenseTemplates.length > 0 ? appData.expenseTemplates.map((template) => (
                      <div key={template.id} className="line-item-row">
                        <div>
                          <strong>{template.title}</strong>
                          <div className="muted">{template.category} · {currency(template.amount)} / month · from {formatMonthLabel(template.startMonth)}</div>
                        </div>
                        <div className="button-row dense">
                          <span className="muted">{template.active ? "Active" : "Inactive"}</span>
                          <button className="ghost-button" type="button" onClick={() => beginEditExpenseTemplate(template)}>Edit</button>
                          <button className="ghost-button" type="button" onClick={() => toggleExpenseTemplateActive(template.id)}>{template.active ? "Deactivate" : "Activate"}</button>
                          <button className="ghost-button danger" type="button" onClick={() => deleteExpenseTemplate(template.id)}>Delete</button>
                        </div>
                      </div>
                    )) : <div className="empty-state">No monthly templates yet.</div>}
                  </div>
                  </div>
                </>
              )}
            </div>
          </section>
          </>
        )}

        {activeTab === "settings" && (activeUser.role === "manager" || activeUser.role === "admin") && (
          <section className="section-grid settings-layout">
            {isManagerReadOnly && <div className="read-only-banner field-span-full">Manager view: read-only access on this page.</div>}
            <div className="panel field-span-full">
              <div className="panel-header">
                <div><h2>Business Profile</h2><p>Receipt identity and customer-facing contact details.</p></div>
              </div>
              {canEditSettings ? (
                <form className="form-grid" onSubmit={saveBusinessProfile}>
                  <label><span>Business Name</span><input value={businessDraft.name} onChange={(event) => setBusinessDraft((p) => ({ ...p, name: event.target.value }))} /></label>
                  <label><span>Logo Text</span><input value={businessDraft.logoText} onChange={(event) => setBusinessDraft((p) => ({ ...p, logoText: event.target.value }))} /></label>
                  <label className="field-span-full"><span>Address</span><input value={businessDraft.address} onChange={(event) => setBusinessDraft((p) => ({ ...p, address: event.target.value }))} /></label>
                  <label><span>Primary Phone</span><input value={businessDraft.primaryPhone} onChange={(event) => setBusinessDraft((p) => ({ ...p, primaryPhone: event.target.value }))} /></label>
                  <label><span>Secondary Phone</span><input value={businessDraft.secondaryPhone ?? ""} onChange={(event) => setBusinessDraft((p) => ({ ...p, secondaryPhone: event.target.value }))} /></label>
                  <label className="field-span-full"><span>Receipt Footer</span><input value={businessDraft.receiptFooter} onChange={(event) => setBusinessDraft((p) => ({ ...p, receiptFooter: event.target.value }))} /></label>
                  <button className="primary-button" type="submit">Save Business Details</button>
                </form>
              ) : (
                <div className="activity-list">
                  <div className="activity-row"><strong>Business Name</strong><span className="muted">{appData.businessProfile.name}</span></div>
                  <div className="activity-row"><strong>Logo Text</strong><span className="muted">{appData.businessProfile.logoText}</span></div>
                  <div className="activity-row"><strong>Primary Phone</strong><span className="muted">{appData.businessProfile.primaryPhone}</span></div>
                  <div className="activity-row"><strong>Secondary Phone</strong><span className="muted">{appData.businessProfile.secondaryPhone || "—"}</span></div>
                  <div className="activity-row"><strong>Address</strong><span className="muted">{appData.businessProfile.address}</span></div>
                  <div className="activity-row"><strong>Receipt Footer</strong><span className="muted">{appData.businessProfile.receiptFooter}</span></div>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-header">
                <div><h2>Stations</h2><p>{canEditSettings ? "Add or remove tables, consoles, and other timed resources." : "Review configured stations and their current status."}</p></div>
              </div>
              {canEditSettings && (
              <form className="form-grid" onSubmit={upsertStation}>
                <label><span>Station Name</span><input required value={stationForm.name} onChange={(event) => setStationForm((p) => ({ ...p, name: event.target.value }))} /></label>
                <label><span>Mode</span><select value={stationForm.mode} onChange={(event) => setStationForm((p) => ({ ...p, mode: event.target.value as Station["mode"] }))}><option value="timed">Timed</option><option value="unit_sale">Unit sale</option></select></label>
                <label className="checkbox-field"><input type="checkbox" checked={stationForm.active} onChange={(event) => setStationForm((p) => ({ ...p, active: event.target.checked }))} /><span>Active station</span></label>
                <label className="checkbox-field"><input type="checkbox" checked={stationForm.ltpEnabled} onChange={(event) => setStationForm((p) => ({ ...p, ltpEnabled: event.target.checked }))} /><span>LTP enabled</span></label>
                <button className="primary-button" type="submit">{stationForm.id ? "Update Station" : "Create Station"}</button>
              </form>
              )}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Station</th><th>Mode</th><th>LTP</th><th>Status</th>{canEditSettings && <th />}</tr></thead>
                  <tbody>
                    {appData.stations.map((station) => (
                      <tr key={station.id}>
                        <td>{station.name}</td>
                        <td>{station.mode}</td>
                        <td>{station.ltpEnabled ? "Enabled" : "Off"}</td>
                        <td>{station.active ? "Active" : "Inactive"}</td>
                        {canEditSettings && <td><div className="button-row dense"><button className="ghost-button" type="button" onClick={() => setStationForm(station)}>Edit</button><button className="ghost-button danger" type="button" onClick={() => deleteStation(station.id)}>Delete</button></div></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div><h2>Pricing Bands</h2><p>{canEditSettings ? "Hourly rates are prorated and split across time ranges automatically." : "Review configured rate bands for each station."}</p></div>
              </div>
              {canEditSettings && (
              <form className="form-grid" onSubmit={addPricingRule}>
                <label><span>Station</span><select value={pricingDraft.stationId} onChange={(event) => setPricingDraft((p) => ({ ...p, stationId: event.target.value }))}><option value="">Select station</option>{appData.stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
                <label><span>Label</span><input required value={pricingDraft.label} onChange={(event) => setPricingDraft((p) => ({ ...p, label: event.target.value }))} placeholder="Day, Night..." /></label>
                <label><span>Start</span><input type="time" value={pricingDraft.startTime} onChange={(event) => setPricingDraft((p) => ({ ...p, startTime: event.target.value }))} /></label>
                <label><span>End</span><input type="time" value={pricingDraft.endTime} onChange={(event) => setPricingDraft((p) => ({ ...p, endTime: event.target.value }))} /></label>
                <label><span>Hourly Rate</span><NumericInput required mode="decimal" min={0} value={pricingDraft.hourlyRate} onValueChange={(value) => setPricingDraft((p) => ({ ...p, hourlyRate: value }))} /></label>
                <button className="primary-button" type="submit">Add Pricing Rule</button>
              </form>
              )}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Station</th><th>Label</th><th>Time Band</th><th>Rate</th>{canEditSettings && <th />}</tr></thead>
                  <tbody>
                    {appData.pricingRules.map((rule: PricingRule) => (
                      <tr key={rule.id}>
                        <td>{appData.stations.find((station) => station.id === rule.stationId)?.name || "Station"}</td>
                        <td>{rule.label}</td>
                        <td>{minuteToTimeLabel(rule.startMinute)} - {minuteToTimeLabel(rule.endMinute)}</td>
                        <td>{currency(rule.hourlyRate)}/hr</td>
                        {canEditSettings && <td><button className="ghost-button danger" type="button" onClick={() => deletePricingRule(rule.id)}>Delete</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {activeTab === "users" && activeUser.role === "admin" && (
          <section className="section-grid">
            <div className="panel">
              <div className="panel-header">
                <div><h2>Create User</h2><p>Create accounts for admin, manager, and reception users.</p></div>
              </div>
              <form className="form-grid" onSubmit={createUser}>
                <label><span>Name</span><input required value={userForm.name} onChange={(event) => setUserForm((p) => ({ ...p, name: event.target.value }))} /></label>
                <label><span>Username</span><input required value={userForm.username} onChange={(event) => setUserForm((p) => ({ ...p, username: event.target.value }))} /></label>
                <label><span>Password</span><input required value={userForm.password} onChange={(event) => setUserForm((p) => ({ ...p, password: event.target.value }))} /></label>
                <label><span>Role</span><select value={userForm.role} onChange={(event) => setUserForm((p) => ({ ...p, role: event.target.value as Role }))}><option value="admin">Admin</option><option value="manager">Manager</option><option value="receptionist">Receptionist</option></select></label>
                <button className="primary-button" type="submit">Create User</button>
              </form>
            </div>
            <div className="panel">
              <div className="panel-header"><div><h2>Edit Users</h2><p>Only admins can edit user details, change passwords, or revoke access.</p></div></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {appData.users.map((user) => (
                      <tr key={user.id}>
                        <td>{user.name}</td>
                        <td>{user.username}</td>
                        <td>{user.role}</td>
                        <td>{user.active ? "Active" : "Inactive"}</td>
                        <td>
                          <div className="button-row dense">
                            <button className="ghost-button" type="button" onClick={() => beginEditUser(user)}>Edit</button>
                            <button className="ghost-button" type="button" onClick={() => openChangePassword(user)}>Change Password</button>
                            <button className="ghost-button" type="button" onClick={() => toggleUserActive(user.id)}>{user.active ? "Disable" : "Enable"}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </main>

      {editUserDraft && (
        <Modal title="Edit User" onClose={() => setEditUserDraft(null)}>
          <form className="form-grid" onSubmit={saveUserEdits}>
            <label>
              <span>Name</span>
              <input
                required
                value={editUserDraft.name}
                onChange={(event) => setEditUserDraft((previous) => (previous ? { ...previous, name: event.target.value } : previous))}
              />
            </label>
            <label>
              <span>Username</span>
              <input
                required
                value={editUserDraft.username}
                onChange={(event) => setEditUserDraft((previous) => (previous ? { ...previous, username: event.target.value } : previous))}
              />
            </label>
            <label className="field-span-full">
              <span>Role</span>
              <select
                value={editUserDraft.role}
                onChange={(event) =>
                  setEditUserDraft((previous) =>
                    previous ? { ...previous, role: event.target.value as Role } : previous
                  )
                }
              >
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="receptionist">Receptionist</option>
              </select>
            </label>
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => setEditUserDraft(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Save User
              </button>
            </div>
          </form>
        </Modal>
      )}

      {passwordDraft && (
        <Modal
          title={`Change Password${appData.users.find((user) => user.id === passwordDraft.userId) ? ` · ${appData.users.find((user) => user.id === passwordDraft.userId)?.username}` : ""}`}
          onClose={() => setPasswordDraft(null)}
        >
          <form className="form-grid" onSubmit={saveUserPassword}>
            <label className="field-span-full">
              <span>New Password</span>
              <input
                type="password"
                required
                value={passwordDraft.password}
                onChange={(event) =>
                  setPasswordDraft((previous) => (previous ? { ...previous, password: event.target.value } : previous))
                }
              />
            </label>
            <label className="field-span-full">
              <span>Confirm Password</span>
              <input
                type="password"
                required
                value={passwordDraft.confirmPassword}
                onChange={(event) =>
                  setPasswordDraft((previous) => (previous ? { ...previous, confirmPassword: event.target.value } : previous))
                }
              />
            </label>
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => setPasswordDraft(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Update Password
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showStartSessionModal && (
        <Modal
          title="Start New Session"
          onClose={() => {
            setShowStartSessionModal(false);
            setStartSessionDraft(createStartSessionDraft());
          }}
        >
          <form className="form-grid" onSubmit={startSession}>
            <label>
              <span>Station</span>
              <select
                value={startSessionDraft.stationId}
                onChange={(event) =>
                  setStartSessionDraft((previous) => {
                    const nextStation = appData.stations.find((station) => station.id === event.target.value);
                    return {
                      ...previous,
                      stationId: event.target.value,
                      playMode: nextStation?.ltpEnabled ? previous.playMode : "group",
                      arcadeItemId: nextStation?.mode === "unit_sale" ? defaultArcadeInventoryItem?.id ?? "" : "",
                      arcadeQuantity: 1
                    };
                  })
                }
              >
                <option value="">Select station</option>
                {stations
                  .filter((station) => !getActiveSessionForStation(station.id))
                  .map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Customer Name</span>
              <input
                value={startSessionDraft.customerName}
                onChange={(event) =>
                  setStartSessionDraft((previous) => ({ ...previous, customerName: event.target.value }))
                }
                placeholder="Optional"
              />
            </label>
            <label className="field-span-full">
              <span>Customer Phone</span>
              <input
                value={startSessionDraft.customerPhone}
                onChange={(event) =>
                  setStartSessionDraft((previous) => ({ ...previous, customerPhone: event.target.value }))
                }
                placeholder="Optional"
              />
            </label>
            {selectedStartStation?.ltpEnabled && (
              <label className="field-span-full">
                <span>Play Mode</span>
                <select
                  value={startSessionDraft.playMode}
                  onChange={(event) =>
                    setStartSessionDraft((previous) => ({
                      ...previous,
                      playMode: event.target.value as PlayMode
                    }))
                  }
                >
                  <option value="solo">Solo (LTP)</option>
                  <option value="group">Group</option>
                </select>
              </label>
            )}
            {selectedStartStation?.mode === "unit_sale" && (
              <>
                {arcadeInventoryItems.length === 0 && (
                  <div className="field-span-full error-text">
                    Add an active `Arcade` inventory item first so this station can start with coin packs.
                  </div>
                )}
                <label>
                  <span>Coin Pack</span>
                  <select
                    value={startSessionDraft.arcadeItemId}
                    onChange={(event) =>
                      setStartSessionDraft((previous) => ({
                        ...previous,
                        arcadeItemId: event.target.value
                      }))
                    }
                  >
                    <option value="">Select coin pack</option>
                    {arcadeInventoryItems.map((item) => (
                      <option key={item.id} value={item.id}>
                            {item.name} · {currency(item.price)} · {getInventoryPickerDetail(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Upfront Packs</span>
                  <NumericInput
                    min={1}
                    defaultValue={1}
                    value={startSessionDraft.arcadeQuantity}
                    onValueChange={(value) =>
                      setStartSessionDraft((previous) => ({
                        ...previous,
                        arcadeQuantity: value
                      }))
                    }
                  />
                </label>
                {selectedArcadeStartItem && (
                  <div className="field-span-full helper-text">
                    Default arcade entry: {selectedArcadeStartItem.name} at {currency(selectedArcadeStartItem.price)} each.
                    Increase packs here if the customer wants more coins upfront.
                  </div>
                )}
              </>
            )}
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => {
                setShowStartSessionModal(false);
                setStartSessionDraft(createStartSessionDraft());
              }}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={selectedStartStation?.mode === "unit_sale" && arcadeInventoryItems.length === 0}>
                Start Session
              </button>
            </div>
          </form>
        </Modal>
      )}

      {managedSession && managedSessionCharge && (
        <Modal title={managedSession.stationNameSnapshot} onClose={() => setManageSessionId(null)}>
          <div className="metrics-row">
            <MetricCard label={managedSession.mode === "timed" ? "Live bill" : "Current total"} value={currency(getSessionLiveTotal(managedSession, getFrozenEndAtForSession(managedSession.id)))} />
            {managedSession.mode === "timed" ? (
              <>
                <MetricCard label="Billed time" value={formatMinutes(managedSessionCharge.billedMinutes)} />
                <MetricCard label="Paused" value={formatMinutes(managedSessionCharge.pauseMinutes)} />
              </>
            ) : (
              <>
                <MetricCard label="Coin / item lines" value={`${managedSession.items.length}`} />
                <MetricCard label="Started" value={formatTime(managedSession.startedAt)} />
              </>
            )}
          </div>
          <div className="frozen-billing-banner">
            Add consumables to the live session here. The running game time is not changed by this action.
          </div>
          <div className="panel-header compact-header">
            <div>
              <h2>Session Consumables</h2>
              <p>Add or remove items linked to this live session.</p>
            </div>
          </div>
          <div className="session-item-adder">
            <select value={sessionItemForm[managedSession.id]?.itemId ?? ""} onChange={(event) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { itemId: event.target.value, quantity: p[managedSession.id]?.quantity ?? 1 } }))}>
              <option value="">Select item</option>
              {appData.inventoryItems.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name} · {currency(item.price)} · {getInventoryPickerDetail(item, managedSession.id)}</option>)}
            </select>
            <NumericInput min={1} defaultValue={1} value={sessionItemForm[managedSession.id]?.quantity ?? 1} onValueChange={(value) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { itemId: p[managedSession.id]?.itemId ?? "", quantity: value } }))} />
            <button className="secondary-button" type="button" onClick={() => addItemToSession(managedSession.id)}>Add Item</button>
          </div>
          <div className="line-items">
            {managedSession.items.length === 0 && <div className="empty-state">No consumables added yet.</div>}
            {managedSession.items.map((item: SessionItem) => (
              <div key={item.id} className="session-item-row">
                <div>
                  <strong>{item.name}</strong>
                  <div className="muted">{formatTime(item.addedAt)}</div>
                </div>
                <div className="session-item-actions">
                  <span>{item.quantity} × {currency(item.unitPrice)}</span>
                  <button className="ghost-button danger" type="button" onClick={() => removeItemFromSession(managedSession.id, item.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          {managedSession.mode === "timed" && (
            <>
              <div className="divider" />
              <div className="panel-header compact-header">
                <div>
                  <h2>Game Charge Summary</h2>
                  <p>Frozen game-rate breakdown for the active session.</p>
                </div>
              </div>
              <div className="segments-list">
                {managedSessionCharge.segments.map((segment, index) => <div key={`${segment.label}-${index}`} className="activity-row"><strong>Game Type · {currency(segment.hourlyRate)}/hr</strong><span className="muted">{formatMinutes(segment.minutes)} · {currency(segment.subtotal)}</span></div>)}
              </div>
            </>
          )}
          <div className="button-row">
            {managedSession.mode === "timed" && (managedSession.status === "active" ? <button className="secondary-button session-action-button is-pause" type="button" onClick={() => toggleSessionPause(managedSession.id, true)}>|| Pause Session</button> : <button className="secondary-button session-action-button is-resume" type="button" onClick={() => toggleSessionPause(managedSession.id, false)}>&gt; Resume Session</button>)}
            <button className="ghost-button danger" type="button" onClick={() => rejectSession(managedSession.id)}>Reject Session</button>
            <button className="primary-button" type="button" onClick={() => openSessionCheckout(managedSession.id)}>Proceed to Checkout</button>
          </div>
        </Modal>
      )}

      {checkoutState && checkoutPreview && (
        <Modal
          title={
            checkoutState.mode === "session"
              ? "Close Session Bill"
              : checkoutState.mode === "customer_tab"
                ? "Finalize Customer Tab Bill"
                : "Replace Issued Bill"
          }
          onClose={() => {
            setCheckoutState(null);
            setReplacementItemForm({ itemId: "", quantity: 1 });
          }}
          wide
        >
          <div className="form-grid three-columns">
            <label><span>Customer Name</span><input value={checkoutState.customerName} onChange={(event) => setCheckoutState((p) => p ? { ...p, customerName: event.target.value } : p)} /></label>
            <label><span>Customer Phone</span><input value={checkoutState.customerPhone} onChange={(event) => setCheckoutState((p) => p ? { ...p, customerPhone: event.target.value } : p)} /></label>
            <label><span>Payment Mode</span><select value={checkoutState.paymentMode} onChange={(event) => setCheckoutState((p) => p ? { ...p, paymentMode: event.target.value as PaymentMode } : p)}><option value="cash">Cash</option><option value="upi">UPI</option></select></label>
          </div>
          <div className="form-grid">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={checkoutState.roundOffEnabled}
                onChange={(event) =>
                  setCheckoutState((previous) =>
                    previous ? { ...previous, roundOffEnabled: event.target.checked } : previous
                  )
                }
              />
              <span>Round off final bill to nearest rupee</span>
            </label>
          </div>
          {checkoutReplacementBill && (
            <>
              <div className="frozen-billing-banner">
                Replacing {checkoutReplacementBill.billNumber}. The original bill will be marked as incorrect and linked to the new replacement bill.
              </div>
              <div className="form-grid">
                <label className="field-span-full">
                  <span>Replacement Reason</span>
                  <input
                    value={checkoutState.replaceReason ?? ""}
                    placeholder="Explain what was wrong in the original bill"
                    onChange={(event) =>
                      setCheckoutState((previous) =>
                        previous ? { ...previous, replaceReason: event.target.value } : previous
                      )
                    }
                  />
                </label>
              </div>
              <div className="divider" />
              <div className="panel-header">
                <div>
                  <h2>Replacement Bill Items</h2>
                  <p>Session charge stays fixed. Inventory lines can be added, removed, or corrected here.</p>
                </div>
              </div>
              <div className="session-item-adder">
                <select
                  value={replacementItemForm.itemId}
                  onChange={(event) => setReplacementItemForm((previous) => ({ ...previous, itemId: event.target.value }))}
                >
                  <option value="">Select item</option>
                  {appData.inventoryItems
                    .filter((item) => item.active)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {currency(item.price)} · {getInventoryPickerDetail(item)}
                      </option>
                    ))}
                </select>
                <NumericInput
                  value={replacementItemForm.quantity}
                  min={1}
                  defaultValue={1}
                  onValueChange={(value) => setReplacementItemForm((previous) => ({ ...previous, quantity: value }))}
                />
                <button className="secondary-button" type="button" onClick={addItemToReplacementBill}>
                  Add Item
                </button>
              </div>
            </>
          )}
          {checkoutSession && (
            <>
              <div className="frozen-billing-banner">
                Billing frozen at {formatDateTime(checkoutState.closedAt ?? now)}. The session timer is stopped for this checkout.
              </div>
              {checkoutSession.ltpEligible && checkoutSession.playMode === "solo" && (
                <div className="form-grid">
                  <label>
                    <span>LTP Result</span>
                    <select
                      value={checkoutState.ltpOutcome ?? "lost"}
                      onChange={(event) =>
                        setCheckoutState((previous) =>
                          previous ? { ...previous, ltpOutcome: event.target.value as LtpOutcome } : previous
                        )
                      }
                    >
                      <option value="lost">Customer lost - full bill payable</option>
                      <option value="won">Customer won - waive game charge</option>
                    </select>
                  </label>
                </div>
              )}
              <div className="divider" />
              <div className="panel-header">
                <div>
                  <h2>Add Session Consumables</h2>
                  <p>Anything added here becomes part of this session bill.</p>
                </div>
              </div>
              <div className="session-item-adder">
                <select
                  value={sessionItemForm[checkoutSession.id]?.itemId ?? ""}
                  onChange={(event) =>
                    setSessionItemForm((p) => ({
                      ...p,
                      [checkoutSession.id]: {
                        itemId: event.target.value,
                        quantity: p[checkoutSession.id]?.quantity ?? 1
                      }
                    }))
                  }
                >
                  <option value="">Select item</option>
                  {appData.inventoryItems
                    .filter((item) => item.active)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {currency(item.price)} · {getInventoryPickerDetail(item, checkoutSession.id)}
                      </option>
                    ))}
                </select>
                <NumericInput
                  value={sessionItemForm[checkoutSession.id]?.quantity ?? 1}
                  min={1}
                  defaultValue={1}
                  onValueChange={(value) =>
                    setSessionItemForm((p) => ({
                      ...p,
                      [checkoutSession.id]: {
                        itemId: p[checkoutSession.id]?.itemId ?? "",
                        quantity: value
                      }
                    }))
                  }
                />
                <button className="secondary-button" type="button" onClick={() => addItemToSession(checkoutSession.id)}>
                  Add Item
                </button>
              </div>
            </>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Reason</th><th>Total</th>{checkoutState.mode === "bill_replacement" && <th>Action</th>}</tr></thead>
              <tbody>
                {checkoutLines.map((line) => {
                  const subtotal = line.quantity * line.unitPrice;
                  const discount = checkoutLineDiscounts[line.id];
                  const isLtpAutoDiscount =
                    checkoutSession?.ltpEligible &&
                    checkoutSession.playMode === "solo" &&
                    checkoutState.ltpOutcome === "won" &&
                    line.type === "session_charge";
                  const lineDiscount = getDiscountAmount(subtotal, discount);
                  return (
                    <tr key={line.id}>
                      <td>{line.description}</td>
                      <td>
                        {checkoutState.mode === "bill_replacement" && line.type === "inventory_item" ? (
                          <NumericInput
                            value={line.quantity}
                            min={1}
                            defaultValue={1}
                            onValueChange={(value) => updateReplacementLineQuantity(line.id, value)}
                          />
                        ) : (
                          line.quantity
                        )}
                      </td>
                      <td>{currency(line.unitPrice)}</td>
                      <td>
                        {isLtpAutoDiscount ? (
                          <div className="muted">Auto LTP discount</div>
                        ) : (
                          <div className="discount-grid">
                            <select
                              value={discount?.type ?? "amount"}
                              onChange={(event) =>
                                setCheckoutState((p) =>
                                  p
                                    ? {
                                        ...p,
                                        lineDiscounts: {
                                          ...p.lineDiscounts,
                                          [line.id]: {
                                            type: event.target.value as DiscountType,
                                            value: p.lineDiscounts[line.id]?.value ?? 0,
                                            reason: p.lineDiscounts[line.id]?.reason ?? ""
                                          }
                                        }
                                      }
                                    : p
                                )
                              }
                            >
                              <option value="amount">Amount</option>
                              <option value="percentage">%</option>
                            </select>
                            <NumericInput
                              mode="decimal"
                              min={0}
                              value={discount?.value ?? 0}
                              onValueChange={(value) =>
                                setCheckoutState((p) =>
                                  p
                                    ? {
                                        ...p,
                                        lineDiscounts: {
                                          ...p.lineDiscounts,
                                          [line.id]: {
                                            type: p.lineDiscounts[line.id]?.type ?? "amount",
                                            value,
                                            reason: p.lineDiscounts[line.id]?.reason ?? ""
                                          }
                                        }
                                      }
                                    : p
                                )
                              }
                            />
                          </div>
                        )}
                      </td>
                      <td>
                        {isLtpAutoDiscount ? (
                          <input value="LTP win - game charge waived" disabled />
                        ) : (
                          <input
                            value={discount?.reason ?? ""}
                            placeholder="required if used"
                            onChange={(event) =>
                              setCheckoutState((p) =>
                                p
                                  ? {
                                      ...p,
                                      lineDiscounts: {
                                        ...p.lineDiscounts,
                                        [line.id]: {
                                          type: p.lineDiscounts[line.id]?.type ?? "amount",
                                          value: p.lineDiscounts[line.id]?.value ?? 0,
                                          reason: event.target.value
                                        }
                                      }
                                    }
                                  : p
                              )
                            }
                          />
                        )}
                      </td>
                      <td><strong>{currency(subtotal - lineDiscount)}</strong></td>
                      {checkoutState.mode === "bill_replacement" && (
                        <td>
                          {line.type === "inventory_item" ? (
                            <button className="ghost-button danger" type="button" onClick={() => removeReplacementLine(line.id)}>
                              Remove
                            </button>
                          ) : (
                            <span className="muted">Fixed</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form-grid three-columns">
            <label><span>Bill Discount Type</span><select value={checkoutState.billDiscount?.type ?? "amount"} onChange={(event) => setCheckoutState((p) => p ? { ...p, billDiscount: { type: event.target.value as DiscountType, value: p.billDiscount?.value ?? 0, reason: p.billDiscount?.reason ?? "" } } : p)}><option value="amount">Amount</option><option value="percentage">%</option></select></label>
            <label><span>Bill Discount Value</span><NumericInput mode="decimal" min={0} value={checkoutState.billDiscount?.value ?? 0} onValueChange={(value) => setCheckoutState((p) => p ? { ...p, billDiscount: { type: p.billDiscount?.type ?? "amount", value, reason: p.billDiscount?.reason ?? "" } } : p)} /></label>
            <label><span>Bill Discount Reason</span><input value={checkoutState.billDiscount?.reason ?? ""} onChange={(event) => setCheckoutState((p) => p ? { ...p, billDiscount: { type: p.billDiscount?.type ?? "amount", value: p.billDiscount?.value ?? 0, reason: event.target.value } } : p)} /></label>
          </div>
          <div className="checkout-summary">
            <div><span className="muted">Subtotal</span><strong>{currency(checkoutPreview.subtotal)}</strong></div>
            <div><span className="muted">Line Discounts</span><strong>{currency(checkoutPreview.lineDiscountAmount)}</strong></div>
            <div><span className="muted">Bill Discount</span><strong>{currency(checkoutPreview.billDiscountAmount)}</strong></div>
            <div><span className="muted">Round Off</span><strong>{currency(checkoutPreview.roundOffAmount)}</strong></div>
            <div><span className="muted">Total Due</span><strong>{currency(checkoutPreview.total)}</strong></div>
          </div>
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => { setCheckoutState(null); setReplacementItemForm({ itemId: "", quantity: 1 }); }}>Cancel</button>
            <button className="primary-button" type="button" onClick={finalizeCheckout} disabled={remoteSaving}>{checkoutState.mode === "bill_replacement" ? "Issue Replacement Bill" : "Issue Bill"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LoginScreen(props: { loginUsername: string; loginPassword: string; loginError: string; onUsernameChange: (value: string) => void; onPasswordChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; }) {
  return (
    <div className="login-page">
      <div className="login-card login-layout">
        <section className="login-hero-panel">
          <div className="login-logo-shell">
            <div className="login-logo-frame">
              <img src={brandLogo} alt="BreakPerfect logo" />
            </div>
          </div>
          <div className="login-hero-copy">
            <div className="eyebrow">BreakPerfect Gaming Lounge</div>
            <h1>Game Parlour Management System</h1>
            <p>Billing, live sessions, consumables, and owner visibility from one operational dashboard.</p>
            <div className="login-feature-list">
              <span>Live station control</span>
              <span>Session billing</span>
              <span>Inventory alerts</span>
            </div>
          </div>
        </section>

        <section className="login-form-panel">
          <div className="login-form-copy">
            <h2>Sign In</h2>
            <p>Use your assigned role credentials to access the parlour dashboard.</p>
          </div>
          <form className="form-grid" onSubmit={props.onSubmit}>
            <label>
              <span>Username</span>
              <input value={props.loginUsername} onChange={(event) => props.onUsernameChange(event.target.value)} />
            </label>
            <label>
              <span>Password</span>
              <input type="password" value={props.loginPassword} onChange={(event) => props.onPasswordChange(event.target.value)} />
            </label>
            {props.loginError && <div className="error-text field-span-full">{props.loginError}</div>}
            <button className="primary-button field-span-full" type="submit">Sign In</button>
          </form>
          <div className="credentials-panel">
            <strong>Seed accounts</strong>
            <div className="muted">admin / admin123</div>
            <div className="muted">manager / manager123</div>
            <div className="muted">reception / reception123</div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return <div className="metric-card"><span className="muted">{props.label}</span><strong>{props.value}</strong></div>;
}

function TodayMetricCard(props: { value: string; timeLabel: string; dateLabel: string }) {
  return (
    <div className="metric-card today-metric-card">
      <div className="today-metric-top">
        <span className="muted">Today</span>
        <span className="muted">{props.timeLabel}</span>
        <span className="muted">{props.dateLabel}</span>
      </div>
      <strong>{props.value}</strong>
    </div>
  );
}

function NumericInput(props: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  mode?: NumericInputMode;
  defaultValue?: number;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const mode = props.mode ?? "integer";
  const fallbackValue = props.defaultValue ?? props.min ?? 0;
  const [draftValue, setDraftValue] = useState(() => formatNumericDraft(props.value, mode));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setDraftValue(formatNumericDraft(props.value, mode));
    }
  }, [props.value, mode, isFocused]);

  function commitValue(nextDraft: string) {
    if (!nextDraft || nextDraft === ".") {
      const normalizedFallback = normalizeNumericValue(fallbackValue, mode, props.min);
      setDraftValue(formatNumericDraft(normalizedFallback, mode));
      props.onValueChange(normalizedFallback);
      return;
    }
    const normalizedValue = normalizeNumericValue(Number(nextDraft), mode, props.min);
    setDraftValue(formatNumericDraft(normalizedValue, mode));
    props.onValueChange(normalizedValue);
  }

  return (
    <input
      type="text"
      inputMode={mode === "decimal" ? "decimal" : "numeric"}
      value={draftValue}
      required={props.required}
      disabled={props.disabled}
      className={props.className}
      placeholder={props.placeholder}
      onFocus={() => {
        setIsFocused(true);
        if (draftValue === formatNumericDraft(fallbackValue, mode)) {
          setDraftValue("");
        }
      }}
      onChange={(event) => {
        const sanitizedValue = sanitizeNumericDraft(event.target.value, mode);
        setDraftValue(sanitizedValue);
        if (sanitizedValue && sanitizedValue !== ".") {
          props.onValueChange(normalizeNumericValue(Number(sanitizedValue), mode, props.min));
        }
      }}
      onBlur={() => {
        setIsFocused(false);
        commitValue(draftValue);
      }}
    />
  );
}

function sanitizeNumericDraft(value: string, mode: NumericInputMode) {
  if (mode === "integer") {
    return value.replace(/[^\d]/g, "");
  }
  const stripped = value.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const parts = stripped.split(".");
  if (parts.length <= 1) {
    return stripped;
  }
  return `${parts[0]}.${parts.slice(1).join("")}`;
}

function normalizeNumericValue(value: number, mode: NumericInputMode, min?: number) {
  if (!Number.isFinite(value)) {
    return min ?? 0;
  }
  const clampedValue = Math.max(min ?? 0, value);
  if (mode === "integer") {
    return Math.trunc(clampedValue);
  }
  return Math.round(clampedValue * 100) / 100;
}

function formatNumericDraft(value: number, mode: NumericInputMode) {
  return mode === "decimal" ? `${value}` : `${Math.trunc(value)}`;
}

function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onClick={props.onClose}><div className={`modal-card ${props.wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.title} onClick={(event) => event.stopPropagation()}><div className="modal-header"><h2>{props.title}</h2><button className="ghost-button" type="button" onClick={props.onClose}>Close</button></div>{props.children}</div></div>;
}

