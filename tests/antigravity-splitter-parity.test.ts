/**
 * The stdout line splitter (src/agent/antigravity/acp-client.ts LineSplitter)
 * against the naive version it replaced, kept here as the reference: the
 * same lines, the same sign-in decision after every chunk and the same
 * too-long errors, on thousands of randomly built and randomly chunked
 * inputs (fixed seed).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LineSplitter, LineTooLongError, SIGN_IN_LINE_PREFIX } from "../src/agent/antigravity/acp-client.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

/** The previous implementation, verbatim in behaviour: whole remainder decoded for every sign-in check. */
class ReferenceSplitter {
	private parts: Buffer[] = [];
	private size = 0;
	constructor(private readonly maxBytes: number) {}
	push(chunk: Buffer): string[] {
		const lines: string[] = [];
		let start = 0;
		for (let newline = chunk.indexOf(10, start); newline >= 0; newline = chunk.indexOf(10, start)) {
			const piece = chunk.subarray(start, newline);
			if (this.size + piece.length > this.maxBytes) throw new LineTooLongError("line too long");
			lines.push(Buffer.concat([...this.parts, piece]).toString("utf8"));
			this.parts = [];
			this.size = 0;
			start = newline + 1;
		}
		const rest = chunk.subarray(start);
		if (rest.length > 0) {
			this.size += rest.length;
			if (this.size > this.maxBytes) throw new LineTooLongError("line too long");
			this.parts.push(rest);
		}
		return lines;
	}
	signIn(): boolean {
		const remainder = this.size === 0 ? "" : Buffer.concat(this.parts).toString("utf8");
		return remainder.trimStart().startsWith(SIGN_IN_LINE_PREFIX);
	}
}

/** mulberry32: small, fast, deterministic. */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WHITESPACE = [" ", "\t", "\r", " ", "　", "﻿", " ", "\v"];
const TEXT = ["a", "json", "{\"id\":1}", "é", "中文", "😀", "Open", "link", " ", "\r"];
const INVALID = [Buffer.from([0xff]), Buffer.from([0x80]), Buffer.from([0xe4, 0xb8])];

function line(next: () => number, pick: <T>(items: readonly T[]) => T): Buffer {
	const parts: Buffer[] = [];
	const shape = next();
	if (shape < 0.15) return Buffer.alloc(0); // empty line
	if (shape < 0.55) {
		// Leading whitespace, then the sign-in prefix, cut short or followed by more.
		for (let i = Math.floor(next() * 4); i > 0; i--) parts.push(Buffer.from(pick(WHITESPACE)));
		const cut = next() < 0.3 ? Math.floor(next() * SIGN_IN_LINE_PREFIX.length) : SIGN_IN_LINE_PREFIX.length;
		parts.push(Buffer.from(SIGN_IN_LINE_PREFIX.slice(0, cut)));
		if (next() < 0.3) parts.push(Buffer.from(pick(TEXT)));
		if (cut === SIGN_IN_LINE_PREFIX.length) parts.push(Buffer.from(" the ACP server: https://example.invalid/x"));
	}
	for (let i = Math.floor(next() * 12); i > 0; i--) {
		const r = next();
		parts.push(r < 0.08 ? pick(INVALID) : r < 0.3 ? Buffer.from(pick(WHITESPACE)) : Buffer.from(pick(TEXT)));
	}
	if (next() < 0.05) parts.push(Buffer.alloc(Math.floor(next() * 400), 0x62)); // sometimes long
	if (next() < 0.2) parts.push(Buffer.from("\r"));
	return Buffer.concat(parts);
}

function input(next: () => number, pick: <T>(items: readonly T[]) => T): Buffer {
	const lines: Buffer[] = [];
	for (let i = 1 + Math.floor(next() * 6); i > 0; i--) lines.push(line(next, pick), Buffer.from("\n"));
	if (next() < 0.6) lines.push(line(next, pick)); // an unfinished last line
	return Buffer.concat(lines);
}

function chunks(bytes: Buffer, next: () => number): Buffer[] {
	const out: Buffer[] = [];
	for (let offset = 0; offset < bytes.length;) {
		const size = next() < 0.5 ? 1 + Math.floor(next() * 4) : 1 + Math.floor(next() * 64);
		out.push(bytes.subarray(offset, offset + size));
		offset += size;
	}
	return out;
}

type Step = { lines?: string[]; tooLong?: true; signIn?: boolean };

function run(make: () => { push(chunk: Buffer): string[]; signIn(): boolean }, parts: Buffer[]): Step[] {
	const splitter = make();
	const steps: Step[] = [];
	for (const part of parts) {
		try { steps.push({ lines: splitter.push(part), signIn: splitter.signIn() }); }
		catch (error) {
			assert.ok(error instanceof LineTooLongError);
			steps.push({ tooLong: true });
			break;
		}
	}
	return steps;
}

const CASES = 4000;

test(`the new splitter matches the reference on ${CASES} random inputs: lines, sign-in decisions, too-long errors`, () => {
	const next = random(20261123);
	const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	let signIns = 0, tooLong = 0, multibyteSplits = 0;
	for (let i = 0; i < CASES; i++) {
		const bytes = input(next, pick);
		const parts = chunks(bytes, next);
		const cap = next() < 0.25 ? 16 + Math.floor(next() * 120) : 16 * 1024 * 1024;
		const reference = run(() => { const s = new ReferenceSplitter(cap); return { push: (c) => s.push(c), signIn: () => s.signIn() }; }, parts);
		const current = run(() => { const s = new LineSplitter(cap); return { push: (c) => s.push(c), signIn: () => s.unfinishedIsSignIn() }; }, parts);
		assert.deepEqual(current, reference, `case ${i}: ${JSON.stringify(bytes.toString("latin1"))} in ${parts.length} chunks, cap ${cap}`);
		if (reference.some((step) => step.signIn)) signIns++;
		if (reference.some((step) => step.tooLong)) tooLong++;
		if (parts.some((part) => part.length > 0 && (part[part.length - 1]! & 0xc0) === 0xc0)) multibyteSplits++;
	}
	// The generator really exercised what matters.
	assert.ok(signIns > CASES / 10, `sign-in seen in ${signIns} cases`);
	assert.ok(tooLong > CASES / 50, `too-long seen in ${tooLong} cases`);
	assert.ok(multibyteSplits > CASES / 10, `multi-byte characters split across chunks in ${multibyteSplits} cases`);
});
