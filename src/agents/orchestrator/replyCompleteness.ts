/**
 * Issue #5899: runtime detector for the final-reply contract
 * (FINAL_REPLY_CONTRACT in ../chatPrompt.ts). Pure, agent-agnostic: it reads
 * the finished assistant message's parts and reports whether the turn ended
 * on a real answer. Used by every turn, not one agent.
 */
export interface ReplyCompleteness {
  complete: boolean;
  reason: "ok" | "no_text" | "ended_on_tool" | "announcement_only";
  toolCalls: number;
}

type Part = { type?: string; text?: string };

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
