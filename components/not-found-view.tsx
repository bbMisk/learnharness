import Link from "next/link";
import { TopBar } from "@/components/top-bar";

/** The in-app "not found" page: a bad link, or a chat or project that was deleted. */
export function NotFoundView() {
	return (
		<div data-testid="not-found" className="flex lh-h-screen flex-col">
			<TopBar />
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
				<p className="font-prose text-(length:--lh-prose-size) text-muted-foreground">
					Nothing here. The link may be wrong, or the chat or project was deleted.
				</p>
				<Link href="/" className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent">
					Go home
				</Link>
			</div>
		</div>
	);
}
