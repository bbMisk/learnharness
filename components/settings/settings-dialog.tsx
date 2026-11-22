"use client";
/**
 * The settings dialog's always-mounted half: the open() context, the shell's
 * open-settings bridge and the connection providers. The dialog itself lives
 * in settings-dialog-body.tsx, loaded on idle so first paint stays light and
 * the first open is not slower.
 */

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type RefObject } from "react";
import { preloadable, useIdlePreload } from "@/components/preloadable";
import { useInteractionLayers, type CloseOutcome } from "@/components/interaction-layers";
import type { UserSettings } from "@/src/core";
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

// Authority belongs to the persistent Settings host, not a particular field or
// open/close lifetime: a delayed response must not roll back a newer ACK.
export interface SettingsWriteOrder {
	issued: number;
	acknowledged: number;
	record?: UserSettings;
	fileAccessError?: string | null;
	pendingWrites: number;
	promptDeletion?: Promise<void>;
	listeners: Set<(record: UserSettings, fileAccessError: string | null) => void>;
}
export const newWriteOrder = (): SettingsWriteOrder => ({ issued: 0, acknowledged: 0, pendingWrites: 0, listeners: new Set() });
export const WriteOrderContext = createContext<RefObject<SettingsWriteOrder> | null>(null);

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const interactions = useInteractionLayers();
	const layerId = useId();
	const writeOrder = useRef(newWriteOrder());
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const [navigationRequest, setNavigationRequest] = useState(0);
	const open = useCallback((section?: string, row?: string) => {
		// Returning to this singleton is a bounded request, not a forced pop.
		// Controlled layers may accept closure before React commits it.
		if (interactions.getLayer(layerId) && interactions.popTo(layerId) !== "closed") return;
		interactions.invalidateOpening();
		setNavigationRequest(request => request + 1);
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, [interactions, layerId]);
	const close = useCallback((): CloseOutcome => { setShow(false); return "closed"; }, []);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	useEffect(() => {
		const onPluginSettings = (event: Event) => {
			const pluginId: unknown = (event as CustomEvent<unknown>).detail;
			if (typeof pluginId === "string") open(`plugin:${pluginId}`);
		};
		window.addEventListener("lh:open-plugin-settings", onPluginSettings);
		return () => window.removeEventListener("lh:open-plugin-settings", onPluginSettings);
	}, [open]);
	useIdlePreload(SettingsDialog.preload);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><WriteOrderContext.Provider value={writeOrder}><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={close} initialSection={landOn} initialRow={landOnRow} navigationRequest={navigationRequest} layerId={layerId} />
			)}
		</DialogContext.Provider></WriteOrderContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}
