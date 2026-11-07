import type { CodeHighlighterPlugin } from "@streamdown/code";

/**
 * Streamdown's code plugin, with @streamdown/code (Shiki core and its regex
 * engine, ~200 KB) loaded on the first highlight instead of with every
 * markdown surface; its grammars and themes already load on demand. Until
 * the module arrives, highlight() returns null and reports through the
 * callback later, exactly like the plugin while Shiki itself loads, so code
 * shows unhighlighted until then.
 *
 * Streamdown only calls getThemes() and highlight(). The language queries
 * answer from the loaded plugin (false / empty before it has loaded).
 */

let plugin: CodeHighlighterPlugin | undefined;
let loading: Promise<CodeHighlighterPlugin> | undefined;
const load = () => (loading ??= import("@streamdown/code").then((m) => (plugin = m.code)));

// @streamdown/code's default themes (one array, as the plugin returns).
const themes: ReturnType<CodeHighlighterPlugin["getThemes"]> = ["github-light", "github-dark"];

export const code: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	getThemes: () => themes,
	highlight(options, callback) {
		if (plugin) return plugin.highlight(options, callback);
		load()
			.then((loaded) => {
				const result = loaded.highlight(options, callback);
				if (result) callback?.(result);
			})
			.catch((error: unknown) => console.error("[Streamdown Code] Failed to highlight code:", error));
		return null;
	},
	supportsLanguage: (language) => plugin?.supportsLanguage(language) ?? false,
	getSupportedLanguages: () => plugin?.getSupportedLanguages() ?? [],
};
