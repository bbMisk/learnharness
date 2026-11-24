# Antigravity (Hanson's fork, phase 1)

LearnHarness can use Google Antigravity as a lesson model. It starts Google's own `agy` program on this computer (`agy acp --sandbox`) and talks to it over the Agent Client Protocol, the documented way for other apps to drive it. Your Antigravity sign-in and plan pay for the replies. LearnHarness never sees your Google credentials.

In a lesson the tutor can use LearnHarness's own tools (quizzes and other questions, PDFs, plans, visuals: whatever the lesson offers), and it sees your pictures. Antigravity's own tools stay forbidden.

## Two switches

Both switches must be on before anything runs.

1. **Server switch.** On in the code (`src/core/fork-config.ts`). Starting a server with `LH_FORK_ANTIGRAVITY=0` turns it off for that server. While it is off, Antigravity offers no models, lessons on it are refused, `GET /api/antigravity` answers only `{ available: false }` (changes are refused with 404), and Settings shows nothing.
2. **Your opt-in.** Settings → Providers → External CLI shows an Antigravity toggle. It is still off until you turn it on. The choice is saved in `antigravity.json` in the data folder, not in the main settings. Turning it off stops `agy` at once, or, if a reply is streaming, as soon as that reply ends.

Antigravity also needs the `agy` program. LearnHarness finds it on your PATH or in the usual folders such as `~/.local/bin`; `LH_AGY_BINARY` can name it exactly. Finding it only checks that the file exists. If Settings says "Not installed", install `agy` and press **Check connection** again; it looks for the program afresh.

`agy` starts only when a model call on an Antigravity model needs it (a lesson turn, or a helper you pinned to one), when you press **Check connection**, or when you press **Sign in**. Check connection signs nothing in. It starts `agy`, opens one session (which also appears in your Antigravity history), and saves the list of models your account offers, with the thinking levels each model offers (Antigravity reports a model's levels only while that model is selected, so the check selects each one in turn on that throwaway session). Lessons can then use those models. Press Check connection again after Google changes the models or their levels.

## Thinking levels

Thinking levels are supported per model: the model picker offers exactly the levels Antigravity listed for that model at the last Check connection (for example low, medium, high and extra-high on one model, low to high on another), with no "off"; the lowest offered level is the floor. A model that offered none has no level choice. With no level chosen for a lesson, LearnHarness's usual default order applies (medium where offered), not Antigravity's own default (high). Before each reply LearnHarness selects the chosen level and confirms it, together with the approval mode and the model, before the prompt is sent; a level the model no longer offers is skipped and Antigravity's default is used. If Antigravity refuses the level, the reply doesn't start.

## In a lesson

- A lesson continues one Antigravity session while its conversation only grows (see below); otherwise a reply starts a new session that receives the whole conversation as text, with your pictures in place (see Pictures).
- The session starts in an empty temporary folder. Antigravity's approval mode is set to "default", which asks before it runs commands, edits files, uses the web or reads outside that folder, and before each LearnHarness tool call. LearnHarness checks the mode again after choosing the model, and if the mode can't be confirmed, the reply doesn't start. If the mode changes while the reply is streaming, the reply is stopped.
- If Antigravity tries to use one of its own tools (commands, files, the web), or any tool the lesson did not offer, LearnHarness refuses it, stops the reply and says so. Text it had already written stays. A tool that your own Antigravity allow rules already permit may have run before LearnHarness hears about it.
- Helpers can use Antigravity too (see Helpers below). A long lesson can be compacted (summarized) with the lesson's own model.

## LearnHarness tools

The tutor gets exactly the tools the lesson offers at that moment, and LearnHarness runs each one itself, as for any other model. They reach Antigravity through a small server inside LearnHarness that listens only on this computer (`127.0.0.1`): one per running `agy`, with a separate address and a random key for every agent session, so only that session can call it. Each agent session's tool server gets its own name (`lh` and 10 random hex characters, never reused while that `agy` runs): Antigravity adds a suffix of its own to the tool names when one `agy` sees the same server name at two addresses, which would make every session after the first look foreign. Antigravity sees each tool as `mcp_<that name>_<tool>` and asks before every call; LearnHarness allows a call only when its name is exactly that, for one of that session's tools, while a reply is streaming, and always "allow once", never "always".

Antigravity makes one tool call at a time. While LearnHarness runs a tool, the agent waits on that call:

- Quick tools (reading, plans, notes, map tools and the like) answer within seconds and the reply goes on in the same agent turn.
- A question (quiz, recall, explain, ask, probe, plugin questions and problems) waits for your answer. Antigravity gives up on a tool call after 3 minutes, so LearnHarness keeps the agent's turn open for 2.5 minutes. Answer within that time and the tutor carries on in the same turn. Answer later and nothing is lost: the waiting turn has been closed, and your answer starts a fresh agent session that gets the whole lesson, including the question and your answer, as text. That costs one full resend of the lesson.
- Jobs (research, PDFs, demos, visuals) start at once and run on their own slot's model. When a job finishes, its result comes back into the lesson as an automatic follow-up, and so does the hand-over from the opening questions to teaching. An Antigravity lesson now accepts automatic follow-ups: any that the wake pipeline delivers to that chat, not only ones its own tools caused (a job queued while the chat ran on another model counts too). A follow-up that arrives while a tool call is waiting closes that waiting turn, and the lesson goes on in a fresh session.

Anything else that happens while a call waits (the agent writing text, trying another tool, a mode or model change, any update LearnHarness doesn't know, the agent cancelling or dropping the call, `agy` stopping, Stop, turning Antigravity off, a different request for the lesson) closes the waiting turn the same way. An answer is never lost: if the agent's side of the call is gone by the time the result is ready, the result goes into a fresh session's replay instead. A tool call that arrives after Antigravity was turned off mid-reply is shown, but nothing waits for it.

## Pictures

Antigravity's models take pictures. Pictures you attach (and pictures in tool results) go to the agent as images, in their place in the conversation, up to 20 MB of pictures per prompt and per tool result; beyond that, or if an `agy` build doesn't accept images, a short note says a picture was left out (the rest of the tool result still goes). A continued session counts a picture by its bytes: a changed picture means a fresh session.

## Usage

Antigravity reports token usage once per agent turn, summed over the model calls inside it, and separately how many tokens are in its context. LearnHarness's context meter and compaction read the last message's usage as the context size. So after tool calls the usage is split: each message that ends in a tool call carries only the context size the agent reported before it, and the reply's final message adds up to the latest context size: the turn's output and cache-read counts (summed over its model calls by Antigravity) are capped so they fit inside it, and the rest is input. If the agent never reported a context size, the final message carries the turn's own counts. The context figure is therefore the agent's context size, never a sum over its model calls; the per-message input and output figures for such a turn are an attribution, not what was billed.

Some of your own Antigravity setup still applies: its allow rules, global rules and skills, and MCP servers. Google documents no way to give a third-party app a separate profile. Each lesson also creates a session in your Antigravity history (more than one if the lesson had to start afresh; see below).

## Helpers on Antigravity models

A model slot or role pinned to an Antigravity model works wherever another provider's model would, while Antigravity is available (switched on, opted in, `agy` found), exactly as Claude Code follows its own availability:

| Helper | How it runs on Antigravity |
|---|---|
| Research job | Its web search and fetch tools through the tool server. |
| PDF reader job | Its PDF tools; rendered pages it looks at go to the agent with the tool's result, so one read is one agent turn. |
| Demo builder, visual maker | Their tools (writing, running and rendering need the local Chrome, as for any model). A rendered figure goes back with the tool's result. |
| Extraction (extractor and auditor) | Their submit tools. |
| Plugin inference and plugin workers | As requested; a plugin's temperature and maximum length are ignored (pi's rule for APIs that can't apply them), and "no tools" runs without the tool server. A plugin worker's tool rounds after the first each start a fresh agent session with the whole run replayed (plugin inference ends each request itself, so a waiting tool call can't be kept); a one-shot plugin request that ends in a tool call leaves its agent turn open for 60 seconds. |
| Side tutor | Text, no tools. |

Every helper call gets its own agent session, with the same checks as a lesson (approval mode "default", model, thinking level before every prompt; only the tools LearnHarness declared, through the tool server; anything else stops the reply). Helper sessions are never kept for reuse, so they can't push a lesson's session out. A tool call in a helper run waits 60 seconds for its result (a lesson's question waits 2.5 minutes); cancelling a job cancels its agent turn like Stop. Helpers that need tools refuse Antigravity rather than run half-working when the tools switch is off, and a helper that hands over pictures refuses it when the pictures can't be seen. The usage of helper calls is recorded like any other model's; Antigravity has no price, so no cost is shown.

## Switches

| Switch | Default | Off means |
|---|---|---|
| `LH_FORK_ANTIGRAVITY` | on | No Antigravity at all (no models, no settings row, every call refused). |
| `LH_ANTIGRAVITY_TOOLS` | on | Lessons are text only: no tool server, no pictures, no automatic follow-ups. Helpers that need tools or pictures refuse Antigravity. |
| `LH_ANTIGRAVITY_REUSE` | on | Every reply gets a fresh agent session. |
| `LH_ANTIGRAVITY_HELPERS` | on | Only lessons use Antigravity: jobs, extraction, plugins and the side tutor refuse it, as before. |

Each is a server environment variable set to `0` to turn it off; they are independent of each other. Your own opt-in in Settings is separate and starts off.

## Sign in

When the last check says you are not signed in, the Antigravity row offers **Sign in** first (otherwise it is a small extra button). Pressing it, and only that, sends Antigravity's own sign-in request for a personal Google account: `agy` then opens a browser window for you to sign in, and when it is done LearnHarness checks the connection again. While it waits, the row says so; pressing again starts nothing. LearnHarness never opens, forwards, stores or logs a sign-in link or token, and it ignores the account details the answer carries. If `agy` can't open a browser, the row asks you to run `agy` in a terminal; a sign-in not finished within 5 minutes is cancelled. A sign-in that times out, or that makes `agy` print a sign-in link, stops `agy`, and with it any reply or job that was using it. There is no sign-out button: signing out would also sign out your own `agy`. A lesson, a check or a helper never asks to sign in.

## One agent session per lesson

While a lesson's conversation only grows, the next reply continues the same Antigravity session and sends only your new message: LearnHarness checks that the agent has already seen exactly everything before it, the same instructions and the same model. Any edit (including to a reply's thinking), a retry that changes the history, compaction, a model or instruction change, going back to the default thinking level after choosing another one, anything the agent says outside a reply, or a reply that didn't finish cleanly starts a fresh session with the whole conversation instead. LearnHarness's own transcript stays the record; the agent session is only a cache of it.

On the real agent, a follow-up reply on a continued session reported about 2,100 new input tokens and 10,900 read from Google's cache, instead of about 13,000 new ones on a fresh session (a fresh session never hits the cache, so a long lesson otherwise resends the whole conversation and about 9,700 tokens of the agent's own instructions every time). Replies were not faster at that size; this saves quota on long lessons.

Every reply still passes the same checks before its prompt: approval mode "default", the chosen model and thinking level, confirmed from the agent's latest answer. A session also keeps the tools it started with: a lesson that offers a different set of tools gets a fresh session. A session that waits between replies is closed if the agent tries to use a tool on it, and at most 8 waiting sessions are kept (the oldest is closed first). They don't keep `agy` running: the 30-minute idle stop and turning Antigravity off still apply. A server started with `LH_ANTIGRAVITY_REUSE=0` turns this off: every reply gets a fresh session, as before (a tool call still resumes the turn it belongs to).

A server started with `LH_ANTIGRAVITY_TOOLS=0` turns tools off: no tool server, no pictures (a short note in their place), no automatic follow-ups, and the tutor is told the session is text only, exactly as before tools were supported.

## What is sent to Google

Your lesson text, including the replayed conversation and the tutor's instructions, goes to Google through `agy` under Antigravity's terms. LearnHarness doesn't pass any Gemini or Google API key to `agy`, so a stray key can't turn this into paid API use.

## Known limits

- A question answered after 2.5 minutes, or a job result that lands while a tool call waits, costs a full resend of the lesson (see LearnHarness tools).
- Antigravity puts its own "Created At" and "Completed At" lines in front of what the model sees of a tool result.
- Signing in needs a browser on this computer (the one `agy` opens); otherwise sign in by running `agy` in a terminal, then press Check connection.
- Only the current session-options format is understood: an `agy` that offers no "mode" and "model" options in that format (older builds used other fields) can't run lessons, and Check connection lists no models for it.
- An error on Google's side can arrive as ordinary reply text. Errors Antigravity reports any other way show only their error code; the details stay in the server log.
- Reopening a lesson that is waiting for a reply resumes it, and so starts `agy`, without a click. A lesson whose last reply already finished is not resumed.
- A message you type while a reply is streaming starts another reply.
- The model's own reply text is shown as written, links included.
- One reply is capped at 4 MB of text; a longer one is stopped.
- If `agy` stops answering, the reply ends after 15 minutes without progress. An idle `agy` is stopped after 30 minutes (so a learner who thinks for a while doesn't wait for it to start again); turning Antigravity off stops it sooner.
- When the server is stopped by a signal, `agy` exits when its input closes (checked with the real `agy`); a temporary folder left behind in that case is removed on the next start.

## Checked against the real agent

Measured with `agy` 1.5.15 and synthetic prompts:

- `initialize` answers protocol version 1 in the expected format.
- A session opens with the sign-in made in a terminal; LearnHarness sends no sign-in request.
- The approval mode starts as "default".
- The system instructions sent through the documented hook are followed.
- `session/close` is accepted.
- The agent starts in about 0.3 s and exits about 0.1 s after its input closes.
- Each turn carries about 10,000 input tokens of the agent's own instructions.
- Short replies on gemini-3.8-flash took 8 to 11 seconds at the agent's default thinking level (high).
- A two-turn lesson on a throwaway packaged server gave correct replies with no tool-use stop and left no process or temporary folder behind.

Also measured with `agy` 1.5.15 (the lead's probes; the shapes are in the mock): a session opened with LearnHarness's tool server lists its tools while it opens; each call is announced, asked about, then made; a picture in a tool result is seen by the model; the agent gives up on a tool call after exactly 3 minutes; two calls asked for in one step run one after the other; cancelling while a call waits ends the turn within milliseconds and leaves the session usable.

Still not known: how often a real lesson trips the tool stop, how errors from Google's side appear, and how real quizzes and PDFs behave in a full lesson (the lead checks those on the real agent before this ships).

The tests still run only against `tests/fixtures/antigravity/mock-agy.mjs`, whose default answers now follow a sanitized capture of that session (`tests/fixtures/antigravity/real-agy-1.5.15.json`); two guards stop the real `agy` from starting under tests.

## Terms

Not settled by Google's public pages. Whether to turn this on with a personal Google plan is the account holder's decision and risk. This is a reading of those pages as of 2026-11-23, not legal advice.

What supports this use:

- The ACP page (antigravity.google/docs/ide/extensions/acp, "Other clients"): "Any ACP client can launch Antigravity CLI." It lists a personal Google sign-in as a method, and says `agy acp` "uses the credentials you cached with an interactive `agy` session."
- LearnHarness runs Google's own unmodified program and never handles the sign-in or its tokens (its Sign in button only asks `agy` to run its own sign-in).

What cuts against it:

- Antigravity's terms (antigravity.google/terms): "You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."
- Antigravity's FAQ (antigravity.google/docs/faq): "Wrapping agy inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans." That answer is about headless mode (`agy -p`), but its wording is general. The same page says: "To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key."

What nobody says:

- The terms, the plans page and the FAQ never mention ACP, so nothing states whether an app that launches Google's own `agy acp` counts as "third party software" accessing the Service.
- The terms carry no date. The plans page says every plan includes "the CLI" and says nothing about other clients.
- T3 Code ships the same kind of integration; that shows it works, not that Google allows it for a tutoring app.

Also in the terms: Google records interactions and uses them to improve its products and models, and asks users not to submit confidential information. Lesson text sent through this provider falls under that.

The route Google itself points third-party tools to is an API key. Phase 1 deliberately does not support one (it removes any Gemini or Google key from the agent's environment), and a key is billed separately.
