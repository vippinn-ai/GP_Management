import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
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
};

function recordRenderEvidence(
  _id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number
) {
  const target = globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence };
  const current = target.__BP_RENDER_EVIDENCE__ ?? {
    commits: 0,
    mountCommits: 0,
    updateCommits: 0,
    totalActualDurationMs: 0,
    maxActualDurationMs: 0,
    updateActualDurationsMs: []
  };
  current.commits += 1;
  if (phase === "mount") current.mountCommits += 1;
  else {
    current.updateCommits += 1;
    current.updateActualDurationsMs.push(actualDuration);
  }
  current.totalActualDurationMs += actualDuration;
  current.maxActualDurationMs = Math.max(current.maxActualDurationMs, actualDuration);
  target.__BP_RENDER_EVIDENCE__ = current;
}

const app = (
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

function preloadShellImage(href: string) {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "image";
  link.href = href;
  document.head.append(link);
}

function mountApp() {
  preloadShellImage(brandLogo);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {import.meta.env.VITE_PERFORMANCE_EVIDENCE === "true"
        ? <React.Profiler id="bp-app" onRender={recordRenderEvidence}>{app}</React.Profiler>
        : app}
    </React.StrictMode>
  );
}

mountApp();
