import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "instagram-web/frontend/node_modules/**",
      "instagram-web/frontend/dist/**",
      "instagram-web/frontend/test-results/**",
      "instagram-web/frontend/playwright-report/**",
      "native-app/**",
      "backups/files/**",
      "database/**",
      "logs/**",
      ".impeccable/**",
      "coverage/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-empty": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-irregular-whitespace": "off"
    }
  },
  {
    files: ["call-panel/app.js"],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } }
  }
];
