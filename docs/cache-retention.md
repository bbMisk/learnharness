# Cache retention

Settings → Models → a slot's **Cache** menu sets how long the provider keeps that
slot's lesson cached. The menu shows what **Long** means for the slot's model.

## What each route sends

| Route | Default / Short | Long | None |
|---|---|---|---|
| Claude, API key (pi-ai `anthropic-messages`) | `cache_control` ephemeral, 5 min | `cache_control.ttl: "1h"` | no `cache_control` |
| Claude Code CLI (≥ 2.1.242) | nothing / `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` | `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` (+ subagent twin) | `DISABLE_PROMPT_CACHING=1` |
| ChatGPT, GPT-5.6 and later | nothing (account default: 30 min) | `prompt_cache_options.ttl: "12h"` | nothing extra; pi drops `prompt_cache_key` |
| ChatGPT, GPT-5.5 and earlier | nothing | `prompt_cache_retention: "24h"` | as above |

ChatGPT fields are chosen in `chatGPTCacheFields` (`src/agent/chatgpt-stream.ts`) because
pi-ai 1.4's catalog has no GPT-6 entries and would send the older field. If ChatGPT rejects
a cache field, the turn fails with a message that names this setting; ChatGPT requests are
never retried after dispatch. Claude Code mapping: `claudeCacheEnv` in
`src/agent/claude-code/stream.ts`.

## Prices (provider docs, November 2026)

- **Claude:** 5-minute writes 1.25× input, 1-hour writes 2×, reads 0.1× (0.05× on Opus 5.5 and
  Sonnet 5.5, 0.025× on Fable 5.1). Claude Code on a subscription already asks for 1 hour on the
  main conversation within included usage.
- **OpenAI GPT-5.6+:** 30-minute writes 1.25×, 12-hour writes 2.5×, reads 0.1× (0.05× on
  GPT-6.1 Sol and Terra). **GPT-5.5 and earlier:** no write surcharge, 24 hours available.

## Replay of this app's lessons (owner data, 718 calls, 2026-11-01)

Input cost relative to sending every token uncached, assuming each call writes only its new
tokens and a gap longer than the TTL (or a prefix change) re-writes the whole request:

| Setup | Default / short | Long |
|---|---|---|
| Claude Opus/Sonnet 5.5 | 0.33 (5 min) | **0.19** (1 h) |
| Claude Fable 5.1 | 0.31 | **0.16** |
| ChatGPT GPT-6.1 | **0.14** (30 min) | 0.18 (12 h) |

So Long is recommended on Claude and not on GPT-5.6+. These are API prices; how a ChatGPT
plan counts cache writes against its usage limit is not published.

## Why lessons miss the cache

Of 37 calls that mostly missed the cache, few were expiry. The largest causes were the probe
handing off to the teacher (different instructions and tools, so the request changes from its
first token), history condensing, and prompt changes from deploys. Pauses of 5 minutes or more
caused 7 misses, about 280k of 2.25M fresh tokens.
