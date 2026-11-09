import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphChromeRow } from "../components/graph-view.tsx";
import { CacheRetentionMenu } from "../components/settings/cache-retention-menu.tsx";
import { DEFAULT_RENDER_SETTINGS } from "../src/core/render-settings.ts";

it("the graph's gear button is named like its tooltip", () => {
	const html = renderToStaticMarkup(
		<GraphChromeRow isEmpty={false} query="" onQuery={() => {}} noMatch={false} importing={false}
			searchInputRef={{ current: null }} onImportFiles={() => {}} settings={DEFAULT_RENDER_SETTINGS as never}
			changeSettings={() => {}} onOpenChains={() => {}} onFit={() => {}} />,
	);
	assert.match(html, /<button[^>]*aria-label="Graph display settings"[^>]*aria-expanded/);
});

it("Long retention points at the cost note only when there is one, and it sits above", () => {
	const long = (html: string) => /data-testid="cache-retention-option-long"[^]*?<\/button>/.exec(html)![0];
	const claude = renderToStaticMarkup(<CacheRetentionMenu value={undefined} onPick={() => {}} provider="anthropic" modelId="claude-x" />);
	assert.ok(claude.indexOf("cache-retention-note") < claude.indexOf("cache-retention-option-long"));
	assert.match(long(claude), /Cache writes cost more\. See the note above\./);
	const custom = renderToStaticMarkup(<CacheRetentionMenu value={undefined} onPick={() => {}} provider="custom" modelId="m1" />);
	assert.doesNotMatch(custom, /cache-retention-note|see below|See the note/i);
	assert.match(long(custom), /Cache writes cost more\.<\/span>/);
});
