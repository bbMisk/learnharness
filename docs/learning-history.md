# Learning history

Settings → General → Learning history → Export JSON downloads the current raw history. `GET /api/learning-history` returns the same versioned JSON. `?chatId=<id>` selects a session; `?download=1` requests a download. `POST /api/learning-history` idempotently archives the currently available transcript facts. These are private routes behind the existing remote-access boundary.

Each chat optionally stores `learningEvents` alongside its transcript. `saveMessages` captures both the old and new message lists before one atomic chat-file replacement. A repeated save cannot duplicate events, and shortening/compacting the transcript cannot erase captured events. Sidebar summaries exclude the log; the export is its dedicated read surface. Existing messages can be captured with `captureChatLearningHistory(id)` without changing chat activity dates.

An event contains:

- `version`, stable event `id`, `kind`, and originating `messageId`.
- `at`: the original native-message timestamp in UTC, or null when unavailable.
- `itemId`: a specific posed question/problem instance, distinct from a future reusable card.
- Explicit `graphNodeIds`, with session-plan references separately in `planNodeId`.
- A frozen `payload`: the original question input, answer/confidence/thinking, practice submission, conclusion or learner message text. Binary attachments are not duplicated.
- `outcome` when recorded: correct, incorrect, don't-know, dismissed, ungraded, or the practice agent's original conclusion such as solvedWithHints.

The event vocabulary covers question poses/answers, successful practice poses/conclusions, practice thinking/dismissals, and learner messages. Failed tool calls and synthetic question acknowledgements are excluded. Outcomes describe the existing recorded assessment; they are not a fresh verification of the grading. Practice agent judgments remain distinguishable from quiz results through event kind and tool.

The export also includes graph propositions with stable IDs and imported-source metadata. A notes import is **not** counted as study, recall, or mastery. Region display names never replace file paths. Reimporting a source keeps its human display name.

## Limits and future spaced repetition

Native timestamps do not measure when the learner saw a question, active study duration, or time spent thinking. Client `answeredAt` is preserved in the answer payload; the top-level event time uses the native message timestamp. Missing times stay unknown. Old facts already absent from the stored transcript cannot be reconstructed. Capture begins with the evidence still available.

Confidence and correctness are not Anki Again/Hard/Good/Easy ratings. No FSRS rating, due date, interval, difficulty or memory stability is fabricated. Questions linked only to session-plan nodes are not silently credited to graph concepts. A future review system must establish explicit reusable card identities and concept links.

For offline-capable phone flashcards, use the same repository and backend with a mobile review view, a cached card set, and an IndexedDB outbox. Every review attempt needs a fresh UUID, stable card ID and card revision, device ID, client occurrence time, server receipt time, and an explicit self-rating. Sync uploads attempts idempotently and acknowledges them only after durable storage. The server deduplicates and recomputes scheduling from accepted attempts; devices do not overwrite each other's due dates. New event kinds/fields can be added to this raw history without coupling the archive to one scheduler implementation.

Normal online study can use the host immediately; subway reviews use cached cards and a persistent outbox. Reconnection, app termination, duplicate retries, stale card versions, clock skew, and concurrent device reviews require tests before calling offline sync complete. iOS can reclaim browser storage, so unsynced browser data is not an absolute durability guarantee. An explicitly cached deck and a visible pending-sync count are preferable to promising every card is always offline.

Online multiple-choice questions can reuse the current engine. Start with iOS keyboard dictation in the thinking field; custom microphone recording needs real-device permission, interruption and background/resume testing. AI generation/feedback stays on the host; offline review operates on already downloaded cards.

No new scheduler, database, service, or package is introduced by this foundation.
