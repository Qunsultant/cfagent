/**
 * Inline account selector (issue #6153, follow-on of F2 #5099).
 *
 * The order ticket's compact way to switch the bound account in place,
 * beside the ActiveBindingBadge display. It renders ONLY when the
 * broker's accounts enumerate — when the accounts read fails, is gated
 * off, or serves another broker, it renders nothing and the badge +
 * Change remain the only path (no new failure mode).
 *
 * One source of truth: the shared `accountBindingStore` — the selected
 * value is the store's resolved binding (`useActiveAccountBinding`), the
 * options are the store's `fetchBrokerAccounts`, and a switch goes
 * through the store's `switchAccountBinding` (optimistic adopt, revert
 * on a server refusal, same validation seam as the settings-menu
 * selector's save). No new store, no new route, no new fetch path.
 *
 * - Bound: the bound account is selected (added to the options when the
 *   enumeration no longer lists it, so the Select never shows blank).
 * - Unbound: a "No account bound — select an account" placeholder is
 *   selected; picking an account binds it.
 * - Options are masked (`••••<last 4>`, with the account name when the
 *   enumeration carries one) — never a full id in the UI.
 * - No client-side account-type filtering: the server validates the
 *   tuple on switch (`validateAccountAgainstBroker`); a mismatch
 *   surfaces as the server's coded error in a Notice and the store
 *   reverts, so the Select falls back to the previous account.
 */
import React, { useEffect, useState } from "react";
import { Notice, Select, Stack } from "./components/ui";
import { maskAccountId } from "../config/accountBindings";
import type { AccountType } from "../trading";
import {
  fetchBrokerAccounts,
  switchAccountBinding,
  useActiveAccountBinding,
  type AccountBindingScope,
  type BrokerAccountOption,
  type TradingType,
} from "./accountBindingStore";

export interface InlineAccountBindingSelectorProps {
  broker: string;
  mode: TradingType;
  accountType: AccountType;
  scope: AccountBindingScope;
}

function optionLabel(account: BrokerAccountOption): string {
  const masked = maskAccountId(account.accountId);
  return account.accountName ? `${account.accountName} (${masked})` : masked;
}

export function InlineAccountBindingSelector({
  broker,
  mode,
  accountType,
  scope,
}: InlineAccountBindingSelectorProps) {
  // undefined = accounts read still in flight; null = read unavailable
  // (failed / gated / wrong broker) — render nothing in both cases
  // until options exist; the badge already shows the loading state.
  const [accounts, setAccounts] = useState<BrokerAccountOption[] | null | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { found, binding } = useActiveAccountBinding({ broker, mode, accountType, scope });

  useEffect(() => {
    let active = true;
    setAccounts(undefined);
    setError(null);
    fetchBrokerAccounts()
      .then((read) => {
        if (!active) return;
        // The F2 save's rule: the read only validates when it serves
        // this broker — otherwise the selector has no options to offer.
        setAccounts(read && read.broker === broker ? read.accounts : null);
      })
      .catch(() => {
        if (active) setAccounts(null);
      });
    return () => {
      active = false;
    };
  }, [broker]);

  if (!accounts || accounts.length === 0) return null;

  const boundAccountId = found ? binding?.accountId : undefined;
  const options =
    boundAccountId && !accounts.some((a) => a.accountId === boundAccountId)
      ? [
          ...accounts,
          {
            accountId: boundAccountId,
            ...(binding?.accountName ? { accountName: binding.accountName } : {}),
            broker,
          },
        ]
      : accounts;

  const handleChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const accountId = event.target.value;
    if (!accountId) return;
    const selected = options.find((a) => a.accountId === accountId);
    if (!selected) return;
    setSwitching(true);
    setError(null);
    const result = await switchAccountBinding(
      {
        broker,
        mode,
        accountType,
        accountId: selected.accountId,
        ...(selected.accountName ? { accountName: selected.accountName } : {}),
      },
      accounts,
    );
    setSwitching(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <Stack gap="1">
      <Select
        label="Account"
        aria-label="Account"
        value={boundAccountId ?? ""}
        disabled={switching}
        onChange={(event) => void handleChange(event)}
      >
        {!boundAccountId && <option value="">No account bound — select an account</option>}
        {options.map((account) => (
          <option key={account.accountId} value={account.accountId}>
            {optionLabel(account)}
          </option>
        ))}
      </Select>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Stack>
  );
}
