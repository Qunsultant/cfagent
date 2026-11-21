### Changed

- Stock screens now honour the exchange filter on the live-quote paths (etrade-only, live-quotes, Yahoo): an `exchange=NYSE` run quotes and screens only NYSE-listed symbols, and the applied exchange is stamped on the run record's filter summary. Runs whose saved presets or schedules set an exchange will narrow to what was actually asked for.
