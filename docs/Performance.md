# Performance architecture

## All-time statistics preparation

After startup data is ready, a three-second grace period starts an all-time statistics
warm-up. It reads history in pages, yields during deserialization and calculation,
and pauses while the app is inactive or in the background. This is cooperative work
on the JavaScript thread, not a separate native worker. Checkpoints target four
milliseconds of work, then schedule a native idle task. The idle deadline also
allows higher-priority UI work to interrupt a slice early. Environments without
`requestIdleCallback` fall back to timers. An individual model operation or sort
can exceed the budget.
Foreground requests promote the shared job to a 16 ms budget rather than waiting
at background priority. Small series operations are checked in groups of 32 points.

The store retains one calculated result, keyed by completed-history revision, weight
unit and today's date. It does not populate the global history map. Workout edits,
deletions, imports and active-workout changes invalidate the snapshot and debounce
a new warm-up. Edits to the excluded active workout do not restart preparation;
finishing it or changing which workout is active does. An early all-time request shares the running job. A completed job
can serve the request immediately; failed jobs remain retryable. Range changes
do not replace the prepared all-time result.

The cache lasts only for the current process; subsequent history edits require fresh preparation.

Startup loads the active workout and exercise catalogs. Completed history remains in SQLite,
with indexed queries for history pages and progression rather than eager whole-history hydration.
Session writes and index backfill are serialized; live edits take precedence over stored projections.
