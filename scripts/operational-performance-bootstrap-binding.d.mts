export interface AppStateIdentity {
  version: number;
  bytes: number;
  md5: string;
  updated_at: string;
  updated_by: string | null;
}

export interface BootstrapPerformanceBindingInput {
  manifest: Record<string, any>;
  manifestSha256: string;
  verification: Record<string, any>;
  scaleFixtureVerification: { appStateAfter?: AppStateIdentity };
  dataset: Record<string, any>;
  stagingProjectRef: string;
}

export function assertBootstrapPerformanceBinding(input: BootstrapPerformanceBindingInput): void;
