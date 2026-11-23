# Antigravity (Hanson's fork, phase 1)

LearnHarness can use Google Antigravity as a lesson model. It starts Google's own `agy` program on this computer (`agy acp --sandbox`) and talks to it over the Agent Client Protocol, the documented way for other apps to drive it. Your Antigravity sign-in and plan pay for the replies. LearnHarness never sees your Google credentials.

Phase 1 is text only: you write, the tutor answers in text.

## Off twice

Both switches must be on before anything runs.

1. **Server switch.** Off in the code (`src/core/fork-config.ts`). Starting the server with `LH_FORK_ANTIGRAVITY=1` turns it on for that server only. While it is off, Antigravity offers no models, lessons on it are refused, `/api/antigravity` answers 404, and Settings shows nothing.
2. **Your opt-in.** With the server switch on, Settings → Providers → External CLI shows an Antigravity toggle. It is off until you turn it on. The choice is saved in `antigravity.json` in the data folder, not in the main settings.

Antigravity also needs the `agy` program. LearnHarness finds it on your PATH or in the usual folders such as `~/.local/bin`; `LH_AGY_BINARY` can name it exactly. Finding it only checks that the file exists.

`agy` starts only when a lesson turn needs it or when you press **Check connection**. Check connection signs nothing in. It starts `agy`, opens one session, and saves the list of models your account offers. Lessons can then use those models.

## In a lesson

- Every reply is a new Antigravity session that receives the whole conversation as text. Pictures and documents are replaced by a short note saying they were left out.
- The session starts in an empty temporary folder. Antigravity's approval mode is set to "default", which asks before it runs commands, edits files, uses the web or reads outside that folder. If that mode can't be set, the reply doesn't start.
- Antigravity gets no LearnHarness tools: no quizzes, no file reading, no background jobs. If it tries to use one of its own tools, LearnHarness refuses the request, stops the reply and says so. Text it had already written stays.
- Only lessons you start use Antigravity. Background jobs, note extraction, automatic follow-ups, the side tutor, plugins and other helpers refuse it; pick another model for those. A long lesson can still be compacted (summarized) with the lesson's own model.

Some of your own Antigravity setup still applies: its allow rules, global rules and skills, and MCP servers. Google documents no way to give a third-party app a separate profile. Each reply also creates a session in your Antigravity history.

## What is sent to Google

Your lesson text, including the replayed conversation and the tutor's instructions, goes to Google through `agy` under Antigravity's terms. LearnHarness doesn't pass any Gemini or Google API key to `agy`, so a stray key can't turn this into paid API use.

## Known limits

- Text only: no pictures, PDFs, quizzes or other tools.
- No sign-in screen. Sign in by running `agy` in a terminal, then press Check connection.
- No thinking-level choice.
- An error on Google's side can arrive as ordinary reply text.
- If `agy` stops answering, the reply ends after 15 minutes without progress. An idle `agy` is stopped after 10 minutes.

## Not verified against the real agent

Every message format here comes from reading the source of T3 Code's Antigravity integration. None comes from a captured real session. The tests run only against `tests/fixtures/antigravity/mock-agy.mjs`, and two guards stop the real `agy` from starting under tests. The first step of any authorised live test is to capture a real session and compare it with the mock.

## Terms

TODO (lead): what Google's terms allow for consumer plans used through a third-party app.
