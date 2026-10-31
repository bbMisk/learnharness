<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>LearnHarness — Hanson’s fork</strong><br>Adaptive lessons, practice, and a persistent knowledge graph.</p>

<p align="center">
  <a href="https://github.com/bbMisk/learnharness/releases/download/v0.4.0-preview.2/LearnHarness-0.4.0-preview.2-arm64.dmg">Download for Mac</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/bbMisk/learnharness/issues">Issues</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

Maintained by [Hanson Sun](https://github.com/bbMisk), based on [Amos Blomqvist’s LearnHarness](https://github.com/amosblomqvist/learnharness). This fork retains the upstream learning system and adds:

- **Continue across Macs:** optional shared-host connection in the Electron app’s settings.
- **Temporary side tutor:** clarify a concept without advancing the main lesson; resizable panes and keyboard controls.
- **Projects and pinned chats:** shared files and custom project instructions.
- **Easier attachments:** paste screenshots or drop files anywhere, with removable previews above the input.
- **Learning review:** exportable learning history and offline flashcards from the knowledge graph.
- **Presentation and reliability:** dark figures/demos, bounded SVG sizing, inspectable background jobs, and send/recovery fixes.

Current upstream ChatGPT sign-in is reused, with account-advertised discovery of new compatible models and an optional Fast preference that distinguishes requested from actual delivery.

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download for Apple Silicon Mac](https://github.com/bbMisk/learnharness/releases/download/v0.4.0-preview.2/LearnHarness-0.4.0-preview.2-arm64.dmg)** · [Release notes and source](https://github.com/bbMisk/learnharness/releases/tag/v0.4.0-preview.2)

1. Open the DMG and drag **LearnHarness** to **Applications**. Requires macOS 13+ and an M-series Mac.
2. Open the app, choose **Connect your AI account**, and use your own ChatGPT account or provider API key.
3. Choose the lesson models and start learning. No terminal, Node installation, or shared host is needed.

This is a **preview**, ad-hoc signed and not Apple notarized. If macOS blocks it, use **System Settings → Privacy & Security → Open Anyway** after verifying the download source. Automatic app updates are not active in this preview; install newer releases from this repository. Your learning data remains in the app’s local data folder. Other platforms are not packaged by this fork yet.

Besides your ChatGPT account or API keys, you can use an installed [Claude Code CLI](docs/claude-code.md) or a [custom OpenAI-compatible endpoint](docs/custom-providers.md), including a local model server. Each model slot can also set a [prompt-cache retention preference](docs/compaction-accounting.md#prompt-cache-retention) under **Settings → Agent → Models → Show advanced settings**.

Optional shared-host mode connects your own Macs to one running LearnHarness host; otherwise every installation uses its own local chats, graph, files and account. It does not include access to Hanson’s host or accounts.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. Billing depends on your provider, CLI configuration, subscription, or local setup. The live cost meter estimates known API costs, not subscription, CLI, or custom-endpoint charges.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

See [ChatGPT account setup](docs/chatgpt-plan.md) for account handling and limits, and [offline flashcards](docs/offline-flashcards.md) for review setup.

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

See the [development guide](docs/development.md) for setup and checks, [architecture](docs/architecture.md) for the shipped runtime, [keyboard reference](docs/keyboard.md) for shortcuts, and [desktop release guide](docs/desktop-release.md) for packaging and updates.

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/bbMisk/learnharness/issues).

## License

[AGPL-3.0](LICENSE)

Original LearnHarness by Amos Blomqvist and contributors; fork additions by Hanson Sun. Upstream attribution and third-party notices are retained.
