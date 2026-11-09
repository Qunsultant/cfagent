/**
 * Issue #1935 (O3 spike) — pure mapping between the actor port's shapes
 * and Think 0.19.0's shapes.
 *
 * This module deliberately imports NOTHING of value from
 * `@cloudflare/think` (only `import type`, which is erased at build):
 * Think's runtime import graph needs workerd schemes
 * (`cloudflare:workers`, `cloudflare:email`) that the repo's node
 * vitest harness cannot load, so the Think-coupled half of the
 * adapter lives in thinkAdapter.ts (workerd-only) while this mapping
 * half stays node-testable. The structural types below mirror
 * Think 0.19.0's .d.ts (TurnContext, TurnConfig, TurnResult,
 * SessionMessage); thinkAdapter.ts passes the real Think objects
 * through these functions, so tsc checks the mirror on every build.
 */
import type {
  ChatResponseResult as ThinkChatResponseResult,
  SessionMessage as ThinkSessionMessage,
  TurnConfig as ThinkTurnConfig,
  TurnContext as ThinkTurnContext,
  TurnResult as ThinkTurnResult,
} from "@cloudflare/think";
import type { ModelMessage } from "ai";
import type {
  ChatResponseResult,
  ModelChatMessage,
  TurnConfig,
  TurnContext,
  UiChatMessage,
} from "./actorPorts";

/** Port roles; Think's UIMessage roles are the same three. */
const PORT_ROLES = new Set(["user", "assistant", "system"]);

/** Port transcript -> Think input messages (metadata/createdAt stay port-side). */
export function portMessagesToThink(messages: UiChatMessage[]): ThinkSessionMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: (m.parts ?? []).map((p) => ({ ...p })),
  })) as ThinkSessionMessage[];
}

/** Think message -> port message; unknown roles are dropped (never invented). */
export function thinkMessageToPort(msg: ThinkSessionMessage): UiChatMessage | undefined {
  const role = (msg as { role?: string }).role;
  if (!role || !PORT_ROLES.has(role)) return undefined;
  const rawParts = (msg as { parts?: unknown }).parts;
  const parts: UiChatMessage["parts"] = Array.isArray(rawParts)
    ? rawParts
        .filter(
          (p): p is UiChatMessage["parts"][number] =>
            !!p && typeof (p as { type?: unknown }).type === "string"
        )
        .map((p) => ({ ...(p as Record<string, unknown>) }) as UiChatMessage["parts"][number])
    : [];
  return {
    id: (msg as { id?: string }).id ?? crypto.randomUUID(),
    role: role as UiChatMessage["role"],
    parts,
  };
}

export function thinkMessagesToPort(messages: ThinkSessionMessage[]): UiChatMessage[] {
  const out: UiChatMessage[] = [];
  for (const m of messages) {
    const mapped = thinkMessageToPort(m);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Port turn config -> Think turn config (shared fields pass through 1:1). */
export function portTurnConfigToThink(config: TurnConfig | void | undefined): ThinkTurnConfig | void {
  if (!config) return undefined;
  const out: Record<string, unknown> = {};
  if (config.model !== undefined) out.model = config.model;
  if (config.instructions !== undefined) out.instructions = config.instructions;
  if (config.system !== undefined) out.system = config.system;
  if (config.messages !== undefined) {
    out.messages = config.messages.map((m) => ({ role: m.role, content: m.content }));
  }
  if (config.tools !== undefined) out.tools = config.tools;
  if (config.activeTools !== undefined) out.activeTools = config.activeTools;
  if (config.maxSteps !== undefined) out.maxSteps = config.maxSteps;
  return out as ThinkTurnConfig;
}

/** ModelMessage content -> port text (string passes through; part arrays join text parts). */
function modelContentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => (p as { text: string }).text)
      .join("");
  }
  return "";
}

/** Think turn context -> port turn context (for the direct-turn delegation path). */
export function thinkTurnContextToPort(ctx: ThinkTurnContext): TurnContext {
  return {
    system: ctx.system,
    messages: ctx.messages.map((m) => ({
      role: m.role as ModelChatMessage["role"],
      content: modelContentToText(m.content),
    })),
    tools: ctx.tools,
    model: ctx.model,
    continuation: ctx.continuation,
    body: ctx.body,
  };
}

/** Runtime extras Think's wait path returns beyond the TurnResult type. */
export interface ThinkWaitResultExtras {
  requestId?: string;
  status?: string;
  error?: string;
}

/**
 * Think wait-path result -> port result.
 *  - completed -> completed, message translated (may be absent).
 *  - skipped (empty input) -> completed with no message: the port has
 *    no "skipped" status, and no new assistant message exists to append.
 *  - aborted -> error "aborted" (mirrors the cf runner's abort shape).
 *  - error -> error with Think's error text; the adapter turns this
 *    into a throw after ensuring onChatError fired (port contract).
 */
export function thinkTurnResultToPort(
  result: ThinkTurnResult & ThinkWaitResultExtras,
  requestId: string
): ChatResponseResult {
  const status = result.status;
  if (status === "error") {
    return {
      status: "error",
      error: result.error ?? "think turn failed",
      requestId: result.requestId ?? requestId,
      continuation: result.continuation ?? false,
    };
  }
  if (status === "aborted") {
    return {
      status: "error",
      error: "aborted",
      requestId: result.requestId ?? requestId,
      continuation: false,
    };
  }
  if (status === "skipped") {
    return { status: "completed", requestId: result.requestId ?? requestId, continuation: false };
  }
  const message = result.message ? thinkMessageToPort(result.message) : undefined;
  return {
    status: "completed",
    message,
    requestId: result.requestId ?? requestId,
    continuation: result.continuation ?? false,
  };
}

/**
 * Issue #3474 — the PortThink webhook channel's pure seams.
 *
 * Webhooks are a built-in communication channel of every Agent
 * (Agents docs, agent-class/communication-channels/webhooks): an
 * HTTP POST routed to a specific instance, verified by HMAC-SHA256
 * over the RAW body before any parsing, then processed in the
 * agent. PortThink intercepts the reserved path tail
 * `/webhooks/<source>` at fetch (see thinkAdapter.ts) and uses
 * these three seams — kept here, in the node-testable mapping
 * module, so the verification rules are pinned without workerd.
 */

/** Env var carrying the deployment webhook secret (the docs' WEBHOOK_SECRET, port-scoped). */
export const THINK_WEBHOOK_SECRET_ENV = "THINK_WEBHOOK_SECRET";

/** Signature header, GitHub-style per the docs pattern: `sha256=<hex>`. */
export const THINK_WEBHOOK_SIGNATURE_HEADER = "x-hub-signature-256";

const THINK_WEBHOOK_PATH_TAIL = /\/webhooks\/([^/]+)$/;

/**
 * The reserved webhook path: any pathname whose tail is
 * `/webhooks/<source>` (a single non-empty segment). Suffix
 * matching — the fleet's onRequest idiom ("/health", Think's own
 * "/get-messages") — so the channel survives every production
 * prefix (routeAgentRequest's /agents/<class>/<name>, gateway
 * internal URLs). Returns the source segment, or null when the
 * path is not a webhook delivery.
 */
export function thinkWebhookSourceFromPath(pathname: string): string | null {
  const match = THINK_WEBHOOK_PATH_TAIL.exec(pathname);
  return match ? match[1] : null;
}

/**
 * The verification seam's secret resolution: the deployment
 * credential from env, named by THINK_WEBHOOK_SECRET_ENV. A
 * missing, blank, or non-string value is UNCONFIGURED (undefined)
 * — the port fails closed on it, never treats it as "no
 * verification needed".
 */
export function resolveThinkWebhookSecret(env: unknown): string | undefined {
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>)[THINK_WEBHOOK_SECRET_ENV];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Issue #3471 — the signing side of the same seam: produce the
 * `sha256=<hex>` header value for a raw body under the deployment
 * secret. In-Worker senders (the settings-change delivery) sign
 * with this so the scheme lives in exactly one place: whatever
 * this produces, the verifier below accepts, and nothing else.
 */
export async function signThinkWebhookSignature(
  rawBody: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

/**
 * HMAC-SHA256 verification over the raw body, the docs'
 * verifyGitHubWebhook pattern: the `sha256=<hex>` header format is
 * checked first, then crypto.subtle.verify decides. Callers verify
 * BEFORE parsing — an unverified body is never JSON-parsed.
 */
export async function verifyThinkWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signatureBytes = Uint8Array.from(
    signature.slice("sha256=".length).match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16)
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(rawBody));
}

/** Think chat-response hook result -> port result (direct-turn delegation path). */
export function thinkChatResponseToPort(
  result: ThinkChatResponseResult,
  requestId: string
): ChatResponseResult {
  const r = result as unknown as {
    message?: ThinkSessionMessage;
    requestId?: string;
    continuation?: boolean;
    status?: string;
    error?: string;
  };
  if (r.status === "error") {
    return {
      status: "error",
      error: r.error ?? "think turn failed",
      requestId: r.requestId ?? requestId,
      continuation: r.continuation ?? false,
    };
  }
  return {
    status: "completed",
    message: r.message ? thinkMessageToPort(r.message) : undefined,
    requestId: r.requestId ?? requestId,
    continuation: r.continuation ?? false,
  };
}

/**
 * Issue #3491 / #3896 — the PortThink workspace channel's pure seams.
 *
 * Every Think agent has a per-instance workspace rooted at `/workspace`.
 * PortThink intercepts the reserved path tails `/workspace/files` and
 * `/workspace/file` (under any routing prefix: `/agents/<class>/<instance>/...`,
 * `/api/workspace/...`, `/api/stock-copilot/workspace/...`) at `fetch`, so
 * every PortThink subclass inherits workspace listing, viewing, downloading,
 * writing, and deletion with zero per-agent route boilerplate.
 */
export const THINK_WORKSPACE_ROOT = "/workspace";

const THINK_WORKSPACE_PATH_TAIL = /\/(?:stock-copilot\/)?workspace\/(files|file)$/;

/**
 * Match the reserved workspace path tail (`/workspace/files` or `/workspace/file`)
 * under any routing prefix. Returns `"files"`, `"file"`, or `null`.
 */
export function thinkWorkspaceEndpointFromPath(pathname: string): "files" | "file" | null {
  const match = THINK_WORKSPACE_PATH_TAIL.exec(pathname);
  if (!match) return null;
  return match[1] === "files" ? "files" : "file";
}

/**
 * Canonicalize a user- or tool-supplied workspace path into `/workspace/...`
 * while rejecting directory traversal (`..`) and returning candidate paths
 * for Think's `_hostReadFile` / `_hostWriteFile` / `_hostDeleteFile`.
 */
export function resolveThinkWorkspacePath(
  rawPath: string
): { ok: true; path: string; candidates: string[] } | { ok: false; error: string } {
  if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, error: "Workspace path must be a non-empty string." };
  }
  const normalizedSlashes = rawPath.trim().replace(/\\/g, "/");
  const rawSegments = normalizedSlashes.split("/").filter(Boolean);
  if (rawSegments.some((seg) => seg === "..")) {
    return { ok: false, error: "Invalid workspace path: directory traversal ('..') is not permitted." };
  }
  const cleanSegments = rawSegments.filter((seg) => seg !== ".");
  if (cleanSegments.length === 0) {
    return { ok: true, path: THINK_WORKSPACE_ROOT, candidates: [THINK_WORKSPACE_ROOT, "/"] };
  }
  const startsWithWorkspace = cleanSegments[0] === "workspace";
  const canonicalPath = startsWithWorkspace
    ? "/" + cleanSegments.join("/")
    : `${THINK_WORKSPACE_ROOT}/${cleanSegments.join("/")}`;
  const relativeFromWorkspace = startsWithWorkspace
    ? "/" + cleanSegments.slice(1).join("/")
    : "/" + cleanSegments.join("/");
  const candidates = Array.from(
    new Set([canonicalPath, relativeFromWorkspace, relativeFromWorkspace.slice(1)].filter(Boolean))
  );
  return { ok: true, path: canonicalPath, candidates };
}

/** Safe basename for Content-Disposition and file metadata. */
export function thinkWorkspaceFileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "workspace-file.txt";
  return last.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Content-Type header for raw/download workspace file responses. */
export function thinkWorkspaceContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** Standard view & download URLs for a canonical workspace path. */
export function thinkWorkspaceUrls(canonicalPath: string): { viewUrl: string; downloadUrl: string } {
  const encoded = encodeURIComponent(canonicalPath);
  return {
    viewUrl: `/api/workspace/file?path=${encoded}&raw=1`,
    downloadUrl: `/api/workspace/file?path=${encoded}&download=1`,
  };
}

