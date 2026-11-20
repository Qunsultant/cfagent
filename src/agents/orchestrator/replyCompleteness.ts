/**
 * Issue #5899: runtime detector and deterministic closing-summary builder
 * for the final-reply contract (FINAL_REPLY_CONTRACT in ../chatPrompt.ts).
 * Pure, agent-agnostic: reads the finished assistant message's parts,
 * detects whether the turn ended on a real answer, and synthesizes a
 * complete, count-consistent closing receipt when the model stopped after
 * tool calls without writing one.
 */
export interface ReplyCompleteness {
  complete: boolean;
  reason: "ok" | "no_text" | "ended_on_tool" | "announcement_only";
  toolCalls: number;
}

type Part = {
  type?: string;
  text?: string;
  toolName?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  toolInvocation?: {
    toolName?: string;
    args?: unknown;
    result?: unknown;
  };
};

const isToolPart = (p: Part): boolean =>
  typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");

/** Trailing punctuation that marks a promise rather than an answer. */
const ANNOUNCEMENT_TAIL = /(?::|…|\.{3})\s*$/;

export function assessReplyCompleteness(message: unknown): ReplyCompleteness {
  const parts = ((message as { parts?: Part[] } | null)?.parts ?? []).filter((p) => p && typeof p === "object");
  const toolCalls = parts.filter(isToolPart).length;
  if (toolCalls === 0) return { complete: true, reason: "ok", toolCalls };

  const lastToolIdx = parts.map(isToolPart).lastIndexOf(true);
  const trailingText = parts
    .slice(lastToolIdx + 1)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  if (trailingText) return { complete: true, reason: "ok", toolCalls };

  const anyText = parts.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim());
  if (!anyText) return { complete: false, reason: "no_text", toolCalls };
  const lastText = [...parts].reverse().find((p) => p.type === "text" && p.text?.trim());
  if (lastText && ANNOUNCEMENT_TAIL.test(lastText.text ?? "")) {
    return { complete: false, reason: "announcement_only", toolCalls };
  }
  return { complete: false, reason: "ended_on_tool", toolCalls };
}

function cleanToolName(part: Part): string {
  const raw =
    part.toolInvocation?.toolName ||
    part.toolName ||
    part.name ||
    (typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : part.type) ||
    "tool";
  return String(raw).replace(/^tool[-_]/, "").replace(/^openaimp_/, "");
}

function summarizeOneToolPart(part: Part, index: number): string {
  const name = cleanToolName(part);
  const out = (part.toolInvocation?.result ?? part.output ?? part.result ?? null) as Record<string, unknown> | null;
  const inp = (part.toolInvocation?.args ?? part.input ?? null) as Record<string, unknown> | null;
  const data = (out && typeof out === "object" ? out : inp && typeof inp === "object" ? inp : {}) as Record<string, unknown>;

  const symbol = data.symbol ?? inp?.symbol;
  const side = (data.side ?? data.action ?? inp?.side ?? inp?.action) as string | undefined;
  const qty = data.qty ?? data.quantity ?? inp?.qty ?? inp?.quantity;
  const orderType = (data.type ?? data.orderType ?? data.order_type ?? inp?.type ?? inp?.orderType ?? inp?.order_type) as string | undefined;
  const limitPrice = data.limit_price ?? data.limitPrice ?? inp?.limit_price ?? inp?.limitPrice;
  const orderId = data.orderId ?? data.draftId ?? data.id ?? data.jobId;
  const status =
    data.status ??
    (data.success === true ? "completed" : data.success === false ? "failed" : undefined) ??
    (part.error ? "failed" : out ? "completed" : "submitted");
  const msg =
    (typeof data.message === "string" && data.message.trim()) ||
    (typeof data.error === "string" && data.error.trim()) ||
    (typeof part.error === "string" && part.error.trim()) ||
    undefined;

  const details: string[] = [];
  if (side && symbol) {
    details.push(`${String(side).toUpperCase()}${qty !== undefined ? ` ${qty}` : ""} ${String(symbol).toUpperCase()}`);
  } else if (symbol) {
    details.push(String(symbol).toUpperCase());
  }
  if (orderType) details.push(String(orderType).toUpperCase());
  if (limitPrice !== undefined && Number.isFinite(Number(limitPrice))) {
    details.push(`@ $${Number(limitPrice).toFixed(2)}`);
  }
  if (orderId) details.push(`ID \`${String(orderId)}\``);
  if (status) details.push(`status: **${String(status)}**`);
  if (msg) details.push(`— ${msg}`);

  return details.length > 0
    ? `${index + 1}. \`${name}\`: ${details.join(" · ")}`
    : `${index + 1}. \`${name}\`: status **${String(status)}**`;
}

/**
 * Deterministic closing summary when a turn ended on tool calls without a
 * final reply, or when an announcement stated a count that disagrees with
 * the actual number of tool calls made. Returns null when the reply is
 * already complete.
 */
export function synthesizeToolTurnSummary(message: unknown): string | null {
  const completeness = assessReplyCompleteness(message);
  if (completeness.complete) return null;
  const parts = ((message as { parts?: Part[] } | null)?.parts ?? []).filter((p) => p && typeof p === "object");
  const toolParts = parts.filter(isToolPart);
  if (toolParts.length === 0) return null;
  const lines = toolParts.map((p, idx) => summarizeOneToolPart(p, idx));
  const noun = toolParts.length === 1 ? "1 tool call" : `${toolParts.length} tool calls`;
  return `Completed ${noun}:\n${lines.join("\n")}`;
}

export function auditReplyCompleteness(
  message: unknown,
  turn: { requestId: string; route?: { agent?: string } },
  audit: (type: string, agent: "orchestrator", payload: Record<string, unknown>) => void,
): void {
  const completeness = assessReplyCompleteness(message);
  if (!completeness.complete) {
    audit("chat.reply_incomplete", "orchestrator", {
      requestId: turn.requestId,
      agent: turn.route?.agent,
      reason: completeness.reason,
      toolCalls: completeness.toolCalls,
    });
  }
}
