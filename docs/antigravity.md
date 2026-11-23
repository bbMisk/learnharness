# Antigravity (Hanson's fork, phase 1)

LearnHarness can use Google Antigravity as a lesson model. It starts Google's own `agy` program on this computer (`agy acp --sandbox`) and talks to it over the Agent Client Protocol, the documented way for other apps to drive it. Your Antigravity sign-in and plan pay for the replies. LearnHarness never sees your Google credentials.

Phase 1 is text only: you write, the tutor answers in text.

## Off twice

Both switches must be on before anything runs.

1. **Server switch.** Off in the code (`src/core/fork-config.ts`). Starting the server with `LH_FORK_ANTIGRAVITY=1` turns it on for that server only. While it is off, Antigravity offers no models, lessons on it are refused, `GET /api/antigravity` answers only `{ available: false }` (changes are refused with 404), and Settings shows nothing.
2. **Your opt-in.** With the server switch on, Settings → Providers → External CLI shows an Antigravity toggle. It is off until you turn it on. The choice is saved in `antigravity.json` in the data folder, not in the main settings.

Antigravity also needs the `agy` program. LearnHarness finds it on your PATH or in the usual folders such as `~/.local/bin`; `LH_AGY_BINARY` can name it exactly. Finding it only checks that the file exists.

`agy` starts only when a lesson turn needs it or when you press **Check connection**. Check connection signs nothing in. It starts `agy`, opens one session (which also appears in your Antigravity history), and saves the list of models your account offers. Lessons can then use those models.

## In a lesson

- Every reply is a new Antigravity session that receives the whole conversation as text. Pictures and documents are replaced by a short note saying they were left out.
- The session starts in an empty temporary folder. Antigravity's approval mode is set to "default", which asks before it runs commands, edits files, uses the web or reads outside that folder. LearnHarness checks the mode again after choosing the model, and if the mode can't be confirmed, the reply doesn't start. If the mode changes while the reply is streaming, the reply is stopped.
- Antigravity gets no LearnHarness tools: no quizzes, no file reading, no background jobs. If it tries to use one of its own tools, LearnHarness refuses the request, stops the reply and says so. Text it had already written stays. A tool that your own Antigravity allow rules already permit may have run before LearnHarness hears about it.
- The tutor's instructions still describe LearnHarness's quizzes and other tools, which Antigravity can't call here, so lesson steps that need them don't happen.
- Only lessons you start use Antigravity. Background jobs, note extraction, automatic follow-ups, the side tutor, plugins and other helpers refuse it; pick another model for those. A long lesson can still be compacted (summarized) with the lesson's own model.

Some of your own Antigravity setup still applies: its allow rules, global rules and skills, and MCP servers. Google documents no way to give a third-party app a separate profile. Each reply also creates a session in your Antigravity history.

## What is sent to Google

Your lesson text, including the replayed conversation and the tutor's instructions, goes to Google through `agy` under Antigravity's terms. LearnHarness doesn't pass any Gemini or Google API key to `agy`, so a stray key can't turn this into paid API use.

## Known limits

- Text only: no pictures, PDFs, quizzes or other tools.
- No sign-in screen. Sign in by running `agy` in a terminal, then press Check connection.
- No thinking-level choice.
- Only the current session-options format is understood: an `agy` that offers no "mode" and "model" options in that format (older builds used other fields) can't run lessons, and Check connection lists no models for it.
- An error on Google's side can arrive as ordinary reply text. Errors Antigravity reports any other way show only their error code; the details stay in the server log.
- Reopening a lesson that is waiting for a reply resumes it, and so starts `agy`, without a click. A lesson whose last reply already finished is not resumed.
- A message you type while a reply is streaming starts another reply.
- The model's own reply text is shown as written, links included.
- One reply is capped at 4 MB of text; a longer one is stopped.
- If `agy` stops answering, the reply ends after 15 minutes without progress. An idle `agy` is stopped after 10 minutes.
- When the server is stopped by a signal, `agy` is expected to exit when its input closes; any temporary folder left behind is removed on the next start. This hasn't been checked with the real `agy`.

## Not verified against the real agent

Every message format here comes from reading the source of T3 Code's Antigravity integration. None comes from a captured real session. The tests run only against `tests/fixtures/antigravity/mock-agy.mjs`, and two guards stop the real `agy` from starting under tests. The first step of any authorised live test is to capture a real session and compare it with the mock.

## Terms

Not settled. No live use of this provider on a personal Google plan until Hanson decides. This is a reading of Google's public pages on 2026-11-23, not legal advice.

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
