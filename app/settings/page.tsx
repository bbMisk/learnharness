"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

/**
 * Settings is a dialog over the app, not a page: /settings opens the
 * dialog and swaps the URL for the draft view behind it.
 */
export default function SettingsPage() {
	const { open } = useSettingsDialog();
	const router = useRouter();
	useEffect(() => {
		open();
		router.replace("/chat/new");
	}, [open, router]);
	return null;
}
