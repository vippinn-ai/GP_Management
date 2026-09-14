export interface OperationalPerformanceHarnessFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface OperationalPerformanceHarnessIdentity {
  schemaVersion: 1;
  files: OperationalPerformanceHarnessFile[];
  sha256: string;
}

export const OPERATIONAL_PERFORMANCE_HARNESS_FILES: readonly string[];

export function buildOperationalPerformanceHarnessIdentity(
  root: string,
  files?: readonly string[]
): OperationalPerformanceHarnessIdentity;

export function assertMatchingOperationalPerformanceHarness(
  baselineHarness: unknown,
  currentHarness: OperationalPerformanceHarnessIdentity
): void;
