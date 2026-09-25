export interface PerformanceEvidenceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export function collectPerformanceEvidenceFiles(root: string, entries: string[]): PerformanceEvidenceFile[];

export function assessPerformanceSampleEvidence(files: { path: string }[], sampleCount: number): {
  complete: boolean;
  missingTerminals: number[];
  samples: { sample: number; measurements: number; diagnostics: number; terminals: number }[];
};
