#!/usr/bin/env node
/**
 * scripts/ci/deploy-worker.mjs
 *
 * Resilient Cloudflare Worker deployment script (Issue #3789 / #3814).
 *
 * Executes `npx wrangler deploy`. If deployment fails due to Cloudflare Containers
 * permissions/entitlement (HTTP 403 Forbidden on /containers/applications), it
 * strips the optional `containers` configuration from wrangler.jsonc in the runner
 * and retries deployment in honest degraded sandbox mode (per src/agents/sandbox-agent.ts).
 *
 * This permanently guarantees that production deployment is never blocked by
 * missing Cloudflare Containers permissions on the deploy token or account plan,
 * while preserving the containers declaration in the repository for environments
 * that do have container provisioning enabled.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Strips the top-level "containers" configuration block from wrangler.jsonc text,
 * preserving all other comments, Durable Object bindings, and formatting.
 *
 * @param {string} content - Raw content of wrangler.jsonc
 * @returns {string} Content without the containers configuration
 */
export function stripContainersConfig(content) {
  return content.replace(
    /\r?\n[ \t]*(?:\/\/[^\r\n]*\r?\n[ \t]*)*"containers":[ \t]*\[[\s\S]*?\],[ \t]*\r?\n/m,
    "\n"
  );
}

/**
 * Checks whether the deployment failure output indicates a Cloudflare Containers
 * API permission or entitlement failure (HTTP 403 Forbidden).
 *
 * @param {string} output - Combined stdout and stderr from wrangler deploy
 * @returns {boolean} True if failure is container-forbidden
 */
export function isContainersForbiddenError(output) {
  if (!output || typeof output !== "string") return false;
  const hasContainerTarget =
    output.includes("containers/applications") ||
    output.includes("/containers") ||
    output.includes("Durable Object-managed Containers");
  const hasAuthError =
    output.includes("Forbidden") ||
    output.includes("403") ||
    output.includes("Authentication error");
  return hasContainerTarget && hasAuthError;
}

/**
 * Runs npx wrangler deploy streaming output to stdout/stderr.
 *
 * @returns {Promise<{ code: number, combined: string }>}
 */
export function runWranglerDeploy() {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "npx.cmd" : "npx";
    const child = spawn(cmd, ["wrangler", "deploy"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    let combined = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        combined += text;
        process.stdout.write(text);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        combined += text;
        process.stderr.write(text);
      });
    }

    child.on("close", (code) => {
      resolve({ code: code ?? 1, combined });
    });

    child.on("error", (err) => {
      const msg = err.message || String(err);
      combined += "\n" + msg;
      process.stderr.write(msg + "\n");
      resolve({ code: 1, combined });
    });
  });
}

export async function main() {
  console.log("Starting Cloudflare Worker deployment (npx wrangler deploy)...");
  const result = await runWranglerDeploy();

  if (result.code === 0) {
    console.log("Deployment completed successfully.");
    process.exit(0);
  }

  if (isContainersForbiddenError(result.combined)) {
    console.log(
      "\n::warning title=Containers API Forbidden::Cloudflare API token lacks Containers permissions (403 Forbidden on /containers/applications). Stripping optional 'containers' block from wrangler.jsonc and retrying deploy in honest degraded sandbox mode (per src/agents/sandbox-agent.ts)...\n"
    );

    const configPath = "wrangler.jsonc";
    let content = "";
    try {
      content = readFileSync(configPath, "utf8");
    } catch (err) {
      console.error(`Failed to read ${configPath}:`, err);
      process.exit(result.code);
    }

    const stripped = stripContainersConfig(content);

    if (stripped !== content) {
      writeFileSync(configPath, stripped, "utf8");
      console.log("Stripped 'containers' block from wrangler.jsonc. Retrying npx wrangler deploy...");
      const retryResult = await runWranglerDeploy();
      if (retryResult.code === 0) {
        console.log("Retry deployment succeeded in honest degraded sandbox mode.");
        process.exit(0);
      }
      process.exit(retryResult.code);
    }
  }

  process.exit(result.code);
}

// Auto-run if executed as main script
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("deploy-worker.mjs") ||
    process.argv[1].endsWith("deploy-worker.js"));

if (isMain) {
  main().catch((err) => {
    console.error("Fatal deployment script error:", err);
    process.exit(1);
  });
}
