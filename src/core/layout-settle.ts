import type { GraphChain, GraphNode, Position } from "./contracts.ts";
import { incrementalLayoutSteps } from "./layout.ts";
import { attachImpToCommunities, birthSessionPartition } from "./session-clusters.ts";
import { deriveView, getGraph } from "./graph.ts";

/**
 * The merge-time settle: recompute the resting layout from the CURRENT
 * graph + the positions ledger, and replace the ledger. Called by the
 * extraction pipeline after every merge (the sole writer) and by the
 * positions-commit endpoint when the graph grew under a live-physics
 * commit (client positions become the anchor set). Callers await it — it
 * must finish before the next /api/graph fetch reflects the change.
 *
 * YIELDING (2026-10-31): the 300 ticks run in slices of at most
 * SETTLE_SLICE_MS, yielding to the event loop between slices, so a settle
 * never freezes the server (a real ~500-node graph took ~250 ms in one
 * block). Same simulation, same tick order — positions are identical to
 * the synchronous run. Because other code can run while it yields:
 * settles are SERIALIZED (one at a time, in call order), and a settle
 * whose inputs (nodes, chains, ledger) changed underneath it discards its
 * result and recomputes from the fresh state — it never writes positions
 * computed from a stale snapshot.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the settle lays out the DERIVED
 * view — propositions AND the derived implication nodes (one per chain,
 * arg_ ids) over the derived untyped arrows — so positions exist for
 * every node the canvas renders. Implication nodes participate in the
 * physics as regular nodes (rendering specialization comes later).
 *
 * SPLIT FROM layout.ts deliberately (2026-09-13): layout.ts is in the
 * browser barrel, and the settle needs the cluster partition for the
 * cluster centroid pull — this module must not ship in the client bundle.
 * Server code imports it DIRECTLY; it is never re-exported through
 * src/core/index.ts.
 */
export function settleGraphLayout(
	graphStore: {
		readNodes(): GraphNode[];
		readChains(): GraphChain[];
		readPositions(): Record<string, Position>;
		writePositions(positions: Record<string, Position>): void;
	},
	options: { sliceMs?: number } = {},
): Promise<void> {
	const sliceMs = options.sliceMs ?? SETTLE_SLICE_MS;
	const run = settleQueue.then(async () => {
		// Stale results (inputs moved while it yielded) settle again; after
		// SETTLE_MAX_RETRIES the last attempt runs without yielding, so it
		// cannot go stale and the loop always ends.
		for (let attempt = 1; !(await trySettle(graphStore, attempt > SETTLE_MAX_RETRIES ? Infinity : sliceMs)); attempt++);
	});
	settleQueue = run.catch(() => undefined);
	return run;
}

/** The longest run of ticks between two yields to the event loop. */
const SETTLE_SLICE_MS = 16;
/** Yielding attempts before a settle finishes in one block regardless. */
const SETTLE_MAX_RETRIES = 3;

/** The tail of the settle queue — each settle starts after the last ends. */
let settleQueue: Promise<void> = Promise.resolve();

/** One settle attempt. false = its inputs changed while it yielded
 *  (nothing written); true = done (ledger written, or an empty graph). */
async function trySettle(
	graphStore: Parameters<typeof settleGraphLayout>[0],
	sliceMs: number,
): Promise<boolean> {
	const nodes = graphStore.readNodes();
	const chains = graphStore.readChains();
	const positions = graphStore.readPositions();
	const inputs = JSON.stringify([nodes, chains, positions]);
	const graph = getGraph({ readNodes: () => nodes, readChains: () => chains });
	if (graph.nodes.length === 0) return true;
	const view = deriveView(graph);
	const previous = new Map(Object.entries(positions));
	// The cluster partition for the centroid pull: the SAME birth-session
	// partition the snapshot renders (derived from provenance on read —
	// core/session-clusters.ts, wave 7) — one cluster concept everywhere.
	// PROPOSITIONS ONLY (owner, 2026-09-30): implication nodes never
	// partition; the stored world clusters, its image follows.
	const communities = birthSessionPartition(graph.nodes);
	// The SAME imp-node assignment the snapshot renders (majority among
	// premises' births — core/session-clusters.ts): the resting ledger and
	// the live sim must agree on where bundles belong, or the first live
	// tick would fight the settle. Unfiltered here (settle pulls every
	// community, hulls are a canvas-only concern).
	attachImpToCommunities(communities, graph.nodes, graph.chains);
	const steps = incrementalLayoutSteps(view.nodes, view.edges, previous, {
		clusters: communities,
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
	});
	let sliceStart = performance.now();
	let step = steps.next();
	while (!step.done) {
		if (performance.now() - sliceStart >= sliceMs) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			sliceStart = performance.now();
		}
		step = steps.next();
	}
	// Something wrote the graph or the ledger while this yielded (a
	// positions commit, a deletion): the result is stale — never write it.
	const now = [graphStore.readNodes(), graphStore.readChains(), graphStore.readPositions()];
	if (JSON.stringify(now) !== inputs) return false;
	graphStore.writePositions(Object.fromEntries(step.value));
	return true;
}
