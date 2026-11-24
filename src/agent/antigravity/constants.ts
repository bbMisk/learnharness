import { ANTIGRAVITY_UNAVAILABLE } from "../../core/contracts/antigravity.ts";

export { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-acp";

/** Every message a learner can see from this provider. None of them carries agent output. */
export const AntigravityMessage = {
	Off: ANTIGRAVITY_UNAVAILABLE,
	NotInstalled: "Antigravity's agy command was not found. Install Antigravity, then check again in Settings.",
	NotSignedIn: 'Not signed in to Antigravity. Run "agy" in a terminal and sign in, then check again in Settings.',
	NoSubscription: "This Google account can't use Antigravity.",
	UnsupportedProtocol: "Unsupported Antigravity protocol. This version of agy speaks a protocol LearnHarness doesn't support yet.",
	ProtocolError: "Antigravity sent output LearnHarness could not read, so it was stopped.",
	StartTimeout: "Antigravity did not start in time.",
	AnswerTimeout: "Antigravity did not answer in time.",
	ModeChanged: "Antigravity's approval mode changed during the reply, so the reply was stopped.",
	TooLong: "Antigravity's reply was too long, so it was stopped.",
	Exited: "Antigravity stopped unexpectedly.",
	ModeNotSet: "Antigravity's approval mode could not be set, so the reply was not started.",
	ModelUnavailable: "That model isn't available for this Google account.",
	LevelNotSet: "Antigravity could not set that thinking level, so the reply was not started.",
	Refusal: "Antigravity refused the request. This usually means a usage limit was reached.",
	StoppedResponding: "Antigravity stopped responding.",
	NoStopReason: "Antigravity ended the reply without saying why.",
	Aborted: "Request was aborted",
	UnexpectedToolCall: "Antigravity made a tool call LearnHarness had not allowed, so the reply was stopped.",
} as const;

/** A tool session: the agent tried a tool LearnHarness didn't give it. */
export function toolBreachMessage(what: string): string {
	return `Antigravity tried to use a tool LearnHarness didn't give it (${what}), so the reply was stopped.`;
}

export function breachMessage(what: string): string {
	return `Antigravity tried to use one of its own tools (${what}). LearnHarness's text-only mode doesn't allow that, so the reply was stopped.`;
}

/** Prepended to the system text of a turn with LearnHarness tools (in place of TEXT_ONLY_NOTE). */
export const TOOLS_NOTE = "LearnHarness's tools are the MCP tools you have been given: their names start with mcp_ and end with _<plain tool name>. When the instructions mention a tool by its plain name, call the MCP tool whose name ends with that name. Use no other tools: do not read or write files, run commands, browse or search with built-in tools. Lines such as \"[tool call …]\" in the conversation are a record of past calls; to use a tool, make a real tool call, never write such a line.";

/** Prepended to the system text of every turn without tools. */
export const TEXT_ONLY_NOTE = "This session is text-only. No tools are available: do not call tools or run commands; answer in plain text and Markdown.";
