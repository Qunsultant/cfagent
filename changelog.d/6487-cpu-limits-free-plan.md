### Deploys work on the Cloudflare Free plan again (#6487)

- **`limits.cpu_ms` is commented out in `wrangler.jsonc`.** Cloudflare rejects the setting on the Free plan (`CPU limits are not supported for the Free plan … [code: 100328]`), so `Deploy Worker` failed on every `main` push since 2026-11-24 23:56Z. The 500ms intent stays recorded in the config comment; restore it (uncomment) when the account moves to a paid plan — an owner decision.
- **No application code changed.** This is the per-request CPU guard, not the startup limit; removing it lets the platform apply its plan default. Re-enabling it on a paid plan is the follow-up recorded on #6487.
