import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { getBackendResourceHints } from "./src/backendResourceHints";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const performanceEvidenceEnabled = env.VITE_PERFORMANCE_EVIDENCE === "true";
  const atomicBootstrapEnabled = env.VITE_BACKEND_ATOMIC_BOOTSTRAP === "true";
  const backendResourceHints = getBackendResourceHints(env.VITE_SUPABASE_URL);
  return {
    plugins: [
      {
        name: "backend-resource-hints",
        transformIndexHtml: {
          order: "pre",
          handler(html) {
            return {
              html: atomicBootstrapEnabled
                ? html
                : html.replace('/src/main.tsx', '/src/main-legacy.tsx'),
              tags: backendResourceHints.map((hint) => ({
                tag: "link",
                attrs: hint,
                injectTo: "head-prepend" as const
              }))
            };
          }
        }
      },
      react()
    ],
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
