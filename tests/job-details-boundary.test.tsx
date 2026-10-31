import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { JobDetailsBoundary } = await import("../components/activity-dock.tsx");

it("contains a failed job-details load inside the dock", async () => {
	function FailedChunk(): React.ReactNode {
		throw new Error("Loading chunk failed");
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host, { onCaughtError() {} });
	await act(async () => root.render(<JobDetailsBoundary><FailedChunk /></JobDetailsBoundary>));
	assert.match(host.textContent ?? "", /Details unavailable\. Reload to retry\./);
	await act(async () => root.unmount());
});
