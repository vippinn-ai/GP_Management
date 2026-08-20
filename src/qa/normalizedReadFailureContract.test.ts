import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("controlled normalized-read QA deployment contract", () => {
  it("wraps every intended screen reader and retry path", () => {
    const appSource = readRepositoryFile("src/App.tsx");

    expect(appSource.match(/runQaControlledNormalizedRead\("bill-history"/g)).toHaveLength(2);
    expect(appSource.match(/runQaControlledNormalizedRead\("reports"/g)).toHaveLength(2);
    expect(appSource.match(/runQaControlledNormalizedRead\("customers"/g)).toHaveLength(1);
    expect(appSource.match(/runQaControlledNormalizedRead\("inventory"/g)).toHaveLength(1);
  });

  it("binds the QA build to staging, v2-off, artifact checks, and the isolated Worker", () => {
    const verifySource = readRepositoryFile("scripts/verify-failclosed-qa.mjs");
    const buildScript = readRepositoryFile("scripts/build-failclosed-qa.cmd");
    const packageJson = JSON.parse(readRepositoryFile("package.json")) as { scripts: Record<string, string> };

    expect(packageJson.scripts["build:staging:failclosed-qa"]).toContain("scripts\\build-failclosed-qa.cmd");
    expect(packageJson.scripts["deploy:staging:failclosed-qa"]).toBe(
      "npm run build:staging:failclosed-qa && npx wrangler deploy --name gp-management-staging-failclosed-qa"
    );
    expect(verifySource).toContain('const STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh"');
    expect(verifySource).toContain('const PRODUCTION_PROJECT_REF = "rrdwbxvuwrbxefarxnse"');
    expect(verifySource).toContain('const QA_WORKER_NAME = "gp-management-staging-failclosed-qa"');
    expect(verifySource).toContain('VITE_BACKEND_FINANCIAL_RPC_V2 !== "false"');
    expect(verifySource).toContain("Object.prototype.hasOwnProperty.call(stagingEnv, qaOnlyFlag)");
    expect(verifySource).toContain("resolvedViteEnv[key] !== stagingEnv[key]");
    expect(verifySource).toContain("Object.prototype.hasOwnProperty.call(resolvedViteEnv, qaOnlyFlag)");
    expect(verifySource).toContain("!stagingEnv.VITE_SUPABASE_ANON_KEY?.trim()");
    expect(buildScript).toContain('set "VITE_QA_NORMALIZED_READ_FAILURES=true"');
    expect(buildScript).toContain('set "VITE_QA_FAIL_CLOSED_BUILD_ID=release-a-failclosed-qa-v1"');
    expect(buildScript).toContain('vite.cmd" build --mode staging --configLoader runner');
    expect(verifySource).toContain('QA_BUILD_ID_VALUE = "release-a-failclosed-qa-v1"');
    expect(verifySource).toContain("bundle.split(QA_BUILD_ID_VALUE).length - 1 < 2");
  });
});
