### Changed

- **The PR shards wait for the cheap gate (#3924):** 	est-shard-pr now needs ast-gates, so a typecheck, build or pin-suite failure stops the run instead of spending four runners on a ten-minute test pass first.
- **The vitest transform cache is shared across jobs (#3924):** 
ode_modules/.vite is cached on the lockfile plus source/test hashes and restored in Fast gates and the PR shards. Transforming the module graph was 40-60% of wall time locally, and every job was paying it independently.
- **The wrangler step validates instead of printing a version (#3924):** 
px wrangler --version became 
px wrangler deploy --dry-run, which builds the Worker configuration (bindings, migrations, assets) without deploying and fails on an invalid wrangler.jsonc.
