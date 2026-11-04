### Added

- #2869 slice 1 follow-up: after a queued analysis-done consume generates a PDF (in-process leg failed, claim released), the canonical mas_reports row's PDF fields are refreshed through the one recorder (update-only, monotonic backfill, owner re-checked; R2-pointer rows refreshed at the same pointer, never a new object). Duplicate-suppressed consumes refresh nothing, and a refresh failure never fails the queue ack.
