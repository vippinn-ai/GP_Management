import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const legacyMainSource = readFileSync(resolve(process.cwd(), "src/main-legacy.tsx"), "utf8");
const viteSource = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
const syncSource = readFileSync(resolve(process.cwd(), "src/hooks/useAppSync.ts"), "utf8");

describe("atomic startup coordinator source contract", () => {
  it("starts one dynamic App import beside the shared bootstrap preparation", () => {
    expect(mainSource).not.toMatch(/import App from ["']\.\/App["']/);
    expect(mainSource.match(/const appModulePromise = import\(["']\.\/App["']\);/g)).toHaveLength(1);
    expect(mainSource).toContain("defaultRemoteDataGateway.prepareAuthenticatedBootstrap?.()");
    expect(mainSource.indexOf('import("./App")')).toBeLessThan(
      mainSource.indexOf("defaultRemoteDataGateway.prepareAuthenticatedBootstrap?.()")
    );
    expect(mainSource).toContain('markStartupPerformance("bp-app-module-requested")');
    expect(mainSource).toContain('markStartupPerformance("bp-app-module-ready")');
  });

  it("keeps the default-off build on the prior static application entry", () => {
    expect(legacyMainSource).toMatch(/import App from ["']\.\/App["']/);
    expect(legacyMainSource).not.toContain('import("./App")');
    expect(viteSource).toContain('VITE_BACKEND_ATOMIC_BOOTSTRAP === "true"');
    expect(viteSource).toContain('order: "pre"');
    expect(viteSource).toContain("html.replace('/src/main.tsx', '/src/main-legacy.tsx')");
  });

  it("uses the atomic result as one identity-plus-data boundary and retains the legacy fallback", () => {
    expect(syncSource).toContain("const authenticatedSnapshotLoader = dataGateway.loadAuthenticatedAppDataSnapshot");
    expect(syncSource).toContain("if (authenticatedSnapshotLoader)");
    expect(syncSource).toContain("await dataGateway.prepareAuthenticatedBootstrap()");
    expect(syncSource).toContain("await authenticatedSnapshotLoader()");
    expect(syncSource).toContain("applyRemoteSnapshot(result.snapshot)");
    expect(syncSource).toContain("setActiveUserId(result.profile.id)");
    expect(syncSource).toContain("resolveRemoteSessionProfile({ includeOrganization: !allowFullAppDataPersist })");
    expect(syncSource).toContain("dataGateway.resetAuthenticatedBootstrapAttempt?.()");
  });
});
