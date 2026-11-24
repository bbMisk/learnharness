/**
 * smoke-antigravity.mjs (Hanson's fork, docs/antigravity.md): prove the
 * Antigravity provider works inside the PACKAGED server, which unit tests
 * can't show: its registration, the server→agent wiring and the gates.
 *
 * Run after `npm run build && node scripts/build-server.mjs`:
 *   node scripts/smoke-antigravity.mjs
 *
 * The only agent it can start is tests/fixtures/antigravity/mock-agy.mjs,
 * named explicitly through LH_AGY_BINARY (the server then never searches
 * PATH for a real `agy`); PATH entries holding an `agy` are also removed
 * from the server's environment. Everything lives under one throwaway
 * folder in os.tmpdir(): data, auth file, TMPDIR and the mock's log.
 *
 * Steps:
 *   1. boot with the switch forced off (LH_FORK_ANTIGRAVITY=0): GET /api/antigravity → 200 { available: false },
 *      and no Antigravity model in GET /api/models;
 *   2. boot WITH LH_FORK_ANTIGRAVITY=1: GET → available, not enabled;
 *      PUT enabled; POST check → models listed and in GET /api/models with
 *      each model's thinking levels;
 *   3. create a chat, pin it to a mock model at thinking level "low", send one learner message
 *      (all through the public HTTP API); the scripted reply arrives and is
 *      saved; the mock saw `acp --sandbox`, no `authenticate`, and mode
 *      "default" and level "low" set before the prompt;
 *      then a second learner message on the same chat: one session/new for
 *      both turns and only the new message in the second prompt;
 *      then a third message in which the mock calls the lesson's declared
 *      ask_user_question tool through the MCP bridge: the server ends the turn
 *      with the question pending, the smoke answers it through the public API,
 *      and the same agent prompt continues with the answer (one tool round);
 *      then a helper run: the pdfReader role pinned to the mock model, the
 *      prober hands over (probe_done), the teacher calls pdf on
 *      tests/fixtures/sample-3page.pdf, and the PDF-reader job runs on the mock
 *      with its real tools (pdf_info, pdf_extract) and finishes;
 *      then POST { action: "signIn" }: authenticate is sent once (the mock is
 *      "signed in already"), and the normal check runs;
 *   4. stop the server: no mock process is left and the agent's temp
 *      folders are gone.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const SERVER = path.join(STANDALONE, "server.js");
const MOCK = path.join(ROOT, "tests", "fixtures", "antigravity", "mock-agy.mjs");
const REPLY = "Smoke reply from the mock agent.";
const ASK = { question: "Which topic should we cover next?", options: [{ label: "Chemistry" }, { label: "History" }] };
const TOOL_REPLY_END = " Thanks for answering.";
const ASSESSMENT = { assessment: { strands: [{ strand: "integrals", assessment: "Ready for the integral rule." }], summary: "Start at the integral rule." } };
const PDF_BRIEF = "Page 1 states the integral rule (p. 1): x dx integrates to x^2/2.";
const BOOT_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 30_000;
const INTENT = { "x-learnharness-antigravity": "1" };

const say = (line) => console.log(`[smoke-antigravity] ${line}`);
function check(condition, message) {
	if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the one agent this script may start ---------------------------------
if (!fs.existsSync(MOCK)) {
	console.error(`[smoke-antigravity] ${MOCK} is missing; refusing to run.`);
	process.exit(1);
}
const MOCK_REAL = fs.realpathSync(MOCK);
if (path.basename(MOCK_REAL) !== "mock-agy.mjs" || !path.isAbsolute(MOCK_REAL)) {
	console.error(`[smoke-antigravity] the agent path does not resolve to mock-agy.mjs (${MOCK_REAL}); refusing to run.`);
	process.exit(1);
}
fs.accessSync(MOCK_REAL, fs.constants.X_OK);
if (!fs.existsSync(SERVER)) {
	console.error("[smoke-antigravity] .next/standalone/server.js missing: run `npm run build && node scripts/build-server.mjs` first.");
	process.exit(1);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function status(url) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
		req.on("error", () => resolve(0));
		req.setTimeout(5000, () => { req.destroy(); resolve(0); });
	});
}

/** PATH without any folder that holds an `agy`, so nothing but LH_AGY_BINARY can name one. */
function pathWithoutAgy(value) {
	return (value ?? "").split(path.delimiter).filter((dir) => dir && !fs.existsSync(path.join(dir, process.platform === "win32" ? "agy.exe" : "agy"))).join(path.delimiter);
}

function readLog(file) {
	try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
	catch { return []; }
}

function pidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/** Boot the standalone server with `extraEnv`; returns { url, stop, tail }. */
async function boot(home, extraEnv) {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const tail = [];
	const env = {
		...probeEnv(process.env, home),
		PATH: pathWithoutAgy(process.env.PATH),
		NODE_ENV: "production",
		PORT: String(port),
		HOSTNAME: "127.0.0.1",
		TMPDIR: path.join(home, "tmp"),
		TEMP: path.join(home, "tmp"),
		TMP: path.join(home, "tmp"),
		...extraEnv,
	};
	// The switch is on by default in the code: each boot states it explicitly.
	env.LH_FORK_ANTIGRAVITY = extraEnv.LH_FORK_ANTIGRAVITY ?? "0";
	const child = spawn(process.execPath, [SERVER], { cwd: STANDALONE, env, stdio: ["ignore", "pipe", "pipe"] });
	let exited = false;
	const keep = (buf) => { tail.push(...buf.toString().split("\n")); if (tail.length > 200) tail.splice(0, tail.length - 200); };
	child.stdout.on("data", keep);
	child.stderr.on("data", keep);
	child.on("exit", () => { exited = true; });
	const stop = () => new Promise((resolve) => {
		if (exited) return resolve();
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
		setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000).unref();
	});
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited) throw Object.assign(new Error(`server exited before answering on ${url}`), { tail });
		if (await status(url) === 200) return { url, stop, tail };
		await sleep(500);
	}
	await stop();
	throw Object.assign(new Error(`server never answered 200 on ${url}`), { tail });
}

async function json(url, init = {}) {
	const response = await fetch(url, init);
	const text = await response.text();
	let body;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: response.status, body };
}

const send = (url, method, body, headers = {}) => json(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function main() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-antigravity-"));
	fs.mkdirSync(path.join(home, "tmp"));
	const authFile = path.join(home, "auth.json");
	fs.writeFileSync(authFile, "{}\n");
	const logFile = path.join(home, "mock-agy.log");
	const agentTemp = path.join(home, "tmp", "learnharness-antigravity");
	let server;
	try {
		// 1. Switch forced off.
		server = await boot(home, { LH_FORK_ANTIGRAVITY: "0" });
		const off = await json(`${server.url}/api/antigravity`, { headers: INTENT });
		check(off.status === 200 && JSON.stringify(off.body) === JSON.stringify({ available: false }), `switch off: GET /api/antigravity → ${off.status} ${JSON.stringify(off.body)}`);
		const offModels = await json(`${server.url}/api/models`);
		check(offModels.status === 200 && !offModels.body.models.some((m) => m.provider === "antigravity"), "switch off: an Antigravity model is listed");
		check((await send(`${server.url}/api/antigravity`, "PUT", { enabled: true }, INTENT)).status === 404, "switch off: PUT is not refused with 404");
		say("switch off: GET → { available: false }, no models, PUT → 404");
		await server.stop();

		// 2. Switch on, the mock named explicitly.
		const agentEnv = {
			LH_FORK_ANTIGRAVITY: "1",
			LH_AGY_BINARY: MOCK_REAL,
			MOCK_AGY_LOG: logFile,
			// The real agent starts in "default"; starting the mock in "auto" also exercises setting the mode.
			MOCK_AGY_SCENARIO: JSON.stringify({ mode: "auto", prompt: [{ text: REPLY }, { usageUpdate: true }], promptSeq: [
				[{ text: REPLY }, { usageUpdate: true }],
				[{ text: REPLY }, { usageUpdate: true }],
				// The third lesson prompt: one tool round with a declared LearnHarness tool.
				[{ mcpCall: { name: "ask_user_question", arguments: ASK, echo: true } }, { text: TOOL_REPLY_END }],
				// The prober hands over; the teacher (a fresh session) dispatches the PDF job.
				[{ mcpCall: { name: "probe_done", arguments: ASSESSMENT } }, { text: "Handing over to teaching." }],
				[{ mcpCall: { name: "pdf", arguments: { path: path.join(home, "lesson.pdf"), question: "What is on page 1?" } } }, { text: " I'll read it." }],
				// The PDF-reader job on the pdfReader role's (mock) model, with its real tools.
				[{ mcpCall: { name: "pdf_info", arguments: {} } }, { mcpCall: { name: "pdf_extract", arguments: { pages: "1" } } }, { text: PDF_BRIEF }],
				// The job's result re-enters the lesson.
				[{ text: "From your PDF: the integral rule." }],
			] }),
		};
		check(path.basename(agentEnv.LH_AGY_BINARY) === "mock-agy.mjs", "LH_AGY_BINARY is not the mock");
		server = await boot(home, agentEnv);
		const on = await json(`${server.url}/api/antigravity`, { headers: INTENT });
		check(on.status === 200 && on.body.available === true && on.body.enabled === false && on.body.installed === true, `switch on: GET → ${JSON.stringify(on.body)}`);
		const enabled = await send(`${server.url}/api/antigravity`, "PUT", { enabled: true }, INTENT);
		check(enabled.status === 200 && enabled.body.enabled === true, `PUT enabled → ${enabled.status} ${JSON.stringify(enabled.body)}`);
		const checked = await send(`${server.url}/api/antigravity`, "POST", { action: "check" }, INTENT);
		check(checked.status === 200 && checked.body.models > 0 && checked.body.checkedAt && !checked.body.problem, `POST check → ${checked.status} ${JSON.stringify(checked.body)}`);
		const onModels = await json(`${server.url}/api/models`);
		const models = onModels.body.models.filter((m) => m.provider === "antigravity");
		check(models.length === checked.body.models, `GET /api/models lists ${models.length} Antigravity models, the check listed ${checked.body.models}`);
		check(models.every((m) => m.cost === null && m.contextWindow === null), "Antigravity models carry an invented price or limit");
		// The mock offers per-model thinking levels like the real agent (learned at Check connection).
		const expectedLevels = { "gemini-3-pro": ["low", "medium", "high", "xhigh"], "gemini-3-flash": ["low", "medium", "high"] };
		for (const model of models) {
			check(model.reasoning === true && JSON.stringify(model.supportedLevels) === JSON.stringify(expectedLevels[model.id]), `levels of ${model.id}: ${JSON.stringify(model.supportedLevels)}`);
		}
		say(`switch on: enabled, check listed ${models.length} models (agy ${checked.body.agentVersion}), all in /api/models`);

		// 3. One lesson turn through the public API.
		const created = await send(`${server.url}/api/chats`, "POST", { title: "Antigravity smoke" });
		check(created.status === 200 && typeof created.body.id === "string", `POST /api/chats → ${created.status} ${JSON.stringify(created.body)}`);
		const chatId = created.body.id;
		// The same settings call the picker makes: the chat's model and thinking level ("low"; the agent's default is "high").
		const pinned = await send(`${server.url}/api/chats/${chatId}/settings`, "PUT", { model: { provider: "antigravity", id: models[0].id }, thinkingLevel: "low" });
		check(pinned.status === 200 && pinned.body.settings?.thinkingLevel === "low", `pin the chat → ${pinned.status} ${JSON.stringify(pinned.body)}`);
		const turn = await send(`${server.url}/api/chat`, "POST", { chatId, input: { type: "text", text: "Teach me about fractions." } });
		check(turn.status === 200, `POST /api/chat → ${turn.status} ${JSON.stringify(turn.body)}`);
		// Drain the turn's stream (it ends when the turn settles), then read the saved record.
		await fetch(`${server.url}/api/chats/${chatId}/stream`).then((res) => res.text()).catch(() => "");
		const chatFile = path.join(home, "data", "chats", `${chatId}.json`);
		const deadline = Date.now() + TURN_TIMEOUT_MS;
		let saved;
		while (Date.now() < deadline) {
			try { saved = JSON.parse(fs.readFileSync(chatFile, "utf8")); } catch { saved = undefined; }
			const reply = saved?.messages?.findLast?.((m) => m.role === "assistant");
			if (reply && reply.stopReason !== "pending") break;
			await sleep(250);
		}
		const reply = saved?.messages?.findLast?.((m) => m.role === "assistant");
		check(reply, "no assistant message was saved");
		const replyText = (reply.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
		check(reply.provider === "antigravity" && replyText === REPLY, `saved reply: provider ${reply.provider}, stop ${reply.stopReason}, error ${JSON.stringify(reply.errorMessage ?? null)}, text ${JSON.stringify(replyText)}`);
		const read = await json(`${server.url}/api/chats/${chatId}`);
		check(read.status === 200 && JSON.stringify(read.body).includes(REPLY), "GET /api/chats/:id does not carry the reply");
		const log = readLog(logFile);
		const starts = log.filter((entry) => entry.kind === "start");
		check(starts.length > 0 && starts.every((entry) => JSON.stringify(entry.argv) === JSON.stringify(["acp", "--sandbox"])), `mock launched with ${JSON.stringify(starts.map((s) => s.argv))}`);
		const received = log.filter((entry) => entry.kind === "recv" && entry.line.trim()).map((entry) => JSON.parse(entry.line));
		check(!received.some((m) => m.method === "authenticate"), "authenticate was sent");
		const promptAt = received.findIndex((m) => m.method === "session/prompt");
		const modeAt = received.findIndex((m) => m.method === "session/set_config_option" && m.params?.configId === "mode" && m.params?.value === "default");
		check(promptAt >= 0 && modeAt >= 0 && modeAt < promptAt, `mode "default" was not set before the prompt (mode at ${modeAt}, prompt at ${promptAt})`);
		const levelAt = received.findIndex((m) => m.method === "session/set_config_option" && m.params?.configId === "thought_level" && m.params?.value === "low");
		check(levelAt >= 0 && levelAt < promptAt, `thinking level "low" was not set before the prompt (level at ${levelAt}, prompt at ${promptAt})`);
		check(JSON.stringify(received[promptAt]).includes("Teach me about fractions."), "the prompt does not carry the learner's message");
		say(`lesson turn: reply saved (${JSON.stringify(replyText)}); mock saw acp --sandbox, no authenticate, mode "default" and level "low" before the prompt`);

		// A second turn on the same chat continues the same agent session with only the new message.
		const second = await send(`${server.url}/api/chat`, "POST", { chatId, input: { type: "text", text: "And what about decimals?" } });
		check(second.status === 200, `second POST /api/chat → ${second.status} ${JSON.stringify(second.body)}`);
		await fetch(`${server.url}/api/chats/${chatId}/stream`).then((res) => res.text()).catch(() => "");
		const until2 = Date.now() + TURN_TIMEOUT_MS;
		let replies = [];
		while (Date.now() < until2) {
			try { replies = JSON.parse(fs.readFileSync(chatFile, "utf8")).messages.filter((m) => m.role === "assistant" && m.stopReason !== "pending"); } catch { replies = []; }
			if (replies.length >= 2) break;
			await sleep(250);
		}
		check(replies.length >= 2 && replies.at(-1).stopReason === "stop", `second reply: ${JSON.stringify(replies.at(-1) ?? null)}`);
		const log2 = readLog(logFile);
		const prompts = log2.filter((entry) => entry.kind === "prompt");
		// Check connection opened its own throwaway session earlier: count only what came after the lesson's first prompt.
		const sessionNews = log2.slice(log2.indexOf(prompts[0]) + 1).filter((entry) => entry.kind === "recv" && entry.line.includes('"method":"session/new"')).length;
		check(prompts.length === 2 && sessionNews === 0 && prompts[1].sessionId === prompts[0].sessionId, `two turns: ${sessionNews} session/new after the first prompt, prompts ${JSON.stringify(prompts.map((p) => [p.sessionId, p.n]))}`);
		check(JSON.stringify(prompts[1].texts) === JSON.stringify(["And what about decimals?"]), `second prompt sent ${JSON.stringify(prompts[1].texts)}, not only the new message`);
		say("second turn: same agent session (one session/new), only the new message sent");

		// A third turn: the mock calls the lesson's ask_user_question through the bridge; the question waits for the learner.
		const third = await send(`${server.url}/api/chat`, "POST", { chatId, input: { type: "text", text: "Ask me what to do next." } });
		check(third.status === 200, `third POST /api/chat → ${third.status} ${JSON.stringify(third.body)}`);
		await fetch(`${server.url}/api/chats/${chatId}/stream`).then((res) => res.text()).catch(() => "");
		const until3 = Date.now() + TURN_TIMEOUT_MS;
		let asked;
		while (Date.now() < until3) {
			try { asked = JSON.parse(fs.readFileSync(chatFile, "utf8")).messages.findLast((m) => m.role === "assistant"); } catch { asked = undefined; }
			if (asked?.stopReason === "toolUse") break;
			await sleep(250);
		}
		const question = asked?.content?.find?.((b) => b.type === "toolCall");
		check(asked?.stopReason === "toolUse" && question?.name === "ask_user_question", `the tutor's question: ${JSON.stringify(asked ?? null)}`);
		const answered = await send(`${server.url}/api/chat`, "POST", { chatId, input: { type: "answer", toolCallId: question.id, answer: { kind: "ask", questionText: ASK.question, dontKnow: false, answers: [], text: "History", answeredAt: new Date().toISOString() } } });
		check(answered.status === 200, `answer POST /api/chat → ${answered.status} ${JSON.stringify(answered.body)}`);
		await fetch(`${server.url}/api/chats/${chatId}/stream`).then((res) => res.text()).catch(() => "");
		const until4 = Date.now() + TURN_TIMEOUT_MS;
		let after;
		while (Date.now() < until4) {
			try { after = JSON.parse(fs.readFileSync(chatFile, "utf8")).messages.findLast((m) => m.role === "assistant"); } catch { after = undefined; }
			if (after && after !== asked && after.stopReason !== "pending" && after.stopReason !== "toolUse") break;
			await sleep(250);
		}
		const afterText = (after?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
		check(after?.stopReason === "stop" && afterText.includes("History") && afterText.endsWith(TOOL_REPLY_END), `after the answer: ${JSON.stringify(after ?? null)}`);
		const log3 = readLog(logFile);
		const tools = log3.find((entry) => entry.kind === "mcp-tools");
		check(tools && tools.names.includes("ask_user_question"), `the bridge listed ${JSON.stringify(tools?.names ?? null)}`);
		const allowed = log3.filter((entry) => entry.kind === "permission-answer").map((entry) => entry.answer?.outcome?.optionId);
		check(JSON.stringify(allowed) === JSON.stringify(["allow"]), `permission answers ${JSON.stringify(allowed)}`);
		const prompts3 = log3.filter((entry) => entry.kind === "prompt");
		check(prompts3.length === 3, `the tool round used ${prompts3.length - 2} agent prompts, not one`);
		say("tool turn: the mock called ask_user_question through the bridge, the answer resumed the same agent prompt");

		// A helper run: the pdfReader role pinned to the mock model; the teacher's pdf tool starts the job.
		fs.copyFileSync(path.join(ROOT, "tests", "fixtures", "sample-3page.pdf"), path.join(home, "lesson.pdf"));
		const role = await send(`${server.url}/api/settings/agent`, "PUT", { models: { pdfReader: { model: { provider: "antigravity", id: models[0].id } } } });
		check(role.status === 200, `pin the pdfReader role → ${role.status} ${JSON.stringify(role.body)}`);
		const handover = await send(`${server.url}/api/chat`, "POST", { chatId, input: { type: "text", text: "Let's start the lesson." } });
		check(handover.status === 200, `handover POST /api/chat → ${handover.status} ${JSON.stringify(handover.body)}`);
		await fetch(`${server.url}/api/chats/${chatId}/stream`).then((res) => res.text()).catch(() => "");
		const jobsDir = path.join(home, "data", "jobs");
		const untilJob = Date.now() + 60_000;
		let pdfJob;
		while (Date.now() < untilJob) {
			const jobs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json")).map((name) => { try { return JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")); } catch { return undefined; } }) : [];
			pdfJob = jobs.find((job) => job?.kind === "pdf");
			if (pdfJob && pdfJob.status !== "running" && pdfJob.status !== "queued") break;
			await sleep(250);
		}
		check(pdfJob?.status === "done" && String(pdfJob.result?.brief ?? "").includes("integral rule"), `the PDF-reader job: ${JSON.stringify(pdfJob ?? null).slice(0, 400)}`);
		const toolLists = readLog(logFile).filter((entry) => entry.kind === "mcp-tools").map((entry) => entry.names);
		check(toolLists.some((names) => names.includes("pdf_info") && names.includes("pdf_extract")), `the job's tools were offered: ${JSON.stringify(toolLists)}`);
		check(!readLog(logFile).some((entry) => entry.kind === "authenticate"), "authenticate was sent before any Sign in");
		say("helper run: a PDF-reader job ran on the mock Antigravity model with its real tools");

		// Sign in: only this click sends authenticate (the mock is signed in already), then the normal check runs.
		const signedIn = await send(`${server.url}/api/antigravity`, "POST", { action: "signIn" }, INTENT);
		check(signedIn.status === 200 && signedIn.body.checkedAt && !signedIn.body.problem && !signedIn.body.signingIn, `POST signIn → ${signedIn.status} ${JSON.stringify(signedIn.body)}`);
		const authenticates = readLog(logFile).filter((entry) => entry.kind === "authenticate");
		check(authenticates.length === 1 && authenticates[0].methodId === "oauth-personal", `authenticate sent ${JSON.stringify(authenticates)}`);
		say("sign in: one authenticate (oauth-personal), then the connection check");

		// 4. Stop: nothing left behind (and the agent's temp root did exist while it ran).
		const during = fs.existsSync(agentTemp) ? fs.readdirSync(agentTemp).filter((name) => name.startsWith("run-")) : [];
		check(during.length > 0, `no agent temp root under ${agentTemp} while the agent ran`);
		await server.stop();
		server = undefined;
		const pids = starts.map((entry) => entry.pid);
		const until = Date.now() + 5000;
		while (pids.some(pidAlive) && Date.now() < until) await sleep(100);
		check(!pids.some(pidAlive), `mock agent processes left running: ${pids.filter(pidAlive).join(", ")}`);
		const leftovers = fs.existsSync(agentTemp) ? fs.readdirSync(agentTemp) : [];
		check(leftovers.length === 0, `agent temp folders left: ${leftovers.join(", ")}`);
		say(`stopped: ${pids.length} mock process(es) gone, no agent temp folders left`);
		say("smoke passed: the packaged server registers Antigravity, gates it, and runs a lesson on the mock agent.");
	} catch (error) {
		console.error(`[smoke-antigravity] FAIL: ${error.message}`);
		for (const line of (error.tail ?? server?.tail ?? []).slice(-40)) if (line.trim()) console.error(`    ${line}`);
		process.exitCode = 1;
	} finally {
		if (server) await server.stop();
		// Belt and braces: never leave a mock behind, but only ever signal the pids this run's mock logged.
		for (const entry of readLog(logFile).filter((e) => e.kind === "start")) if (pidAlive(entry.pid)) try { process.kill(entry.pid, "SIGKILL"); } catch { /* gone */ }
		fs.rmSync(home, { recursive: true, force: true });
	}
}

await main();
