/**
 * Issue #3789 (sub-issue of incident #3781) — structural pin on the
 * wrangler.jsonc `containers` configuration for Durable Object-managed
 * containers.
 *
 * Wrangler 4.156.0 rejects the `image` field on a containers entry whose
 * scheduling_policy is "durable_object" ("Unsupported fields for Durable
 * Object-managed Containers in containers: \"image\". Only \"name\",
 * \"class_name\", \"scheduling_policy\", \"images\", \"observability\",
 * \"ssh\", \"authorized_keys\", and restricted \"unsafe\" settings are
 * supported."), failing config processing for EVERY wrangler command.
 * That broke Deploy NextGenTP at its first wrangler invocation (the
 * "Ensure Vectorize index for VectorMemory" step) from bb24be82 on.
 * The image is supplied at runtime by ETradeSandboxService.runCommand
 * via container.start({ image: "cloudflare/debian-trixie", ... })
 * (src/services/sandboxAgent.ts), so the config field carries nothing
 * the code uses. This pin fails while a DO-managed entry carries
 * `image` and passes once it is removed — and it also pins the
 * SandboxAgent binding itself, so the capability cannot be silently
 * deleted to "fix" the deploy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// Wrangler 4.156.0 error text: the only fields a Durable
// Object-managed containers entry may carry.
const DO_MANAGED_SUPPORTED_FIELDS = new Set([
  "name",
  "class_name",
  "scheduling_policy",
  "images",
  "observability",
  "ssh",
  "authorized_keys",
  "unsafe",
]);

type ContainerEntry = Record<string, unknown>;

function readContainers(): ContainerEntry[] {
  const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
    containers?: ContainerEntry[];
  };
  return wrangler.containers ?? [];
}

describe("wrangler.jsonc containers config (#3789)", () => {
  it("declares the SandboxAgent Durable Object-managed container entry (capability preserved)", () => {
    const entries = readContainers();
    const sandbox = entries.filter(
      (e) =>
        e.class_name === "SandboxAgent" && e.scheduling_policy === "durable_object",
    );
    expect(sandbox).toHaveLength(1);
  });

  it("no Durable Object-managed containers entry carries an `image` field (rejected by wrangler 4.156.0)", () => {
    const entries = readContainers();
    const managed = entries.filter((e) => e.scheduling_policy === "durable_object");
    expect(managed.length).toBeGreaterThan(0);
    for (const entry of managed) {
      expect(entry, "DO-managed entry must not carry `image`").not.toHaveProperty("image");
    }
  });

  it("Durable Object-managed entries use only wrangler-supported fields", () => {
    const entries = readContainers();
    const managed = entries.filter((e) => e.scheduling_policy === "durable_object");
    for (const entry of managed) {
      for (const key of Object.keys(entry)) {
        expect(
          DO_MANAGED_SUPPORTED_FIELDS.has(key),
          `unsupported field "${key}" on DO-managed containers entry`,
        ).toBe(true);
      }
    }
  });

  it("ETradeSandboxService passes the debian-trixie image at container.start() (runtime image source, #3789)", async () => {
    // The image lives at the runtime start() call, not in wrangler.jsonc:
    // removing the config field must not lose the image the container runs.
    const { ETradeSandboxService } = await import("../src/services/sandboxAgent");
    let startArgs: unknown;
    const container = {
      running: false,
      start: async (args: unknown) => {
        startArgs = args;
      },
      exec: async () => ({
        output: async () => ({
          stdout: new TextEncoder().encode("ok"),
          stderr: new TextEncoder().encode(""),
          exitCode: 0,
        }),
      }),
    };
    const svc = new ETradeSandboxService(container as never);
    const result = await svc.runCommand({ command: "echo hi", timeoutMs: 5000 });
    expect(result.executed).toBe(true);
    expect(startArgs).toMatchObject({ image: "cloudflare/debian-trixie" });
  });
});
