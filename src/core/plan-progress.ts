/**
 * Plan progress (owner, 2026-11-05): the Progress card's "Plan" section for
 * a normal teach lesson (components/lesson-tracker.tsx) — one row per step
 * of the session plan with where the lesson is and how its checks went.
 *
 * Nothing new is stored and there is no second notion of position: the
 * steps are the LATEST plan tree (the plan_init result's details.tree —
 * latestTree in components/plan-block.tsx), each step's status is the
 * plan map's own derivation (contracts/plan.ts derivePlanStatuses —
 * current = the node of the most recent tagged quiz/explain CALL, visited =
 * nodes of earlier tagged runs), and the scores read the answers those
 * same tagged calls got. Derived from the transcript view on every render,
 * so it follows checks as they stream and answers as they land.
 *
 *   covered — steps the lesson has moved past (status visited and not
 *             current again); the header's "covered/total".
 *   score   — per step, right/answered over its ANSWERED checks: a tagged
 *             quiz/explain whose result carries a real answer (details).
 *             Excluded: a dismissed question, a call not answered yet (the
 *             streamed "Question posed" placeholder never becomes an
 *             output in the view), a failed call, an untagged call, and a
 *             nodeId not in the current tree (a rewrite may drop a node).
 *             "I don't know" is answered and not right.
 *   latest  — the step's most recent answered check: "right" (green),
 *             "wrong" (red: graded incorrect or "I don't know"), or
 *             "neutral" when it carries no grade — an explain answer: the
 *             model grades it in prose, the record has no `correct`.
 *
 * Shown only for a teach lesson with a plan (a tree with nodes) and never
 * in cram (the card keeps Problems + Mistakes there) or practice.
 *
 * Pure and browser-safe (type-only imports + the plan contract's pure fold).
 */

import { derivedNodeStatus, derivePlanStatuses, type PlanNode, type PlanNodeStatus, type PlanTree } from "./contracts/plan.ts";

/** Minimal structural message slice (the view's typed parts — the same
 *  shape derivePlanStatuses and latestTree read). */
export interface PlanProgressMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

/** The verdict of one answered check. */
export type PlanCheckVerdict = "right" | "wrong" | "neutral";

export interface PlanStepProgress {
	id: string;
	title: string;
	status: PlanNodeStatus;
	/** Answered checks tagged to this step; 0 = no score shown. */
	answered: number;
	/** Of those, graded right. */
	right: number;
	/** The most recent answered check's verdict; null with none. */
	latest: PlanCheckVerdict | null;
}

export interface PlanProgress {
	/** In plan order (planStepOrder). */
	steps: PlanStepProgress[];
	/** Steps moved past — visited, not counting the current one. */
	covered: number;
	total: number;
}

const CHECK_PARTS = new Set(["tool-quiz", "tool-explain"]);

/**
 * The steps in a stable topological order: the tree's own node order (the
 * order the teacher's mermaid named them — mermaid-plan.ts registers nodes
 * at first mention) whenever that already puts every prerequisite before
 * the steps that need it. A plan's mermaid can mention a step before its
 * prerequisite (`b --> c` then `a --> b`), so node order alone is not a
 * reading order: Kahn's algorithm, always taking the earliest ready node in
 * tree order — the identity on an already-topological tree. Edges to unknown
 * nodes are ignored, and a cycle (createTree forbids one) keeps its nodes
 * in tree order at the end rather than losing them.
 */
export function planStepOrder(tree: PlanTree): PlanNode[] {
	const index = new Map(tree.nodes.map((n, i) => [n.id, i]));
	const indegree = tree.nodes.map(() => 0);
	const next = tree.nodes.map((): number[] => []);
	for (const e of tree.edges) {
		const from = index.get(e.from);
		const to = index.get(e.to);
		if (from === undefined || to === undefined || from === to) continue;
		next[from]!.push(to);
		indegree[to]!++;
	}
	const placed = tree.nodes.map(() => false);
	const order: PlanNode[] = [];
	for (;;) {
		const ready = indegree.findIndex((d, i) => d === 0 && !placed[i]);
		if (ready < 0) break;
		placed[ready] = true;
		order.push(tree.nodes[ready]!);
		for (const to of next[ready]!) indegree[to]!--;
	}
	tree.nodes.forEach((n, i) => {
		if (!placed[i]) order.push(n);
	});
	return order;
}

/** One check's answer → its verdict; null when it is not an answer (a
 *  placeholder's missing details, a dismissal). */
export function planCheckVerdict(answer: unknown): PlanCheckVerdict | null {
	if (!answer || typeof answer !== "object") return null;
	const a = answer as { dismissed?: unknown; dontKnow?: unknown; correct?: unknown };
	if (a.dismissed === true) return null;
	if (a.dontKnow === true) return "wrong";
	if (a.correct === true) return "right";
	if (a.correct === false) return "wrong";
	return "neutral";
}

/** The plan section's state for a tree and the transcript view. */
export function derivePlanProgress(tree: PlanTree, messages: readonly PlanProgressMessage[]): PlanProgress {
	const statuses = derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]);
	const scores = new Map<string, { answered: number; right: number; latest: PlanCheckVerdict }>();
	// Keyed by any tagged nodeId; only the tree's steps read it back, so an
	// untagged check or a node a rewrite dropped never shows.
	for (const m of messages) {
		for (const part of m.parts) {
			if (!CHECK_PARTS.has(part.type) || part.state !== "output-available") continue;
			const nodeId = (part.input as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string") continue;
			const verdict = planCheckVerdict(part.output);
			if (!verdict) continue;
			const s = scores.get(nodeId) ?? { answered: 0, right: 0, latest: verdict };
			s.answered++;
			if (verdict === "right") s.right++;
			s.latest = verdict;
			scores.set(nodeId, s);
		}
	}
	const steps = planStepOrder(tree).map((n): PlanStepProgress => {
		const s = scores.get(n.id);
		return {
			id: n.id,
			title: n.title,
			status: derivedNodeStatus(statuses, n.id),
			answered: s?.answered ?? 0,
			right: s?.right ?? 0,
			latest: s?.latest ?? null,
		};
	});
	return { steps, covered: steps.filter((s) => s.status === "visited").length, total: steps.length };
}

/** The card's plan section, or null when it has none: no plan (no tree or
 *  an empty one), a cram lesson, or a practice session. */
export function lessonPlanProgress(
	tree: PlanTree | null,
	messages: readonly PlanProgressMessage[],
	lesson: { cram: boolean; practice: boolean },
): PlanProgress | null {
	if (lesson.cram || lesson.practice || !tree || tree.nodes.length === 0) return null;
	return derivePlanProgress(tree, messages);
}
