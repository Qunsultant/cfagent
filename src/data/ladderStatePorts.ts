/**
 * Issue #5034 — Port & in-memory adapter for `mas_ladder_states` (#3887).
 */
export interface StoredLadderRung {
  rungIndex: number;
  limitPrice: number;
  quantity: number;
  orderId: string | null;
  clientOrderId: string;
}

export interface StoredLadderState {
  ladderId: string;
  symbol: string;
  entryMode: "baseBreakout";
  specJson: string;
  planJson: string;
  placed: StoredLadderRung[];
  committedNotional: number;
  stoppedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LadderStateStore {
  save(state: StoredLadderState): void;
  load(ladderId: string): StoredLadderState | null;
}

export function createInMemoryLadderStateStore(): LadderStateStore {
  const rows = new Map<string, StoredLadderState>();
  return {
    save(state) {
      rows.set(state.ladderId, {
        ...state,
        placed: state.placed.map((r) => ({ ...r })),
      });
    },
    load(ladderId) {
      return rows.get(ladderId) ?? null;
    },
  };
}
