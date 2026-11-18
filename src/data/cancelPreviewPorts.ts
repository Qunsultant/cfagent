/**
 * Issue #5034 — Port & in-memory adapter for `mas_cancel_previews` (#3885).
 */
export const CANCEL_ALL_PREVIEW_TTL_MS = 120_000;

export interface CancelPreviewRecord {
  token: string;
  ids: string[];
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface CancelPreviewStore {
  save(record: Omit<CancelPreviewRecord, "usedAt">): void;
  find(token: string): CancelPreviewRecord | null;
  markUsed(token: string, usedAt: string): void;
}

export function createInMemoryCancelPreviewStore(): CancelPreviewStore {
  const rows = new Map<string, CancelPreviewRecord>();
  return {
    save(record) {
      rows.set(record.token, { ...record, usedAt: null });
    },
    find(token) {
      return rows.get(token) ?? null;
    },
    markUsed(token, usedAt) {
      const existing = rows.get(token);
      if (existing) existing.usedAt = usedAt;
    },
  };
}
