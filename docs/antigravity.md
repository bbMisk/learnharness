# Antigravity (Hanson's fork, phase 1)

LearnHarness can use Google Antigravity as a lesson model. It starts Google's own `agy` program on this computer (`agy acp --sandbox`) and talks to it over the Agent Client Protocol, the documented way for other apps to drive it. Your Antigravity sign-in and plan pay for the replies. LearnHarness never sees your Google credentials.

Phase 1 is text only: you write, the tutor answers in text.

## Two switches

Both switches must be on before anything runs.

1. **Server switch.** On in the code (`src/core/fork-config.ts`). Starting a server with `LH_FORK_ANTIGRAVITY=0` turns it off for that server. While it is off, Antigravity offers no models, lessons on it are refused, `GET /api/antigravity` answers only `{ available: false }` (changes are refused with 404), and Settings shows nothing.
2. **Your opt-in.** Settings → Providers → External CLI shows an Antigravity toggle. It is still off until you turn it on. The choice is saved in `antigravity.json` in the data folder, not in the main settings. Turning it off stops `agy` at once, or, if a reply is streaming, as soon as that reply ends.

Antigravity also needs the `agy` program. LearnHarness finds it on your PATH or in the usual folders such as `~/.local/bin`; `LH_AGY_BINARY` can name it exactly. Finding it only checks that the file exists. If Settings says "Not installed", install `agy` and press **Check connection** again; it looks for the program afresh.

`agy` starts only when a lesson turn needs it or when you press **Check connection**. Check connection signs nothing in. It starts `agy`, opens one session (which also appears in your Antigravity history), and saves the list of models your account offers, with the thinking levels each model offers (Antigravity reports a model's levels only while that model is selected, so the check selects each one in turn on that throwaway session). Lessons can then use those models. Press Check connection again after Google changes the models or their levels.

## Thinking levels

Thinking levels are supported per model: the model picker offers exactly the levels Antigravity listed for that model at the last Check connection (for example low, medium, high and extra-high on one model, low to high on another), with no "off"; the lowest offered level is the floor. A model that offered none has no level choice. With no level chosen for a lesson, LearnHarness's usual default order applies (medium where offered), not Antigravity's own default (high). Before each reply LearnHarness selects the chosen level and confirms it, together with the approval mode and the model, before the prompt is sent; a level the model no longer offers is skipped and Antigravity's default is used. If Antigravity refuses the level, the reply doesn't start.

## In a lesson

- A lesson continues one Antigravity session while its conversation only grows (see below); otherwise a reply starts a new session that receives the whole conversation as text. Pictures and documents are replaced by a short note saying they were left out.
- The session starts in an empty temporary folder. Antigravity's approval mode is set to "default", which asks before it runs commands, edits files, uses the web or reads outside that folder. LearnHarness checks the mode again after choosing the model, and if the mode can't be confirmed, the reply doesn't start. If the mode changes while the reply is streaming, the reply is stopped.
- Antigravity gets no LearnHarness tools: no quizzes, no file reading, no background jobs. If it tries to use one of its own tools, LearnHarness refuses the request, stops the reply and says so. Text it had already written stays. A tool that your own Antigravity allow rules already permit may have run before LearnHarness hears about it.
- The tutor's instructions still describe LearnHarness's quizzes and other tools, which Antigravity can't call here, so lesson steps that need them don't happen.
- Only lessons you start use Antigravity. Background jobs, note extraction, automatic follow-ups, the side tutor, plugins and other helpers refuse it; pick another model for those. A long lesson can still be compacted (summarized) with the lesson's own model.

Some of your own Antigravity setup still applies: its allow rules, global rules and skills, and MCP servers. Google documents no way to give a third-party app a separate profile. Each lesson also creates a session in your Antigravity history (more than one if the lesson had to start afresh; see below).

## One agent session per lesson

While a lesson's conversation only grows, the next reply continues the same Antigravity session and sends only your new message: LearnHarness checks that the agent has already seen exactly everything before it, the same instructions and the same model. Any edit (including to a reply's thinking), a retry that changes the history, compaction, a model or instruction change, going back to the default thinking level after choosing another one, anything the agent says outside a reply, or a reply that didn't finish cleanly starts a fresh session with the whole conversation instead. LearnHarness's own transcript stays the record; the agent session is only a cache of it.

On the real agent, a follow-up reply on a continued session reported about 2,100 new input tokens and 10,900 read from Google's cache, instead of about 13,000 new ones on a fresh session (a fresh session never hits the cache, so a long lesson otherwise resends the whole conversation and about 9,700 tokens of the agent's own instructions every time). Replies were not faster at that size; this saves quota on long lessons.

Every reply still passes the same checks before its prompt: approval mode "default", the chosen model and thinking level, confirmed from the agent's latest answer. A session that waits between replies is closed if the agent tries to use a tool on it, and at most 8 waiting sessions are kept (the oldest is closed first). They don't keep `agy` running: the 30-minute idle stop and turning Antigravity off still apply. A server started with `LH_ANTIGRAVITY_REUSE=0` turns this off: every reply gets a fresh session, as before.

## What is sent to Google

Your lesson text, including the replayed conversation and the tutor's instructions, goes to Google through `agy` under Antigravity's terms. LearnHarness doesn't pass any Gemini or Google API key to `agy`, so a stray key can't turn this into paid API use.

## Known limits

- Text only: no pictures, PDFs, quizzes or other tools.
- No sign-in screen. Sign in by running `agy` in a terminal, then press Check connection.
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

Still not known: how often a real lesson trips the tool stop, and how errors from Google's side appear.

The tests still run only against `tests/fixtures/antigravity/mock-agy.mjs`, whose default answers now follow a sanitized capture of that session (`tests/fixtures/antigravity/real-agy-1.5.15.json`); two guards stop the real `agy` from starting under tests.

## Terms

Not settled by Google's public pages. Whether to turn this on with a personal Google plan is the account holder's decision and risk. This is a reading of those pages as of 2026-11-23, not legal advice.

What supports this use:

- The ACP page (antigravity.google/docs/ide/extensions/acp, "Other clients"): "Any ACP client can launch Antigravity CLI." It lists a personal Google sign-in as a method, and says `agy acp` "uses the credentials you cached with an interactive `agy` session."
- LearnHarness runs Google's own unmodified program and never handles the sign-in or its tokens.

What cuts against it:

- Antigravity's terms (antigravity.google/terms): "You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."
- Antigravity's FAQ (antigravity.google/docs/faq): "Wrapping agy inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans." That answer is about headless mode (`agy -p`), but its wording is general. The same page says: "To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key."

What nobody says:

- The terms, the plans page and the FAQ never mention ACP, so nothing states whether an app that launches Google's own `agy acp` counts as "third party software" accessing the Service.
- The terms carry no date. The plans page says every plan includes "the CLI" and says nothing about other clients.
- T3 Code ships the same kind of integration; that shows it works, not that Google allows it for a tutoring app.

Also in the terms: Google records interactions and uses them to improve its products and models, and asks users not to submit confidential information. Lesson text sent through this provider falls under that.

The route Google itself points third-party tools to is an API key. Phase 1 deliberately does not support one (it removes any Gemini or Google key from the agent's environment), and a key is billed separately.
