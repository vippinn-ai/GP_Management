import { estimateJsonBytes } from "./syncTelemetry";

export const CHECKOUT_TELEMETRY_STORAGE_KEY = "game-parlour-management-system/checkout-telemetry/v1";
const MAX_STORED_CHECKOUT_TELEMETRY_SAMPLES = 100;

export type CheckoutTelemetryStage = "precheck_snapshot" | "financial_rpc" | "checkout_total";
export type CheckoutTelemetryStatus = "success" | "error";

export interface CheckoutTelemetrySample {
  id: string;
  stage: CheckoutTelemetryStage;
  createdAt: string;
  mode?: string;
  entityId?: string;
  billNumber?: string;
  durationMs: number;
  status: CheckoutTelemetryStatus;
  payloadBytes?: number;
  appStateVersion?: number;
  serverDurationMs?: number;
  skippedFullSnapshot?: boolean;
  errorMessage?: string;
}

declare global {
  interface Window {
    __GP_CHECKOUT_TELEMETRY__?: {
      getSamples: () => CheckoutTelemetrySample[];
      clear: () => void;
      storageKey: string;
    };
  }
}

function createTelemetryId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `checkout-${crypto.randomUUID()}`;
  }
  return `checkout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function estimateCheckoutPayloadBytes(value: unknown) {
  return estimateJsonBytes(value);
}

export function readStoredCheckoutTelemetrySamples(): CheckoutTelemetrySample[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(CHECKOUT_TELEMETRY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as CheckoutTelemetrySample[];
    return Array.isArray(parsed) ? parsed.filter((sample) => sample.id && sample.stage) : [];
  } catch {
    return [];
  }
}

export function clearStoredCheckoutTelemetrySamples() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(CHECKOUT_TELEMETRY_STORAGE_KEY);
  } catch {
    // Best-effort diagnostics only.
  }
}

function ensureDebugApi() {
  if (typeof window === "undefined" || window.__GP_CHECKOUT_TELEMETRY__) {
    return;
  }
  window.__GP_CHECKOUT_TELEMETRY__ = {
    getSamples: readStoredCheckoutTelemetrySamples,
    clear: clearStoredCheckoutTelemetrySamples,
    storageKey: CHECKOUT_TELEMETRY_STORAGE_KEY
  };
}

export function recordCheckoutTelemetrySample(
  params: Omit<CheckoutTelemetrySample, "id" | "createdAt"> & { completedAt?: number }
) {
  if (typeof window === "undefined") {
    return;
  }
  ensureDebugApi();
  const { completedAt = Date.now(), ...sample } = params;
  const nextSample: CheckoutTelemetrySample = {
    ...sample,
    id: createTelemetryId(),
    createdAt: new Date(completedAt).toISOString(),
    durationMs: Math.max(0, Math.round(sample.durationMs))
  };
  try {
    const nextSamples = [nextSample, ...readStoredCheckoutTelemetrySamples()].slice(0, MAX_STORED_CHECKOUT_TELEMETRY_SAMPLES);
    window.localStorage.setItem(CHECKOUT_TELEMETRY_STORAGE_KEY, JSON.stringify(nextSamples));
  } catch {
    // Telemetry must never interrupt checkout.
  }
}
