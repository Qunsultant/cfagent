/**
 * Issue #3246 (sub-issue of #3241), slice 3 — runs-pack purchase
 * activation.
 *
 * Buying a pack confers NO tier and creates NO subscription row:
 * activation credits the purchased runs to the buyer's dedicated
 * pack balance and nothing else. By construction this service
 * takes only the balance port — it cannot read or write an
 * account tier or a subscription row — so a pack purchase can
 * never change either (the route test pins both unchanged).
 *
 * The caller (the pack confirm route) owns the ordering: payment
 * verified, draft claimed (minted → crediting), account row
 * ensured, then this activation, then the draft marked credited.
 * The draft is the replay guard: a credited draft's confirm
 * returns the same success without re-activating.
 */
import {
  assertRunsPackLogin,
  assertRunsPackRuns,
  type RunsPackBalancePort,
} from "../data/runsPackPorts";

export interface RunsPackActivationResult {
  /** The pack balance after this purchase. */
  packRunsRemaining: number;
}

/** Credit a verified pack purchase to the buyer's pack balance. */
export async function activateRunsPack(input: {
  balance: RunsPackBalancePort;
  login: string;
  runs: number;
}): Promise<RunsPackActivationResult> {
  const login = assertRunsPackLogin(input.login);
  const runs = assertRunsPackRuns(input.runs);
  const packRunsRemaining = await input.balance.addPackRuns(login, runs);
  return { packRunsRemaining };
}
