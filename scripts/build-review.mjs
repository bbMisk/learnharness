import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "public/review");
const source = path.join(root, "web/review");
const vendor = path.join(root, "vendor/fsrs");
const manifest = JSON.parse(await fs.readFile(path.join(vendor, "manifest.json"), "utf8"));
const binary = await fs.readFile(path.join(vendor, "engine.wasm"));
if (createHash("sha256").update(binary).digest("hex") !== manifest.sha256) throw new Error("FSRS binary does not match its pinned manifest");

async function files(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	return (await Promise.all(entries.filter(entry => !entry.name.startsWith(".")).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat().sort();
}
const inputs = [...await files(source), path.join(root, "src/core/review.ts"), path.join(root, "src/core/math-delims.ts"), path.join(root, "src/core/review-engine.ts"), path.join(vendor, "manifest.json"), path.join(root, "package-lock.json"), path.join(root, "scripts/build-review.mjs"), path.join(vendor, "THIRD_PARTY_NOTICES.txt"), path.join(root, "LICENSE"), path.join(root, "node_modules/katex/LICENSE")];
const fingerprint = createHash("sha256");
for (const file of inputs) fingerprint.update(path.relative(root, file)).update(await fs.readFile(file));
const version = fingerprint.digest("hex").slice(0, 20);

// This directory contains generated review assets only; mutable data stays in LH_DATA_DIR.
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(path.join(output, "assets"), { recursive: true });
const result = await build({
	absWorkingDir: root, entryPoints: ["web/review/app.ts"], outdir: "public/review/assets", entryNames: "app-[hash]", assetNames: "[name]-[hash]",
	bundle: true, format: "esm", platform: "browser", target: ["safari16"], minify: true, metafile: true,
	define: { __REVIEW_BUILD__: JSON.stringify(version) }, loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
});
const entry = Object.entries(result.metafile.outputs).find(([name, info]) => name.endsWith(".js") && info.entryPoint?.endsWith("web/review/app.ts"));
if (!entry || !entry[1].cssBundle) throw new Error("Review app assets are incomplete");
const relative = file => "./" + path.relative(output, path.resolve(root, file)).split(path.sep).join("/");
let html = await fs.readFile(path.join(source, "index.html"), "utf8");
html = html.replace("__SCRIPT__", relative(entry[0])).replace("__STYLE__", relative(entry[1].cssBundle));
await fs.writeFile(path.join(output, "index.html"), html);
await fs.copyFile(path.join(vendor, "engine.wasm"), path.join(output, "assets", manifest.wasmFile));
for (const size of [192, 512]) await fs.copyFile(path.join(source, `icon-${size}.png`), path.join(output, `icon-${size}.png`));
const notices = await fs.readFile(path.join(vendor, "THIRD_PARTY_NOTICES.txt"), "utf8");
const katexLicense = await fs.readFile(path.join(root, "node_modules/katex/LICENSE"), "utf8");
const license = await fs.readFile(path.join(root, "LICENSE"), "utf8");
await fs.writeFile(path.join(output, "licenses.txt"), notices + "\n\nKaTeX\n" + katexLicense + "\n\nAnki interval-policy excerpt: Copyright Ankitects Pty Ltd and contributors, AGPL-3.0-or-later.\nhttps://github.com/ankitects/anki/tree/26.09.3/rslib/src/scheduler/states\n\nLearnHarness and its adapter are AGPL-3.0-only.\n" + license);
await fs.writeFile(path.join(output, "manifest.webmanifest"), JSON.stringify({
	id: "/review/", name: "LearnHarness Flashcards", short_name: "LearnHarness", start_url: "/review/index.html", scope: "/review/", display: "standalone",
	background_color: "#141414", theme_color: "#141414", icons: [192, 512].map(size => ({ src: `./icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png" })),
}));
const assets = (await files(output)).map(file => "/review/" + path.relative(output, file).split(path.sep).join("/"));
const worker = (await fs.readFile(path.join(source, "sw.js"), "utf8")).replaceAll("__BUILD__", version).replace("__ASSETS__", JSON.stringify(assets));
await fs.writeFile(path.join(output, "sw.js"), worker);
await fs.writeFile(path.join(output, "build.json"), JSON.stringify({ version, engine: manifest.engineId, assets: assets.length }));
console.log(`[review] built ${version}: ${assets.length} offline assets; ${manifest.engineId}`);
