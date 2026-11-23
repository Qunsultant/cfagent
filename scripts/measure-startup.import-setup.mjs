/**
 * scripts/measure-startup.import-setup.mjs — import-runner setup (#6281).
 *
 * Loaded with `node --import` before the harness imports the worker bundle.
 * The bundle's ESM output contains esbuild's `require` shim: some bundled
 * CJS modules call `require("process")` (and other builtins) at module
 * scope. Workerd defines `require` (nodejs_compat); plain Node ESM does
 * not, so the shim throws "Dynamic require ... is not supported". Defining
 * globalThis.require via createRequire gives those calls the Node builtins
 * they ask for, without changing the measured bundle. This file is
 * measurement-only and is never part of the deploy bundle.
 */
import { createRequire } from "node:module";

globalThis.require = createRequire(import.meta.url);
