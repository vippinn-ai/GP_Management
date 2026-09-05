import { createHash } from "node:crypto";
import fs from "node:fs";

const origins = [
  { url: "https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/", envFile: ".env.staging" },
  { url: "https://management.breakperfectgaminglounge.workers.dev/", envFile: ".env.production" }
];

function readBuildEnv(filePath) {
  return Object.fromEntries(fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) return [];
    const splitAt = line.indexOf("=");
    let value = line.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [[line.slice(0, splitAt).trim(), value]];
  }));
}

const normalizedArtifacts = [];
for (const target of origins) {
  const origin = target.url;
  const shellResponse = await fetch(origin, { method: "GET", redirect: "error" });
  if (!shellResponse.ok) throw new Error(`Unable to read ${origin} (${shellResponse.status}).`);
  const shell = await shellResponse.text();
  const bundlePath = shell.match(/<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  if (!bundlePath) throw new Error(`Unable to identify the deployed bundle for ${origin}.`);
  const bundleUrl = new URL(bundlePath, origin);
  if (bundleUrl.origin !== new URL(origin).origin) throw new Error(`Bundle for ${origin} escaped its expected origin.`);
  const bundleResponse = await fetch(bundleUrl, { method: "GET", redirect: "error" });
  if (!bundleResponse.ok) throw new Error(`Unable to read ${bundleUrl.href} (${bundleResponse.status}).`);
  const bundle = await bundleResponse.text();
  const environmentSecrets = Object.entries(readBuildEnv(target.envFile)).filter(([key]) =>
    ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].includes(key)
  );
  const normalizedBundle = environmentSecrets.reduce(
    (content, [key, value]) => value ? content.split(value).join(`<${key}>`) : content,
    bundle
  );
  normalizedArtifacts.push({ origin, normalizedBundle });
  console.log(JSON.stringify({
    origin,
    bundlePath: bundleUrl.pathname,
    bytes: Buffer.byteLength(bundle),
    sha256: createHash("sha256").update(bundle).digest("hex"),
    normalizedBytes: Buffer.byteLength(normalizedBundle),
    normalizedSha256: createHash("sha256").update(normalizedBundle).digest("hex")
  }));
}

const [staging, production] = normalizedArtifacts;
let firstDifference = 0;
while (
  firstDifference < staging.normalizedBundle.length &&
  firstDifference < production.normalizedBundle.length &&
  staging.normalizedBundle[firstDifference] === production.normalizedBundle[firstDifference]
) firstDifference += 1;
const contextStart = Math.max(0, firstDifference - 80);
const contextEnd = firstDifference + 160;
console.log(JSON.stringify({
  normalizedBundlesEqual: staging.normalizedBundle === production.normalizedBundle,
  firstDifference,
  stagingContext: staging.normalizedBundle.slice(contextStart, contextEnd),
  productionContext: production.normalizedBundle.slice(contextStart, contextEnd)
}));
