import { BrailleSpinner } from "@/components/braille-spinner";
import { TopBar } from "@/components/top-bar";

/** Shown as soon as a chat is opened, until its transcript arrives (a large
 *  chat can take seconds on a slow link). Fades in late, so fast opens
 *  don't flash it. */
export default function ChatLoading() {
	return (
		<div className="flex lh-h-screen min-w-0 flex-1 flex-col" data-testid="chat-loading">
			<TopBar />
			<div
				role="status"
				className="graph-chrome-fade-in flex flex-1 items-center justify-center gap-2 font-ui text-xs uppercase tracking-wide text-muted-foreground"
				style={{ animationDelay: "300ms", animationFillMode: "both" }}
			>
				<BrailleSpinner label="Opening" />
				Opening…
			</div>
		</div>
	);
}
