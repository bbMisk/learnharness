"use client";

/**
 * THE SESSION LIST'S FETCH COORDINATOR (efficiency pass, 2026-11-01): every
 * reason the sidebar has to refetch — a local turn-state instant, a server
 * event, a reconnect, an explicit refresh — goes through one queue, so one
 * change costs one GET /api/chats, and GET /api/projects rides along only
 * when projects may have changed (chats-changed — which project writes also
 * announce — a reconnect, or an explicit refresh).
 *
 * Two rules keep it fresh without double fetching:
 *
 * 1. A list fetch that starts after an event arrived covers that event
 *    (the server writes before it emits). Starting a fetch therefore
 *    absorbs every pending debounced need.
 * 2. A turn-settled event for chat X that arrives AFTER a fetch started
 *    (the same-window settle refreshed first) is covered when the newest
 *    server snapshot shows X idle and no turn-started for X arrived since
 *    that snapshot was requested: busy is the server's own in-flight
 *    flag, so an idle X in a snapshot whose request preceded no new start
 *    means the turn had already ended — and persisted — when the server
 *    built it. Anything short of that proof fetches. The check runs when
 *    the debounce fires, so a snapshot still in flight when the event
 *    arrives gets to answer it.
 *
 * A reconnect may have missed turn-started events, so it drops the
 * coverage proof until a fresh snapshot lands, and fetches immediately.
 * Pure (no React) below the hook; the hook is the sidebar's wiring.
 */

import { useCallback, useEffect, useRef } from "react";
import type { ChatListItem, ProjectSummary } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";

/** The trailing debounce for announced fetches (the S4/S5 law). */
export const EVENT_REFRESH_MS = 250;

export type ListEvent =
	| { type: "turn-started"; chatId: string }
	| { type: "turn-settled"; chatId: string }
	| { type: "compaction-changed" }
	| { type: "chats-changed" }
	| { type: "record-changed"; chatId: string };

export interface ChatListRefreshDeps {
	fetchList(): Promise<ChatListItem[]>;
	/** null: the projects request failed — keep the last projects. */
	fetchProjects(): Promise<ProjectSummary[] | null>;
	onList(chats: ChatListItem[]): void;
	onProjects(projects: ProjectSummary[]): void;
	/** A failed fetch keeps the last snapshot. */
	onError(): void;
	debounceMs?: number;
	/** A request that hangs longer than this counts as failed, so it can't hold the queue. */
	timeoutMs?: number;
}

const FETCH_TIMEOUT_MS = 20_000;

function within<T>(request: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("list refresh timed out")), ms); });
	return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}

export function createChatListRefresher(deps: ChatListRefreshDeps) {
	const debounceMs = deps.debounceMs ?? EVENT_REFRESH_MS;
	const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight = false;
	let pumpWhenDone = false;
	// Unmounted (hunt finding): no new fetches, no callbacks, pending refresh() promises settle.
	let disposed = false;
	// Work that was waiting when disposed; a resume (React dev double-mount) runs it.
	let resumeWork = false;
	// ...and whether that work included the projects (round-5 hunt finding).
	let resumeProjects = false;
	let flightProjects = false;
	// The in-flight fetch's refresh() waiters, so dispose() can settle them at once.
	let activeWaiters: Array<() => void> = [];
	// What the next fetch must cover.
	let force = false;
	let withProjects = false;
	const settled = new Set<string>();
	let waiters: Array<() => void> = [];
	// Coverage proof: the newest server snapshot, and the chats whose turns
	// started since it (or the fetch in flight) was requested.
	let snapshot: { chats: ChatListItem[]; startedSince: Set<string> } | null = null;
	let flight: { startedSince: Set<string>; trusted: boolean } | null = null;

	const covered = (id: string) =>
		!!snapshot && !snapshot.startedSince.has(id) && snapshot.chats.some((c) => c.id === id && !c.busy);

	function pump(): void {
		if (disposed) {
			const done = waiters;
			waiters = [];
			for (const resolve of done) resolve();
			return;
		}
		if (inFlight) {
			pumpWhenDone = true;
			return;
		}
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (!force && [...settled].every(covered)) {
			settled.clear();
			return;
		}
		const projects = withProjects;
		const done = waiters;
		activeWaiters = done;
		flightProjects = projects;
		force = false;
		withProjects = false;
		settled.clear();
		waiters = [];
		inFlight = true;
		const current = { startedSince: new Set<string>(), trusted: true };
		flight = current;
		void (async () => {
			try {
				const chats = await within(deps.fetchList(), timeoutMs);
				if (current.trusted) snapshot = { chats, startedSince: current.startedSince };
				if (!disposed) deps.onList(chats);
				if (projects && !disposed) {
					// A failed or stalled projects request keeps the last projects; the list stands.
					const list = await within(deps.fetchProjects(), timeoutMs).catch(() => null);
					if (list && !disposed) deps.onProjects(list);
				}
			} catch {
				if (!disposed) deps.onError();
			} finally {
				inFlight = false;
				flight = null;
				for (const resolve of done) resolve();
				if (pumpWhenDone) {
					pumpWhenDone = false;
					pump();
				}
			}
		})();
	}

	function schedule(): void {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			pump();
		}, debounceMs);
	}

	/** Fetch now (list, plus projects unless told otherwise); resolves
	 *  once a fetch that started after this call has finished. */
	function refresh(options: { projects?: boolean } = {}): Promise<void> {
		force = true;
		if (options.projects !== false) withProjects = true;
		const finished = new Promise<void>((resolve) => waiters.push(resolve));
		pump();
		return finished;
	}

	return {
		refresh,
		/** A server event: the debounced fetch, unless rule 2 proves it covered. */
		event(event: ListEvent): void {
			switch (event.type) {
				case "turn-started":
					snapshot?.startedSince.add(event.chatId);
					flight?.startedSince.add(event.chatId);
					force = true;
					break;
				case "turn-settled":
					settled.add(event.chatId);
					break;
				case "compaction-changed":
				case "record-changed":
					force = true;
					break;
				case "chats-changed":
					force = true;
					withProjects = true;
					break;
			}
			schedule();
		},
		/** The channel (re)opened: events may have been missed. */
		resync(): Promise<void> {
			snapshot = null;
			if (flight) flight.trusted = false;
			return refresh();
		},
		/** Unmount: stop fetching and settle every pending refresh() promise. */
		dispose(): void {
			disposed = true;
			// An in-flight result is dropped while disposed, so a resume must fetch again.
			resumeWork = resumeWork || inFlight || timer !== undefined || pumpWhenDone || force || settled.size > 0;
			resumeProjects = resumeProjects || withProjects || (inFlight && flightProjects);
			if (timer) clearTimeout(timer);
			timer = undefined;
			pumpWhenDone = false;
			const done = [...activeWaiters, ...waiters];
			activeWaiters = [];
			waiters = [];
			for (const resolve of done) resolve();
		},
		/** Mount (again): React's development double-mount disposes once before the real mount. */
		resume(): void {
			if (!disposed) return;
			disposed = false;
			if (resumeWork) {
				// Whatever was dropped while disposed must be fetched again, covered or not.
				resumeWork = false;
				force = true;
				if (resumeProjects) withProjects = true;
				resumeProjects = false;
				schedule();
			}
		},
	};
}

/** The sidebar's wiring: server events, reconnects and the same-window
 *  turn-state instants feed the coordinator; the returned refresh is for
 *  explicit callers (open, navigation, organization moves). */
export function useChatListRefresh({
	chats,
	setChats,
	setProjects,
}: {
	chats: ChatListItem[] | null;
	setChats: (update: (prev: ChatListItem[] | null) => ChatListItem[] | null) => void;
	setProjects: (projects: ProjectSummary[]) => void;
}) {
	const refresherRef = useRef<ReturnType<typeof createChatListRefresher> | null>(null);
	refresherRef.current ??= createChatListRefresher({
		fetchList: async () => {
			const res = await fetch("/api/chats", { cache: "no-store" });
			return ((await res.json()) as { chats: ChatListItem[] }).chats;
		},
		fetchProjects: async () => {
			const res = await fetch("/api/projects");
			return res.ok ? ((await res.json()) as { projects: ProjectSummary[] }).projects : null;
		},
		onList: (list) => setChats(() => list),
		onProjects: setProjects,
		onError: () => setChats((prev) => prev ?? []),
	});
	const refresher = refresherRef.current;
	useEffect(() => {
		refresher.resume();
		return () => refresher.dispose();
	}, [refresher]);
	useServerEvent("chats-changed", () => refresher.event({ type: "chats-changed" }));
	useServerEvent("turn-started", ({ chatId }) => refresher.event({ type: "turn-started", chatId }));
	useServerEvent("turn-settled", ({ chatId }) => refresher.event({ type: "turn-settled", chatId }));
	useServerEvent("compaction-changed", () => refresher.event({ type: "compaction-changed" }));
	// The silent writes (a dismissal, a parallel answer's write-ahead, a
	// compaction) change a row's time spent (owner, 2026-11-05).
	useServerEvent("record-changed", ({ chatId }) => refresher.event({ type: "record-changed", chatId }));
	useServerResync(() => void refresher.resync());

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts lh:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. A turn cannot change
	   projects, so neither fetch asks for them. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresher.refresh({ projects: false }); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			// Settle: the server snapshot is now truthful — land it now. The
			// server's own turn-settled for this turn then finds it covered
			// (rule 2) instead of fetching again.
			void refresher.refresh({ projects: false });
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresher, setChats]);

	return useCallback((options?: { projects?: boolean }) => refresher.refresh(options), [refresher]);
}
