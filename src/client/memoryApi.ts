/**
 * Issue #164: client API for the VectorMemory browser.
 */
import { csrfHeaders } from "./apiFetch";

export interface MemoryChunk {
  summary: string;
  operation: string;
  success: boolean;
  score: number;
}

export async function searchMemory(
  query: string,
  opts: { topK?: number; operationFilter?: string } = {}
): Promise<{ chunks: MemoryChunk[] }> {
  const response = await globalThis.fetch("/api/memory/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({
      query,
      topK: opts.topK ?? 10,
      operationFilter: opts.operationFilter,
    }),
  });
  const data = (await response.json()) as { chunks?: MemoryChunk[]; error?: string };
  if (!response.ok) throw new Error(data.error || "Memory search failed.");
  return { chunks: data.chunks || [] };
}
