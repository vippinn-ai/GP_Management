export function classifyComboRaceEvidence(evidence) {
  if (!evidence) return "not_started";
  const lifecycle = evidence.lifecycle ?? {};
  if (evidence.winner && evidence.sessionId && evidence.afterRace) return "completed";
  if (lifecycle.raceStarted || lifecycle.checkoutSubmitted || lifecycle.comboSubmitted) return "ambiguous";
  if (evidence.sessionId || lifecycle.sessionStarted) return "setup_only";
  return "not_started";
}

export function countComboRaceClassifications(entries) {
  return entries.reduce((counts, entry) => {
    const classification = classifyComboRaceEvidence(entry);
    counts[classification] = (counts[classification] ?? 0) + 1;
    return counts;
  }, {});
}

export function selectComboRaceEvidenceCandidate(candidates, runId, scenario) {
  const rejectedCandidates = [];
  for (const candidate of candidates) {
    let evidence;
    try {
      evidence = JSON.parse(candidate.content);
    } catch (error) {
      rejectedCandidates.push({
        artifactPath: candidate.artifactPath,
        reason: error instanceof Error ? `invalid_json: ${error.message}` : "invalid_json"
      });
      continue;
    }
    if (evidence?.runId !== runId || evidence?.scenario !== scenario) {
      rejectedCandidates.push({ artifactPath: candidate.artifactPath, reason: "identity_mismatch" });
      continue;
    }
    return {
      artifactPath: candidate.artifactPath,
      evidence,
      classification: classifyComboRaceEvidence(evidence),
      rejectedCandidates
    };
  }
  return {
    artifactPath: null,
    evidence: null,
    classification: "not_started",
    rejectedCandidates
  };
}
