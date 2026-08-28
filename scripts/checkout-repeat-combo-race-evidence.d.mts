export type ComboRaceClassification = "not_started" | "setup_only" | "ambiguous" | "completed";

export interface ComboRaceEvidence {
  winner?: string;
  sessionId?: string;
  afterRace?: unknown;
  lifecycle?: {
    sessionStarted?: boolean;
    raceStarted?: boolean;
    checkoutSubmitted?: boolean;
    comboSubmitted?: boolean;
    outcomeResolved?: boolean;
  };
}

export function classifyComboRaceEvidence(
  evidence: ComboRaceEvidence | null | undefined
): ComboRaceClassification;

export function countComboRaceClassifications(
  entries: Array<ComboRaceEvidence | null | undefined>
): Partial<Record<ComboRaceClassification, number>>;

export interface ComboRaceEvidenceCandidate {
  artifactPath: string;
  content: string;
}

export interface ComboRaceEvidenceSelection {
  artifactPath: string | null;
  evidence: (ComboRaceEvidence & { runId?: string; scenario?: string }) | null;
  classification: ComboRaceClassification;
  rejectedCandidates: Array<{ artifactPath: string; reason: string }>;
}

export function selectComboRaceEvidenceCandidate(
  candidates: ComboRaceEvidenceCandidate[],
  runId: string,
  scenario: string
): ComboRaceEvidenceSelection;
