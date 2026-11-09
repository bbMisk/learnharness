/** A node drag on the live renderer re-anneals only the dragged node's
 *  neighbourhood: the rest of the layout stays put, so repeated drags
 *  never walk the layout's centre (the old full reheat moved every node). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { GraphCanvasRenderer, pinOutsideNeighborhood, type CanvasData } from "../components/graph-canvas.ts";
import { graphSnapshot } from "../src/core/graph.ts";

const dir = new URL("./fixtures/golden-data/graph/", import.meta.url);
const jsonl = (name: string) => readFileSync(new URL(name, dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ledger = (JSON.parse(readFileSync(new URL("positions.json", dir), "utf8")) as { positions: Record<string, { x: number; y: number }> }).positions;
const view = graphSnapshot({
	graphStore: { readNodes: () => jsonl("nodes.jsonl"), readChains: () => jsonl("chains.jsonl"), readSources: () => [], readPositions: () => ledger },
	chatStore: { listChats: () => [], getChat: () => null },
} as never);

// DOM-free stand-ins: the renderer only needs these to construct and to take pointer input.
Object.assign(globalThis, {
	window: { devicePixelRatio: 1 },
	ResizeObserver: class { observe() {} disconnect() {} },
	Path2D: class {},
	SVGElement: class {},
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
});
function fakeCanvas() {
	const listeners: Record<string, (e: unknown) => void> = {};
	return {
		listeners, clientWidth: 1200, clientHeight: 800, width: 0, height: 0, style: { setProperty() {}, cursor: "" },
		getContext: () => ({ setTransform() {} }),
		addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
		removeEventListener() {},
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		setPointerCapture() {},
		releasePointerCapture() {},
	};
}

function renderer() {
	const canvas = fakeCanvas();
	const r = new GraphCanvasRenderer(canvas as unknown as HTMLCanvasElement, {
		onSelect() {}, onContext() {}, onStageClick() {}, onCameraMove() {}, onCommit() {},
	}, { k: 1, x: 0, y: 0 });
	// The private hooks the drive needs: no draw loop, a scripted pick, manual ticks.
	const internals = r as unknown as { markDirty: () => void; pickAt: () => unknown; advanceSim: () => boolean };
	internals.markDirty = () => {};
	const data: CanvasData = {
		nodes: view.nodes.map((n) => ({ id: n.id, x: ledger[n.id]!.x, y: ledger[n.id]!.y, label: n.name })),
		edges: view.edges, logicalEdges: view.logicalEdges, impLinks: view.impLinks,
		clusters: view.clusters.map((c) => ({ id: c.id, label: c.label, members: c.members })),
		colors: { node: "#000", edge: "#000", label: "#000", hoverText: "#000" }, fontFamily: "sans-serif",
	};
	r.setData(data);
	const drag = (id: string, dx: number) => {
		const n = data.nodes.find((m) => m.id === id)!;
		internals.pickAt = () => n; // identity transform: world = screen
		const at = (x: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: n.y, preventDefault() {} });
		const x0 = n.x;
		canvas.listeners.pointerdown!(at(x0));
		for (let i = 1; i <= 10; i++) {
			canvas.listeners.pointermove!(at(x0 + (dx * i) / 10));
			internals.advanceSim();
		}
		canvas.listeners.pointerup!(at(x0 + dx));
		let guard = 0;
		while (internals.advanceSim() && guard++ < 2000);
	};
	return { data, drag };
}
const centroid = (nodes: { x: number; y: number }[]) => ({
	x: nodes.reduce((s, n) => s + n.x, 0) / nodes.length,
	y: nodes.reduce((s, n) => s + n.y, 0) / nodes.length,
});

it("a drag moves only the dragged node's neighbourhood, and repeated drags keep the centre", () => {
	const { data, drag } = renderer();
	const ids = ["n_465398b5356a", "n_0077867ac365", "n_465398b5356a"];
	for (const id of ids) {
		const before = new Map(data.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
		const start = centroid(data.nodes);
		drag(id, 20);
		const moved = data.nodes.filter((n) => Math.hypot(n.x - before.get(n.id)!.x, n.y - before.get(n.id)!.y) > 1e-9);
		const near = new Set(data.nodes.map((n) => n.id));
		for (const n of pinOutsideNeighborhood(data.nodes.map((m) => ({ ...m })), data.edges, id)) near.delete(n.id);
		assert.ok(moved.length > 0 && moved.length < data.nodes.length / 4, `${moved.length}/${data.nodes.length} nodes moved`);
		assert.ok(moved.every((n) => near.has(n.id)), "only the neighbourhood moves");
		assert.ok(data.nodes.every((n) => (n as { fx?: number | null }).fx == null && (n as { fy?: number | null }).fy == null), "no pin outlives the settle");
		const end = centroid(data.nodes);
		assert.ok(Math.hypot(end.x - start.x, end.y - start.y) < 2.5, `centre moved ${JSON.stringify([start, end])}`);
	}
});
