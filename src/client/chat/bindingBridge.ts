/**
 * Issue #5101 (F4 of #5094): the client bridge between a chat
 * `broker_account_binding` switch and the F2 binding store. The tool
 * result is masked, so a switch is detected from the part shape
 * (tool name + `action: "set"` + `ok: true`) — never from an account
 * id. The caller reloads the store from the server (`fetchAccountBindings(true)`);
 * the masked result itself is never adopted into the cache.
 */
export function messageHasBindingSwitch(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { role?: unknown; parts?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.parts)) return false;
  return m.parts.some((p: any) => {
    const toolName = String(p?.toolInvocation?.toolName || p?.toolName || p?.name || p?.type || "");
    if (!toolName.toLowerCase().includes("broker_account_binding")) return false;
    const result = p?.toolInvocation?.result ?? p?.output ?? p?.result ?? {};
    return result?.action === "set" && result?.ok === true;
  });
}
