import { sameAppStateIdentity } from "./json-value-equality.mjs";

export function assertBootstrapPerformanceBinding({
  manifest,
  manifestSha256,
  verification,
  scaleFixtureVerification,
  dataset,
  stagingProjectRef
}) {
  const payloadKeys = ["actorId", "bytes", "collectionCounts", "limitBytes", "marginBytes"];
  if (
    manifest?.environment !== "staging"
    || manifest?.projectRef !== stagingProjectRef
    || !/^[a-f0-9]{40}$/i.test(manifest?.sourceCommit ?? "")
    || !/^[a-f0-9]{64}$/i.test(manifestSha256 ?? "")
  ) {
    throw new Error("Candidate bootstrap database install manifest is not an exact staging source.");
  }
  if (
    verification?.projectRef !== stagingProjectRef
    || verification?.systemIdentifier !== manifest.systemIdentifier
    || verification?.runId !== manifest.runId
    || verification?.sourceCommit !== manifest.sourceCommit
    || verification?.manifestSha256 !== manifestSha256
    || verification?.appStateUnchanged !== true
    || verification?.incompleteMutations !== 0
    || verification?.cleanPreflightFloor !== true
    || verification?.installedFunctionBodyMd5 !== manifest.reviewedSql?.bodyMd5
    || !verification?.payload || typeof verification.payload !== "object" || Array.isArray(verification.payload)
    || JSON.stringify(Object.keys(verification.payload).sort()) !== JSON.stringify(payloadKeys)
    || !Number.isInteger(verification.payload.bytes)
    || verification.payload.bytes <= 0
    || verification.payload.bytes > 160_992
    || verification.payload?.limitBytes !== 160_992
    || verification.payload?.marginBytes !== 160_992 - verification.payload.bytes
  ) {
    throw new Error("Candidate bootstrap postflight verification is not an unchanged staging installation.");
  }
  if (!sameAppStateIdentity(verification.appState, scaleFixtureVerification?.appStateAfter)
    || !sameAppStateIdentity(verification.appState, dataset?.app_state)) {
    throw new Error("Candidate bootstrap postflight, active scale fixture, and dataset identities differ.");
  }
  const counts = verification.payload?.collectionCounts;
  const expectedKeys = [
    "combos", "customer_tabs", "inventory_categories", "inventory_items", "pricing_rules",
    "profiles", "sale_variants", "sessions", "stations"
  ];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(verification.payload?.actorId ?? "")
    || JSON.stringify(Object.keys(counts ?? {}).sort()) !== JSON.stringify(expectedKeys)
    || Object.values(counts ?? {}).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Candidate bootstrap payload actor or collection-count shape is invalid.");
  }
  const datasetCounts = {
    combos: dataset?.public_counts?.combos,
    customer_tabs: dataset?.open_customer_tabs,
    inventory_categories: dataset?.public_counts?.inventory_categories,
    inventory_items: dataset?.public_counts?.inventory_items,
    pricing_rules: dataset?.public_counts?.pricing_rules,
    sale_variants: dataset?.public_counts?.sale_variants,
    sessions: dataset?.open_sessions,
    stations: dataset?.public_counts?.stations
  };
  if (Object.entries(datasetCounts).some(([key, value]) => counts?.[key] !== value)) {
    throw new Error("Candidate bootstrap collection counts do not match the active performance dataset.");
  }
}
