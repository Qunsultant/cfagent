### Changed

- Corpus indexing is enabled in production (issue 3375): `AI_SEARCH_CORPUS_INDEXING_ENABLED` is now set to "1" in the production Worker vars, so the corpus items-API bridge (issue 3345) is live — corpus writes and corpus syncs also upload each corpus document to the `screener-search` AI Search instance through the namespace binding, and the Search Hub Corpus tab reports per-item indexing state as indexed instead of not-configured. The bridge stays best-effort (a failed upload never fails a corpus write or sync), and rollback is unsetting the var and redeploying.
