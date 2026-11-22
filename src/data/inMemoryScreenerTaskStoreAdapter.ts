/**
 * Issue #6072 (#4437 slice 6d-a) — the in-memory `ScreenerTaskStore`:
 * the test / non-D1 implementation of the ledger's port, mirroring
 * the D1 adapter's key shape (the `screener:` namespace the
 * DO-storage implementation prefixes with is stripped on read, so
 * callers see exactly the keys they wrote). No persistence — entries
 * live in the store instance.
 */
import type { ScreenerTaskStore } from "../services/screenerTaskLedger";

/** The `screener:` namespace the DO-storage implementation prefixes with. */
const KEY_NAMESPACE = "screener:";

function namespaced(key: string): string {
  return key.startsWith(KEY_NAMESPACE) ? key : `${KEY_NAMESPACE}${key}`;
}

function denamespaced(key: string): string {
  return key.startsWith(KEY_NAMESPACE) ? key.slice(KEY_NAMESPACE.length) : key;
}

export class InMemoryScreenerTaskStore implements ScreenerTaskStore {
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.entries.get(namespaced(key)) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.entries.set(namespaced(key), value);
  }

  async list(prefix: string): Promise<Array<{ key: string; value: string }>> {
    const wanted = namespaced(prefix);
    const out: Array<{ key: string; value: string }> = [];
    for (const [key, value] of this.entries) {
      if (key.startsWith(wanted)) out.push({ key: denamespaced(key), value });
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(namespaced(key));
  }
}
