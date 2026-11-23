#!/usr/bin/env node
/**
 * scripts/measure-startup.mjs — worker startup measurement harness (#6281).
 *
 * Rebuilds the #3185 diagnosis measurement as an in-repo script (the original
 * lived in /tmp and is gone; this one is committed, so it cannot be lost to a
 * restart). It measures, on the current tree:
 *
 *  1. Worker bundle bytes — the `wrangler deploy --dry-run` bundle is the
 *     authoritative number (it is literally the deploy's build). The
 *     esbuild-direct build is informational and supplies the metafile.
 *  2. Largest modules from the esbuild metafile (where the bytes live).
 *  3. Parse-only time: `node --check` on the bundle, several runs, median.
 *  4. Full import CPU: importing the bundle in a fresh Node process per run,
 *     median. Node is not workerd — this is a regression signal, not a
 *     deploy prediction, and it is reported, never gated on.
 *  5. Budget check: fail when the wrangler bundle bytes exceed
 *     baselineBytes + maxGrowthPct from scripts/measure-startup.config.json
 *     (PROPOSED 5%, owner decision). Startup time is reported as a CI
 *     artifact, never a failing gate (CI machine timing is too noisy).
 *
 * How the esbuild-direct build stays faithful to wrangler: entry
 * src/server.ts, bundle, minify, format esm, target es2022, platform node
 * (the static graph imports node:* builtins, which platform browser
 * rejects), conditions [workerd, worker, browser], and `cloudflare:*`
 * aliased to the measurement stub (scripts/measure-startup.cloudflare-stub.mjs)
 * so the bundle imports in plain Node. Calibrated 2026-11-23 on main
 * 1841712537: esbuild 13,667,629 bytes / 4,342 modules vs wrangler dry-run
 * 14,197,253 bytes — the ~3.7% gap is wrangler's node-compat shims, which
 * esbuild leaves external under platform node. That is why the budget is
 * enforced on the wrangler number, never the esbuild number.
 *
 * Usage:
 *   node scripts/measure-startup.mjs [--out <report.json>]
 *       [--config <config.json>] [--runs <n>] [--esbuild-only]
 * Defaults: --out startup-measurement.json, --config
 * scripts/measure-startup.config.json, --runs 5. --esbuild-only skips the
 * wrangler dry-run (local iteration; the budget verdict is skipped too,
 * because the esbuild bytes are not the deploy bytes). Requires dist/ for
 * the wrangler dry-run — run `npm run build` first.
 *
 * Exit code: 0 = measured, budget OK (or skipped in --esbuild-only);
 * 1 = budget exceeded; 2 = measurement/config error.
 *
 * esbuild is a transitive dependency (via vite/wrangler); the import below
 * relies on npm hoisting it to node_modules, as `npx wrangler` already does.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

export const DEFAULT_OUT = "startup-measurement.json";
export const DEFAULT_CONFIG = "scripts/measure-startup.config.json";
export const DEFAULT_RUNS = 5;
export const TOP_MODULES = 10;

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STUB_PATH = join(REPO_ROOT, "scripts", "measure-startup.cloudflare-stub.mjs");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/measure_startup_6281.test.ts)
// ---------------------------------------------------------------------------

/** Median of a non-empty numeric sample. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("median requires a non-empty array of numbers");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Largest modules from an esbuild metafile, sorted by input bytes desc.
 * @param {object} metafile - esbuild metafile ({ inputs: { path: { bytes } } })
 * @param {number} limit - how many to return
 * @returns {{ path: string, bytes: number }[]}
 */
export function topModules(metafile, limit) {
  const inputs = metafile?.inputs ?? {};
  return Object.entries(inputs)
    .map(([path, info]) => ({ path, bytes: info?.bytes ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

/** Budget ceiling in bytes: baseline + maxGrowthPct, floored. */
export function budgetLimitBytes(baselineBytes, maxGrowthPct) {
  return Math.floor(baselineBytes * (1 + maxGrowthPct / 100));
}

/** True when bytes exceed the budget ceiling. At the limit is not over. */
export function exceedsBudget(bytes, baselineBytes, maxGrowthPct) {
  return bytes > budgetLimitBytes(baselineBytes, maxGrowthPct);
}

/**
 * Validate + normalize a budget config object.
 * @returns {{ baselineBytes: number, baselineCommit: string | null, maxGrowthPct: number }}
 */
export function validateBudgetConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("budget config must be an object");
  }
  const { baselineBytes, baselineCommit = null, maxGrowthPct } = config;
  if (!Number.isInteger(baselineBytes) || baselineBytes <= 0) {
    throw new Error("budget config baselineBytes must be a positive integer");
  }
  if (baselineCommit !== null && (typeof baselineCommit !== "string" || baselineCommit === "")) {
    throw new Error("budget config baselineCommit must be a non-empty string when present");
  }
  if (typeof maxGrowthPct !== "number" || !Number.isFinite(maxGrowthPct) || maxGrowthPct <= 0) {
    throw new Error("budget config maxGrowthPct must be a positive number");
  }
  return { baselineBytes, baselineCommit, maxGrowthPct };
}

/** Load + validate a budget config file. */
export function loadBudgetConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`budget config not found: ${configPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`budget config is not valid JSON: ${configPath}`);
  }
  return validateBudgetConfig(parsed);
}

/**
 * Assess measured bytes against a validated config.
 * @returns {{ bytes, baselineBytes, limitBytes, maxGrowthPct, over, overByBytes }}
 */
export function assessBudget(bytes, config) {
  const limitBytes = budgetLimitBytes(config.baselineBytes, config.maxGrowthPct);
  const over = bytes > limitBytes;
  return {
    bytes,
    baselineBytes: config.baselineBytes,
    limitBytes,
    maxGrowthPct: config.maxGrowthPct,
    over,
    overByBytes: over ? bytes - limitBytes : 0,
  };
}

/** Parse CLI args. Throws on unknown flags or invalid values. */
export function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    esbuildOnly: false,
    runs: DEFAULT_RUNS,
    config: DEFAULT_CONFIG,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--esbuild-only") {
      args.esbuildOnly = true;
    } else if (arg === "--out" || arg === "--config" || arg === "--runs") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--out") args.out = value;
      else if (arg === "--config") args.config = value;
      else {
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1) {
          throw new Error("--runs must be a positive integer");
        }
        args.runs = runs;
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Measurement engine
// ---------------------------------------------------------------------------

/** Run a command, capturing output. Rejects on spawn failure; resolves with code. */
function runCommand(cmd, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Build the worker bundle with esbuild (deploy-equivalent flags, see header).
 * The cloudflare:* alias points at the measurement stub so the bundle
 * imports in plain Node for the import-CPU measurement.
 * @returns {Promise<{ bytes: number, modules: number, top: { path, bytes }[], outFile: string }>}
 */
export async function buildEsbuildBundle(outDir) {
  const outFile = join(outDir, "server.js");
  const result = await esbuild.build({
    entryPoints: [join(REPO_ROOT, "src", "server.ts")],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    platform: "node",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    alias: {
      "cloudflare:workers": STUB_PATH,
      "cloudflare:email": STUB_PATH,
    },
    metafile: true,
    outfile: outFile,
    logLevel: "warning",
  });
  const bytes = statSync(outFile).size;
  const inputs = result.metafile?.inputs ?? {};
  return {
    bytes,
    modules: Object.keys(inputs).length,
    top: topModules(result.metafile, TOP_MODULES),
    outFile,
  };
}

/**
 * Time `node --check` on a file, one fresh process per run.
 * @returns {Promise<number[]>} parse times in ms, one per run
 */
export async function measureParseMs(bundlePath, runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = await runCommand(process.execPath, ["--check", bundlePath]);
    const ms = performance.now() - start;
    if (result.code !== 0) {
      throw new Error(`node --check failed on ${bundlePath}: ${result.stderr}`);
    }
    samples.push(ms);
  }
  return samples;
}

/**
 * Time importing a bundle in a fresh Node process per run (cold module cache).
 * Runs with `--import scripts/measure-startup.import-setup.mjs`, which
 * defines globalThis.require: the bundle's ESM output contains esbuild's
 * `require` shim and some bundled CJS modules call `require("process")` at
 * module scope. Workerd defines `require` (nodejs_compat); plain Node ESM
 * does not. The runner prints a `MEASURE_IMPORT_MS:{...}` marker line on
 * success or a `MEASURE_IMPORT_ERROR:{...}` marker on failure; the last
 * such line is parsed, so any module-scope console output is ignored and
 * a failure never dumps the minified bundle source into the log.
 * @returns {Promise<number[]>} import times in ms, one per run
 */
export async function measureImportMs(bundlePath, runs) {
  const samples = [];
  const setupPath = join(REPO_ROOT, "scripts", "measure-startup.import-setup.mjs");
  const code = [
    "try {",
    "  const t0 = performance.now();",
    `  await import(${JSON.stringify(bundlePath)});`,
    "  console.log('MEASURE_IMPORT_MS:' + JSON.stringify({ ms: performance.now() - t0 }));",
    "} catch (err) {",
    "  console.log('MEASURE_IMPORT_ERROR:' + JSON.stringify({ name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 500) }));",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  for (let i = 0; i < runs; i++) {
    const result = await runCommand(process.execPath, [
      "--import",
      setupPath,
      "--input-type=module",
      "--eval",
      code,
    ]);
    const marker = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("MEASURE_IMPORT_MS:"))
      .pop();
    if (result.code !== 0 || !marker) {
      const errorMarker = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("MEASURE_IMPORT_ERROR:"))
        .pop();
      const detail = errorMarker
        ? errorMarker.slice("MEASURE_IMPORT_ERROR:".length)
        : result.stderr.trim().split("\n").slice(0, 3).join("\n");
      throw new Error(`bundle import failed on ${bundlePath}: ${detail}`);
    }
    samples.push(JSON.parse(marker.slice("MEASURE_IMPORT_MS:".length)).ms);
  }
  return samples;
}

/**
 * Run the deploy's own build (`wrangler deploy --dry-run`) and measure the
 * emitted bundle. Requires dist/ (run `npm run build` first).
 * @returns {Promise<{ bytes: number, bundle: string }>}
 */
export async function measureWranglerBytes() {
  if (!existsSync(join(REPO_ROOT, "dist"))) {
    throw new Error("dist/ is missing — run `npm run build` first (wrangler dry-run needs the assets directory)");
  }
  const outDir = mkdtempSync(join(tmpdir(), "measure-startup-wrangler-"));
  try {
    const result = await runCommand(
      "npx",
      ["wrangler", "deploy", "--dry-run", "--outdir", outDir],
      { cwd: REPO_ROOT }
    );
    const bundlePath = join(outDir, "server.js");
    if (result.code !== 0 || !existsSync(bundlePath)) {
      const detail = (result.stdout + result.stderr).trim().split("\n").slice(-10).join("\n");
      throw new Error(`wrangler dry-run failed:\n${detail}`);
    }
    return { bytes: statSync(bundlePath).size, bundle: "server.js" };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Best-effort current HEAD (short SHA), null when git is unavailable. */
async function currentHead() {
  try {
    const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Run the full measurement.
 * @param {{ out: string, esbuildOnly: boolean, runs: number, config: string }} options
 * @returns {Promise<{ report: object, over: boolean }>}
 */
export async function runMeasurement(options) {
  const config = loadBudgetConfig(resolve(REPO_ROOT, options.config));
  const workDir = mkdtempSync(join(tmpdir(), "measure-startup-esbuild-"));
  try {
    const esbuildResult = await buildEsbuildBundle(workDir);
    const parseSamples = await measureParseMs(esbuildResult.outFile, options.runs);
    const importSamples = await measureImportMs(esbuildResult.outFile, options.runs);

    let wrangler = null;
    let budget = null;
    if (!options.esbuildOnly) {
      wrangler = await measureWranglerBytes();
      budget = assessBudget(wrangler.bytes, config);
    }

    const report = {
      commit: await currentHead(),
      measuredAt: new Date().toISOString(),
      wrangler,
      esbuild: {
        bytes: esbuildResult.bytes,
        modules: esbuildResult.modules,
        topModules: esbuildResult.top,
      },
      parseMs: { samples: parseSamples, median: median(parseSamples) },
      importMs: { samples: importSamples, median: median(importSamples) },
      budget,
      config: {
        baselineBytes: config.baselineBytes,
        baselineCommit: config.baselineCommit,
        maxGrowthPct: config.maxGrowthPct,
      },
    };
    return { report, over: budget?.over ?? false };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function printSummary(report, esbuildOnly) {
  console.log(`commit: ${report.commit ?? "unknown"}`);
  if (report.wrangler) {
    console.log(`wrangler bundle: ${report.wrangler.bytes} bytes (authoritative, deploy build)`);
  } else {
    console.log("wrangler bundle: skipped (--esbuild-only)");
  }
  console.log(
    `esbuild bundle: ${report.esbuild.bytes} bytes, ${report.esbuild.modules} modules`
  );
  console.log("largest modules:");
  for (const mod of report.esbuild.topModules) {
    console.log(`  ${mod.bytes.toString().padStart(9)}  ${mod.path}`);
  }
  console.log(
    `parse (node --check): median ${Math.round(report.parseMs.median)} ms ` +
      `(range ${Math.round(Math.min(...report.parseMs.samples))}–${Math.round(Math.max(...report.parseMs.samples))} ms, ${report.parseMs.samples.length} runs)`
  );
  console.log(
    `import (cold, Node): median ${Math.round(report.importMs.median)} ms ` +
      `(range ${Math.round(Math.min(...report.importMs.samples))}–${Math.round(Math.max(...report.importMs.samples))} ms, ${report.importMs.samples.length} runs)`
  );
  if (report.budget) {
    const b = report.budget;
    console.log(
      `budget: ${b.over ? "EXCEEDED" : "OK"} — ${b.bytes} bytes vs limit ${b.limitBytes} ` +
        `(baseline ${b.baselineBytes} + ${b.maxGrowthPct}%)` +
        (b.over ? `, over by ${b.overByBytes} bytes` : "")
    );
  } else if (esbuildOnly) {
    console.log("budget: skipped (--esbuild-only; esbuild bytes are not the deploy bytes)");
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(
      "usage: node scripts/measure-startup.mjs [--out <report.json>] [--config <config.json>] [--runs <n>] [--esbuild-only]"
    );
    process.exit(2);
  }

  let result;
  try {
    result = await runMeasurement(options);
  } catch (err) {
    console.error(`measurement failed: ${err.message}`);
    process.exit(2);
  }

  const outPath = resolve(process.cwd(), options.out);
  writeFileSync(outPath, JSON.stringify(result.report, null, 2) + "\n");
  printSummary(result.report, options.esbuildOnly);
  console.log(`report: ${outPath}`);

  if (result.over) {
    console.error(
      "BUDGET EXCEEDED: worker bundle bytes are over baseline + maxGrowthPct. " +
        "Split a heavy module out of the startup bundle (see program #6280) or record a new baseline with an owner decision."
    );
    process.exit(1);
  }
  process.exit(0);
}

// Auto-run if executed as main script
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("measure-startup.mjs") ||
    process.argv[1].endsWith("measure-startup.js"));

if (isMain) {
  main().catch((err) => {
    console.error("Fatal measurement error:", err);
    process.exit(2);
  });
}
