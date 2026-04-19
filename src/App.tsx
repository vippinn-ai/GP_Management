import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClock } from "./hooks/useClock";
import { useAppSync } from "./hooks/useAppSync";
import { Modal } from "./components/Modal";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { LoginScreen } from "./components/LoginScreen";
import { MetricCard, TodayMetricCard } from "./components/MetricCard";
import { NumericInput } from "./components/NumericInput";
import { CustomerAutocompleteFields } from "./components/CustomerAutocompleteFields";
import { UsersPanel } from "./panels/UsersPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { InventoryPanel } from "./panels/InventoryPanel";
import { CustomersPanel } from "./panels/CustomersPanel";
import { ReportsPanel } from "./panels/ReportsPanel";
import { SalePanel } from "./panels/SalePanel";
import { DashboardPanel } from "./panels/DashboardPanel";
import { BillRegisterPanel } from "./panels/BillRegisterPanel";
import brandLogo from "../Branding/Logo.png";
import {
  buildReceiptPreviewModel,
  downloadReceiptPdf,
  openReceiptWindow,
  type ReportRow
} from "./exporters";
import { calculateSessionCharge } from "./pricing";
import { loadAppData } from "./storage";
import {
  adminChangePasswordRemote,
  changeOwnPasswordRemote,
  adminCreateUserRemote,
  adminToggleUserActiveRemote,
  adminUpdateUserRemote,
  fetchCurrentProfile,
  isBackendConfigured,
  loadRemoteAppDataSnapshot,
  saveRemoteAppData,
  signInWithUsername,
  signOutRemote
} from "./backend";
import type {
  AppData,
  AppliedDiscount,
  Bill,
  BillPaymentMode,
  BusinessProfile,
  CheckoutState,
  Customer,
  CustomerTab,
  CustomerTabDraft,
  CustomerTabEditDraft,
  CustomerProfileEditDraft,
  DiscountType,
  DraftLineDiscountMap,
  InventoryItem,
  InventoryState,
  ExpenseTemplate,
  LtpOutcome,
  PaymentMode,
  PlayMode,
  ReportFilterState,
  Role,
  Session,
  SessionEditDraft,
  SessionItem,
  StartSessionDraft,
  Station,
  StationEditDraft,
  StockMovementType,
  TabId,
  User,
  UserEditDraft,
  UserPasswordDraft,
  SettlementDraft,
  VoidPendingDraft
} from "./types";
import { DEFAULT_INVENTORY_CATEGORIES, DEFAULT_EXPENSE_CATEGORIES, tabsByRole, ALL_TABS } from "./constants";
import {
  addAuditLog,
  buildBillPreview,
  clampNumber,
  cloneBillLinesForReplacement,
  cloneValue,
  createId,
  currency,
  findCustomerProfileMatch,
  formatAuditValue,
  formatBillNumber,
  formatDateTimeInputValue,
  formatDateTime,
  formatMinutes,
  formatTime,
  getCustomerTabCheckoutLines,
  getDiscountAmount,
  getInventoryQuantityMap,
  getMonthKeysInRange,
  getPreviousRange,
  getReportRange,
  getSessionCheckoutLines,
  isToday,
  normalizeAppDataCustomers,
  normalizeCustomerName,
  normalizeCustomerPhone,
  parseDateTimeInputValue,
  resolveCustomerProfile,
  sumBy,
  toBusinessDayKey,
  toLocalDateKey,
  toMinuteOfDay
} from "./utils";
import {
  buildCheckoutPaymentResult,
  computeSettlement,
  getSettlementAmount,
  validateCheckoutPayment
} from "./billing";

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `pbkdf2:${toB64(salt.buffer)}:${toB64(bits)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2:")) return password === stored; // backward compat: plaintext
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const salt = Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))) === parts[2];
}

export default function App() {
  const backendConfigured = isBackendConfigured();
  const [appData, setAppData] = useState<AppData>(() =>
    normalizeAppDataCustomers(loadAppData())
  );
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const now = useClock();
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(backendConfigured);
  const [remoteError, setRemoteError] = useState("");
  const [remoteVersion, setRemoteVersion] = useState(0);
  const [remoteSaving, setRemoteSaving] = useState(false);
  const [blockingActionLabel, setBlockingActionLabel] = useState<string | null>(null);
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
  const [customerProfileSearch, setCustomerProfileSearch] = useState("");
  const [customerProfileSort, setCustomerProfileSort] = useState<"last_visit" | "total_spend" | "visit_count">("last_visit");
  const [inventoryItemSearch, setInventoryItemSearch] = useState("");
  const [selectedCustomerTabId, setSelectedCustomerTabId] = useState<string | null>(null);
  const [selectedCustomerProfileId, setSelectedCustomerProfileId] = useState<string | null>(null);
  const [editSessionDraft, setEditSessionDraft] = useState<SessionEditDraft | null>(null);
  const [editCustomerTabDraft, setEditCustomerTabDraft] = useState<CustomerTabEditDraft | null>(null);
  const [editCustomerProfileDraft, setEditCustomerProfileDraft] = useState<CustomerProfileEditDraft | null>(null);
  const [customerTabDraft, setCustomerTabDraft] = useState<CustomerTabDraft>({
    customerName: "",
    customerPhone: ""
  });
  const [dashboardCustomerTabDraft, setDashboardCustomerTabDraft] = useState<CustomerTabDraft>({
    customerName: "",
    customerPhone: ""
  });
  const [replacementItemForm, setReplacementItemForm] = useState({ itemId: "", quantity: 1 });
  const [sessionItemForm, setSessionItemForm] = useState<Record<string, { itemId: string; quantity: number; sellAsPackOf?: number }>>({});
  const [selectedReceiptBillId, setSelectedReceiptBillId] = useState<string | null>(null);
  const receiptPreviewBlockRef = useRef<HTMLDivElement | null>(null);
  const [, setReceiptPreviewBlockHeight] = useState<number | null>(null);
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
  const [editItemForm, setEditItemForm] = useState<InventoryItem | null>(null);
  const [useCustomEditItemCategory, setUseCustomEditItemCategory] = useState(false);
  const [customEditItemCategory, setCustomEditItemCategory] = useState("");
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
  const [editStationDraft, setEditStationDraft] = useState<StationEditDraft | null>(null);
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
  const [passwordError, setPasswordError] = useState("");
  const [ownPasswordDraft, setOwnPasswordDraft] = useState<{ password: string; confirm: string } | null>(null);
  const [ownPasswordError, setOwnPasswordError] = useState("");
  const [settlementDraft, setSettlementDraft] = useState<SettlementDraft | null>(null);
  const [voidPendingDraft, setVoidPendingDraft] = useState<VoidPendingDraft | null>(null);
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
  const filteredInventoryItems = appData.inventoryItems.filter((item) =>
    `${item.name} ${item.category}`.toLowerCase().includes(inventoryItemSearch.trim().toLowerCase())
  );

  useAppSync({
    backendConfigured,
    activeUserId,
    appData,
    remoteLoading,
    remoteVersion,
    skipRemotePersistRef,
    remoteSaveTimerRef,
    setAppData,
    setActiveUserId,
    setRemoteVersion,
    setRemoteLoading,
    setRemoteError,
    setRemoteSaving,
    setActiveTab
  });

  async function refreshRemoteState(options?: { keepUser?: boolean }) {
    const snapshot = await loadRemoteAppDataSnapshot();
    skipRemotePersistRef.current = true;
    setAppData(normalizeAppDataCustomers(snapshot.appData));
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
      throw error;
    } finally {
      setRemoteSaving(false);
    }
  }

  useEffect(() => {
    setBusinessDraft(appData.businessProfile);
  }, [appData.businessProfile]);

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
  const visibleTabs = useMemo(() => {
    if (!activeUser) return [];
    const roleTabs = tabsByRole[activeUser.role];
    if (!activeUser.tabPermissions?.length) return roleTabs;
    const roleIds = new Set(roleTabs.map((t) => t.id));
    const extras = ALL_TABS.filter((t) => activeUser.tabPermissions!.includes(t.id) && !roleIds.has(t.id));
    return [...roleTabs, ...extras];
  }, [activeUser]);
  const canAccessTab = useCallback((tabId: TabId) => visibleTabs.some((tab) => tab.id === tabId), [visibleTabs]);
  const canEditInventory = activeUser?.role === "admin";
  const canEditReports = activeUser?.role === "admin";
  const canEditSettings = activeUser?.role === "admin";
  const canManageUsers = activeUser?.role === "admin";
  const canVoidRefundBills = activeUser?.role === "admin";
  const canReplaceIssuedBills = activeUser?.role === "admin";
  const canSettlePendingBills = activeUser?.role === "admin" || activeUser?.role === "manager" || activeUser?.role === "receptionist";
  const canEditActiveSessionDetails = activeUser?.role === "admin";
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
  // Revenue is attributed to the business day of the session/tab start time,
  // not the bill issue time. Bills issued after midnight (before 7 AM) belong
  // to the previous business day.
  function getBillBusinessDate(bill: Bill): string {
    const session = bill.sessionId ? appData.sessions.find((s) => s.id === bill.sessionId) : undefined;
    if (session) return toBusinessDayKey(session.startedAt);
    const tab = appData.customerTabs.find((t) => t.closedBillId === bill.id);
    if (tab) return toBusinessDayKey(tab.createdAt);
    return toBusinessDayKey(bill.issuedAt);
  }
  const resolvedReportRange = getReportRange(reportFilter, now);
  const reportFromDate = resolvedReportRange.from <= resolvedReportRange.to ? resolvedReportRange.from : resolvedReportRange.to;
  const reportToDate = resolvedReportRange.from <= resolvedReportRange.to ? resolvedReportRange.to : resolvedReportRange.from;
  const filteredBills = appData.bills.filter((bill) => {
    const billDate = getBillBusinessDate(bill);
    return billDate >= reportFromDate && billDate <= reportToDate;
  });
  // Precomputed map used by BillRegisterPanel for its own date filters.
  const billBusinessDates: Record<string, string> = {};
  for (const bill of appData.bills) {
    billBusinessDates[bill.id] = getBillBusinessDate(bill);
  }
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
  const activeFinancialBills = appData.bills.filter((bill) => bill.status === "issued" || bill.status === "pending");

  const customerAnalytics = (() => {
    const statsMap = new Map<
      string,
      {
        customer: Customer;
        bills: Bill[];
        totalSpend: number;
        visitCount: number;
        lastVisitAt: string;
        favoriteStationName?: string;
      }
    >();
    const stationTotals = new Map<string, { name: string; count: number }>();
    const hourTotals = new Map<number, number>();
    const weekdayTotals = new Map<number, number>();

    function getBillVisitAt(bill: Bill) {
      const linkedSession = bill.sessionId
        ? appData.sessions.find((session) => session.id === bill.sessionId)
        : undefined;
      if (linkedSession?.startedAt) {
        return linkedSession.startedAt;
      }
      const linkedTab = appData.customerTabs.find((tab) => tab.closedBillId === bill.id);
      if (linkedTab?.createdAt) {
        return linkedTab.createdAt;
      }
      return bill.issuedAt;
    }

    for (const customer of appData.customers) {
      statsMap.set(customer.id, {
        customer,
        bills: [],
        totalSpend: 0,
        visitCount: 0,
        lastVisitAt: customer.lastVisitAt,
        favoriteStationName: undefined
      });
    }

    for (const bill of activeFinancialBills) {
      if (!bill.customerId) {
        continue;
      }
      const customer = appData.customers.find((entry) => entry.id === bill.customerId);
      if (!customer) {
        continue;
      }
      const visitAt = getBillVisitAt(bill);
      const current =
        statsMap.get(customer.id) ??
        {
          customer,
          bills: [],
          totalSpend: 0,
          visitCount: 0,
          lastVisitAt: visitAt,
          favoriteStationName: undefined
        };
      current.bills.push(bill);
      current.totalSpend += bill.amountPaid;
      current.visitCount += 1;
      if (new Date(visitAt).getTime() > new Date(current.lastVisitAt).getTime()) {
        current.lastVisitAt = visitAt;
      }
      if (bill.stationId) {
        const stationName =
          appData.stations.find((station) => station.id === bill.stationId)?.name ??
          "Unknown station";
        const existingStation = stationTotals.get(stationName) ?? { name: stationName, count: 0 };
        existingStation.count += 1;
        stationTotals.set(stationName, existingStation);
      }
      const visitDate = new Date(visitAt);
      hourTotals.set(visitDate.getHours(), (hourTotals.get(visitDate.getHours()) ?? 0) + 1);
      weekdayTotals.set(visitDate.getDay(), (weekdayTotals.get(visitDate.getDay()) ?? 0) + 1);
      statsMap.set(customer.id, current);
    }

    for (const stats of statsMap.values()) {
      const stationCounts = new Map<string, number>();
      for (const bill of stats.bills) {
        const stationName =
          (bill.stationId && appData.stations.find((station) => station.id === bill.stationId)?.name) ||
          "Consumables Tab";
        stationCounts.set(stationName, (stationCounts.get(stationName) ?? 0) + 1);
      }
      stats.favoriteStationName = Array.from(stationCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
    }

    const stats = Array.from(statsMap.values()).sort(
      (left, right) => new Date(right.lastVisitAt).getTime() - new Date(left.lastVisitAt).getTime()
    );
    const repeatCustomers = stats.filter((entry) => entry.visitCount > 1);
    const totalSpend = sumBy(stats, (entry) => entry.totalSpend);
    const nowDate = new Date(now);
    const thirtyDaysAgo = new Date(nowDate);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const topSpend = [...stats].filter((entry) => entry.totalSpend > 0).sort((left, right) => right.totalSpend - left.totalSpend)[0];
    const topVisits = [...stats].filter((entry) => entry.visitCount > 0).sort((left, right) => right.visitCount - left.visitCount)[0];
    const recentHighValueCustomers = [...stats]
      .filter((entry) => entry.totalSpend > 0)
      .sort((left, right) => right.totalSpend - left.totalSpend)
      .slice(0, 5);
    const atRiskCustomers = stats.filter(
      (entry) => entry.visitCount > 1 && new Date(entry.lastVisitAt).getTime() < thirtyDaysAgo.getTime()
    );
    const peakHourEntry = Array.from(hourTotals.entries()).sort((left, right) => right[1] - left[1])[0];
    const peakWeekdayEntry = Array.from(weekdayTotals.entries()).sort((left, right) => right[1] - left[1])[0];
    const mostPlayedStation = Array.from(stationTotals.values()).sort((left, right) => right.count - left.count)[0];

    return {
      stats,
      topSpend,
      topVisits,
      totalProfiles: appData.customers.length,
      repeatCustomersCount: repeatCustomers.length,
      repeatRate: stats.length ? (repeatCustomers.length / stats.length) * 100 : 0,
      averageSpendPerCustomer: appData.customers.length ? totalSpend / appData.customers.length : 0,
      oneTimeCustomersCount: stats.filter((entry) => entry.visitCount === 1).length,
      activeCustomersCount: stats.filter(
        (entry) => new Date(entry.lastVisitAt).getTime() >= thirtyDaysAgo.getTime()
      ).length,
      mostPlayedStation: mostPlayedStation?.name,
      peakHourLabel:
        peakHourEntry !== undefined
          ? new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(
              new Date(2026, 0, 1, peakHourEntry[0], 0, 0)
            )
          : "No data",
      peakWeekdayLabel:
        peakWeekdayEntry !== undefined
          ? new Intl.DateTimeFormat("en-IN", { weekday: "long" }).format(new Date(2026, 0, 4 + peakWeekdayEntry[0]))
          : "No data",
      recentHighValueCustomers,
      atRiskCustomers
    };
  })();
  const selectedCustomerProfile =
    (selectedCustomerProfileId
      ? appData.customers.find((customer) => customer.id === selectedCustomerProfileId)
      : undefined) ??
    customerAnalytics.stats[0]?.customer ??
    null;
  const selectedCustomerProfileStats =
    (selectedCustomerProfile
      ? customerAnalytics.stats.find((entry) => entry.customer.id === selectedCustomerProfile.id)
      : undefined) ?? null;
  const filteredCustomerProfiles = [...customerAnalytics.stats]
    .filter((entry) => {
      const searchValue = customerProfileSearch.trim().toLowerCase();
      if (!searchValue) {
        return true;
      }
      return (
        entry.customer.name.toLowerCase().includes(searchValue) ||
        (entry.customer.phone ?? "").toLowerCase().includes(searchValue)
      );
    })
    .sort((left, right) => {
      if (customerProfileSort === "total_spend") {
        return right.totalSpend - left.totalSpend;
      }
      if (customerProfileSort === "visit_count") {
        return right.visitCount - left.visitCount;
      }
      return new Date(right.lastVisitAt).getTime() - new Date(left.lastVisitAt).getTime();
    });

  useEffect(() => {
    if (selectedCustomerTabId && !openCustomerTabs.some((tab) => tab.id === selectedCustomerTabId)) {
      setSelectedCustomerTabId(openCustomerTabs[0]?.id ?? null);
    }
    if (!selectedCustomerTabId && openCustomerTabs[0]) {
      setSelectedCustomerTabId(openCustomerTabs[0].id);
    }
  }, [openCustomerTabs, selectedCustomerTabId]);

  useEffect(() => {
    if (selectedCustomerProfileId && !appData.customers.some((customer) => customer.id === selectedCustomerProfileId)) {
      setSelectedCustomerProfileId(customerAnalytics.stats[0]?.customer.id ?? null);
      return;
    }
    if (!selectedCustomerProfileId && customerAnalytics.stats[0]) {
      setSelectedCustomerProfileId(customerAnalytics.stats[0].customer.id);
    }
  }, [appData.customers, customerAnalytics.stats, selectedCustomerProfileId]);

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

  async function runBlockingAction<T>(label: string, action: () => Promise<T>) {
    setBlockingActionLabel(label);
    try {
      return await action();
    } finally {
      setBlockingActionLabel(null);
    }
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
      customerId: undefined,
      customerName: "",
      customerPhone: "",
      playMode: station?.ltpEnabled ? "solo" : "group",
      arcadeItemId: station?.mode === "unit_sale" ? defaultArcadeInventoryItem?.id ?? "" : "",
      arcadeQuantity: 1
    };
  }

  function getFrozenEndAtForSession(sessionId: string) {
    return checkoutState?.mode === "session" && checkoutState.sessionId === sessionId
      ? checkoutState.sessionEndedAt ?? checkoutState.closedAt ?? now
      : now;
  }

  function getCheckoutSessionPreview(session: Session, state: CheckoutState) {
    return {
      ...session,
      startedAt: state.sessionStartedAt ?? session.startedAt,
      endedAt: state.sessionEndedAt ?? state.closedAt ?? session.endedAt
    };
  }

  function getSessionReservedQuantity(itemId: string, ignoreSessionId?: string) {
    return sumBy(
      appData.sessions.filter((session) => session.status !== "closed" && session.id !== ignoreSessionId),
      (session) => sumBy(
        session.items.filter((item) => item.inventoryItemId === itemId),
        (item) => item.soldAsPackOf ? item.quantity * item.soldAsPackOf : item.quantity
      )
    );
  }

  function getCustomerTabReservedQuantity(itemId: string, ignoreCustomerTabId?: string) {
    return sumBy(
      appData.customerTabs.filter((tab) => tab.status === "open" && tab.id !== ignoreCustomerTabId),
      (tab) => sumBy(
        tab.items.filter((item) => item.inventoryItemId === itemId),
        (item) => item.soldAsPackOf ? item.quantity * item.soldAsPackOf : item.quantity
      )
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

  function getCustomerById(customerId?: string) {
    return customerId ? appData.customers.find((customer) => customer.id === customerId) : undefined;
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

  function closeEditInventoryModal() {
    setEditItemForm(null);
    setUseCustomEditItemCategory(false);
    setCustomEditItemCategory("");
  }

  function beginEditInventoryItem(item: InventoryItem) {
    setEditItemForm({
      ...item,
      barcode: item.barcode ?? ""
    });
    const isKnownCategory = inventoryCategoryOptions.includes(item.category);
    setUseCustomEditItemCategory(!isKnownCategory);
    setCustomEditItemCategory(isKnownCategory ? "" : item.category);
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
    if (item.cigarettePack) {
      const packs = Math.floor(available / item.cigarettePack.size);
      const loose = available % item.cigarettePack.size;
      return `${available} left (~${packs} pack${packs !== 1 ? "s" : ""}${loose > 0 ? ` + ${loose}` : ""})`;
    }
    return `Available ${available}`;
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUsername = loginUsername.trim();
    if (!trimmedUsername) { setLoginError("Username is required."); return; }
    if (!loginPassword.trim()) { setLoginError("Password is required."); return; }
    if (trimmedUsername.length > 64) { setLoginError("Username is too long."); return; }
    if (backendConfigured) {
      void runBlockingAction("Signing in...", async () => {
        setRemoteLoading(true);
        const profile = await signInWithUsername(loginUsername, loginPassword);
          const snapshot = await loadRemoteAppDataSnapshot();
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(snapshot.appData));
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
    const candidate = appData.users.find(
      (user) => user.active && user.username.toLowerCase() === loginUsername.trim().toLowerCase()
    );
    void (async () => {
      const matched = candidate && (await verifyPassword(loginPassword, candidate.password ?? "")) ? candidate : null;
      if (!matched) {
        setLoginError("Invalid username or password.");
        return;
      }
      setLoginError("");
      setActiveUserId(matched.id);
      setActiveTab("dashboard");
    })();
  }

  function handleChangeOwnPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ownPasswordDraft) return;
    if (ownPasswordDraft.password.length < 8) {
      setOwnPasswordError("Password must be at least 8 characters.");
      return;
    }
    if (ownPasswordDraft.password !== ownPasswordDraft.confirm) {
      setOwnPasswordError("Passwords do not match.");
      return;
    }
    setOwnPasswordError("");
    if (backendConfigured) {
      void runBlockingAction("Updating password...", async () => {
        await changeOwnPasswordRemote(ownPasswordDraft.password);
        setOwnPasswordDraft(null);
      }).catch((error: unknown) => {
        setOwnPasswordError(error instanceof Error ? error.message : "Unable to update password.");
      });
    } else {
      void (async () => {
        if (!activeUser) return;
        const hashed = await hashPassword(ownPasswordDraft.password);
        mutateAppData((data) => {
          const user = data.users.find((u) => u.id === activeUser.id);
          if (user) user.password = hashed;
        });
        setOwnPasswordDraft(null);
      })();
    }
  }

  function handleLogout() {
    if (backendConfigured) {
      void runBlockingAction("Signing out...", async () => {
        await signOutRemote();
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
      const customerId = resolveCustomerProfile(
        draft,
        startSessionDraft.customerName,
        startSessionDraft.customerPhone
      );
      draft.sessions.unshift({
        id: createId("session"),
        stationId: station.id,
        stationNameSnapshot: station.name,
        mode: station.mode,
        startedAt: new Date().toISOString(),
        status: "active",
        customerId,
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
    const packOf = form.sellAsPackOf;
    const stockNeeded = packOf ? form.quantity * packOf : form.quantity;
    if (!item || getAvailableStock(item, sessionId) < stockNeeded) {
      if (packOf && item && getAvailableStock(item, sessionId) < stockNeeded) {
        window.alert(`Cannot sell as pack — only ${getAvailableStock(item, sessionId)} cigarettes in stock (need ${stockNeeded} for ${form.quantity} pack${form.quantity !== 1 ? "s" : ""}). Please restock first or sell as singles.`);
      } else {
        window.alert(item?.isReusable ? `${item.name} is currently occupied.` : "Not enough stock available for that item.");
      }
      return;
    }
    mutateAppData((draft) => {
      const session = draft.sessions.find((entry) => entry.id === sessionId);
      if (!session) return;
      session.items.push({
        id: createId("session-item"),
        inventoryItemId: item.id,
        name: item.name,
        quantity: clampNumber(form.quantity, 1),
        unitPrice: packOf ? item.cigarettePack!.packPrice : item.price,
        soldAsPackOf: packOf,
        addedAt: new Date().toISOString()
      });
      addAuditLog(draft, activeUser.id, "session_item_added", "session", sessionId, `Added ${item.name}${packOf ? " (pack)" : ""} to ${session.stationNameSnapshot}.`);
    });
    setSessionItemForm((previous) => ({
      ...previous,
      [sessionId]: { itemId: form.itemId, quantity: 1, sellAsPackOf: packOf }
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

  function beginEditSessionDetails(session: Session) {
    if (!canEditActiveSessionDetails) {
      return;
    }
    setEditSessionDraft({
      sessionId: session.id,
      customerId: session.customerId,
      customerName: session.customerName ?? "",
      customerPhone: session.customerPhone ?? "",
      startedAt: formatDateTimeInputValue(session.startedAt)
    });
  }

  function saveSessionDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditActiveSessionDetails || !editSessionDraft) {
      return;
    }
    const sourceSession = getSessionById(editSessionDraft.sessionId);
    if (!sourceSession || sourceSession.status === "closed") {
      return;
    }
    const nextStartedAt = parseDateTimeInputValue(editSessionDraft.startedAt);
    if (sourceSession.mode === "timed" && !nextStartedAt) {
      window.alert("Start time is required.");
      return;
    }
    if (sourceSession.mode === "timed" && new Date(nextStartedAt).getTime() > new Date(now).getTime()) {
      window.alert("Start time cannot be in the future.");
      return;
    }
    mutateAppData((draft) => {
      const session = draft.sessions.find((entry) => entry.id === editSessionDraft.sessionId && entry.status !== "closed");
      if (!session) {
        return;
      }
      const nextCustomerName = editSessionDraft.customerName.trim() || undefined;
      const nextCustomerPhone = editSessionDraft.customerPhone.trim() || undefined;
      const customerId = resolveCustomerProfile(draft, nextCustomerName, nextCustomerPhone, session.startedAt);
      const changes: string[] = [];
      if ((session.customerName ?? "") !== (nextCustomerName ?? "")) {
        changes.push(`customer name: ${formatAuditValue(session.customerName)} -> ${formatAuditValue(nextCustomerName)}`);
      }
      if ((session.customerPhone ?? "") !== (nextCustomerPhone ?? "")) {
        changes.push(`customer phone: ${formatAuditValue(session.customerPhone)} -> ${formatAuditValue(nextCustomerPhone)}`);
      }
      session.customerId = customerId;
      session.customerName = nextCustomerName;
      session.customerPhone = nextCustomerPhone;
      if (session.mode === "timed" && nextStartedAt && session.startedAt !== nextStartedAt) {
        changes.push(`start time: ${formatDateTime(session.startedAt)} -> ${formatDateTime(nextStartedAt)}`);
        session.startedAt = nextStartedAt;
      }
      if (changes.length > 0) {
        addAuditLog(draft, activeUser.id, "session_details_updated", "session", session.id, `Updated ${session.stationNameSnapshot}: ${changes.join("; ")}`);
      }
    });
    setEditSessionDraft(null);
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
      sessionStartedAt: session.startedAt,
      sessionEndedAt: closedAt,
      customerId: session.customerId,
      customerName: session.customerName || "",
      customerPhone: session.customerPhone || "",
      paymentMode: "cash",
      splitCashAmount: 0,
      splitUpiAmount: 0,
      collectAmount: 0,
      collectMode: "cash" as const,
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
    const matchingCustomer = draftValue.customerId
      ? getCustomerById(draftValue.customerId)
      : findCustomerProfileMatch(appData, customerName, customerPhone);
    const existing = appData.customerTabs.find(
      (tab) =>
        tab.status === "open" &&
        ((matchingCustomer && tab.customerId === matchingCustomer.id) ||
          tab.customerName.trim().toLowerCase() === customerName.toLowerCase() ||
          (customerPhone && tab.customerPhone?.trim() === customerPhone))
    );
    if (existing) {
      setSelectedCustomerTabId(existing.id);
      if (options?.updateSaleDraft) {
        setCustomerTabDraft({
          customerId: existing.customerId,
          customerName: existing.customerName,
          customerPhone: existing.customerPhone ?? ""
        });
      }
      if (options?.clearDraft) {
        setDashboardCustomerTabDraft({ customerId: undefined, customerName: "", customerPhone: "" });
      }
      if (options?.switchToSale) {
        setActiveTab("sale");
      }
      return;
    }

    const tabId = createId("customer-tab");
    let resolvedCustomerId = matchingCustomer?.id;
    mutateAppData((draft) => {
      const customerId = resolveCustomerProfile(draft, customerName, customerPhone);
      resolvedCustomerId = customerId;
      draft.customerTabs.unshift({
        id: tabId,
        customerId,
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
      setCustomerTabDraft({ customerId: resolvedCustomerId, customerName, customerPhone });
    }
    if (options?.clearDraft) {
      setDashboardCustomerTabDraft({ customerId: undefined, customerName: "", customerPhone: "" });
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

  function beginEditCustomerTabDetails(tab: CustomerTab) {
    if (!canEditActiveSessionDetails || tab.status !== "open") {
      return;
    }
    setEditCustomerTabDraft({
      customerTabId: tab.id,
      customerId: tab.customerId,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? ""
    });
  }

  function saveCustomerTabDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditActiveSessionDetails || !editCustomerTabDraft) {
      return;
    }
    const nextCustomerName = editCustomerTabDraft.customerName.trim();
    if (!nextCustomerName) {
      window.alert("Customer name is required.");
      return;
    }
    const nextCustomerPhone = editCustomerTabDraft.customerPhone.trim() || undefined;
    let resolvedCustomerId = editCustomerTabDraft.customerId;
    mutateAppData((draft) => {
      const tab = draft.customerTabs.find((entry) => entry.id === editCustomerTabDraft.customerTabId && entry.status === "open");
      if (!tab) {
        return;
      }
      const customerId = resolveCustomerProfile(draft, nextCustomerName, nextCustomerPhone, tab.createdAt);
      resolvedCustomerId = customerId;
      const changes: string[] = [];
      if (tab.customerName !== nextCustomerName) {
        changes.push(`customer name: ${formatAuditValue(tab.customerName)} -> ${formatAuditValue(nextCustomerName)}`);
      }
      if ((tab.customerPhone ?? "") !== (nextCustomerPhone ?? "")) {
        changes.push(`customer phone: ${formatAuditValue(tab.customerPhone)} -> ${formatAuditValue(nextCustomerPhone)}`);
      }
      tab.customerId = customerId;
      tab.customerName = nextCustomerName;
      tab.customerPhone = nextCustomerPhone;
      if (changes.length > 0) {
        addAuditLog(draft, activeUser.id, "customer_tab_details_updated", "customer_tab", tab.id, `Updated customer tab: ${changes.join("; ")}`);
      }
    });
    setCustomerTabDraft({
      customerId: resolvedCustomerId,
      customerName: nextCustomerName,
      customerPhone: nextCustomerPhone ?? ""
    });
    setEditCustomerTabDraft(null);
  }

  function beginEditCustomerProfile(customer: Customer) {
    if (!canManageUsers) {
      return;
    }
    setEditCustomerProfileDraft({
      customerId: customer.id,
      name: customer.name,
      phone: customer.phone ?? ""
    });
  }

  function saveCustomerProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canManageUsers || !editCustomerProfileDraft) {
      return;
    }
    const nextName = editCustomerProfileDraft.name.trim();
    const nextPhone = editCustomerProfileDraft.phone.trim();
    if (!nextName) {
      window.alert("Customer name is required.");
      return;
    }
    const duplicate = appData.customers.find((customer) => {
      if (customer.id === editCustomerProfileDraft.customerId) {
        return false;
      }
      const samePhone = nextPhone && normalizeCustomerPhone(customer.phone) === normalizeCustomerPhone(nextPhone);
      const sameNameOnly =
        !nextPhone &&
        !normalizeCustomerPhone(customer.phone) &&
        normalizeCustomerName(customer.name) === normalizeCustomerName(nextName);
      return samePhone || sameNameOnly;
    });
    if (duplicate) {
      window.alert("Another customer profile already uses the same phone or name.");
      return;
    }
    mutateAppData((draft) => {
      const customer = draft.customers.find((entry) => entry.id === editCustomerProfileDraft.customerId);
      if (!customer) {
        return;
      }
      const previousName = customer.name;
      const previousPhone = customer.phone;
      customer.name = nextName;
      customer.phone = nextPhone || undefined;
      for (const session of draft.sessions) {
        if (session.customerId === customer.id) {
          session.customerName = nextName;
          session.customerPhone = nextPhone || undefined;
        }
      }
      for (const tab of draft.customerTabs) {
        if (tab.customerId === customer.id) {
          tab.customerName = nextName;
          tab.customerPhone = nextPhone || undefined;
        }
      }
      for (const bill of draft.bills) {
        if (bill.customerId === customer.id) {
          bill.customerName = nextName;
          bill.customerPhone = nextPhone || undefined;
        }
      }
      addAuditLog(
        draft,
        activeUser.id,
        "customer_profile_updated",
        "customer",
        customer.id,
        `Updated customer profile: name ${formatAuditValue(previousName)} -> ${formatAuditValue(nextName)}; phone ${formatAuditValue(previousPhone)} -> ${formatAuditValue(nextPhone)}`
      );
    });
    setEditCustomerProfileDraft(null);
  }

  function addItemToCustomerTab(item: InventoryItem, sellAsPackOf?: number) {
    if (!activeUser || !selectedCustomerTab) {
      window.alert("Open or select a customer tab first.");
      return;
    }
    const stockNeeded = sellAsPackOf ?? 1;
    if (getAvailableStock(item) < stockNeeded) {
      if (sellAsPackOf) {
        window.alert(`Cannot sell as pack — only ${getAvailableStock(item)} cigarettes in stock (need ${sellAsPackOf} for 1 pack). Please restock first or sell as singles.`);
      } else {
        window.alert(item.isReusable ? `${item.name} is currently occupied.` : "That item is out of stock.");
      }
      return;
    }
    mutateAppData((draft) => {
      const tab = draft.customerTabs.find((entry) => entry.id === selectedCustomerTab.id && entry.status === "open");
      if (!tab) return;
      const existing = tab.items.find((entry) => entry.inventoryItemId === item.id && entry.soldAsPackOf === sellAsPackOf);
      if (existing) {
        existing.quantity += 1;
      } else {
        tab.items.push({
          id: createId("customer-tab-item"),
          inventoryItemId: item.id,
          name: item.name,
          quantity: 1,
          unitPrice: sellAsPackOf ? item.cigarettePack!.packPrice : item.price,
          soldAsPackOf: sellAsPackOf,
          addedAt: new Date().toISOString()
        });
      }
      addAuditLog(draft, activeUser.id, "customer_tab_item_added", "customer_tab", tab.id, `Added ${item.name}${sellAsPackOf ? " (pack)" : ""} to ${tab.customerName}'s tab.`);
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
      customerId: selectedCustomerTab.customerId,
      customerName: selectedCustomerTab.customerName,
      customerPhone: selectedCustomerTab.customerPhone ?? "",
      paymentMode: "cash",
      splitCashAmount: 0,
      splitUpiAmount: 0,
      collectAmount: 0,
      collectMode: "cash" as const,
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
      customerId: tab.customerId,
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
      customerId: tab.customerId,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? ""
    });
    setCheckoutState({
      mode: "customer_tab",
      customerTabId: tab.id,
      customerId: tab.customerId,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? "",
      paymentMode: "cash",
      splitCashAmount: 0,
      splitUpiAmount: 0,
      collectAmount: 0,
      collectMode: "cash" as const,
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
      customerId: bill.customerId,
      customerName: bill.customerName ?? "",
      customerPhone: bill.customerPhone ?? "",
      paymentMode: bill.paymentMode,
      splitCashAmount: 0,
      splitUpiAmount: 0,
      collectAmount: 0,
      collectMode: "cash" as const,
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
          setAppData(normalizeAppDataCustomers(baseAppData));
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
          setAppData(normalizeAppDataCustomers(baseAppData));
          setCheckoutState(null);
          window.alert("This consumables tab was already closed from another browser. Latest data has been loaded.");
          return;
        }
      }
      if (checkoutState.mode === "bill_replacement" && checkoutState.replacementBillId) {
        const remoteBill = baseAppData.bills.find((entry) => entry.id === checkoutState.replacementBillId);
        if (!remoteBill || remoteBill.status !== "issued") {
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(baseAppData));
          setCheckoutState(null);
          window.alert("This bill was already changed from another browser. Latest data has been loaded.");
          return;
        }
      }
      skipRemotePersistRef.current = true;
      setAppData(normalizeAppDataCustomers(baseAppData));
    }
    function getAvailableStockFromData(
      data: AppData,
      item: InventoryItem,
      ignoreSessionId?: string,
      ignoreCustomerTabId?: string
    ) {
      const sessionReserved = sumBy(
        data.sessions.filter((entry) => entry.status !== "closed" && entry.id !== ignoreSessionId),
        (entry) => sumBy(entry.items.filter((line) => line.inventoryItemId === item.id), (line) => line.soldAsPackOf ? line.quantity * line.soldAsPackOf : line.quantity)
      );
      const tabReserved = item.isReusable
        ? sumBy(
            data.customerTabs.filter((entry) => entry.status === "open" && entry.id !== ignoreCustomerTabId),
            (entry) => sumBy(entry.items.filter((line) => line.inventoryItemId === item.id), (line) => line.soldAsPackOf ? line.quantity * line.soldAsPackOf : line.quantity)
          )
        : 0;
      return Math.max(0, item.stockQty - sessionReserved - tabReserved);
    }
    const issuedAt = new Date().toISOString();
    const effectiveClosedAt =
      checkoutState.mode === "session" ? checkoutState.sessionEndedAt ?? checkoutState.closedAt ?? issuedAt : issuedAt;
    const session =
      checkoutState.mode === "session" && checkoutState.sessionId
        ? baseAppData.sessions.find((entry) => entry.id === checkoutState.sessionId)
        : undefined;
    const previewSession =
      checkoutState.mode === "session" && session
        ? getCheckoutSessionPreview(session, checkoutState)
        : session;
    const customerTab =
      checkoutState.mode === "customer_tab" && checkoutState.customerTabId
        ? baseAppData.customerTabs.find((entry) => entry.id === checkoutState.customerTabId)
        : undefined;
    const replacementBill =
      checkoutState.mode === "bill_replacement" && checkoutState.replacementBillId
        ? baseAppData.bills.find((entry) => entry.id === checkoutState.replacementBillId)
        : undefined;
    const sourceLines =
      checkoutState.mode === "session" && previewSession
        ? getSessionCheckoutLines(previewSession, calculateSessionCharge(previewSession, baseAppData.sessionPauseLogs, effectiveClosedAt))
        : checkoutState.mode === "customer_tab"
          ? getCustomerTabCheckoutLines(customerTab?.items ?? [])
          : checkoutState.replacementLines ?? [];
    if (previewSession) {
      const startedAt = new Date(previewSession.startedAt);
      const endedAt = new Date(effectiveClosedAt);
      const nowDate = new Date(now);
      if (startedAt.getTime() > endedAt.getTime()) {
        window.alert("Session start time cannot be later than end time.");
        return;
      }
      if (endedAt.getTime() > nowDate.getTime()) {
        window.alert("Session end time cannot be in the future.");
        return;
      }
    }
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
    const paymentValidationError = validateCheckoutPayment(
      checkoutState.paymentMode,
      checkoutState.splitCashAmount,
      checkoutState.splitUpiAmount,
      checkoutState.collectAmount,
      preview.total
    );
    if (paymentValidationError) {
      window.alert(paymentValidationError);
      return;
    }
    const { amountPaid: billAmountPaid, amountDue: billAmountDue, status: billStatus, paymentRecords: checkoutPaymentRecords } =
      buildCheckoutPaymentResult(
        checkoutState.paymentMode,
        checkoutState.splitCashAmount,
        checkoutState.splitUpiAmount,
        checkoutState.collectAmount,
        checkoutState.collectMode,
        preview.total
      );

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
    const nextAppData = cloneValue(baseAppData);
    const draft = nextAppData;
      const billCustomerId = resolveCustomerProfile(
        draft,
        checkoutState.customerName,
        checkoutState.customerPhone,
        previewSession?.startedAt ?? customerTab?.createdAt ?? issuedAt
      );
      const billNumber = formatBillNumber(draft, issuedAt);
      const issuedBill = {
        id: billId,
        billNumber,
        status: billStatus,
        createdAt: issuedAt,
        issuedAt,
        issuedByUserId: activeUser.id,
        customerId: billCustomerId,
        customerName: checkoutState.customerName.trim() || undefined,
        customerPhone: checkoutState.customerPhone.trim() || undefined,
        paymentMode: checkoutState.paymentMode,
        stationId: previewSession?.stationId ?? replacementBill?.stationId,
        sessionId: previewSession?.id ?? replacementBill?.sessionId,
        amountPaid: billAmountPaid,
        amountDue: billAmountDue,
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
      draft.bills.unshift(issuedBill);
      for (const record of checkoutPaymentRecords) {
        draft.payments.unshift({
          id: createId("payment"),
          billId,
          mode: record.mode,
          amount: record.amount,
          createdAt: issuedAt,
          receivedByUserId: activeUser.id
        });
      }
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
          const stockDelta = line.soldAsPackOf ? line.quantity * line.soldAsPackOf : line.quantity;
          item.stockQty -= stockDelta;
          draft.stockMovements.unshift({
            id: createId("stock"),
            itemId: item.id,
            type: "sale",
            quantity: -stockDelta,
            reason: `Sold in ${billNumber}${line.soldAsPackOf ? ` (${line.quantity} pack${line.quantity !== 1 ? "s" : ""} of ${line.soldAsPackOf})` : ""}`,
            createdAt: issuedAt,
            userId: activeUser.id,
            relatedBillId: billId
          });
        }
      }
      if (session) {
        const targetSession = draft.sessions.find((entry) => entry.id === session.id);
        if (targetSession) {
          targetSession.startedAt = checkoutState.sessionStartedAt ?? targetSession.startedAt;
          targetSession.customerId = billCustomerId;
          targetSession.customerName = checkoutState.customerName.trim() || undefined;
          targetSession.customerPhone = checkoutState.customerPhone.trim() || undefined;
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
          targetTab.customerId = billCustomerId;
          targetTab.customerName = checkoutState.customerName.trim() || targetTab.customerName;
          targetTab.customerPhone = checkoutState.customerPhone.trim() || undefined;
          targetTab.status = "closed";
          targetTab.closedAt = issuedAt;
          targetTab.closedBillId = billId;
          targetTab.closeDisposition = "billed";
          targetTab.closeReason = undefined;
        }
      }
      if (session) {
        const detailChanges: string[] = [];
        if ((session.customerName ?? "") !== checkoutState.customerName.trim()) {
          detailChanges.push(`customer name: ${formatAuditValue(session.customerName)} -> ${formatAuditValue(checkoutState.customerName)}`);
        }
        if ((session.customerPhone ?? "") !== checkoutState.customerPhone.trim()) {
          detailChanges.push(`customer phone: ${formatAuditValue(session.customerPhone)} -> ${formatAuditValue(checkoutState.customerPhone)}`);
        }
        if ((checkoutState.sessionStartedAt ?? session.startedAt) !== session.startedAt) {
          detailChanges.push(`start time: ${formatDateTime(session.startedAt)} -> ${formatDateTime(checkoutState.sessionStartedAt ?? session.startedAt)}`);
        }
        if (effectiveClosedAt !== (checkoutState.closedAt ?? effectiveClosedAt)) {
          detailChanges.push(`end time: ${formatDateTime(checkoutState.closedAt ?? effectiveClosedAt)} -> ${formatDateTime(effectiveClosedAt)}`);
        }
        if (detailChanges.length > 0) {
          addAuditLog(draft, activeUser.id, "session_checkout_details_updated", "session", session.id, `Updated during checkout: ${detailChanges.join("; ")}`);
        }
      }
      if (customerTab) {
        const detailChanges: string[] = [];
        if (customerTab.customerName !== checkoutState.customerName.trim()) {
          detailChanges.push(`customer name: ${formatAuditValue(customerTab.customerName)} -> ${formatAuditValue(checkoutState.customerName)}`);
        }
        if ((customerTab.customerPhone ?? "") !== checkoutState.customerPhone.trim()) {
          detailChanges.push(`customer phone: ${formatAuditValue(customerTab.customerPhone)} -> ${formatAuditValue(checkoutState.customerPhone)}`);
        }
        if (detailChanges.length > 0) {
          addAuditLog(draft, activeUser.id, "customer_tab_checkout_details_updated", "customer_tab", customerTab.id, `Updated during checkout: ${detailChanges.join("; ")}`);
        }
      }
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
      if (billStatus === "pending") {
        addAuditLog(draft, activeUser.id, "bill_pending", "bill", billId, `${billNumber} issued as pending (due ₹${billAmountDue.toFixed(2)}).`);
      }
    if (backendConfigured) {
      skipRemotePersistRef.current = true;
      setAppData(normalizeAppDataCustomers(nextAppData));
      await saveRemoteSnapshot(nextAppData, baseVersion);
    } else {
      setAppData(normalizeAppDataCustomers(nextAppData));
    }

    setSelectedReceiptBillId(billId);
    setCheckoutState(null);
    setManageSessionId(null);
    setSelectedCustomerTabId(null);
    setCustomerTabDraft({ customerId: undefined, customerName: "", customerPhone: "" });
    setReplacementItemForm({ itemId: "", quantity: 1 });
    openReceiptWindow(nextAppData.businessProfile, issuedBill, nextAppData.bills);
    downloadReceiptPdf(nextAppData.businessProfile, issuedBill, nextAppData.bills);
  }

  function settlePayment(draft: SettlementDraft): boolean {
    if (!activeUser || !canSettlePendingBills) {
      return false;
    }
    const bill = appData.bills.find((b) => b.id === draft.billId);
    if (!bill || bill.status !== "pending") {
      window.alert("Bill is not pending.");
      return false;
    }
    const result = computeSettlement(bill.amountPaid, bill.amountDue, bill.total, draft);
    if (result.error) {
      window.alert(result.error);
      return false;
    }
    const settledAt = new Date().toISOString();
    const settlementAmount = getSettlementAmount(draft);
    mutateAppData((data) => {
      const target = data.bills.find((b) => b.id === draft.billId);
      if (!target || target.status !== "pending") return;
      target.amountPaid = result.newAmountPaid;
      target.amountDue = result.newAmountDue;
      target.status = result.newStatus;
      if (result.newStatus === "issued") {
        target.settledAt = settledAt;
        target.settledByUserId = activeUser.id;
      }
      for (const record of result.paymentRecords) {
        data.payments.unshift({
          id: createId("payment"),
          billId: draft.billId,
          mode: record.mode,
          amount: record.amount,
          createdAt: settledAt,
          receivedByUserId: activeUser.id
        });
      }
      addAuditLog(
        data,
        activeUser.id,
        "bill_settled",
        "bill",
        draft.billId,
        `Settled ₹${settlementAmount.toFixed(2)} on ${target.billNumber}. Remaining due: ₹${result.newAmountDue.toFixed(2)}.`
      );
    });
    return true;
  }

  function voidPendingBill(draft: VoidPendingDraft): boolean {
    if (!activeUser || activeUser.role !== "admin") {
      return false;
    }
    // Stock is intentionally NOT reversed: goods were consumed/session was played before the debt was written off.
    const bill = appData.bills.find((b) => b.id === draft.billId);
    if (!bill || bill.status !== "pending") {
      window.alert("Bill is not pending.");
      return false;
    }
    if (!draft.reason.trim()) {
      window.alert("Void reason is required.");
      return false;
    }
    const voidedAt = new Date().toISOString();
    mutateAppData((data) => {
      const target = data.bills.find((b) => b.id === draft.billId);
      if (!target || target.status !== "pending") return;
      target.status = "voided";
      target.voidedAt = voidedAt;
      target.voidedByUserId = activeUser.id;
      target.voidReason = draft.reason.trim();
      addAuditLog(
        data,
        activeUser.id,
        "bill_voided_bad_debt",
        "bill",
        draft.billId,
        `Voided pending bill ${target.billNumber} as bad debt. Reason: ${draft.reason.trim()}.`
      );
    });
    return true;
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
          barcode: itemForm.barcode?.trim() || undefined,
          cigarettePack: resolvedCategory === "Cigarettes" ? itemForm.cigarettePack : undefined
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
          barcode: itemForm.barcode?.trim() || undefined,
          cigarettePack: resolvedCategory === "Cigarettes" ? itemForm.cigarettePack : undefined
        });
        addAuditLog(draft, activeUser.id, "inventory_created", "inventory_item", newId, `Created ${itemForm.name.trim()}.`);
      }
      if (!draft.inventoryCategories.includes(resolvedCategory)) {
        draft.inventoryCategories.push(resolvedCategory);
      }
    });
    resetItemForm();
  }

  function saveEditedInventoryItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditInventory || !editItemForm) {
      return;
    }
    const resolvedCategory = (useCustomEditItemCategory ? customEditItemCategory : editItemForm.category).trim();
    if (!resolvedCategory) {
      window.alert("Category is required.");
      return;
    }
    mutateAppData((draft) => {
      const existing = draft.inventoryItems.find((item) => item.id === editItemForm.id);
      if (!existing) {
        return;
      }
      Object.assign(existing, {
        ...editItemForm,
        name: editItemForm.name.trim(),
        category: resolvedCategory,
        unit: "piece",
        barcode: editItemForm.barcode?.trim() || undefined,
        cigarettePack: resolvedCategory === "Cigarettes" ? editItemForm.cigarettePack : undefined
      });
      if (!draft.inventoryCategories.includes(resolvedCategory)) {
        draft.inventoryCategories.push(resolvedCategory);
      }
      addAuditLog(draft, activeUser.id, "inventory_updated", "inventory_item", existing.id, `Updated ${existing.name}.`);
    });
    closeEditInventoryModal();
  }

  function recordStockMovement(type: StockMovementType, quantityOverride?: number) {
    const effectiveQty = quantityOverride ?? inventoryAction.quantity;
    if (!activeUser || !canEditInventory || !inventoryAction.itemId || effectiveQty <= 0 || !inventoryAction.reason.trim()) {
      return;
    }
    mutateAppData((draft) => {
      const item = draft.inventoryItems.find((entry) => entry.id === inventoryAction.itemId);
      if (!item) {
        return;
      }
      const signedQuantity = type === "restock" ? effectiveQty : -effectiveQty;
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
      draft.stations.unshift({
        ...stationForm,
        id: createId("station"),
        name: stationForm.name.trim()
      });
    });
    setStationForm({ id: "", name: "", mode: "timed", active: true, ltpEnabled: false });
  }

  function beginEditStation(station: Station) {
    if (!canEditSettings) {
      return;
    }
    setEditStationDraft({
      id: station.id,
      name: station.name,
      mode: station.mode,
      active: station.active,
      ltpEnabled: station.ltpEnabled
    });
  }

  function saveEditedStation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings || !editStationDraft) {
      return;
    }
    mutateAppData((draft) => {
      const existing = draft.stations.find((station) => station.id === editStationDraft.id);
      if (!existing) {
        return;
      }
      Object.assign(existing, {
        ...editStationDraft,
        name: editStationDraft.name.trim()
      });
    });
    setEditStationDraft(null);
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
      void runBlockingAction("Creating user...", async () => {
        await adminCreateUserRemote({
          name: nextName,
          username: nextUsername,
          password: userForm.password,
          role: userForm.role
        });
        setUserForm({ name: "", username: "", password: "", role: "receptionist" });
        await refreshRemoteState({ keepUser: true });
      }).catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : "Unable to create user.");
      });
      return;
    }
    void (async () => {
      const hashedPassword = await hashPassword(userForm.password);
      mutateAppData((draft) => {
        const userId = createId("user");
        draft.users.push({
          id: userId,
          name: nextName,
          username: nextUsername,
          password: hashedPassword,
          role: userForm.role,
          active: true
        });
        addAuditLog(draft, activeUser.id, "user_created", "user", userId, `Created ${userForm.role} user ${nextUsername}.`);
      });
      setUserForm({ name: "", username: "", password: "", role: "receptionist" });
    })();
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
      role: user.role,
      tabPermissions: user.tabPermissions
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
    const roleDefaultIds = new Set(tabsByRole[editUserDraft.role].map((t) => t.id));
    const cleanedTabPermissions = editUserDraft.tabPermissions?.filter((id) => !roleDefaultIds.has(id));
    const nextTabPermissions = cleanedTabPermissions?.length ? cleanedTabPermissions : undefined;
    if (backendConfigured) {
      void runBlockingAction("Updating user...", async () => {
        await adminUpdateUserRemote({
          id: editUserDraft.id,
          name: nextName,
          username: nextUsername,
          role: editUserDraft.role
        });
        setEditUserDraft(null);
        await refreshRemoteState({ keepUser: true });
        // Patch tabPermissions into the freshly-reloaded app state and save to Supabase.
        // refreshRemoteState consumes the skip flag so this mutateAppData triggers a remote save.
        mutateAppData((data) => {
          const user = data.users.find((u) => u.id === editUserDraft.id);
          if (user) user.tabPermissions = nextTabPermissions;
        });
      }).catch((error: unknown) => {
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
      user.tabPermissions = nextTabPermissions;
      addAuditLog(draft, activeUser.id, "user_updated", "user", user.id, `Updated user ${user.username}.`);
    });
    setEditUserDraft(null);
  }

  function openChangePassword(user: User) {
    if (!canManageUsers) {
      return;
    }
    setPasswordError("");
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
    if (nextPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      return;
    }
    if (nextPassword !== passwordDraft.confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }
    setPasswordError("");
    const targetUser = appData.users.find((user) => user.id === passwordDraft.userId);
    if (!targetUser) {
      return;
    }
    if (backendConfigured) {
      void runBlockingAction("Updating password...", async () => {
        await adminChangePasswordRemote(passwordDraft.userId, nextPassword);
        setPasswordDraft(null);
        setPasswordError("");
      }).catch((error: unknown) => {
        setPasswordError(error instanceof Error ? error.message : "Unable to update password.");
      });
      return;
    }
    void (async () => {
      const hashedPassword = await hashPassword(nextPassword);
      mutateAppData((draft) => {
        const user = draft.users.find((entry) => entry.id === passwordDraft.userId);
        if (!user) return;
        user.password = hashedPassword;
        addAuditLog(draft, activeUser.id, "user_password_changed", "user", user.id, `Changed password for ${user.username}.`);
      });
      setPasswordDraft(null);
    })();
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
      spentAt: toBusinessDayKey(now),
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
      void runBlockingAction(targetUser.active ? "Disabling user..." : "Enabling user...", async () => {
        await adminToggleUserActiveRemote(userId);
        await refreshRemoteState({ keepUser: true });
      }).catch((error: unknown) => {
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
        const reverseDelta = line.soldAsPackOf ? line.quantity * line.soldAsPackOf : line.quantity;
        item.stockQty += reverseDelta;
        draft.stockMovements.unshift({
          id: createId("stock"),
          itemId: item.id,
          type: "void_refund_reversal",
          quantity: reverseDelta,
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
          const previewSession = session ? getCheckoutSessionPreview(session, checkoutState) : null;
          return session
            ? getSessionCheckoutLines(
                previewSession ?? session,
                getSessionChargeSummary(previewSession ?? session, checkoutState.sessionEndedAt ?? checkoutState.closedAt ?? now)
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
      const billDate = getBillBusinessDate(bill);
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
  const issuedBillIds = new Set(issuedBills.map((bill) => bill.id));
  const issuedBillPayments = appData.payments.filter((payment) => issuedBillIds.has(payment.billId));
  const paymentModeTotals = {
    cash: sumBy(issuedBillPayments.filter((payment) => payment.mode === "cash"), (payment) => payment.amount),
    upi: sumBy(issuedBillPayments.filter((payment) => payment.mode === "upi"), (payment) => payment.amount)
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
  const pendingBills = appData.bills.filter((b) => b.status === "pending");
  const totalAmountDue = pendingBills.reduce((sum, b) => sum + b.amountDue, 0);

  if (backendConfigured && remoteLoading) {
    return <AppLoadingScreen />;
  }

  if (!activeUser) {
    return (
      <>
        <LoginScreen
          loginUsername={loginUsername}
          loginPassword={loginPassword}
          loginError={remoteError || loginError}
          onUsernameChange={setLoginUsername}
          onPasswordChange={setLoginPassword}
          onSubmit={handleLogin}
        />
        {blockingActionLabel && <LoadingOverlay label={blockingActionLabel} />}
      </>
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
          {remoteError && (
            <div className="remote-error-banner" role="alert">
              <span>{remoteError}</span>
              <button type="button" className="ghost-button" onClick={() => setRemoteError("")}>
                Dismiss
              </button>
            </div>
          )}
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
            <div className="sidebar-user-actions">
              {backendConfigured && (
                <button
                  className="ghost-button sidebar-user-action"
                  type="button"
                  onClick={() => { setOwnPasswordDraft({ password: "", confirm: "" }); setOwnPasswordError(""); }}
                >
                  Change Password
                </button>
              )}
              <button className="secondary-button sidebar-user-action" type="button" onClick={handleLogout}>
                Log Out
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className={`main-content ${activeTab === "dashboard" ? "is-dashboard-tab" : activeTab === "bills" ? "is-bills-tab" : ""}`}>
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <div className="muted">{activeUser.name}</div>
          </div>
          <div className="topbar-actions">
            <TodayMetricCard
              value={currency(sumBy(appData.bills.filter((bill) => bill.status === "issued" && getBillBusinessDate(bill) === toBusinessDayKey(now)), (bill) => bill.total))}
              timeLabel={formatTime(now)}
              dateLabel={currentDateLabel}
            />
            <MetricCard label="Open Sessions" value={`${activeSessions.length + openCustomerTabs.length}`} />
          </div>
        </header>

        {activeTab === "dashboard" && (
          <DashboardPanel
            stations={stations}
            openCustomerTabs={openCustomerTabs}
            auditLogs={appData.auditLogs}
            customers={appData.customers}
            inventoryItems={appData.inventoryItems}
            checkoutState={checkoutState}
            startSessionDraft={startSessionDraft}
            selectedStartStation={selectedStartStation}
            arcadeInventoryItems={arcadeInventoryItems}
            selectedArcadeStartItem={selectedArcadeStartItem}
            dashboardCustomerTabDraft={dashboardCustomerTabDraft}
            pendingBillsCount={pendingBills.length}
            totalAmountDue={totalAmountDue}
            lowStockItems={lowStockItems}
            outOfStockItems={outOfStockItems}
            occupiedItems={occupiedItems}
            getActiveSessionForStation={getActiveSessionForStation}
            getSessionLiveTotal={getSessionLiveTotal}
            getFrozenEndAtForSession={getFrozenEndAtForSession}
            getCustomerTabTotal={getCustomerTabTotal}
            getInventoryState={getInventoryState}
            getInventoryStateLabel={getInventoryStateLabel}
            getInventoryStatusDetail={getInventoryStatusDetail}
            getAvailableStock={getAvailableStock}
            getInventoryPickerDetail={getInventoryPickerDetail}
            createStartSessionDraft={createStartSessionDraft}
            onStartSessionDraftChange={setStartSessionDraft}
            onDashboardCustomerTabDraftChange={setDashboardCustomerTabDraft}
            onSetManageSessionId={setManageSessionId}
            onSetShowStartSessionModal={setShowStartSessionModal}
            onToggleSessionPause={toggleSessionPause}
            onRejectSession={rejectSession}
            onOpenSessionCheckout={openSessionCheckout}
            onOpenCustomerTabWorkspace={openCustomerTabWorkspace}
            onBeginCustomerTabCheckoutById={beginCustomerTabCheckoutById}
            onRejectCustomerTab={rejectCustomerTab}
            onStartSession={startSession}
            onCreateDashboardCustomerTab={createDashboardCustomerTab}
          />
        )}

        {activeTab === "sale" && (
          <SalePanel
            inventoryItems={appData.inventoryItems}
            customers={appData.customers}
            customerTabSearch={customerTabSearch}
            customerTabDraft={customerTabDraft}
            openCustomerTabs={openCustomerTabs}
            selectedCustomerTab={selectedCustomerTab}
            editCustomerTabDraft={editCustomerTabDraft}
            canEditActiveSessionDetails={canEditActiveSessionDetails}
            getInventoryPickerDetail={getInventoryPickerDetail}
            getCustomerTabTotal={getCustomerTabTotal}
            onCustomerTabSearchChange={setCustomerTabSearch}
            onCustomerTabDraftChange={setCustomerTabDraft}
            onSelectCustomerTab={setSelectedCustomerTabId}
            onEditCustomerTabDraftChange={setEditCustomerTabDraft}
            onAddItemToCustomerTab={(item, sellAsPackOf) => addItemToCustomerTab(item, sellAsPackOf)}
            onCreateOrSelectCustomerTab={createOrSelectCustomerTab}
            onUpdateCustomerTabItemQuantity={updateCustomerTabItemQuantity}
            onRemoveItemFromCustomerTab={removeItemFromCustomerTab}
            onBeginEditCustomerTabDetails={beginEditCustomerTabDetails}
            onRejectCustomerTab={rejectCustomerTab}
            onBeginCustomerTabCheckout={beginCustomerTabCheckout}
            onSaveCustomerTabDetails={saveCustomerTabDetails}
          />
        )}

        {activeTab === "inventory" && canAccessTab("inventory") && (
          <InventoryPanel
            inventoryItems={appData.inventoryItems}
            stockMovements={appData.stockMovements}
            itemForm={itemForm}
            editItemForm={editItemForm}
            useCustomItemCategory={useCustomItemCategory}
            customItemCategory={customItemCategory}
            useCustomEditItemCategory={useCustomEditItemCategory}
            customEditItemCategory={customEditItemCategory}
            inventoryAction={inventoryAction}
            inventoryItemSearch={inventoryItemSearch}
            filteredInventoryItems={filteredInventoryItems}
            inventoryCategoryOptions={inventoryCategoryOptions}
            canEditInventory={canEditInventory}
            isManagerReadOnly={isManagerReadOnly}
            getInventoryState={getInventoryState}
            getInventoryStateLabel={getInventoryStateLabel}
            onItemFormChange={setItemForm}
            onEditItemFormChange={setEditItemForm}
            onUseCustomItemCategoryChange={setUseCustomItemCategory}
            onCustomItemCategoryChange={setCustomItemCategory}
            onUseCustomEditItemCategoryChange={setUseCustomEditItemCategory}
            onCustomEditItemCategoryChange={setCustomEditItemCategory}
            onInventoryActionChange={setInventoryAction}
            onInventoryItemSearchChange={setInventoryItemSearch}
            onUpsertInventoryItem={upsertInventoryItem}
            onSaveEditedInventoryItem={saveEditedInventoryItem}
            onCloseEditInventoryModal={closeEditInventoryModal}
            onBeginEditInventoryItem={beginEditInventoryItem}
            onRecordStockMovement={recordStockMovement}
          />
        )}

        {activeTab === "bills" && canAccessTab("bills") && (
          <BillRegisterPanel
            bills={appData.bills}
            billBusinessDates={billBusinessDates}
            stations={appData.stations}
            businessProfile={appData.businessProfile}
            selectedReceiptBillId={selectedReceiptBillId}
            selectedReceiptBill={selectedReceiptBill}
            receiptPreviewModel={receiptPreviewModel}
            allBills={appData.bills}
            canReplaceIssuedBills={canReplaceIssuedBills}
            canVoidRefundBills={canVoidRefundBills}
            canSettlePendingBills={canSettlePendingBills}
            onSelectReceiptBill={setSelectedReceiptBillId}
            onSettlePendingBill={(billId) => setSettlementDraft({ billId, paymentMode: "cash", cashAmount: 0, upiAmount: 0 })}
            onVoidPendingBill={(billId) => setVoidPendingDraft({ billId, reason: "" })}
            onOpenBillReplacement={openBillReplacement}
            onVoidOrRefundBill={voidOrRefundBill}
          />
        )}

        {activeTab === "reports" && canAccessTab("reports") && (
          <ReportsPanel
            stations={appData.stations}
            businessProfile={appData.businessProfile}
            reportFilter={reportFilter}
            reportFromDate={reportFromDate}
            reportToDate={reportToDate}
            resolvedReportRangeLabel={resolvedReportRange.label}
            filteredBills={filteredBills}
            filteredExpenses={filteredExpenses}
            expenseTemplates={appData.expenseTemplates}
            reportRows={reportRows}
            summary={{
              grossRevenue,
              netCashEarnings,
              normalizedNetProfit,
              issuedBillsCount: issuedBills.length,
              cashExpenses,
              normalizedExpenses,
              sessionRevenue,
              itemRevenue,
              totalDiscounts,
              previousRangeLabel: previousRange.label,
              previousRangeRevenue,
              revenueGrowthPct,
              averageBillValue,
              topStation,
              paymentModeTotals,
              expenseByCategory,
              normalizedExpenseByCategory
            }}
            expenseForm={expenseForm}
            expenseTemplateForm={expenseTemplateForm}
            expenseCategoryOptions={expenseCategoryOptions}
            canEditReports={canEditReports}
            isManagerReadOnly={isManagerReadOnly}
            onReportFilterChange={setReportFilter}
            onExpenseFormChange={setExpenseForm}
            onExpenseTemplateFormChange={setExpenseTemplateForm}
            onCreateExpense={createExpense}
            onDeleteExpense={deleteExpense}
            onSaveExpenseTemplate={saveExpenseTemplate}
            onBeginEditExpenseTemplate={beginEditExpenseTemplate}
            onToggleExpenseTemplateActive={toggleExpenseTemplateActive}
            onDeleteExpenseTemplate={deleteExpenseTemplate}
          />
        )}

        {activeTab === "customers" && canAccessTab("customers") && (
          <CustomersPanel
            stations={appData.stations}
            customerAnalytics={customerAnalytics}
            filteredCustomerProfiles={filteredCustomerProfiles}
            selectedCustomerProfile={selectedCustomerProfile}
            selectedCustomerProfileStats={selectedCustomerProfileStats}
            customerProfileSearch={customerProfileSearch}
            customerProfileSort={customerProfileSort}
            editCustomerProfileDraft={editCustomerProfileDraft}
            onCustomerProfileSearchChange={setCustomerProfileSearch}
            onCustomerProfileSortChange={setCustomerProfileSort}
            onSelectCustomerProfile={setSelectedCustomerProfileId}
            onEditCustomerProfileDraftChange={setEditCustomerProfileDraft}
            onBeginEditCustomerProfile={beginEditCustomerProfile}
            onSaveCustomerProfile={saveCustomerProfile}
          />
        )}

        {activeTab === "settings" && canAccessTab("settings") && (
          <SettingsPanel
            stations={appData.stations}
            pricingRules={appData.pricingRules}
            businessProfile={appData.businessProfile}
            stationForm={stationForm}
            editStationDraft={editStationDraft}
            pricingDraft={pricingDraft}
            businessDraft={businessDraft}
            canEditSettings={canEditSettings}
            isManagerReadOnly={isManagerReadOnly}
            onStationFormChange={setStationForm}
            onEditStationDraftChange={setEditStationDraft}
            onPricingDraftChange={setPricingDraft}
            onBusinessDraftChange={setBusinessDraft}
            onUpsertStation={upsertStation}
            onBeginEditStation={beginEditStation}
            onSaveEditedStation={saveEditedStation}
            onDeleteStation={deleteStation}
            onAddPricingRule={addPricingRule}
            onDeletePricingRule={deletePricingRule}
            onSaveBusinessProfile={saveBusinessProfile}
          />
        )}

        {activeTab === "users" && canAccessTab("users") && (
          <UsersPanel
            users={appData.users}
            userForm={userForm}
            editUserDraft={editUserDraft}
            passwordDraft={passwordDraft}
            passwordError={passwordError}
            onUserFormChange={setUserForm}
            onEditUserDraftChange={setEditUserDraft}
            onPasswordDraftChange={(next) => { setPasswordDraft(next); setPasswordError(""); }}
            onCreateUser={createUser}
            onBeginEditUser={beginEditUser}
            onSaveUserEdits={saveUserEdits}
            onOpenChangePassword={openChangePassword}
            onSaveUserPassword={saveUserPassword}
            onToggleUserActive={toggleUserActive}
          />
        )}
      </main>

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
            <CustomerAutocompleteFields
              customers={appData.customers}
              customerId={startSessionDraft.customerId}
              customerName={startSessionDraft.customerName}
              customerPhone={startSessionDraft.customerPhone}
              namePlaceholder="Optional"
              phonePlaceholder="Optional"
              phoneFieldClassName="field-span-full"
              onChange={(next) => setStartSessionDraft((previous) => ({ ...previous, ...next }))}
            />
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
        <Modal
          title={managedSession.stationNameSnapshot}
          onClose={() => {
            setManageSessionId(null);
            setEditSessionDraft((previous) => (previous?.sessionId === managedSession.id ? null : previous));
          }}
        >
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
          {editSessionDraft?.sessionId === managedSession.id && (
            <div className="section-block section-block-muted">
              <div className="section-block-header">
                <h3>Edit Session Details</h3>
                <p>Admin-only corrections for customer details and timed session start time.</p>
              </div>
              <form className="form-grid" onSubmit={saveSessionDetails}>
                <CustomerAutocompleteFields
                  customers={appData.customers}
                  customerId={editSessionDraft.customerId}
                  customerName={editSessionDraft.customerName}
                  customerPhone={editSessionDraft.customerPhone}
                  namePlaceholder="Optional"
                  phonePlaceholder="Optional"
                  onChange={(next) =>
                    setEditSessionDraft((previous) => (previous ? { ...previous, ...next } : previous))
                  }
                />
                {managedSession.mode === "timed" && (
                  <label className="field-span-full">
                    <span>Session Start Time</span>
                    <input
                      type="datetime-local"
                      value={editSessionDraft.startedAt}
                      onChange={(event) =>
                        setEditSessionDraft((previous) =>
                          previous ? { ...previous, startedAt: event.target.value } : previous
                        )
                      }
                    />
                  </label>
                )}
                <div className="button-row field-span-full">
                  <button className="secondary-button" type="button" onClick={() => setEditSessionDraft(null)}>
                    Cancel
                  </button>
                  <button className="primary-button" type="submit">
                    Save Session Details
                  </button>
                </div>
              </form>
            </div>
          )}
          <div className="panel-header compact-header">
            <div>
              <h2>Session Consumables</h2>
              <p>Add or remove items linked to this live session.</p>
            </div>
          </div>
          <div className="session-item-adder">
            <select value={sessionItemForm[managedSession.id]?.itemId ?? ""} onChange={(event) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { itemId: event.target.value, quantity: p[managedSession.id]?.quantity ?? 1, sellAsPackOf: undefined } }))}>
              <option value="">Select item</option>
              {appData.inventoryItems.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name} · {currency(item.price)} · {getInventoryPickerDetail(item, managedSession.id)}</option>)}
            </select>
            {(() => {
              const selectedItem = appData.inventoryItems.find((i) => i.id === sessionItemForm[managedSession.id]?.itemId);
              if (!selectedItem?.cigarettePack) return null;
              const packOf = selectedItem.cigarettePack;
              const selling = sessionItemForm[managedSession.id]?.sellAsPackOf;
              return (
                <select value={selling ? "pack" : "single"} onChange={(e) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { ...p[managedSession.id], itemId: p[managedSession.id]?.itemId ?? "", quantity: p[managedSession.id]?.quantity ?? 1, sellAsPackOf: e.target.value === "pack" ? packOf.size : undefined } }))}>
                  <option value="single">Single — {currency(selectedItem.price)}</option>
                  <option value="pack">Pack of {packOf.size} — {currency(packOf.packPrice)}</option>
                </select>
              );
            })()}
            <NumericInput min={1} defaultValue={1} value={sessionItemForm[managedSession.id]?.quantity ?? 1} onValueChange={(value) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { ...p[managedSession.id], itemId: p[managedSession.id]?.itemId ?? "", quantity: value } }))} />
            <button className="secondary-button" type="button" onClick={() => addItemToSession(managedSession.id)}>Add Item</button>
          </div>
          <div className="line-items">
            {managedSession.items.length === 0 && <div className="empty-state">No consumables added yet.</div>}
            {managedSession.items.map((item: SessionItem) => (
              <div key={item.id} className="session-item-row">
                <div>
                  <strong>{item.name}{item.soldAsPackOf ? ` (Pack of ${item.soldAsPackOf})` : ""}</strong>
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
            {canEditActiveSessionDetails && (
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  editSessionDraft?.sessionId === managedSession.id ? setEditSessionDraft(null) : beginEditSessionDetails(managedSession)
                }
              >
                {editSessionDraft?.sessionId === managedSession.id ? "Hide Session Details" : "Edit Session Details"}
              </button>
            )}
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
            <CustomerAutocompleteFields
              customers={appData.customers}
              customerId={checkoutState.customerId}
              customerName={checkoutState.customerName}
              customerPhone={checkoutState.customerPhone}
              disabled={!canEditActiveSessionDetails && checkoutState.mode !== "bill_replacement"}
              onChange={(next) => setCheckoutState((p) => (p ? { ...p, ...next } : p))}
            />
            <label><span>Payment Mode</span><select value={checkoutState.paymentMode} onChange={(event) => setCheckoutState((p) => p ? { ...p, paymentMode: event.target.value as BillPaymentMode, splitCashAmount: 0, splitUpiAmount: 0, collectAmount: 0 } : p)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="split">Split (Cash + UPI)</option>{checkoutState.mode !== "bill_replacement" && <option value="deferred">Pay Later</option>}</select></label>
          </div>
          {checkoutState.paymentMode === "split" && (
            <div className="form-grid">
              <label>
                <span>Cash Amount</span>
                <NumericInput mode="decimal" min={0} value={checkoutState.splitCashAmount} onValueChange={(value) => setCheckoutState((p) => p ? { ...p, splitCashAmount: value, splitUpiAmount: Math.max(0, (checkoutPreview?.total ?? 0) - value) } : p)} />
              </label>
              <label>
                <span>UPI Amount</span>
                <NumericInput mode="decimal" min={0} value={checkoutState.splitUpiAmount} onValueChange={(value) => setCheckoutState((p) => p ? { ...p, splitUpiAmount: value, splitCashAmount: Math.max(0, (checkoutPreview?.total ?? 0) - value) } : p)} />
              </label>
            </div>
          )}
          {checkoutState.paymentMode === "deferred" && (
            <div className="form-grid">
              <label>
                <span>Collect Upfront (optional)</span>
                <NumericInput mode="decimal" min={0} value={checkoutState.collectAmount} onValueChange={(value) => setCheckoutState((p) => p ? { ...p, collectAmount: value } : p)} />
              </label>
              <label>
                <span>Upfront Mode</span>
                <select value={checkoutState.collectMode} onChange={(event) => setCheckoutState((p) => p ? { ...p, collectMode: event.target.value as PaymentMode } : p)} disabled={checkoutState.collectAmount === 0}><option value="cash">Cash</option><option value="upi">UPI</option></select>
              </label>
            </div>
          )}
          {checkoutState && checkoutSession && checkoutSession.mode === "timed" && canEditActiveSessionDetails && (
            <div className="form-grid">
              <label>
                <span>Session Start Time</span>
                <input
                  type="datetime-local"
                  value={formatDateTimeInputValue(checkoutState.sessionStartedAt)}
                  onChange={(event) =>
                    setCheckoutState((previous) =>
                      previous ? { ...previous, sessionStartedAt: parseDateTimeInputValue(event.target.value) } : previous
                    )
                  }
                />
              </label>
              <label>
                <span>Session End Time</span>
                <input
                  type="datetime-local"
                  value={formatDateTimeInputValue(checkoutState.sessionEndedAt)}
                  onChange={(event) =>
                    setCheckoutState((previous) =>
                      previous ? { ...previous, sessionEndedAt: parseDateTimeInputValue(event.target.value) } : previous
                    )
                  }
                />
              </label>
            </div>
          )}
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
                Billing frozen at {formatDateTime(checkoutState.sessionEndedAt ?? checkoutState.closedAt ?? now)}. The session timer is stopped for this checkout.
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
                        ...p[checkoutSession.id],
                        itemId: event.target.value,
                        quantity: p[checkoutSession.id]?.quantity ?? 1,
                        sellAsPackOf: undefined
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
                {(() => {
                  const selectedItem = appData.inventoryItems.find((i) => i.id === sessionItemForm[checkoutSession.id]?.itemId);
                  if (!selectedItem?.cigarettePack) return null;
                  const packOf = selectedItem.cigarettePack;
                  const selling = sessionItemForm[checkoutSession.id]?.sellAsPackOf;
                  return (
                    <select
                      value={selling ? "pack" : "single"}
                      onChange={(e) =>
                        setSessionItemForm((p) => ({
                          ...p,
                          [checkoutSession.id]: {
                            ...p[checkoutSession.id],
                            itemId: p[checkoutSession.id]?.itemId ?? "",
                            quantity: p[checkoutSession.id]?.quantity ?? 1,
                            sellAsPackOf: e.target.value === "pack" ? packOf.size : undefined
                          }
                        }))
                      }
                    >
                      <option value="single">Single — {currency(selectedItem.price)}</option>
                      <option value="pack">Pack of {packOf.size} — {currency(packOf.packPrice)}</option>
                    </select>
                  );
                })()}
                <NumericInput
                  value={sessionItemForm[checkoutSession.id]?.quantity ?? 1}
                  min={1}
                  defaultValue={1}
                  onValueChange={(value) =>
                    setSessionItemForm((p) => ({
                      ...p,
                      [checkoutSession.id]: {
                        ...p[checkoutSession.id],
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
            <div><span className="muted">Total</span><strong>{currency(checkoutPreview.total)}</strong></div>
            {checkoutState.paymentMode === "split" && (
              <>
                <div><span className="muted">Cash</span><strong>{currency(checkoutState.splitCashAmount)}</strong></div>
                <div><span className="muted">UPI</span><strong>{currency(checkoutState.splitUpiAmount)}</strong></div>
              </>
            )}
            {checkoutState.paymentMode === "deferred" && (
              <>
                <div><span className="muted">Collecting Now</span><strong>{currency(checkoutState.collectAmount)}</strong></div>
                <div><span className="muted pending-amount">Amount Due Later</span><strong className="pending-amount">{currency(Math.max(0, checkoutPreview.total - checkoutState.collectAmount))}</strong></div>
              </>
            )}
          </div>
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => { setCheckoutState(null); setReplacementItemForm({ itemId: "", quantity: 1 }); }}>Cancel</button>
            <button
              className="primary-button"
              type="button"
              onClick={() =>
                void runBlockingAction(
                  checkoutState.mode === "bill_replacement" ? "Issuing replacement bill..." : "Issuing bill...",
                  finalizeCheckout
                )
              }
              disabled={remoteSaving || Boolean(blockingActionLabel)}
            >
              {checkoutState.mode === "bill_replacement" ? "Issue Replacement Bill" : "Issue Bill"}
            </button>
          </div>
        </Modal>
      )}
      {ownPasswordDraft && (
        <Modal title="Change Your Password" onClose={() => { setOwnPasswordDraft(null); setOwnPasswordError(""); }}>
          <form className="form-grid" onSubmit={handleChangeOwnPassword}>
            <label className="field-span-full">
              <span>New Password</span>
              <input
                type="password"
                required
                value={ownPasswordDraft.password}
                onChange={(event) => setOwnPasswordDraft({ ...ownPasswordDraft, password: event.target.value })}
              />
            </label>
            <label className="field-span-full">
              <span>Confirm Password</span>
              <input
                type="password"
                required
                value={ownPasswordDraft.confirm}
                onChange={(event) => setOwnPasswordDraft({ ...ownPasswordDraft, confirm: event.target.value })}
              />
            </label>
            {ownPasswordError && <div className="error-text field-span-full">{ownPasswordError}</div>}
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => { setOwnPasswordDraft(null); setOwnPasswordError(""); }}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Update Password
              </button>
            </div>
          </form>
        </Modal>
      )}
      {settlementDraft && (() => {
        const pendingBill = appData.bills.find((b) => b.id === settlementDraft.billId);
        if (!pendingBill) return null;
        const settlementTotal = settlementDraft.paymentMode === "split"
          ? settlementDraft.cashAmount + settlementDraft.upiAmount
          : settlementDraft.paymentMode === "cash" ? settlementDraft.cashAmount : settlementDraft.upiAmount;
        return (
          <Modal title={`Settle Bill — ${pendingBill.billNumber}`} onClose={() => setSettlementDraft(null)}>
            <div className="form-grid">
              <div className="field-span-full checkout-summary">
                <div><span className="muted">Bill Total</span><strong>{currency(pendingBill.total)}</strong></div>
                <div><span className="muted">Already Paid</span><strong>{currency(pendingBill.amountPaid)}</strong></div>
                <div><span className="muted pending-amount">Amount Due</span><strong className="pending-amount">{currency(pendingBill.amountDue)}</strong></div>
              </div>
              <label><span>Payment Mode</span><select value={settlementDraft.paymentMode} onChange={(event) => setSettlementDraft((p) => p ? { ...p, paymentMode: event.target.value as PaymentMode | "split", cashAmount: 0, upiAmount: 0 } : p)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="split">Split</option></select></label>
              {settlementDraft.paymentMode === "split" ? (
                <>
                  <label><span>Cash Amount</span><NumericInput mode="decimal" min={0} value={settlementDraft.cashAmount} onValueChange={(value) => setSettlementDraft((p) => p ? { ...p, cashAmount: value } : p)} /></label>
                  <label><span>UPI Amount</span><NumericInput mode="decimal" min={0} value={settlementDraft.upiAmount} onValueChange={(value) => setSettlementDraft((p) => p ? { ...p, upiAmount: value } : p)} /></label>
                </>
              ) : settlementDraft.paymentMode === "cash" ? (
                <label><span>Cash Amount</span><NumericInput mode="decimal" min={0} value={settlementDraft.cashAmount} onValueChange={(value) => setSettlementDraft((p) => p ? { ...p, cashAmount: value } : p)} /></label>
              ) : (
                <label><span>UPI Amount</span><NumericInput mode="decimal" min={0} value={settlementDraft.upiAmount} onValueChange={(value) => setSettlementDraft((p) => p ? { ...p, upiAmount: value } : p)} /></label>
              )}
              {settlementDraft.paymentMode !== "split" && (
                <div className="field-span-full">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setSettlementDraft((p) => p ? (p.paymentMode === "cash" ? { ...p, cashAmount: pendingBill.amountDue } : { ...p, upiAmount: pendingBill.amountDue }) : p)}
                  >
                    Pay Full Amount ({currency(pendingBill.amountDue)})
                  </button>
                </div>
              )}
            </div>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={() => setSettlementDraft(null)}>Cancel</button>
              <button
                className="primary-button"
                type="button"
                onClick={() => { if (settlePayment(settlementDraft)) setSettlementDraft(null); }}
                disabled={settlementTotal <= 0}
              >
                Confirm Settlement
              </button>
            </div>
          </Modal>
        );
      })()}
      {voidPendingDraft && (() => {
        const pendingBill = appData.bills.find((b) => b.id === voidPendingDraft.billId);
        if (!pendingBill) return null;
        return (
          <Modal title={`Write Off Bad Debt — ${pendingBill.billNumber}`} onClose={() => setVoidPendingDraft(null)}>
            <div className="form-grid">
              <div className="field-span-full checkout-summary">
                <div><span className="muted pending-amount">Amount to Write Off</span><strong className="pending-amount">{currency(pendingBill.amountDue)}</strong></div>
              </div>
              <label className="field-span-full">
                <span>Reason</span>
                <input
                  value={voidPendingDraft.reason}
                  placeholder="Reason for writing off this debt"
                  onChange={(event) => setVoidPendingDraft((p) => p ? { ...p, reason: event.target.value } : p)}
                />
              </label>
            </div>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={() => setVoidPendingDraft(null)}>Cancel</button>
              <button
                className="danger-button"
                type="button"
                onClick={() => { if (voidPendingBill(voidPendingDraft)) setVoidPendingDraft(null); }}
                disabled={!voidPendingDraft.reason.trim()}
              >
                Write Off
              </button>
            </div>
          </Modal>
        );
      })()}
      {blockingActionLabel && <LoadingOverlay label={blockingActionLabel} />}
    </div>
  );
}
