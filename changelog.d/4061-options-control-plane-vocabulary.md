### Options control-plane vocabulary (#4061)

- Control-plane coverage for the options stage vocabulary (#4061): the seven uniform stage operations (run, re-run, stop, resume, cancel, schedule, re-schedule) now address the 8 options execution stages by (runId, stageId) through the merged #3945 mechanism — the options stage ids name themselves in the engine's one vocabulary walk, with the same named refusals; the display-only ids (feed/store/serve) stay unaddressable.
