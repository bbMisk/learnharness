"use client";

import { createElement, useEffect, useState, type ComponentType } from "react";

/**
 * A code-split component for surfaces that are closed on first paint.
 * It renders nothing until its chunk arrives, then renders synchronously
 * on every later mount, so a warmed chunk opens without a blank frame.
 * A failed load throws to the nearest error boundary.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
	let loaded: ComponentType<P> | undefined;
	let pending: Promise<ComponentType<P>> | undefined;
	const preload = () =>
		(pending ??= load().then(
			(component) => (loaded = component),
			(error: unknown) => {
				pending = undefined;
				throw error;
			},
		));
	function Preloaded(props: P) {
		const [failure, setFailure] = useState<{ error: unknown }>();
		const [, setReady] = useState(false);
		const missing = !loaded;
		useEffect(() => {
			if (missing) preload().then(() => setReady(true), (error: unknown) => setFailure({ error }));
		}, [missing]);
		if (failure) throw failure.error;
		return loaded ? createElement(loaded, props) : null;
	}
	return Object.assign(Preloaded, { preload });
}

/** Warms a chunk once the browser is idle after the first render. */
export function useIdlePreload(preload: () => Promise<unknown>) {
	useEffect(() => {
		const run = () => void preload().catch(() => {});
		if (typeof window.requestIdleCallback === "function") {
			const id = window.requestIdleCallback(run, { timeout: 2000 });
			return () => window.cancelIdleCallback(id);
		}
		const timer = setTimeout(run, 1000);
		return () => clearTimeout(timer);
	}, [preload]);
}
