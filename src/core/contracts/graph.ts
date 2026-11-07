/**
 * Knowledge-graph contracts — nodes, ledgers, extraction findings
 *
 * The graph vision (docs/archive/vision.md §1): every node is a TRUE
 * proposition; reasoning chains (premises ⟹ conclusion) are the stored
 * structure, edges only a derived view; provenance is message-granular;
 * extraction is free-form and post-hoc, fully decoupled from the session's
 * plan tree. The graph is an extraction of the reasoning chains from all
 * teaching sessions (and imported notes) — NOTHING else: no quiz outcomes,
 * no understanding assessments.
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/archive/vision.md.
 */
// ─── Knowledge graph (vision §1 — global, cross-session) ────────────────────

import type { ExtractionRunUsage } from "./chat.ts";

/** One relation of the DERIVED view — chains are the stored truth (the graph is
 *  a lossy image of what is truly stored), and the snapshot derives UNTYPED
 *  arrows from them: every premise → the chain's implication node, the
 *  implication node → the conclusion. Nothing stores or mutates these — they
 *  are rebuilt after every change and never converted back. */
export interface GraphEdge {
	from: string;
	to: string;
}

/** One stored REASONING CHAIN — an argument: premises that JOINTLY entail the
 *  conclusion. Independent arguments for the same conclusion are separate
 *  chains (they may share `conclusion`); co-premises within one chain are used
 *  TOGETHER. The snapshot derives an implication NODE per chain (id = the chain
 *  id — the arg_ namespace is its own, collision-free with n_) plus untyped
 *  edges premises → imp → conclusion. A chain referencing a dead node dies with
 *  it (full death cascades through every referencing chain). */
export interface GraphChain {
	/** "arg_" + nanoid-like (store-assigned, the node-minting pattern). */
	id: string;
	/** Node ids of the argument's premises — at least one, jointly
	 *  sufficient. Extractor-local at the wire; node ids after resolution. */
	premises: string[];
	/** The node id the premises jointly imply. */
	conclusion: string;
	/** Every (chat, message) point where this argument was asserted —
	 *  unioned across assertion lines at read time. */
	provenance: ProvenancePoint[];
	createdAt: string;
}

/** What one extraction run merged into the graph ledgers — the merger's
 *  output, also persisted in extraction-run usage records (contracts/chat).
 *  `chains` is OPTIONAL IN OLD RECORDS ONLY: older usage history carries
 *  `edges` instead — tolerated at read, never written. */
export interface EmissionStats {
	/** New graph nodes appended. */
	nodes: number;
	/** New reasoning chains appended. */
	chains?: number;
	/** Chains the simplification pass removed in this merge
	 *  (ancestry-cover / prefer-fewest-premises).
	 *  Maintenance, not extraction: appends are counted in `chains`
	 *  regardless. Undefined when nothing dropped (pre-simplification
	 *  records read as zero). */
	droppedChains?: number;
}

/** One provenance point — message-granular: nodes and chains record every
 *  (chat, message) where they came up, deep-linkable to the exact
 *  transcript point. messageId is "" for a chat-level point (chains, notes
 *  imports). */
export interface ProvenancePoint {
	/** The chat this point anchors to — or a notes source id ("src_…"):
	 *  imports carry no message anchors (provenance is the file itself,
	 *  recorded through the source record). */
	chatId: string;
	messageId: string;
}

/** One imported notes file — the format-agnostic front door's bookkeeping:
 *  personal notes in ARBITRARY formats run through the same extractor → auditor
 *  → merger pipeline, with the file itself as the provenance anchor. There is
 *  no chat: the detail card shows the file path as a STATIC entry (not a link).
 *  The run's usage log lives here, mirroring ChatRecord.extractions. Ids are
 *  "src_" + hash of the file path — deterministic, so re-importing the same
 *  file re-runs extraction against the same source id. */
export interface NotesSource {
	id: string;
	filePath: string;
	/** Optional human label; the file path remains the provenance anchor. */
	displayName?: string;
	/** ISO — when this file was imported (the checkpoint's foldedAt). */
	importedAt: string;
	/** Legacy content fingerprint. Accepted when reading old records, but
	 * ignored: every explicit notes import processes the whole file. New
	 * imports do not compute or write this field. No migration is needed. */
	contentFp?: string;
	/** The run's usage log — same append-only discipline as
	 *  ChatRecord.extractions, idempotent per startedAt. */
	extractions?: ExtractionRunUsage[];
}

/** The graph-family format version this build writes and understands
 *  (the format.json sidecar — src/store/graph-format.ts). */
export const CURRENT_GRAPH_FORMAT_VERSION = 1;


export interface GraphNode {
	/** Opaque stable id, store-assigned: "n_" + nanoid-like. */
	id: string;
	/** A very short label for the node — a compact handle like a glossary
	 *  headword ("Will to power", "Divine command theory"): what the graph
	 *  shows at a glance. Presentational only — not unique, not an identity
	 *  key, never precise: the statement carries the precision. Set at
	 *  creation (first line defines); a link-append never changes it. */
	name: string;
	/** The minimal proposition — one true, self-contained statement, at
	 *  full precision. The IDENTITY ANCHOR: the auditor recognizes a
	 *  re-encounter by judgment against this (link-or-create), not by
	 *  string matching. Shown in the detail card; the canvas label is the
	 *  name. */
	statement: string;
	/** Verbatim phrasings sessions used for this proposition (the identity
	 *  audit trail — how the world said what the node says). */
	aliases: string[];
	createdAt: string;
	/** Every (chat, message) point where this proposition came up. */
	provenance: ProvenancePoint[];
}

/** sessions.jsonl line — the whole-source extraction checkpoint, written
 *  by merges that carry no coverage (notes imports: chatId is the "src_"
 *  id). Chat extractions write CoverageEntry lines instead. */
export interface SessionCheckpoint {
	chatId: string;
	/** ISO stamp of the merge (a notes import's importedAt). */
	foldedAt: string;
}

/** coverage.jsonl line (vision-extraction-coverage.md): ONE MESSAGE of one chat
 *  has been extracted — by content fingerprint over exactly what the extraction
 *  view sees. The MESSAGE is the unit of coverage; "uncovered" is derived
 *  (fingerprint the current transcript, diff) — never dual-tracked. A quiz
 *  answer merging into the asking message changes its fingerprint: the message
 *  re-opens itself, only itself. Chat extractions write these instead of
 *  whole-chat checkpoints; notes imports keep the checkpoint (a file is one
 *  shot). */
export interface CoverageEntry {
	chatId: string;
	/** sha256 of the message's view lines — "covered" means exactly this. */
	fp: string;
	/** chars/4 estimate of the message's view — display + budgeting. */
	tokens: number;
	/** ISO — when this message's last extraction run merged. */
	foldedAt: string;
}

/**
 * Store format (src/store/graph.ts): JSONL ledgers at config.LEDGER_FILES
 * (nodes/chains/sessions/coverage), appended by merges (the simplification
 * pass and deletions rewrite them). Edges are NEVER stored — the derived
 * view (implication nodes + untyped arrows) is rebuilt from chains on
 * every read.
 *
 *   nodes.jsonl    one line per node — the FIRST line for an id defines
 *                  name/statement/createdAt; later lines for the
 *                  same id are link-appends (a session's re-encounter):
 *                  their statements/aliases join `aliases`, their
 *                  provenance unions; the name stays the first line's.
 *                  getGraph merges by id.
 *   chains.jsonl   one line per chain ASSERTION; readers merge by
 *                  (premises, conclusion), unioning provenance — the
 *                  first line's arg_ id is the chain's identity.
 *
 * The derived graph is rebuilt by reading the ledgers — store events,
 * derive state. coverage.jsonl (per message) and sessions.jsonl (per notes
 * source) record what the pipeline has extracted (never extract the same
 * turns twice).
 *
 * The EXTRACTION PIPELINE is the sole graph writer (extractor → auditor →
 * merger), tree-blind and post-hoc: the extractor is the ONLY stage that
 * sees the raw source (the session's teacher prose, or raw notes) and
 * extracts the reasoning chains — propositions (lonely relevant ones
 * included) plus chains; the auditor NEVER sees the source — its job is
 * identity verdicts (link-or-create, merging equivalent forms of the same
 * proposition) from ranked candidates plus graph-exploration tools, and it
 * never mints edges or chains; the merger (core/graph.ts, deterministic)
 * applies the verdicts and appends. The pipeline is the only
 * session→graph bridge, and it carries propositions + chains, nothing else.
 */

// ─── Extraction findings (extractor output → audit → merger input) ───────────

/** One proposed proposition — a node candidate (or a re-encounter of one). */
export interface ExtractedProposition {
	/** Extractor-local id ("p1", …) referenced by chains. */
	id: string;
	/** A very short label — a few words, a compact handle like a glossary
	 *  headword. Not a sentence, needn't be unique or self-contained: the
	 *  statement carries the precision. Becomes the node's name on create;
	 *  on link, the existing node keeps its name. */
	name: string;
	/** The minimal proposition — a true, self-contained, world-facing
	 *  statement, at full precision. No learner / teacher / session
	 *  references: misconceptions are stated as the true correction, and
	 *  wrongness is never recorded in the graph. */
	statement: string;
	/** Verbatim phrasings the session used. */
	aliases: string[];
	/** OPTIONAL, SESSION PATH ONLY: the message id of the ONE teacher passage
	 *  this proposition came from — the extractor copies it from the view's
	 *  "TEACHER [id]" label (core/coverage.ts messageViewLines) and the submit
	 *  seam validates it against the CURRENT batch. The merger stamps it into
	 *  the node's provenance point {chatId, messageId} (new nodes AND
	 *  link-appends); chains stay chat-level. Notes imports and legacy/core
	 *  callers have none: undefined → messageId "" (chat-level), so NO
	 *  persisted shape or format version changes (GraphNode / ProvenancePoint
	 *  untouched). */
	messageId?: string;
}

/** One proposed argument. Endpoints are extractor-local proposition ids
 *  ("p1", …) or existing node ids from the source digest — the extractor is
 *  the ONLY stage that ever proposes chains; the merger resolves them to
 *  node ids. */
export interface ExtractedChain {
	/** Proposition ids that JOINTLY entail the conclusion. */
	premises: string[];
	/** The proposition id the premises jointly imply. */
	conclusion: string;
}

/** The extractor's output shape: the raw reasoning chains. */
export interface SessionFindings {
	propositions: ExtractedProposition[];
	chains: ExtractedChain[];
}

/** One identity verdict: the extractor's local proposition id → the EXISTING
 *  graph node that proposition IS. On link, the session's phrasings (statement,
 *  aliases) join the node's aliases and the provenance unions. EQUIVALENCE
 *  BIAS: paraphrases, rewordings, and compressions of the same claim MERGE — do
 *  not create a duplicate because the wording differs. Only genuinely distinct
 *  propositions stay apart. */
export interface IdentityLink {
	id: string;
	linkTo: string;
}

/** The auditor's output — VERDICTS ONLY: the auditor never alters the
 *  extractor's findings, so it does not restate them; the deterministic
 *  merger joins findings + verdicts. `links` = the identity verdicts (local
 *  id ⇄ existing node) — the auditor's ENTIRE deliverable (it never mints
 *  edges; the graph connects across sources solely through identified
 *  equivalences). No drop channel — the auditor never rejects; the
 *  extractor is fully trusted. */
export interface AuditVerdicts {
	links: IdentityLink[];
}

/** One rendered cluster in the snapshot payload (vision §1). Members are
 * node ids; the renderer draws the hull from member positions at draw
 * time and gates the label inversely on the node-label zoom control. */
export interface Cluster {
	/** The birth session's id — a chatId or a notes source id ("src_…"). */
	id: string;
	/** The session's name (chat title / file label); null when its record
	 * is gone — the hull still renders, unlabeled. */
	label: string | null;
	/** Node ids, sorted. Hull + centroid are renderer concerns. */
	members: string[];
}

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */
export interface GraphSnapshot {
	/** Proposition nodes + the DERIVED implication nodes (one per chain,
	 *  id = chain id) — what the canvas renders. */
	nodes: GraphNode[];
	/** The STORED proposition nodes alone (no derived implication nodes)
	 *  — the stored truth, like `chains`: consumers that read the world
	 *  (the chain table) take this list, never the canvas image. */
	propositions: GraphNode[];
	/** DERIVED untyped arrows: premise → imp → conclusion. A lossy image
	 *  of the stored chains — rebuilt after every change, never stored. */
	edges: GraphEdge[];
	/** DERIVED LOGICAL arrows: every chain contracted to direct premise→
	 *  conclusion over PROPOSITION ids only (the imp hop collapsed). The
	 *  depth pass consumes these — inference depth is a property of
	 *  propositions, never of the geometry point. */
	logicalEdges: GraphEdge[];
	/** DERIVED imp linkage (one per MULTI-premise live chain): the depth pass
	 *  anchors each junction at the average of the highest premise row and the
	 *  conclusion's row — strictly above the premises, strictly below the
	 *  conclusion. */
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
	/** The STORED reasoning chains (merged by (premises, conclusion) at
	 *  read): the chain table's and the practice pipeline's input — they
	 * read the truth, never the derived fan-out. */
	chains: GraphChain[];
	/** chatId → title, for every chat that touched the graph. */
	sessions: Record<string, string>;
	/** srcId → file path, for every IMPORTED NOTES file that touched the
	 *  graph (the format-agnostic front door): a static provenance entry —
	 *  the detail card shows the path as plain text, not a link. */
	fileSources: Record<string, string>;
	/** nodeId → chatIds that touched the node (click-through provenance). */
	nodeSessions: Record<string, string[]>;
	/** Birth-session communities (core/session-clusters.ts: each
	 * proposition joins the cluster of the session that birthed it —
	 * session provenance, no Louvain, no embeddings), MIN_CLUSTER_SIZE
	 * ≥ 3 as the hull presentation rule. Propositions only — implication
	 * nodes are never partitioned. Purely provenance-derived — never
	 * depends on layout. */
	clusters: Cluster[];
	/** Resting layout positions per node id, when a positions ledger
	 *  exists (core/layout-settle.ts writes it). Absent on a fresh graph —
	 *  the view then falls back to its own one-shot forceAtlas2 pass. */
	positions?: Record<string, Position>;
}

/** A node's resting position in layout space (the positions ledger). */
export interface Position {
	x: number;
	y: number;
}

/** The auto-title's character cap: long enough to stay informative in the
 *  sidebar and the top bar, short enough that a first message never reads as a
 *  paragraph. Tunable — one number, one place. */
export const TITLE_MAX_CHARS = 72;

/** Derive a short chat title from the learner's first message (pure). Smart
 *  truncation: the cut snaps to a word boundary AT OR UNDER the cap — a title
 *  never ends mid-word. The one exception is a single word longer than the cap
 *  (rare, but real: identifiers, URLs): it cuts at the cap, splitting the word.
 *  Whitespace collapses to single spaces first, so boundaries are always
 *  single-space boundaries. Used on chat creation; deterministic so tests can
 *  pin it. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
	// Last space among the first TITLE_MAX_CHARS characters; the cut sits
	// before it so no trailing space rides into the title.
	let cut = -1;
	for (let i = TITLE_MAX_CHARS; i > 0; i--) {
		if (oneLine[i - 1] === " ") {
			cut = i - 1;
			break;
		}
	}
	// One long word: no boundary exists under the cap — split it. This also
	// lands correctly when the first word exactly fills the cap: cutting at the
	// cap IS the boundary.
	if (cut < 0) cut = TITLE_MAX_CHARS;
	return `${oneLine.slice(0, cut)}…`;
}
