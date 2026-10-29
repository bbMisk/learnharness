const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function isLoopback(url) {
	return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
}
function normalizeServerURL(value) {
	if (typeof value !== "string" || !value.trim()) throw new Error("Enter the host URL.");
	const url = new URL(value.trim());
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.href))) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Use an HTTPS host URL without a path, or HTTP on localhost.");
	}
	return url.origin;
}
function readConnection(userData) {
	const file = path.join(userData, "shared-server.json");
	if (!fs.existsSync(file)) return {};
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	return {
		...(record.url ? { url: normalizeServerURL(record.url) } : {}),
		...(record.localUrl ? { localUrl: normalizeServerURL(record.localUrl) } : {}),
	};
}
/** The existing loopback configuration remains valid; a remote host is opt-in. */
function sharedServerURL(userData) { return readConnection(userData).url; }
function connectionSettings(userData) {
	const record = readConnection(userData);
	return { mode: record.url && !isLoopback(record.url) ? "host" : "local", url: record.url || "" };
}
function saveConnection(userData, value) {
	let previous = {};
	try { previous = readConnection(userData); } catch { /* An invalid configuration must be repairable. */ }
	const localUrl = previous.url && isLoopback(previous.url) ? previous.url : previous.localUrl;
	const url = value === null ? localUrl : normalizeServerURL(value);
	const record = { ...(url ? { url } : {}), ...(localUrl ? { localUrl } : {}) };
	fs.mkdirSync(userData, { recursive: true });
	const file = path.join(userData, "shared-server.json");
	const temp = file + "." + randomUUID() + ".tmp";
	fs.writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temp, file);
	return record;
}
async function checkServer(value, fetchLike = fetch) {
	const url = normalizeServerURL(value);
	const response = await fetchLike(url + "/api/health", { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" });
	const body = await response.json();
	if (!response.ok || body.app !== "learnharness") throw new Error("This address is not a reachable LearnHarness host.");
	return url;
}
module.exports = { sharedServerURL, normalizeServerURL, connectionSettings, saveConnection, checkServer, isLoopback };
