"use client";

import { useEffect, type RefObject } from "react";
import { createStudyClock, STUDY_MAX_AGE_MS, STUDY_SAMPLE_MS, type StudySpan } from "@/src/core";

export function useStudyActivity(chatId: string, scope: RefObject<HTMLElement | null>, active: boolean) {
	useEffect(() => {
		if (!active) return;
		const pending: StudySpan[] = [];
		let sending = false;
		let lastRefresh = -Infinity;
		const clock = createStudyClock((span) => pending.push(span));

		function flush(final = false) {
			if (!final && sending) return;
			const oldest = Date.now() - STUDY_MAX_AGE_MS + STUDY_SAMPLE_MS;
			while (pending.length && pending[0]![0] < oldest) pending.shift();
			if (pending.length === 0) return;
			const batch = pending.slice(0, 360);
			if (!final) sending = true;
			void fetch("/api/study-activity", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, spans: batch }),
				keepalive: final,
				...(final ? {} : { signal: AbortSignal.timeout(STUDY_SAMPLE_MS) }),
			})
				.then((response) => {
					// Remove only the submitted entries. A final flush can overlap a
					// regular send, and the server unions any duplicate intervals.
					if (response.ok || response.status === 400 || response.status === 404) {
						while (pending.length && batch.includes(pending[0]!)) pending.shift();
					}
					if (response.ok && Date.now() - lastRefresh >= 60_000) {
						lastRefresh = Date.now();
						window.dispatchEvent(new Event("lh:study-activity"));
					}
				})
				.catch(() => {})
				.finally(() => {
					if (!final) sending = false;
				});
		}

		const foreground = () => document.visibilityState === "visible" && document.hasFocus();
		const interact = (event: Event) => {
			if (event.isTrusted && foreground() && event.target instanceof Node && scope.current?.contains(event.target)) {
				clock.interact(Date.now());
			}
		};
		const pause = () => {
			clock.pause(Date.now());
			flush(true);
		};
		const visibility = () => {
			if (!foreground()) pause();
		};
		const timer = window.setInterval(() => {
			if (foreground()) clock.sample(Date.now());
			else clock.pause(Date.now());
			flush();
		}, STUDY_SAMPLE_MS);

		const inputEvents = ["pointerdown", "keydown", "wheel", "input"] as const;
		for (const type of inputEvents) document.addEventListener(type, interact, { capture: true, passive: true });
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("blur", pause);
		window.addEventListener("pagehide", pause);
		return () => {
			window.clearInterval(timer);
			for (const type of inputEvents) document.removeEventListener(type, interact, true);
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("blur", pause);
			window.removeEventListener("pagehide", pause);
			pause();
		};
	}, [active, chatId, scope]);
}
