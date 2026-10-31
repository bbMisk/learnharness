/**
 * Connection settings, the Connection window and Home-only quit (fork).
 * Kept out of main.cjs so the upstream shell carries only call sites.
 * The factory takes Electron's main-process objects and live getters for
 * the state main.cjs owns (the private server child and its API secret).
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const connection = require(path.join(__dirname, "shared-server.cjs"));

function createConnectionIPC({ app, BrowserWindow, ipcMain, dialog, serverProcess, desktopAPISecret }) {
	let connectionWindow = null;
	const connectionPage = path.join(__dirname, "connection.html");
	const connectionPageURL = pathToFileURL(connectionPage).href;
	const connectionSenders = new WeakMap();

	function trustedConnectionSender(event) {
		const allowed = connectionSenders.get(event.sender);
		const frame = event.senderFrame;
		if (!allowed || !frame || frame !== event.sender.mainFrame) return false;
		return (allowed.origin && frame.origin === allowed.origin) || (allowed.allowLocal && frame.url.split("?")[0] === connectionPageURL);
	}
	function openConnectionWindow() {
		if (connectionWindow && !connectionWindow.isDestroyed()) {
			connectionWindow.focus();
			return;
		}
		const win = new BrowserWindow({
			width: 600,
			height: 520,
			resizable: false,
			title: "Connection",
			backgroundColor: "#181818",
			webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") },
		});
		connectionWindow = win;
		connectionSenders.set(win.webContents, { allowLocal: true });
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		win.webContents.on("will-navigate", (event, target) => {
			if (target.split("?")[0] !== connectionPageURL) event.preventDefault();
		});
		win.on("closed", () => {
			connectionWindow = null;
		});
		void win.loadFile(connectionPage);
	}
	function requestContextClose(win) {
		if (!win || win.isDestroyed()) return;
		if (win === connectionWindow || win.webContents.getURL().startsWith("file:")) win.close();
		else win.webContents.send("lh:close-context");
	}
	function installConnectionIPC(serverUrl) {
		const confirmQuit = require(path.join(__dirname, "quit-confirmation.cjs")).createQuitConfirmation(
			app.getPath("userData"),
			(win, options) => dialog.showMessageBox(win, options),
			() => app.quit(),
		);
		ipcMain.handle("lh:quit-from-home", (event) => {
			if (!trustedConnectionSender(event) || new URL(event.senderFrame.url).pathname !== "/")
				throw new Error("Quit must be requested from Home.");
			return confirmQuit(BrowserWindow.fromWebContents(event.sender));
		});
		ipcMain.handle("lh:connection:get", (event) => {
			if (!trustedConnectionSender(event)) throw new Error("Untrusted connection request.");
			try {
				return connection.connectionSettings(app.getPath("userData"));
			} catch {
				return { mode: "local", url: "" };
			}
		});
		ipcMain.handle("lh:connection:open", (event) => {
			if (!trustedConnectionSender(event)) throw new Error("Untrusted connection request.");
			openConnectionWindow();
		});
		ipcMain.handle("lh:connection:set", async (event, value) => {
			if (!trustedConnectionSender(event)) throw new Error("Untrusted connection request.");
			try {
				if (value !== null) await connection.checkServer(value);
				// A privately spawned local server dies on app quit. Let its turns finish.
				if (serverProcess()) {
					const secret = desktopAPISecret();
					const [chats, activity] = await Promise.all(
						["/api/chats", "/api/activity"].map((route) =>
							fetch(serverUrl + route, {
								headers: secret ? { "x-learnharness-desktop": secret } : {},
								signal: AbortSignal.timeout(3000),
							}).then((r) => r.json()),
						),
					);
					if (chats.chats.some((chat) => chat.busy || chat.compacting) || activity.extractions.length || activity.jobs.length)
						throw new Error("Let the current lesson and background tasks finish before changing connections.");
				}
				connection.saveConnection(app.getPath("userData"), value);
				setTimeout(() => {
					app.relaunch();
					app.quit();
				}, 200);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error.message || "Could not connect to this host." };
			}
		});
	}

	return { connectionPage, connectionSenders, trustedConnectionSender, openConnectionWindow, requestContextClose, installConnectionIPC };
}

module.exports = { createConnectionIPC };
