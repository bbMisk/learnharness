import "./style.css";
import { renderReviewText } from "./math.ts";
import { createReviewEngine, REVIEW_ENGINE, type ReviewEngine } from "../../src/core/review-engine.ts";
import { assertReviewSnapshot, assertReviewQuestion, cardProjectIds, UNASSIGNED_REVIEW_PROJECT, reviewMode, isReceipted, localReviewCards, reviewChoices, reviewQueue, scheduleToken, type ReviewSnapshot, type ReviewRating } from "../../src/core/review.ts";
import { enqueueReview, openReviewDatabase, reconcileReviewSnapshot, type LocalReviewState, type ReviewDatabase } from "./database.ts";

declare const __REVIEW_BUILD__: string;

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const projectOptions = element("project-options");
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
let selectedIndex: number | undefined, optionOrder: number[] = [];
let questionKey = "", preparingQuestion = false, questionError = "";
let shownAt = 0, revealedAt = 0, foregroundMs = 0, foregroundStart: number | null = null;
let selectedProjects: string[] = [], projectOptionsKey = "";
try { const saved = JSON.parse(localStorage.getItem("lh-review-projects") ?? "[]"); if (Array.isArray(saved) && saved.every(id => typeof id === "string")) selectedProjects = [...new Set(saved)]; } catch { /* preferences are optional */ }

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

function updateProjects() {
	const active = cards().filter(card => card.active);
	const projects = new Map((state?.snapshot?.projects ?? []).map(project => [project.id,project.name]));
	for (const card of active) for (const id of cardProjectIds(card)) if (!projects.has(id)) projects.set(id,id === UNASSIGNED_REVIEW_PROJECT ? "Unassigned" : "Project");
	const choices = [...projects].sort((a,b) => a[1].localeCompare(b[1]));
	if (state?.snapshot?.projects && selectedProjects.length) selectedProjects = selectedProjects.filter(id => projects.has(id));
	const key = JSON.stringify(choices);
	if (key !== projectOptionsKey) {
		projectOptionsKey = key;
		projectOptions.replaceChildren(...[["","All projects"],...choices].map(([id,name]) => {
			const button = document.createElement("button"); button.type = "button"; button.className = "project-chip";
			button.dataset.projectId = id!; button.textContent = name!;
			button.onclick = () => {
				selectedProjects = !id ? [] : selectedProjects.includes(id) ? selectedProjects.filter(value => value !== id) : [...selectedProjects,id];
				current = undefined; revealed = false;
				try { localStorage.setItem("lh-review-projects",JSON.stringify(selectedProjects)); } catch { /* optional preference */ }
				render();
			};
			return button;
		}));
	}
	for (const button of projectOptions.querySelectorAll<HTMLButtonElement>("button")) {
		button.setAttribute("aria-pressed",String(button.dataset.projectId ? selectedProjects.includes(button.dataset.projectId) : selectedProjects.length === 0));
		button.disabled = saving;
	}
}

function render() {
	updateProjects();
	const all = cards(), queue = reviewQueue(all, now(), {projectIds:selectedProjects});
	const pending = state?.pending.length ?? 0;
	const active = queue.selected.length;
	const status = syncTask ? "Syncing…" : connected ? pending ? "Online" : "Online · Synced" : navigator.onLine ? "Host unavailable" : "Offline";
	element("connection").textContent = pending ? `${status} · ${pending} pending` : status;
	element("connection").dataset.online = String(connected);
	element("counts").textContent = state?.snapshot ? `${queue.due.length} due · ${queue.fresh.length} new · ${active} downloaded` : "Connect once to download your cards.";
	element("sync-status").textContent = pending ? `${pending} review${pending === 1 ? "" : "s"} saved here, waiting to sync.` : state?.lastSyncedAt ? `Last synced ${new Date(state.lastSyncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Reviews are saved here before syncing.";
	element("backup").hidden = !pending;
	syncButton.disabled = !!syncTask || saving || !database || !engine;
	start.disabled = !state?.snapshot || !engine || !cacheReady;
	start.textContent = !cacheReady ? "Preparing offline review…" : queue.queue.length ? "Start review" : "View review status";
	element("ready").textContent = cacheReady && state?.snapshot ? "Offline ready" : "Keep this page open online until the offline download finishes.";
	element("welcome").hidden = started;
	// A review shows only the card: the home screen's heading, picker and footer hide.
	document.body.dataset.mode = started ? "review" : "home";
	element("back").hidden = !started;
	if (!started || !engine) { element("review").hidden = true; element("done").hidden = true; return; }
	if (current) {
		const latest = all.find(card => card.id === current!.id);
		if (!latest || scheduleToken(latest) !== currentToken || !queue.selected.some(card => card.id === latest.id)) { current = undefined; revealed = false; }
	}
	if (!current) {
		current = queue.queue[0];
		if (current) {
			currentToken = scheduleToken(current); shownAt = Date.now(); revealedAt = 0; foregroundMs = 0;
			foregroundStart = document.hidden ? null : performance.now(); revealed = false; selectedIndex = undefined;
            optionOrder = [0,1,2,3].map(index => ({index, order:Math.random()})).sort((a,b) => a.order-b.order).map(item => item.index);
		}
	}
	element("review").hidden = !current;
	element("done").hidden = !!current;
	if (!current) {
		element("next-due").textContent = Number.isFinite(queue.nextDueAt) ? `Your next card is due in ${intervalLabel(queue.nextDueAt)}. You can choose another project or come back then.` : queue.newRemaining === 0 && active ? "You’ve reached today’s 20-new-card target for the selected projects. New cards become available at 4am New York time." : "No cards are ready for these projects. Choose another project, or sync to download newly prepared material.";
		return;
	}
	const mcq = reviewMode(current.schedule) === "mcq";
    element("mcq").hidden = !mcq;
    element("mcq-feedback").hidden = !mcq || !revealed;
    element("mcq-continue").hidden = !mcq || !revealed;
    element<HTMLButtonElement>("mcq-continue").disabled = saving;
    if (mcq && !current.mcq && questionKey !== current.id + current.revision) void prepareQuestion(current);
    const nextDrawn = `${currentToken}:${revealed}:${selectedIndex}:${!!current.mcq}:${preparingQuestion}:${questionError}:${saving}`;
	if (drawn !== nextDrawn) {
		drawn = nextDrawn;
		const projectNames = new Map(state?.snapshot?.projects?.map(project => [project.id,project.name]));
		const names = cardProjectIds(current).map(id => projectNames.get(id) ?? (id === UNASSIGNED_REVIEW_PROJECT ? "Unassigned" : "Project"));
		element("card-topic").textContent = `${names.join(" · ")} · ${current.deckName}`;
		element("card-state").textContent = mcq ? `Multiple choice · ${Math.min(current.schedule.mcqStreak ?? 0, 3)}/3` : "Active recall";
		renderReviewText(element("front"), mcq ? current.mcq?.prompt ?? current.front : current.front);
        const options = element("mcq-options"); options.replaceChildren();
        element("mcq-status").textContent = mcq && !current.mcq ? preparingQuestion ? "Preparing choices…" : questionError || "Reconnect to prepare this card’s choices for offline review." : "";
        element("mcq-retry").hidden = !mcq || !!current.mcq || preparingQuestion;
        if (mcq && current.mcq) {
            for (const [position, index] of optionOrder.entries()) {
                const button = document.createElement("button"); button.type = "button"; button.className = "mcq-option";
                button.disabled = revealed || saving; button.dataset.index = String(index);
                if (revealed && index === current.mcq.correctIndex) button.dataset.result = "correct";
                else if (revealed && index === selectedIndex) button.dataset.result = "wrong";
                const label = document.createElement("span"); label.className = "mcq-letter"; label.textContent = String.fromCharCode(65 + position);
                const content = document.createElement("span"); renderReviewText(content, current.mcq.options[index]!);
                button.append(label,content);
                button.onclick = () => { if (!current || revealed || saving) return; selectedIndex = index; revealed = true; revealedAt = Date.now(); render(); };
                options.append(button);
            }
            if (revealed) {
                const correct = selectedIndex === current.mcq.correctIndex;
                element("mcq-verdict").textContent = correct ? "Correct" : "Not quite — the correct answer is highlighted.";
                renderReviewText(element("mcq-explanation"), current.mcq.explanation);
            }
        }
		if (revealed && !mcq) renderReviewText(element("answer"), current.back);
		else element("answer").replaceChildren();
		element("answer").hidden = !revealed || mcq;
	}
	reveal.hidden = revealed || mcq; reveal.disabled = saving;
	element("ratings").hidden = !revealed || mcq;
	element("rating-hint").textContent = mcq ? "" : revealed ? "Again = couldn’t recall · Hard = recalled with difficulty" : "Try recalling the idea before revealing it.";
	const choices = reviewChoices(current.schedule, now(), engine);
	for (const button of ratingButtons) {
		const rating = Number(button.dataset.rating) as ReviewRating;
		button.disabled = saving;
		button.querySelector("small")!.textContent = intervalLabel(choices[rating].dueAt);
	}
	fitCard(`${currentToken}:${!!current.mcq}:${innerWidth}x${innerHeight}`);
}

/** Phones differ in height (Safari bars, the Dynamic Island), so each new card's
 *  text shrinks in small steps, to 80% at most, until the card and its buttons fit
 *  the screen. Answering does not refit: the text never jumps mid-card. */
let fittedFor = "";
function fitCard(key: string) {
	if (key === fittedFor) return;
	fittedFor = key;
	const card = element("card");
	let fit = 1;
	card.style.setProperty("--fit", "1");
	while (fit > 0.8 && document.documentElement.scrollHeight > innerHeight) {
		fit = Math.round((fit - 0.04) * 100) / 100;
		card.style.setProperty("--fit", String(fit));
	}
}
addEventListener("resize", () => { if (started) render(); });

async function prepareQuestion(card: ReviewSnapshot["cards"][number]) {
    if (!database) return;
    questionKey = card.id + card.revision; preparingQuestion = true; questionError = ""; render();
    try {
        const response = await fetch("/api/review/question", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({cardId:card.id, revision:card.revision}), signal:AbortSignal.timeout(130000)});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not prepare choices.");
        assertReviewQuestion(body.question);
        state = await database.change(local => {
            if (!local.snapshot) return local;
            return {...local, snapshot:{...local.snapshot, cards:local.snapshot.cards.map(item => item.id === card.id && item.revision === card.revision ? {...item, mcq:body.question} : item)}};
        });
        cardsKey = "";
        if (current?.id === card.id && current.revision === card.revision) current = {...current, mcq:body.question};
        signal();
    } catch (error) { questionError = error instanceof Error ? error.message : "Reconnect to prepare choices."; }
    finally { preparingQuestion = false; render(); }
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
		state = await enqueueReview(database, { cardId: current.id, cardRevision: current.revision, rating, clientAt: now(), deviceAt, clockOffsetMs: state.clockOffsetMs, shownAt, revealedAt, foregroundMs: foregroundTime(), engineId: REVIEW_ENGINE.engineId, ...(reviewMode(current.schedule) === "mcq" ? {mode:"mcq" as const, selectedIndex} : {mode:"recall" as const}) }, currentToken, engine);
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

element("mcq-retry").onclick = () => { if (current) void prepareQuestion(current); };
element("mcq-continue").onclick = () => { if (current?.mcq && selectedIndex !== undefined) void rate(selectedIndex === current.mcq.correctIndex ? 3 : 1); };
start.onclick = () => { started = true; notify(""); render(); scrollTo(0, 0); };
reveal.onclick = () => { if (!current || saving) return; revealed = true; revealedAt = Date.now(); render(); };
for (const button of ratingButtons) button.onclick = () => void rate(Number(button.dataset.rating) as ReviewRating);
const chooseProjects = () => { started = false; current = undefined; render(); scrollTo(0, 0); projectOptions.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus(); };
element("choose-projects").onclick = chooseProjects;
element("back").onclick = chooseProjects;
// Installed to the Home Screen: the install instructions no longer apply.
element("install").hidden = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
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
	if (reviewMode(current.schedule) === "mcq") return;
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
