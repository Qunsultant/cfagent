import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // mppx/server is node-only (imports node:util) and is only ever loaded
      // lazily inside server-side MPP payment flows (see
      // src/services/agenticPayments.ts). Keep it out of the browser bundle;
      // the worker build (wrangler/esbuild) ignores this config and bundles
      // it normally. (Issue #290: the trading boundary index is imported by
      // client code, which would otherwise drag mppx into the client graph.)
      // The mppx root is external for the same reason: Credential.fromRequest
      // is loaded lazily from it in the same flows (issue #700).
      external: ["mppx/server", "mppx"],
    },
  },
  resolve: {
    alias: [
      { find: /^(\.\/|\.\.\/.*\/)TradeExecutionPreview$/, replacement: new URL("./src/client/TradeExecutionPreview.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
      { find: /^(\.\/|\.\.\/.*\/)tradeExecutionPreview$/, replacement: new URL("./src/client/tradeExecutionPreview.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
      { find: /^(\.\/|\.\.\/.*\/)SchedulesHome$/, replacement: new URL("./src/client/SchedulesHome.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
      { find: /^(\.\/|\.\.\/.*\/)schedulesHome$/, replacement: new URL("./src/client/schedulesHome.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
      { find: "@", replacement: "/src" },
    ],
  },
  // @ts-expect-error vitest configuration options
  test: {
    testTimeout: 25000,
    hookTimeout: 25000,
    exclude: ["**/node_modules/**", "**/.git/**", "**/.worktrees/**", "dist/**"],
    // #411: hermetic suite — block outbound fetch in tests by default;
    // suites stub the exact responses they need.
    setupFiles: ["./tests/netblock.setup.ts"],
    // `src/server.ts` exports Durable Object classes, so importing the Worker
    // under Node resolves `cloudflare:workers` — a scheme the ESM loader cannot
    // load. The stub only provides the base class; tests never instantiate one.
    alias: {
      "cloudflare:workers": new URL("./tests/stubs/cloudflareWorkers.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      // The /workflows alias stays: both workflow classes are
      // still ThinkWorkflow by ADR 0004 W13.
      "@cloudflare/think/workflows": new URL("./tests/stubs/cloudflareThinkWorkflows.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      // Issue #2003 (tracker #1951): TEST-ONLY bare alias, fully
      // replacing "@cloudflare/think" under Node vitest. The real
      // package's runtime graph reaches workerd-only imports
      // (`cloudflare:email` / `cloudflare:workflows`-adjacent code)
      // the Node ESM loader rejects, which failed 58 suites at load
      // with 0 tests each (Research #1953 / PR #1990 narrowed cause).
      // The stub (tests/stubs/cloudflareThink.ts) imports nothing,
      // so the failing graph never loads; its turn methods throw
      // rather than fake a turn. This is test config only — the
      // production Worker build ignores it and resolves the real
      // package. It restores the bare alias #1738 removed, as a
      // test-only alias, because foundation #1962 reintroduced a
      // bare Think import through src/actors/thinkAdapter.ts.
      "@cloudflare/think": new URL("./tests/stubs/cloudflareThink.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    },
  },
});
