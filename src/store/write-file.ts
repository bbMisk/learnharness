import fs from "node:fs";
import { randomUUID } from "node:crypto";

/** Replace a complete record; a failed write must leave the saved copy intact. */
export function writeFileAtomic(file: string, content: string): void {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
		fs.writeFileSync(temp, content, { encoding: "utf-8", mode });
		if (mode !== undefined) fs.chmodSync(temp, mode);
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}
