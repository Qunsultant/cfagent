### Added

- **Rebalance drift proposals, DRAFT-only (#1771 slice C, parent #1717):** pure `src/orchestrations/rebalanceProposals.ts` (`computeRebalanceProposals`) sizes buy/sell quantities that would restore target weights (hold below the drift threshold, unlisted holdings named with no proposal, bad target sums and bad prices throw naming the problem). Registry entry `portfolio-rebalancing` flipped to enabled in its DRAFT-only form: the module places, previews, and submits no order — any execution still requires the trade-approval workflow.
