/** Local-only launcher for the Hanson fork. Never uses the installed app's data. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const root = path.resolve(import.meta.dirname, "..");
const server = path.join(root, ".next/standalone/server.js");
if (!fs.existsSync(server)) throw new Error("Build first: npm run build && node scripts/build-server.mjs");
const port = process.env.LH_LOCAL_PORT ?? "3027";
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("LH_LOCAL_PORT must be a port between 1024 and 65535.");
const url = `http://127.0.0.1:${port}`;
const appData = process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support/LearnHarness-Hanson") : path.join(os.homedir(), ".local/share/learnharness-hanson");
fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [server], { cwd: path.dirname(server), stdio: "inherit", env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: port, LH_DATA_DIR: path.join(appData, "data"), LH_AUTH_FILE: path.join(appData, "auth.json") } });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code ?? 1));
let attempts = 0;
const timer = setInterval(() => {
	const req = http.get(url, (response) => {
		response.resume();
		if (response.statusCode !== 200) return;
		clearInterval(timer);
		console.log(`LearnHarness (Hanson fork): ${url}\nKeep this terminal open. Press Ctrl+C to stop.`);
		if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore" }).unref();
	});
	req.on("error", () => {});
	req.setTimeout(1000, () => req.destroy());
	if (++attempts === 60) { clearInterval(timer); console.error("The local server did not become ready. Check the messages above."); child.kill("SIGTERM"); }
}, 500);
timer.unref();
