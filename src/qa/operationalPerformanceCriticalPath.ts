export interface CriticalResourceTiming {
  requestKey: string;
  path: string;
  api: boolean;
  shell: boolean;
  javascript: boolean;
  startTime: number;
  responseEnd: number;
  transferSize: number;
}

export const INVENTORY_RENDER_POLL_INTERVAL_MS = 25;
export const CRITICAL_RESOURCE_TIMING_SETTLE_TIMEOUT_MS = 1_000;

export interface CriticalResponseTiming {
  requestKey: string;
  path: string;
  status: number;
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
  const statuses = new Map(responses.map((entry) => [entry.requestKey, entry.status]));
  const apiResources = resources
    .filter((entry) => entry.api && (statuses.get(entry.requestKey) ?? 500) < 400)
    .sort((left, right) => left.startTime - right.startTime);
  const organization = apiResources.find((entry) => /\/rest\/v1\/organizations$/.test(entry.path));
  if (!organization) return null;

  const bootstrapResources = apiResources.filter((entry) => entry.startTime + 2 >= organization.startTime);
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
