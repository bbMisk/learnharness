import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** The window title of pages without their own (home, a new chat, not-found). */
export const APP_TITLE = "LearnHarness";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
