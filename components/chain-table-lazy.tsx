"use client";

import { useState, type ComponentProps } from "react";
import { preloadable, useIdlePreload } from "@/components/preloadable";
import type { ChainTableOverlay as Overlay } from "@/components/chain-table";

const LazyOverlay = preloadable(() => import("@/components/chain-table").then((m) => m.ChainTableOverlay));

/** ChainTableOverlay, split out of first paint. It mounts on first open and
 *  stays mounted, so query, sort and expansion survive closing it as before. */
export function ChainTableOverlay(props: ComponentProps<typeof Overlay>) {
	const [opened, setOpened] = useState(props.open);
	if (props.open && !opened) setOpened(true);
	useIdlePreload(LazyOverlay.preload);
	return opened ? <LazyOverlay {...props} /> : null;
}
