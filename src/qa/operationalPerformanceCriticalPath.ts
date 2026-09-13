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

export function selectCriticalEvidence<
  TResource extends CriticalResourceTiming,
  TResponse extends CriticalResponseTiming
>(resources: TResource[], responses: TResponse[], safeInteractiveMarkMs: number): CriticalEvidenceSelection<TResource, TResponse> {
  const errors: string[] = [];
  if (!Number.isFinite(safeInteractiveMarkMs) || safeInteractiveMarkMs < 0) {
    return { criticalResources: [], criticalResponses: [], errors: ["Safe-interactive browser mark is invalid."] };
  }

  const criticalResources = resources.filter((entry) => entry.startTime <= safeInteractiveMarkMs);
  const criticalKeys = new Set(criticalResources.filter((entry) => entry.api || entry.shell).map((entry) => entry.requestKey));
  const responseCounts = new Map<string, number>();
  responses.forEach((entry) => responseCounts.set(entry.requestKey, (responseCounts.get(entry.requestKey) ?? 0) + 1));

  for (const resource of criticalResources.filter((entry) => entry.api || entry.shell)) {
    const count = responseCounts.get(resource.requestKey) ?? 0;
    if (count !== 1) errors.push(`Critical resource ${resource.requestKey} has ${count} correlated responses.`);
  }
  for (const [requestKey, count] of responseCounts) {
    if (count > 1) errors.push(`Response correlation key ${requestKey} is duplicated ${count} times.`);
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
