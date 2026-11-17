### Changed

- **One run-broker context instead of four answers (#5188, slice 2 of #5187):** a job no longer decides which broker it runs against. `resolveRunBrokerContext` (`src/services/runBrokerContext.ts`) resolves `{ broker, mode, modeSource, account }` once — caller selection → schedule selection → tenant broker — fails closed when the mode cannot be resolved, and refuses a broker that does not declare the capability the job requires. The scheduled options firer now consumes it, so its dispatch, its broker stage input and (next) the run record and alerts all read one value.
