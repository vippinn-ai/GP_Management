export interface CriticalResourceTiming {
  requestKey: string;
  path: string;
  api: boolean;
  shell: boolean;
  javascript: boolean;
  startTime: number;
  responseStart: number;
  responseEnd: number;
  transferSize: number;
}

export interface WebVitalsEvidence {
  largestContentfulPaintMs: number;
  largestContentfulPaintElement: string;
  largestContentfulPaintResourcePath: string;
  largestContentfulPaintSize: number;
  largestContentfulPaintRenderTimeMs: number;
  largestContentfulPaintLoadTimeMs: number;
  largestContentfulPaintElementPresent: boolean;
  largestContentfulPaintSource: "text" | "resource" | "unknown";
  firstContentfulPaintMs: number;
  cumulativeLayoutShift: number;
}

export const INVENTORY_RENDER_POLL_INTERVAL_MS = 25;
export const CRITICAL_RESOURCE_TIMING_SETTLE_TIMEOUT_MS = 1_000;

export interface CriticalResponseTiming {
  requestKey: string;
  path: string;
  status: number;
}

export interface ResourceTimingPhases {
  totalMs: number;
  fetchToFirstByteMs: number;
  downloadMs: number;
}

export function assertCompatiblePerformanceMetricVersion(actual: unknown, expected: number): void {
  if (!Number.isInteger(expected) || expected <= 0 || actual !== expected) {
    throw new Error(`Performance baseline metric version ${String(actual)} is incompatible with required version ${String(expected)}.`);
  }
}

export interface CriticalEvidenceSelection<
  TResource extends CriticalResourceTiming,
  TResponse extends CriticalResponseTiming
> {
  criticalResources: TResource[];
  criticalResponses: TResponse[];
  errors: string[];
}

export interface VisibleReadyObserverOptions {
  markName: string;
  headingText: string;
}

export function installVisibleReadyObserver(options: VisibleReadyObserverOptions): void {
  const { markName, headingText } = options;
  let frameId: number | null = null;
  let observer: MutationObserver | null = null;

  const alreadyMarked = () => performance.getEntriesByName(markName, "mark").length > 0;
  const findVisibleHeading = () => Array.from(document.querySelectorAll("h1, h2, h3")).find((element) => {
    if (element.textContent?.trim() !== headingText) return false;
    const style = globalThis.getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && bounds.width > 0
      && bounds.height > 0;
  });
  const inspect = () => {
    frameId = null;
    if (alreadyMarked() || !findVisibleHeading()) return;
    performance.mark(markName);
    observer?.disconnect();
  };
  const scheduleInspection = () => {
    if (alreadyMarked() || frameId !== null) return;
    frameId = globalThis.requestAnimationFrame(inspect);
  };

  observer = new MutationObserver(scheduleInspection);
  observer.observe(document, { childList: true, subtree: true, attributes: true });
  document.addEventListener("DOMContentLoaded", scheduleInspection, { once: true });
  scheduleInspection();
}

export function installWebVitalsObserver(): void {
  type BrowserVitalsTarget = typeof globalThis & {
    __BP_WEB_VITALS__?: WebVitalsEvidence;
    __BP_STARTUP_WEB_VITALS__?: WebVitalsEvidence;
    __BP_FREEZE_STARTUP_WEB_VITALS__?: (boundaryMs: number) => WebVitalsEvidence;
  };
  type LcpEntry = PerformanceEntry & {
    element?: Element;
    url?: string;
    size?: number;
    renderTime?: number;
    loadTime?: number;
  };

  const target = globalThis as BrowserVitalsTarget;
  const current: WebVitalsEvidence = {
    largestContentfulPaintMs: 0,
    largestContentfulPaintElement: "",
    largestContentfulPaintResourcePath: "",
    largestContentfulPaintSize: 0,
    largestContentfulPaintRenderTimeMs: 0,
    largestContentfulPaintLoadTimeMs: 0,
    largestContentfulPaintElementPresent: false,
    largestContentfulPaintSource: "unknown",
    firstContentfulPaintMs: 0,
    cumulativeLayoutShift: 0
  };
  const lcpEntries: WebVitalsEvidence[] = [];
  let startupBoundaryMs: number | null = null;

  const describeLcp = (entry: LcpEntry): WebVitalsEvidence => {
    let resourcePath = "";
    if (entry.url) {
      try {
        const url = new URL(entry.url);
        resourcePath = `${url.hostname}${url.pathname}`;
      } catch {
        resourcePath = "";
      }
    }
    const safeToken = (value: string) => /^[a-z][a-z0-9_-]{0,63}$/i.test(value) ? value : "";
    const tagName = entry.element ? safeToken(entry.element.tagName.toLowerCase()) : "";
    const elementId = entry.element?.id ? safeToken(entry.element.id) : "";
    const classNames = entry.element
      ? [...entry.element.classList].map(safeToken).filter(Boolean).slice(0, 3)
      : [];
    const elementDescription = tagName
      ? `${tagName}${elementId ? `#${elementId}` : ""}${classNames.map((value) => `.${value}`).join("")}`
      : "";
    return {
      largestContentfulPaintMs: entry.startTime,
      largestContentfulPaintElement: elementDescription,
      largestContentfulPaintResourcePath: resourcePath,
      largestContentfulPaintSize: Number.isFinite(entry.size) && (entry.size ?? -1) >= 0 ? entry.size! : 0,
      largestContentfulPaintRenderTimeMs: Number.isFinite(entry.renderTime) && (entry.renderTime ?? -1) >= 0 ? entry.renderTime! : 0,
      largestContentfulPaintLoadTimeMs: Number.isFinite(entry.loadTime) && (entry.loadTime ?? -1) >= 0 ? entry.loadTime! : 0,
      largestContentfulPaintElementPresent: Boolean(elementDescription),
      largestContentfulPaintSource: resourcePath ? "resource" : elementDescription ? "text" : "unknown",
      firstContentfulPaintMs: current.firstContentfulPaintMs,
      cumulativeLayoutShift: current.cumulativeLayoutShift
    };
  };
  const latestAtOrBefore = (boundaryMs: number) => lcpEntries
    .filter((entry) => Number.isFinite(entry.largestContentfulPaintMs) && entry.largestContentfulPaintMs <= boundaryMs)
    .sort((left, right) => right.largestContentfulPaintMs - left.largestContentfulPaintMs)[0];
  const refreshStartupSnapshot = () => {
    if (startupBoundaryMs === null) return;
    const latest = latestAtOrBefore(startupBoundaryMs);
    target.__BP_STARTUP_WEB_VITALS__ = latest
      ? { ...latest, firstContentfulPaintMs: current.firstContentfulPaintMs, cumulativeLayoutShift: current.cumulativeLayoutShift }
      : {
          ...current,
          largestContentfulPaintMs: 0,
          largestContentfulPaintElement: "",
          largestContentfulPaintResourcePath: "",
          largestContentfulPaintSize: 0,
          largestContentfulPaintRenderTimeMs: 0,
          largestContentfulPaintLoadTimeMs: 0,
          largestContentfulPaintElementPresent: false,
          largestContentfulPaintSource: "unknown"
        };
  };
  const recordLcpEntries = (entries: PerformanceEntry[]) => {
    for (const raw of entries) {
      const entry = raw as LcpEntry;
      if (!Number.isFinite(entry.startTime) || entry.startTime < 0) continue;
      const snapshot = describeLcp(entry);
      lcpEntries.push(snapshot);
      if (entry.startTime >= current.largestContentfulPaintMs) Object.assign(current, snapshot);
    }
    refreshStartupSnapshot();
  };

  target.__BP_WEB_VITALS__ = current;
  const lcpObserver = new PerformanceObserver((list) => recordLcpEntries(list.getEntries()));
  lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    const firstContentfulPaint = list.getEntries().find((entry) => entry.name === "first-contentful-paint");
    if (firstContentfulPaint && Number.isFinite(firstContentfulPaint.startTime) && firstContentfulPaint.startTime >= 0) {
      current.firstContentfulPaintMs = firstContentfulPaint.startTime;
      refreshStartupSnapshot();
    }
  }).observe({ type: "paint", buffered: true });
  target.__BP_FREEZE_STARTUP_WEB_VITALS__ = (boundaryMs: number) => {
    startupBoundaryMs = Number.isFinite(boundaryMs) && boundaryMs >= 0 ? boundaryMs : null;
    recordLcpEntries(lcpObserver.takeRecords());
    refreshStartupSnapshot();
    return { ...(target.__BP_STARTUP_WEB_VITALS__ ?? current) };
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!shift.hadRecentInput) current.cumulativeLayoutShift += shift.value ?? 0;
    }
  }).observe({ type: "layout-shift", buffered: true });
}

export function freezeStartupWebVitals(boundaryMs: number): WebVitalsEvidence {
  const target = globalThis as typeof globalThis & {
    __BP_WEB_VITALS__?: WebVitalsEvidence;
    __BP_STARTUP_WEB_VITALS__?: WebVitalsEvidence;
    __BP_FREEZE_STARTUP_WEB_VITALS__?: (boundary: number) => WebVitalsEvidence;
  };
  const empty: WebVitalsEvidence = {
    largestContentfulPaintMs: 0,
    largestContentfulPaintElement: "",
    largestContentfulPaintResourcePath: "",
    largestContentfulPaintSize: 0,
    largestContentfulPaintRenderTimeMs: 0,
    largestContentfulPaintLoadTimeMs: 0,
    largestContentfulPaintElementPresent: false,
    largestContentfulPaintSource: "unknown",
    firstContentfulPaintMs: 0,
    cumulativeLayoutShift: 0
  };
  if (!Number.isFinite(boundaryMs) || boundaryMs < 0) return empty;
  return target.__BP_FREEZE_STARTUP_WEB_VITALS__?.(boundaryMs) ?? empty;
}

export function requestStartedByBrowserMark(
  requestStartEpochMs: number,
  pageTimeOriginEpochMs: number,
  safeInteractiveMarkMs: number
): boolean | null {
  if (
    !Number.isFinite(requestStartEpochMs)
    || requestStartEpochMs <= 0
    || !Number.isFinite(pageTimeOriginEpochMs)
    || pageTimeOriginEpochMs <= 0
    || !Number.isFinite(safeInteractiveMarkMs)
    || safeInteractiveMarkMs < 0
  ) return null;
  return requestStartEpochMs <= pageTimeOriginEpochMs + safeInteractiveMarkMs;
}

export function measureResourceTimingPhases(
  resource: Pick<CriticalResourceTiming, "startTime" | "responseStart" | "responseEnd">
): ResourceTimingPhases | null {
  if (
    !Number.isFinite(resource.startTime)
    || resource.startTime < 0
    || !Number.isFinite(resource.responseStart)
    || resource.responseStart < resource.startTime
    || !Number.isFinite(resource.responseEnd)
    || resource.responseEnd < resource.responseStart
  ) return null;
  return {
    totalMs: resource.responseEnd - resource.startTime,
    fetchToFirstByteMs: resource.responseStart - resource.startTime,
    downloadMs: resource.responseEnd - resource.responseStart
  };
}

export async function requestStartedByBrowserMarkAfterCompletion(
  readRequestStartEpochMs: () => number,
  completion: Promise<void>,
  pageTimeOriginEpochMs: number,
  safeInteractiveMarkMs: number
): Promise<boolean | null> {
  const initial = requestStartedByBrowserMark(
    readRequestStartEpochMs(),
    pageTimeOriginEpochMs,
    safeInteractiveMarkMs
  );
  if (initial !== null) return initial;
  await completion;
  return requestStartedByBrowserMark(
    readRequestStartEpochMs(),
    pageTimeOriginEpochMs,
    safeInteractiveMarkMs
  );
}

export function missingExpectedCriticalResourceKeys(
  resources: ReadonlyArray<Pick<CriticalResourceTiming, "requestKey">>,
  expectedCriticalRequestKeys: ReadonlySet<string>
): string[] {
  const observedKeys = new Set(resources.map((entry) => entry.requestKey));
  return [...expectedCriticalRequestKeys].filter((requestKey) => !observedKeys.has(requestKey));
}

export function selectCriticalEvidence<
  TResource extends CriticalResourceTiming,
  TResponse extends CriticalResponseTiming
>(
  resources: TResource[],
  responses: TResponse[],
  safeInteractiveMarkMs: number,
  expectedCriticalRequestKeys: ReadonlySet<string> = new Set()
): CriticalEvidenceSelection<TResource, TResponse> {
  const errors: string[] = [];
  if (!Number.isFinite(safeInteractiveMarkMs) || safeInteractiveMarkMs < 0) {
    return { criticalResources: [], criticalResponses: [], errors: ["Safe-interactive browser mark is invalid."] };
  }

  const validResources = resources.filter((entry) => {
    const timingValid = Number.isFinite(entry.startTime)
      && entry.startTime >= 0
      && Number.isFinite(entry.responseEnd)
      && entry.responseEnd >= entry.startTime
      && Number.isFinite(entry.transferSize)
      && entry.transferSize >= 0;
    if (!timingValid) errors.push(`Resource ${entry.requestKey} has invalid browser timing or transfer evidence.`);
    return timingValid;
  });
  const criticalResources = validResources.filter((entry) => entry.startTime <= safeInteractiveMarkMs);
  const criticalKeys = new Set(criticalResources.filter((entry) => entry.api || entry.shell).map((entry) => entry.requestKey));
  const resourceCounts = new Map<string, number>();
  criticalResources.forEach((entry) => resourceCounts.set(entry.requestKey, (resourceCounts.get(entry.requestKey) ?? 0) + 1));
  const responseCounts = new Map<string, number>();
  responses.forEach((entry) => responseCounts.set(entry.requestKey, (responseCounts.get(entry.requestKey) ?? 0) + 1));

  for (const resource of criticalResources.filter((entry) => entry.api || entry.shell)) {
    const count = responseCounts.get(resource.requestKey) ?? 0;
    if (count !== 1) errors.push(`Critical resource ${resource.requestKey} has ${count} correlated responses.`);
  }
  for (const [requestKey, count] of responseCounts) {
    if (count > 1) errors.push(`Response correlation key ${requestKey} is duplicated ${count} times.`);
  }
  for (const [requestKey, count] of resourceCounts) {
    if (count > 1) errors.push(`Resource correlation key ${requestKey} is duplicated ${count} times.`);
  }
  for (const requestKey of expectedCriticalRequestKeys) {
    const resourceCount = resourceCounts.get(requestKey) ?? 0;
    const responseCount = responseCounts.get(requestKey) ?? 0;
    if (resourceCount !== 1) errors.push(`Expected critical request ${requestKey} has ${resourceCount} correlated resources.`);
    if (responseCount !== 1) errors.push(`Expected critical request ${requestKey} has ${responseCount} correlated responses.`);
  }

  return {
    criticalResources,
    criticalResponses: responses.filter((entry) => criticalKeys.has(entry.requestKey)),
    errors
  };
}

export function measureBootstrapDependencyDepth<TResource extends CriticalResourceTiming, TResponse extends CriticalResponseTiming>(
  resources: TResource[],
  responses: TResponse[]
): number | null {
  const operationalBootstrapPath = /\/rest\/v1\/rpc\/load_operational_bootstrap_v2$/;
  const atomicResources = resources.filter((entry) => entry.api && operationalBootstrapPath.test(entry.path));
  const atomicResponses = responses.filter((entry) => operationalBootstrapPath.test(entry.path));
  const atomicEvidencePresent = atomicResources.length > 0 || atomicResponses.length > 0;
  if (atomicEvidencePresent) {
    if (atomicResources.length !== 1 || atomicResponses.length !== 1) return null;
    const [atomicResource] = atomicResources;
    const [atomicResponse] = atomicResponses;
    if (
      atomicResource.requestKey !== atomicResponse.requestKey
      || atomicResponse.status < 200
      || atomicResponse.status >= 400
      || !Number.isFinite(atomicResource.startTime)
      || atomicResource.startTime < 0
      || !Number.isFinite(atomicResource.responseEnd)
      || atomicResource.responseEnd < atomicResource.startTime
    ) return null;
  }

  const statusEntries = new Map<string, number[]>();
  responses.forEach((entry) => statusEntries.set(entry.requestKey, [...(statusEntries.get(entry.requestKey) ?? []), entry.status]));
  const apiResources = resources
    .filter((entry) => {
      const statuses = statusEntries.get(entry.requestKey) ?? [];
      return entry.api
        && Number.isFinite(entry.startTime)
        && entry.startTime >= 0
        && Number.isFinite(entry.responseEnd)
        && entry.responseEnd >= entry.startTime
        && statuses.length === 1
        && statuses[0] >= 200
        && statuses[0] < 400;
    })
    .sort((left, right) => left.startTime - right.startTime);
  const anchor = atomicEvidencePresent
    ? apiResources.find((entry) => operationalBootstrapPath.test(entry.path))
    : apiResources.find((entry) => /\/rest\/v1\/organizations$/.test(entry.path));
  if (!anchor) return null;

  const bootstrapResources = apiResources.filter((entry) => entry.startTime + 2 >= anchor.startTime);
  const depths: number[] = [];
  bootstrapResources.forEach((_entry, index) => {
    let depth = 1;
    for (let previous = 0; previous < index; previous += 1) {
      if (bootstrapResources[previous].responseEnd <= bootstrapResources[index].startTime + 2) {
        depth = Math.max(depth, depths[previous] + 1);
      }
    }
    depths.push(depth);
  });
  return depths.length > 0 ? Math.max(...depths) : 0;
}

export function sumCriticalShellTransferBytes(resources: CriticalResourceTiming[]): number {
  return resources
    .filter((entry) => entry.shell)
    .reduce((total, entry) => total + entry.transferSize, 0);
}
