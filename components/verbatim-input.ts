/** Learner reasoning, especially unfinished math, must stay as typed.
 * writingsuggestions is lowercase so React forwards the standard Safari
 * inline-prediction control even with older React DOM attribute typings. */
export const verbatimInputProps = {
	autoComplete: "off",
	autoCorrect: "off",
	autoCapitalize: "off",
	spellCheck: false,
	writingsuggestions: "false",
} as const;
