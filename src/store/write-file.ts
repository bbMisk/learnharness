import fs from "node:fs";
import { randomUUID } from "node:crypto";

export interface WriteFileAtomicOptions {
	/** Create the replacement with this mode (subject to umask) instead of copying the saved file's mode. */
	mode?: number;
	/** Flush the replacement to disk before it takes the saved copy's place. */
	fsync?: boolean;
	/** Refuse to reuse an existing path for the temporary copy. */
	exclusive?: boolean;
}

/** Replace a complete record; a failed write must leave the saved copy intact. */
export function writeFileAtomic(file: string, content: string, options: WriteFileAtomicOptions = {}): void {
	const temp = `${file}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		const preserved = options.mode === undefined ? fs.statSync(file, { throwIfNoEntry: false })?.mode : undefined;
		descriptor = fs.openSync(temp, options.exclusive ? "wx" : "w", options.mode ?? preserved);
		fs.writeFileSync(descriptor, content, "utf8");
		if (options.fsync) fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		if (preserved !== undefined) fs.chmodSync(temp, preserved);
		fs.renameSync(temp, file);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		fs.rmSync(temp, { force: true });
	}
}
