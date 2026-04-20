import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "off",
      // Flags passing ref objects as JSX ref= props — false positive for valid React pattern
      "react-hooks/refs": "off",
      // Selection-sync effects (reset selected item when list changes) are an established
      // pattern in this codebase; downgrade to warn so real issues still surface
      "react-hooks/set-state-in-effect": "warn"
    }
  },
  {
    // supabase/** contains Deno edge functions — not part of the TS/Node project,
    // uses Deno globals and npm: specifiers that the Node ESLint parser can't resolve.
    ignores: ["dist/**", "supabase/**", "scripts/**"]
  }
);
