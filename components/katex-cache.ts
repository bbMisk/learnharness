/**
 * rehype-katex with a bounded memo. A transcript repeats the same equations
 * many times, and every remount re-renders them; KaTeX plus parsing its HTML
 * back into HAST is the costliest step of a markdown render.
 *
 * Each math element (or the `pre` around a fenced `math` block) is rendered
 * by rehype-katex itself, alone in a scratch root, and the output is stored
 * under the element's exact structure (positions aside). A repeat gets a deep
 * copy, so no stored node is ever shared with a tree. Trees with math shaped
 * any other way (nested elements inside a math element, extra children in its
 * `pre`) skip the memo and run rehype-katex unchanged.
 */

type HastNode = {
	type: string;
	tagName?: string;
	properties?: { className?: unknown };
	children?: HastNode[];
	position?: unknown;
};
type Transform = (tree: HastNode, file: unknown) => void;

const MAX_ENTRIES = 3000;

const textOnly = (node: HastNode) => node.children?.every((c) => c.type === "text") ?? true;
/** Deep copy of plain HAST data (much cheaper than structuredClone). */
function clone<T>(value: T): T {
	if (Array.isArray(value)) return value.map(clone) as T;
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const key in value) out[key] = clone(value[key]);
	return out as T;
}
const withoutPosition = (key: string, value: unknown) => (key === "position" ? undefined : value);

/** `scope` is what rehype-katex replaces, inside `parent`. */
type Site = { scope: HastNode; parent: HastNode };

/** The nodes rehype-katex would replace, or null when any math element is
 *  shaped outside the memo's exact cases. */
function mathSites(tree: HastNode): Site[] | null {
	const sites: Site[] = [];
	const walk = (node: HastNode, grandparent?: HastNode): boolean => {
		for (const child of node.children ?? []) {
			if (child.type !== "element") continue;
			const classes = Array.isArray(child.properties?.className) ? child.properties.className : [];
			const languageMath = classes.includes("language-math");
			if (!languageMath && !classes.includes("math-display") && !classes.includes("math-inline")) {
				if (!walk(child, node)) return false;
				continue;
			}
			if (!textOnly(child)) return false;
			if (child.tagName === "code" && languageMath && node.type === "element" && node.tagName === "pre") {
				// rehype-katex renders the whole `pre` as display math.
				if (node.children!.length !== 1) return false;
				sites.push({ scope: node, parent: grandparent! });
			} else {
				sites.push({ scope: child, parent: node });
			}
		}
		return true;
	};
	return walk(tree) ? sites : null;
}

export function memoizeRehypeKatex(rehypeKatex: (options?: object) => Transform) {
	return function rehypeKatexMemo(options?: object): Transform {
		const render = rehypeKatex(options);
		const memo = new Map<string, HastNode[]>();
		return (tree, file) => {
			const sites = mathSites(tree);
			if (!sites) return render(tree, file);
			for (const { scope, parent } of sites) {
				const key = JSON.stringify(scope, withoutPosition);
				const hit = memo.get(key);
				let nodes: HastNode[];
				if (hit) {
					memo.delete(key);
					memo.set(key, hit);
					nodes = clone(hit);
				} else {
					const root: HastNode = { type: "root", children: [scope] };
					render(root, file);
					nodes = root.children!;
					if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value!);
					memo.set(key, clone(nodes));
				}
				parent.children!.splice(parent.children!.indexOf(scope), 1, ...nodes);
			}
		};
	};
}
