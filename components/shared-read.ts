const pending = new Map<string, Promise<unknown>>();

/** One GET for readers that mount together (a commit's effects, one event's
 *  listeners): reads of `key` started in one synchronous run share one
 *  request; any later read starts a fresh one, so a read after a save never
 *  sees older data. */
export function sharedRead<T>(key: string, start: () => Promise<T>): Promise<T> {
	const shared = pending.get(key);
	if (shared) return shared as Promise<T>;
	const read = start();
	pending.set(key, read);
	queueMicrotask(() => pending.delete(key));
	return read;
}
