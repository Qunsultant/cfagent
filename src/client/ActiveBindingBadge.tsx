/**
 * Active-binding badge (issue #5099, F2 of #5094).
 *
 * The one-line "which account is this surface using?" display, mounted
 * beside the existing broker/mode badges on every surface that carries a
 * binding (BrokerDynamicMenu header, order ticket, schedule dialog,
 * portfolio / account views). It reads the shared store
 * (`useActiveAccountBinding`), so a binding change anywhere re-renders
 * every open surface — no surface keeps a stale binding.
 *
 * - Bound: `<accountType label> ••••<last 4>` (masked via `maskAccountId`).
 * - Not bound: "No account bound" — never a silent default.
 * - `override`: a form-level account override (the schedule dialog's
 *   per-schedule account) replaces the stored binding in the display,
 *   so the display and the submitted payload agree.
 * - Change: dispatches the existing `open-settings-menu` event, which
 *   toggles the settings menu carrying the AccountBindingSelector (the
 *   same event the menu's own Change action uses). Surfaces inside the
 *   settings panel pass their own `onChangeRequest` instead — dispatching
 *   the toggle there would close the panel.
 */
import { Badge, Button, Flex } from "./components/ui";
import { maskAccountId } from "../config/accountBindings";
import type { AccountType } from "../trading";
import { useActiveAccountBinding, type AccountBindingScope, type TradingType } from "./accountBindingStore";

export interface ActiveBindingBadgeProps {
  broker: string;
  mode: TradingType;
  accountType: AccountType;
  scope: AccountBindingScope;
  /**
   * A form-level account override (schedule dialog). When set, the badge
   * shows this account instead of the stored binding.
   */
  override?: { accountId: string; accountType: AccountType } | null;
  /** Defaults to dispatching `open-settings-menu` on window. */
  onChangeRequest?: () => void;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  stock: "Stock",
  options: "Options",
  forex: "Forex",
  futures: "Futures",
  crypto: "Crypto",
  ira: "IRA",
  margin: "Margin",
  cash: "Cash",
};

function accountTypeLabel(accountType: string): string {
  return ACCOUNT_TYPE_LABELS[accountType] ?? accountType;
}

/**
 * Issue #5102 (F5 of #5094) — the RECORDED binding label for a
 * history row (run ledger, docs row, trade row, audit event).
 *
 * The badge above is store-driven: it shows the binding that is
 * LIVE right now, with a Change affordance for it. A history row
 * must show the tuple the record STAMPED, not today's binding, and
 * must not offer to change today's binding from a historical row —
 * so rows render this label (same type label + `maskAccountId`
 * rendering as the badge) inside a plain Badge, never the badge
 * itself. Unbound rows read "Unbound", never a blank cell.
 */
export function formatRecordBindingLabel(binding: {
  accountType?: string | null;
  accountId?: string | null;
} | null | undefined): string {
  if (!binding?.accountId) return "Unbound";
  return `${accountTypeLabel(binding.accountType ?? "")} ${maskAccountId(binding.accountId)}`;
}

export function ActiveBindingBadge({
  broker,
  mode,
  accountType,
  scope,
  override,
  onChangeRequest,
}: ActiveBindingBadgeProps) {
  const { found, binding, loaded } = useActiveAccountBinding({ broker, mode, accountType, scope });

  const shownAccountId = override?.accountId ?? (found ? binding?.accountId : undefined);
  const shownAccountType = override?.accountType ?? accountType;
  const label = shownAccountId
    ? `${accountTypeLabel(shownAccountType)} ${maskAccountId(shownAccountId)}`
    : loaded
      ? "No account bound"
      : "Loading account…";

  const handleChange = () => {
    if (onChangeRequest) {
      onChangeRequest();
      return;
    }
    window.dispatchEvent(new CustomEvent("open-settings-menu"));
  };

  return (
    <Flex gap="1" align="center" wrap>
      <Badge tone={shownAccountId ? "info" : "warning"} size="sm" title={`Active account binding for ${accountTypeLabel(shownAccountType)} (${broker}, ${mode})`}>
        {label}
      </Badge>
      <Button variant="secondary" size="sm" onClick={handleChange} title="Change the active account binding in Settings">
        Change
      </Button>
    </Flex>
  );
}
