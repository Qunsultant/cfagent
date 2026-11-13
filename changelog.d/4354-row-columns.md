### Changed

- **A schedule row fits, and its scope reads in full (#4348 S6e, #4354):** the scope cell no longer cuts its value at 90 characters with an ellipsis — the `taskId` and `scheduleHash` an operator needs are all there, wrapping inside the cell. The cadence column (220px) and the scope column (260px) get a floor, so a value holds its line instead of pushing the row to three-plus lines; the table keeps its horizontal scroll, so a wide row is scrolled, never clipped. #autoclaw-001
