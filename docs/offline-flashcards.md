# Offline flashcards

The flashcard app lives in this repository and uses the existing host and knowledge graph. It has no separate mobile service or database server. The phone stores its downloaded catalog and pending reviews in IndexedDB; the host stores `flashcards.json` beside the existing learning data.

## Install and use

1. Connect Tailscale on iPhone. Open your own LearnHarness host’s `/review/index.html` URL in Safari.
2. Choose Share → Add to Home Screen → Open as Web App (if offered). Open the installed app while online and wait for **Offline ready**.
3. Recall the card, reveal the answer, then choose Again, Hard, Good, or Easy. The next card appears only after the review commits to local storage.
4. Downloaded cards and scheduling work on the subway. Open the app again when the host is reachable; reconnect, foregrounding, and Sync now trigger synchronization. iOS does not need to run the app while it is closed.

Each graph proposition becomes an Explain card, grouped by its region or lesson. All imported cards start new: prior reading and chat activity are not invented recall grades. New material appears after syncing. The initial daily new-card target is 20; learning cards remain available when due. The original logo is reused.

Safari and the installed app may have separate storage. Prepare the installed app online before relying on it offline. Browser storage is best effort: do not clear website data with pending reviews. The app requests persistent storage when available and offers **Back up pending reviews** when needed. This export is a recovery record, not an automatic import flow.

## Scheduling provenance

`vendor/fsrs/manifest.json` pins Anki 26.09.3 (commit `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`) and the exact upstream Rust `fsrs` 6.6.2 crate/checksum from its Cargo.lock. `engine.wasm` compiles that unmodified FSRS implementation with a thin JSON ABI adapter. The browser and host load the same SHA-256-verified binary. There is no approximate JavaScript scheduler fallback.

The surrounding policy uses 90% desired retention, 1-minute/10-minute learning steps, a 10-minute relearning step, 4am America/New_York day boundaries, and Anki's passing-interval floors. Fuzz is deliberately disabled so offline/host replay is deterministic. The FSRS engine is the same; the whole Anki desktop queue, per-user optimizer, import/export formats, and all deck options are not reproduced. The pinned default model weights are used.

Sources: [Anki Cargo.lock](https://github.com/ankitects/anki/blob/26.09.3/Cargo.lock), [Anki scheduling states](https://github.com/ankitects/anki/tree/26.09.3/rslib/src/scheduler/states), [FSRS Rust](https://github.com/open-spaced-repetition/fsrs-rs).

## Durability and sync

- One IndexedDB read/write transaction allocates the device sequence and persists a UUID review before advancing. Tabs share that transaction boundary and reject grading an obsolete schedule.
- The host validates the whole batch, checks UUID and device/sequence collisions, and atomically writes/fsyncs/renames its archive before returning receipts. Retrying a committed review is idempotent.
- Contiguous receipt watermarks plus sparse sequences handle out-of-order batches. The phone removes only acknowledged events; stale responses cannot roll back its snapshot or delete newer pending reviews.
- Host schedules replay immutable review events in deterministic timestamp/device/sequence/ID order. Concurrent devices can temporarily show provisional schedules until sync converges. The new-card target is advisory across disconnected devices.
- Card IDs remain stable; exact card versions and retired cards remain in history. A downloaded old version can sync after a graph edit.
- Reviews retain device time, calibrated time, host receipt time, rating, card version, engine ID, shown/reveal timestamps, and visible foreground duration. Foreground duration is not an attention measurement. Implausible times are bounded for scheduling while preserving the raw event.
- Unknown data/protocol versions or corrupt storage are rejected, never silently reset. Engine changes require an explicit compatibility/migration plan; old offline reviews are not silently interpreted under a different engine.
- Service-worker caches cover `/review/` only, including the actual engine, math fonts, and shell. API responses and the rest of LearnHarness are not cached. Updates preserve IndexedDB and retain one prior shell cache. The UI offers a reload after an update.
- The existing learning-history JSON export includes the flashcard archive.

## Maintenance

`web/review/` is a small static TypeScript composition root. It shares `src/core/review.ts` and `src/core/review-engine.ts` with the host; filesystem writes remain in `src/store/review.ts`. Routes use the existing server barrel. Existing KaTeX renders math safely. The only new npm packages are pinned build/test dependencies, esbuild and fake-indexeddb.

Normal `npm run dev`, `npm run build`, and desktop packaging build the offline assets automatically. Rust is not required for normal builds or runtime. `public/review/` is generated; keep the sources, vendored engine, Cargo.lock, notices, native reference vectors, and manifest under version control.

For an intentional engine upgrade, inspect the chosen Anki release's Cargo.lock, update the pinned crate/toolchain and provenance, regenerate dependency notices, run `npm run review:engine`, then run the review tests and browser offline/update checks. The engine build uses a temporary Cargo target outside the repo. A version upgrade must explicitly address pending events and archive replay compatibility before deployment.

Checks: native Rust reference vectors against the browser/Node WASM, learning/lapse/DST boundaries, actual IndexedDB transaction tests, retries/collisions/out-of-order receipts, card revisions, corrupt/newer archives, and isolated-store replay. Browser checks exercise offline reload, math, reconnect, lost-response retry, and update durability. A real iPhone Safari installation remains a device acceptance check.

## Automatic LaTeX on new cards

Lesson and notes extractors both author graph statements as LaTeX-bearing flashcard answers. The shared submit validator rejects clear mathematical notation outside delimiters, unclosed math, and formulas the existing KaTeX renderer cannot parse (after the same display-only escape repair used on the phone). Literal code is excluded. Validation uses the existing submit-agent error/retry channel: normal successful extraction adds no extra model call; an invalid submission gets actionable feedback within the existing four-turn budget. Only a corrected submission can reach the graph and become a card. Exhausted retries leave the source uncovered for a later attempt; existing cards, reviews, and schedules are untouched.

This check recognizes clear notation such as subscripts, powers, equations, Greek variables, operators, and numeric fractions; it does not try to infer mathematics from ambiguous ordinary prose or verify the mathematical truth of a claim. Authoring instructions still require all mathematical variables and expressions to use LaTeX. The validator and renderer share the same KaTeX dependency, and regression tests exercise both creation paths.
