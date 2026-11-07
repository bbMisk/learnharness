"use client";

import type { ComponentProps } from "react";
import { preloadable, useIdlePreload } from "@/components/preloadable";
import type { SetupDialog as Dialog } from "@/components/setup-dialog";

const LazyDialog = preloadable(() => import("@/components/setup-dialog").then((m) => m.SetupDialog));

/** SetupDialog, split out of first paint: the body loads on idle, so the first open is not slower. */
export function SetupDialog(props: ComponentProps<typeof Dialog>) {
	useIdlePreload(LazyDialog.preload);
	return props.open ? <LazyDialog {...props} /> : null;
}
