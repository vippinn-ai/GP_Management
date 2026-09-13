import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const performanceEvidenceEnabled = loadEnv(mode, process.cwd(), "VITE_PERFORMANCE_EVIDENCE").VITE_PERFORMANCE_EVIDENCE === "true";
  return {
    plugins: [react()],
    resolve: {
      alias: performanceEvidenceEnabled
        ? [{ find: "react-dom/client", replacement: "react-dom/profiling" }]
        : []
    },
    server: {
      host: "0.0.0.0",
      port: 4173
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      exclude: [...configDefaults.exclude, ".claude/**", "openwhispr/**", "test-artifacts/**", "tests/e2e/**"]
    }
  };
});
