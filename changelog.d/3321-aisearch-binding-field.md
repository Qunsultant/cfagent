### Fixed

- The `ai_search_namespaces` binding entry in `wrangler.jsonc` now uses the `"binding"` field wrangler's schema requires (issue 3321): the `"name"`-field entry shipped by the 1169 enablement was rejected by the production deploy. The agent-conformance pin asserts the schema shape, so the field cannot regress in the unit suite.
