declare const __REVIEW_BUILD__: string;
declare module "katex/contrib/auto-render" {
	import type { KatexOptions } from "katex";
	export default function renderMath(element: HTMLElement, options?: KatexOptions & { delimiters?: { left: string; right: string; display: boolean }[] }): void;
}
