import js from "@eslint/js";
export default [js.configs.recommended, {
  files: ["**/*.mjs"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: {
    process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", fetch: "readonly"
  } }
}];
