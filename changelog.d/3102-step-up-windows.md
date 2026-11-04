### Added

- **Step-up windows per action (#945 Q4, #3102):** the epic §4 actions
  now carry their own freshness windows (5 min for privileged role
  assignment, integration-credential management, auth-method change,
  provider linking, and payment-configuration change; 10 min for
  sensitive export; 15-min settled default as fallback), enforced at
  role-grants/grant, membership/grant, bootstrap-proposals/approve,
  privacy/export, and api-keys mint (retimed from the default).
  Legacy sessions (no `authTimeMs`) are stale for every step-up
  action. Durable answer: `docs/architecture/security/step-up-windows-3102.md`.
  #CISO-bhdm
