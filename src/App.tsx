import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClock } from "./hooks/useClock";
import { useAppSync, type RemoteRestoreState } from "./hooks/useAppSync";
import { Modal } from "./components/Modal";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { LoginScreen } from "./components/LoginScreen";
import { MetricCard, TodayMetricCard } from "./components/MetricCard";
import { NumericInput } from "./components/NumericInput";
import { CustomerAutocompleteFields, type CustomerAutocompleteSuggestionProps } from "./components/CustomerAutocompleteFields";
import { SellableInventoryPicker } from "./components/SellableInventoryPicker";
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
import {
  clearStoredAppData,
  hasStoredAppData,
  loadAppData,
  saveAppData,
  setFullAppDataCacheEnabled
} from "./storage";
import {
  adminChangePasswordRemote,
  changeOwnPasswordRemote,
  adminCreateUserRemote,
  adminToggleUserActiveRemote,
  adminUpdateUserRemote,
  fetchCurrentProfile,
  isBackendConfigured,
  type RemoteAppDataSnapshot,
  signInWithUsername,
  signOutRemote
} from "./backend";
import {
  defaultRemoteDataGateway,
  adminDataChangePatchHasChanges,
  adminDataChangePatchHasUnsupportedChanges,
  buildAdminDataChangePatch,
  buildFinancialAdjustmentPatch,
  buildFinancialCheckoutPatch,
  clearCachedNormalizedOrganizationId,
  loadInventoryReportSummaryData,
  loadAnalyticsSummaryData,
  isAnalyticsSummaryDataReady,
  loadNormalizedCustomerSearch,
  loadNormalizedCustomerHistoryData,
  loadNormalizedReportData,
  loadNormalizedBillRegisterPage,
  loadNormalizedPendingBills,
  loadNormalizedFinancialDelta,
  mergeNormalizedAppDataOverlay,
  resolveBackendFeatureFlags,
  type FinancialAdjustmentCommitResult,
  type FinancialAdjustmentKind,
  type FinancialAdjustmentPatch,
  type FinancialCheckoutCommitResult,
  type FinancialCheckoutPatch,
  type AnalyticsSummaryData,
  type NormalizedBillRegisterCursor,
  type NormalizedBillRegisterQuery,
  type NormalizedCustomerHistoryData,
  type NormalizedReportData,
  type OperationalRpcCommitResult,
  OperationalRpcError
} from "./dataGateway";
import {
  estimateCheckoutPayloadBytes,
  recordCheckoutTelemetrySample
} from "./checkoutTelemetry";
import { runQaControlledNormalizedRead } from "./qa/normalizedReadFailure";
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
  CustomerTabItem,
  CustomerProfileEditDraft,
  ComboPackage,
  DiscountType,
  DraftLineDiscountMap,
  ExpensePaymentMode,
  InventoryReportFilterState,
  InventoryReportModel,
  InventoryPanelView,
  InventoryItem,
  InventoryState,
  SaleVariant,
  ExpenseTemplate,
  ExpenseTemplateOverride,
  SellableInventoryOption,
  LtpOutcome,
  PendingSettlementDraft,
  Payment,
  PaymentMode,
  PlayMode,
  ReportFilterState,
  Role,
  Session,
  SessionComboApplication,
  SessionEditDraft,
  SessionItem,
  SessionPauseLog,
  StartSessionDraft,
  Station,
  StationEditDraft,
  StockMovementType,
  TabId,
  User,
  UserEditDraft,
  UserPasswordDraft,
  SettlementDraft,
  VoidPendingDraft,
  VoidPendingGroupDraft
} from "./types";
import { DEFAULT_INVENTORY_CATEGORIES, DEFAULT_EXPENSE_CATEGORIES, tabsByRole, ALL_TABS, getCategoryIcon } from "./constants";
import { getCategoryImage } from "./categoryImages";
import {
  addAuditLog,
  buildBillPreview,
  clampNumber,
  cloneBillLinesForReplacement,
  cloneValue,
  createId,
  currency,
  findExactCustomerProfileMatch,
  findCustomerProfileMatch,
  formatAuditValue,
  formatBillNumber,
  formatDateTimeInputValue,
  formatDateTime,
  formatMinutes,
  formatTime,
  getCustomerTabCheckoutLines,
  getDiscountAmount,
  getActiveInventoryItems,
  getArchivedInventoryItems,
  getInventoryItemOpenUsage,
  getInventoryReportRange,
  filterInventoryReportModel,
  getInventoryQuantityMap,
  getLineStockQuantity,
  getCombosForStation,
  getConsumablesCombos,
  getComboInventorySelections,
  getComboApplicationsTotal,
  getComboIncludedMinutes,
  getMonthKeysInRange,
  getPreviousRange,
  prorateFactor,
  getReportRange,
  resolveComboChoiceSelections,
  resolveComboFixedSelections,
  getSellableInventoryOptions,
  getStockUnitsPerSale,
  getSessionCheckoutLines,
  normalizeAppDataCustomers,
  allocatePaymentRevenueToBill,
  computeExpensePaymentModeTotals,
  computePaymentModeTotals,
  filterPaymentsByBusinessDate,
  getRevenueCountedPayments,
  getDirectlyLinkedHoppedSessions,
  getCustomerTabContinuationCandidates,
  getPendingBillsForCustomer as findPendingBillsForCustomer,
  getPendingReceivableGroups,
  buildInventoryReportModel,
  getUnbilledHoppedSessionsForCustomer,
  normalizeCustomerName,
  normalizeCustomerPhone,
  parseDateTimeInputValue,
  resolveCustomerTabWorkspaceSelection,
  resolveCustomerProfile,
  sumBy,
  toBusinessDayKey,
  toLocalDateKey,
  toMinuteOfDay,
  resolveEffectiveAmount
} from "./utils";
import {
  buildCheckoutPaymentResult,
  computeReceivableSettlement,
  getSettlementAmount,
  validateCheckoutPayment
} from "./billing";
import {
  applyOperationalMutation,
  createOperationalMutationAcknowledgementRegistry,
  getOperationalMutationForDispatch,
  getOperationalConflictMessages,
  hasPendingOperationalMutationForEntity,
  isOperationalMutationSyncable,
  loadPendingOperationalMutations,
  reconcileOperationalServerIdentity,
  rebasePendingMutations,
  savePendingOperationalMutations,
  type OperationalMutation,
  type OperationalMutationKind,
  type OperationalMutationPayload
} from "./operationalSync";

type PostHopContinuationMode = "gaming" | "consumables";
type SessionItemFormState = Record<string, { sellableOptionId: string; quantity: number; sellAsPackOf?: number }>;
type InventoryArchiveView = "active" | "archived";
type BillRegisterServerQuery = Omit<NormalizedBillRegisterQuery, "organizationId" | "cursor" | "limit">;
type CustomerIdentityDraft = {
  customerId?: string;
  customerName: string;
  customerPhone: string;
};

const BACKEND_FEATURE_FLAGS = resolveBackendFeatureFlags();
const BILL_REGISTER_PAGE_SIZE = 50;
const CUSTOMER_SEARCH_PAGE_SIZE = 8;
const CUSTOMER_SEARCH_DEBOUNCE_MS = 180;
const CRITICAL_OPERATION_ACK_TIMEOUT_MS = 20_000;

interface InventoryArchiveDraft {
  itemId: string;
  reason: string;
  remainingStock: number;
}

interface PostHopTabLinkDraft {
  continuedFromSessionIds: string[];
  candidateTabIds: string[];
  selectedTabId: string;
}

interface NormalizedBillRegisterState {
  bills: Bill[];
  relatedBills: Bill[];
  payments: Payment[];
  nextCursor?: NormalizedBillRegisterCursor;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  loaded: boolean;
  queryKey: string;
}

interface NormalizedCustomerSearchState {
  query: string;
  customers: Customer[];
  loading: boolean;
  error: string;
}

interface NormalizedCustomerHistoryState extends NormalizedCustomerHistoryData {
  loading: boolean;
  error: string;
  loaded: boolean;
}

interface NormalizedReportState extends NormalizedReportData {
  loading: boolean;
  error: string;
  loaded: boolean;
  queryKey: string;
}

interface AnalyticsSummaryState {
  data: AnalyticsSummaryData | null;
  loading: boolean;
  error: string;
  loaded: boolean;
  queryKey: string;
  dataQueryKey: string;
}

interface InventoryReportSummaryState {
  data: InventoryReportModel | null;
  loading: boolean;
  error: string;
  loaded: boolean;
  queryKey: string;
  dataQueryKey: string;
}

function createEmptyNormalizedBillRegisterState(): NormalizedBillRegisterState {
  return {
    bills: [],
    relatedBills: [],
    payments: [],
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: "",
    loaded: false,
    queryKey: "{}"
  };
}

function createEmptyNormalizedCustomerSearchState(): NormalizedCustomerSearchState {
  return {
    query: "",
    customers: [],
    loading: false,
    error: ""
  };
}

function createEmptyNormalizedCustomerHistoryState(): NormalizedCustomerHistoryState {
  return { customers: [], bills: [], payments: [], billVisitAt: {}, loading: false, error: "", loaded: false };
}

function createEmptyNormalizedReportState(): NormalizedReportState {
  return {
    bills: [],
    payments: [],
    expenses: [],
    billBusinessDates: {},
    loading: false,
    error: "",
    loaded: false,
    queryKey: "{}"
  };
}

function createEmptyAnalyticsSummaryState(): AnalyticsSummaryState {
  return {
    data: null,
    loading: false,
    error: "",
    loaded: false,
    queryKey: "{}",
    dataQueryKey: "{}"
  };
}

function createEmptyInventoryReportSummaryState(): InventoryReportSummaryState {
  return {
    data: null,
    loading: false,
    error: "",
    loaded: false,
    queryKey: "{}",
    dataQueryKey: "{}"
  };
}

function mergeBillsById(primary: Bill[], fallback: Bill[]): Bill[] {
  const map = new Map(fallback.map((bill) => [bill.id, bill]));
  primary.forEach((bill) => map.set(bill.id, bill));
  return Array.from(map.values());
}

function mergePaymentsById(primary: Payment[], fallback: Payment[]): Payment[] {
  const map = new Map(fallback.map((payment) => [payment.id, payment]));
  primary.forEach((payment) => map.set(payment.id, payment));
  return Array.from(map.values());
}

function mergeRecordsById<T extends { id: string }>(primary: T[], fallback: T[]): T[] {
  const map = new Map(fallback.map((entry) => [entry.id, entry]));
  primary.forEach((entry) => map.set(entry.id, entry));
  return Array.from(map.values());
}

function createComboDraft(): ComboPackage {
  const now = new Date().toISOString();
  return {
    id: "",
    name: "",
    type: "game",
    active: true,
    stationIds: [],
    price: 0,
    includedMinutes: 60,
    fixedItems: [],
    choiceGroups: [],
    createdAt: now,
    updatedAt: now
  };
}

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

function getOperationalAttentionMessage(mutation: OperationalMutation) {
  const reason = mutation.failureReason ?? (
    mutation.status === "conflict"
      ? "Conflicts with the latest server data."
      : "Unable to sync this pending operation."
  );
  return `${mutation.label}: ${reason}`;
}

function showLiveSyncAlert(message: string) {
  if (!message.trim()) {
    return;
  }
  window.alert(message);
}

export default function App() {
  const backendConfigured = isBackendConfigured();
  setFullAppDataCacheEnabled(!backendConfigured);
  const [appData, setAppData] = useState<AppData>(() =>
    normalizeAppDataCustomers(loadAppData({ useStoredCache: !backendConfigured }))
  );
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const now = useClock();
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(backendConfigured);
  const [remoteRestoreState, setRemoteRestoreState] = useState<RemoteRestoreState>(backendConfigured ? "checking" : "ready");
  const [restoreRetrySignal, setRestoreRetrySignal] = useState(0);
  const [hasCachedAppData] = useState(() => hasStoredAppData({ useStoredCache: !backendConfigured }));
  const [remoteError, setRemoteError] = useState("");
  const [remoteVersion, setRemoteVersion] = useState(0);
  const [remoteSaving, setRemoteSaving] = useState(false);
  const [blockingActionLabel, setBlockingActionLabel] = useState<string | null>(null);
  const [pendingOperationalMutations, setPendingOperationalMutations] = useState<OperationalMutation[]>(() =>
    loadPendingOperationalMutations()
  );
  const [lastOperationalSyncAt, setLastOperationalSyncAt] = useState<string | null>(null);
  const [startSessionDraft, setStartSessionDraft] = useState<StartSessionDraft>({
    stationId: "",
    customerName: "",
    customerPhone: "",
    playMode: "group",
    arcadeItemId: "",
    arcadeQuantity: 1,
    comboId: "",
    comboChoices: {}
  });
  const [showStartSessionModal, setShowStartSessionModal] = useState(false);
  const [manageSessionId, setManageSessionId] = useState<string | null>(null);
  const [checkoutState, setCheckoutState] = useState<CheckoutState | null>(null);
  const [isHopMode, setIsHopMode] = useState(false);
  const [lastHoppedSessionId, setLastHoppedSessionId] = useState<string | null>(null);
  const [postHopContinuationMode, setPostHopContinuationMode] = useState<PostHopContinuationMode>("gaming");
  const [postHopCustomerLocked, setPostHopCustomerLocked] = useState(true);
  const [postHopTabLinkDraft, setPostHopTabLinkDraft] = useState<PostHopTabLinkDraft | null>(null);
  const [customerTabSearch, setCustomerTabSearch] = useState("");
  const [customerProfileSearch, setCustomerProfileSearch] = useState("");
  const [customerProfileSort, setCustomerProfileSort] = useState<"last_visit" | "total_spend" | "visit_count">("last_visit");
  const [inventoryItemSearch, setInventoryItemSearch] = useState("");
  const [inventoryArchiveView, setInventoryArchiveView] = useState<InventoryArchiveView>("active");
  const [inventoryArchiveDraft, setInventoryArchiveDraft] = useState<InventoryArchiveDraft | null>(null);
  const [activeInventoryPanelView, setActiveInventoryPanelView] = useState<InventoryPanelView>("catalog");
  const [inventoryReportSearch, setInventoryReportSearch] = useState("");
  const [debouncedInventoryReportSearch, setDebouncedInventoryReportSearch] = useState("");
  const [comboDraft, setComboDraft] = useState<ComboPackage>(() => createComboDraft());
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
  const [replacementItemForm, setReplacementItemForm] = useState({ sellableOptionId: "", quantity: 1 });
  const [sessionItemForm, setSessionItemForm] = useState<SessionItemFormState>({});
  const [selectedReceiptBillId, setSelectedReceiptBillId] = useState<string | null>(null);
  const [billRegisterFocus, setBillRegisterFocus] = useState<{ token: number; search: string } | null>(null);
  const [normalizedBillRegisterQuery, setNormalizedBillRegisterQuery] = useState<BillRegisterServerQuery>({});
  const [normalizedBillRegisterState, setNormalizedBillRegisterState] = useState<NormalizedBillRegisterState>(
    createEmptyNormalizedBillRegisterState
  );
  const [normalizedBillRegisterRefreshSignal, setNormalizedBillRegisterRefreshSignal] = useState(0);
  const [customerSuggestionQuery, setCustomerSuggestionQuery] = useState("");
  const [normalizedCustomerSearchState, setNormalizedCustomerSearchState] = useState<NormalizedCustomerSearchState>(
    createEmptyNormalizedCustomerSearchState
  );
  const [normalizedCustomerHistoryState, setNormalizedCustomerHistoryState] = useState<NormalizedCustomerHistoryState>(
    createEmptyNormalizedCustomerHistoryState
  );
  const [normalizedCustomerHistoryRefreshSignal, setNormalizedCustomerHistoryRefreshSignal] = useState(0);
  const [normalizedReportState, setNormalizedReportState] = useState<NormalizedReportState>(
    createEmptyNormalizedReportState
  );
  const [analyticsSummaryState, setAnalyticsSummaryState] = useState<AnalyticsSummaryState>(
    createEmptyAnalyticsSummaryState
  );
  const [inventoryReportSummaryState, setInventoryReportSummaryState] = useState<InventoryReportSummaryState>(
    createEmptyInventoryReportSummaryState
  );
  const [normalizedReportRefreshSignal, setNormalizedReportRefreshSignal] = useState(0);
  const [inventoryReportRefreshSignal, setInventoryReportRefreshSignal] = useState(0);
  const receiptPreviewBlockRef = useRef<HTMLDivElement | null>(null);
  const [, setReceiptPreviewBlockHeight] = useState<number | null>(null);
  const skipRemotePersistRef = useRef(false);
  const remoteSaveTimerRef = useRef<number | null>(null);
  const appDataRef = useRef(appData);
  const remoteVersionRef = useRef(remoteVersion);
  const pendingOperationalMutationsRef = useRef(pendingOperationalMutations);
  const operationalSyncTimerRef = useRef<number | null>(null);
  const operationalSyncInFlightRef = useRef(false);
  const criticalOperationalActionsRef = useRef<Set<string>>(new Set());
  const operationalMutationAcknowledgementsRef = useRef<ReturnType<
    typeof createOperationalMutationAcknowledgementRegistry
  > | null>(null);
  if (!operationalMutationAcknowledgementsRef.current) {
    operationalMutationAcknowledgementsRef.current = createOperationalMutationAcknowledgementRegistry();
  }
  const alertedOperationalMutationIdsRef = useRef<Set<string>>(new Set());
  const lastCheckoutPendingSyncAlertKeyRef = useRef<string | null>(null);
  const financialAdjustmentMutationIdsRef = useRef<Map<string, string>>(new Map());
  const todayDateKey = toLocalDateKey(new Date());
  const [reportFilter, setReportFilter] = useState<ReportFilterState>({
    preset: "today",
    fromDate: todayDateKey,
    toDate: todayDateKey
  });
  const [inventoryReportFilter, setInventoryReportFilter] = useState<InventoryReportFilterState>({
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
    active: true,
    sellBaseItem: true,
    saleVariants: []
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
  const [voidPendingGroupDraft, setVoidPendingGroupDraft] = useState<VoidPendingGroupDraft | null>(null);
  const [voidRefundDraft, setVoidRefundDraft] = useState<{
    billId: string;
    reason: string;
    action: "void" | "refund";
  } | null>(null);
  const [pendingWarningDraft, setPendingWarningDraft] = useState<{
    pendingBills: Bill[];
    customerLabel: string;
    intent:
      | { type: "session"; draftValue: StartSessionDraft }
      | { type: "tab"; draftValue: CustomerTabDraft; options?: { updateSaleDraft?: boolean; clearDraft?: boolean; switchToSale?: boolean; continuedFromSessionIds?: string[]; onSuccess?: () => void } };
  } | null>(null);
  const [expenseForm, setExpenseForm] = useState({
    title: "",
    category: "Utilities",
    amount: 0,
    paymentMode: "cash" as ExpensePaymentMode,
    cashAmount: 0,
    upiAmount: 0,
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
  const [pendingBackfillTemplate, setPendingBackfillTemplate] = useState<ExpenseTemplateOverride["templateId"] | null>(null);
  const [editingPauseLogId, setEditingPauseLogId] = useState<string | null>(null);
  const [pauseLogEditDraft, setPauseLogEditDraft] = useState<{ pausedAt: string; resumedAt: string }>({ pausedAt: "", resumedAt: "" });
  const [pauseLogDeleteConfirmId, setPauseLogDeleteConfirmId] = useState<string | null>(null);
  const [pendingRetryData, setPendingRetryData] = useState<AppData | null>(null);
  const activeInventoryItems = getActiveInventoryItems(appData.inventoryItems);
  const archivedInventoryItems = getArchivedInventoryItems(appData.inventoryItems);
  const visibleInventoryItems = inventoryArchiveView === "archived" ? archivedInventoryItems : activeInventoryItems;
  const filteredInventoryItems = visibleInventoryItems.filter((item) =>
    `${item.name} ${item.category}`.toLowerCase().includes(inventoryItemSearch.trim().toLowerCase())
  );
  const remoteReadOnly =
    backendConfigured && (remoteRestoreState === "stale-cache" || remoteRestoreState === "retrying");
  const remoteReadOnlyMessage =
    "Latest remote data is still loading. Cached data is read-only until sync recovers.";

  function retryRemoteRestore() {
    setRemoteError("");
    setRestoreRetrySignal((previous) => previous + 1);
  }

  function guardRemoteWrite(): boolean {
    if (!remoteReadOnly) {
      return true;
    }
    setRemoteError(remoteReadOnlyMessage);
    return false;
  }

  function getRestoreRecoveryMessage() {
    if (remoteError) {
      return remoteError;
    }
    if (remoteRestoreState === "retrying") {
      return "Checking the remote backend again. Your Supabase session is still being preserved.";
    }
    if (hasCachedAppData) {
      return "Your Supabase session is still active, but the cached user profile cannot be opened safely. Retry remote restore or sign out.";
    }
    return "Your Supabase session is still active, but no usable cached app data is available. Retry remote restore or sign out.";
  }

  function updatePendingOperationalMutations(
    nextValue:
      | OperationalMutation[]
      | ((previous: OperationalMutation[]) => OperationalMutation[])
  ) {
    const nextMutations =
      typeof nextValue === "function"
        ? (nextValue as (previous: OperationalMutation[]) => OperationalMutation[])(pendingOperationalMutationsRef.current)
        : nextValue;
    pendingOperationalMutationsRef.current = nextMutations;
    setPendingOperationalMutations(nextMutations);
    savePendingOperationalMutations(nextMutations);
  }

  function dedupeOperationalMutations(mutations: OperationalMutation[]) {
    const seen = new Set<string>();
    return mutations.filter((mutation) => {
      if (seen.has(mutation.id)) {
        return false;
      }
      seen.add(mutation.id);
      return true;
    });
  }

  function isSameCustomerTabQuantityMutation(candidate: OperationalMutation, nextMutation: OperationalMutation) {
    if (candidate.kind !== "updateCustomerTabItemQuantity" || nextMutation.kind !== "updateCustomerTabItemQuantity") {
      return false;
    }
    const candidatePayload = candidate.payload as { customerTabId?: string; lineId?: string };
    const nextPayload = nextMutation.payload as { customerTabId?: string; lineId?: string };
    return (
      candidate.entityType === nextMutation.entityType &&
      candidate.entityId === nextMutation.entityId &&
      candidatePayload.customerTabId === nextPayload.customerTabId &&
      candidatePayload.lineId === nextPayload.lineId
    );
  }

  function appendPendingOperationalMutation(previous: OperationalMutation[], mutation: OperationalMutation) {
    if (mutation.kind !== "updateCustomerTabItemQuantity") {
      return [...previous, mutation];
    }
    return [
      ...previous.filter(
        (candidate) =>
          candidate.status === "syncing" ||
          !isSameCustomerTabQuantityMutation(candidate, mutation)
      ),
      mutation
    ];
  }

  function getOperationalErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Unable to sync this pending operation.";
  }

  function isOperationalBusinessConflict(error: unknown) {
    const code = error instanceof OperationalRpcError ? error.code : undefined;
    return code ? !/^[A-Z0-9]{5}$/i.test(code) : false;
  }

  function getFirstChangedRowId(result: OperationalRpcCommitResult, collectionName: string) {
    const changedRows = result.changedRows ?? {};
    const collection = changedRows[collectionName];
    return Array.isArray(collection) && typeof collection[0] === "string" ? collection[0] : undefined;
  }

  function getCustomerTabLineIdReconciliation(mutation: OperationalMutation, result: OperationalRpcCommitResult) {
    if (mutation.kind !== "addCustomerTabItem") {
      return null;
    }
    const payload = mutation.payload as { customerTabId?: string; line?: CustomerTabItem };
    const localLineId = payload.line?.id;
    const serverLineId = getFirstChangedRowId(result, "customer_tab_items");
    if (!payload.customerTabId || !localLineId || !serverLineId || serverLineId === localLineId) {
      return null;
    }
    return {
      customerTabId: payload.customerTabId,
      localLineId,
      serverLineId
    };
  }

  function isCustomerTabLineReferenceMutation(
    mutation: OperationalMutation
  ): mutation is OperationalMutation & {
    kind: "updateCustomerTabItemQuantity" | "removeCustomerTabItem";
    payload: { customerTabId: string; lineId: string };
  } {
    return mutation.kind === "updateCustomerTabItemQuantity" || mutation.kind === "removeCustomerTabItem";
  }

  function rewriteCustomerTabLineReference(
    mutation: OperationalMutation,
    lineReconciliation: { customerTabId: string; localLineId: string; serverLineId: string }
  ): OperationalMutation {
    if (!isCustomerTabLineReferenceMutation(mutation)) {
      return mutation;
    }
    if (mutation.payload.customerTabId !== lineReconciliation.customerTabId ||
      mutation.payload.lineId !== lineReconciliation.localLineId) {
      return mutation;
    }
    return {
      ...mutation,
      payload: {
        ...mutation.payload,
        lineId: lineReconciliation.serverLineId
      }
    };
  }

  function reconcileOperationalRpcResult(
    source: AppData,
    mutation: OperationalMutation,
    result: OperationalRpcCommitResult
  ) {
    const identityReconciledSource = reconcileOperationalServerIdentity(
      source,
      mutation,
      result.changedRows
    );
    const lineReconciliation = getCustomerTabLineIdReconciliation(mutation, result);
    if (!lineReconciliation) {
      return identityReconciledSource;
    }
    const sourceTab = identityReconciledSource.customerTabs.find((tab) => tab.id === lineReconciliation.customerTabId);
    const sourceLine = sourceTab?.items.find((line) => line.id === lineReconciliation.localLineId);
    if (!sourceTab || !sourceLine) {
      return identityReconciledSource;
    }

    const nextAppData = cloneValue(identityReconciledSource);
    const tab = nextAppData.customerTabs.find((entry) => entry.id === lineReconciliation.customerTabId);
    if (!tab) {
      return identityReconciledSource;
    }
    const localLine = tab.items.find((line) => line.id === lineReconciliation.localLineId);
    const serverLine = tab.items.find((line) => line.id === lineReconciliation.serverLineId);
    if (!localLine) {
      return identityReconciledSource;
    }
    if (serverLine) {
      serverLine.quantity += localLine.quantity;
      tab.items = tab.items.filter((line) => line.id !== lineReconciliation.localLineId);
    } else {
      localLine.id = lineReconciliation.serverLineId;
    }
    return nextAppData;
  }

  const applyRemoteSnapshotWithPending = useCallback((snapshot: RemoteAppDataSnapshot) => {
    const activePending = pendingOperationalMutationsRef.current.filter(
      (mutation) => mutation.status !== "conflict" && mutation.id !== snapshot.sourceMutationId
    );
    const normalizedRemoteData = normalizeAppDataCustomers(snapshot.appData);
    const rebased = rebasePendingMutations(normalizedRemoteData, activePending);
    const nextMutations = [
      ...rebased.pendingMutations,
      ...rebased.conflicts,
      ...pendingOperationalMutationsRef.current.filter((mutation) => mutation.status === "conflict")
    ];
    pendingOperationalMutationsRef.current = nextMutations;
    setPendingOperationalMutations(nextMutations);
    savePendingOperationalMutations(nextMutations);
    skipRemotePersistRef.current = true;
    appDataRef.current = rebased.appData;
    setAppData(rebased.appData);
    saveAppData(rebased.appData);
    remoteVersionRef.current = snapshot.version;
    setRemoteVersion(snapshot.version);
    if (snapshot.refreshedSlices?.includes("bills")) {
      setNormalizedBillRegisterRefreshSignal((previous) => previous + 1);
    }
    if (rebased.conflicts.length > 0) {
      setRemoteError(getOperationalConflictMessages(rebased.conflicts).join(" "));
    }
  }, []);

  useEffect(() => {
    setFullAppDataCacheEnabled(!backendConfigured);
    if (backendConfigured) {
      clearStoredAppData();
    }
  }, [backendConfigured]);

  useEffect(() => {
    appDataRef.current = appData;
  }, [appData]);

  useEffect(() => {
    remoteVersionRef.current = remoteVersion;
  }, [remoteVersion]);

  useEffect(() => {
    pendingOperationalMutationsRef.current = pendingOperationalMutations;
    savePendingOperationalMutations(pendingOperationalMutations);
  }, [pendingOperationalMutations]);

  useEffect(() => {
    if (!isHopMode || checkoutState?.mode !== "session" || !checkoutState.sessionId) {
      return;
    }
    const hoppedSession = appData.sessions.find((session) => session.id === checkoutState.sessionId);
    if (
      !hoppedSession ||
      hoppedSession.status !== "closed" ||
      hoppedSession.closeDisposition !== "hopped" ||
      hoppedSession.closedBillId
    ) {
      return;
    }
    const continuationConsumed =
      appData.sessions.some((session) => session.continuedFromSessionIds?.includes(hoppedSession.id)) ||
      appData.customerTabs.some((tab) => tab.continuedFromSessionIds?.includes(hoppedSession.id));
    if (continuationConsumed) {
      setCheckoutState(null);
      setIsHopMode(false);
      return;
    }
    setCheckoutState(null);
    setIsHopMode(false);
    setLastHoppedSessionId(hoppedSession.id);
    setPostHopContinuationMode("gaming");
    setPostHopCustomerLocked(true);
    setStartSessionDraft((previous) => ({
      ...previous,
      customerId: hoppedSession.customerId,
      customerName: hoppedSession.customerName ?? "",
      customerPhone: hoppedSession.customerPhone ?? ""
    }));
    setShowStartSessionModal(true);
  }, [appData.customerTabs, appData.sessions, checkoutState, isHopMode]);

  useEffect(() => {
    const attentionMutations = pendingOperationalMutations.filter(
      (mutation) =>
        (mutation.status === "failed" || mutation.status === "conflict") &&
        !mutation.acknowledgementRequired &&
        !alertedOperationalMutationIdsRef.current.has(mutation.id)
    );
    if (attentionMutations.length === 0) {
      return;
    }
    attentionMutations.forEach((mutation) => alertedOperationalMutationIdsRef.current.add(mutation.id));
    showLiveSyncAlert(`Live action could not sync:\n\n${attentionMutations.map(getOperationalAttentionMessage).join("\n\n")}`);
  }, [pendingOperationalMutations]);

  useEffect(() => {
    const entity =
      checkoutState?.mode === "session" && checkoutState.sessionId
        ? { type: "session" as const, id: checkoutState.sessionId, label: "this session" }
        : checkoutState?.mode === "customer_tab" && checkoutState.customerTabId
          ? { type: "customer_tab" as const, id: checkoutState.customerTabId, label: "this customer tab" }
          : null;
    if (!entity) {
      lastCheckoutPendingSyncAlertKeyRef.current = null;
      return;
    }
    const pendingForCheckout = pendingOperationalMutations.filter(
      (mutation) =>
        mutation.entityType === entity.type &&
        mutation.entityId === entity.id &&
        (mutation.status === "pending" || mutation.status === "syncing" || mutation.status === "failed")
    );
    if (pendingForCheckout.length === 0) {
      lastCheckoutPendingSyncAlertKeyRef.current = null;
      return;
    }
    const alertKey = `${entity.type}:${entity.id}:${pendingForCheckout.map((mutation) => mutation.id).join("|")}`;
    if (lastCheckoutPendingSyncAlertKeyRef.current === alertKey) {
      return;
    }
    lastCheckoutPendingSyncAlertKeyRef.current = alertKey;
    showLiveSyncAlert(
      `Live changes for ${entity.label} are still syncing with the server. Please wait until Live actions shows Synced before issuing the bill, hopping, rejecting, or closing it.`
    );
  }, [checkoutState, pendingOperationalMutations]);

  useAppSync({
    backendConfigured,
    online,
    activeUserId,
    appData,
    remoteLoading,
    remoteReadOnly,
    remoteRestoreState,
    restoreRetrySignal,
    hasCachedAppData,
    remoteVersion,
    allowFullAppDataPersist: !BACKEND_FEATURE_FLAGS.normalizedBootstrap,
    skipRemotePersistRef,
    remoteSaveTimerRef,
    setAppData,
    setActiveUserId,
    setRemoteVersion,
    setRemoteLoading,
    setRemoteError,
    setRemoteSaving,
    setRemoteRestoreState,
    setRestoreRetrySignal,
    setActiveTab,
    applyRemoteSnapshot: applyRemoteSnapshotWithPending
  });

  useEffect(() => {
    if (online && activeUserId && backendConfigured) {
      scheduleOperationalSync(0);
    }
  }, [activeUserId, backendConfigured, online]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshRemoteState(options?: { keepUser?: boolean }) {
    const snapshot = await defaultRemoteDataGateway.loadAppDataSnapshot();
    skipRemotePersistRef.current = true;
    setAppData(normalizeAppDataCustomers(snapshot.appData));
    setRemoteVersion(snapshot.version);
    setRemoteRestoreState("ready");
    setRemoteError("");
    if (!options?.keepUser) {
      const profile = await fetchCurrentProfile();
      setActiveUserId(profile?.id ?? null);
    }
  }

  async function saveRemoteSnapshot(
    nextAppData: AppData,
    expectedVersion = remoteVersion,
    isRetry = false,
    actionLabel = "Blocking app data save"
  ) {
    if (!activeUserId) {
      return;
    }
    if (remoteReadOnly) {
      setRemoteError(remoteReadOnlyMessage);
      throw new Error(remoteReadOnlyMessage);
    }
    setRemoteSaving(true);
    try {
      const nextVersion = await defaultRemoteDataGateway.saveAppData(nextAppData, activeUserId, expectedVersion, {
        actionLabel: isRetry ? `${actionLabel} retry` : actionLabel,
        source: "blocking"
      });
      setRemoteVersion(nextVersion);
      setRemoteError("");
      setPendingRetryData(null);
    } catch (error) {
      await refreshRemoteState({ keepUser: true });
      const isVersionConflict =
        error instanceof Error && error.message.toLowerCase().includes("remote data changed");
      if (isVersionConflict && !isRetry) {
        setPendingRetryData(nextAppData);
        setRemoteError("Another device updated this data. Your changes were not saved.");
      } else {
        const message =
          isRetry
            ? "Could not save - please check the latest data and try again."
            : error instanceof Error
              ? error.message
              : "Remote data changed in another browser. Please retry after the latest data loads.";
        setRemoteError(message);
        setPendingRetryData(null);
      }
      throw error;
    } finally {
      setRemoteSaving(false);
    }
  }

  useEffect(() => {
    setBusinessDraft(appData.businessProfile);
  }, [appData.businessProfile]);

  // One-time migration: create session_reservation audit movements for items that were already in
  // open sessions before this feature shipped. Runs once per device via localStorage flag.
  useEffect(() => {
    if (!activeUserId) return;
    if (backendConfigured && BACKEND_FEATURE_FLAGS.normalizedBootstrap) return;
    const flagKey = "inv_reservation_migrated_v1";
    if (localStorage.getItem(flagKey)) return;
    const openSessions = appData.sessions.filter((s) => s.status !== "closed");
    if (openSessions.length === 0) {
      try {
        localStorage.setItem(flagKey, "1");
      } catch {
        // The migration flag is a best-effort local cache marker.
      }
      return;
    }
    mutateAppData((draft) => {
      const now = new Date().toISOString();
      for (const session of draft.sessions.filter((s) => s.status !== "closed")) {
        for (const sessionItem of session.items) {
          const inventoryEntry = draft.inventoryItems.find((e) => e.id === sessionItem.inventoryItemId);
          if (!inventoryEntry || inventoryEntry.isReusable) continue;
          const alreadyHasReservation = draft.stockMovements.some(
            (m) => m.type === "session_reservation" && m.itemId === sessionItem.inventoryItemId
              && m.reason?.includes(session.stationNameSnapshot)
          );
          if (alreadyHasReservation) continue;
          const qty = getLineStockQuantity(sessionItem);
          draft.stockMovements.push({
            id: createId("stock"),
            itemId: sessionItem.inventoryItemId,
            type: "session_reservation",
            quantity: -qty,
            reason: `Reserved for ${session.stationNameSnapshot} (migrated)`,
            createdAt: now,
            userId: activeUserId
          });
        }
      }
    });
    try {
      localStorage.setItem(flagKey, "1");
    } catch {
      // The migration flag is a best-effort local cache marker.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUserId]);

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
  const normalizedBillHistoryReadsEnabled = backendConfigured && BACKEND_FEATURE_FLAGS.normalizedBillHistoryReads;
  const normalizedCustomerSearchReadsEnabled = backendConfigured && BACKEND_FEATURE_FLAGS.normalizedCustomerSearchReads;
  const normalizedCustomerHistoryReadsEnabled = backendConfigured && (BACKEND_FEATURE_FLAGS.normalizedBootstrap || BACKEND_FEATURE_FLAGS.normalizedCustomerSearchReads);
  const normalizedReportReadsEnabled = backendConfigured && BACKEND_FEATURE_FLAGS.normalizedReportReads;
  const analyticsSummaryReadsEnabled = backendConfigured && BACKEND_FEATURE_FLAGS.analyticsSummaryReads;
  const inventoryReportReadsEnabled = backendConfigured && BACKEND_FEATURE_FLAGS.inventoryReportReads;
  const canEditInventory = activeUser?.role === "admin";
  const canCreateExpenses = activeUser?.role === "admin" || activeUser?.role === "manager";
  const canDeleteExpenses = activeUser?.role === "admin";
  const canManageExpenseTemplates = activeUser?.role === "admin";
  const canEditSettings = activeUser?.role === "admin";
  const canManageUsers = activeUser?.role === "admin";
  const canVoidRefundBills = activeUser?.role === "admin";
  const canReplaceIssuedBills = activeUser?.role === "admin";
  const canSettlePendingBills = activeUser?.role === "admin" || activeUser?.role === "manager" || activeUser?.role === "receptionist";
  const canEditSessionTiming = activeUser?.role === "admin";
  const canEditSessionCustomerDetails = activeUser?.role === "admin" || activeUser?.role === "manager" || activeUser?.role === "receptionist"; // all roles: admin, manager, receptionist can edit customer details
  const isManagerReadOnly = activeUser?.role === "manager";
  const pageTitle =
    activeTab === "sale"
      ? "Consumables Tab"
      : visibleTabs.find((tab) => tab.id === activeTab)?.label ?? "Game Parlour";
  const stations = [...appData.stations.filter((station) => station.active)].sort((a, b) =>
    (getActiveSessionForStation(b.id) ? 1 : 0) - (getActiveSessionForStation(a.id) ? 1 : 0)
  );
  const activeSessions = appData.sessions.filter((session) => session.status !== "closed");
  const openCustomerTabs = appData.customerTabs.filter((tab) => tab.status === "open");
  const selectedCustomerTab = resolveCustomerTabWorkspaceSelection(openCustomerTabs, selectedCustomerTabId);
  // Build O(1) index maps so getBillBusinessDate is O(n) total, not O(n^2).
  const sessionById = new Map(appData.sessions.map((s) => [s.id, s]));
  const tabByBillId = new Map(
    appData.customerTabs.filter((t) => t.closedBillId).map((t) => [t.closedBillId!, t])
  );
  // Revenue is attributed to the business day of the session/tab start time,
  // not the bill issue time. Bills issued after midnight (before 7 AM) belong
  // to the previous business day.
  function getBillBusinessDate(bill: Bill): string {
    const session = bill.sessionId ? sessionById.get(bill.sessionId) : undefined;
    if (session) return toBusinessDayKey(session.startedAt);
    const tab = tabByBillId.get(bill.id);
    if (tab) return toBusinessDayKey(tab.createdAt);
    return toBusinessDayKey(bill.issuedAt);
  }
  // Precomputed map: billId -> business date key. Built once per render so
  // downstream consumers (BillRegisterPanel, topbar metric) don't re-derive it.
  const billBusinessDates: Record<string, string> = {};
  for (const bill of appData.bills) {
    billBusinessDates[bill.id] = getBillBusinessDate(bill);
  }
  const billPaymentBusinessDates: Record<string, string[]> = {};
  for (const payment of appData.payments) {
    const dates = billPaymentBusinessDates[payment.billId] ?? [];
    dates.push(toBusinessDayKey(payment.createdAt));
    billPaymentBusinessDates[payment.billId] = dates;
  }
  const currentBusinessDay = toBusinessDayKey(now);
  const resolvedReportRange = getReportRange(reportFilter, now);
  const reportFromDate = resolvedReportRange.from <= resolvedReportRange.to ? resolvedReportRange.from : resolvedReportRange.to;
  const reportToDate = resolvedReportRange.from <= resolvedReportRange.to ? resolvedReportRange.to : resolvedReportRange.from;
  const previousRange = getPreviousRange(reportFromDate, reportToDate);
  const normalizedReportQueryKey = useMemo(
    () =>
      JSON.stringify({
        fromDate: reportFromDate,
        toDate: reportToDate,
        previousFromDate: previousRange.from,
        previousToDate: previousRange.to,
        refresh: normalizedReportRefreshSignal
      }),
    [normalizedReportRefreshSignal, previousRange.from, previousRange.to, reportFromDate, reportToDate]
  );
  const resolvedInventoryReportRange = getInventoryReportRange(inventoryReportFilter, now);
  const inventoryReportFromDate = resolvedInventoryReportRange.from <= resolvedInventoryReportRange.to ? resolvedInventoryReportRange.from : resolvedInventoryReportRange.to;
  const inventoryReportToDate = resolvedInventoryReportRange.from <= resolvedInventoryReportRange.to ? resolvedInventoryReportRange.to : resolvedInventoryReportRange.from;
  const clientInventoryReportModel = buildInventoryReportModel(
    appData.inventoryItems,
    appData.stockMovements,
    appData.sessions,
    appData.customerTabs,
    appData.bills,
    inventoryReportFromDate,
    inventoryReportToDate
  );
  const filteredClientInventoryReportModel = filterInventoryReportModel(clientInventoryReportModel, inventoryReportSearch);
  const inventoryReportQueryKey = useMemo(
    () =>
      JSON.stringify({
        fromDate: inventoryReportFromDate,
        toDate: inventoryReportToDate,
        search: debouncedInventoryReportSearch.trim(),
        refresh: inventoryReportRefreshSignal
      }),
    [debouncedInventoryReportSearch, inventoryReportFromDate, inventoryReportRefreshSignal, inventoryReportToDate]
  );
  const inventoryReportDataReady =
    inventoryReportReadsEnabled &&
    inventoryReportSummaryState.loaded &&
    !inventoryReportSummaryState.error &&
    !!inventoryReportSummaryState.data &&
    inventoryReportSummaryState.dataQueryKey === inventoryReportQueryKey;
  const inventoryReportModel = inventoryReportDataReady
    ? inventoryReportSummaryState.data!
    : filteredClientInventoryReportModel;
  const normalizedReportDataReady =
    normalizedReportReadsEnabled &&
    normalizedReportState.loaded &&
    !normalizedReportState.error &&
    normalizedReportState.queryKey === normalizedReportQueryKey;
  const analyticsSummaryDataReady =
    analyticsSummaryReadsEnabled &&
    isAnalyticsSummaryDataReady(analyticsSummaryState, normalizedReportQueryKey);
  const analyticsSummaryData = analyticsSummaryDataReady ? analyticsSummaryState.data : null;
  const financialReportDataReady =
    (!analyticsSummaryReadsEnabled || analyticsSummaryDataReady) &&
    (!normalizedReportReadsEnabled || normalizedReportDataReady);
  const financialReportLoading =
    (analyticsSummaryReadsEnabled && analyticsSummaryState.loading) ||
    (normalizedReportReadsEnabled && normalizedReportState.loading);
  const financialReportError =
    (analyticsSummaryReadsEnabled ? analyticsSummaryState.error : "") ||
    (normalizedReportReadsEnabled ? normalizedReportState.error : "");
  const reportSourceBills = normalizedReportReadsEnabled ? normalizedReportState.bills : appData.bills;
  const reportSourcePayments = normalizedReportReadsEnabled ? normalizedReportState.payments : appData.payments;
  const reportSourceExpenses = normalizedReportReadsEnabled ? normalizedReportState.expenses : appData.expenses;
  const reportBillBusinessDates = normalizedReportReadsEnabled ? normalizedReportState.billBusinessDates : billBusinessDates;
  const filteredBills = reportSourceBills.filter((bill) => {
    const billDate = reportBillBusinessDates[bill.id] ?? toBusinessDayKey(bill.issuedAt);
    return billDate >= reportFromDate && billDate <= reportToDate;
  });
  const filteredExpenses = reportSourceExpenses.filter((expense) => {
    const expenseDate = toLocalDateKey(expense.spentAt);
    return expenseDate >= reportFromDate && expenseDate <= reportToDate;
  });
  const dashboardRevenueCountedPayments = getRevenueCountedPayments(appData.bills, appData.payments);
  const reportRevenueCountedPayments = getRevenueCountedPayments(reportSourceBills, reportSourcePayments);
  const filteredRevenuePayments = filterPaymentsByBusinessDate(reportRevenueCountedPayments, reportFromDate, reportToDate);
  const expenseCategoryOptions = Array.from(
    new Set([
      ...DEFAULT_EXPENSE_CATEGORIES,
      ...reportSourceExpenses.map((expense) => expense.category),
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
  const sellableInventoryOptions = useMemo(
    () => getSellableInventoryOptions(appData.inventoryItems),
    [appData.inventoryItems]
  );
  const sellableOptionById = useMemo(
    () => new Map(sellableInventoryOptions.map((option) => [option.id, option])),
    [sellableInventoryOptions]
  );
  const defaultArcadeInventoryItem = arcadeInventoryItems[0] ?? null;
  const normalizedCustomerHistoryReady =
    normalizedCustomerHistoryReadsEnabled && normalizedCustomerHistoryState.loaded && !normalizedCustomerHistoryState.error;
  const customerAnalyticsCustomers = normalizedCustomerHistoryReadsEnabled
    ? normalizedCustomerHistoryState.customers
    : appData.customers;
  const customerAnalyticsBills = normalizedCustomerHistoryReadsEnabled
    ? normalizedCustomerHistoryState.bills
    : appData.bills;
  const activeFinancialBills = customerAnalyticsBills.filter((bill) => bill.status === "issued" || bill.status === "pending");

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
      if (normalizedCustomerHistoryReadsEnabled) {
        return normalizedCustomerHistoryState.billVisitAt[bill.id] ?? bill.issuedAt;
      }
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

    for (const customer of customerAnalyticsCustomers) {
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
      const customer = customerAnalyticsCustomers.find((entry) => entry.id === bill.customerId);
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
      totalProfiles: customerAnalyticsCustomers.length,
      repeatCustomersCount: repeatCustomers.length,
      repeatRate: stats.length ? (repeatCustomers.length / stats.length) * 100 : 0,
      averageSpendPerCustomer: customerAnalyticsCustomers.length ? totalSpend / customerAnalyticsCustomers.length : 0,
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
      ? customerAnalyticsCustomers.find((customer) => customer.id === selectedCustomerProfileId)
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
      setSelectedCustomerTabId(openCustomerTabs.length === 1 ? openCustomerTabs[0].id : null);
    }
    if (!selectedCustomerTabId && openCustomerTabs.length === 1) {
      setSelectedCustomerTabId(openCustomerTabs[0].id);
    }
  }, [openCustomerTabs, selectedCustomerTabId]);

  useEffect(() => {
    if (selectedCustomerProfileId && !customerAnalyticsCustomers.some((customer) => customer.id === selectedCustomerProfileId)) {
      setSelectedCustomerProfileId(customerAnalytics.stats[0]?.customer.id ?? null);
      return;
    }
    if (!selectedCustomerProfileId && customerAnalytics.stats[0]) {
      setSelectedCustomerProfileId(customerAnalytics.stats[0].customer.id);
    }
  }, [customerAnalyticsCustomers, customerAnalytics.stats, selectedCustomerProfileId]);

  useEffect(() => {
    if (!activeUser) {
      return;
    }
    if (!canAccessTab(activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [activeTab, activeUser, canAccessTab, visibleTabs]);

  const normalizedBillRegisterQueryKey = useMemo(
    () => JSON.stringify(normalizedBillRegisterQuery),
    [normalizedBillRegisterQuery]
  );
  const normalizedBillRegisterQueryKeyRef = useRef(normalizedBillRegisterQueryKey);
  const normalizedBillRegisterGenerationRef = useRef(0);
  normalizedBillRegisterQueryKeyRef.current = normalizedBillRegisterQueryKey;
  const handleNormalizedBillRegisterQueryChange = useCallback((query: BillRegisterServerQuery) => {
    const nextKey = JSON.stringify(query);
    setNormalizedBillRegisterQuery((previous) => (JSON.stringify(previous) === nextKey ? previous : query));
  }, []);

  const hydrateNormalizedBillRegisterPage = useCallback((page: { bills: Bill[]; payments: Payment[] }) => {
    skipRemotePersistRef.current = true;
    setAppData((previous) => mergeNormalizedAppDataOverlay(previous, {
      bills: page.bills,
      payments: page.payments
    }));
  }, []);

  useEffect(() => {
    if (!normalizedCustomerHistoryReadsEnabled || activeTab !== "customers" || !activeUserId || !canAccessTab("customers")) {
      return;
    }
    let cancelled = false;
    setNormalizedCustomerHistoryState((previous) => ({ ...previous, loading: true, error: "" }));
    runQaControlledNormalizedRead("customers", () => loadNormalizedCustomerHistoryData())
      .then((data) => {
        if (!cancelled) setNormalizedCustomerHistoryState({ ...data, loading: false, error: "", loaded: true });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setNormalizedCustomerHistoryState({
            customers: [], bills: [], payments: [], billVisitAt: {}, loading: false,
            error: error instanceof Error ? error.message : "Unable to load normalized customer history.",
            loaded: false
          });
        }
      });
    return () => { cancelled = true; };
  }, [activeTab, activeUserId, canAccessTab, normalizedCustomerHistoryReadsEnabled, normalizedCustomerHistoryRefreshSignal]);

  useEffect(() => {
    if (!normalizedCustomerSearchReadsEnabled || !activeUserId) {
      return;
    }

    const query = customerSuggestionQuery.trim();
    if (!query) {
      setNormalizedCustomerSearchState(createEmptyNormalizedCustomerSearchState());
      return;
    }

    let cancelled = false;
    setNormalizedCustomerSearchState((previous) => ({
      ...previous,
      query,
      loading: true,
      error: ""
    }));

    const timeoutId = window.setTimeout(() => {
      loadNormalizedCustomerSearch({
        search: query,
        limit: CUSTOMER_SEARCH_PAGE_SIZE
      })
        .then((customers) => {
          if (cancelled) {
            return;
          }
          setNormalizedCustomerSearchState({
            query,
            customers,
            loading: false,
            error: ""
          });
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }
          setNormalizedCustomerSearchState({
            query,
            customers: [],
            loading: false,
            error: error instanceof Error ? error.message : "Unable to search normalized customers."
          });
        });
    }, CUSTOMER_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeUserId, customerSuggestionQuery, normalizedCustomerSearchReadsEnabled]);

  const customerAutocompleteSuggestions = useMemo<CustomerAutocompleteSuggestionProps | undefined>(() => {
    if (!normalizedCustomerSearchReadsEnabled) {
      return undefined;
    }
    return {
      serverSuggestionsEnabled: true,
      suggestionCustomers: normalizedCustomerSearchState.error ? undefined : normalizedCustomerSearchState.customers,
      suggestionQuery: normalizedCustomerSearchState.query,
      suggestionsLoading: normalizedCustomerSearchState.loading,
      suggestionsError: normalizedCustomerSearchState.error,
      onSuggestionQueryChange: setCustomerSuggestionQuery
    };
  }, [normalizedCustomerSearchReadsEnabled, normalizedCustomerSearchState]);

  useEffect(() => {
    if (!analyticsSummaryReadsEnabled || activeTab !== "reports" || !activeUserId || !canAccessTab("reports")) {
      return;
    }

    let cancelled = false;
    setAnalyticsSummaryState((previous) => ({
      ...previous,
      loading: true,
      error: "",
      queryKey: normalizedReportQueryKey
    }));

    runQaControlledNormalizedRead("reports", () => loadAnalyticsSummaryData({
      fromDate: reportFromDate,
      toDate: reportToDate,
      previousFromDate: previousRange.from,
      previousToDate: previousRange.to
    }))
      .then((data) => {
        if (cancelled) {
          return;
        }
        setAnalyticsSummaryState({
          data,
          loading: false,
          error: "",
          loaded: true,
          queryKey: normalizedReportQueryKey,
          dataQueryKey: normalizedReportQueryKey
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setAnalyticsSummaryState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load analytics summary data.",
          loaded: previous.loaded,
          queryKey: previous.queryKey,
          dataQueryKey: previous.dataQueryKey
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    activeUserId,
    analyticsSummaryReadsEnabled,
    canAccessTab,
    normalizedReportQueryKey,
    normalizedReportRefreshSignal,
    previousRange.from,
    previousRange.to,
    reportFromDate,
    reportToDate
  ]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedInventoryReportSearch(inventoryReportSearch.trim());
    }, 180);
    return () => window.clearTimeout(timeoutId);
  }, [inventoryReportSearch]);

  useEffect(() => {
    if (
      !inventoryReportReadsEnabled ||
      activeTab !== "inventory" ||
      activeInventoryPanelView !== "report" ||
      !activeUserId ||
      !canAccessTab("inventory")
    ) {
      return;
    }

    let cancelled = false;
    setInventoryReportSummaryState((previous) => ({
      ...previous,
      loading: true,
      error: "",
      queryKey: inventoryReportQueryKey
    }));

    runQaControlledNormalizedRead("inventory", () => loadInventoryReportSummaryData({
      fromDate: inventoryReportFromDate,
      toDate: inventoryReportToDate,
      searchQuery: debouncedInventoryReportSearch
    }))
      .then((data) => {
        if (cancelled) {
          return;
        }
        setInventoryReportSummaryState({
          data,
          loading: false,
          error: "",
          loaded: true,
          queryKey: inventoryReportQueryKey,
          dataQueryKey: inventoryReportQueryKey
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setInventoryReportSummaryState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load inventory report data.",
          loaded: previous.loaded,
          queryKey: previous.queryKey,
          dataQueryKey: previous.dataQueryKey
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeInventoryPanelView,
    activeTab,
    activeUserId,
    canAccessTab,
    debouncedInventoryReportSearch,
    inventoryReportFromDate,
    inventoryReportQueryKey,
    inventoryReportReadsEnabled,
    inventoryReportToDate
  ]);

  useEffect(() => {
    if (
      !normalizedReportReadsEnabled ||
      activeTab !== "reports" ||
      !activeUserId ||
      !canAccessTab("reports")
    ) {
      return;
    }

    let cancelled = false;
    setNormalizedReportState((previous) => ({
      ...previous,
      loading: true,
      error: "",
      queryKey: normalizedReportQueryKey
    }));

    runQaControlledNormalizedRead("reports", () => loadNormalizedReportData({
      fromDate: reportFromDate,
      toDate: reportToDate,
      previousFromDate: previousRange.from,
      previousToDate: previousRange.to
    }))
      .then((data) => {
        if (cancelled) {
          return;
        }
        setNormalizedReportState({
          ...data,
          loading: false,
          error: "",
          loaded: true,
          queryKey: normalizedReportQueryKey
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setNormalizedReportState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load normalized report data.",
          loaded: false,
          queryKey: normalizedReportQueryKey
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    activeUserId,
    canAccessTab,
    normalizedReportReadsEnabled,
    normalizedReportQueryKey,
    normalizedReportRefreshSignal,
    previousRange.from,
    previousRange.to,
    reportFromDate,
    reportToDate
  ]);

  const refreshNormalizedReport = useCallback(() => {
    setNormalizedReportState((previous) => ({
      ...previous,
      loaded: false,
      queryKey: `${previous.queryKey}:refresh:${Date.now()}`
    }));
    setAnalyticsSummaryState((previous) => ({
      ...previous,
      queryKey: `${previous.queryKey}:refresh:${Date.now()}`
    }));
    setNormalizedReportRefreshSignal((previous) => previous + 1);
  }, []);

  const refreshInventoryReport = useCallback(() => {
    setInventoryReportSummaryState((previous) => ({
      ...previous,
      queryKey: `${previous.queryKey}:refresh:${Date.now()}`
    }));
    setInventoryReportRefreshSignal((previous) => previous + 1);
  }, []);

  useEffect(() => {
    if (!normalizedBillHistoryReadsEnabled || activeTab !== "bills" || !activeUserId || !canAccessTab("bills")) {
      return;
    }
    let cancelled = false;
    const requestGeneration = ++normalizedBillRegisterGenerationRef.current;
    setNormalizedBillRegisterState((previous) => ({
      ...previous,
      loading: true,
      loadingMore: false,
      error: "",
      queryKey: normalizedBillRegisterQueryKey
    }));

    runQaControlledNormalizedRead("bill-history", () => loadNormalizedBillRegisterPage({
      ...normalizedBillRegisterQuery,
      limit: BILL_REGISTER_PAGE_SIZE
    }))
      .then((page) => {
        if (cancelled || normalizedBillRegisterGenerationRef.current !== requestGeneration) {
          return;
        }
        hydrateNormalizedBillRegisterPage(page);
        setNormalizedBillRegisterState({
          bills: page.bills,
          relatedBills: page.relatedBills,
          payments: page.payments,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          loading: false,
          loadingMore: false,
          error: "",
          loaded: true,
          queryKey: normalizedBillRegisterQueryKey
        });
      })
      .catch((error: unknown) => {
        if (cancelled || normalizedBillRegisterGenerationRef.current !== requestGeneration) {
          return;
        }
        setNormalizedBillRegisterState((previous) => ({
          ...previous,
          bills: [],
          relatedBills: [],
          payments: [],
          nextCursor: undefined,
          hasMore: false,
          loading: false,
          loadingMore: false,
          error: error instanceof Error ? error.message : "Unable to load normalized bill history.",
          loaded: false,
          queryKey: normalizedBillRegisterQueryKey
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    activeUserId,
    canAccessTab,
    normalizedBillHistoryReadsEnabled,
    normalizedBillRegisterQuery,
    normalizedBillRegisterQueryKey,
    normalizedBillRegisterRefreshSignal,
    hydrateNormalizedBillRegisterPage
  ]);

  const loadMoreNormalizedBillRegister = useCallback(() => {
    if (
      !normalizedBillHistoryReadsEnabled ||
      !normalizedBillRegisterState.nextCursor ||
      normalizedBillRegisterState.loading ||
      normalizedBillRegisterState.loadingMore
    ) {
      return;
    }
    const cursor = normalizedBillRegisterState.nextCursor;
    const requestedQueryKey = normalizedBillRegisterQueryKey;
    const requestedGeneration = normalizedBillRegisterGenerationRef.current;
    setNormalizedBillRegisterState((previous) => ({ ...previous, loadingMore: true, error: "" }));
    runQaControlledNormalizedRead("bill-history", () => loadNormalizedBillRegisterPage({
      ...normalizedBillRegisterQuery,
      cursor,
      limit: BILL_REGISTER_PAGE_SIZE
    }))
      .then((page) => {
        if (
          normalizedBillRegisterQueryKeyRef.current !== requestedQueryKey ||
          normalizedBillRegisterGenerationRef.current !== requestedGeneration
        ) {
          return;
        }
        hydrateNormalizedBillRegisterPage(page);
        setNormalizedBillRegisterState((previous) => {
          if (previous.queryKey !== requestedQueryKey) {
            return previous;
          }
          return {
            ...previous,
            bills: mergeBillsById(page.bills, previous.bills),
            relatedBills: mergeBillsById(page.relatedBills, previous.relatedBills),
            payments: mergePaymentsById(page.payments, previous.payments),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            loading: false,
            loadingMore: false,
            error: "",
            loaded: true,
            queryKey: requestedQueryKey
          };
        });
      })
      .catch((error: unknown) => {
        if (
          normalizedBillRegisterQueryKeyRef.current !== requestedQueryKey ||
          normalizedBillRegisterGenerationRef.current !== requestedGeneration
        ) {
          return;
        }
        setNormalizedBillRegisterState((previous) => {
          if (previous.queryKey !== requestedQueryKey) {
            return previous;
          }
          return {
            ...previous,
            loadingMore: false,
            error: error instanceof Error ? error.message : "Unable to load more normalized bill history."
          };
        });
      });
  }, [
    normalizedBillHistoryReadsEnabled,
    normalizedBillRegisterQuery,
    normalizedBillRegisterQueryKey,
    normalizedBillRegisterState.loading,
    normalizedBillRegisterState.loadingMore,
    normalizedBillRegisterState.nextCursor,
    hydrateNormalizedBillRegisterPage
  ]);

  const refreshNormalizedBillRegister = useCallback(() => {
    normalizedBillRegisterGenerationRef.current += 1;
    setNormalizedBillRegisterState((previous) => ({
      ...previous,
      loaded: false,
      queryKey: `${previous.queryKey}:refresh:${Date.now()}`
    }));
    setNormalizedBillRegisterRefreshSignal((previous) => previous + 1);
  }, []);

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

  async function commitAppDataChange(
    label: string,
    mutator: (draft: AppData) => void | false,
    onSuccess?: (nextAppData: AppData) => void
  ) {
    if (backendConfigured && !guardRemoteWrite()) {
      return false;
    }
    const nextAppData = cloneValue(appData);
    const result = mutator(nextAppData);
    if (result === false) {
      return false;
    }
    try {
      await runBlockingAction(label, async () => {
        let handledByAdminDataRpc = false;
        if (backendConfigured && defaultRemoteDataGateway.commitAdminDataChange) {
          const patch = buildAdminDataChangePatch({
            baseAppData: appData,
            nextAppData,
            baseVersion: remoteVersionRef.current,
            createdAt: new Date().toISOString(),
            userId: activeUser?.id ?? activeUserId ?? "",
            mutationId: createId("admin-change"),
            actionLabel: label
          });
          const hasAdminPatchChanges = adminDataChangePatchHasChanges(patch);
          const hasUnsupportedChanges = adminDataChangePatchHasUnsupportedChanges(appData, nextAppData);
          if (hasAdminPatchChanges && !hasUnsupportedChanges) {
            const commitResult = await defaultRemoteDataGateway.commitAdminDataChange(patch);
            const nextVersion = commitResult.appStateVersion ?? remoteVersionRef.current + 1;
            remoteVersionRef.current = nextVersion;
            setRemoteVersion(nextVersion);
            setRemoteError("");
            setPendingRetryData(null);
            handledByAdminDataRpc = true;
          } else if (!hasAdminPatchChanges && !hasUnsupportedChanges) {
            handledByAdminDataRpc = true;
          }
          if (handledByAdminDataRpc) {
            skipRemotePersistRef.current = true;
          }
        }
        if (backendConfigured && !handledByAdminDataRpc) {
          await saveRemoteSnapshot(nextAppData, remoteVersion, false, label);
          skipRemotePersistRef.current = true;
        }
        setAppData(normalizeAppDataCustomers(nextAppData));
        onSuccess?.(nextAppData);
      });
      return true;
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "Unable to save changes.");
      return false;
    }
  }

  function hasPendingOperationalForSession(sessionId?: string) {
    return hasPendingOperationalMutationForEntity(pendingOperationalMutations, "session", sessionId);
  }

  function hasPendingOperationalForCustomerTab(customerTabId?: string) {
    return hasPendingOperationalMutationForEntity(pendingOperationalMutations, "customer_tab", customerTabId);
  }

  async function hydrateNormalizedFinancialDelta(
    patch: FinancialCheckoutPatch | FinancialAdjustmentPatch,
    result?: FinancialCheckoutCommitResult | FinancialAdjustmentCommitResult
  ) {
    const checkoutPatch = "sessions" in patch ? patch : null;
    const changedRows = result?.changedRows ?? {};
    const changedIds = (key: string) =>
      Array.isArray(changedRows[key])
        ? (changedRows[key] as unknown[]).filter((value): value is string => typeof value === "string" && Boolean(value))
        : [];
    const delta = await loadNormalizedFinancialDelta({
      billIds: Array.from(new Set([
        ...patch.bills.map((bill) => bill.id),
        ...changedIds("bills"),
        ...(result && "billId" in result ? [result.billId] : [])
      ])),
      paymentIds: Array.from(new Set([...patch.payments.map((payment) => payment.id), ...changedIds("payments")])),
      sessionIds: checkoutPatch?.sourceSessionIds ?? checkoutPatch?.sessions.map((session) => session.id),
      customerTabIds:
        checkoutPatch?.sourceCustomerTabIds ?? checkoutPatch?.customerTabs.map((tab) => tab.id),
      inventoryItemIds: Array.from(new Set([...patch.inventoryItems.map((item) => item.id), ...changedIds("inventory_items")])),
      customerIds: Array.from(new Set([...(checkoutPatch?.customers ?? []).map((customer) => customer.id), ...changedIds("customers")])),
      stockMovementIds: Array.from(new Set([...patch.stockMovements.map((movement) => movement.id), ...changedIds("stock_movements")])),
      auditLogIds: Array.from(new Set([...patch.auditLogs.map((audit) => audit.id), ...changedIds("audit_logs")]))
    });
    setAppData((previous) => ({
      ...previous,
      bills: mergeBillsById(delta.bills, previous.bills),
      payments: mergePaymentsById(delta.payments, previous.payments),
      sessions: mergeRecordsById(delta.sessions, previous.sessions),
      sessionPauseLogs: mergeRecordsById(delta.sessionPauseLogs, previous.sessionPauseLogs),
      customerTabs: mergeRecordsById(delta.customerTabs, previous.customerTabs),
      inventoryItems: mergeRecordsById(delta.inventoryItems, previous.inventoryItems),
      customers: mergeRecordsById(delta.customers, previous.customers),
      stockMovements: mergeRecordsById(delta.stockMovements, previous.stockMovements),
      auditLogs: mergeRecordsById(delta.auditLogs, previous.auditLogs)
    }));
  }

  async function commitFinancialCheckoutPatch(patch: FinancialCheckoutPatch): Promise<FinancialCheckoutCommitResult | null> {
    if (!activeUserId || !defaultRemoteDataGateway.commitFinancialCheckout) {
      return null;
    }
    if (remoteReadOnly) {
      setRemoteError(remoteReadOnlyMessage);
      throw new Error(remoteReadOnlyMessage);
    }
    setRemoteSaving(true);
    try {
      const result = await defaultRemoteDataGateway.commitFinancialCheckout(patch);
      const nextVersion =
        result.appStateVersion ??
        (BACKEND_FEATURE_FLAGS.financialRpcV2 ? remoteVersionRef.current : patch.baseAppStateVersion + 1);
      if (nextVersion !== remoteVersionRef.current) {
        remoteVersionRef.current = nextVersion;
        setRemoteVersion(nextVersion);
      }
      setRemoteError("");
      setPendingRetryData(null);
      if (BACKEND_FEATURE_FLAGS.financialRpcV2) {
        await hydrateNormalizedFinancialDelta(patch, result);
      }
      return result;
    } catch (error) {
      if (!BACKEND_FEATURE_FLAGS.financialRpcV2) {
        await refreshRemoteState({ keepUser: true });
      } else {
        try {
          await hydrateNormalizedFinancialDelta(patch);
        } catch (hydrationError) {
          console.warn("Unable to hydrate the affected financial rows after checkout failure.", hydrationError);
        }
      }
      setRemoteError(error instanceof Error ? error.message : "Could not issue the bill. Please check the latest data and try again.");
      setPendingRetryData(null);
      throw error;
    } finally {
      setRemoteSaving(false);
    }
  }

  async function commitFinancialAdjustmentPatch(patch: FinancialAdjustmentPatch): Promise<FinancialAdjustmentCommitResult | null> {
    if (!activeUserId || !defaultRemoteDataGateway.commitFinancialAdjustment) {
      return null;
    }
    if (remoteReadOnly) {
      setRemoteError(remoteReadOnlyMessage);
      throw new Error(remoteReadOnlyMessage);
    }
    setRemoteSaving(true);
    try {
      const result = await defaultRemoteDataGateway.commitFinancialAdjustment(patch);
      const nextVersion =
        result.appStateVersion ??
        (BACKEND_FEATURE_FLAGS.financialRpcV2 ? remoteVersionRef.current : patch.baseAppStateVersion + 1);
      if (nextVersion !== remoteVersionRef.current) {
        remoteVersionRef.current = nextVersion;
        setRemoteVersion(nextVersion);
      }
      setRemoteError("");
      setPendingRetryData(null);
      if (BACKEND_FEATURE_FLAGS.financialRpcV2) {
        await hydrateNormalizedFinancialDelta(patch, result);
      }
      return result;
    } catch (error) {
      if (!BACKEND_FEATURE_FLAGS.financialRpcV2) {
        await refreshRemoteState({ keepUser: true });
      } else {
        try {
          await hydrateNormalizedFinancialDelta(patch);
        } catch (hydrationError) {
          console.warn("Unable to hydrate the affected rows after financial adjustment failure.", hydrationError);
        }
      }
      setRemoteError(error instanceof Error ? error.message : "Could not save the financial update. Please check the latest data and try again.");
      setPendingRetryData(null);
      throw error;
    } finally {
      setRemoteSaving(false);
    }
  }

  async function commitFinancialAdjustmentChange(
    label: string,
    kind: FinancialAdjustmentKind,
    entityType: FinancialAdjustmentPatch["entityType"],
    entityId: string,
    mutator: (draft: AppData) => void | false,
    onSuccess?: (nextAppData: AppData) => void
  ) {
    if (!backendConfigured || !defaultRemoteDataGateway.commitFinancialAdjustment) {
      return commitAppDataChange(label, mutator, onSuccess);
    }
    if (!guardRemoteWrite()) {
      return false;
    }

    const baseAppData = appData;
    const nextAppData = cloneValue(appData);
    const result = mutator(nextAppData);
    if (result === false) {
      return false;
    }

    const mutationKey = `${kind}:${entityType}:${entityId}`;
    const mutationId = financialAdjustmentMutationIdsRef.current.get(mutationKey) ?? createId("financial-adjustment");
    financialAdjustmentMutationIdsRef.current.set(mutationKey, mutationId);
    const patch = buildFinancialAdjustmentPatch({
      baseAppData,
      nextAppData,
      kind,
      entityType,
      entityId,
      baseVersion: remoteVersionRef.current,
      createdAt: new Date().toISOString(),
      userId: activeUser?.id ?? activeUserId ?? "",
      mutationId
    });
    if (patch.bills.length === 0) {
      return false;
    }

    try {
      await runBlockingAction(label, async () => {
        await commitFinancialAdjustmentPatch(patch);
        skipRemotePersistRef.current = true;
        if (!BACKEND_FEATURE_FLAGS.financialRpcV2) {
          setAppData(normalizeAppDataCustomers(nextAppData));
        }
        if (normalizedBillHistoryReadsEnabled) {
          refreshNormalizedBillRegister();
        }
        financialAdjustmentMutationIdsRef.current.delete(mutationKey);
        onSuccess?.(nextAppData);
      });
      return true;
    } catch {
      return false;
    }
  }

  function createOperationalMutation(
    kind: OperationalMutationKind,
    label: string,
    entityType: OperationalMutation["entityType"],
    entityId: string,
    payload: OperationalMutationPayload,
    options?: Pick<OperationalMutation, "retryPolicy" | "optimistic" | "acknowledgementRequired">
  ): OperationalMutation | null {
    if (!activeUser) {
      return null;
    }
    return {
      id: createId("op"),
      kind,
      label,
      userId: activeUser.id,
      createdAt: new Date().toISOString(),
      baseVersion: remoteVersionRef.current,
      status: "pending",
      entityType,
      entityId,
      payload,
      ...options
    };
  }

  function settleOperationalMutationAcknowledgement(
    mutation: OperationalMutation | undefined,
    outcome: Parameters<ReturnType<typeof createOperationalMutationAcknowledgementRegistry>["settle"]>[1]
  ) {
    if (mutation?.acknowledgementRequired) {
      operationalMutationAcknowledgementsRef.current?.settle(mutation.id, outcome);
    }
  }

  function scheduleOperationalSync(delayMs = 400) {
    if (operationalSyncTimerRef.current) {
      window.clearTimeout(operationalSyncTimerRef.current);
    }
    operationalSyncTimerRef.current = window.setTimeout(() => {
      void syncOperationalQueue();
    }, delayMs);
  }

  async function syncOperationalQueue() {
    if (!backendConfigured || !activeUserId || !online || remoteReadOnly || operationalSyncInFlightRef.current) {
      return;
    }
    let syncableMutations = pendingOperationalMutationsRef.current.filter(
      isOperationalMutationSyncable
    );
    if (syncableMutations.length === 0) {
      return;
    }
    const syncIds = new Set(syncableMutations.map((mutation) => mutation.id));
    operationalSyncInFlightRef.current = true;
    updatePendingOperationalMutations((previous) =>
      previous.map((mutation) =>
        syncIds.has(mutation.id)
          ? { ...mutation, status: "syncing", failureReason: undefined }
          : mutation
      )
    );
    setRemoteSaving(true);
    try {
      if (defaultRemoteDataGateway.commitOperationalMutation) {
        const syncedIds = new Set<string>();
        const failedMutations: OperationalMutation[] = [];
        const conflictMutations: OperationalMutation[] = [];
        for (let syncIndex = 0; syncIndex < syncableMutations.length; syncIndex += 1) {
          const mutation = getOperationalMutationForDispatch(
            pendingOperationalMutationsRef.current,
            syncableMutations[syncIndex].id
          );
          if (!mutation) {
            continue;
          }
          try {
            const result = await defaultRemoteDataGateway.commitOperationalMutation(mutation);
            const lineReconciliation = getCustomerTabLineIdReconciliation(mutation, result);
            let reconciledData = reconcileOperationalRpcResult(appDataRef.current, mutation, result);
            if (mutation.optimistic === false) {
              reconciledData = applyOperationalMutation(reconciledData, mutation, { skipValidation: true });
            }
            if (result.appStateVersion) {
              remoteVersionRef.current = result.appStateVersion;
              setRemoteVersion(result.appStateVersion);
            }
            if (reconciledData !== appDataRef.current) {
              skipRemotePersistRef.current = true;
              appDataRef.current = reconciledData;
              setAppData(reconciledData);
              saveAppData(reconciledData);
            }
            if (lineReconciliation) {
              syncableMutations = syncableMutations.map((entry) =>
                rewriteCustomerTabLineReference(entry, lineReconciliation)
              );
              updatePendingOperationalMutations((previous) =>
                previous.map((entry) => rewriteCustomerTabLineReference(entry, lineReconciliation))
              );
            }
            syncedIds.add(mutation.id);
          } catch (error) {
            const rejectedMutation: OperationalMutation = {
              ...mutation,
              status: isOperationalBusinessConflict(error) ? "conflict" : "failed",
              failureReason: getOperationalErrorMessage(error)
            };
            if (rejectedMutation.status === "conflict") {
              conflictMutations.push(rejectedMutation);
            } else {
              failedMutations.push(rejectedMutation);
            }
          }
        }
        if (conflictMutations.length > 0) {
          const conflictIds = new Set(conflictMutations.map((mutation) => mutation.id));
          const failedIds = new Set(failedMutations.map((mutation) => mutation.id));
          try {
            const snapshot = await defaultRemoteDataGateway.loadAppDataSnapshot();
            const rebaseQueue = pendingOperationalMutationsRef.current
              .filter(
                (mutation) =>
                  !syncedIds.has(mutation.id) &&
                  !conflictIds.has(mutation.id) &&
                  !failedIds.has(mutation.id) &&
                  mutation.status !== "conflict"
              )
              .map((mutation) =>
                mutation.status === "syncing" ? { ...mutation, status: "pending" as const } : mutation
              );
            const rebased = rebasePendingMutations(normalizeAppDataCustomers(snapshot.appData), rebaseQueue);
            skipRemotePersistRef.current = true;
            appDataRef.current = rebased.appData;
            setAppData(rebased.appData);
            saveAppData(rebased.appData);
            remoteVersionRef.current = snapshot.version;
            setRemoteVersion(snapshot.version);
            const rebaseConflictIds = new Set(rebased.conflicts.map((mutation) => mutation.id));
            updatePendingOperationalMutations((previous) =>
              dedupeOperationalMutations([
                ...rebased.pendingMutations,
                ...failedMutations,
                ...conflictMutations,
                ...rebased.conflicts,
                ...previous.filter(
                  (mutation) =>
                    mutation.status === "conflict" &&
                    !conflictIds.has(mutation.id) &&
                    !rebaseConflictIds.has(mutation.id)
                )
              ])
            );
            const conflictMessage = getOperationalConflictMessages([
              ...conflictMutations,
              ...rebased.conflicts
            ]).join(" ");
            const failureMessage = failedMutations.map((mutation) => mutation.failureReason).filter(Boolean).join(" ");
            setRemoteError([failureMessage, conflictMessage].filter(Boolean).join(" "));
          } catch (refreshError) {
            updatePendingOperationalMutations((previous) =>
              dedupeOperationalMutations([
                ...previous.filter(
                  (mutation) =>
                    !syncedIds.has(mutation.id) &&
                    !conflictIds.has(mutation.id) &&
                    !failedIds.has(mutation.id)
                ),
                ...failedMutations,
                ...conflictMutations
              ])
            );
            setRemoteError(
              [
                getOperationalErrorMessage(refreshError),
                getOperationalConflictMessages(conflictMutations).join(" ")
              ].filter(Boolean).join(" ")
            );
          }
        } else {
          updatePendingOperationalMutations((previous) =>
            previous
              .filter((mutation) => !syncedIds.has(mutation.id))
              .map((mutation) => failedMutations.find((failed) => failed.id === mutation.id) ?? mutation)
          );
          const failureMessage = failedMutations.map((mutation) => mutation.failureReason).filter(Boolean).join(" ");
          const remainingConflicts = getOperationalConflictMessages(pendingOperationalMutationsRef.current);
          setRemoteError(failureMessage || (remainingConflicts.length > 0 ? remainingConflicts.join(" ") : ""));
        }
        syncedIds.forEach((mutationId) => {
          settleOperationalMutationAcknowledgement(
            syncableMutations.find((mutation) => mutation.id === mutationId),
            { status: "synced" }
          );
        });
        failedMutations.forEach((mutation) => {
          settleOperationalMutationAcknowledgement(mutation, {
            status: "failed",
            failureReason: mutation.failureReason ?? "Unable to sync this pending operation."
          });
        });
        conflictMutations.forEach((mutation) => {
          settleOperationalMutationAcknowledgement(mutation, {
            status: "conflict",
            failureReason: mutation.failureReason ?? "This operation conflicts with the latest server data."
          });
        });
        if (syncedIds.size > 0) {
          setLastOperationalSyncAt(new Date().toISOString());
        }
      } else {
        const nextVersion = await defaultRemoteDataGateway.saveAppData(appDataRef.current, activeUserId, remoteVersionRef.current, {
          actionLabel: syncableMutations.map((mutation) => mutation.kind).join(", "),
          source: "operational_queue",
          pendingOperationCount: syncableMutations.length
        });
        remoteVersionRef.current = nextVersion;
        setRemoteVersion(nextVersion);
        updatePendingOperationalMutations((previous) => previous.filter((mutation) => !syncIds.has(mutation.id)));
        setLastOperationalSyncAt(new Date().toISOString());
        syncIds.forEach((mutationId) => {
          settleOperationalMutationAcknowledgement(
            syncableMutations.find((mutation) => mutation.id === mutationId),
            { status: "synced" }
          );
        });
        const remainingConflicts = getOperationalConflictMessages(pendingOperationalMutationsRef.current);
        setRemoteError(remainingConflicts.length > 0 ? remainingConflicts.join(" ") : "");
      }
    } catch (error) {
      const isVersionConflict =
        error instanceof Error && error.message.toLowerCase().includes("remote data changed");
      if (isVersionConflict) {
        try {
          const snapshot = await defaultRemoteDataGateway.loadAppDataSnapshot();
          const currentQueue = pendingOperationalMutationsRef.current.filter(
            (mutation) =>
              mutation.status === "syncing" ||
              isOperationalMutationSyncable(mutation)
          );
          const rebased = rebasePendingMutations(normalizeAppDataCustomers(snapshot.appData), currentQueue);
          skipRemotePersistRef.current = true;
          appDataRef.current = rebased.appData;
          setAppData(rebased.appData);
          saveAppData(rebased.appData);
          remoteVersionRef.current = snapshot.version;
          setRemoteVersion(snapshot.version);
          if (rebased.pendingMutations.length > 0) {
            const savedVersion = await defaultRemoteDataGateway.saveAppData(rebased.appData, activeUserId, snapshot.version, {
              actionLabel: `Rebased ${rebased.pendingMutations.map((mutation) => mutation.kind).join(", ")}`,
              source: "operational_queue",
              pendingOperationCount: rebased.pendingMutations.length
            });
            remoteVersionRef.current = savedVersion;
            setRemoteVersion(savedVersion);
            const savedIds = new Set(rebased.pendingMutations.map((mutation) => mutation.id));
            const conflictIds = new Set(rebased.conflicts.map((mutation) => mutation.id));
            updatePendingOperationalMutations((previous) => [
              ...previous.filter((mutation) => !savedIds.has(mutation.id) && !conflictIds.has(mutation.id)),
              ...rebased.conflicts
            ]);
            savedIds.forEach((mutationId) => {
              settleOperationalMutationAcknowledgement(
                rebased.pendingMutations.find((mutation) => mutation.id === mutationId),
                { status: "synced" }
              );
            });
            rebased.conflicts.forEach((mutation) => {
              settleOperationalMutationAcknowledgement(mutation, {
                status: "conflict",
                failureReason: mutation.failureReason ?? "This operation conflicts with the latest server data."
              });
            });
            setLastOperationalSyncAt(new Date().toISOString());
          } else {
            const conflictIds = new Set(rebased.conflicts.map((mutation) => mutation.id));
            updatePendingOperationalMutations((previous) => [
              ...previous.filter((mutation) => !conflictIds.has(mutation.id) && mutation.status === "conflict"),
              ...rebased.conflicts
            ]);
            rebased.conflicts.forEach((mutation) => {
              settleOperationalMutationAcknowledgement(mutation, {
                status: "conflict",
                failureReason: mutation.failureReason ?? "This operation conflicts with the latest server data."
              });
            });
          }
          setRemoteError(
            rebased.conflicts.length > 0
              ? getOperationalConflictMessages(rebased.conflicts).join(" ")
              : ""
          );
        } catch (rebaseError) {
          updatePendingOperationalMutations((previous) =>
            previous.map((mutation) =>
              syncIds.has(mutation.id)
                ? {
                    ...mutation,
                    status: "failed",
                    failureReason:
                      rebaseError instanceof Error
                        ? rebaseError.message
                        : "Unable to sync this pending operation."
                  }
                : mutation
            )
          );
          setRemoteError(
            rebaseError instanceof Error
              ? rebaseError.message
              : "Unable to sync pending operational changes."
          );
          syncIds.forEach((mutationId) => {
            settleOperationalMutationAcknowledgement(
              syncableMutations.find((mutation) => mutation.id === mutationId),
              {
              status: "failed",
              failureReason:
                rebaseError instanceof Error
                  ? rebaseError.message
                  : "Unable to sync pending operational changes."
              }
            );
          });
        }
      } else {
        updatePendingOperationalMutations((previous) =>
          previous.map((mutation) =>
            syncIds.has(mutation.id)
              ? {
                  ...mutation,
                  status: "failed",
                  failureReason:
                    error instanceof Error
                      ? error.message
                      : "Unable to sync this pending operation."
                }
              : mutation
          )
        );
        setRemoteError(
          error instanceof Error
            ? error.message
            : "Unable to sync pending operational changes."
        );
        syncIds.forEach((mutationId) => {
          settleOperationalMutationAcknowledgement(
            syncableMutations.find((mutation) => mutation.id === mutationId),
            {
              status: "failed",
              failureReason:
                error instanceof Error
                  ? error.message
                  : "Unable to sync pending operational changes."
            }
          );
        });
      }
    } finally {
      setRemoteSaving(false);
      operationalSyncInFlightRef.current = false;
      if (
        pendingOperationalMutationsRef.current.some(
          isOperationalMutationSyncable
        )
      ) {
        scheduleOperationalSync(1200);
      }
    }
  }

  function commitOperationalChange(
    mutation: OperationalMutation | null,
    onSuccess?: (nextAppData: AppData) => void,
    options?: { optimistic?: boolean }
  ) {
    if (!mutation) {
      return false;
    }
    if (backendConfigured && !guardRemoteWrite()) {
      return false;
    }
    try {
      const shouldApplyOptimistically = options?.optimistic ?? mutation.optimistic !== false;
      const nextAppData = shouldApplyOptimistically
        ? applyOperationalMutation(appDataRef.current, mutation)
        : appDataRef.current;
      if (shouldApplyOptimistically) {
        skipRemotePersistRef.current = true;
        appDataRef.current = nextAppData;
        setAppData(nextAppData);
        saveAppData(nextAppData);
      }
      if (backendConfigured) {
        updatePendingOperationalMutations((previous) => appendPendingOperationalMutation(previous, mutation));
        scheduleOperationalSync();
      }
      onSuccess?.(nextAppData);
      return true;
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "Unable to apply this action.");
      return false;
    }
  }

  async function commitCriticalOperationalChange(
    mutation: OperationalMutation | null,
    actionKey: string,
    options?: { existingMutation?: boolean }
  ) {
    if (!mutation) {
      return {
        status: "failed" as const,
        failureReason: "Unable to prepare this action."
      };
    }
    if (criticalOperationalActionsRef.current.has(actionKey)) {
      return {
        status: "failed" as const,
        failureReason: "This action is already being confirmed."
      };
    }
    criticalOperationalActionsRef.current.add(actionKey);
    try {
      if (!backendConfigured) {
        return commitOperationalChange(mutation, undefined, { optimistic: true })
          ? { status: "synced" as const }
          : {
              status: "failed" as const,
              failureReason: remoteError || "Unable to complete this action."
            };
      }

      if (options?.existingMutation) {
        operationalMutationAcknowledgementsRef.current?.discard(mutation.id);
      }
      const acknowledgement = operationalMutationAcknowledgementsRef.current!.waitFor(
        mutation.id,
        CRITICAL_OPERATION_ACK_TIMEOUT_MS
      );
      const committed = options?.existingMutation
        ? (() => {
            updatePendingOperationalMutations((previous) =>
              previous.map((entry) =>
                entry.id === mutation.id
                  ? { ...entry, status: "pending", failureReason: undefined }
                  : entry
              )
            );
            return true;
          })()
        : commitOperationalChange(mutation, undefined, { optimistic: false });
      if (!committed) {
        operationalMutationAcknowledgementsRef.current?.discard(mutation.id);
        return {
          status: "failed" as const,
          failureReason: remoteError || "Unable to queue this action."
        };
      }

      scheduleOperationalSync(0);
      const outcome = await acknowledgement;
      if (outcome.status !== "synced") {
        updatePendingOperationalMutations((previous) =>
          previous.map((entry) =>
            entry.id === mutation.id && entry.retryPolicy === "manual" && entry.status !== "conflict"
              ? { ...entry, status: "failed", failureReason: outcome.failureReason }
              : entry
          )
        );
        return outcome;
      }

      const confirmedData = applyOperationalMutation(appDataRef.current, mutation, { skipValidation: true });
      skipRemotePersistRef.current = true;
      appDataRef.current = confirmedData;
      setAppData(confirmedData);
      saveAppData(confirmedData);
      return outcome;
    } finally {
      criticalOperationalActionsRef.current.delete(actionKey);
    }
  }

  function discardOperationalMutation(mutationId: string) {
    operationalMutationAcknowledgementsRef.current?.discard(mutationId);
    alertedOperationalMutationIdsRef.current.delete(mutationId);
    updatePendingOperationalMutations((previous) =>
      previous.filter((mutation) => mutation.id !== mutationId)
    );
  }

  function discardFailedContinuationStart(sourceSessionId: string) {
    const failedMutation = pendingOperationalMutationsRef.current.find((mutation) => {
      const payload = mutation.payload as { session?: Session };
      return (
        mutation.kind === "startSession" &&
        mutation.retryPolicy === "manual" &&
        mutation.status === "failed" &&
        payload.session?.continuedFromSessionIds?.includes(sourceSessionId)
      );
    });
    if (failedMutation) {
      discardOperationalMutation(failedMutation.id);
    }
  }

  function retryOperationalSyncNow() {
    pendingOperationalMutationsRef.current
      .filter((mutation) => mutation.status === "failed" && mutation.retryPolicy !== "manual")
      .forEach((mutation) => alertedOperationalMutationIdsRef.current.delete(mutation.id));
    updatePendingOperationalMutations((previous) =>
      previous.map((mutation) =>
        mutation.status === "failed" && mutation.retryPolicy !== "manual"
          ? { ...mutation, status: "pending", failureReason: undefined }
          : mutation
      )
    );
    scheduleOperationalSync(0);
  }

  function clearOperationalConflicts() {
    pendingOperationalMutationsRef.current
      .filter((mutation) => mutation.status === "conflict")
      .forEach((mutation) => alertedOperationalMutationIdsRef.current.delete(mutation.id));
    updatePendingOperationalMutations((previous) => previous.filter((mutation) => mutation.status !== "conflict"));
    setRemoteError("");
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
    const charge = getSessionChargeSummary(session, effectiveEndAt);
    const comboApplications = session.comboApplications ?? [];
    if (comboApplications.length === 0 || session.mode !== "timed") {
      return getSessionItemsSubtotal(session) + charge.subtotal;
    }
    const extraMinutes = Math.max(0, charge.billedMinutes - getComboIncludedMinutes(session));
    const hourlyRate = charge.segments[0]?.hourlyRate ?? 0;
    const extraCharge = (extraMinutes / 60) * hourlyRate;
    return getSessionItemsSubtotal(session) + getComboApplicationsTotal(session) + extraCharge;
  }

  function createStartSessionDraft(station?: Station | null): StartSessionDraft {
    return {
      stationId: station?.id ?? "",
      customerId: undefined,
      customerName: "",
      customerPhone: "",
      playMode: "group",
      arcadeItemId: station?.mode === "unit_sale" ? defaultArcadeInventoryItem?.id ?? "" : "",
      arcadeQuantity: 1,
      comboId: "",
      comboChoices: {}
    };
  }

  function getAvailableCombosForStation(stationId?: string) {
    return getCombosForStation(appData.combos, stationId);
  }

  function buildComboApplication(
    combo: ComboPackage,
    choices: Record<string, string[]> = {}
  ): SessionComboApplication | null {
    const fixedItems = resolveComboFixedSelections(combo, sellableInventoryOptions);
    const choiceSelections = resolveComboChoiceSelections(combo, sellableInventoryOptions, choices);
    if (!fixedItems || !choiceSelections) {
      return null;
    }
    return {
      id: createId("combo-app"),
      comboId: combo.id,
      comboName: combo.name,
      price: combo.price,
      includedMinutes: combo.type === "consumables" ? 0 : combo.includedMinutes,
      appliedAt: new Date().toISOString(),
      fixedItems,
      choices: choiceSelections
    };
  }

  function getComboSessionItems(application: SessionComboApplication): SessionItem[] {
    return getComboInventorySelections(application).map((selection) => ({
      id: createId("session-item"),
      inventoryItemId: selection.inventoryItemId,
      name: selection.name,
      quantity: selection.quantity,
      unitPrice: 0,
      saleVariantId: selection.saleVariantId,
      stockUnitsPerSale: selection.stockUnitsPerSale,
      comboApplicationId: application.id,
      comboId: application.comboId,
      addedAt: application.appliedAt
    }));
  }

  function getComboCustomerTabItems(application: SessionComboApplication): CustomerTabItem[] {
    return getComboInventorySelections(application).map((selection) => ({
      id: createId("customer-tab-item"),
      inventoryItemId: selection.inventoryItemId,
      name: selection.name,
      quantity: selection.quantity,
      unitPrice: 0,
      saleVariantId: selection.saleVariantId,
      stockUnitsPerSale: selection.stockUnitsPerSale,
      comboApplicationId: application.id,
      comboId: application.comboId,
      addedAt: application.appliedAt
    }));
  }

  function findUnavailableComboSelection(
    selections: ReturnType<typeof getComboInventorySelections>,
    ignoreSessionId?: string,
    ignoreCustomerTabId?: string
  ) {
    const requiredByItemId = selections.reduce<Record<string, number>>((totals, selection) => {
      totals[selection.inventoryItemId] = (totals[selection.inventoryItemId] ?? 0) + selection.quantity * selection.stockUnitsPerSale;
      return totals;
    }, {});
    return Object.entries(requiredByItemId).find(([itemId, required]) => {
      const item = appData.inventoryItems.find((entry) => entry.id === itemId);
      return !item || getAvailableStock(item, ignoreSessionId, ignoreCustomerTabId) < required;
    });
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
        (item) => getLineStockQuantity(item)
      )
    );
  }

  function getCustomerTabReservedQuantity(itemId: string, ignoreCustomerTabId?: string) {
    return sumBy(
      appData.customerTabs.filter((tab) => tab.status === "open" && tab.id !== ignoreCustomerTabId),
      (tab) => sumBy(
        tab.items.filter((item) => item.inventoryItemId === itemId),
        (item) => getLineStockQuantity(item)
      )
    );
  }

  function getCustomerTabReservedQuantityExceptLine(itemId: string, customerTabId: string, lineId: string) {
    return sumBy(
      appData.customerTabs.filter((tab) => tab.status === "open"),
      (tab) => sumBy(
        tab.items.filter(
          (item) => item.inventoryItemId === itemId && !(tab.id === customerTabId && item.id === lineId)
        ),
        (item) => getLineStockQuantity(item)
      )
    );
  }

  function getReservedQuantity(
    item: InventoryItem,
    options?: { ignoreSessionId?: string; ignoreCustomerTabId?: string }
  ) {
    const sessionReserved = getSessionReservedQuantity(item.id, options?.ignoreSessionId);
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

  function getAvailableStockForCustomerTabLineUpdate(item: InventoryItem, customerTabId: string, lineId: string) {
    return Math.max(
      0,
      item.stockQty -
        getSessionReservedQuantity(item.id) -
        getCustomerTabReservedQuantityExceptLine(item.id, customerTabId, lineId)
    );
  }

  function getCustomerTabById(customerTabId: string) {
    return appData.customerTabs.find((tab) => tab.id === customerTabId);
  }

  function getCustomerById(customerId?: string) {
    return customerId ? appData.customers.find((customer) => customer.id === customerId) : undefined;
  }

  function getExactCustomerFromSearchState(customerName: string, customerPhone: string) {
    const query = (customerPhone.trim() || customerName.trim()).trim();
    if (!query || normalizedCustomerSearchState.query.trim() !== query) {
      return undefined;
    }
    return findExactCustomerProfileMatch(normalizedCustomerSearchState.customers, customerName, customerPhone);
  }

  async function resolveExactCustomerDraft<T extends CustomerIdentityDraft>(draftValue: T): Promise<T> {
    if (draftValue.customerId) {
      return draftValue;
    }

    const customerName = draftValue.customerName.trim();
    const customerPhone = draftValue.customerPhone.trim();
    if (!customerName && !customerPhone) {
      return draftValue;
    }

    const localMatch = findExactCustomerProfileMatch(appData.customers, customerName, customerPhone);
    const searchStateMatch = localMatch ?? getExactCustomerFromSearchState(customerName, customerPhone);
    if (searchStateMatch) {
      return {
        ...draftValue,
        customerId: searchStateMatch.id,
        customerName: searchStateMatch.name,
        customerPhone: searchStateMatch.phone ?? customerPhone
      };
    }

    if (!normalizedCustomerSearchReadsEnabled) {
      return draftValue;
    }

    try {
      const customers = await loadNormalizedCustomerSearch({
        search: customerPhone || customerName,
        limit: 25
      });
      const remoteMatch = findExactCustomerProfileMatch(customers, customerName, customerPhone);
      if (!remoteMatch) {
        return draftValue;
      }
      return {
        ...draftValue,
        customerId: remoteMatch.id,
        customerName: remoteMatch.name,
        customerPhone: remoteMatch.phone ?? customerPhone
      };
    } catch {
      return draftValue;
    }
  }

  function getBillById(billId: string) {
    return appData.bills.find((bill) => bill.id === billId) ??
      normalizedBillRegisterState.bills.find((bill) => bill.id === billId);
  }

  function getCustomerTabTotal(tab: CustomerTab) {
    return sumBy(tab.items, (item) => item.quantity * item.unitPrice) + sumBy(tab.comboApplications ?? [], (combo) => combo.price);
  }

  function getUnbilledHoppedSessionsForTab(tab: CustomerTab) {
    return getDirectlyLinkedHoppedSessions(appData.sessions, tab.continuedFromSessionIds);
  }

  function getUnbilledHoppedSessionsForSession(session: Session) {
    return getDirectlyLinkedHoppedSessions(appData.sessions, session.continuedFromSessionIds, session.id);
  }

  function getPossibleUnbilledHoppedSessionsForCustomer(name: string, phone: string, excludedIds: string[] = []) {
    const excluded = new Set(excludedIds);
    return getUnbilledHoppedSessionsForCustomer(appData.sessions, name, phone)
      .filter((session) => !excluded.has(session.id));
  }

  function getContinuationSessionIds(hoppedSession: Session | undefined) {
    if (!hoppedSession) {
      return [];
    }
    return Array.from(new Set([...(hoppedSession.continuedFromSessionIds ?? []), hoppedSession.id]));
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
      active: true,
      sellBaseItem: true,
      saleVariants: []
    });
    setUseCustomItemCategory(false);
    setCustomItemCategory("");
  }

  function sanitizeSaleVariants(item: InventoryItem, resolvedCategory: string): SaleVariant[] | undefined {
    if (item.isReusable || resolvedCategory === "Cigarettes") {
      return undefined;
    }
    const variants = (item.saleVariants ?? [])
      .map((variant) => ({
        id: variant.id || createId("variant"),
        name: variant.name.trim(),
        price: Math.max(0, variant.price),
        stockUnitsPerSale: Math.max(1, Math.trunc(variant.stockUnitsPerSale)),
        barcode: variant.barcode?.trim() || undefined,
        active: variant.active
      }))
      .filter((variant) => variant.name);
    return variants.length > 0 ? variants : undefined;
  }

  function closeEditInventoryModal() {
    setEditItemForm(null);
    setUseCustomEditItemCategory(false);
    setCustomEditItemCategory("");
  }

  function beginEditInventoryItem(item: InventoryItem) {
    if (!item.active) {
      window.alert("Restore archived inventory items before editing them.");
      return;
    }
    setEditItemForm({
      ...item,
      barcode: item.barcode ?? ""
    });
    const isKnownCategory = inventoryCategoryOptions.includes(item.category);
    setUseCustomEditItemCategory(!isKnownCategory);
    setCustomEditItemCategory(isKnownCategory ? "" : item.category);
  }

  function getInventoryOpenUsage(itemId: string) {
    return getInventoryItemOpenUsage(itemId, appData.sessions, appData.customerTabs);
  }

  function formatInventoryOpenUsageMessage(item: InventoryItem) {
    const usage = getInventoryOpenUsage(item.id);
    if (usage.totalQuantity <= 0) {
      return "";
    }
    const contexts = [
      ...usage.sessionMatches.map((entry) => `${entry.label} session (${entry.quantity})`),
      ...usage.tabMatches.map((entry) => `${entry.label} tab (${entry.quantity})`)
    ];
    const preview = contexts.slice(0, 4).join(", ");
    const remaining = contexts.length > 4 ? `, and ${contexts.length - 4} more` : "";
    return `${item.name} is currently used in open work: ${preview}${remaining}. Remove or bill those lines before archiving.`;
  }

  function beginArchiveInventoryItem(item: InventoryItem) {
    if (!activeUser || !canEditInventory) {
      return;
    }
    if (!item.active) {
      window.alert("This item is already archived.");
      return;
    }
    const usageMessage = formatInventoryOpenUsageMessage(item);
    if (usageMessage) {
      window.alert(usageMessage);
      return;
    }
    setInventoryArchiveDraft({
      itemId: item.id,
      reason: "",
      remainingStock: item.stockQty
    });
  }

  function archiveInventoryItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditInventory || !inventoryArchiveDraft) {
      return;
    }
    const archiveReason = inventoryArchiveDraft.reason.trim();
    void commitAppDataChange("Archiving inventory item...", (draft) => {
      const item = draft.inventoryItems.find((entry) => entry.id === inventoryArchiveDraft.itemId);
      if (!item || !item.active) {
        return false;
      }
      const usageMessage = formatInventoryOpenUsageMessage(item);
      if (usageMessage) {
        window.alert(usageMessage);
        return false;
      }
      item.active = false;
      item.archivedAt = new Date().toISOString();
      item.archivedByUserId = activeUser.id;
      item.archiveReason = archiveReason || undefined;
      addAuditLog(
        draft,
        activeUser.id,
        "inventory_archived",
        "inventory_item",
        item.id,
        `Archived ${item.name}${archiveReason ? `. Reason: ${archiveReason}` : ""}.`
      );
    }, () => {
      setInventoryArchiveDraft(null);
      if (inventoryAction.itemId === inventoryArchiveDraft.itemId) {
        setInventoryAction({ itemId: "", quantity: 1, reason: "" });
      }
    });
  }

  function restoreInventoryItem(itemId: string) {
    if (!activeUser || !canEditInventory) {
      return;
    }
    void commitAppDataChange("Restoring inventory item...", (draft) => {
      const item = draft.inventoryItems.find((entry) => entry.id === itemId);
      if (!item || item.active) {
        return false;
      }
      item.active = true;
      item.archivedAt = undefined;
      item.archivedByUserId = undefined;
      item.archiveReason = undefined;
      addAuditLog(draft, activeUser.id, "inventory_restored", "inventory_item", item.id, `Restored ${item.name}.`);
    });
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
      return `${occupied} in use - ${available} available`;
    }
    return `${item.stockQty} left - threshold ${item.lowStockThreshold}`;
  }

  function getInventoryPickerDetail(
    item: InventoryItem,
    ignoreSessionId?: string,
    ignoreCustomerTabId?: string
  ) {
    const available = getAvailableStock(item, ignoreSessionId, ignoreCustomerTabId);
    if (item.isReusable) {
      const occupied = getOccupiedQuantity(item, { ignoreSessionId, ignoreCustomerTabId });
      return `${available} available - ${occupied} in use`;
    }
    if (item.cigarettePack) {
      const packs = Math.floor(available / item.cigarettePack.size);
      const loose = available % item.cigarettePack.size;
      return `${available} left (~${packs} pack${packs !== 1 ? "s" : ""}${loose > 0 ? ` + ${loose}` : ""})`;
    }
    return `Available ${available}`;
  }

  function getSellableOptionPickerDetail(
    option: SellableInventoryOption,
    ignoreSessionId?: string,
    ignoreCustomerTabId?: string
  ) {
    const sourceAvailable = getAvailableStock(option.item, ignoreSessionId, ignoreCustomerTabId);
    if (option.isBaseItem) {
      return getInventoryPickerDetail(option.item, ignoreSessionId, ignoreCustomerTabId);
    }
    const sellableQuantity = Math.floor(sourceAvailable / option.stockUnitsPerSale);
    const leftover = sourceAvailable % option.stockUnitsPerSale;
    return `${sellableQuantity} available (${sourceAvailable} ${option.sourceName} in stock, ${option.stockUnitsPerSale} per sale${leftover > 0 ? `, ${leftover} leftover` : ""})`;
  }

  function isSellableOptionUnavailable(
    option: SellableInventoryOption,
    ignoreSessionId?: string,
    ignoreCustomerTabId?: string
  ) {
    return getAvailableStock(option.item, ignoreSessionId, ignoreCustomerTabId) < option.stockUnitsPerSale;
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUsername = loginUsername.trim();
    if (!trimmedUsername) { setLoginError("Username is required."); return; }
    if (!loginPassword.trim()) { setLoginError("Password is required."); return; }
    if (trimmedUsername.length > 64) { setLoginError("Username is too long."); return; }
    if (backendConfigured) {
      void runBlockingAction("Signing in...", async () => {
        const profile = await signInWithUsername(loginUsername, loginPassword);
        const snapshot = await defaultRemoteDataGateway.loadAppDataSnapshot();
        skipRemotePersistRef.current = true;
        setAppData(normalizeAppDataCustomers(snapshot.appData));
        setRemoteVersion(snapshot.version);
        setActiveUserId(profile.id);
        setLoginError("");
        setRemoteError("");
        setRemoteRestoreState("ready");
        setActiveTab("dashboard");
      }).catch((error: unknown) => {
        setLoginError(error instanceof Error ? error.message : "Invalid username or password.");
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
      if (!guardRemoteWrite()) {
        setOwnPasswordError(remoteReadOnlyMessage);
        return;
      }
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
        void commitAppDataChange("Updating password...", (data) => {
          const user = data.users.find((u) => u.id === activeUser.id);
          if (user) user.password = hashed;
        }, () => setOwnPasswordDraft(null));
      })();
    }
  }

  function handleLogout() {
    if (backendConfigured) {
      void runBlockingAction("Signing out...", async () => {
        await signOutRemote();
        clearCachedNormalizedOrganizationId();
        setActiveUserId(null);
        setRemoteError("");
        setRemoteRestoreState("ready");
      });
      return;
    }
    clearCachedNormalizedOrganizationId();
    setActiveUserId(null);
  }

  function getPendingBillsForCustomerDetails(customerId?: string, name?: string, phone?: string): Bill[] {
    return findPendingBillsForCustomer(appData.bills, customerId, name, phone);
  }

  function replacePendingBillsForCustomer(
    bills: Bill[],
    pendingBills: Bill[],
    customerId?: string,
    name?: string,
    phone?: string
  ): Bill[] {
    const localPendingIds = new Set(
      findPendingBillsForCustomer(bills, customerId, name, phone).map((bill) => bill.id)
    );
    const freshPendingIds = new Set(pendingBills.map((bill) => bill.id));
    const retainedBills = bills.filter((bill) => !localPendingIds.has(bill.id) || freshPendingIds.has(bill.id));
    return mergeBillsById(pendingBills, retainedBills);
  }

  async function loadFreshPendingBillsForCustomerDetails(
    customerId?: string,
    name?: string,
    phone?: string
  ): Promise<Bill[]> {
    const localPendingBills = getPendingBillsForCustomerDetails(customerId, name, phone);
    if (!backendConfigured || !BACKEND_FEATURE_FLAGS.normalizedBootstrap) {
      return localPendingBills;
    }
    if (!customerId && !normalizeCustomerName(name) && !normalizeCustomerPhone(phone)) {
      return [];
    }
    try {
      const freshPendingBills = await loadNormalizedPendingBills({
        customerId,
        customerName: name,
        customerPhone: phone
      });
      skipRemotePersistRef.current = true;
      setAppData((previous) => ({
        ...previous,
        bills: replacePendingBillsForCustomer(previous.bills, freshPendingBills, customerId, name, phone)
      }));
      return freshPendingBills;
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Unable to verify pending bills: ${error.message}`
          : "Unable to verify pending bills from the backend.",
        { cause: error }
      );
    }
  }

  function applyPendingSettlementAmount(draft: PendingSettlementDraft, amount: number): PendingSettlementDraft {
    if (draft.paymentMode === "upi") {
      return { ...draft, cashAmount: 0, upiAmount: amount };
    }
    if (draft.paymentMode === "split") {
      return { ...draft, cashAmount: amount, upiAmount: 0 };
    }
    return { ...draft, cashAmount: amount, upiAmount: 0 };
  }

  function getPendingSettlementDueForIds(billIds: string[]): number {
    const selected = new Set(billIds);
    return sumBy(
      appData.bills.filter((bill) => selected.has(bill.id) && bill.status === "pending" && bill.amountDue > 0),
      (bill) => bill.amountDue
    );
  }

  function createPendingSettlementDraftForCustomer(customerId?: string, name?: string, phone?: string) {
    const pendingBillsForCustomer = getPendingBillsForCustomerDetails(customerId, name, phone);
    if (pendingBillsForCustomer.length === 0) return undefined;
    const billIds = pendingBillsForCustomer.map((bill) => bill.id);
    const draft: PendingSettlementDraft = {
      availableBillIds: billIds,
      billIds,
      paymentMode: "cash" as const,
      cashAmount: 0,
      upiAmount: 0
    };
    return applyPendingSettlementAmount(draft, sumBy(pendingBillsForCustomer, (bill) => bill.amountDue));
  }

  function getPendingBillFocusSearch(pendingBillsForCustomer: Bill[], fallbackLabel: string): string {
    const first = pendingBillsForCustomer[0];
    return first?.customerPhone?.trim() || first?.customerName?.trim() || fallbackLabel.trim() || first?.billNumber || "";
  }

  function viewPendingBillsForWarning() {
    if (!pendingWarningDraft) return;
    const search = getPendingBillFocusSearch(pendingWarningDraft.pendingBills, pendingWarningDraft.customerLabel);
    setPendingWarningDraft(null);
    setShowStartSessionModal(false);
    setSelectedReceiptBillId(null);
    setBillRegisterFocus({ token: Date.now(), search });
    setActiveTab("bills");
  }

  async function doStartSessionDirect(draftValue: StartSessionDraft = startSessionDraft) {
    if (!activeUser || !draftValue.stationId) {
      return;
    }
    const station = appData.stations.find((entry) => entry.id === draftValue.stationId);
    if (!station || getActiveSessionForStation(station.id)) {
      return;
    }
    const pricingSnapshot = appData.pricingRules.filter((rule) => rule.stationId === station.id);
    const sessionPlayMode = station.ltpEnabled ? draftValue.playMode : "group";
    const initialItems: SessionItem[] = [];
    const combo = draftValue.comboId
      ? appData.combos.find((entry) => entry.id === draftValue.comboId && (entry.type ?? "game") === "game" && entry.active && entry.stationIds.includes(station.id))
      : undefined;
    const comboApplication = combo ? buildComboApplication(combo, draftValue.comboChoices) : null;
    if (combo && !comboApplication) {
      window.alert("Select all required combo choices before starting this session.");
      return;
    }
    if (comboApplication) {
      const unavailable = findUnavailableComboSelection(getComboInventorySelections(comboApplication));
      if (unavailable) {
        const item = appData.inventoryItems.find((entry) => entry.id === unavailable[0]);
        window.alert(`Not enough stock available for ${item?.name ?? "one combo item"}.`);
        return;
      }
      initialItems.push(...getComboSessionItems(comboApplication));
    }
    if (station.mode === "unit_sale") {
      const arcadeItem = appData.inventoryItems.find(
        (entry) => entry.id === draftValue.arcadeItemId && entry.active
      );
      if (!arcadeItem) {
        window.alert("Select an arcade coin pack before starting this session.");
        return;
      }
      const upfrontQuantity = clampNumber(draftValue.arcadeQuantity, 1);
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
    const customerName = draftValue.customerName;
    const customerPhone = draftValue.customerPhone;
    const continuedFromSession = lastHoppedSessionId && postHopContinuationMode === "gaming"
      ? appData.sessions.find((session) => session.id === lastHoppedSessionId)
      : undefined;
    const continuedFromSessionIds = continuedFromSession
      ? getContinuationSessionIds(continuedFromSession)
      : undefined;
    const sessionId = createId("session");
    const startedAt = new Date().toISOString();
    const session: Session = {
      id: sessionId,
      stationId: station.id,
      stationNameSnapshot: station.name,
      mode: station.mode,
      startedAt,
      status: "active",
      customerName: customerName.trim() || undefined,
      customerPhone: customerPhone.trim() || undefined,
      playMode: sessionPlayMode,
      ltpEligible: station.ltpEnabled,
      pricingSnapshot,
      items: initialItems,
      comboApplications: comboApplication ? [comboApplication] : [],
      pauseLogIds: [],
      continuedFromSessionIds,
      customerId: draftValue.customerId
    };
    const comboReservationMovements = comboApplication
      ? initialItems
          .filter((item) => item.comboApplicationId === comboApplication.id)
          .flatMap((sessionItem) => {
            const inventoryEntry = appData.inventoryItems.find((entry) => entry.id === sessionItem.inventoryItemId);
            if (!inventoryEntry || inventoryEntry.isReusable) {
              return [];
            }
            const stockNeeded = getLineStockQuantity(sessionItem);
            return [{
              id: createId("stock"),
              itemId: sessionItem.inventoryItemId,
              type: "session_reservation" as StockMovementType,
              quantity: -stockNeeded,
              reason: `Reserved ${sessionItem.name} for combo ${comboApplication.comboName} on ${station.name}`,
              createdAt: startedAt,
              userId: activeUser.id
            }];
          })
      : [];
    const auditMessage = continuedFromSession
      ? `Started ${sessionPlayMode} session on ${station.name}, continuing hopped session from ${continuedFromSession.stationNameSnapshot}.`
      : comboApplication
        ? `Started ${sessionPlayMode} session on ${station.name} with combo ${comboApplication.comboName}.`
        : `Started ${sessionPlayMode} session on ${station.name}${station.mode === "unit_sale" ? ` with ${initialItems[0]?.quantity ?? 0} ${initialItems[0]?.name ?? "coin pack(s)"}.` : station.ltpEnabled ? " with LTP enabled." : "."}`;
    let retryMutation = continuedFromSession
      ? pendingOperationalMutationsRef.current.find((mutation) => {
          const payload = mutation.payload as { session?: Session };
          return (
            mutation.kind === "startSession" &&
            mutation.retryPolicy === "manual" &&
            mutation.status === "failed" &&
            payload.session?.continuedFromSessionIds?.includes(continuedFromSession.id)
          );
        })
      : undefined;
    if (retryMutation) {
      const retryPayload = retryMutation.payload as { session?: Session };
      const getStartRequestSignature = (value: Session | undefined) =>
        JSON.stringify(
          value
            ? {
                stationId: value.stationId,
                mode: value.mode,
                customerId: value.customerId,
                customerName: value.customerName,
                customerPhone: value.customerPhone,
                playMode: value.playMode,
                ltpEligible: value.ltpEligible,
                pricingSnapshot: value.pricingSnapshot,
                items: value.items.map(({ id: _id, addedAt: _addedAt, comboApplicationId: _comboApplicationId, ...item }) => item),
                comboApplications: (value.comboApplications ?? []).map(
                  ({ id: _id, appliedAt: _appliedAt, ...application }) => application
                ),
                continuedFromSessionIds: value.continuedFromSessionIds
              }
            : null
        );
      if (getStartRequestSignature(retryPayload.session) !== getStartRequestSignature(session)) {
        discardOperationalMutation(retryMutation.id);
        retryMutation = undefined;
      }
    }
    const mutation = retryMutation ?? createOperationalMutation(
      "startSession",
      "Starting session",
      "session",
      sessionId,
      {
        session,
        customer: customerName.trim() || customerPhone.trim()
          ? { id: draftValue.customerId ?? createId("customer"), name: customerName, phone: customerPhone, visitAt: startedAt }
          : undefined,
        stockMovements: comboReservationMovements,
        auditLogs: [{
          id: createId("audit"),
          action: "session_started",
          entityType: "session",
          entityId: sessionId,
          message: auditMessage,
          createdAt: startedAt,
          userId: activeUser.id
        }]
      },
      continuedFromSession
        ? {
            retryPolicy: "manual",
            optimistic: false,
            acknowledgementRequired: true
          }
        : undefined
    );
    const finishStart = () => {
      setStartSessionDraft(createStartSessionDraft());
      setLastHoppedSessionId(null);
      setPostHopContinuationMode("gaming");
      setPostHopCustomerLocked(true);
      setShowStartSessionModal(false);
    };
    if (continuedFromSession) {
      const outcome = await commitCriticalOperationalChange(
        mutation,
        `hop-continuation:${continuedFromSession.id}`,
        { existingMutation: Boolean(retryMutation) }
      );
      if (outcome.status !== "synced") {
        if (mutation) {
          alertedOperationalMutationIdsRef.current.add(mutation.id);
        }
        window.alert(
          outcome.status === "conflict"
            ? "The next game was not started because the latest server state changed. Review the continuation and try again."
            : `The next game was not started. ${outcome.failureReason}`
        );
        return;
      }
      finishStart();
      return;
    }
    commitOperationalChange(mutation, finishStart);
  }

  async function startSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !startSessionDraft.stationId) {
      return;
    }
    const station = appData.stations.find((entry) => entry.id === startSessionDraft.stationId);
    if (!station || getActiveSessionForStation(station.id)) {
      return;
    }
    let resolvedDraft: StartSessionDraft;
    let pendingForCustomer: Bill[];
    try {
      const result = await runBlockingAction("Checking customer details...", async () => {
        const nextDraft = await resolveExactCustomerDraft(startSessionDraft);
        const pendingBills = await loadFreshPendingBillsForCustomerDetails(
          nextDraft.customerId,
          nextDraft.customerName,
          nextDraft.customerPhone
        );
        return { nextDraft, pendingBills };
      });
      resolvedDraft = result.nextDraft;
      pendingForCustomer = result.pendingBills;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to verify pending bills.");
      return;
    }
    if (pendingForCustomer.length > 0) {
      const label = resolvedDraft.customerPhone.trim() || resolvedDraft.customerName.trim();
      setPendingWarningDraft({ pendingBills: pendingForCustomer, customerLabel: label, intent: { type: "session", draftValue: resolvedDraft } });
      return;
    }
    await doStartSessionDirect(resolvedDraft);
  }

  function toggleSessionPause(sessionId: string, shouldPause: boolean) {
    if (!activeUser) {
      return;
    }
    const session = appData.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }
    const changedAt = new Date().toISOString();
    const auditLog = {
      id: createId("audit"),
      action: shouldPause ? "session_paused" : "session_resumed",
      entityType: "session",
      entityId: sessionId,
      message: `${shouldPause ? "Paused" : "Resumed"} ${session.stationNameSnapshot}.`,
      createdAt: changedAt,
      userId: activeUser.id
    };
    if (shouldPause) {
      const pauseLog = {
        id: createId("pause"),
        sessionId,
        pausedAt: changedAt
      };
      commitOperationalChange(createOperationalMutation(
        "pauseSession",
        "Pausing session",
        "session",
        sessionId,
        { sessionId, pauseLog, auditLog }
      ));
      return;
    }
    const openPause = appData.sessionPauseLogs.find((entry) => entry.sessionId === sessionId && !entry.resumedAt);
    commitOperationalChange(createOperationalMutation(
      "resumeSession",
      "Resuming session",
      "session",
      sessionId,
      { sessionId, pauseLogId: openPause?.id, resumedAt: changedAt, auditLog }
    ));
  }

  function editPauseLogEntry(logId: string, patch: Partial<Pick<SessionPauseLog, "pausedAt" | "resumedAt">>) {
    if (!activeUser) return;
    const log = appData.sessionPauseLogs.find((entry) => entry.id === logId);
    if (!log) return;
    const session = appData.sessions.find((entry) => entry.id === log.sessionId);
    if (!session) return;
    const newPausedAt = patch.pausedAt ?? log.pausedAt;
    const newResumedAt = patch.resumedAt ?? log.resumedAt;
    if (new Date(newPausedAt).getTime() < new Date(session.startedAt).getTime()) {
      window.alert("Pause time cannot be before the session start time.");
      return;
    }
    if (newResumedAt && new Date(newResumedAt).getTime() <= new Date(newPausedAt).getTime()) {
      window.alert("Resume time must be after pause time.");
      return;
    }
    const otherLogs = appData.sessionPauseLogs.filter((entry) => entry.sessionId === log.sessionId && entry.id !== logId);
    const overlap = otherLogs.some((other) => {
      const otherEnd = other.resumedAt ? new Date(other.resumedAt).getTime() : Infinity;
      const newEnd = newResumedAt ? new Date(newResumedAt).getTime() : Infinity;
      return new Date(newPausedAt).getTime() < otherEnd && new Date(other.pausedAt).getTime() < newEnd;
    });
    if (overlap) {
      window.alert("Pause intervals cannot overlap.");
      return;
    }
    const pauseLog = {
      ...log,
      pausedAt: patch.pausedAt ? new Date(patch.pausedAt).toISOString() : log.pausedAt,
      resumedAt: patch.resumedAt !== undefined
        ? patch.resumedAt ? new Date(patch.resumedAt).toISOString() : undefined
        : log.resumedAt
    };
    const auditLog = {
      id: createId("audit"),
      action: "pause_log_edited",
      entityType: "session",
      entityId: log.sessionId,
      message: `Edited pause log entry for ${session.stationNameSnapshot}.`,
      createdAt: new Date().toISOString(),
      userId: activeUser.id
    };
    commitOperationalChange(createOperationalMutation(
      "editPauseLog",
      "Saving pause log",
      "session",
      log.sessionId,
      { sessionId: log.sessionId, pauseLog, auditLog }
    ), () => setEditingPauseLogId(null));
  }

  function deletePauseLogEntry(logId: string) {
    if (!activeUser) return;
    const log = appData.sessionPauseLogs.find((entry) => entry.id === logId);
    if (!log) return;
    const session = appData.sessions.find((entry) => entry.id === log.sessionId);
    if (!session) return;
    const auditLog = {
      id: createId("audit"),
      action: "pause_log_deleted",
      entityType: "session",
      entityId: log.sessionId,
      message: `Deleted pause log entry for ${session.stationNameSnapshot}.`,
      createdAt: new Date().toISOString(),
      userId: activeUser.id
    };
    commitOperationalChange(createOperationalMutation(
      "deletePauseLog",
      "Deleting pause log",
      "session",
      log.sessionId,
      { sessionId: log.sessionId, pauseLogId: logId, auditLog }
    ), () => setPauseLogDeleteConfirmId(null));
  }

  function addItemToSession(sessionId: string) {
    const form = sessionItemForm[sessionId];
    if (!activeUser || !form?.sellableOptionId) {
      return;
    }
    const option = sellableOptionById.get(form.sellableOptionId);
    const item = option?.item;
    const packOf = form.sellAsPackOf;
    const stockUnitsPerSale = packOf ?? option?.stockUnitsPerSale ?? 1;
    const stockNeeded = form.quantity * stockUnitsPerSale;
    if (!option || !item || getAvailableStock(item) < stockNeeded) {
      if (packOf && item && getAvailableStock(item) < stockNeeded) {
        window.alert(`Cannot sell as pack - only ${getAvailableStock(item)} cigarettes in stock (need ${stockNeeded} for ${form.quantity} pack${form.quantity !== 1 ? "s" : ""}). Please restock first or sell as singles.`);
      } else {
        window.alert(item?.isReusable ? `${item.name} is currently occupied.` : `Not enough stock available for ${option?.name ?? "that item"}.`);
      }
      return;
    }
    const session = appData.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }
    const addedAt = new Date().toISOString();
    const sessionItem: SessionItem = {
      id: createId("session-item"),
      inventoryItemId: item.id,
      name: option.name,
      quantity: clampNumber(form.quantity, 1),
      unitPrice: packOf ? item.cigarettePack!.packPrice : option.price,
      soldAsPackOf: packOf,
      saleVariantId: option.saleVariantId,
      stockUnitsPerSale: option.saleVariantId ? option.stockUnitsPerSale : undefined,
      addedAt
    };
    const stockMovement = !item.isReusable
      ? {
          id: createId("stock"),
          itemId: item.id,
          type: "session_reservation" as StockMovementType,
          quantity: -stockNeeded,
          reason: `Reserved ${option.name} for ${session.stationNameSnapshot}${option.saleVariantId ? ` (${stockNeeded} ${item.name} unit${stockNeeded !== 1 ? "s" : ""})` : ""}`,
          createdAt: addedAt,
          userId: activeUser.id
        }
      : undefined;
    commitOperationalChange(createOperationalMutation(
      "addSessionItem",
      "Adding session item",
      "session",
      sessionId,
      {
        sessionId,
        item: sessionItem,
        stockMovement,
        auditLog: {
          id: createId("audit"),
          action: "session_item_added",
          entityType: "session",
          entityId: sessionId,
          message: `Added ${option.name}${packOf ? " (pack)" : ""} to ${session.stationNameSnapshot}.`,
          createdAt: addedAt,
          userId: activeUser.id
        }
      }
    ), () => {
      setSessionItemForm((previous) => ({
        ...previous,
        [sessionId]: { sellableOptionId: "", quantity: 1, sellAsPackOf: undefined }
      }));
    });
  }

  function repeatSessionCombo(sessionId: string) {
    if (!activeUser) {
      return;
    }
    const session = appData.sessions.find((entry) => entry.id === sessionId && entry.status !== "closed");
    const previousApplication = session?.comboApplications?.at(-1);
    if (!session || !previousApplication) {
      return;
    }
    const repeatedApplication: SessionComboApplication = {
      ...previousApplication,
      id: createId("combo-app"),
      appliedAt: new Date().toISOString(),
      fixedItems: previousApplication.fixedItems.map((item) => ({ ...item })),
      choices: previousApplication.choices.map((choice) => ({
        groupId: choice.groupId,
        groupLabel: choice.groupLabel,
        selections: (choice.selections ?? (choice.selection ? [choice.selection] : [])).map((selection) => ({ ...selection }))
      }))
    };
    const selections = getComboInventorySelections(repeatedApplication);
    const unavailable = findUnavailableComboSelection(selections);
    if (unavailable) {
      const item = appData.inventoryItems.find((entry) => entry.id === unavailable[0]);
      window.alert(`Not enough stock available to repeat combo item ${item?.name ?? ""}.`);
      return;
    }
    const repeatedItems = getComboSessionItems(repeatedApplication);
    const stockMovements = repeatedItems.flatMap((sessionItem) => {
      const inventoryEntry = appData.inventoryItems.find((entry) => entry.id === sessionItem.inventoryItemId);
      if (!inventoryEntry || inventoryEntry.isReusable) {
        return [];
      }
      const stockNeeded = getLineStockQuantity(sessionItem);
      return [{
        id: createId("stock"),
        itemId: sessionItem.inventoryItemId,
        type: "session_reservation" as StockMovementType,
        quantity: -stockNeeded,
        reason: `Reserved ${sessionItem.name} for repeated combo ${repeatedApplication.comboName} on ${session.stationNameSnapshot}`,
        createdAt: repeatedApplication.appliedAt,
        userId: activeUser.id
      }];
    });
    commitOperationalChange(createOperationalMutation(
      "repeatSessionCombo",
      "Repeating combo",
      "session",
      sessionId,
      {
        sessionId,
        comboApplication: repeatedApplication,
        items: repeatedItems,
        stockMovements,
        auditLog: {
          id: createId("audit"),
          action: "combo_repeated",
          entityType: "session",
          entityId: sessionId,
          message: `Repeated combo ${repeatedApplication.comboName} on ${session.stationNameSnapshot}.`,
          createdAt: repeatedApplication.appliedAt,
          userId: activeUser.id
        }
      }
    ));
  }

  function removeItemFromSession(sessionId: string, sessionItemId: string) {
    if (!activeUser) {
      return;
    }
    const session = appData.sessions.find((entry) => entry.id === sessionId);
    const item = session?.items.find((entry) => entry.id === sessionItemId);
    if (!session || !item) {
      return;
    }
    const removedAt = new Date().toISOString();
    const inventoryEntry = appData.inventoryItems.find((entry) => entry.id === item.inventoryItemId);
    const stockMovement = inventoryEntry && !inventoryEntry.isReusable
      ? {
          id: createId("stock"),
          itemId: item.inventoryItemId,
          type: "session_reservation_void" as StockMovementType,
          quantity: getLineStockQuantity(item),
          reason: `Released from ${session.stationNameSnapshot}`,
          createdAt: removedAt,
          userId: activeUser.id
        }
      : undefined;
    commitOperationalChange(createOperationalMutation(
      "removeSessionItem",
      "Removing session item",
      "session",
      sessionId,
      {
        sessionId,
        sessionItemId,
        stockMovement,
        auditLog: {
          id: createId("audit"),
          action: "session_item_removed",
          entityType: "session",
          entityId: sessionId,
          message: `Removed ${item.name} from ${session.stationNameSnapshot}.`,
          createdAt: removedAt,
          userId: activeUser.id
        }
      }
    ));
  }

  function beginEditSessionDetails(session: Session) {
    if (!canEditSessionCustomerDetails) {
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
    if (!activeUser || !canEditSessionCustomerDetails || !editSessionDraft) {
      return;
    }
    const sourceSession = getSessionById(editSessionDraft.sessionId);
    if (!sourceSession || sourceSession.status === "closed") {
      return;
    }
    if (canEditSessionTiming) {
      const nextStartedAt = parseDateTimeInputValue(editSessionDraft.startedAt);
      if (sourceSession.mode === "timed" && !nextStartedAt) {
        window.alert("Start time is required.");
        return;
      }
      if (sourceSession.mode === "timed" && new Date(nextStartedAt).getTime() > new Date(now).getTime()) {
        window.alert("Start time cannot be in the future.");
        return;
      }
    }
    const nextCustomerName = editSessionDraft.customerName.trim() || undefined;
    const nextCustomerPhone = editSessionDraft.customerPhone.trim() || undefined;
    const changes: string[] = [];
    if ((sourceSession.customerName ?? "") !== (nextCustomerName ?? "")) {
      changes.push(`customer name: ${formatAuditValue(sourceSession.customerName)} -> ${formatAuditValue(nextCustomerName)}`);
    }
    if ((sourceSession.customerPhone ?? "") !== (nextCustomerPhone ?? "")) {
      changes.push(`customer phone: ${formatAuditValue(sourceSession.customerPhone)} -> ${formatAuditValue(nextCustomerPhone)}`);
    }
    let nextStartedAt: string | undefined;
    if (canEditSessionTiming) {
      const parsedStartedAt = parseDateTimeInputValue(editSessionDraft.startedAt);
      const nextStartedAtNorm = new Date(parsedStartedAt).toISOString().substring(0, 19);
      const sessionStartNorm = new Date(sourceSession.startedAt).toISOString().substring(0, 19);
      if (sourceSession.mode === "timed" && parsedStartedAt && nextStartedAtNorm !== sessionStartNorm) {
        changes.push(`start time: ${formatDateTime(sourceSession.startedAt)} -> ${formatDateTime(parsedStartedAt)}`);
        nextStartedAt = parsedStartedAt;
      }
    }
    const changedAt = new Date().toISOString();
    commitOperationalChange(createOperationalMutation(
      "saveLiveSessionDetails",
      "Saving session details",
      "session",
      editSessionDraft.sessionId,
      {
        sessionId: editSessionDraft.sessionId,
        customer: nextCustomerName || nextCustomerPhone
          ? { id: createId("customer"), name: nextCustomerName, phone: nextCustomerPhone, visitAt: sourceSession.startedAt }
          : undefined,
        customerName: nextCustomerName,
        customerPhone: nextCustomerPhone,
        startedAt: nextStartedAt,
        auditLog: changes.length > 0
          ? {
              id: createId("audit"),
              action: "session_details_updated",
              entityType: "session",
              entityId: sourceSession.id,
              message: `Updated ${sourceSession.stationNameSnapshot}: ${changes.join("; ")}`,
              createdAt: changedAt,
              userId: activeUser.id
            }
          : undefined
      }
    ), () => setEditSessionDraft(null));
  }

  function openSessionCheckout(sessionId: string) {
    const session = getSessionById(sessionId);
    if (!session) {
      return;
    }
    if (hasPendingOperationalForSession(sessionId)) {
      window.alert("This session has pending sync changes. Please wait for sync to finish before checkout.");
      scheduleOperationalSync(0);
      return;
    }
    const closedAt = new Date().toISOString();
    // For hopped sessions, use the stored endedAt so the charge is billed at the hop time, not "now"
    const effectiveEndAt = session.closeDisposition === "hopped" && session.endedAt
      ? session.endedAt
      : closedAt;
    const directlyLinkedHops = getUnbilledHoppedSessionsForSession(session);
    setIsHopMode(false);
    setCheckoutState({
      mode: "session",
      mutationId: createId("financial"),
      sessionId,
      closedAt,
      sessionStartedAt: session.startedAt,
      sessionEndedAt: effectiveEndAt,
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
      hoppedSessionIds: directlyLinkedHops.map((s) => s.id),
      pendingSettlement: createPendingSettlementDraftForCustomer(session.customerId, session.customerName, session.customerPhone),
      ltpOutcome:
        session.ltpEligible && session.playMode === "solo"
          ? session.ltpOutcome ?? "lost"
          : undefined
    });
  }

  function createOrSelectCustomerTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void openOrCreateCustomerTab(customerTabDraft, {
      updateSaleDraft: true,
      clearDraft: true,
      switchToSale: false
    });
  }

  function completePostHopConsumablesTabSelection(tab: CustomerTab) {
    setSelectedCustomerTabId(tab.id);
    setCustomerTabDraft({
      customerId: tab.customerId,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? ""
    });
    setActiveTab("sale");
    setShowStartSessionModal(false);
    setPostHopTabLinkDraft(null);
    setLastHoppedSessionId(null);
    setPostHopContinuationMode("gaming");
    setPostHopCustomerLocked(true);
    setStartSessionDraft(createStartSessionDraft());
  }

  function linkCustomerTabContinuation(
    customerTabId: string,
    continuedFromSessionIds: string[],
    onSuccess?: (tab: CustomerTab) => void
  ) {
    if (!activeUser) {
      return false;
    }
    const targetTab = getCustomerTabById(customerTabId);
    if (!targetTab || targetTab.status !== "open") {
      window.alert("The selected customer tab is no longer open.");
      return false;
    }
    const continuationIds = Array.from(new Set(continuedFromSessionIds.filter(Boolean)));
    const linkedAt = new Date().toISOString();
    const auditLogs = continuationIds.map((sessionId) => {
      const hoppedSession = getSessionById(sessionId);
      return {
        id: createId("audit"),
        action: "customer_tab_continuation_linked",
        entityType: "customer_tab" as const,
        entityId: targetTab.id,
        message: `Linked ${targetTab.customerName}'s tab to hopped session from ${hoppedSession?.stationNameSnapshot ?? "previous session"}.`,
        createdAt: linkedAt,
        userId: activeUser.id
      };
    });
    const committed = commitOperationalChange(createOperationalMutation(
      "linkCustomerTabContinuation",
      "Linking customer tab...",
      "customer_tab",
      targetTab.id,
      {
        customerTabId: targetTab.id,
        continuedFromSessionIds: continuationIds,
        auditLogs
      }
    ), (nextAppData) => {
      const updatedTab = nextAppData.customerTabs.find((tab) => tab.id === targetTab.id) ?? targetTab;
      onSuccess?.(updatedTab);
    });
    if (!committed) {
      window.alert(remoteError || "Unable to link the hopped session to this customer tab.");
    }
    return committed;
  }

  async function openOrCreateCustomerTab(
    draftValue: CustomerTabDraft,
    options?: { updateSaleDraft?: boolean; clearDraft?: boolean; switchToSale?: boolean; continuedFromSessionIds?: string[]; onSuccess?: () => void }
  ) {
    if (!activeUser) {
      return;
    }
    const resolvedDraft = await runBlockingAction("Checking customer details...", () => resolveExactCustomerDraft(draftValue));
    const customerName = resolvedDraft.customerName.trim();
    const customerPhone = resolvedDraft.customerPhone.trim();
    if (!customerName) {
      window.alert("Customer name is required to open a tab.");
      return;
    }
    const matchingCustomer = resolvedDraft.customerId
      ? getCustomerById(resolvedDraft.customerId)
      : findCustomerProfileMatch(appData, customerName, customerPhone);
    const matchingCustomerId = resolvedDraft.customerId ?? matchingCustomer?.id;
    const isContinuation = Boolean(options?.continuedFromSessionIds?.length);
    const existing = appData.customerTabs.find(
      (tab) =>
        tab.status === "open" &&
        (isContinuation
          ? ((matchingCustomerId && tab.customerId === matchingCustomerId) ||
            (customerPhone && tab.customerPhone?.trim() === customerPhone))
          : ((matchingCustomerId && tab.customerId === matchingCustomerId) ||
            tab.customerName.trim().toLowerCase() === customerName.toLowerCase() ||
            (customerPhone && tab.customerPhone?.trim() === customerPhone)))
    );
    if (existing) {
      if (options?.continuedFromSessionIds?.length) {
        linkCustomerTabContinuation(existing.id, options.continuedFromSessionIds, () => {
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
          options?.onSuccess?.();
        });
        return;
      }
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
      options?.onSuccess?.();
      return;
    }

    let pendingForCustomer: Bill[];
    try {
      pendingForCustomer = await runBlockingAction("Checking pending bills...", () =>
        loadFreshPendingBillsForCustomerDetails(resolvedDraft.customerId, customerName, customerPhone)
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to verify pending bills.");
      return;
    }
    if (pendingForCustomer.length > 0) {
      const label = customerPhone || customerName;
      setPendingWarningDraft({ pendingBills: pendingForCustomer, customerLabel: label, intent: { type: "tab", draftValue: resolvedDraft, options } });
      return;
    }
    doCommitTabDirect(resolvedDraft, options);
  }

  function doCommitTabDirect(
    draftValue: CustomerTabDraft,
    options?: { updateSaleDraft?: boolean; clearDraft?: boolean; switchToSale?: boolean; continuedFromSessionIds?: string[]; onSuccess?: () => void }
  ) {
    if (!activeUser) {
      return;
    }
    const customerName = draftValue.customerName.trim();
    const customerPhone = draftValue.customerPhone.trim();
    const tabId = createId("customer-tab");
    let resolvedCustomerId = draftValue.customerId;
    const createdAt = new Date().toISOString();
    const continuedFromSession = options?.continuedFromSessionIds?.[0]
      ? appData.sessions.find((session) => session.id === options.continuedFromSessionIds![0])
      : undefined;
    commitOperationalChange(createOperationalMutation(
      "openCustomerTab",
      "Opening customer tab",
      "customer_tab",
      tabId,
      {
        tab: {
          id: tabId,
          customerName,
          customerPhone: customerPhone || undefined,
          status: "open",
          createdAt,
          items: [],
          continuedFromSessionIds: options?.continuedFromSessionIds?.length
            ? Array.from(new Set(options.continuedFromSessionIds))
            : undefined
        },
        customer: customerName || customerPhone
          ? { id: resolvedCustomerId ?? createId("customer"), name: customerName, phone: customerPhone, visitAt: createdAt }
          : undefined,
        auditLog: {
          id: createId("audit"),
          action: "customer_tab_opened",
          entityType: "customer_tab",
          entityId: tabId,
          message: continuedFromSession
            ? `Opened customer tab for ${customerName}, continuing hopped session from ${continuedFromSession.stationNameSnapshot}.`
            : `Opened customer tab for ${customerName}.`,
          createdAt,
          userId: activeUser.id
        }
      }
    ), (nextAppData) => {
      resolvedCustomerId = nextAppData.customerTabs.find((tab) => tab.id === tabId)?.customerId;
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
      options?.onSuccess?.();
    });
  }

  function createDashboardCustomerTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void openOrCreateCustomerTab(dashboardCustomerTabDraft, {
      updateSaleDraft: true,
      clearDraft: true,
      switchToSale: false
    });
  }

  function beginEditCustomerTabDetails(tab: CustomerTab) {
    if (!canEditSessionCustomerDetails || tab.status !== "open") {
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
    if (!activeUser || !canEditSessionCustomerDetails || !editCustomerTabDraft) {
      return;
    }
    const nextCustomerName = editCustomerTabDraft.customerName.trim();
    if (!nextCustomerName) {
      window.alert("Customer name is required.");
      return;
    }
    const nextCustomerPhone = editCustomerTabDraft.customerPhone.trim() || undefined;
    let resolvedCustomerId = editCustomerTabDraft.customerId;
    const sourceTab = appData.customerTabs.find((entry) => entry.id === editCustomerTabDraft.customerTabId && entry.status === "open");
    if (!sourceTab) {
      return;
    }
    const changes: string[] = [];
    if (sourceTab.customerName !== nextCustomerName) {
      changes.push(`customer name: ${formatAuditValue(sourceTab.customerName)} -> ${formatAuditValue(nextCustomerName)}`);
    }
    if ((sourceTab.customerPhone ?? "") !== (nextCustomerPhone ?? "")) {
      changes.push(`customer phone: ${formatAuditValue(sourceTab.customerPhone)} -> ${formatAuditValue(nextCustomerPhone)}`);
    }
    const changedAt = new Date().toISOString();
    commitOperationalChange(createOperationalMutation(
      "saveLiveCustomerTabDetails",
      "Saving customer details",
      "customer_tab",
      editCustomerTabDraft.customerTabId,
      {
        customerTabId: editCustomerTabDraft.customerTabId,
        customer: { id: resolvedCustomerId ?? createId("customer"), name: nextCustomerName, phone: nextCustomerPhone, visitAt: sourceTab.createdAt },
        customerName: nextCustomerName,
        customerPhone: nextCustomerPhone,
        auditLog: changes.length > 0
          ? {
              id: createId("audit"),
              action: "customer_tab_details_updated",
              entityType: "customer_tab",
              entityId: sourceTab.id,
              message: `Updated customer tab: ${changes.join("; ")}`,
              createdAt: changedAt,
              userId: activeUser.id
            }
          : undefined
      }
    ), (nextAppData) => {
      resolvedCustomerId = nextAppData.customerTabs.find((tab) => tab.id === sourceTab.id)?.customerId;
      setCustomerTabDraft({
        customerId: resolvedCustomerId,
        customerName: nextCustomerName,
        customerPhone: nextCustomerPhone ?? ""
      });
      setEditCustomerTabDraft(null);
    });
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
    void commitAppDataChange("Saving customer profile...", (draft) => {
      const customer = draft.customers.find((entry) => entry.id === editCustomerProfileDraft.customerId);
      if (!customer) {
        return false;
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
    }, () => setEditCustomerProfileDraft(null));
  }

  function addItemToCustomerTab(customerTabId: string, option: SellableInventoryOption, sellAsPackOf?: number) {
    const targetTab = appData.customerTabs.find((tab) => tab.id === customerTabId && tab.status === "open");
    const item = option.item;
    if (!activeUser || !targetTab) {
      window.alert("Open or select a customer tab first.");
      return;
    }
    const stockNeeded = sellAsPackOf ?? option.stockUnitsPerSale;
    if (getAvailableStock(item) < stockNeeded) {
      if (sellAsPackOf) {
        window.alert(`Cannot sell as pack - only ${getAvailableStock(item)} cigarettes in stock (need ${sellAsPackOf} for 1 pack). Please restock first or sell as singles.`);
      } else {
        window.alert(item.isReusable ? `${item.name} is currently occupied.` : `${option.name} is out of stock.`);
      }
      return;
    }
    const addedAt = new Date().toISOString();
    commitOperationalChange(createOperationalMutation(
      "addCustomerTabItem",
      "Adding customer tab item",
      "customer_tab",
      targetTab.id,
      {
        customerTabId: targetTab.id,
        line: {
          id: createId("customer-tab-item"),
          inventoryItemId: item.id,
          name: option.name,
          quantity: 1,
          unitPrice: sellAsPackOf ? item.cigarettePack!.packPrice : option.price,
          soldAsPackOf: sellAsPackOf,
          saleVariantId: option.saleVariantId,
          stockUnitsPerSale: option.saleVariantId ? option.stockUnitsPerSale : undefined,
          addedAt
        },
        quantityDelta: 1,
        auditLog: {
          id: createId("audit"),
          action: "customer_tab_item_added",
          entityType: "customer_tab",
          entityId: targetTab.id,
          message: `Added ${option.name}${sellAsPackOf ? " (pack)" : ""} to ${targetTab.customerName}'s tab.`,
          createdAt: addedAt,
          userId: activeUser.id
        }
      }
    ));
  }

  function applyComboToCustomerTab(customerTabId: string, comboId: string, choices: Record<string, string[]> = {}) {
    const targetTab = appData.customerTabs.find((tab) => tab.id === customerTabId && tab.status === "open");
    const combo = appData.combos.find((entry) => entry.id === comboId && entry.active && entry.type === "consumables");
    if (!activeUser || !targetTab || !combo) {
      window.alert("Open a customer tab and choose an active consumables combo first.");
      return;
    }
    const comboApplication = buildComboApplication(combo, choices);
    if (!comboApplication) {
      window.alert("Select all required combo choices before applying this combo.");
      return;
    }
    const selections = getComboInventorySelections(comboApplication);
    const unavailable = findUnavailableComboSelection(selections);
    if (unavailable) {
      const [itemId] = unavailable;
      const item = appData.inventoryItems.find((entry) => entry.id === itemId);
      window.alert(`${item?.name ?? "One combo item"} is not available in the required quantity.`);
      return;
    }
    const appliedAt = comboApplication.appliedAt;
    commitOperationalChange(createOperationalMutation(
      "applyCustomerTabCombo",
      "Applying customer tab combo",
      "customer_tab",
      targetTab.id,
      {
        customerTabId: targetTab.id,
        comboApplication,
        items: getComboCustomerTabItems(comboApplication),
        auditLog: {
          id: createId("audit"),
          action: "customer_tab_combo_applied",
          entityType: "customer_tab",
          entityId: targetTab.id,
          message: `Applied combo ${combo.name} to ${targetTab.customerName}'s tab.`,
          createdAt: appliedAt,
          userId: activeUser.id
        }
      }
    ));
  }

  function updateCustomerTabItemQuantity(customerTabId: string, lineId: string, quantity: number) {
    const targetTab = appData.customerTabs.find((tab) => tab.id === customerTabId && tab.status === "open");
    if (!activeUser || !targetTab) {
      return;
    }
    const nextQuantity = clampNumber(quantity, 1);
    const currentLine = targetTab.items.find((entry) => entry.id === lineId);
    if (!currentLine) {
      return;
    }
    if (currentLine.comboApplicationId) {
      window.alert("Included combo items cannot be edited directly. Apply the combo again if the customer wants another set.");
      return;
    }
    if (currentLine.quantity === nextQuantity) {
      return;
    }
    const currentItem = currentLine
      ? appData.inventoryItems.find((entry) => entry.id === currentLine.inventoryItemId && entry.active)
      : undefined;
    const availableForLineUpdate = currentItem
      ? getAvailableStockForCustomerTabLineUpdate(currentItem, targetTab.id, lineId)
      : 0;
    if (
      currentLine &&
      currentItem &&
      getLineStockQuantity({ ...currentLine, quantity: nextQuantity }) > availableForLineUpdate
    ) {
      const availableSaleUnits = Math.floor(availableForLineUpdate / getStockUnitsPerSale(currentLine));
      window.alert(`Only ${availableSaleUnits} available for ${currentLine.name}.`);
      return;
    }
    commitOperationalChange(createOperationalMutation(
      "updateCustomerTabItemQuantity",
      "Updating customer tab item quantity",
      "customer_tab",
      targetTab.id,
      { customerTabId: targetTab.id, lineId, quantity: nextQuantity }
    ));
  }

  function removeItemFromCustomerTab(customerTabId: string, lineId: string) {
    const targetTab = appData.customerTabs.find((tab) => tab.id === customerTabId && tab.status === "open");
    if (!activeUser || !targetTab) {
      return;
    }
    const line = targetTab.items.find((entry) => entry.id === lineId);
    if (line?.comboApplicationId) {
      window.alert("Included combo items cannot be removed directly. Remove or void the whole tab during checkout if needed.");
      return;
    }
    const removedAt = new Date().toISOString();
    commitOperationalChange(createOperationalMutation(
      "removeCustomerTabItem",
      "Removing customer tab item",
      "customer_tab",
      targetTab.id,
      {
        customerTabId: targetTab.id,
        lineId,
        auditLog: line
          ? {
              id: createId("audit"),
              action: "customer_tab_item_removed",
              entityType: "customer_tab",
              entityId: targetTab.id,
              message: `Removed ${line.name} from ${targetTab.customerName}'s tab.`,
              createdAt: removedAt,
              userId: activeUser.id
            }
          : undefined
      }
    ));
  }

  function beginCustomerTabCheckout() {
    const previousHops = selectedCustomerTab ? getUnbilledHoppedSessionsForTab(selectedCustomerTab) : [];
    if (!selectedCustomerTab || (selectedCustomerTab.items.length === 0 && previousHops.length === 0)) {
      window.alert("Open a customer tab and add items first.");
      return;
    }
    if (hasPendingOperationalForCustomerTab(selectedCustomerTab.id)) {
      window.alert("This customer tab has pending sync changes. Please wait for sync to finish before checkout.");
      scheduleOperationalSync(0);
      return;
    }
    setCheckoutState({
      mode: "customer_tab",
      mutationId: createId("financial"),
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
      lineDiscounts: {},
      hoppedSessionIds: previousHops.map((session) => session.id),
      pendingSettlement: createPendingSettlementDraftForCustomer(
        selectedCustomerTab.customerId,
        selectedCustomerTab.customerName,
        selectedCustomerTab.customerPhone
      )
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
    const previousHops = tab ? getUnbilledHoppedSessionsForTab(tab) : [];
    if (!tab || tab.status !== "open" || (tab.items.length === 0 && previousHops.length === 0)) {
      window.alert("Open a customer tab and add items first.");
      return;
    }
    if (hasPendingOperationalForCustomerTab(tab.id)) {
      window.alert("This customer tab has pending sync changes. Please wait for sync to finish before checkout.");
      scheduleOperationalSync(0);
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
      mutationId: createId("financial"),
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
      lineDiscounts: {},
      hoppedSessionIds: previousHops.map((session) => session.id),
      pendingSettlement: createPendingSettlementDraftForCustomer(tab.customerId, tab.customerName, tab.customerPhone)
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
    if (hasPendingOperationalForSession(sessionId)) {
      window.alert("This session has pending sync changes. Please wait for sync to finish before rejecting it.");
      scheduleOperationalSync(0);
      return;
    }
    const reason = window.prompt("Enter reason for rejecting this session:");
    if (!reason?.trim()) {
      return;
    }
    const rejectedAt = new Date().toISOString();
    const rejectedSession = cloneValue(session);
    const openPause =
      rejectedSession.status === "paused"
        ? appData.sessionPauseLogs.find((entry) => entry.sessionId === sessionId && !entry.resumedAt)
        : undefined;
    const rejectedPause = openPause ? cloneValue(openPause) : undefined;
    if (rejectedPause) {
      rejectedPause.resumedAt = rejectedAt;
    }
    rejectedSession.status = "closed";
    rejectedSession.endedAt = rejectedAt;
    rejectedSession.closeDisposition = "rejected";
    rejectedSession.closeReason = reason.trim();
    commitOperationalChange(createOperationalMutation(
      "rejectSession",
      "Rejecting session",
      "session",
      sessionId,
      {
        session: rejectedSession,
        pauseLog: rejectedPause,
        auditLog: {
          id: createId("audit"),
          action: "session_rejected",
          entityType: "session",
          entityId: sessionId,
          message: `Rejected ${rejectedSession.stationNameSnapshot}. Reason: ${reason.trim()}`,
          createdAt: rejectedAt,
          userId: activeUser.id
        }
      }
    ), () => {
      setCheckoutState((previous) =>
        previous?.mode === "session" && previous.sessionId === sessionId ? null : previous
      );
      setManageSessionId((previous) => (previous === sessionId ? null : previous));
    });
  }

  async function hopSession() {
    if (!activeUser || !checkoutState || checkoutState.mode !== "session" || !checkoutState.sessionId) {
      return;
    }
    const sessionId = checkoutState.sessionId;
    if (backendConfigured && !guardRemoteWrite()) {
      window.alert(remoteReadOnlyMessage);
      return;
    }
    if (backendConfigured && !online) {
      window.alert("An internet connection is required to confirm a game hop safely.");
      return;
    }
    const retryMutation = pendingOperationalMutationsRef.current.find(
      (mutation) =>
        mutation.kind === "hopSession" &&
        mutation.entityId === sessionId &&
        mutation.retryPolicy === "manual" &&
        mutation.status === "failed"
    );
    if (hasPendingOperationalForSession(sessionId) && !retryMutation) {
      window.alert("This session has pending sync changes. Please wait for sync to finish before hopping.");
      scheduleOperationalSync(0);
      return;
    }
    const effectiveEndAt = checkoutState.sessionEndedAt ?? checkoutState.closedAt ?? new Date().toISOString();
    // Capture customer before clearing checkout state
    const hopCustomerName = checkoutState.customerName;
    const hopCustomerPhone = checkoutState.customerPhone;
    const hopCustomerId = checkoutState.customerId;
    if (new Date(effectiveEndAt).getTime() > Date.now()) {
      window.alert("Session end time cannot be in the future.");
      return;
    }
    const targetSession = getSessionById(sessionId);
    if (!targetSession || targetSession.status === "closed") {
      return;
    }
    const hoppedAt = new Date().toISOString();
    const hoppedSession = cloneValue(targetSession);
    const openPause =
      hoppedSession.status === "paused"
        ? appData.sessionPauseLogs.find((entry) => entry.sessionId === sessionId && !entry.resumedAt)
        : undefined;
    const hoppedPause = openPause ? cloneValue(openPause) : undefined;
    if (targetSession.status === "paused") {
      if (hoppedPause) {
        hoppedPause.resumedAt = effectiveEndAt;
      }
    }
    hoppedSession.status = "closed";
    hoppedSession.endedAt = effectiveEndAt;
    hoppedSession.closeDisposition = "hopped";
    const mutation = retryMutation ?? createOperationalMutation(
        "hopSession",
        "Closing session for game hop",
        "session",
        sessionId,
        {
          session: hoppedSession,
          pauseLog: hoppedPause,
          auditLog: {
            id: createId("audit"),
            action: "session_hopped",
            entityType: "session",
            entityId: sessionId,
            message: `Game hop: closed ${hoppedSession.stationNameSnapshot} without billing. Station released for next customer.`,
            createdAt: hoppedAt,
            userId: activeUser.id
          }
        },
        {
          retryPolicy: "manual",
          optimistic: false,
          acknowledgementRequired: true
        }
      );
    const outcome = await commitCriticalOperationalChange(
      mutation,
      `hop:${sessionId}`,
      { existingMutation: Boolean(retryMutation) }
    );
    if (outcome.status !== "synced") {
      if (mutation) {
        alertedOperationalMutationIdsRef.current.add(mutation.id);
      }
      window.alert(
        outcome.status === "conflict"
          ? "The game hop was not completed. Latest data has been refreshed; review the session and try again."
          : `The game hop was not completed. ${outcome.failureReason}`
      );
      return;
    }
    setCheckoutState(null);
    setIsHopMode(false);
    setLastHoppedSessionId(sessionId);
    setPostHopContinuationMode("gaming");
    setPostHopCustomerLocked(true);
    setManageSessionId((previous) => (previous === sessionId ? null : previous));
    setStartSessionDraft((prev) => ({
      ...prev,
      customerId: hopCustomerId,
      customerName: hopCustomerName,
      customerPhone: hopCustomerPhone
    }));
    window.setTimeout(() => setShowStartSessionModal(true), 0);
  }

  function handleSetShowStartSessionModal(show: boolean) {
    if (!show) {
      setLastHoppedSessionId(null);
      setPostHopContinuationMode("gaming");
      setPostHopCustomerLocked(true);
      setPostHopTabLinkDraft(null);
    }
    if (show && lastHoppedSessionId) {
      const hoppedSession = appData.sessions.find((s) => s.id === lastHoppedSessionId);
      if (hoppedSession) {
        setStartSessionDraft((prev) => ({
          ...prev,
          customerId: hoppedSession.customerId,
          customerName: hoppedSession.customerName ?? "",
          customerPhone: hoppedSession.customerPhone ?? ""
        }));
      }
      setPostHopCustomerLocked(true);
    }
    setShowStartSessionModal(show);
  }

  function recoverHoppedSessionContinuation(session: Session) {
    setLastHoppedSessionId(session.id);
    setPostHopContinuationMode("gaming");
    setPostHopCustomerLocked(true);
    setPostHopTabLinkDraft(null);
    setStartSessionDraft({
      ...createStartSessionDraft(),
      customerId: session.customerId,
      customerName: session.customerName ?? "",
      customerPhone: session.customerPhone ?? ""
    });
    setShowStartSessionModal(true);
  }

  function billHoppedSession() {
    if (!lastHoppedSessionId) return;
    const sessionId = lastHoppedSessionId;
    discardFailedContinuationStart(sessionId);
    // Keep lastHoppedSessionId alive - needed to loop back to "Start Next Game" if billing is cancelled
    setShowStartSessionModal(false);  // bypass handleSetShowStartSessionModal so the ID stays set
    setPostHopContinuationMode("gaming");
    setPostHopTabLinkDraft(null);
    setStartSessionDraft(createStartSessionDraft());
    openSessionCheckout(sessionId);
  }

  function detachPostHopContinuation() {
    if (!lastHoppedSessionId || !activeUser) {
      return;
    }
    const detachedSessionId = lastHoppedSessionId;
    discardFailedContinuationStart(detachedSessionId);
    const hoppedSession = getSessionById(detachedSessionId);
    const auditLog = {
      id: createId("audit"),
      action: "hop_continuation_detached",
      entityType: "session",
      entityId: detachedSessionId,
      message: `Detached post-hop continuation${hoppedSession ? ` from ${hoppedSession.stationNameSnapshot}` : ""}.`,
      createdAt: new Date().toISOString(),
      userId: activeUser.id
    };
    commitOperationalChange(createOperationalMutation(
      "recordSessionAudit",
      "Detaching continuation",
      "session",
      detachedSessionId,
      { auditLog }
    ), () => {
      setLastHoppedSessionId(null);
      setPostHopContinuationMode("gaming");
      setPostHopCustomerLocked(false);
      setPostHopTabLinkDraft(null);
      setStartSessionDraft((previous) => ({
        ...previous,
        customerId: undefined,
        customerName: "",
        customerPhone: ""
      }));
    });
  }

  function startPostHopConsumablesTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lastHoppedSessionId) return;
    const hoppedSession = getSessionById(lastHoppedSessionId);
    const draftValue: CustomerTabDraft = {
      customerId: startSessionDraft.customerId ?? hoppedSession?.customerId,
      customerName: startSessionDraft.customerName || hoppedSession?.customerName || "",
      customerPhone: startSessionDraft.customerPhone || hoppedSession?.customerPhone || ""
    };
    if (!draftValue.customerName.trim()) {
      window.alert("Customer name is required to start a consumables tab.");
      return;
    }
    const continuedFromSessionIds = getContinuationSessionIds(hoppedSession);
    const matchingCustomer = draftValue.customerId
      ? getCustomerById(draftValue.customerId)
      : findCustomerProfileMatch(appData, draftValue.customerName, draftValue.customerPhone);
    const candidateTabs = getCustomerTabContinuationCandidates(openCustomerTabs, {
      customerId: matchingCustomer?.id ?? draftValue.customerId,
      customerName: draftValue.customerName,
      customerPhone: draftValue.customerPhone
    });
    if (candidateTabs.length > 0) {
      setPostHopTabLinkDraft({
        continuedFromSessionIds,
        candidateTabIds: candidateTabs.map((tab) => tab.id),
        selectedTabId: candidateTabs[0].id
      });
      return;
    }
    void openOrCreateCustomerTab(draftValue, {
      updateSaleDraft: true,
      clearDraft: false,
      switchToSale: true,
      continuedFromSessionIds,
      onSuccess: () => {
        setShowStartSessionModal(false);
        setPostHopTabLinkDraft(null);
        setLastHoppedSessionId(null);
        setPostHopContinuationMode("gaming");
        setPostHopCustomerLocked(true);
        setStartSessionDraft(createStartSessionDraft());
      }
    });
  }

  function confirmPostHopCustomerTabLink() {
    if (!postHopTabLinkDraft) {
      return;
    }
    const selectedTab = getCustomerTabById(postHopTabLinkDraft.selectedTabId);
    if (!selectedTab || selectedTab.status !== "open") {
      window.alert("The selected customer tab is no longer open. Choose another tab or start a new consumables tab.");
      setPostHopTabLinkDraft((previous) => {
        if (!previous) return previous;
        const remainingIds = previous.candidateTabIds.filter((tabId) => {
          const tab = getCustomerTabById(tabId);
          return tab?.status === "open";
        });
        return remainingIds.length > 0
          ? { ...previous, candidateTabIds: remainingIds, selectedTabId: remainingIds[0] }
          : null;
      });
      return;
    }
    linkCustomerTabContinuation(
      selectedTab.id,
      postHopTabLinkDraft.continuedFromSessionIds,
      completePostHopConsumablesTabSelection
    );
  }

  function returnToStartNextGame() {
    const hoppedSession = checkoutState?.sessionId ? getSessionById(checkoutState.sessionId) : null;
    setCheckoutState(null);
    setIsHopMode(false);
    setReplacementItemForm({ sellableOptionId: "", quantity: 1 });
    if (hoppedSession?.closeDisposition === "hopped") {
      setLastHoppedSessionId(hoppedSession.id);
      setPostHopContinuationMode("gaming");
      setPostHopCustomerLocked(true);
      setStartSessionDraft((prev) => ({
        ...prev,
        customerId: hoppedSession.customerId,
        customerName: hoppedSession.customerName ?? "",
        customerPhone: hoppedSession.customerPhone ?? ""
      }));
      setShowStartSessionModal(true);
    }
  }

  function rejectCustomerTab(customerTabId: string) {
    if (!activeUser) {
      return;
    }
    const tab = getCustomerTabById(customerTabId);
    if (!tab || tab.status !== "open") {
      return;
    }
    if (hasPendingOperationalForCustomerTab(customerTabId)) {
      window.alert("This customer tab has pending sync changes. Please wait for sync to finish before rejecting it.");
      scheduleOperationalSync(0);
      return;
    }
    const reason = window.prompt("Enter reason for rejecting this consumables tab:");
    if (!reason?.trim()) {
      return;
    }
    const rejectedAt = new Date().toISOString();
    const rejectedTab = cloneValue(tab);
    rejectedTab.status = "closed";
    rejectedTab.closedAt = rejectedAt;
    rejectedTab.closeDisposition = "rejected";
    rejectedTab.closeReason = reason.trim();
    commitOperationalChange(createOperationalMutation(
      "rejectCustomerTab",
      "Rejecting customer tab",
      "customer_tab",
      customerTabId,
      {
        tab: rejectedTab,
        auditLog: {
          id: createId("audit"),
          action: "customer_tab_rejected",
          entityType: "customer_tab",
          entityId: customerTabId,
          message: `Rejected ${rejectedTab.customerName}'s tab. Reason: ${reason.trim()}`,
          createdAt: rejectedAt,
          userId: activeUser.id
        }
      }
    ), () => {
      setCheckoutState((previous) =>
        previous?.mode === "customer_tab" && previous.customerTabId === customerTabId ? null : previous
      );
      setSelectedCustomerTabId((previous) => (previous === customerTabId ? null : previous));
    });
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
    setReplacementItemForm({ sellableOptionId: "", quantity: 1 });
    setCheckoutState({
      mode: "bill_replacement",
      mutationId: createId("financial"),
      replacementBillId: billId,
      customerId: bill.customerId,
      customerName: bill.customerName ?? "",
      customerPhone: bill.customerPhone ?? "",
      paymentMode: bill.paymentMode === "deferred" ? "cash" : bill.paymentMode,
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
    if (!checkoutState || checkoutState.mode !== "bill_replacement" || !replacementItemForm.sellableOptionId) {
      return;
    }
    const option = sellableOptionById.get(replacementItemForm.sellableOptionId);
    const item = option?.item;
    if (!option || !item) {
      return;
    }
    const originalBill = checkoutState.replacementBillId ? getBillById(checkoutState.replacementBillId) : undefined;
    const originalQuantities = getInventoryQuantityMap(originalBill?.lines ?? []);
    const currentQuantities = getInventoryQuantityMap(checkoutState.replacementLines ?? []);
    const nextStockQuantity = (currentQuantities[item.id] ?? 0) + clampNumber(replacementItemForm.quantity, 1) * option.stockUnitsPerSale;
    const requiredDelta = nextStockQuantity - (originalQuantities[item.id] ?? 0);
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
                description: option.name,
                quantity: clampNumber(replacementItemForm.quantity, 1),
                unitPrice: option.price,
                inventoryItemId: item.id,
                saleVariantId: option.saleVariantId,
                stockUnitsPerSale: option.saleVariantId ? option.stockUnitsPerSale : undefined
              }
            ]
          }
        : previous
    );
    setReplacementItemForm({ sellableOptionId: replacementItemForm.sellableOptionId, quantity: 1 });
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
    const totalAfterChange = (currentQuantities[item.id] ?? 0) + nextQuantity * getStockUnitsPerSale(targetLine);
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
    if (backendConfigured && !guardRemoteWrite()) {
      window.alert(remoteReadOnlyMessage);
      return;
    }
    if (checkoutState.mode === "session" && hasPendingOperationalForSession(checkoutState.sessionId)) {
      window.alert("This session still has pending sync changes. Please wait for sync to finish before issuing the bill.");
      scheduleOperationalSync(0);
      return;
    }
    if (checkoutState.mode === "customer_tab" && hasPendingOperationalForCustomerTab(checkoutState.customerTabId)) {
      window.alert("This customer tab still has pending sync changes. Please wait for sync to finish before issuing the bill.");
      scheduleOperationalSync(0);
      return;
    }
    const checkoutStartedAt = Date.now();
    const checkoutTelemetryMode = checkoutState.mode;
    const checkoutTelemetryEntityId =
      checkoutState.sessionId ?? checkoutState.customerTabId ?? checkoutState.replacementBillId;
    const canSkipFullSnapshotPrecheck =
      backendConfigured &&
      Boolean(defaultRemoteDataGateway.commitFinancialCheckout) &&
      (checkoutState.mode === "session" ||
        checkoutState.mode === "customer_tab" ||
        checkoutState.mode === "bill_replacement");
    let baseAppData = appData;
    let baseVersion = remoteVersionRef.current;
    if (backendConfigured && !canSkipFullSnapshotPrecheck) {
      const precheckStartedAt = Date.now();
      let snapshot;
      try {
        snapshot = await defaultRemoteDataGateway.loadAppDataSnapshot();
        recordCheckoutTelemetrySample({
          stage: "precheck_snapshot",
          mode: checkoutTelemetryMode,
          entityId: checkoutTelemetryEntityId,
          durationMs: Date.now() - precheckStartedAt,
          status: "success",
          appStateVersion: snapshot.version
        });
      } catch (error) {
        recordCheckoutTelemetrySample({
          stage: "precheck_snapshot",
          mode: checkoutTelemetryMode,
          entityId: checkoutTelemetryEntityId,
          durationMs: Date.now() - precheckStartedAt,
          status: "error",
          errorMessage: error instanceof Error ? error.message : "Could not load latest checkout data."
        });
        throw error;
      }
      baseAppData = snapshot.appData;
      baseVersion = snapshot.version;
      setRemoteVersion(baseVersion);
      if (checkoutState.mode === "session" && checkoutState.sessionId) {
        const remoteSession = baseAppData.sessions.find((entry) => entry.id === checkoutState.sessionId);
        if (!remoteSession) {
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(baseAppData));
          setCheckoutState(null);
          setManageSessionId(null);
          window.alert("This session no longer exists. Latest data has been loaded.");
          return;
        }
        // Allow billing a hopped session (status "closed" but not yet billed)
        const isHoppedSession = remoteSession.closeDisposition === "hopped" && !remoteSession.closedBillId;
        if (!isHoppedSession && remoteSession.status === "closed") {
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(baseAppData));
          setCheckoutState(null);
          setManageSessionId(null);
          window.alert("This session was already closed from another browser. Latest data has been loaded.");
          return;
        }
        if (isHoppedSession && remoteSession.closedBillId) {
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(baseAppData));
          setCheckoutState(null);
          window.alert("This session was already billed from another browser. Latest data has been loaded.");
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
      for (const hId of (checkoutState.hoppedSessionIds ?? [])) {
        const remoteHopped = baseAppData.sessions.find((s) => s.id === hId);
        if (!remoteHopped || remoteHopped.closeDisposition !== "hopped" || remoteHopped.closedBillId) {
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(baseAppData));
          setCheckoutState((prev) => prev ? { ...prev, hoppedSessionIds: (prev.hoppedSessionIds ?? []).filter((id) => id !== hId) } : prev);
          window.alert(`A previous session${remoteHopped ? ` (${remoteHopped.stationNameSnapshot})` : ""} was already billed or is no longer available. It has been removed from this bill. Please review the updated selection and try again.`);
          return;
        }
      }
      skipRemotePersistRef.current = true;
      setAppData(normalizeAppDataCustomers(baseAppData));
    } else if (backendConfigured && canSkipFullSnapshotPrecheck) {
      recordCheckoutTelemetrySample({
        stage: "precheck_snapshot",
        mode: checkoutTelemetryMode,
        entityId: checkoutTelemetryEntityId,
        durationMs: 0,
        status: "success",
        appStateVersion: baseVersion,
        skippedFullSnapshot: true
      });
    }
    if (checkoutState.mode === "bill_replacement" && checkoutState.replacementBillId) {
      const normalizedReplacementBill = normalizedBillRegisterState.bills.find(
        (entry) => entry.id === checkoutState.replacementBillId
      );
      if (normalizedReplacementBill && !baseAppData.bills.some((entry) => entry.id === normalizedReplacementBill.id)) {
        baseAppData = {
          ...baseAppData,
          bills: mergeBillsById([normalizedReplacementBill], baseAppData.bills)
        };
      }
    }
    function getAvailableStockFromData(
      data: AppData,
      item: InventoryItem,
      ignoreSessionId?: string,
      ignoreCustomerTabId?: string
    ) {
      const sessionReserved = sumBy(
        data.sessions.filter((entry) => entry.status !== "closed" && entry.id !== ignoreSessionId),
        (entry) => sumBy(entry.items.filter((line) => line.inventoryItemId === item.id), (line) => getLineStockQuantity(line))
      );
      const tabReserved = sumBy(
        data.customerTabs.filter((entry) => entry.status === "open" && entry.id !== ignoreCustomerTabId),
        (entry) => sumBy(entry.items.filter((line) => line.inventoryItemId === item.id), (line) => getLineStockQuantity(line))
      );
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
    if (checkoutState.mode === "bill_replacement" && !replacementBill) {
      window.alert("The original bill is not loaded for replacement. Refresh the Bill Register and try again.");
      return;
    }
    const hoppedSourceLines = (checkoutState.hoppedSessionIds ?? []).flatMap((hId) => {
      const hSession = baseAppData.sessions.find((s) => s.id === hId);
      if (!hSession || !hSession.endedAt) return [];
      return getSessionCheckoutLines(hSession, calculateSessionCharge(hSession, baseAppData.sessionPauseLogs, hSession.endedAt));
    });
    const sourceLines =
      checkoutState.mode === "session" && previewSession
        ? [...hoppedSourceLines, ...getSessionCheckoutLines(previewSession, calculateSessionCharge(previewSession, baseAppData.sessionPauseLogs, effectiveClosedAt))]
        : checkoutState.mode === "customer_tab"
          ? [...hoppedSourceLines, ...getCustomerTabCheckoutLines(customerTab?.items ?? [], customerTab?.comboApplications ?? [])]
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
      const customerTabLines = getCustomerTabCheckoutLines(customerTab.items, customerTab.comboApplications ?? []);
      const unavailableLine = customerTabLines.find((line) => {
        if (!line.inventoryItemId) {
          return false;
        }
        const inventoryItem = baseAppData.inventoryItems.find((item) => item.id === line.inventoryItemId);
        return !inventoryItem || getAvailableStockFromData(baseAppData, inventoryItem, undefined, customerTab.id) < getLineStockQuantity(line);
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
      const currentSessionLineId = `line-session-${checkoutState.sessionId}`;
      const sessionLine = sourceLines.find((line) => line.id === currentSessionLineId);
      if (sessionLine) {
        effectiveLineDiscounts[sessionLine.id] = {
          type: "amount",
          value: sessionLine.unitPrice,
          reason: "LTP win - game charge waived"
        };
      }
    }
    // Audit query for zero-price bills: SELECT data->'bills' FROM app_data WHERE (data->'bills') @> '[{"total":0}]'::jsonb;
    const preview = buildBillPreview(
      sourceLines,
      effectiveLineDiscounts,
      checkoutState.billDiscount,
      checkoutState.roundOffEnabled
    );
    if (preview.isZeroTotal) {
      window.alert("Bill total is Rs 0 - add items or remove any full discounts before issuing.");
      return;
    }
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
    const pendingSettlementDraft = checkoutState.pendingSettlement;
    const pendingSettlementAmount = pendingSettlementDraft ? getSettlementAmount(pendingSettlementDraft) : 0;
    const pendingSettlementResult =
      pendingSettlementDraft && pendingSettlementAmount > 0
        ? computeReceivableSettlement(
            pendingSettlementDraft.billIds
              .map((billId) => baseAppData.bills.find((bill) => bill.id === billId))
              .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending" && bill.amountDue > 0)),
            pendingSettlementDraft,
            billBusinessDates
          )
        : null;
    if (pendingSettlementResult?.error) {
      window.alert(pendingSettlementResult.error);
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
        previewSession?.startedAt ?? customerTab?.createdAt ?? issuedAt,
        previewSession?.customerId ?? customerTab?.customerId
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
      if (pendingSettlementResult && pendingSettlementResult.allocations.length > 0) {
        const settlementGroupId = createId("settlement-group");
        for (const allocation of pendingSettlementResult.allocations) {
          const target = draft.bills.find((entry) => entry.id === allocation.billId);
          if (!target || target.status !== "pending") continue;
          target.amountPaid = allocation.newAmountPaid;
          target.amountDue = allocation.newAmountDue;
          target.status = allocation.newStatus;
          if (allocation.newStatus === "issued") {
            target.settledAt = issuedAt;
            target.settledByUserId = activeUser.id;
          }
          for (const record of allocation.paymentRecords) {
            draft.payments.unshift({
              id: createId("payment"),
              billId: allocation.billId,
              mode: record.mode,
              amount: record.amount,
              createdAt: issuedAt,
              receivedByUserId: activeUser.id,
              settlementGroupId,
              relatedCheckoutBillId: billId
            });
          }
          addAuditLog(
            draft,
            activeUser.id,
            "bill_settled",
            "bill",
            allocation.billId,
            `Settled Rs ${allocation.amount.toFixed(2)} on ${target.billNumber} during checkout ${billNumber}. Remaining due: Rs ${allocation.newAmountDue.toFixed(2)}.`
          );
        }
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
          const stockDelta = getLineStockQuantity(line);
          item.stockQty -= stockDelta;
          draft.stockMovements.unshift({
            id: createId("stock"),
            itemId: item.id,
            type: "sale",
            quantity: -stockDelta,
            reason: `Sold ${line.description} in ${billNumber}${line.soldAsPackOf ? ` (${line.quantity} pack${line.quantity !== 1 ? "s" : ""} of ${line.soldAsPackOf})` : line.saleVariantId ? ` (${stockDelta} ${item.name} unit${stockDelta !== 1 ? "s" : ""})` : ""}`,
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
      for (const hoppedSessionId of (checkoutState.hoppedSessionIds ?? [])) {
        const hoppedSession = draft.sessions.find((s) => s.id === hoppedSessionId);
        if (hoppedSession && hoppedSession.closeDisposition === "hopped" && !hoppedSession.closedBillId) {
          hoppedSession.closedBillId = billId;
          hoppedSession.closeDisposition = "billed";
          addAuditLog(draft, activeUser.id, "session_hop_billed", "session", hoppedSessionId, `Included in combined bill ${billNumber} (${hoppedSession.stationNameSnapshot}).`);
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
        addAuditLog(draft, activeUser.id, "bill_pending", "bill", billId, `${billNumber} issued as pending (due Rs ${billAmountDue.toFixed(2)}).`);
      }
    let confirmedReceiptBill: Bill = issuedBill;
    let confirmedReceiptBills = nextAppData.bills;
    let confirmedReceiptPayments = nextAppData.payments;
    if (backendConfigured) {
      const financialRpcMode =
        defaultRemoteDataGateway.commitFinancialCheckout &&
        (checkoutState.mode === "session" ||
          checkoutState.mode === "customer_tab" ||
          (checkoutState.mode === "bill_replacement" && replacementBill))
          ? checkoutState.mode
          : null;
      const financialRpcEntityId =
        financialRpcMode === "session"
          ? checkoutState.sessionId
          : financialRpcMode === "customer_tab"
            ? checkoutState.customerTabId
            : financialRpcMode === "bill_replacement"
              ? checkoutState.replacementBillId
              : "";
      if (financialRpcMode && financialRpcEntityId) {
        const financialPatch = buildFinancialCheckoutPatch({
          baseAppData,
          nextAppData,
          mode: financialRpcMode,
          entityId: financialRpcEntityId,
          bill: issuedBill,
          baseVersion,
          createdAt: issuedAt,
          userId: activeUser?.id ?? activeUserId ?? "",
          mutationId: checkoutState.mutationId ?? createId("financial")
        });
        const financialRpcStartedAt = Date.now();
        try {
          const financialResult = await commitFinancialCheckoutPatch(financialPatch);
          if (BACKEND_FEATURE_FLAGS.financialRpcV2 && !financialResult?.canonicalBill) {
            throw new Error("The server confirmed checkout without returning the canonical bill. Receipt generation was stopped.");
          }
          if (BACKEND_FEATURE_FLAGS.financialRpcV2 && financialResult?.canonicalBill) {
            confirmedReceiptBill = financialResult.canonicalBill;
            confirmedReceiptBills = mergeBillsById(
              [financialResult.canonicalBill],
              nextAppData.bills.filter((bill) => bill.id !== issuedBill.id)
            );
            confirmedReceiptPayments = mergePaymentsById(
              financialResult.canonicalPayments ?? [],
              nextAppData.payments.filter((payment) => payment.billId !== issuedBill.id)
            );
          }
          recordCheckoutTelemetrySample({
            stage: "financial_rpc",
            mode: financialRpcMode,
            entityId: financialRpcEntityId,
            billNumber,
            durationMs: Date.now() - financialRpcStartedAt,
            status: "success",
            payloadBytes: estimateCheckoutPayloadBytes(financialPatch),
            appStateVersion: financialResult?.appStateVersion,
            serverDurationMs: financialResult?.serverDurationMs
          });
        } catch (error) {
          recordCheckoutTelemetrySample({
            stage: "financial_rpc",
            mode: financialRpcMode,
            entityId: financialRpcEntityId,
            billNumber,
            durationMs: Date.now() - financialRpcStartedAt,
            status: "error",
            payloadBytes: estimateCheckoutPayloadBytes(financialPatch),
            errorMessage: error instanceof Error ? error.message : "Could not issue the bill."
          });
          throw error;
        }
      } else {
        await saveRemoteSnapshot(nextAppData, baseVersion, false, "Issuing bill");
      }
      skipRemotePersistRef.current = true;
      if (!BACKEND_FEATURE_FLAGS.financialRpcV2) {
        setAppData(normalizeAppDataCustomers(nextAppData));
      }
    } else {
      setAppData(normalizeAppDataCustomers(nextAppData));
    }

    setSelectedReceiptBillId(confirmedReceiptBill.id);
    setCheckoutState(null);
    setManageSessionId(null);
    setSelectedCustomerTabId(null);
    setCustomerTabDraft({ customerId: undefined, customerName: "", customerPhone: "" });
    setReplacementItemForm({ sellableOptionId: "", quantity: 1 });
    setLastHoppedSessionId(null);
    openReceiptWindow(nextAppData.businessProfile, confirmedReceiptBill, confirmedReceiptBills, confirmedReceiptPayments);
    downloadReceiptPdf(nextAppData.businessProfile, confirmedReceiptBill, confirmedReceiptBills, confirmedReceiptPayments);
    recordCheckoutTelemetrySample({
      stage: "checkout_total",
      mode: checkoutTelemetryMode,
      entityId: checkoutTelemetryEntityId,
      billNumber,
      durationMs: Date.now() - checkoutStartedAt,
      status: "success",
      skippedFullSnapshot: canSkipFullSnapshotPrecheck
    });
  }

  async function settlePayment(draft: SettlementDraft): Promise<boolean> {
    if (!activeUser || !canSettlePendingBills) {
      return false;
    }
    const billIds = draft.billIds?.length ? draft.billIds : draft.billId ? [draft.billId] : [];
    const selectedBills = billIds
      .map((billId) => appData.bills.find((b) => b.id === billId))
      .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending" && bill.amountDue > 0));
    if (selectedBills.length === 0) {
      window.alert("No selected bills are pending.");
      return false;
    }
    const result = computeReceivableSettlement(selectedBills, draft, billBusinessDates);
    if (result.error) {
      window.alert(result.error);
      return false;
    }
    const settledAt = new Date().toISOString();
    const settlementEntityType = selectedBills.length > 1 ? "bill_group" : "bill";
    const settlementEntityId = selectedBills.map((bill) => bill.id).join(",");
    return commitFinancialAdjustmentChange("Settling pending bill...", "settlePendingBills", settlementEntityType, settlementEntityId, (data) => {
      const settlementGroupId = result.allocations.length > 1 ? createId("settlement-group") : undefined;
      for (const allocation of result.allocations) {
        const target = data.bills.find((b) => b.id === allocation.billId);
        if (!target || target.status !== "pending") continue;
        target.amountPaid = allocation.newAmountPaid;
        target.amountDue = allocation.newAmountDue;
        target.status = allocation.newStatus;
        if (allocation.newStatus === "issued") {
          target.settledAt = settledAt;
          target.settledByUserId = activeUser.id;
        }
        for (const record of allocation.paymentRecords) {
          data.payments.unshift({
            id: createId("payment"),
            billId: allocation.billId,
            mode: record.mode,
            amount: record.amount,
            createdAt: settledAt,
            receivedByUserId: activeUser.id,
            settlementGroupId
          });
        }
        addAuditLog(
          data,
          activeUser.id,
          "bill_settled",
          "bill",
          allocation.billId,
          `Settled Rs ${allocation.amount.toFixed(2)} on ${target.billNumber}. Remaining due: Rs ${allocation.newAmountDue.toFixed(2)}.`
        );
      }
    });
  }

  async function voidPendingBills(draft: VoidPendingGroupDraft): Promise<boolean> {
    if (!activeUser || activeUser.role !== "admin") {
      return false;
    }
    if (!draft.reason.trim()) {
      window.alert("Void reason is required.");
      return false;
    }
    const billIds = Array.from(new Set(draft.billIds));
    const pendingBillsToVoid = billIds
      .map((billId) => appData.bills.find((b) => b.id === billId))
      .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending"));
    if (pendingBillsToVoid.length === 0) {
      window.alert("No selected bills are pending.");
      return false;
    }
    const voidedAt = new Date().toISOString();
    const voidEntityType = pendingBillsToVoid.length > 1 ? "bill_group" : "bill";
    const voidEntityId = pendingBillsToVoid.map((bill) => bill.id).join(",");
    return commitFinancialAdjustmentChange("Writing off pending bills...", "writeOffPendingBills", voidEntityType, voidEntityId, (data) => {
      for (const bill of pendingBillsToVoid) {
        const target = data.bills.find((b) => b.id === bill.id);
        if (!target || target.status !== "pending") continue;
        target.status = "voided";
        target.voidedAt = voidedAt;
        target.voidedByUserId = activeUser.id;
        target.voidReason = draft.reason.trim();
        addAuditLog(
          data,
          activeUser.id,
          "bill_voided_bad_debt",
          "bill",
          target.id,
          `Voided pending bill ${target.billNumber} as bad debt. Reason: ${draft.reason.trim()}.`
        );
      }
    });
  }

  async function voidPendingBill(draft: VoidPendingDraft): Promise<boolean> {
    return voidPendingBills({
      billIds: [draft.billId],
      reason: draft.reason,
      customerLabel: "Selected bill"
    });
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
    const saleVariants = sanitizeSaleVariants(itemForm, resolvedCategory);
    const sellBaseItem = itemForm.isReusable || resolvedCategory === "Cigarettes" ? true : itemForm.sellBaseItem ?? true;
    void commitAppDataChange(itemForm.id ? "Updating inventory item..." : "Saving inventory item...", (draft) => {
      if (itemForm.id) {
        const existing = draft.inventoryItems.find((item) => item.id === itemForm.id);
        if (!existing) {
          return false;
        }
        Object.assign(existing, {
          ...itemForm,
          name: itemForm.name.trim(),
          category: resolvedCategory,
          unit: "piece",
          barcode: itemForm.barcode?.trim() || undefined,
          cigarettePack: resolvedCategory === "Cigarettes" ? itemForm.cigarettePack : undefined,
          sellBaseItem,
          saleVariants
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
          cigarettePack: resolvedCategory === "Cigarettes" ? itemForm.cigarettePack : undefined,
          sellBaseItem,
          saleVariants
        });
        addAuditLog(draft, activeUser.id, "inventory_created", "inventory_item", newId, `Created ${itemForm.name.trim()}.`);
      }
      if (!draft.inventoryCategories.includes(resolvedCategory)) {
        draft.inventoryCategories.push(resolvedCategory);
      }
    }, () => resetItemForm());
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
    const saleVariants = sanitizeSaleVariants(editItemForm, resolvedCategory);
    const sellBaseItem = editItemForm.isReusable || resolvedCategory === "Cigarettes" ? true : editItemForm.sellBaseItem ?? true;
    void commitAppDataChange("Updating inventory item...", (draft) => {
      const existing = draft.inventoryItems.find((item) => item.id === editItemForm.id);
      if (!existing) {
        return false;
      }
      Object.assign(existing, {
        ...editItemForm,
        name: editItemForm.name.trim(),
        category: resolvedCategory,
        unit: "piece",
        barcode: editItemForm.barcode?.trim() || undefined,
        cigarettePack: resolvedCategory === "Cigarettes" ? editItemForm.cigarettePack : undefined,
        sellBaseItem,
        saleVariants
      });
      if (!draft.inventoryCategories.includes(resolvedCategory)) {
        draft.inventoryCategories.push(resolvedCategory);
      }
      addAuditLog(draft, activeUser.id, "inventory_updated", "inventory_item", existing.id, `Updated ${existing.name}.`);
    }, () => closeEditInventoryModal());
  }

  function recordStockMovement(type: StockMovementType, quantityOverride?: number) {
    const effectiveQty = quantityOverride ?? inventoryAction.quantity;
    if (!activeUser || !canEditInventory || !inventoryAction.itemId || effectiveQty <= 0 || !inventoryAction.reason.trim()) {
      return;
    }
    void commitAppDataChange("Recording stock movement...", (draft) => {
      const item = draft.inventoryItems.find((entry) => entry.id === inventoryAction.itemId);
      if (!item) {
        return false;
      }
      if (!item.active) {
        window.alert("Restore archived inventory items before recording stock movements.");
        return false;
      }
      const signedQuantity = type === "restock" ? effectiveQty : -effectiveQty;
      if (item.stockQty + signedQuantity < 0) {
        return false;
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
    }, () => setInventoryAction({ itemId: "", quantity: 1, reason: "" }));
  }

  function saveComboDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditInventory) {
      return;
    }
    const name = comboDraft.name.trim();
    const comboType = comboDraft.type ?? "game";
    const fixedItems = comboDraft.fixedItems
      .filter((item) => item.sellableOptionId && item.quantity > 0)
      .map((item) => ({ ...item, quantity: Math.max(1, Math.trunc(item.quantity)) }));
    const choiceGroups = comboDraft.choiceGroups
      .filter((group) => group.label.trim() && group.optionIds.length > 0)
      .map((group) => ({
        ...group,
        label: group.label.trim(),
        requiredQuantity: Math.max(1, Math.trunc(group.requiredQuantity)),
        optionIds: Array.from(new Set(group.optionIds))
      }));
    if (!name || comboDraft.price < 0) {
      window.alert("Combo name and price are required.");
      return;
    }
    if (comboType === "game" && (comboDraft.stationIds.length === 0 || comboDraft.includedMinutes <= 0)) {
      window.alert("Game combos require at least one station and included minutes.");
      return;
    }
    if (comboType === "consumables" && fixedItems.length === 0 && choiceGroups.length === 0) {
      window.alert("Consumables combos require at least one fixed item or choice group.");
      return;
    }
    const sanitizedCombo: ComboPackage = {
      ...comboDraft,
      id: comboDraft.id || createId("combo"),
      name,
      type: comboType,
      price: Math.max(0, comboDraft.price),
      stationIds: comboType === "game" ? comboDraft.stationIds : [],
      includedMinutes: comboType === "game" ? Math.max(1, Math.trunc(comboDraft.includedMinutes)) : 0,
      fixedItems,
      choiceGroups,
      createdAt: comboDraft.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    void commitAppDataChange(comboDraft.id ? "Updating combo..." : "Creating combo...", (draft) => {
      const existing = draft.combos.find((entry) => entry.id === sanitizedCombo.id);
      if (existing) {
        Object.assign(existing, sanitizedCombo);
      } else {
        draft.combos.unshift(sanitizedCombo);
      }
      addAuditLog(draft, activeUser.id, comboDraft.id ? "combo_updated" : "combo_created", "combo", sanitizedCombo.id, `${comboDraft.id ? "Updated" : "Created"} combo ${sanitizedCombo.name}.`);
    }, () => setComboDraft(createComboDraft()));
  }

  function editCombo(combo: ComboPackage) {
    if (!canEditInventory) {
      return;
    }
    setComboDraft(cloneValue(combo));
    setActiveTab("inventory");
  }

  function toggleComboActive(comboId: string) {
    if (!activeUser || !canEditInventory) {
      return;
    }
    void commitAppDataChange("Updating combo status...", (draft) => {
      const combo = draft.combos.find((entry) => entry.id === comboId);
      if (!combo) return false;
      combo.active = !combo.active;
      combo.updatedAt = new Date().toISOString();
      addAuditLog(draft, activeUser.id, combo.active ? "combo_restored" : "combo_archived", "combo", combo.id, `${combo.active ? "Restored" : "Archived"} combo ${combo.name}.`);
    });
  }

  function upsertStation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings) {
      return;
    }
    void commitAppDataChange("Saving station...", (draft) => {
      draft.stations.unshift({
        ...stationForm,
        id: createId("station"),
        name: stationForm.name.trim()
      });
    }, () => setStationForm({ id: "", name: "", mode: "timed", active: true, ltpEnabled: false }));
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
    void commitAppDataChange("Updating station...", (draft) => {
      const existing = draft.stations.find((station) => station.id === editStationDraft.id);
      if (!existing) {
        return false;
      }
      Object.assign(existing, {
        ...editStationDraft,
        name: editStationDraft.name.trim()
      });
    }, () => setEditStationDraft(null));
  }

  function deleteStation(stationId: string) {
    if (!activeUser || !canEditSettings) {
      return;
    }
    if (appData.sessions.some((session) => session.stationId === stationId && session.status !== "closed")) {
      window.alert("Close the active session first.");
      return;
    }
    void commitAppDataChange("Deleting station...", (draft) => {
      draft.stations = draft.stations.filter((station) => station.id !== stationId);
      draft.pricingRules = draft.pricingRules.filter((rule) => rule.stationId !== stationId);
    });
  }

  function addPricingRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings || !pricingDraft.stationId) {
      return;
    }
    void commitAppDataChange("Saving pricing rule...", (draft) => {
      draft.pricingRules.push({
        id: createId("pricing"),
        stationId: pricingDraft.stationId,
        label: pricingDraft.label.trim(),
        startMinute: toMinuteOfDay(pricingDraft.startTime),
        endMinute: toMinuteOfDay(pricingDraft.endTime),
        hourlyRate: clampNumber(pricingDraft.hourlyRate)
      });
    }, () => {
      setPricingDraft({
        stationId: pricingDraft.stationId,
        label: "",
        startTime: "10:00",
        endTime: "21:00",
        hourlyRate: 0
      });
    });
  }

  function deletePricingRule(ruleId: string) {
    if (!canEditSettings) {
      return;
    }
    void commitAppDataChange("Deleting pricing rule...", (draft) => {
      draft.pricingRules = draft.pricingRules.filter((rule) => rule.id !== ruleId);
    });
  }

  function saveBusinessProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canEditSettings) {
      return;
    }
    void commitAppDataChange("Saving business profile...", (draft) => {
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
      if (!guardRemoteWrite()) {
        window.alert(remoteReadOnlyMessage);
        return;
      }
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
      void commitAppDataChange("Creating user...", (draft) => {
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
      }, () => setUserForm({ name: "", username: "", password: "", role: "receptionist" }));
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
      if (!guardRemoteWrite()) {
        window.alert(remoteReadOnlyMessage);
        return;
      }
      void runBlockingAction("Updating user...", async () => {
        await adminUpdateUserRemote({
          id: editUserDraft.id,
          name: nextName,
          username: nextUsername,
          role: editUserDraft.role,
          tabPermissions: nextTabPermissions
        });
        const nextAppData = cloneValue(appDataRef.current);
        const user = nextAppData.users.find((entry) => entry.id === editUserDraft.id);
        if (!user) throw new Error("Updated user could not be reconciled locally.");
        user.name = nextName;
        user.username = nextUsername;
        user.role = editUserDraft.role;
        user.tabPermissions = nextTabPermissions;
        skipRemotePersistRef.current = true;
        appDataRef.current = nextAppData;
        setAppData(nextAppData);
        setEditUserDraft(null);
      }).catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : "Unable to update user.");
      });
      return;
    }
    void commitAppDataChange("Updating user...", (draft) => {
      const user = draft.users.find((entry) => entry.id === editUserDraft.id);
      if (!user) {
        return false;
      }
      user.name = nextName;
      user.username = nextUsername;
      user.role = editUserDraft.role;
      user.tabPermissions = nextTabPermissions;
      addAuditLog(draft, activeUser.id, "user_updated", "user", user.id, `Updated user ${user.username}.`);
    }, () => setEditUserDraft(null));
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
      if (!guardRemoteWrite()) {
        setPasswordError(remoteReadOnlyMessage);
        return;
      }
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
      void commitAppDataChange("Updating password...", (draft) => {
        const user = draft.users.find((entry) => entry.id === passwordDraft.userId);
        if (!user) return false;
        user.password = hashedPassword;
        addAuditLog(draft, activeUser.id, "user_password_changed", "user", user.id, `Changed password for ${user.username}.`);
      }, () => setPasswordDraft(null));
    })();
  }

  function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const expenseCashAmount =
      expenseForm.paymentMode === "cash" ? expenseForm.amount : expenseForm.paymentMode === "split" ? expenseForm.cashAmount : 0;
    const expenseUpiAmount =
      expenseForm.paymentMode === "upi" ? expenseForm.amount : expenseForm.paymentMode === "split" ? expenseForm.upiAmount : 0;
    const expenseAmount = expenseCashAmount + expenseUpiAmount;
    if (
      !activeUser ||
      !canCreateExpenses ||
      expenseAmount <= 0 ||
      (expenseForm.paymentMode === "split" && (expenseCashAmount <= 0 || expenseUpiAmount <= 0)) ||
      !expenseForm.title.trim()
    ) {
      return;
    }
    void commitAppDataChange("Saving expense...", (draft) => {
      const expenseId = createId("expense");
      draft.expenses.unshift({
        id: expenseId,
        title: expenseForm.title.trim(),
        category: expenseForm.category.trim(),
        amount: expenseAmount,
        paymentMode: expenseForm.paymentMode,
        cashAmount: expenseCashAmount,
        upiAmount: expenseUpiAmount,
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
        expenseForm.paymentMode === "split"
          ? `Logged SPLIT expense ${expenseForm.title.trim()} for ${currency(expenseAmount)} (Cash ${currency(expenseCashAmount)}, UPI ${currency(expenseUpiAmount)}).`
          : `Logged ${expenseForm.paymentMode.toUpperCase()} expense ${expenseForm.title.trim()} for ${currency(expenseAmount)}.`
      );
    }, () => {
      setExpenseForm({
        title: "",
        category: "Utilities",
        amount: 0,
        paymentMode: "cash",
        cashAmount: 0,
        upiAmount: 0,
        spentAt: toBusinessDayKey(now),
        notes: ""
      });
    });
  }

  function saveExpenseTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeUser || !canManageExpenseTemplates || expenseTemplateForm.amount <= 0 || !expenseTemplateForm.title.trim()) {
      return;
    }
    let newTemplateId: string | null = null;
    void commitAppDataChange(expenseTemplateForm.id ? "Updating expense template..." : "Saving expense template...", (draft) => {
      if (expenseTemplateForm.id) {
        const existing = draft.expenseTemplates.find((entry) => entry.id === expenseTemplateForm.id);
        if (!existing) {
          return false;
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
        newTemplateId = templateId;
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
    }, () => {
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
      if (newTemplateId) {
        const currentMonth = todayDateKey.slice(5, 7);
        if (currentMonth !== "01") {
          setPendingBackfillTemplate(newTemplateId);
        }
      }
    });
  }

  function resolveBackfillPrompt(templateId: string, backfill: boolean) {
    if (!activeUser || !canManageExpenseTemplates) return;
    if (backfill) {
      const year = todayDateKey.slice(0, 4);
      void commitAppDataChange("Updating expense template...", (draft) => {
        const template = draft.expenseTemplates.find((t) => t.id === templateId);
        if (template) {
          template.startMonth = `${year}-01`;
        }
      }, () => setPendingBackfillTemplate(null));
      return;
    }
    setPendingBackfillTemplate(null);
  }

  function deleteExpense(expenseId: string) {
    if (!activeUser || !canDeleteExpenses) {
      return;
    }
    void commitAppDataChange("Deleting expense...", (draft) => {
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
    if (!canManageExpenseTemplates) {
      return;
    }
    setExpenseTemplateForm({
      ...template,
      notes: template.notes ?? ""
    });
  }

  function toggleExpenseTemplateActive(templateId: string) {
    if (!activeUser || !canManageExpenseTemplates) {
      return;
    }
    void commitAppDataChange("Updating expense template...", (draft) => {
      const template = draft.expenseTemplates.find((entry) => entry.id === templateId);
      if (!template) {
        return false;
      }
      template.active = !template.active;
      addAuditLog(draft, activeUser.id, template.active ? "expense_template_activated" : "expense_template_deactivated", "expense_template", templateId, `${template.active ? "Activated" : "Deactivated"} monthly template ${template.title}.`);
    });
  }

  function deleteExpenseTemplate(templateId: string) {
    if (!activeUser || !canManageExpenseTemplates) {
      return;
    }
    void commitAppDataChange("Deleting expense template...", (draft) => {
      const template = draft.expenseTemplates.find((entry) => entry.id === templateId);
      draft.expenseTemplates = draft.expenseTemplates.filter((entry) => entry.id !== templateId);
      draft.expenseTemplateOverrides = draft.expenseTemplateOverrides.filter((o) => o.templateId !== templateId);
      if (template) {
        addAuditLog(draft, activeUser.id, "expense_template_deleted", "expense_template", templateId, `Deleted monthly template ${template.title}.`);
      }
    }, () => {
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
    });
  }

  function createOrUpdateOverride(
    templateId: string,
    monthKey: string,
    amount: number | null,
    skipReason?: string,
    notes?: string
  ) {
    if (!activeUser || !canManageExpenseTemplates) return;
    void commitAppDataChange("Saving expense override...", (draft) => {
      const existing = draft.expenseTemplateOverrides.find(
        (o) => o.templateId === templateId && o.monthKey === monthKey
      );
      const now = new Date().toISOString();
      if (existing) {
        existing.amount = amount;
        existing.skipReason = skipReason;
        existing.notes = notes;
        existing.updatedAt = now;
      } else {
        draft.expenseTemplateOverrides.push({
          id: createId("expense-override"),
          templateId,
          monthKey,
          amount,
          skipReason,
          notes,
          createdByUserId: activeUser.id,
          updatedAt: now
        });
      }
      const label = amount === null ? "Skipped" : `Set to ${currency(amount)}`;
      addAuditLog(draft, activeUser.id, "expense_override_set", "expense_template", templateId, `${label} for ${monthKey}.`);
    });
  }

  function createOrUpdateOverrideForFutureMonths(
    templateId: string,
    fromMonthKey: string,
    amount: number | null,
    skipReason?: string,
    notes?: string
  ) {
    if (!activeUser || !canManageExpenseTemplates) return;
    const [year] = fromMonthKey.split("-").map(Number);
    const endMonthKey = `${year}-12`;
    void commitAppDataChange("Saving future expense overrides...", (draft) => {
      const now = new Date().toISOString();
      let cursor = fromMonthKey;
      while (cursor <= endMonthKey) {
        const existing = draft.expenseTemplateOverrides.find(
          (o) => o.templateId === templateId && o.monthKey === cursor
        );
        if (existing) {
          existing.amount = amount;
          existing.skipReason = skipReason;
          existing.notes = notes;
          existing.updatedAt = now;
        } else {
          draft.expenseTemplateOverrides.push({
            id: createId("expense-override"),
            templateId,
            monthKey: cursor,
            amount,
            skipReason,
            notes,
            createdByUserId: activeUser.id,
            updatedAt: now
          });
        }
        const [y, m] = cursor.split("-").map(Number);
        const next = new Date(y, m, 1);
        cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
      }
      const label = amount === null ? "Skipped" : `Set to ${currency(amount)}`;
      addAuditLog(draft, activeUser.id, "expense_override_set", "expense_template", templateId, `${label} for ${fromMonthKey} through ${endMonthKey}.`);
    });
  }

  function deleteOverride(templateId: string, monthKey: string) {
    if (!activeUser || !canManageExpenseTemplates) return;
    void commitAppDataChange("Restoring expense default...", (draft) => {
      draft.expenseTemplateOverrides = draft.expenseTemplateOverrides.filter(
        (o) => !(o.templateId === templateId && o.monthKey === monthKey)
      );
      addAuditLog(draft, activeUser.id, "expense_override_removed", "expense_template", templateId, `Restored default amount for ${monthKey}.`);
    });
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
      if (!guardRemoteWrite()) {
        window.alert(remoteReadOnlyMessage);
        return;
      }
      void runBlockingAction(targetUser.active ? "Disabling user..." : "Enabling user...", async () => {
        await adminToggleUserActiveRemote(userId);
        await refreshRemoteState({ keepUser: true });
      }).catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : "Unable to update user access.");
      });
      return;
    }
    void commitAppDataChange(targetUser.active ? "Disabling user..." : "Enabling user...", (draft) => {
      const user = draft.users.find((entry) => entry.id === userId);
      if (!user) {
        return false;
      }
      user.active = !user.active;
      addAuditLog(
        draft,
        activeUser.id,
        user.active ? "user_enabled" : "user_disabled",
        "user",
        user.id,
        `${user.active ? "Enabled" : "Disabled"} user ${user.username}.`
      );
    });
  }

  function voidOrRefundBill(billId: string) {
    if (!activeUser || !canVoidRefundBills) {
      return;
    }
    const bill = appData.bills.find((entry) => entry.id === billId);
    if (!bill || bill.status !== "issued") {
      return;
    }
    setVoidRefundDraft({ billId, reason: "", action: "void" });
  }

  function submitVoidOrRefundBill(): Promise<boolean> {
    if (!activeUser || !canVoidRefundBills || !voidRefundDraft?.reason.trim()) {
      return Promise.resolve(false);
    }
    const refund = voidRefundDraft.action === "refund";
    const voidedAt = new Date().toISOString();
    const cleanReason = voidRefundDraft.reason.trim();
    const billId = voidRefundDraft.billId;
    return commitFinancialAdjustmentChange(refund ? "Refunding bill..." : "Voiding bill...", refund ? "refundBill" : "voidBill", "bill", billId, (draft) => {
      const bill = draft.bills.find((entry) => entry.id === billId);
      if (!bill || bill.status !== "issued") {
        return false;
      }
      bill.status = refund ? "refunded" : "voided";
      bill.voidReason = cleanReason;
      bill.voidedAt = voidedAt;
      bill.voidedByUserId = activeUser.id;
      for (const line of bill.lines) {
        if (!line.inventoryItemId) {
          continue;
        }
        const item = draft.inventoryItems.find((entry) => entry.id === line.inventoryItemId);
        if (!item || item.isReusable) {
          continue;
        }
        const reverseDelta = getLineStockQuantity(line);
        item.stockQty += reverseDelta;
        draft.stockMovements.unshift({
          id: createId("stock"),
          itemId: item.id,
          type: "void_refund_reversal",
          quantity: reverseDelta,
          reason: cleanReason,
          createdAt: voidedAt,
          userId: activeUser.id,
          relatedBillId: bill.id
        });
      }
      addAuditLog(
        draft,
        activeUser.id,
        refund ? "bill_refunded" : "bill_voided",
        "bill",
        bill.id,
        `${refund ? "Refunded" : "Voided"} ${bill.billNumber}. Reason: ${cleanReason}.`
      );
    });
  }

  const normalizedBillRegisterDisplayEnabled =
    normalizedBillHistoryReadsEnabled &&
    activeTab === "bills" &&
    normalizedBillRegisterState.loaded &&
    !normalizedBillRegisterState.error &&
    normalizedBillRegisterState.queryKey === normalizedBillRegisterQueryKey;
  const billRegisterBills = normalizedBillHistoryReadsEnabled ? normalizedBillRegisterState.bills : appData.bills;
  const billRegisterPayments = normalizedBillHistoryReadsEnabled ? normalizedBillRegisterState.payments : appData.payments;
  const billRegisterBusinessDates = normalizedBillRegisterDisplayEnabled
    ? billRegisterBills.reduce<Record<string, string>>((dates, bill) => {
        dates[bill.id] = getBillBusinessDate(bill);
        return dates;
      }, {})
    : billBusinessDates;
  const billRegisterPaymentBusinessDates = normalizedBillRegisterDisplayEnabled
    ? billRegisterPayments.reduce<Record<string, string[]>>((datesByBill, payment) => {
        const dates = datesByBill[payment.billId] ?? [];
        dates.push(toBusinessDayKey(payment.createdAt));
        datesByBill[payment.billId] = dates;
        return datesByBill;
      }, {})
    : billPaymentBusinessDates;
  const billRegisterReceiptBills = normalizedBillHistoryReadsEnabled
    ? mergeBillsById(normalizedBillRegisterState.relatedBills, billRegisterBills)
    : appData.bills;
  const billRegisterReceiptPayments = normalizedBillHistoryReadsEnabled ? billRegisterPayments : appData.payments;
  const selectedReceiptBill = normalizedBillHistoryReadsEnabled
    ? billRegisterBills.find((bill) => bill.id === selectedReceiptBillId) ?? billRegisterBills[0] ?? null
    : appData.bills.find((bill) => bill.id === selectedReceiptBillId) ?? appData.bills[0] ?? null;
  const receiptPreviewModel = selectedReceiptBill
    ? buildReceiptPreviewModel(appData.businessProfile, selectedReceiptBill, billRegisterReceiptBills, billRegisterReceiptPayments)
    : null;
  const managedSession = manageSessionId ? getSessionById(manageSessionId) ?? null : null;
  const managedSessionCharge = managedSession ? getSessionChargeSummary(managedSession, getFrozenEndAtForSession(managedSession.id)) : null;
  const managedSessionPreviousHops = managedSession
    ? getUnbilledHoppedSessionsForSession(managedSession)
    : [];
  const managedSessionPreviousHopTotal = sumBy(managedSessionPreviousHops, (s) => getSessionLiveTotal(s, s.endedAt));
  const managedSessionPendingBills = managedSession
    ? getPendingBillsForCustomerDetails(managedSession.customerId, managedSession.customerName, managedSession.customerPhone)
    : [];
  const managedSessionPendingDue = sumBy(managedSessionPendingBills, (bill) => bill.amountDue);
  const managedSessionLiveTotal =
    managedSession && managedSessionCharge
      ? getSessionLiveTotal(managedSession, getFrozenEndAtForSession(managedSession.id)) + managedSessionPreviousHopTotal + managedSessionPendingDue
      : 0;
  const selectedCustomerTabPreviousHops = selectedCustomerTab
    ? getUnbilledHoppedSessionsForTab(selectedCustomerTab)
    : [];
  const selectedStartStation =
    startSessionDraft.stationId ? appData.stations.find((station) => station.id === startSessionDraft.stationId) ?? null : null;
  const selectedArcadeStartItem =
    startSessionDraft.arcadeItemId
      ? arcadeInventoryItems.find((item) => item.id === startSessionDraft.arcadeItemId) ?? null
      : defaultArcadeInventoryItem;
  const selectedStationCombos = selectedStartStation ? getAvailableCombosForStation(selectedStartStation.id) : [];
  const selectedStartCombo = startSessionDraft.comboId
    ? selectedStationCombos.find((combo) => combo.id === startSessionDraft.comboId) ?? null
    : null;
  const postHopSession = lastHoppedSessionId ? getSessionById(lastHoppedSessionId) ?? null : null;
  const postHopSessionCharge = postHopSession ? getSessionChargeSummary(postHopSession, postHopSession.endedAt) : null;
  const postHopTabLinkCandidates = postHopTabLinkDraft
    ? postHopTabLinkDraft.candidateTabIds
        .map((tabId) => getCustomerTabById(tabId))
        .filter((tab): tab is CustomerTab => Boolean(tab && tab.status === "open"))
    : [];
  const selectedPostHopTabLinkCandidate = postHopTabLinkCandidates.find((tab) => tab.id === postHopTabLinkDraft?.selectedTabId)
    ?? postHopTabLinkCandidates[0]
    ?? null;

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
          const currentLines = session
            ? getSessionCheckoutLines(
                previewSession ?? session,
                getSessionChargeSummary(previewSession ?? session, checkoutState.sessionEndedAt ?? checkoutState.closedAt ?? now)
              )
            : [];
          const hoppedLines = (checkoutState.hoppedSessionIds ?? []).flatMap((hId) => {
            const hSession = getSessionById(hId);
            if (!hSession || !hSession.endedAt) return [];
            return getSessionCheckoutLines(hSession, getSessionChargeSummary(hSession, hSession.endedAt));
          });
          return [...hoppedLines, ...currentLines];
        })()
      : checkoutState?.mode === "customer_tab" && checkoutState.customerTabId
        ? (() => {
            const tab = getCustomerTabById(checkoutState.customerTabId);
            const tabLines = getCustomerTabCheckoutLines(tab?.items ?? [], tab?.comboApplications ?? []);
            const hoppedLines = (checkoutState.hoppedSessionIds ?? []).flatMap((hId) => {
              const hSession = getSessionById(hId);
              if (!hSession || !hSession.endedAt) return [];
              return getSessionCheckoutLines(hSession, getSessionChargeSummary(hSession, hSession.endedAt));
            });
            return [...hoppedLines, ...tabLines];
          })()
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
  const checkoutDirectHoppedSessionIds = checkoutState?.mode === "session" && checkoutSession
    ? getUnbilledHoppedSessionsForSession(checkoutSession).map((session) => session.id)
    : checkoutState?.mode === "customer_tab" && checkoutState.customerTabId
      ? getDirectlyLinkedHoppedSessions(
          appData.sessions,
          getCustomerTabById(checkoutState.customerTabId)?.continuedFromSessionIds
        ).map((session) => session.id)
      : [];
  const checkoutSelectedHoppedSessionIds = checkoutState?.hoppedSessionIds ?? [];
  const checkoutCandidateExclusions = Array.from(new Set([
    ...checkoutDirectHoppedSessionIds,
    ...checkoutSelectedHoppedSessionIds,
    checkoutState?.sessionId ?? ""
  ].filter(Boolean)));
  const checkoutPossibleHoppedSessions = checkoutState && (checkoutState.mode === "session" || checkoutState.mode === "customer_tab")
    ? getPossibleUnbilledHoppedSessionsForCustomer(
        checkoutState.customerName,
        checkoutState.customerPhone,
        checkoutCandidateExclusions
      )
    : [];
  const checkoutHoppedSessionCandidates: Session[] = checkoutState && (checkoutState.mode === "session" || checkoutState.mode === "customer_tab")
    ? [
        ...checkoutSelectedHoppedSessionIds
          .map((sessionId) => getSessionById(sessionId))
          .filter((session): session is Session => Boolean(session)),
        ...checkoutPossibleHoppedSessions
      ]
    : [];
  const checkoutLineDiscounts: DraftLineDiscountMap = checkoutState ? { ...checkoutState.lineDiscounts } : {};
  if (
    checkoutState?.mode === "session" &&
    checkoutSession?.ltpEligible &&
    checkoutSession.playMode === "solo" &&
    checkoutState.ltpOutcome === "won"
  ) {
    const currentSessionLineId = `line-session-${checkoutState.sessionId}`;
    const sessionLine = checkoutLines.find((line) => line.id === currentSessionLineId);
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
  const checkoutPendingSettlementBills = checkoutState?.pendingSettlement
    ? checkoutState.pendingSettlement.billIds
        .map((billId) => appData.bills.find((bill) => bill.id === billId))
        .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending" && bill.amountDue > 0))
    : [];
  const checkoutAvailablePendingSettlementBills = checkoutState?.pendingSettlement
    ? (checkoutState.pendingSettlement.availableBillIds ?? checkoutState.pendingSettlement.billIds)
        .map((billId) => appData.bills.find((bill) => bill.id === billId))
        .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending" && bill.amountDue > 0))
    : [];
  const checkoutPendingSettlementDue = sumBy(checkoutPendingSettlementBills, (bill) => bill.amountDue);
  const checkoutPendingSettlementAmount = checkoutState?.pendingSettlement
    ? getSettlementAmount(checkoutState.pendingSettlement)
    : 0;
  const checkoutSummaryCurrency = (value: number) =>
    checkoutState?.roundOffEnabled
      ? new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        }).format(Math.round(value))
      : currency(value);

  const billById = new Map(reportSourceBills.map((bill) => [bill.id, bill]));
  const paidBillIds = new Set(filteredRevenuePayments.map((payment) => payment.billId));
  const paidBillsInRange = reportSourceBills.filter((bill) => paidBillIds.has(bill.id));
  const analyticsSummary = analyticsSummaryData?.summary;
  const clientGrossRevenue = sumBy(filteredRevenuePayments, (payment) => payment.amount);
  const grossRevenue = analyticsSummary?.grossRevenue ?? clientGrossRevenue;
  const clientDeferredOutstanding = sumBy(
    filteredBills.filter((b) => b.status === "pending" && b.amountDue > 0),
    (b) => b.amountDue
  );
  const deferredOutstanding = analyticsSummary?.deferredOutstanding ?? clientDeferredOutstanding;
  const paymentAllocations = filteredRevenuePayments.map((payment) => {
    const bill = billById.get(payment.billId);
    return bill ? allocatePaymentRevenueToBill(bill, payment.amount) : { sessionRevenue: 0, itemRevenue: 0, totalDiscounts: 0 };
  });
  const clientSessionRevenue = sumBy(paymentAllocations, (allocation) => allocation.sessionRevenue);
  const clientItemRevenue = sumBy(paymentAllocations, (allocation) => allocation.itemRevenue);
  const clientTotalDiscounts = sumBy(paymentAllocations, (allocation) => allocation.totalDiscounts);
  const sessionRevenue = analyticsSummary?.sessionRevenue ?? clientSessionRevenue;
  const itemRevenue = analyticsSummary?.itemRevenue ?? clientItemRevenue;
  const totalDiscounts = analyticsSummary?.totalDiscounts ?? clientTotalDiscounts;
  const clientOneTimeExpenses = sumBy(filteredExpenses, (expense) => expense.amount);
  const oneTimeExpenses = analyticsSummary?.oneTimeExpenses ?? clientOneTimeExpenses;
  const expensePaymentModeTotals =
    analyticsSummary?.expensePaymentModeTotals ?? computeExpensePaymentModeTotals(filteredExpenses);
  const reportMonthKeys = getMonthKeysInRange(reportFromDate, reportToDate);
  const normalizedExpenseEntries = appData.expenseTemplates
    .filter((template) => template.active)
    .flatMap((template) =>
      reportMonthKeys
        .flatMap((monthKey) => {
          const effectiveAmount = resolveEffectiveAmount(template, monthKey, appData.expenseTemplateOverrides);
          if (effectiveAmount === null) return [];
          const { factor, daysInRange, daysInMonth } = prorateFactor(monthKey, reportFromDate, reportToDate);
          return [{
            templateId: template.id,
            title: template.title,
            category: template.category,
            fullAmount: effectiveAmount,
            proratedAmount: effectiveAmount * factor,
            daysInRange,
            daysInMonth,
            monthKey,
            notes: template.notes
          }];
        })
    );
  const normalizedExpenses = sumBy(normalizedExpenseEntries, (entry) => entry.proratedAmount);
  const netCashEarnings = grossRevenue - oneTimeExpenses;
  const normalizedNetProfit = grossRevenue - normalizedExpenses;
  const clientPreviousRangeRevenue = sumBy(
    filterPaymentsByBusinessDate(reportRevenueCountedPayments, previousRange.from, previousRange.to),
    (payment) => payment.amount
  );
  const previousRangeRevenue = analyticsSummary?.previousRangeRevenue ?? clientPreviousRangeRevenue;
  const revenueGrowthPct =
    previousRangeRevenue > 0 ? ((grossRevenue - previousRangeRevenue) / previousRangeRevenue) * 100 : null;
  const paidBillsInRangeCount = analyticsSummary?.paidBillCount ?? paidBillsInRange.length;
  const averageBillValue = paidBillsInRangeCount > 0 ? grossRevenue / paidBillsInRangeCount : 0;
  const clientTopStation =
    Object.entries(
      filteredRevenuePayments.reduce<Record<string, number>>((totals, payment) => {
        const bill = billById.get(payment.billId);
        if (!bill) {
          return totals;
        }
        const stationName = bill.stationId
          ? appData.stations.find((station) => station.id === bill.stationId)?.name ?? "Unknown station"
          : "Customer tab";
        totals[stationName] = (totals[stationName] ?? 0) + payment.amount;
        return totals;
      }, {})
    ).sort((left, right) => right[1] - left[1])[0] ?? null;
  const topStation = analyticsSummaryData?.topStation ?? clientTopStation;
  const paymentModeTotals = analyticsSummary?.paymentModeTotals ?? computePaymentModeTotals(reportSourceBills, filteredRevenuePayments);
  const cashExpenseByCategory = Object.entries(
    filteredExpenses.reduce<Record<string, number>>((totals, expense) => {
      totals[expense.category] = (totals[expense.category] ?? 0) + expense.amount;
      return totals;
    }, {})
  ).sort((left, right) => right[1] - left[1]);
  const normalizedExpenseByCategory = Object.entries(
    normalizedExpenseEntries.reduce<Record<string, number>>((totals, expense) => {
      totals[expense.category] = (totals[expense.category] ?? 0) + expense.proratedAmount;
      return totals;
    }, {})
  ).sort((left, right) => right[1] - left[1]);
  const expenseByCategory = analyticsSummaryData?.expenseByCategory ?? cashExpenseByCategory;
  const outOfStockItems = appData.inventoryItems.filter((item) => item.active && getInventoryState(item) === "out");
  const lowStockItems = appData.inventoryItems.filter((item) => item.active && getInventoryState(item) === "low");
  const occupiedItems = appData.inventoryItems.filter((item) => item.active && getInventoryState(item) === "occupied");
  const pendingBills = appData.bills.filter((b) => b.status === "pending");
  const totalAmountDue = pendingBills.reduce((sum, b) => sum + b.amountDue, 0);
  const pendingReceivableGroups = getPendingReceivableGroups(pendingBills, billBusinessDates, currentBusinessDay);
  const clientPendingRevenue = sumBy(
    filteredBills.filter((b) => b.status === "pending"),
    (b) => b.amountDue
  );
  const pendingRevenue = analyticsSummary?.pendingRevenue ?? clientPendingRevenue;
  const todayMs = new Date(`${currentBusinessDay}T12:00:00`).getTime();
  const clientAllPendingReceivables = pendingBills
    .map((b) => {
      const businessDate = billBusinessDates[b.id];
      const daysOverdue = Math.floor((todayMs - new Date(`${businessDate}T12:00:00`).getTime()) / 86400000);
      return { bill: b, businessDate, daysOverdue };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const allPendingReceivables = analyticsSummaryData?.pendingReceivables ?? clientAllPendingReceivables;
  const pendingOperationalCount = pendingOperationalMutations.filter(
    (mutation) => mutation.status === "pending" || mutation.status === "syncing" || mutation.status === "failed"
  ).length;
  const failedOperationalCount = pendingOperationalMutations.filter((mutation) => mutation.status === "failed").length;
  const retryableFailedOperationalCount = pendingOperationalMutations.filter(
    (mutation) => mutation.status === "failed" && mutation.retryPolicy !== "manual"
  ).length;
  const conflictOperationalCount = pendingOperationalMutations.filter((mutation) => mutation.status === "conflict").length;
  const operationalStatusLabel =
    conflictOperationalCount > 0
      ? `${conflictOperationalCount} conflict${conflictOperationalCount !== 1 ? "s" : ""}`
      : pendingOperationalCount > 0
        ? `${pendingOperationalCount} pending`
        : lastOperationalSyncAt
          ? `Synced ${formatTime(lastOperationalSyncAt)}`
          : "Synced";
  const checkoutRetryableHopMutation =
    checkoutState?.mode === "session" && isHopMode
      ? pendingOperationalMutations.find(
          (mutation) =>
            mutation.kind === "hopSession" &&
            mutation.entityId === checkoutState.sessionId &&
            mutation.retryPolicy === "manual" &&
            mutation.status === "failed"
        )
      : undefined;
  const retryableContinuationMutation = lastHoppedSessionId
    ? pendingOperationalMutations.find((mutation) => {
        const payload = mutation.payload as { session?: Session };
        return (
          mutation.kind === "startSession" &&
          mutation.retryPolicy === "manual" &&
          mutation.status === "failed" &&
          payload.session?.continuedFromSessionIds?.includes(lastHoppedSessionId)
        );
      })
    : undefined;
  const consumedHoppedSessionIds = new Set([
    ...appData.sessions.flatMap((session) => session.continuedFromSessionIds ?? []),
    ...appData.customerTabs.flatMap((tab) => tab.continuedFromSessionIds ?? [])
  ]);
  const recoverableHoppedSessions = appData.sessions
    .filter(
      (session) =>
        session.status === "closed" &&
        session.closeDisposition === "hopped" &&
        !session.closedBillId &&
        !consumedHoppedSessionIds.has(session.id)
    )
    .sort(
      (left, right) =>
        new Date(right.endedAt ?? right.startedAt).getTime() -
        new Date(left.endedAt ?? left.startedAt).getTime()
    );
  const checkoutHasPendingOperational =
    checkoutState?.mode === "session"
      ? hasPendingOperationalForSession(checkoutState.sessionId) && !checkoutRetryableHopMutation
      : checkoutState?.mode === "customer_tab"
        ? hasPendingOperationalForCustomerTab(checkoutState.customerTabId)
        : false;
  const showRestoreRecovery =
    backendConfigured &&
    !activeUser &&
    (remoteRestoreState === "blocked" ||
      remoteRestoreState === "stale-cache" ||
      remoteRestoreState === "retrying");
  const restoreRecoveryTitle =
    remoteRestoreState === "retrying" ? "Restoring your session" : "Remote restore blocked";
  const restoreStatusLabel =
    remoteRestoreState === "retrying"
      ? "Reconnecting"
      : remoteReadOnly
        ? "Cached read-only"
        : remoteSaving
          ? "Syncing"
          : online
            ? "Online"
            : "Offline fallback";

  if (backendConfigured && remoteLoading && remoteRestoreState === "checking") {
    return <AppLoadingScreen />;
  }

  if (showRestoreRecovery) {
    return (
      <>
        <div className="login-page">
          <div className="login-card restore-card">
            <div className="restore-card-logo">
              <img src={brandLogo} alt={`${appData.businessProfile.name || "BreakPerfect"} logo`} />
            </div>
            <div>
              <div className="eyebrow">BreakPerfect Gaming Lounge</div>
              <h1>{restoreRecoveryTitle}</h1>
              <p>{getRestoreRecoveryMessage()}</p>
            </div>
            <div className="button-row">
              <button className="primary-button" type="button" onClick={retryRemoteRestore} disabled={remoteLoading}>
                {remoteLoading ? "Retrying..." : "Retry"}
              </button>
              <button className="secondary-button" type="button" onClick={handleLogout}>
                Sign Out
              </button>
            </div>
          </div>
        </div>
        {blockingActionLabel && <LoadingOverlay label={blockingActionLabel} />}
      </>
    );
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
          <div className={`status-pill ${remoteReadOnly || remoteRestoreState === "retrying" ? "is-warning" : online ? "is-online" : "is-offline"}`}>
            {restoreStatusLabel}
          </div>
          <div className={`sync-detail-card ${conflictOperationalCount > 0 ? "has-conflict" : failedOperationalCount > 0 ? "has-error" : pendingOperationalCount > 0 ? "has-pending" : ""}`}>
            <div>
              <strong>Live actions</strong>
              <span>{operationalStatusLabel}</span>
            </div>
            {(failedOperationalCount > 0 || conflictOperationalCount > 0) && (
              <div className="button-row" style={{ gap: "0.4rem", marginTop: "0.4rem" }}>
                {retryableFailedOperationalCount > 0 && (
                  <button type="button" className="secondary-button" onClick={retryOperationalSyncNow} disabled={remoteSaving}>
                    Retry
                  </button>
                )}
                {conflictOperationalCount > 0 && (
                  <button type="button" className="ghost-button" onClick={clearOperationalConflicts}>
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
          {remoteError && (
            <div className="remote-error-banner" role="alert">
              <span>{remoteError}</span>
              <div className="button-row" style={{ gap: "0.4rem", marginTop: "0.4rem" }}>
                {pendingRetryData && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={remoteSaving}
                    onClick={() => {
                      const dataToRetry = pendingRetryData;
                      setPendingRetryData(null);
                      setRemoteError("");
                      void saveRemoteSnapshot(dataToRetry, remoteVersion, true, "Retry pending save");
                    }}
                  >
                    Retry
                  </button>
                )}
                <button type="button" className="ghost-button" onClick={() => { setRemoteError(""); setPendingRetryData(null); }}>
                  Dismiss
                </button>
              </div>
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
                  disabled={remoteReadOnly}
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

      <main className={`main-content ${activeTab === "dashboard" ? "is-dashboard-tab" : activeTab === "bills" ? "is-bills-tab" : activeTab === "sale" ? "is-sale-tab" : ""}`}>
        <header className="topbar">
          <div>
            <h1>{pageTitle}</h1>
            <div className="muted">{activeUser.name}</div>
          </div>
          <div className="topbar-actions">
            <TodayMetricCard
              value={currency(
                sumBy(filterPaymentsByBusinessDate(dashboardRevenueCountedPayments, currentBusinessDay, currentBusinessDay), (payment) => payment.amount)
              )}
              timeLabel={formatTime(now)}
              dateLabel={currentDateLabel}
            />
            <MetricCard label="Open Sessions" value={`${activeSessions.length + openCustomerTabs.length}`} />
          </div>
        </header>

        {remoteReadOnly && (
          <div className="remote-restore-banner" role="alert">
            <div>
              <strong>{remoteRestoreState === "retrying" ? "Reconnecting to latest data" : "Cached read-only mode"}</strong>
              <span>{remoteError || "Latest remote data could not be loaded. Cached data is read-only until retry succeeds."}</span>
            </div>
            <button className="secondary-button" type="button" onClick={retryRemoteRestore} disabled={remoteLoading}>
              {remoteLoading ? "Retrying..." : "Retry"}
            </button>
          </div>
        )}

        {recoverableHoppedSessions.length > 0 && (
          <div className="remote-restore-banner" role="alert">
            <div>
              <strong>Game hop needs continuation</strong>
              <span>
                {recoverableHoppedSessions[0].stationNameSnapshot} was closed for a game hop but has not been linked to a next game, consumables tab, or bill.
                {recoverableHoppedSessions.length > 1
                  ? ` ${recoverableHoppedSessions.length - 1} more hopped session${recoverableHoppedSessions.length > 2 ? "s" : ""} also need review.`
                  : ""}
              </span>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => recoverHoppedSessionContinuation(recoverableHoppedSessions[0])}
            >
              Continue
            </button>
          </div>
        )}

        {activeTab === "dashboard" && (
          <DashboardPanel
            stations={stations}
            openCustomerTabs={openCustomerTabs}
            sessionPauseLogs={appData.sessionPauseLogs}
            auditLogs={appData.auditLogs}
            customers={appData.customers}
            customerAutocompleteSuggestions={customerAutocompleteSuggestions}
            inventoryItems={appData.inventoryItems}
            combos={appData.combos}
            sellableOptions={sellableInventoryOptions}
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
            getPreviousHopTotalForSession={(session) => {
              return sumBy(getUnbilledHoppedSessionsForSession(session), (s) => getSessionLiveTotal(s, s.endedAt));
            }}
            getPendingDueForSession={(session) =>
              sumBy(
                getPendingBillsForCustomerDetails(session.customerId, session.customerName, session.customerPhone),
                (bill) => bill.amountDue
              )
            }
            getPreviousHopTotalForCustomerTab={(tab) =>
              sumBy(getUnbilledHoppedSessionsForTab(tab), (session) => getSessionLiveTotal(session, session.endedAt))
            }
            getPendingDueForCustomerTab={(tab) =>
              sumBy(getPendingBillsForCustomerDetails(tab.customerId, tab.customerName, tab.customerPhone), (bill) => bill.amountDue)
            }
            getPreviousHopItemCountForCustomerTab={(tab) =>
              sumBy(getUnbilledHoppedSessionsForTab(tab), (session) => session.items.length)
            }
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
            onSetShowStartSessionModal={handleSetShowStartSessionModal}
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
            sellableOptions={sellableInventoryOptions}
            consumablesCombos={getConsumablesCombos(appData.combos)}
            customers={appData.customers}
            customerAutocompleteSuggestions={customerAutocompleteSuggestions}
            customerTabSearch={customerTabSearch}
            customerTabDraft={customerTabDraft}
            openCustomerTabs={openCustomerTabs}
            selectedCustomerTab={selectedCustomerTab}
            selectedCustomerTabPreviousHops={selectedCustomerTabPreviousHops}
            selectedCustomerTabPendingBills={
              selectedCustomerTab
                ? getPendingBillsForCustomerDetails(selectedCustomerTab.customerId, selectedCustomerTab.customerName, selectedCustomerTab.customerPhone)
                : []
            }
            editCustomerTabDraft={editCustomerTabDraft}
            canEditCustomerTabDetails={canEditSessionCustomerDetails}
            getSellableOptionPickerDetail={getSellableOptionPickerDetail}
            getCustomerTabTotal={getCustomerTabTotal}
            getPendingDueForCustomerTab={(tab) =>
              sumBy(getPendingBillsForCustomerDetails(tab.customerId, tab.customerName, tab.customerPhone), (bill) => bill.amountDue)
            }
            getSessionLiveTotal={getSessionLiveTotal}
            getSessionBilledMinutes={(session) => getSessionChargeSummary(session, session.endedAt).billedMinutes}
            onCustomerTabSearchChange={setCustomerTabSearch}
            onCustomerTabDraftChange={setCustomerTabDraft}
            onSelectCustomerTab={setSelectedCustomerTabId}
            onEditCustomerTabDraftChange={setEditCustomerTabDraft}
            onAddItemToCustomerTab={(customerTabId, option, sellAsPackOf) => addItemToCustomerTab(customerTabId, option, sellAsPackOf)}
            onApplyComboToCustomerTab={applyComboToCustomerTab}
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
            inventoryArchiveView={inventoryArchiveView}
            activeInventoryCount={activeInventoryItems.length}
            archivedInventoryCount={archivedInventoryItems.length}
            inventoryArchiveDraft={inventoryArchiveDraft}
            inventoryReport={inventoryReportModel}
            inventoryReportFilter={inventoryReportFilter}
            inventoryReportFromDate={inventoryReportFromDate}
            inventoryReportToDate={inventoryReportToDate}
            inventoryReportRangeLabel={resolvedInventoryReportRange.label}
            inventoryReportSearch={inventoryReportSearch}
            inventoryReportBackend={
              inventoryReportReadsEnabled
                ? {
                    enabled: true,
                    ready: inventoryReportDataReady,
                    loading: inventoryReportSummaryState.loading,
                    error: inventoryReportSummaryState.error,
                    onRefresh: refreshInventoryReport
                  }
                : undefined
            }
            combos={appData.combos}
            comboDraft={comboDraft}
            stations={appData.stations}
            sellableOptions={sellableInventoryOptions}
            filteredInventoryItems={filteredInventoryItems}
            inventoryCategoryOptions={inventoryCategoryOptions}
            canEditInventory={canEditInventory}
            isManagerReadOnly={isManagerReadOnly}
            getInventoryState={getInventoryState}
            getInventoryStateLabel={getInventoryStateLabel}
            getAvailableStock={getAvailableStock}
            onItemFormChange={setItemForm}
            onEditItemFormChange={setEditItemForm}
            onUseCustomItemCategoryChange={setUseCustomItemCategory}
            onCustomItemCategoryChange={setCustomItemCategory}
            onUseCustomEditItemCategoryChange={setUseCustomEditItemCategory}
            onCustomEditItemCategoryChange={setCustomEditItemCategory}
            onInventoryActionChange={setInventoryAction}
            onInventoryItemSearchChange={setInventoryItemSearch}
            onInventoryArchiveViewChange={setInventoryArchiveView}
            onInventoryReportFilterChange={setInventoryReportFilter}
            onInventoryReportSearchChange={setInventoryReportSearch}
            onInventoryPanelViewChange={setActiveInventoryPanelView}
            onComboDraftChange={setComboDraft}
            onSaveCombo={saveComboDraft}
            onEditCombo={editCombo}
            onToggleComboActive={toggleComboActive}
            onArchiveDraftReasonChange={(reason) => {
              setInventoryArchiveDraft((draft) => draft ? { ...draft, reason } : draft);
            }}
            onUpsertInventoryItem={upsertInventoryItem}
            onSaveEditedInventoryItem={saveEditedInventoryItem}
            onCloseEditInventoryModal={closeEditInventoryModal}
            onBeginEditInventoryItem={beginEditInventoryItem}
            onBeginArchiveInventoryItem={beginArchiveInventoryItem}
            onCloseArchiveInventoryModal={() => setInventoryArchiveDraft(null)}
            onArchiveInventoryItem={archiveInventoryItem}
            onRestoreInventoryItem={restoreInventoryItem}
            onRecordStockMovement={recordStockMovement}
          />
        )}

        {activeTab === "bills" && canAccessTab("bills") && (
          <BillRegisterPanel
            bills={billRegisterBills}
            billBusinessDates={billRegisterBusinessDates}
            billPaymentBusinessDates={billRegisterPaymentBusinessDates}
            stations={appData.stations}
            businessProfile={appData.businessProfile}
            selectedReceiptBillId={selectedReceiptBillId}
            selectedReceiptBill={selectedReceiptBill}
            receiptPreviewModel={receiptPreviewModel}
            allBills={billRegisterReceiptBills}
            allPayments={billRegisterReceiptPayments}
            receivableGroups={pendingReceivableGroups}
            receivableFocusToken={billRegisterFocus?.token}
            receivableFocusSearch={billRegisterFocus?.search}
            canReplaceIssuedBills={canReplaceIssuedBills}
            canVoidRefundBills={canVoidRefundBills}
            canSettlePendingBills={canSettlePendingBills}
            normalizedHistory={
              normalizedBillHistoryReadsEnabled
                ? {
                    enabled: true,
                    ready: normalizedBillRegisterDisplayEnabled,
                    loading: normalizedBillRegisterState.loading,
                    loadingMore: normalizedBillRegisterState.loadingMore,
                    error: normalizedBillRegisterState.error,
                    hasMore: normalizedBillRegisterState.hasMore,
                    onQueryChange: handleNormalizedBillRegisterQueryChange,
                    onLoadMore: loadMoreNormalizedBillRegister,
                    onRefresh: refreshNormalizedBillRegister
                  }
                : undefined
            }
            onSelectReceiptBill={setSelectedReceiptBillId}
            onSettlePendingBill={(billId) => setSettlementDraft({ billId, paymentMode: "cash", cashAmount: 0, upiAmount: 0 })}
            onSettlePendingBills={(billIds) => setSettlementDraft({ billIds, paymentMode: "cash", cashAmount: 0, upiAmount: 0 })}
            onVoidPendingBill={(billId) => setVoidPendingDraft({ billId, reason: "" })}
            onVoidPendingBills={(billIds, customerLabel) => setVoidPendingGroupDraft({ billIds, customerLabel, reason: "" })}
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
            expenseTemplateOverrides={appData.expenseTemplateOverrides}
            pendingBackfillTemplateId={pendingBackfillTemplate}
            reportRows={reportRows}
            summary={{
              grossRevenue,
              netCashEarnings,
              normalizedNetProfit,
              issuedBillsCount: paidBillsInRangeCount,
              oneTimeExpenses,
              normalizedExpenses,
              sessionRevenue,
              itemRevenue,
              totalDiscounts,
              pendingRevenue,
              deferredOutstanding,
              previousRangeLabel: previousRange.label,
              previousRangeRevenue,
              revenueGrowthPct,
              averageBillValue,
              topStation,
              paymentModeTotals,
              expensePaymentModeTotals,
              expenseByCategory,
              normalizedExpenseByCategory,
              normalizedExpenseDetails: normalizedExpenseEntries
            }}
            allPendingReceivables={allPendingReceivables}
            expenseForm={expenseForm}
            expenseTemplateForm={expenseTemplateForm}
            expenseCategoryOptions={expenseCategoryOptions}
            canCreateExpenses={canCreateExpenses}
            canDeleteExpenses={canDeleteExpenses}
            canManageExpenseTemplates={canManageExpenseTemplates}
            isManagerReadOnly={isManagerReadOnly}
            normalizedReports={
              analyticsSummaryReadsEnabled
                ? {
                    enabled: true,
                    ready: financialReportDataReady,
                    loading: financialReportLoading,
                    error: financialReportError,
                    onRefresh: refreshNormalizedReport
                  }
                : normalizedReportReadsEnabled
                ? {
                    enabled: true,
                    ready: financialReportDataReady,
                    loading: financialReportLoading,
                    error: financialReportError,
                    onRefresh: refreshNormalizedReport
                  }
                : undefined
            }
            onReportFilterChange={setReportFilter}
            onExpenseFormChange={setExpenseForm}
            onExpenseTemplateFormChange={setExpenseTemplateForm}
            onCreateExpense={createExpense}
            onDeleteExpense={deleteExpense}
            onSaveExpenseTemplate={saveExpenseTemplate}
            onBeginEditExpenseTemplate={beginEditExpenseTemplate}
            onToggleExpenseTemplateActive={toggleExpenseTemplateActive}
            onDeleteExpenseTemplate={deleteExpenseTemplate}
            onCreateOrUpdateOverride={createOrUpdateOverride}
            onCreateOrUpdateOverrideForFutureMonths={createOrUpdateOverrideForFutureMonths}
            onDeleteOverride={deleteOverride}
            onResolveBackfillPrompt={resolveBackfillPrompt}
            onSettlePendingBill={(billId) => setSettlementDraft({ billId, paymentMode: "cash", cashAmount: 0, upiAmount: 0 })}
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
            normalizedHistory={
              normalizedCustomerHistoryReadsEnabled
                ? {
                    enabled: true,
                    ready: normalizedCustomerHistoryReady,
                    loading: normalizedCustomerHistoryState.loading,
                    error: normalizedCustomerHistoryState.error,
                    onRefresh: () => setNormalizedCustomerHistoryRefreshSignal((value) => value + 1)
                  }
                : undefined
            }
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
          title={lastHoppedSessionId ? "Continue Customer" : "Start New Session"}
          onClose={() => {
            if (lastHoppedSessionId) {
              billHoppedSession();
            } else {
              handleSetShowStartSessionModal(false);
              setStartSessionDraft(createStartSessionDraft());
            }
          }}
        >
          <form
            className="form-grid"
            onSubmit={lastHoppedSessionId && postHopContinuationMode === "consumables" ? startPostHopConsumablesTab : startSession}
          >
            {lastHoppedSessionId && (
              <>
                <div className="field-span-full frozen-billing-banner">
                  <strong>Continuing from: {postHopSession?.customerName || "Customer"} - {postHopSession?.stationNameSnapshot ?? "Previous session"}</strong>
                  <span>
                    {postHopSessionCharge
                      ? `${formatMinutes(postHopSessionCharge.billedMinutes)} - ${currency(postHopSessionCharge.subtotal)}`
                      : "Previous unbilled session will stay directly linked."}
                  </span>
                  {postHopCustomerLocked ? (
                    <button className="secondary-button" type="button" onClick={detachPostHopContinuation}>
                      Change Customer
                    </button>
                  ) : (
                    <span className="muted">Customer changed. Previous hopped session remains unbilled.</span>
                  )}
                </div>
                <label className="field-span-full">
                  <span>Continue As</span>
                  <select
                    value={postHopContinuationMode}
                    onChange={(event) => {
                      if (lastHoppedSessionId && event.target.value !== "gaming") {
                        discardFailedContinuationStart(lastHoppedSessionId);
                      }
                      setPostHopTabLinkDraft(null);
                      setPostHopContinuationMode(event.target.value as PostHopContinuationMode);
                    }}
                  >
                    <option value="gaming">Gaming Session</option>
                    <option value="consumables">Consumables Tab</option>
                  </select>
                </label>
              </>
            )}
            {(!lastHoppedSessionId || postHopContinuationMode === "gaming") && (
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
                        arcadeQuantity: 1,
                        comboId: "",
                        comboChoices: {}
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
            )}
            <CustomerAutocompleteFields
              customers={appData.customers}
              customerId={startSessionDraft.customerId}
              customerName={startSessionDraft.customerName}
              customerPhone={startSessionDraft.customerPhone}
              namePlaceholder="Optional"
              phonePlaceholder="Optional"
              phoneFieldClassName="field-span-full"
              disabled={Boolean(lastHoppedSessionId && postHopCustomerLocked)}
              {...customerAutocompleteSuggestions}
              onChange={(next) => {
                setPostHopTabLinkDraft(null);
                setStartSessionDraft((previous) => ({ ...previous, ...next }));
              }}
            />
            {lastHoppedSessionId && postHopContinuationMode === "consumables" && postHopTabLinkDraft && (
              <div className="field-span-full warning-banner">
                <strong>
                  {postHopTabLinkCandidates.length === 1
                    ? "Existing consumables tab found"
                    : `${postHopTabLinkCandidates.length} matching consumables tabs found`}
                </strong>
                <span>
                  Link the hopped game to an existing open tab so the previous game appears in the live bill and checkout.
                </span>
                {postHopTabLinkCandidates.length > 1 && (
                  <label>
                    <span>Select tab</span>
                    <select
                      value={selectedPostHopTabLinkCandidate?.id ?? ""}
                      onChange={(event) =>
                        setPostHopTabLinkDraft((previous) =>
                          previous ? { ...previous, selectedTabId: event.target.value } : previous
                        )
                      }
                    >
                      {postHopTabLinkCandidates.map((tab) => (
                        <option key={tab.id} value={tab.id}>
                          {tab.customerName} - {tab.customerPhone || "No phone"} - {currency(getCustomerTabTotal(tab))}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selectedPostHopTabLinkCandidate && (
                  <div className="muted">
                    Selected: {selectedPostHopTabLinkCandidate.customerName}
                    {selectedPostHopTabLinkCandidate.customerPhone ? ` - ${selectedPostHopTabLinkCandidate.customerPhone}` : ""}
                    {" - "}
                    {selectedPostHopTabLinkCandidate.items.length + (selectedPostHopTabLinkCandidate.comboApplications?.length ?? 0)} current item
                    {selectedPostHopTabLinkCandidate.items.length + (selectedPostHopTabLinkCandidate.comboApplications?.length ?? 0) === 1 ? "" : "s"}
                    {" - "}
                    {currency(getCustomerTabTotal(selectedPostHopTabLinkCandidate))}
                  </div>
                )}
                <div className="button-row dense">
                  <button className="secondary-button" type="button" onClick={() => setPostHopTabLinkDraft(null)}>
                    Cancel Link
                  </button>
                </div>
              </div>
            )}
            {(!lastHoppedSessionId || postHopContinuationMode === "gaming") && selectedStartStation?.mode === "timed" && selectedStationCombos.length > 0 && (
              <>
                <label className="field-span-full">
                  <span>Combo</span>
                  <select
                    value={startSessionDraft.comboId ?? ""}
                    onChange={(event) =>
                      setStartSessionDraft((previous) => ({
                        ...previous,
                        comboId: event.target.value,
                        comboChoices: {}
                      }))
                    }
                  >
                    <option value="">Normal Session</option>
                    {selectedStationCombos.map((combo) => (
                      <option key={combo.id} value={combo.id}>
                        {combo.name} - {currency(combo.price)} - {combo.includedMinutes} min
                      </option>
                    ))}
                  </select>
                </label>
                {selectedStartCombo?.choiceGroups.flatMap((group) =>
                  Array.from({ length: Math.max(1, Math.trunc(group.requiredQuantity)) }, (_, index) => (
                    <label key={`${group.id}-${index}`}>
                      <span>{group.requiredQuantity > 1 ? `${group.label} ${index + 1}` : group.label}</span>
                      <select
                        required
                        value={startSessionDraft.comboChoices?.[group.id]?.[index] ?? ""}
                        onChange={(event) =>
                          setStartSessionDraft((previous) => {
                            const nextChoices = [...(previous.comboChoices?.[group.id] ?? [])];
                            nextChoices[index] = event.target.value;
                            return {
                              ...previous,
                              comboChoices: {
                                ...(previous.comboChoices ?? {}),
                                [group.id]: nextChoices
                              }
                            };
                          })
                        }
                      >
                        <option value="">Select option</option>
                        {group.optionIds.map((optionId) => {
                          const option = sellableOptionById.get(optionId);
                          return option ? <option key={optionId} value={optionId}>{option.name}</option> : null;
                        })}
                      </select>
                    </label>
                  ))
                )}
              </>
            )}
            {(!lastHoppedSessionId || postHopContinuationMode === "gaming") && selectedStartStation?.ltpEnabled && (
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
            {(!lastHoppedSessionId || postHopContinuationMode === "gaming") && selectedStartStation?.mode === "unit_sale" && (
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
                            {item.name} - {currency(item.price)} - {getInventoryPickerDetail(item)}
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
              {lastHoppedSessionId ? (
                <button className="secondary-button" type="button" onClick={billHoppedSession}>
                  Bill &amp; Done
                </button>
              ) : (
                <button className="secondary-button" type="button" onClick={() => {
                  handleSetShowStartSessionModal(false);
                  setStartSessionDraft(createStartSessionDraft());
                }}>
                  Cancel
                </button>
              )}
              <button
                className="primary-button"
                type={lastHoppedSessionId && postHopContinuationMode === "consumables" && postHopTabLinkDraft ? "button" : "submit"}
                disabled={
                  remoteSaving ||
                  Boolean(blockingActionLabel) ||
                  (postHopContinuationMode === "gaming" && selectedStartStation?.mode === "unit_sale" && arcadeInventoryItems.length === 0) ||
                  Boolean(lastHoppedSessionId && postHopContinuationMode === "consumables" && postHopTabLinkDraft && !selectedPostHopTabLinkCandidate)
                }
                onClick={lastHoppedSessionId && postHopContinuationMode === "consumables" && postHopTabLinkDraft ? confirmPostHopCustomerTabLink : undefined}
              >
                {lastHoppedSessionId && postHopContinuationMode === "consumables" && postHopTabLinkDraft
                  ? "Link Existing Tab"
                  : lastHoppedSessionId && postHopContinuationMode === "consumables"
                    ? "Start Consumables Tab"
                    : retryableContinuationMutation
                      ? "Retry Start Session"
                      : "Start Session"}
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
            <MetricCard
              label={managedSessionPendingDue > 0
                ? (managedSession.mode === "timed" ? "Live bill + dues" : "Current total + dues")
                : managedSessionPreviousHopTotal > 0
                ? (managedSession.mode === "timed" ? "Live total (all sessions)" : "Current total (all sessions)")
                : (managedSession.mode === "timed" ? "Live bill" : "Current total")}
              value={currency(managedSessionLiveTotal)}
            />
            {managedSessionPendingDue > 0 && (
              <MetricCard label="Previous pending" value={currency(managedSessionPendingDue)} />
            )}
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
          {managedSessionPreviousHops.length > 0 && (
            <>
              <div className="panel-header compact-header">
                <div>
                  <h2>Previous Game Sessions</h2>
                  <p>Game charges carried forward - will be included in the combined bill.</p>
                </div>
              </div>
              <div className="line-items">
                {managedSessionPreviousHops.map((hSession) => {
                  const hCharge = getSessionChargeSummary(hSession, hSession.endedAt);
                  return (
                    <div key={hSession.id} className="session-item-row">
                      <div>
                        <strong>{hSession.stationNameSnapshot}</strong>
                        {hSession.mode === "timed" && (
                          <div className="muted">{formatMinutes(hCharge.billedMinutes)} - {currency(hCharge.subtotal)}/session</div>
                        )}
                      </div>
                      <div className="session-item-actions">
                        <span>{currency(hCharge.subtotal)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {managedSessionPendingBills.length > 0 && (
            <>
              <div className="panel-header compact-header">
                <div>
                  <h2>Previous Pending Bills</h2>
                  <p>Outstanding dues for this customer - will be included during checkout.</p>
                </div>
              </div>
              <div className="line-items previous-pending-lines">
                {managedSessionPendingBills.map((bill) => (
                  <div key={bill.id} className="session-item-row previous-due-session-row">
                    <div>
                      <strong>Previous due - {bill.billNumber}</strong>
                      <div className="muted">
                        {billBusinessDates[bill.id] ?? toBusinessDayKey(bill.issuedAt)}
                        {bill.customerName ? ` - ${bill.customerName}` : ""}
                      </div>
                    </div>
                    <div className="session-item-actions">
                      <span className="pending-amount">{currency(bill.amountDue)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="frozen-billing-banner">
            Add consumables to the live session here. The running game time is not changed by this action.
          </div>
          {editSessionDraft?.sessionId === managedSession.id && (
            <div className="section-block section-block-muted">
              <div className="section-block-header">
                <h3>Edit Session Details</h3>
                <p>All staff can update customer name and phone.{canEditSessionTiming ? " Admins can also correct the session start time." : ""}</p>
              </div>
              <form className="form-grid" onSubmit={saveSessionDetails}>
                <CustomerAutocompleteFields
                  customers={appData.customers}
                  customerId={editSessionDraft.customerId}
                  customerName={editSessionDraft.customerName}
                  customerPhone={editSessionDraft.customerPhone}
                  namePlaceholder="Optional"
                  phonePlaceholder="Optional"
                  {...customerAutocompleteSuggestions}
                  onChange={(next) =>
                    setEditSessionDraft((previous) => (previous ? { ...previous, ...next } : previous))
                  }
                />
                {managedSession.mode === "timed" && canEditSessionTiming && (
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
            <SellableInventoryPicker
              options={sellableInventoryOptions}
              value={sessionItemForm[managedSession.id]?.sellableOptionId ?? ""}
              onChange={(optionId) =>
                setSessionItemForm((previous) => ({
                  ...previous,
                  [managedSession.id]: {
                    sellableOptionId: optionId,
                    quantity: previous[managedSession.id]?.quantity ?? 1,
                    sellAsPackOf: undefined
                  }
                }))
              }
              getOptionDetail={(option) => getSellableOptionPickerDetail(option, managedSession.id)}
              isOptionDisabled={(option) => isSellableOptionUnavailable(option, managedSession.id)}
            />
            {(() => {
              const selectedOption = sellableOptionById.get(sessionItemForm[managedSession.id]?.sellableOptionId ?? "");
              const selectedItem = selectedOption?.item;
              if (!selectedOption?.isBaseItem || !selectedItem?.cigarettePack) return null;
              const packOf = selectedItem.cigarettePack;
              const selling = sessionItemForm[managedSession.id]?.sellAsPackOf;
              return (
                <select value={selling ? "pack" : "single"} onChange={(e) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { ...p[managedSession.id], sellableOptionId: p[managedSession.id]?.sellableOptionId ?? "", quantity: p[managedSession.id]?.quantity ?? 1, sellAsPackOf: e.target.value === "pack" ? packOf.size : undefined } }))}>
                  <option value="single">Single - {currency(selectedItem.price)}</option>
                  <option value="pack">Pack of {packOf.size} - {currency(packOf.packPrice)}</option>
                </select>
              );
            })()}
            <NumericInput min={1} defaultValue={1} value={sessionItemForm[managedSession.id]?.quantity ?? 1} onValueChange={(value) => setSessionItemForm((p) => ({ ...p, [managedSession.id]: { ...p[managedSession.id], sellableOptionId: p[managedSession.id]?.sellableOptionId ?? "", quantity: value } }))} />
            <button className="secondary-button" type="button" onClick={() => addItemToSession(managedSession.id)}>Add Item</button>
          </div>
          {(() => {
            const selectedOption = sellableOptionById.get(sessionItemForm[managedSession.id]?.sellableOptionId ?? "");
            if (!selectedOption || selectedOption.price > 0) return null;
            return <div className="warning-banner">Warning: This item has a Rs 0 price - confirm or update it in Inventory before adding.</div>;
          })()}
          <div className="line-items">
            {managedSessionPreviousHops.flatMap((hSession) =>
              hSession.items.map((item) => {
                const invCategory = appData.inventoryItems.find((i) => i.id === item.inventoryItemId)?.category ?? "";
                const catImage = getCategoryImage(invCategory);
                return (
                  <div key={`${hSession.id}-${item.id}`} className="session-item-row">
                    <div>
                      <strong>
                        {catImage
                          ? <img src={catImage} alt="" className="category-icon-img" />
                          : invCategory ? <span className="category-icon">{getCategoryIcon(invCategory)}</span> : null}
                        {item.name}{item.soldAsPackOf ? ` (Pack of ${item.soldAsPackOf})` : ""}
                      </strong>
                      <div className="muted">From: {hSession.stationNameSnapshot}</div>
                    </div>
                    <div className="session-item-actions">
                      <span>{item.quantity} x {currency(item.unitPrice)}</span>
                      {item.comboApplicationId ? <span className="muted">Combo included</span> : <button className="ghost-button danger" type="button" onClick={() => removeItemFromSession(hSession.id, item.id)}>Remove</button>}
                    </div>
                  </div>
                );
              })
            )}
            {managedSession.items.length === 0 && managedSessionPreviousHops.every(h => h.items.length === 0) && <div className="empty-state">No consumables added yet.</div>}
            {managedSession.items.map((item: SessionItem) => {
              const invCategory = appData.inventoryItems.find((i) => i.id === item.inventoryItemId)?.category ?? "";
              const catImage = getCategoryImage(invCategory);
              return (
              <div key={item.id} className="session-item-row">
                <div>
                  <strong>
                    {catImage
                      ? <img src={catImage} alt="" className="category-icon-img" />
                      : invCategory ? <span className="category-icon">{getCategoryIcon(invCategory)}</span> : null}
                    {item.name}{item.soldAsPackOf ? ` (Pack of ${item.soldAsPackOf})` : ""}
                  </strong>
                  <div className="muted">{formatTime(item.addedAt)}</div>
                </div>
                <div className="session-item-actions">
                  <span>{item.quantity} x {currency(item.unitPrice)}</span>
                  {item.comboApplicationId ? <span className="muted">Combo included</span> : <button className="ghost-button danger" type="button" onClick={() => removeItemFromSession(managedSession.id, item.id)}>Remove</button>}
                </div>
              </div>
            );
            })}
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
                {managedSessionCharge.segments.map((segment, index) => <div key={`${segment.label}-${index}`} className="activity-row"><strong>Game Type - {currency(segment.hourlyRate)}/hr</strong><span className="muted">{formatMinutes(segment.minutes)} - {currency(segment.subtotal)}</span></div>)}
              </div>
            </>
          )}
          {managedSession.mode === "timed" && managedSession.pauseLogIds.length > 0 && canEditSessionTiming && (
            <>
              <div className="divider" />
              <div className="panel-header compact-header">
                <div>
                  <h2>Pause History</h2>
                  <p>Review and correct pause/resume timestamps for this session.</p>
                </div>
              </div>
              <div className="line-items">
                {managedSession.pauseLogIds.map((logId) => {
                  const log = appData.sessionPauseLogs.find((entry) => entry.id === logId);
                  if (!log) return null;
                  const isEditing = editingPauseLogId === logId;
                  const isDeleteConfirm = pauseLogDeleteConfirmId === logId;
                  return (
                    <div key={logId} className="session-item-row">
                      {isEditing ? (
                        <div className="form-grid" style={{ flex: 1 }}>
                          <label>
                            <span>Paused At</span>
                            <input
                              type="datetime-local"
                              value={pauseLogEditDraft.pausedAt}
                              onChange={(e) => setPauseLogEditDraft((p) => ({ ...p, pausedAt: e.target.value }))}
                            />
                          </label>
                          <label>
                            <span>Resumed At</span>
                            <input
                              type="datetime-local"
                              value={pauseLogEditDraft.resumedAt}
                              onChange={(e) => setPauseLogEditDraft((p) => ({ ...p, resumedAt: e.target.value }))}
                            />
                          </label>
                          <div className="button-row field-span-full">
                            <button className="secondary-button" type="button" onClick={() => setEditingPauseLogId(null)}>Cancel</button>
                            <button
                              className="primary-button"
                              type="button"
                              onClick={() => editPauseLogEntry(logId, {
                                pausedAt: pauseLogEditDraft.pausedAt,
                                resumedAt: pauseLogEditDraft.resumedAt || undefined
                              })}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : isDeleteConfirm ? (
                        <div style={{ flex: 1 }}>
                          <span className="muted">Delete this pause entry?</span>
                          <div className="button-row" style={{ marginTop: "0.5rem" }}>
                            <button className="secondary-button" type="button" onClick={() => setPauseLogDeleteConfirmId(null)}>Cancel</button>
                            <button className="ghost-button danger" type="button" onClick={() => deletePauseLogEntry(logId)}>Delete</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div>
                            <strong>{formatDateTime(log.pausedAt)}</strong>
                            <div className="muted">-&gt; {log.resumedAt ? formatDateTime(log.resumedAt) : "Active"}</div>
                          </div>
                          <div className="session-item-actions">
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={() => {
                                setEditingPauseLogId(logId);
                                setPauseLogEditDraft({
                                  pausedAt: formatDateTimeInputValue(log.pausedAt),
                                  resumedAt: log.resumedAt ? formatDateTimeInputValue(log.resumedAt) : ""
                                });
                              }}
                            >
                              Edit
                            </button>
                            <button className="ghost-button danger" type="button" onClick={() => setPauseLogDeleteConfirmId(logId)}>Delete</button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {hasPendingOperationalForSession(managedSession.id) && (
            <div className="inline-sync-warning">Pending sync. Checkout and close actions unlock after the latest live changes are saved.</div>
          )}
          <div className="button-row">
            {canEditSessionCustomerDetails && (
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  editSessionDraft?.sessionId === managedSession.id ? setEditSessionDraft(null) : beginEditSessionDetails(managedSession)
                }
              >
                {editSessionDraft?.sessionId === managedSession.id ? "Hide Details" : "Edit Customer Details"}
              </button>
            )}
            {(managedSession.comboApplications ?? []).length > 0 && managedSession.status !== "closed" && (
              <button className="secondary-button" type="button" onClick={() => repeatSessionCombo(managedSession.id)}>
                Repeat Combo
              </button>
            )}
            {managedSession.mode === "timed" && (managedSession.status === "active" ? <button className="secondary-button session-action-button is-pause" type="button" onClick={() => toggleSessionPause(managedSession.id, true)}>|| Pause Session</button> : <button className="secondary-button session-action-button is-resume" type="button" onClick={() => toggleSessionPause(managedSession.id, false)}>&gt; Resume Session</button>)}
            <button className="ghost-button danger" type="button" onClick={() => rejectSession(managedSession.id)} disabled={hasPendingOperationalForSession(managedSession.id)}>Reject Session</button>
            <button className="primary-button" type="button" onClick={() => openSessionCheckout(managedSession.id)} disabled={hasPendingOperationalForSession(managedSession.id)}>Proceed to Checkout</button>
          </div>
        </Modal>
      )}

      {checkoutState && checkoutPreview && (
        <Modal
          title={
            checkoutState.mode === "session"
              ? checkoutSession?.closeDisposition === "hopped"
                ? "Bill Hopped Session"
                : "Close Session Bill"
              : checkoutState.mode === "customer_tab"
                ? "Finalize Customer Tab Bill"
                : "Replace Issued Bill"
          }
          onClose={() => {
            if (checkoutSession?.closeDisposition === "hopped") {
              returnToStartNextGame();
            } else {
              setCheckoutState(null);
              setIsHopMode(false);
              setReplacementItemForm({ sellableOptionId: "", quantity: 1 });
            }
          }}
          wide
        >
          <div className="form-grid three-columns">
            <CustomerAutocompleteFields
              customers={appData.customers}
              customerId={checkoutState.customerId}
              customerName={checkoutState.customerName}
              customerPhone={checkoutState.customerPhone}
              disabled={!canEditSessionCustomerDetails && checkoutState.mode !== "bill_replacement"}
              {...customerAutocompleteSuggestions}
              onChange={(next) => setCheckoutState((p) => (p ? { ...p, ...next } : p))}
            />
            {!isHopMode && <label><span>Payment Mode</span><select value={checkoutState.paymentMode} onChange={(event) => setCheckoutState((p) => p ? { ...p, paymentMode: event.target.value as BillPaymentMode, splitCashAmount: 0, splitUpiAmount: 0, collectAmount: 0 } : p)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="split">Split (Cash + UPI)</option>{checkoutState.mode !== "bill_replacement" && <option value="deferred">Pay Later</option>}</select></label>}
          </div>
          {checkoutState.mode === "session" && checkoutSession?.status !== "closed" && (
            <div className="form-grid">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={isHopMode}
                  onChange={(event) => setIsHopMode(event.target.checked)}
                />
                <span>Game hop - close station without billing (customer will pay with their next game)</span>
              </label>
            </div>
          )}
          {isHopMode && (
            <div className="frozen-billing-banner">
              Game hop mode - the station will be released immediately. No bill will be issued. This session's charges will be included when the customer checks out their next game.
            </div>
          )}
          {!isHopMode && (checkoutState.mode === "session" || checkoutState.mode === "customer_tab") && checkoutHoppedSessionCandidates.length > 0 && (
            <div>
              <div className="muted" style={{ marginBottom: "0.5rem", fontWeight: 600 }}>Previous unbilled sessions for this customer</div>
              {checkoutHoppedSessionCandidates.map((hSession) => {
                const hCharge = getSessionChargeSummary(hSession, hSession.endedAt);
                const isSelected = (checkoutState.hoppedSessionIds ?? []).includes(hSession.id);
                const isDirectlyLinked = checkoutDirectHoppedSessionIds.includes(hSession.id);
                return (
                  <label className="checkbox-field" key={hSession.id} style={{ marginBottom: "0.25rem" }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(event) => {
                        if (event.target.checked && !isDirectlyLinked && !window.confirm(
                          `Include possible match "${hSession.stationNameSnapshot}" (${currency(hCharge.subtotal)}) in this bill?\n\nThis session was matched by customer details, not by direct hop continuation.`
                        )) {
                          return;
                        }
                        if (!event.target.checked && !window.confirm(
                          `Remove "${hSession.stationNameSnapshot}" (${currency(hCharge.subtotal)}) from this bill?\n\nThat session will remain unlinked and must be billed separately later.`
                        )) {
                          return;
                        }
                        setCheckoutState((p) =>
                          p ? {
                            ...p,
                            hoppedSessionIds: event.target.checked
                              ? [...(p.hoppedSessionIds ?? []), hSession.id]
                              : (p.hoppedSessionIds ?? []).filter((id) => id !== hSession.id)
                          } : p
                        );
                      }}
                    />
                    <span>{hSession.stationNameSnapshot} - {formatMinutes(hCharge.billedMinutes)} - {currency(hCharge.subtotal)}{isDirectlyLinked ? " - linked continuation" : " - possible match"}</span>
                  </label>
                );
              })}
            </div>
          )}
          {!isHopMode && checkoutState.paymentMode === "split" && (
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
          {!isHopMode && checkoutState.paymentMode === "deferred" && (
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
          {!isHopMode && checkoutState.mode !== "bill_replacement" && checkoutState.pendingSettlement && checkoutAvailablePendingSettlementBills.length > 0 && (
            <div className="section-block previous-dues-panel">
              <div className="section-block-header">
                <h3>Previous Dues</h3>
                <p>
                  {checkoutAvailablePendingSettlementBills.length} pending bill{checkoutAvailablePendingSettlementBills.length !== 1 ? "s" : ""} found for this customer.
                  Selected due: <strong className="pending-amount">{currency(checkoutPendingSettlementDue)}</strong>
                </p>
              </div>
              <div className="activity-list compact-list">
                {checkoutAvailablePendingSettlementBills.map((bill) => {
                  const isSelected = checkoutState.pendingSettlement?.billIds.includes(bill.id) ?? false;
                  return (
                    <label key={bill.id} className="checkbox-field receivable-check-row">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(event) =>
                          setCheckoutState((previous) => {
                            if (!previous?.pendingSettlement) return previous;
                            const nextBillIds = event.target.checked
                              ? Array.from(new Set([...previous.pendingSettlement.billIds, bill.id]))
                              : previous.pendingSettlement.billIds.filter((billId) => billId !== bill.id);
                            const nextDue = getPendingSettlementDueForIds(nextBillIds);
                            return {
                              ...previous,
                              pendingSettlement: {
                                ...applyPendingSettlementAmount(previous.pendingSettlement, nextDue),
                                billIds: nextBillIds
                              }
                            };
                          })
                        }
                      />
                      <span>
                        <strong>{bill.billNumber}</strong> - {currency(bill.amountDue)} due
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="form-grid">
                <label>
                  <span>Previous Dues Payment</span>
                  <select
                    value={checkoutState.pendingSettlement.paymentMode}
                    onChange={(event) =>
                      setCheckoutState((previous) =>
                        previous?.pendingSettlement
                          ? {
                              ...previous,
                              pendingSettlement: {
                                ...previous.pendingSettlement,
                                paymentMode: event.target.value as PaymentMode | "split",
                                cashAmount: event.target.value === "upi" ? 0 : checkoutPendingSettlementDue,
                                upiAmount: event.target.value === "upi" ? checkoutPendingSettlementDue : 0
                              }
                            }
                          : previous
                      )
                    }
                  >
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="split">Split</option>
                  </select>
                </label>
                {checkoutState.pendingSettlement.paymentMode === "split" ? (
                  <>
                    <label>
                      <span>Previous Cash</span>
                      <NumericInput mode="decimal" min={0} value={checkoutState.pendingSettlement.cashAmount} onValueChange={(value) => setCheckoutState((previous) => previous?.pendingSettlement ? { ...previous, pendingSettlement: { ...previous.pendingSettlement, cashAmount: value } } : previous)} />
                    </label>
                    <label>
                      <span>Previous UPI</span>
                      <NumericInput mode="decimal" min={0} value={checkoutState.pendingSettlement.upiAmount} onValueChange={(value) => setCheckoutState((previous) => previous?.pendingSettlement ? { ...previous, pendingSettlement: { ...previous.pendingSettlement, upiAmount: value } } : previous)} />
                    </label>
                  </>
                ) : checkoutState.pendingSettlement.paymentMode === "cash" ? (
                  <label>
                    <span>Previous Cash Amount</span>
                    <NumericInput mode="decimal" min={0} value={checkoutState.pendingSettlement.cashAmount} onValueChange={(value) => setCheckoutState((previous) => previous?.pendingSettlement ? { ...previous, pendingSettlement: { ...previous.pendingSettlement, cashAmount: value } } : previous)} />
                  </label>
                ) : (
                  <label>
                    <span>Previous UPI Amount</span>
                    <NumericInput mode="decimal" min={0} value={checkoutState.pendingSettlement.upiAmount} onValueChange={(value) => setCheckoutState((previous) => previous?.pendingSettlement ? { ...previous, pendingSettlement: { ...previous.pendingSettlement, upiAmount: value } } : previous)} />
                  </label>
                )}
                <div className="field-span-full button-row">
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={checkoutPendingSettlementDue <= 0}
                    onClick={() =>
                      setCheckoutState((previous) => {
                        if (!previous?.pendingSettlement) return previous;
                        return {
                          ...previous,
                          pendingSettlement: applyPendingSettlementAmount(previous.pendingSettlement, checkoutPendingSettlementDue)
                        };
                      })
                    }
                  >
                    Collect Selected Due ({currency(checkoutPendingSettlementDue)})
                  </button>
                  {checkoutPendingSettlementAmount > checkoutPendingSettlementDue && (
                    <span className="pending-amount">Previous dues payment exceeds selected due.</span>
                  )}
                </div>
              </div>
            </div>
          )}
          {checkoutState && checkoutSession && checkoutSession.mode === "timed" && canEditSessionTiming && (
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
          {!isHopMode && (
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
          )}
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
                  value={replacementItemForm.sellableOptionId}
                  onChange={(event) => setReplacementItemForm((previous) => ({ ...previous, sellableOptionId: event.target.value }))}
                >
                  <option value="">Select item</option>
                  {sellableInventoryOptions
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name} - {currency(option.price)} - {getSellableOptionPickerDetail(option)}
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
                <SellableInventoryPicker
                  options={sellableInventoryOptions}
                  value={sessionItemForm[checkoutSession.id]?.sellableOptionId ?? ""}
                  onChange={(optionId) =>
                    setSessionItemForm((previous) => ({
                      ...previous,
                      [checkoutSession.id]: {
                        ...previous[checkoutSession.id],
                        sellableOptionId: optionId,
                        quantity: previous[checkoutSession.id]?.quantity ?? 1,
                        sellAsPackOf: undefined
                      }
                    }))
                  }
                  getOptionDetail={(option) => getSellableOptionPickerDetail(option, checkoutSession.id)}
                  isOptionDisabled={(option) => isSellableOptionUnavailable(option, checkoutSession.id)}
                />
                {(() => {
                  const selectedOption = sellableOptionById.get(sessionItemForm[checkoutSession.id]?.sellableOptionId ?? "");
                  const selectedItem = selectedOption?.item;
                  if (!selectedOption?.isBaseItem || !selectedItem?.cigarettePack) return null;
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
                            sellableOptionId: p[checkoutSession.id]?.sellableOptionId ?? "",
                            quantity: p[checkoutSession.id]?.quantity ?? 1,
                            sellAsPackOf: e.target.value === "pack" ? packOf.size : undefined
                          }
                        }))
                      }
                    >
                      <option value="single">Single - {currency(selectedItem.price)}</option>
                      <option value="pack">Pack of {packOf.size} - {currency(packOf.packPrice)}</option>
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
                        sellableOptionId: p[checkoutSession.id]?.sellableOptionId ?? "",
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
                        {checkoutState.mode === "bill_replacement" && line.type === "inventory_item" && !line.comboApplicationId ? (
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
                          {line.type === "inventory_item" && !line.comboApplicationId ? (
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
                {checkoutPendingSettlementBills.map((bill) => (
                  <tr key={`previous-due-${bill.id}`} className="previous-due-line">
                    <td>
                      Previous due - {bill.billNumber}
                      {bill.customerName && <div className="muted">{bill.customerName}</div>}
                    </td>
                    <td>1</td>
                    <td>{currency(bill.amountDue)}</td>
                    <td><span className="muted">-</span></td>
                    <td><span className="muted">Old pending bill</span></td>
                    <td><strong className="pending-amount">{currency(bill.amountDue)}</strong></td>
                    {checkoutState.mode === "bill_replacement" && <td><span className="muted">Fixed</span></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-grid three-columns">
            <label><span>Bill Discount Type</span><select value={checkoutState.billDiscount?.type ?? "amount"} onChange={(event) => setCheckoutState((p) => p ? { ...p, billDiscount: { type: event.target.value as DiscountType, value: p.billDiscount?.value ?? 0, reason: p.billDiscount?.reason ?? "" } } : p)}><option value="amount">Amount</option><option value="percentage">%</option></select></label>
            <label><span>Bill Discount Value</span><NumericInput mode="decimal" min={0} value={checkoutState.billDiscount?.value ?? 0} onValueChange={(value) => setCheckoutState((p) => p ? { ...p, billDiscount: { type: p.billDiscount?.type ?? "amount", value, reason: p.billDiscount?.reason ?? "" } } : p)} /></label>
            <label><span>Bill Discount Reason</span><input value={checkoutState.billDiscount?.reason ?? ""} onChange={(event) => setCheckoutState((p) => p ? { ...p, billDiscount: { type: p.billDiscount?.type ?? "amount", value: p.billDiscount?.value ?? 0, reason: event.target.value } } : p)} /></label>
          </div>
          <div className="checkout-summary">
            <div><span className="muted">Subtotal</span><strong>{checkoutSummaryCurrency(checkoutPreview.subtotal)}</strong></div>
            <div><span className="muted">Line Discounts</span><strong>{checkoutSummaryCurrency(checkoutPreview.lineDiscountAmount)}</strong></div>
            <div><span className="muted">Bill Discount</span><strong>{checkoutSummaryCurrency(checkoutPreview.billDiscountAmount)}</strong></div>
            <div><span className="muted">Round Off</span><strong>{currency(checkoutPreview.roundOffAmount)}</strong></div>
            <div><span className="muted">Total</span><strong>{checkoutSummaryCurrency(checkoutPreview.total)}</strong></div>
            {checkoutState.paymentMode === "split" && (
              <>
                <div><span className="muted">Cash</span><strong>{checkoutSummaryCurrency(checkoutState.splitCashAmount)}</strong></div>
                <div><span className="muted">UPI</span><strong>{checkoutSummaryCurrency(checkoutState.splitUpiAmount)}</strong></div>
              </>
            )}
            {checkoutState.paymentMode === "deferred" && (
              <>
                <div><span className="muted">Collecting Now</span><strong>{checkoutSummaryCurrency(checkoutState.collectAmount)}</strong></div>
                <div><span className="muted pending-amount">Amount Due Later</span><strong className="pending-amount">{checkoutSummaryCurrency(Math.max(0, checkoutPreview.total - checkoutState.collectAmount))}</strong></div>
              </>
            )}
            {checkoutPendingSettlementAmount > 0 && (
              <div>
                <span className="muted">Previous Dues Collection</span>
                <strong className="pending-amount">{currency(checkoutPendingSettlementAmount)}</strong>
              </div>
            )}
            {checkoutPendingSettlementAmount > 0 && (
              <div>
                <span className="muted">Total Payable Today</span>
                <strong>{currency(checkoutPreview.total + checkoutPendingSettlementAmount)}</strong>
              </div>
            )}
          </div>
          {checkoutRetryableHopMutation && (
            <div className="inline-sync-warning">
              The previous hop attempt was not confirmed. No further retries will run automatically.
            </div>
          )}
          {checkoutHasPendingOperational && (
            <div className="inline-sync-warning">Pending live changes are still syncing. Billing will unlock after sync completes.</div>
          )}
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => {
              if (checkoutRetryableHopMutation) {
                discardOperationalMutation(checkoutRetryableHopMutation.id);
                setIsHopMode(false);
                setRemoteError("");
                return;
              }
              if (checkoutSession?.closeDisposition === "hopped") {
                returnToStartNextGame();
              } else {
                setCheckoutState(null);
                setIsHopMode(false);
                setReplacementItemForm({ sellableOptionId: "", quantity: 1 });
              }
            }}>
              {checkoutRetryableHopMutation
                ? "Cancel Hop & Bill"
                : checkoutSession?.closeDisposition === "hopped"
                  ? "Start New Game Instead"
                  : "Cancel"}
            </button>
            {isHopMode ? (
              <button
                className="primary-button"
                type="button"
                onClick={() => void runBlockingAction("Closing session for game hop...", hopSession)}
                disabled={remoteSaving || Boolean(blockingActionLabel) || checkoutHasPendingOperational}
              >
                {checkoutRetryableHopMutation ? "Retry Game Hop" : "Confirm Game Hop"}
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                onClick={() =>
                  void runBlockingAction(
                    checkoutState.mode === "bill_replacement" ? "Issuing replacement bill..." : "Issuing bill...",
                    finalizeCheckout
                  )
                }
                disabled={remoteSaving || Boolean(blockingActionLabel) || checkoutPreview.isZeroTotal || checkoutHasPendingOperational}
                title={
                  checkoutHasPendingOperational
                    ? "Pending live changes are still syncing"
                    : checkoutPreview.isZeroTotal
                      ? "Bill total is Rs 0 - add items or remove discounts"
                      : undefined
                }
              >
                {checkoutState.mode === "bill_replacement" ? "Issue Replacement Bill" : "Issue Bill"}
              </button>
            )}
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
        const settlementBillIds = settlementDraft.billIds?.length ? settlementDraft.billIds : settlementDraft.billId ? [settlementDraft.billId] : [];
        const pendingBillsToSettle = settlementBillIds
          .map((billId) => appData.bills.find((b) => b.id === billId))
          .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending" && bill.amountDue > 0));
        if (pendingBillsToSettle.length === 0) return null;
        const settlementDue = sumBy(pendingBillsToSettle, (bill) => bill.amountDue);
        const settlementPaid = sumBy(pendingBillsToSettle, (bill) => bill.amountPaid);
        const settlementBillValue = sumBy(pendingBillsToSettle, (bill) => bill.total);
        const settlementTitle = pendingBillsToSettle.length === 1
          ? `Settle Bill - ${pendingBillsToSettle[0].billNumber}`
          : `Settle ${pendingBillsToSettle.length} Pending Bills`;
        const settlementTotal = getSettlementAmount(settlementDraft);
        return (
          <Modal title={settlementTitle} onClose={() => setSettlementDraft(null)}>
            <div className="form-grid">
              <div className="field-span-full checkout-summary">
                <div><span className="muted">Bill Value</span><strong>{currency(settlementBillValue)}</strong></div>
                <div><span className="muted">Already Paid</span><strong>{currency(settlementPaid)}</strong></div>
                <div><span className="muted pending-amount">Selected Due</span><strong className="pending-amount">{currency(settlementDue)}</strong></div>
              </div>
              {pendingBillsToSettle.length > 1 && (
                <div className="field-span-full activity-list compact-list">
                  {pendingBillsToSettle.map((bill) => (
                    <div key={bill.id} className="activity-row">
                      <strong>{bill.billNumber}</strong>
                      <span className="pending-amount">{currency(bill.amountDue)} due</span>
                    </div>
                  ))}
                </div>
              )}
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
                    onClick={() => setSettlementDraft((p) => p ? (p.paymentMode === "cash" ? { ...p, cashAmount: settlementDue } : { ...p, upiAmount: settlementDue }) : p)}
                  >
                    Pay Full Amount ({currency(settlementDue)})
                  </button>
                </div>
              )}
              {settlementTotal > settlementDue && <div className="error-text field-span-full">Settlement amount exceeds selected due.</div>}
            </div>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={() => setSettlementDraft(null)}>Cancel</button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  void settlePayment(settlementDraft).then((saved) => {
                    if (saved) setSettlementDraft(null);
                  });
                }}
                disabled={settlementTotal <= 0 || settlementTotal > settlementDue}
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
          <Modal title={`Write Off Bad Debt - ${pendingBill.billNumber}`} onClose={() => setVoidPendingDraft(null)}>
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
                onClick={() => {
                  void voidPendingBill(voidPendingDraft).then((saved) => {
                    if (saved) setVoidPendingDraft(null);
                  });
                }}
                disabled={!voidPendingDraft.reason.trim()}
              >
                Write Off
              </button>
            </div>
          </Modal>
        );
      })()}
      {voidPendingGroupDraft && (() => {
        const pendingBillsToVoid = voidPendingGroupDraft.billIds
          .map((billId) => appData.bills.find((b) => b.id === billId))
          .filter((bill): bill is Bill => Boolean(bill && bill.status === "pending"));
        if (pendingBillsToVoid.length === 0) return null;
        const amountToWriteOff = sumBy(pendingBillsToVoid, (bill) => bill.amountDue);
        return (
          <Modal title={`Write Off ${pendingBillsToVoid.length} Pending Bill${pendingBillsToVoid.length !== 1 ? "s" : ""}`} onClose={() => setVoidPendingGroupDraft(null)}>
            <div className="form-grid">
              <div className="field-span-full checkout-summary">
                <div><span className="muted">Customer</span><strong>{voidPendingGroupDraft.customerLabel}</strong></div>
                <div><span className="muted pending-amount">Amount to Write Off</span><strong className="pending-amount">{currency(amountToWriteOff)}</strong></div>
              </div>
              <div className="field-span-full activity-list compact-list">
                {pendingBillsToVoid.map((bill) => (
                  <div key={bill.id} className="activity-row">
                    <strong>{bill.billNumber}</strong>
                    <span className="pending-amount">{currency(bill.amountDue)} due</span>
                  </div>
                ))}
              </div>
              <label className="field-span-full">
                <span>Reason</span>
                <input
                  value={voidPendingGroupDraft.reason}
                  placeholder="Reason for writing off this debt"
                  onChange={(event) => setVoidPendingGroupDraft((p) => p ? { ...p, reason: event.target.value } : p)}
                />
              </label>
            </div>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={() => setVoidPendingGroupDraft(null)}>Cancel</button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  void voidPendingBills(voidPendingGroupDraft).then((saved) => {
                    if (saved) setVoidPendingGroupDraft(null);
                  });
                }}
                disabled={!voidPendingGroupDraft.reason.trim()}
              >
                Write Off Selected
              </button>
            </div>
          </Modal>
        );
      })()}
      {voidRefundDraft && (() => {
        const targetBill = appData.bills.find((bill) => bill.id === voidRefundDraft.billId);
        if (!targetBill || targetBill.status !== "issued") return null;
        const isRefund = voidRefundDraft.action === "refund";
        return (
          <Modal title={`Void or Refund - ${targetBill.billNumber}`} onClose={() => setVoidRefundDraft(null)}>
            <div className="form-grid">
              <div className="field-span-full checkout-summary">
                <div><span className="muted">Bill Total</span><strong>{currency(targetBill.total)}</strong></div>
                <div><span className="muted">Paid</span><strong>{currency(targetBill.amountPaid)}</strong></div>
              </div>
              <label>
                <span>Action</span>
                <select
                  aria-label="Void or refund action"
                  value={voidRefundDraft.action}
                  onChange={(event) => setVoidRefundDraft((draft) => draft ? { ...draft, action: event.target.value as "void" | "refund" } : draft)}
                >
                  <option value="void">Void</option>
                  <option value="refund">Refund</option>
                </select>
              </label>
              <label className="field-span-full">
                <span>Reason</span>
                <input
                  value={voidRefundDraft.reason}
                  placeholder={`Reason for ${isRefund ? "refunding" : "voiding"} this bill`}
                  onChange={(event) => setVoidRefundDraft((draft) => draft ? { ...draft, reason: event.target.value } : draft)}
                />
              </label>
            </div>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={() => setVoidRefundDraft(null)}>Cancel</button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  void submitVoidOrRefundBill().then((saved) => {
                    if (saved) setVoidRefundDraft(null);
                  });
                }}
                disabled={!voidRefundDraft.reason.trim()}
              >
                Confirm {isRefund ? "Refund" : "Void"}
              </button>
            </div>
          </Modal>
        );
      })()}
      {pendingWarningDraft && (
        <Modal title="Outstanding Pending Bills" onClose={() => setPendingWarningDraft(null)}>
          <p>
            <strong>{pendingWarningDraft.customerLabel}</strong> has {pendingWarningDraft.pendingBills.length} pending bill{pendingWarningDraft.pendingBills.length !== 1 ? "s" : ""} with an outstanding balance of{" "}
            <strong className="pending-amount">{currency(sumBy(pendingWarningDraft.pendingBills, (bill) => bill.amountDue))}</strong>:
          </p>
          <div className="activity-list" style={{ marginBottom: "1rem" }}>
            {pendingWarningDraft.pendingBills.map((b) => (
              <div key={b.id} className="activity-row">
                <strong>{b.billNumber}</strong>
                <span className="pending-amount">{currency(b.amountDue)} due</span>
              </div>
            ))}
          </div>
          <div className="button-row">
            <button
              className="secondary-button"
              type="button"
              onClick={viewPendingBillsForWarning}
            >
              View Bills
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                const { intent } = pendingWarningDraft;
                setPendingWarningDraft(null);
                if (intent.type === "session") {
                  doStartSessionDirect(intent.draftValue);
                } else {
                  doCommitTabDirect(intent.draftValue, intent.options);
                }
              }}
            >
              Continue Anyway
            </button>
          </div>
        </Modal>
      )}
      {blockingActionLabel && <LoadingOverlay label={blockingActionLabel} />}
    </div>
  );
}
