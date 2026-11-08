/**
 * The settings resolution layer: pure projection of the delta record
 * (core/settings.ts UserSettings) into EffectiveSettings — every field
 * CONCRETE, so consumers do no delta-walking of their own.
 *
 * Resolution rule: explicit value in the record wins; absent key resolves to
 * the compiled factory default — EXCEPT MODELS (BYOK): no factory pins exist,
 * so a model chain that ends empty resolves to null/undefined and whatever
 * needs it refuses (503 models_not_configured). This module
 * stays browser-safe/pure, so it imports config TYPES only, never the
 * runtime module (config.ts pulls node:path).
 *
 * Deliberately NOT resolved here (see settings.ts module doc):
 * - per-chat overrides: the chat record's ChatSettings applies via the
 *   conversation chain in chat-handler (chat.model → strong slot) — prober
 *   and teacher stay chat-controlled, never settings-record-controlled;
 * - tool toggles: passed through as the delta map; consumers look up by
 *   tool id with absent → enabled (the honoring lives in the agent band);
 * - prompt switches: passed through; effective composition lives in
 *   src/store/prompt-overrides.ts (segment list derived from source).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../config.ts";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";
import {
	BACKGROUND_MODEL_ROLES,
	FACTORY_SETTINGS,
	ROLE_SLOT,
	type BackgroundModelRole,
	type FactorySettings,
	type GeneralSettings,
	type DictationSettings,
	type CompactionSettings,
	type CustomModel,
	type CustomModelOverride,
	type GraphSettings,
	type ModelSlot,
	type ModelSlotName,
	type RoleModelOverride,
	type UserSettings,
} from "./settings.ts";

/** A configured model slot: the tier's concrete model, with its optional
 *  thinking level. UNSET level is legal — the engine build resolves it
 *  from core/settings.ts DEFAULT_THINKING_ORDER (first entry the model
 *  supports). A slot is CONFIGURED iff its model is
 *  present; a level-only slot is inert (kept on disk, resolved as null). */
export interface EffectiveSlot {
	cacheRetention?: ModelSlot["cacheRetention"];
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** A fully-resolved model pin for one role — same shape/level semantics
 *  as EffectiveSlot; undefined means the role's whole chain came up
 *  empty and whatever needs it refuses honestly. */
export interface EffectiveModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The concrete appearance view — same shape as the factory's. */
export type EffectiveAppearance = FactorySettings["appearance"];

/** The concrete view: every knob resolved, no absent fields. */
export interface EffectiveSettings {
	general: Required<GeneralSettings>;
	dictation: Required<DictationSettings>;
	agent: {
		models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
		/** Delta map as stored — consumers resolve absent key → enabled. */
		tools: Record<string, boolean>;
		/** Delta map as stored — absent key → override off. */
		prompts: Record<string, boolean>;
		/** The search-engine preference as stored (passthrough delta) —
		 *  engine resolution (pin → auto → unavailable)
		 *  lives in server/search.ts, where keys are visible. */
		search: { engine?: SearchEngineId };
		/** Prober graph tools: passthrough delta as stored —
		 * absent/undefined enabled = ON; consumers use graphToolsEnabled. */
		graphTools: { enabled?: boolean };
		/** Per-model tutor instructions as stored ("provider:id" → text). */
		modelInstructions: Record<string, string>;
	};
	/** The resolved strong/cheap/vision slots: each tier's concrete model or
	 *  NULL when the tier holds no model (BYOK, no factory floor). These are
	 *  the tier-level views the picker captions and refusal gates read. */
	models: Record<ModelSlotName, EffectiveSlot | null>;
	appearance: EffectiveAppearance;
	graph: Required<GraphSettings>;
	/** Compaction, resolved concrete — an absent section resolves to the
	 *  factory 150k. */
	compaction: Required<CompactionSettings>;
	/** Custom endpoint, resolved concrete: baseUrl defaults "", models and
	 *  user pins default to empty. */
	customProvider: { baseUrl: string; models: CustomModel[]; overrides: Record<string, CustomModelOverride>; manualModels: string[] };
}

/** The conversation pair's chain: the chat's own
 *  model override over the STRONG slot, each field independent (a bare
 *  chat thinking level rides the strong slot's model). null = no model
 *  anywhere — the turn gate refuses with the 503 models_not_configured
 *  envelope. */
export function resolveConversationSpec(
	chat: ChatSettings | undefined,
	strong: EffectiveSlot | null,
): EffectiveModelSpec | null {
	const model = chat?.model ?? (strong ? { provider: strong.provider, id: strong.id } : undefined);
	if (!model) return null;
	return {
		provider: model.provider,
		id: model.id,
		thinkingLevel: chat?.thinkingLevel ?? strong?.thinkingLevel,
	};
}

/** Full-chain resolution for ANY role:
 *  per-role override (background roles only) → SLOT → NOTHING. The
 *  conversation pair (prober/teacher) resolves the same chain MINUS the
 *  role override (their override is the chat's own settings — the
 *  chat-handler overlays it itself). undefined = the chain came up
 *  empty; the per-need refusal gates fire on exactly that. This is the
 *  engine wiring's one call. */
export function resolveRoleSpec(role: ModelRole, record: UserSettings | null): EffectiveModelSpec | undefined {
	const bg = BACKGROUND_MODEL_ROLES as readonly string[];
	const override = bg.includes(role) ? record?.agent?.models?.[role as BackgroundModelRole] : undefined;
	return resolveModelSpec(role, override, record?.models);
}

/** Resolve one slot to its configured view, or null when the tier holds
 *  no model (a thinkingLevel-only slot is inert — the level has no model
 *  to ride). */
export function resolveSlot(slot: ModelSlot | undefined): EffectiveSlot | null {
	if (!slot?.model) return null;
	return {
		provider: slot.model.provider, id: slot.model.id, thinkingLevel: slot.thinkingLevel,
		...(slot.cacheRetention !== undefined ? { cacheRetention: slot.cacheRetention } : {}),
	};
}

/** Resolve one role's spec — the BYOK chain: role
 *  override → SLOT → NOTHING, each field independent (an override may
 *  borrow only the slot's model, or only its thinking budget; an unset
 *  level stays unset and the engine build resolves it from
 *  DEFAULT_THINKING_ORDER). undefined = no model resolved; the
 *  per-need refusal gates fire on exactly that. */
export function resolveModelSpec(
	role: ModelRole,
	override: RoleModelOverride | undefined,
	slots?: Partial<Record<ModelSlotName, ModelSlot>>,
): EffectiveModelSpec | undefined {
	const slotName = ROLE_SLOT[role] as ModelSlotName | undefined;
	const slot = slotName ? slots?.[slotName] : undefined;
	const model = override?.model ?? slot?.model;
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		thinkingLevel: override?.thinkingLevel ?? slot?.thinkingLevel,
	};
}

/** Resolve the whole record. `record` may be null (first boot) — every
 *  factory-defaulted field lands on its default; MODEL fields resolve to
 *  null/undefined when unset (BYOK: no factory pins). */
export function resolveSettings(record: UserSettings | null): EffectiveSettings {
	const agent = record?.agent ?? {};
	const modelsSection = record?.models ?? {};
	const appearance = record?.appearance ?? {};
	const md = appearance.mdRendering ?? {};
	const graph = record?.graph ?? {};
	const factoryAppearance = FACTORY_SETTINGS.appearance;
	const factoryMd = factoryAppearance.mdRendering;
	const models = {} as Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
	for (const role of BACKGROUND_MODEL_ROLES) {
		models[role] = resolveModelSpec(role, agent.models?.[role], modelsSection);
	}
	return {
		general: {
			flashcardSources: record?.general?.flashcardSources ?? FACTORY_SETTINGS.general.flashcardSources,
			autoUpdate: record?.general?.autoUpdate ?? FACTORY_SETTINGS.general.autoUpdate,
			showReadingThinking: record?.general?.showReadingThinking ?? FACTORY_SETTINGS.general.showReadingThinking,
			keepThinkingFocus: record?.general?.keepThinkingFocus ?? FACTORY_SETTINGS.general.keepThinkingFocus,
			hiddenModes: record?.general?.hiddenModes ?? FACTORY_SETTINGS.general.hiddenModes,
			revealQuestions: record?.general?.revealQuestions ?? FACTORY_SETTINGS.general.revealQuestions,
			cramShortProbe: record?.general?.cramShortProbe ?? FACTORY_SETTINGS.general.cramShortProbe,
			sharedHandoffPrefix: record?.general?.sharedHandoffPrefix ?? FACTORY_SETTINGS.general.sharedHandoffPrefix,
			showLessonTime: record?.general?.showLessonTime ?? FACTORY_SETTINGS.general.showLessonTime,
		},
		dictation: {
			language: record?.dictation?.language ?? FACTORY_SETTINGS.dictation.language,
		},
		agent: {
			models,
			tools: agent.tools ?? {},
			prompts: agent.prompts ?? {},
			search: agent.search ?? {},
			graphTools: agent.graphTools ?? {},
			modelInstructions: agent.modelInstructions ?? {},
		},
		models: {
			strong: resolveSlot(modelsSection.strong),
			cheap: resolveSlot(modelsSection.cheap),
			vision: resolveSlot(modelsSection.vision),
		},
		appearance: {
			mode: appearance.mode ?? factoryAppearance.mode,
			background: appearance.background ?? factoryAppearance.background,
			fontFamily: appearance.fontFamily ?? factoryAppearance.fontFamily,
			proseFontSize: appearance.proseFontSize ?? factoryAppearance.proseFontSize,
			sessionNameSerif: appearance.sessionNameSerif ?? factoryAppearance.sessionNameSerif,
			mdRendering: {
				headingWeight: md.headingWeight ?? factoryMd.headingWeight,
				boldColor: md.boldColor ?? factoryMd.boldColor,
				italicColor: md.italicColor ?? factoryMd.italicColor,
			},
		},
		graph: {
			enabled: graph.enabled ?? FACTORY_SETTINGS.graph.enabled,
			// Display-only: gates the home's main view (canvas vs chains).
			rendering: graph.rendering ?? FACTORY_SETTINGS.graph.rendering,
			// The sanitizer has already clamped/floored any stored value.
			extractionChunkTokens: graph.extractionChunkTokens ?? FACTORY_SETTINGS.graph.extractionChunkTokens,
		},
		compaction: {
			thresholdTokens: record?.compaction?.thresholdTokens ?? FACTORY_SETTINGS.compaction.thresholdTokens,
		},
		customProvider: {
			baseUrl: record?.customProvider?.baseUrl ?? "",
			models: record?.customProvider?.models ?? [],
			overrides: record?.customProvider?.overrides ?? {},
			manualModels: record?.customProvider?.manualModels ?? [],
		},
	};
}

// ─── Graph channel gates ─────────────────────────────────────────────────────

/**
 * The WRITE channel gate (extraction + its auditor): dies with the master
 * switch. Used by the chat-handler's post-turn trigger.
 */
export function extractionEnabled(graph: { enabled: boolean }): boolean {
	return graph.enabled;
}

/**
 * The RENDERING gate: off = the home shows the
 * chains view, not the canvas. Display-only by construction — every data
 * path (ledgers, extraction, tools) never consults this.
 */
export function renderingEnabled(graph: { rendering: boolean }): boolean {
	return graph.rendering;
}

/**
 * The PROBER GRAPH TOOLS gate: the toggle gates tool registration, but the
 * tools only mean anything when the graph itself runs — so the effective
 * gate composes the graph master switch AND the toggle. The chat handler
 * consults it when wiring the agents' tool factories.
 */
export function graphToolsEnabled(effective: {
	graph: { enabled: boolean };
	agent: { graphTools: { enabled?: boolean } };
}): boolean {
	return effective.graph.enabled && (effective.agent.graphTools.enabled ?? true);
}


