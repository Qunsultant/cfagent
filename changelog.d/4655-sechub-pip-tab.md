### Added

- **SecHub PIP tab (Qunsultant/cfagent#4655):** SecurityHub gains a seventh sub-tab (`?tab=security-hub&view=pip`) showing the Policy Information Point's live state — the attribute schema (Membership, RoleBinding, PermissionDenial fields), the attribute sources, and the signed-in user's own memberships and denials via a new session-gated `GET /api/security/pip`. No other user's attributes are readable from the tab; sections with no readable source render honest empty states.
