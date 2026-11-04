### Added

- Tenant administration surface (#2221, program #2218 slice 3): a "Tenants" tab on the Platform Admin page with operator-gated tenant create / list / settings / detail routes (`/api/platform-tenants*`), a port-first tenant directory (D1 + in-memory, no new migration), and a read-only membership view from the existing IAAA read path. Membership writes stay on the IAAA Admin tab (CISO lane); the payment screen stays automatic and read-only with no tenant-id input. #CBO-mlops
