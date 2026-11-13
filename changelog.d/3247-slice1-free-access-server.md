### Free-for-lifetime / free-for-a-limited-time: server delivery

- Free-access grants are now stored and managed server-side: a new `agent_free_access_grants` table with a grant/revoke history, operator-only grant and revoke routes, and an own-or-operator read route. A grant records free access for one login (lifetime, or a limited window) and is revocable; it confers no tier, no included runs, and makes no run free — the gate is unchanged. The operator UI and the upgrade-offer mention light up in slice 2.
