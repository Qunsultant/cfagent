### Fixed

Post-deploy QA now asserts the deployed client bundle is the one the deploy built (#3891): the bundle embeds its short commit sha (`__BUILD_COMMIT__`, exposed on `window`), and qa-smoke fetches the built asset from production and fails the job when the asset 404s or carries an older marker — the stale-bundle failure, which the 13084a0 deploy reported as success while serving the aa751785-era bundle, can no longer pass silently.
