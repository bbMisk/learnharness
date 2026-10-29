import "./style.css";
import { renderReviewText } from "./math.ts";
import { createReviewEngine, REVIEW_ENGINE, type ReviewEngine } from "../../src/core/review-engine.ts";
import { assertReviewSnapshot, isReceipted, localReviewCards, reviewChoices, reviewQueue, scheduleToken, type ReviewSnapshot, type ReviewRating } from "../../src/core/review.ts";
import { enqueueReview, openReviewDatabase, reconcileReviewSnapshot, type LocalReviewState, type ReviewDatabase } from "./database.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const deck = element<HTMLSelectElement>("deck");
const start = element<HTMLButtonElement>("start");
const reveal = element<HTMLButtonElement>("reveal");
const syncButton = element<HTMLButtonElement>("sync");
const ratingButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-rating]")];
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("learnharness-review") : null;
let database: ReviewDatabase | undefined, engine: ReviewEngine | undefined, state: LocalReviewState | undefined;
let current: ReviewSnapshot["cards"][number] | undefined;
let currentToken = "", drawn = "", cardsKey = "", cardsCache: ReviewSnapshot["cards"] = [];
let started = false, revealed = false, saving = false, cacheReady = false, connected = false;
let syncTask: Promise<void> | undefined;
let shownAt = 0, revealedAt = 0, foregroundMs = 0, foregroundStart: number | null = null;
let rememberedDeck = "";
try { rememberedDeck = localStorage.getItem("lh-review-topic") ?? ""; } catch { /* preferences are optional */ }

function notify(message: string) { element("message").textContent = message; element("message").hidden = !message; }
function now() { return Math.round(Date.now() + (state?.clockOffsetMs ?? 0)); }
function foregroundTime() { return Math.round(foregroundMs + (foregroundStart === null ? 0 : performance.now() - foregroundStart)); }
function signal() { channel?.postMessage("changed"); }

function cards() {
	if (!state?.snapshot || !engine) return [];
	const key = `${state.snapshot.collectionId}:${state.snapshot.revision}:${state.snapshot.engineId}:${state.pending.map(attempt => attempt.id).join(",")}`;
	if (key !== cardsKey) { cardsKey = key; cardsCache = localReviewCards(state.snapshot, state.pending, engine); }
	return cardsCache;
}

function intervalLabel(dueAt: number) {
	const seconds = Math.max(1, Math.round((dueAt - now()) / 1000));
	if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 6) / 10)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	const days = Math.round(seconds / 86400);
	return days < 365 ? `${days}d` : `${(days / 365).toFixed(1)}y`;
}

function updateTopics() {
	const topics = [...new Map(cards().filter(card => card.active).map(card => [card.deckId, card.deckName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
	const existing = [...deck.options].map(option => `${option.value}:${option.text}`).join("|");
	const desired = `:All topics|${topics.map(([id, name]) => `${id}:${name}`).join("|")}`;
	if (existing === desired) return;
	const selected = deck.value || rememberedDeck;
	deck.replaceChildren(new Option("All topics", ""), ...topics.map(([id, name]) => new Option(name, id)));
	deck.value = topics.some(([id]) => id === selected) ? selected : "";
}

function render() {
	updateTopics();
	const all = cards(), queue = reviewQueue(all, now(), deck.value);
	const pending = state?.pending.length ?? 0;
	const active = all.filter(card => card.active).length;
	const status = syncTask ? "Syncing…" : connected ? pending ? "Online" : "Online · Synced" : navigator.onLine ? "Host unavailable" : "Offline";
	element("connection").textContent = pending ? `${status} · ${pending} pending` : status;
	element("connection").dataset.online = String(connected);
	element("counts").textContent = state?.snapshot ? `${queue.due.length} due · ${queue.fresh.length} new · ${active} downloaded` : "Connect once to download your cards.";
	element("sync-status").textContent = pending ? `${pending} review${pending === 1 ? "" : "s"} saved here, waiting to sync.` : state?.lastSyncedAt ? `Last synced ${new Date(state.lastSyncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Reviews are saved here before syncing.";
	element("backup").hidden = !pending;
	syncButton.disabled = !!syncTask || saving || !database || !engine;
	start.disabled = !state?.snapshot || !engine || !cacheReady;
	start.textContent = !cacheReady ? "Preparing offline review…" : queue.queue.length ? "Start review" : "View review status";
	element("ready").textContent = cacheReady && state?.snapshot ? "Offline ready. Downloaded cards work without a connection." : "Keep this page open online until the offline download finishes.";
	element("welcome").hidden = started;
	if (!started || !engine) { element("review").hidden = true; element("done").hidden = true; return; }
	if (current) {
		const latest = all.find(card => card.id === current!.id);
		if (!latest || scheduleToken(latest) !== currentToken || !latest.active) { current = undefined; revealed = false; }
	}
	if (!current) {
		current = queue.queue[0];
		if (current) {
			currentToken = scheduleToken(current); shownAt = Date.now(); revealedAt = 0; foregroundMs = 0;
			foregroundStart = document.hidden ? null : performance.now(); revealed = false;
		}
	}
	element("review").hidden = !current;
	element("done").hidden = !!current;
	if (!current) {
		element("next-due").textContent = Number.isFinite(queue.nextDueAt) ? `Your next card is due in ${intervalLabel(queue.nextDueAt)}. You can choose another topic or come back then.` : queue.newRemaining === 0 ? "You’ve reached today’s 20-card new-card target. New cards become available at 4am New York time." : "Choose another topic, or sync to download newly added material.";
		return;
	}
	const nextDrawn = `${currentToken}:${revealed}`;
	if (drawn !== nextDrawn) {
		drawn = nextDrawn;
		element("card-topic").textContent = current.deckName;
		element("card-state").textContent = current.schedule.phase === "new" ? "New" : current.schedule.phase;
		renderReviewText(element("front"), current.front);
		if (revealed) renderReviewText(element("answer"), current.back);
		else element("answer").replaceChildren();
		element("answer").hidden = !revealed;
	}
	reveal.hidden = revealed; reveal.disabled = saving;
	element("ratings").hidden = !revealed;
	element("rating-hint").textContent = revealed ? "Again = couldn’t recall · Hard = recalled with difficulty" : "Try recalling the idea before revealing it.";
	const choices = reviewChoices(current.schedule, now(), engine);
	for (const button of ratingButtons) {
		const rating = Number(button.dataset.rating) as ReviewRating;
		button.disabled = saving;
		button.querySelector("small")!.textContent = intervalLabel(choices[rating].dueAt);
	}
}

async function readState() { if (database) { state = await database.read(); render(); } }

function sync(): Promise<void> {
	if (syncTask) return syncTask;
	if (!database || !engine) return Promise.resolve();
	syncTask = (async () => {
		try {
			for (let batchNumber = 0; batchNumber < 10; batchNumber++) {
				const local = await database!.read();
				const batch = local.pending.slice(0, 200);
				const began = Date.now();
				const response = await fetch("/api/review", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, deviceId: local.deviceId, attempts: batch }), signal: AbortSignal.timeout(10000) });
				const body: unknown = await response.json();
				if (!response.ok) throw new Error((body as { error?: string })?.error ?? "The host could not complete this sync.");
				assertReviewSnapshot(body);
				state = await reconcileReviewSnapshot(database!, body, body.serverAt - (began + Date.now()) / 2);
				if (!batch.every(attempt => isReceipted(attempt, state!.snapshot!.receipts))) throw new Error("The host did not acknowledge every review. They remain saved here.");
				connected = true; notify(""); signal(); render();
				if (body.engineId !== REVIEW_ENGINE.engineId) element("update").hidden = false;
				if (!state.pending.length) break;
			}
		} catch (error) {
			connected = false;
			if (error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" && error.name !== "AbortError") notify(error.message);
			await readState();
		} finally { syncTask = undefined; render(); }
	})();
	render();
	return syncTask;
}

async function rate(rating: ReviewRating) {
	if (!revealed || saving || !current || !database || !engine || !state) return;
	saving = true; render();
	try {
		const deviceAt = Date.now();
		state = await enqueueReview(database, { cardId: current.id, cardRevision: current.revision, rating, clientAt: now(), deviceAt, clockOffsetMs: state.clockOffsetMs, shownAt, revealedAt, foregroundMs: foregroundTime(), engineId: REVIEW_ENGINE.engineId }, currentToken, engine);
		current = undefined; revealed = false; notify(""); signal();
		// Advancing happens only after IndexedDB's transaction completed.
		render(); void sync();
	} catch (error) {
		notify(error instanceof Error ? error.message : "This device could not save the review. The card has not advanced.");
		await readState();
	} finally { saving = false; render(); }
}

async function checkOfflineCache() {
	const worker = navigator.serviceWorker.controller;
	if (!worker) return;
	cacheReady = await new Promise<boolean>(resolve => {
		const ports = new MessageChannel();
		const timeout = setTimeout(() => { ports.port1.close(); resolve(false); }, 3000);
		ports.port1.onmessage = event => { clearTimeout(timeout); ports.port1.close(); resolve(event.data?.ready === true); };
		worker.postMessage({ type: "IS_CACHED", build: __REVIEW_BUILD__ }, [ports.port2]);
	});
	render();
}

async function prepareOffline() {
	if (!("serviceWorker" in navigator)) { notify("This browser cannot prepare offline review. Open this page in Safari or Chrome."); return; }
	let hadController = !!navigator.serviceWorker.controller;
	navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) element("update").hidden = false; hadController = true; void checkOfflineCache(); });
	try {
		const registration = await navigator.serviceWorker.register("/review/sw.js", { scope: "/review/", updateViaCache: "none" });
		await navigator.serviceWorker.ready;
		await checkOfflineCache();
		void registration.update().catch(() => {});
		void navigator.storage?.persist?.().catch(() => false);
	} catch { notify("The offline download did not finish. Keep this page open online, then reload."); }
}

start.onclick = () => { started = true; notify(""); render(); };
reveal.onclick = () => { if (!current || saving) return; revealed = true; revealedAt = Date.now(); render(); };
for (const button of ratingButtons) button.onclick = () => void rate(Number(button.dataset.rating) as ReviewRating);
deck.onchange = () => { rememberedDeck = deck.value; current = undefined; revealed = false; try { localStorage.setItem("lh-review-topic", deck.value); } catch { /* optional preference */ } render(); };
element("choose-topic").onclick = () => { started = false; current = undefined; render(); deck.focus(); };
syncButton.onclick = () => void sync();
element("reload").onclick = () => location.reload();
element("install").onclick = () => element<HTMLDialogElement>("install-dialog").showModal();
element("backup").onclick = async () => {
	if (!database) return;
	const local = await database.read();
	const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), deviceId: local.deviceId, pending: local.pending }, null, 2)], { type: "application/json" }));
	const link = document.createElement("a"); link.href = url; link.download = "learnharness-pending-reviews.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener("keydown", event => {
	if (!started || !current || saving || (event.target instanceof HTMLElement && event.target.closest("button,select,input,textarea,dialog"))) return;
	if (event.code === "Space" && !revealed) { event.preventDefault(); reveal.click(); }
	if (revealed && ["1", "2", "3", "4"].includes(event.key)) { event.preventDefault(); void rate(Number(event.key) as ReviewRating); }
});
document.addEventListener("visibilitychange", () => {
	if (document.hidden) { foregroundMs = foregroundTime(); foregroundStart = null; }
	else { if (current) foregroundStart = performance.now(); void readState(); void sync(); }
});
window.addEventListener("online", () => void sync());
window.addEventListener("offline", () => { connected = false; render(); });
window.addEventListener("pageshow", () => { void readState(); void sync(); });
channel?.addEventListener("message", () => void readState());
setInterval(() => { if (!document.hidden) { render(); void sync(); } }, 30000);
setInterval(() => { if (started && !document.hidden && engine && state) render(); }, 5000);

async function boot() {
	syncButton.disabled = true;
	try {
		const ready = await Promise.all([openReviewDatabase(), fetch(`./assets/${REVIEW_ENGINE.wasmFile}`).then(response => { if (!response.ok) throw new Error("Reconnect once to download the scheduling engine."); return response.arrayBuffer(); }).then(bytes => createReviewEngine(new Uint8Array(bytes)))]);
		database = ready[0]; engine = ready[1]; state = await database.read(); render();
		void prepareOffline(); void sync();
	} catch (error) { notify(error instanceof Error ? error.message : "Could not open flashcards. Reconnect and reload."); element("connection").textContent = "Unable to prepare"; }
}
void boot();
