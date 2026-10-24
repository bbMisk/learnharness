// electron-builder afterPack hook — mac only.
//
// WHY (owner ruling 2026-10-13): mac.icon is the Icon Composer document
// (build/icon.icon); actool compiles it into Assets.car (the macOS 26
// Liquid Glass render) PLUS a backwards-compat icns — but actool's
// fallback icns caps at 256px (known actool behavior), which looks soft
// at Finder/Launchpad sizes on pre-Tahoe macOS. This hook swaps in the
// hand-packed full-res build/icon.icns (all 10 entries, 16→1024, packed
// via iconutil from the design's PNG exports) AFTER packaging and BEFORE
// signing, so:
//
//   macOS 26+  → Assets.car (CFBundleIconName) — true layered glass icon;
//   older mac  → icon.icns (CFBundleIconFile) — today's full-res flatten.
//
// Windows/Linux builds return immediately (their icons are static files:
// build/icon.ico / build/icon.png).
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const target = path.join(appBundle, "Contents", "Resources", "icon.icns");
	const source = path.join(context.packager.info.projectDir, "build", "icon.icns");
	fs.copyFileSync(source, target);
	if (context.packager.config.mac?.identity === "-") {
		// Finder metadata is not code and makes strict signing verification fail.
		// Remove only those two attributes; preserve quarantine/security metadata.
		for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
			const result = spawnSync("/usr/bin/xattr", ["-r", "-d", attribute, appBundle], { encoding: "utf8" });
			if (result.error) throw result.error;
		}
	}
	console.log(`[after-pack] pre-Tahoe fallback icns (full-res) → ${target}`);
};
