### Changed

- Stock Hub new-screen form gains "Schedule this screen": a capture strip
  (cadence picker + snapshot summary) creates a durable market-screen
  schedule from the form's exact criteria via POST /api/schedules/create
  (issue #4432, S4c). An applied preset arms the schedule with presetId
  (resolved at fire time); a manual criteria edit disarms it. Broker/mode
  stay server-resolved live tenant selections; no broker/mode/provider
  claims are sent from the bridge.
