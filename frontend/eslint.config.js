import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  {
    ignores: [
      "dist",
      "node_modules",
      ".npm-cache",
      ".npm-appdata",
      ".edge-*",
      "qa-*.png",
      "vite-dev*.log",
    ],
  },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "no-unused-vars": ["warn", { varsIgnorePattern: "^[A-Z_]" }],
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // Root-level tooling config files run in Node, not the browser (e.g.
    // vite.config.js uses process.cwd() to load .env.local server-side).
    files: ["*.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
