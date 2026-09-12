import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const marker = "--run-id=";
const runId = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
if (!runId || !/^normops-\d{8}-\d{4}-db-proof-[a-z0-9-]+$/.test(runId)) {
  throw new Error("Use --run-id=normops-YYYYMMDD-HHMM-db-proof-<unique-suffix>.");
}
const sourcePath = path.join(root, "supabase", "operational-lifecycle-v2-transactional-proof.sql");
const source = fs.readFileSync(sourcePath, "utf8");
if (!source.includes("OPERATIONAL_LIFECYCLE_V2_TRANSACTIONAL_PROOF") || !source.trimEnd().endsWith("rollback;")) {
  throw new Error("Transactional proof lost its marker or terminal rollback.");
}
if (/\bcommit\s*;/i.test(source)) throw new Error("Transactional proof must never commit.");
const generated = source.replaceAll("__RUN_ID__", runId);
if (generated.includes("__RUN_ID__")) throw new Error("Transactional proof contains an unresolved run ID.");
const outputDirectory = path.join(root, "test-artifacts", "sql");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `${runId}-operational-v2-transactional-proof.sql`);
const manifestPath = path.join(outputDirectory, `${runId}-operational-v2-transactional-proof-manifest.json`);
if (fs.existsSync(outputPath) || fs.existsSync(manifestPath)) throw new Error("This proof run ID already has immutable artifacts.");
fs.writeFileSync(outputPath, generated, { encoding: "utf8", flag: "wx" });
const manifest = {
  runId,
  target: { environment: "staging", projectRef: "tkbdyzxwwbhkpztgjjxh", organizationId: "org-primary" },
  rollbackOnly: true,
  source: { path: path.relative(root, sourcePath), sha256: createHash("sha256").update(source).digest("hex") },
  artifact: { path: path.relative(root, outputPath), bytes: Buffer.byteLength(generated), sha256: createHash("sha256").update(generated).digest("hex") },
  createdAt: new Date().toISOString()
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, manifestPath, manifest }, null, 2) + "\n");
