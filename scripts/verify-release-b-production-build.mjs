import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const productionProjectRef = "rrdwbxvuwrbxefarxnse";
const stagingProjectRef = "tkbdyzxwwbhkpztgjjxh";

function getArgument(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat().sort();
}

const files = await listFiles(distRoot);
const textFiles = files.filter((file) => /\.(?:html|js|css|json|txt)$/i.test(file));
const textBuffers = await Promise.all(textFiles.map((file) => readFile(file)));
const searchable = Buffer.concat(textBuffers).toString("utf8");
const javascriptFiles = files.filter((file) => /\.js$/i.test(file));
const largestJavascriptFile = (await Promise.all(javascriptFiles.map(async (file) => ({
  file,
  size: (await stat(file)).size
})))).sort((a, b) => b.size - a.size)[0];
const bundle = largestJavascriptFile ? await readFile(largestJavascriptFile.file) : Buffer.alloc(0);
const checks = {
  indexHtmlPresent: files.some((file) => path.relative(distRoot, file).replaceAll("\\", "/") === "index.html"),
  javascriptBundlePresent: javascriptFiles.length > 0,
  exactProductionProjectPresent: searchable.includes(productionProjectRef),
  stagingProjectAbsent: !searchable.includes(stagingProjectRef),
  checkoutV2Present: searchable.includes("commit_checkout_bill_v2"),
  adjustmentV2Present: searchable.includes("commit_financial_adjustment_v2"),
  mutationStatusLookupPresent: searchable.includes("get_financial_mutation_result")
};
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  productionProjectRef,
  productionAccessed: false,
  productionWritePerformed: false,
  secretValuesPrinted: false,
  fileCount: files.length,
  bundle: largestJavascriptFile ? {
    path: path.relative(projectRoot, largestJavascriptFile.file).replaceAll("\\", "/"),
    bytes: largestJavascriptFile.size,
    sha256: createHash("sha256").update(bundle).digest("hex")
  } : null,
  checks,
  failures,
  status: failures.length === 0 ? "passed" : "failed"
};

const serializedResult = `${JSON.stringify(result, null, 2)}\n`;
const evidenceOutput = getArgument("--evidence-output");
if (evidenceOutput) {
  const outputPath = path.resolve(projectRoot, evidenceOutput);
  const allowedRoot = path.join(projectRoot, "test-artifacts", "evidence") + path.sep;
  if (!outputPath.startsWith(allowedRoot)) {
    throw new Error("Build evidence output must stay under test-artifacts/evidence.");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializedResult, "utf8");
}
console.log(serializedResult.trimEnd());
if (failures.length > 0) process.exitCode = 1;
