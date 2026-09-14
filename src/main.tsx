import React from "react";
import { createRoot } from "react-dom/client";
import { defaultRemoteDataGateway } from "./dataGateway";
import { ErrorBoundary } from "./ErrorBoundary";
import brandLogo from "../Branding/Logo.optimized.png";
import "./styles.css";

type RenderEvidence = {
  commits: number;
  mountCommits: number;
  updateCommits: number;
  totalActualDurationMs: number;
  maxActualDurationMs: number;
  updateActualDurationsMs: number[];
  events: Array<{
    id: string;
    phase: "mount" | "update" | "nested-update";
    actualDurationMs: number;
    baseDurationMs: number;
    startTimeMs: number;
    commitTimeMs: number;
  }>;
};

function recordRenderEvidence(
  id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  const target = globalThis as typeof globalThis & {
    __BP_RENDER_EVIDENCE__?: RenderEvidence;
    __BP_RECORD_RENDER_EVIDENCE__?: typeof recordRenderEvidence;
  };
  const current = target.__BP_RENDER_EVIDENCE__ ?? {
    commits: 0,
    mountCommits: 0,
    updateCommits: 0,
    totalActualDurationMs: 0,
    maxActualDurationMs: 0,
    updateActualDurationsMs: [],
    events: []
  };
  current.events.push({
    id,
    phase,
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    startTimeMs: startTime,
    commitTimeMs: commitTime
  });
  if (id === "bp-app") {
    current.commits += 1;
    if (phase === "mount") current.mountCommits += 1;
    else {
      current.updateCommits += 1;
      current.updateActualDurationsMs.push(actualDuration);
    }
    current.totalActualDurationMs += actualDuration;
    current.maxActualDurationMs = Math.max(current.maxActualDurationMs, actualDuration);
  }
  target.__BP_RENDER_EVIDENCE__ = current;
  target.__BP_RECORD_RENDER_EVIDENCE__ = recordRenderEvidence;
}

function preloadShellImage(href: string) {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "image";
  link.href = href;
  document.head.append(link);
}

function mountApp(App: typeof import("./App")["default"]) {
  if (import.meta.env.VITE_PERFORMANCE_EVIDENCE === "true") {
    const target = globalThis as typeof globalThis & { __BP_RECORD_RENDER_EVIDENCE__?: typeof recordRenderEvidence };
    target.__BP_RECORD_RENDER_EVIDENCE__ = recordRenderEvidence;
  }
  const app = (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
  preloadShellImage(brandLogo);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {import.meta.env.VITE_PERFORMANCE_EVIDENCE === "true"
        ? <React.Profiler id="bp-app" onRender={recordRenderEvidence}>{app}</React.Profiler>
        : app}
    </React.StrictMode>
  );
}

function markStartupPerformance(name: string) {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(name);
  }
}

async function startApp() {
  markStartupPerformance("bp-app-module-requested");
  const appModulePromise = import("./App");
  const bootstrapPreparation = defaultRemoteDataGateway.prepareAuthenticatedBootstrap?.();
  void bootstrapPreparation?.catch(() => undefined);
  const { default: App } = await appModulePromise;
  markStartupPerformance("bp-app-module-ready");
  mountApp(App);
}

void startApp();
