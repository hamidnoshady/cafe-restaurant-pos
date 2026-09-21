import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: root });

const config = [
  {
    ignores: [
      ".next/**",
      ".desktop-runtime/**",
      "electron/dist/**",
      "electron/node_modules/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "dist/**",
      "out/**",
      "build/**",
      "backups/**",
      "**/pgdata/**",
      "wordpress-plugin/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // TypeScript compilation remains the source of truth for unused symbols. The
      // legacy codebase intentionally keeps compatibility parameters and exports.
      "@typescript-eslint/no-unused-vars": "off",
      // Product-domain variables named `module` are not the Node.js module object.
      "@next/next/no-assign-module-variable": "off",
      // These are runtime/data URLs and authenticated media for which next/image
      // cannot supply an optimizer. Accessibility rules still require alt text.
      "@next/next/no-img-element": "off",
      // New hook dependency mistakes must fail CI rather than be warnings.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "integration/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["electron/**/*.js", "**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default config;
