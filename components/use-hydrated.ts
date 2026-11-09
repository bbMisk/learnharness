"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** False while React hydrates the server's HTML, true after it and on every
 *  client-side mount. Browser storage the server can't see waits for it, so
 *  restored drafts never make the first render differ from the server's. */
export function useHydrated(): boolean {
	return useSyncExternalStore(subscribe, () => true, () => false);
}
