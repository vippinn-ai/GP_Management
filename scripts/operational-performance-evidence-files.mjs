import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Used after successful and failed runs alike. Hash exact bytes, including partial
// sample diagnostics; an absent optional aggregate never suppresses earlier files.
export function collectPerformanceEvidenceFiles(root, entries) {
  const files = [];
  const visit = (entryPath) => {
    if (!fs.existsSync(entryPath)) return;
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, name));
      return;
    }
    const bytes = fs.readFileSync(entryPath);
    files.push({ path: path.relative(root, entryPath), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
  for (const entry of entries) visit(entry);
  return files;
}

export function assessPerformanceSampleEvidence(files, sampleCount) {
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const sample = index + 1;
    const count = (kind) => files.filter((file) => path.basename(file.path) === `sample-${sample}-${kind}.json`).length;
    return { sample, measurements: count("measurement"), diagnostics: count("diagnostics"), terminals: count("terminal") };
  });
  return {
    complete: samples.every((entry) => entry.measurements === 1 && entry.diagnostics === 1 && entry.terminals === 1),
    // Missing means not recorded, not proof that the sample was attempted.
    missingTerminals: samples.filter((entry) => entry.terminals === 0).map((entry) => entry.sample),
    samples
  };
}
