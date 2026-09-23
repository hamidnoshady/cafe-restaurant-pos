import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The fast suite: pure units in Node, plus the handful of *component* tests
 * that need a DOM.
 *
 * The split is by extension, not by folder. A `.test.ts` is framework-free and
 * runs in Node, which is the overwhelming majority of this repo and the reason
 * the suite finishes in under two minutes. A `.test.tsx` renders a component
 * and opts into jsdom with its own `@vitest-environment jsdom` docblock — a
 * per-file pragma rather than a config glob, so adding a pure test can never
 * accidentally pay for a DOM and the choice is visible in the file making it.
 *
 * What the DOM ones exist for is the two long-press gestures (payment confirm,
 * add-on quantity): their contract is "a tap does nothing, a hold does
 * something after N seconds", which cannot be proven by calling a function.
 * They need real pointerdown/pointerup on a real element, and a real element to
 * read the progress fill's width back off.
 */
export default defineConfig({
  // tsconfig keeps `jsx: "preserve"` for Next's own compiler; esbuild needs to
  // be told to run the automatic runtime itself for a test that renders JSX.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
