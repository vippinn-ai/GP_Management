import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

function argument(name) {
  const marker = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(marker))?.slice(marker.length).trim();
  if (!value) throw new Error(`Missing required ${marker}<value> argument.`);
  return value;
}

const profileId = argument("profile-id");
if (!/^[a-z0-9][a-z0-9._-]{5,80}$/i.test(profileId)) throw new Error("Profile ID contains unsupported characters.");
const networkProfile = argument("network-profile");
const browser = await chromium.launch({ headless: true });
const expectedBrowserVersion = browser.version();
await browser.close();

const evidence = {
  schemaVersion: 1,
  profileId,
  capturedAt: new Date().toISOString(),
  hostFingerprint: createHash("sha256").update(`${os.hostname()}|${os.platform()}|${os.release()}|${os.arch()}`).digest("hex"),
  expectedBrowserVersion,
  viewport: { width: 1440, height: 900 },
  cachePolicy: "new-context-cold-cache-service-workers-blocked",
  networkProfile,
  requirement: "Run baseline and candidate consecutively on this host and unchanged network path."
};
const outputDirectory = path.join(process.cwd(), "test-artifacts", "operational-performance-profile");
const outputPath = path.join(outputDirectory, `${profileId}.json`);
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
const sha256 = createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
process.stdout.write(JSON.stringify({ outputPath, sha256, evidence }, null, 2) + "\n");
