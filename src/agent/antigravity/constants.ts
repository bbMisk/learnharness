export { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-acp";

/** Every message a learner can see from this provider. None of them carries agent output. */
export const AntigravityMessage = {
	Off: "Antigravity is off. Turn it on in Settings → Providers.",
	NotInstalled: "Antigravity's agy command was not found. Install Antigravity, then check again in Settings.",
	NotSignedIn: 'Not signed in to Antigravity. Run "agy" in a terminal and sign in, then check again in Settings.',
	NoSubscription: "This Google account can't use Antigravity.",
	UnsupportedProtocol: "Unsupported Antigravity protocol. This version of agy speaks a protocol LearnHarness doesn't support yet.",
	ProtocolError: "Antigravity sent output LearnHarness could not read, so it was stopped.",
	StartTimeout: "Antigravity did not start in time.",
	Exited: "Antigravity stopped unexpectedly.",
	ModeNotSet: "Antigravity's approval mode could not be set, so the reply was not started.",
	ModelUnavailable: "That model isn't available for this Google account.",
	Refusal: "Antigravity refused the request. This usually means a usage limit was reached.",
	StoppedResponding: "Antigravity stopped responding.",
	NoStopReason: "Antigravity ended the reply without saying why.",
	Aborted: "Request was aborted",
} as const;

export function breachMessage(what: string): string {
	return `Antigravity tried to use one of its own tools (${what}). LearnHarness's text-only mode doesn't allow that, so the reply was stopped.`;
}

/** Prepended to the system text of every turn. */
export const TEXT_ONLY_NOTE = "This session is text-only. No tools are available: do not call tools or run commands; answer in plain text and Markdown.";
