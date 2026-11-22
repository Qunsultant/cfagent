### Added

- Active account-binding display on every surface that carries a binding: the BrokerDynamicMenu header, order ticket, schedule dialog, and portfolio / account views now show the bound account (masked) beside the broker/mode badges, backed by one shared client store so a binding change re-renders every open surface (#5099).
- Schedule payloads for options schedules with a chosen account now carry `{accountType: "options", accountId}`, so the schedule display and the stored payload agree; the options criteria schema accepts the new field (#5099).
- Account-binding saves are validated against the broker's real accounts when the accounts read serves the broker being saved (`availableAccounts` on the PUT); switches adopt optimistically and revert on a server refusal (#5099).
