/** Child process for tests/side-chat-switch-render.test.tsx: renders a chat
 *  with one teaching answer and prints what the switch exposes as JSON. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";

process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-switch-"));
const { renderToString } = await import("react-dom/server");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
const { Chat } = await import("../../components/chat.tsx");
const { ActivityProvider } = await import("../../components/activity-dock.tsx");
const { InteractionLayersProvider } = await import("../../components/interaction-layers.tsx");
const { PluginsProvider } = await import("../../components/plugins.tsx");
const { ServerEventsProvider } = await import("../../components/server-events.tsx");
const { AppearanceProvider } = await import("../../components/settings/appearance.tsx");
const { SettingsDialogProvider } = await import("../../components/settings/settings-dialog.tsx");
const { SidebarProvider } = await import("../../components/sidebar.tsx");
const { DEFAULT_THEME } = await import("../../src/core/themes.ts");
const { forkSideChat, KEYBOARD_ACTIONS, newUserMessage } = await import("../../src/core/index.ts");
const { composeInstructions } = await import("../../src/agent/teacher-agent.ts");
const { listSourceSegments } = await import("../../src/agent/prompt-segments.ts");

const answer = { ...fauxAssistantMessage([fauxText("A derivative measures change.\n\nIt is the slope of the tangent.")]), id: "teach-1" };
const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
const html = renderToString(
	<AppRouterContext.Provider value={router}>
	<PathnameContext.Provider value="/chat/chat_side_switch">
	<ServerEventsProvider>
		<PluginsProvider>
			<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
				<SidebarProvider>
					<ActivityProvider>
						<InteractionLayersProvider>
							<SettingsDialogProvider>
								<Chat chatId="chat_side_switch" title="Side switch" kind="teach" initialMessages={[newUserMessage("Teach me derivatives"), answer]} initialConfigured />
							</SettingsDialogProvider>
						</InteractionLayersProvider>
					</ActivityProvider>
				</SidebarProvider>
			</AppearanceProvider>
		</PluginsProvider>
	</ServerEventsProvider>
	</PathnameContext.Provider>
	</AppRouterContext.Provider>,
);
console.log(JSON.stringify({
	mode: forkSideChat,
	html,
	actions: KEYBOARD_ACTIONS.map((a) => a.id),
	teacherPrompt: composeInstructions("teacher"),
	segments: listSourceSegments("teacher").map((s) => s.path),
}));
