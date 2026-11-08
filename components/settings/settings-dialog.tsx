"use client";
/**
 * The settings dialog's always-mounted half: the open() context, the shell's
 * open-settings bridge and the connection providers. The dialog itself lives
 * in settings-dialog-body.tsx, loaded on idle so first paint stays light and
 * the first open is not slower.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { preloadable, useIdlePreload } from "@/components/preloadable";
import type { SectionId } from "./settings-dialog-body.tsx";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";

export const SettingsDialog = preloadable(() => import("./settings-dialog-body.tsx").then((m) => m.SettingsDialog));

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const open = useCallback((section?: string, row?: string) => {
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, []);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	useIdlePreload(SettingsDialog.preload);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={() => setShow(false)} initialSection={landOn} initialRow={landOnRow} />
			)}
		</DialogContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}
