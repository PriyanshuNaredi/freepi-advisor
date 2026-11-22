# freepi-advisor

A `/advisor` command and an `ask_advisor` tool for **[free-pi](https://www.npmjs.com/package/free-pi-cli)** (and any pi-based CLI): get a second opinion from a stronger model **without switching your session's model**.

Your session keeps running on the cheap/free model that does the work — the advisor is only consulted, in a separate one-shot request, over the transcript so far.

```
You (deepseek-v4.1-flash) ──works──> files, commands, tests
        │
        └── /advisor ──> gpt-6.2-astra: "what did you miss?"  (one request, no tools)
```

- **Non-invasive** — the advisor never touches your session model, history or tools.
- **Two ways to use it** — you ask (`/advisor did I miss anything?`), or the agent asks itself (the `ask_advisor` tool).
- **Model choice** — automatic (free-tier `gpt-6.2-astra` first), per-call (`/advisor @gpt-6.1-sol …`), or pinned for the session (`/advisor use …`).
- **Bring your own key** — `openai`, `openrouter`, `anthropic` or any OpenAI/Anthropic-compatible endpoint (Coarena, LiteLLM, vLLM, a proxy…), configured only for the advisor.
- **No dependencies** — one TypeScript file, `node:fs`/`fetch` only, no build step.

---

## Install

Requires **free-pi** (or pi) and **Node ≥ 18** (for `fetch`). The extension is a single file dropped into your agent's `extensions/` folder.

Your agent directory is `$PI_CODING_AGENT_DIR` if set, otherwise `~/.free-pi/agent`:

| OS | Default path |
| --- | --- |
| macOS / Linux | `~/.free-pi/agent/extensions/advisor.ts` |
| Windows | `%USERPROFILE%\.free-pi\agent\extensions\advisor.ts` |

### Option A — clone and run the installer (any OS)

```bash
git clone https://github.com/PriyanshuNaredi/freepi-advisor.git
cd freepi-advisor
node install.mjs
```

The installer copies `advisor.ts` into the detected agent directory, creates `extensions/` if needed, and prints the target path. Point it somewhere else with `node install.mjs --dir <agent-dir>`.

### Option B — copy the file by hand

```bash
# macOS / Linux
mkdir -p ~/.free-pi/agent/extensions
cp advisor.ts ~/.free-pi/agent/extensions/advisor.ts
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.free-pi\agent\extensions" | Out-Null
Copy-Item .\advisor.ts "$env:USERPROFILE\.free-pi\agent\extensions\advisor.ts"
```

### Then

Restart free-pi (`npx free-pi-cli@latest`) and check the footer or run `/advisor model`.

---

## Quick start

```
/advisor                                   # review the session so far with the default advisor
/advisor does the retry logic handle 429?  # ask it something specific
/advisor @gpt-6.1-sol is this over-engineered?
/advisor use claude-opus-5-5               # pin an advisor for the rest of the session
/advisor use default                       # back to automatic
```

The answer comes back as an advisor message in the transcript, so the main model sees it and can act on it.

---

## Commands

| Command | What it does |
| --- | --- |
| `/advisor [question]` | Ask the current advisor, either the whole transcript (no question) or the transcript plus your question. |
| `/advisor @<model> [question]` | Ask that model for this call only. Loose ids work: `@gpt-6.1-sol`, `@luna`, `@coarena/gpt-6-2-astra`. With no question and an empty session it **pins** that model instead of erroring. |
| `/advisor -m <provider>/<id> [question]` | Same, with an explicit provider, e.g. `-m openai/gpt-6.2-astra`. |
| `/advisor use <model>` | Pin the advisor for this session. Alias: `/advisor set <model>`. |
| `/advisor use default` | Drop the pin and go back to the automatic choice. |
| `/advisor model` | Show which advisor is in use and why. |
| `/advisor key` | Explain how to give the advisor its own API key. |
| `/advisor endpoint` | Show the third-party endpoint config (never the key). |
| `/advisor models` | List model ids available on that endpoint. |

`Tab` completes everything above, including model ids after `use`, `set`, `@` and `-m`.

### Tool: `ask_advisor`

The agent can consult the advisor itself:

```
ask_advisor(question: "Is the migration reversible? Be specific about the down path.")
```

Optional `model` argument (`"gpt-6.1-sol"`, `"openai/gpt-6.2-astra"`, `"coarena/claude-opus-5-5"`) asks a specific model for that call. The tool returns the advice as text with `details.advisor` naming the model that answered, and reports failures as tool errors instead of crashing the turn.

---

## Which model answers?

Resolution order, first hit wins:

1. `/advisor use …` pin, or the per-call `@model` / `-m provider/model`.
2. `ADVISOR_MODEL` environment variable.
3. `gpt-6.2-astra` — from the free-pi catalogue if your account has it, otherwise from a bring-your-own-key entry in `models.json`.
4. `ADVISOR_FALLBACKS` (default `gpt-6.2-astra,gpt-6-astra,gpt-6.1-sol,gpt-6-luna,claude-opus-5-5,claude-sonnet-5-5`) — only models that are actually usable: free tier, configured auth, or your advisor key.
5. The endpoint's configured `model`, if you set one.

A model counts as *usable* only when free-pi serves it or you have credentials for it, so a fallback list is safe to over-share — it will not try a provider you cannot call.

The footer shows the result:

```
advisor: 6.2 astra
advisor: claude opus 5.5 (coarena) · pinned
advisor: 6.2 astra · your key
advisor: none            # nothing usable; set ADVISOR_MODEL or a key
```

---

## Bring your own key

The advisor can use a key that is **not** your session's credentials. This is also the path that avoids free-pi's `FREEPI_BYO` origin allowlist, because the key is passed per request.

Two ways, both read at call time:

```bash
ADVISOR_API_KEY=sk-...                       # the key
ADVISOR_API_KEY_PROVIDER=openai              # which provider it belongs to (default: openai)
```

or a file `<agent dir>/advisor-key` containing just the key, optionally with a provider line first:

```
provider=openrouter
sk-or-v1-...
```

Then ask an advisor from that provider:

```
/advisor @gpt-6.2-astra ...            # matches openai/gpt-6.2-astra
/advisor use openrouter/deepseek-v4    # any model id your key can serve
```

Keys are **never** printed, logged or put in the transcript — `/advisor key` only says where a key was found. Keep the file private:

```bash
chmod 600 ~/.free-pi/agent/advisor-key
```

```powershell
icacls "$env:USERPROFILE\.free-pi\agent\advisor-key" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

> Never paste an API key into the chat, a commit, or an issue: it lands in the transcript and in shell history.

---

## Third-party endpoints (OpenAI- or Anthropic-compatible)

Any host that speaks `/chat/completions` or `/messages` can act as the advisor. Configure with environment variables:

| Variable | Meaning |
| --- | --- |
| `ADVISOR_BASE_URL` | e.g. `https://coarena.ai/api/v1`, `http://localhost:4000/v1` |
| `ADVISOR_API_KEY` | key for that endpoint (shared with the BYO-key path above) |
| `ADVISOR_ENDPOINT_MODEL` | default model id on that endpoint |
| `ADVISOR_ENDPOINT_API` | `openai-completions` (default) or `anthropic-messages` |
| `ADVISOR_ENDPOINT_PROVIDER` | name shown in labels, default `custom` |
| `ADVISOR_ENDPOINT_DEFAULT` | `1` = prefer this endpoint over free models |

or a JSON file `<agent dir>/advisor-endpoint.json`:

```json
{
  "provider": "coarena",
  "baseUrl": "https://coarena.ai/api/v1",
  "apiKey": "",
  "model": "gpt-6-2-astra",
  "api": "openai-completions",
  "default": false
}
```

- `apiKey` empty ⇒ the endpoint is inert, everything else in the file is ignored.
- `default: false` ⇒ free-tier models still win unless you name the endpoint (`@coarena/<id>`) or pin it (`/advisor use coarena/<id>`). Set `true` to make it the default advisor.
- `api` picks the wire format: `openai-completions` sends `Authorization: Bearer …` to `<baseUrl>/chat/completions`; `anthropic-messages` sends `x-api-key` + `anthropic-version: 2023-06-01` to `<baseUrl>/messages`.
- `/advisor models` calls `GET <baseUrl>/models` and lists ids, so you can copy one into `model`.

Keep the file private (`chmod 600` on macOS/Linux; `icacls` on Windows). It is in `.gitignore` here for a reason.

---

## Configuration reference

| Variable | Default | Effect |
| --- | --- | --- |
| `ADVISOR_MODEL` | — | Preferred advisor id or `provider/id`. |
| `ADVISOR_FALLBACKS` | `gpt-6.2-astra,gpt-6-astra,gpt-6.1-sol,gpt-6-luna,claude-opus-5-5,claude-sonnet-5-5` | Ordered fallback ids. |
| `ADVISOR_REASONING` | `high` | Reasoning effort passed to models that support it. |
| `ADVISOR_MAX_TOKENS` | `8000` | Max output tokens for the advice. |
| `ADVISOR_MAX_CHARS` | `160000` | Transcript cap, newest messages kept first. |
| `ADVISOR_API_KEY` | — | Advisor-only key (also used by the endpoint). |
| `ADVISOR_API_KEY_PROVIDER` | `openai` | Provider that key belongs to. |
| `ADVISOR_BASE_URL` + friends | — | Third-party endpoint, see above. |

Set them per shell:

```bash
export ADVISOR_MODEL=gpt-6.1-sol
```

```powershell
$env:ADVISOR_MODEL = "gpt-6.1-sol"
```

On Windows, use `setx ADVISOR_MODEL gpt-6.1-sol` to make it permanent (new terminals only).

---

## What is actually sent

One request, two messages, no tools, no streaming:

1. A system prompt: senior reviewer, no tools, short blunt critique — what is wrong or unverified, what is missing, the single next action. It also tells the model not to speculate about its own identity or version, so an advisor cannot derail a review by guessing which model it is.
2. The transcript, rendered as `## user`, `## assistant`, `## tool result (edit)` sections, with tool calls inline as `[tool call edit {"path":"a.ts"}]`. Thinking blocks are dropped, tool output is truncated, and the whole thing is capped by `ADVISOR_MAX_CHARS` from the newest end.

So: **the transcript leaves your machine** and goes to whichever provider answers. Pick your advisor accordingly, and prefer endpoints you trust.

---

## Cross-platform notes

- Paths are built with `node:path`; no shelling out, no `chmod`, no `/tmp`. Windows, macOS and Linux take the same code path.
- `fetch` needs Node ≥ 18 — same requirement as free-pi.
- The only OS-specific text is the `/advisor key` hint, which omits `chmod` on Windows.
- `install.mjs` only copies one file and resolves the agent directory with `os.homedir()`.

Tested on macOS with free-pi; the code avoids platform APIs, but Windows and Linux have not been run by the author. Reports welcome.

---

## Tests

```bash
node tests/run.mjs        # or: npm test
```

59 headless checks, no network and no real API calls: registration, default/fallback resolution, per-call and pinned models, empty-session behaviour, error paths, own-key plumbing, both endpoint wire formats against a local stub server (auth headers and request bodies included), config-file loading, transcript capping, odd transcript entries, tool success/failure, and Tab completion.

The script loads the extension through pi's own jiti setup, so imports match production. It needs the free-pi (or pi) package for `typebox`; it auto-discovers `~/.npm/_npx/*/node_modules/free-pi-cli`, and you can point it anywhere with:

```bash
PI_PKG_DIR=/path/to/free-pi-cli/node_modules node tests/run.mjs
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `/advisor` not listed | Extension not loaded: file must be at `<agent dir>/extensions/advisor.ts`, then restart free-pi. |
| `Nothing to review yet: this session has no messages` | Nothing has happened in the session. Pass a question (`/advisor <question>`) or do some work first. |
| `No single model matches "x"` (with suggestions) | The id is not in the catalogue and not configured. Use a suggestion, `/advisor models`, or `-m provider/id`. |
| Footer reads `advisor: none` | No usable advisor. Set `ADVISOR_MODEL`, or provide `ADVISOR_API_KEY`, or enable an endpoint. |
| Endpoint configured but ignored | `apiKey` is empty in `advisor-endpoint.json`, or the file is not valid JSON (`node -e "JSON.parse(require('fs').readFileSync(process.argv[1]))" <file>`). |
| `401`/`403` from an endpoint | Wrong wire format: switch `api` between `openai-completions` and `anthropic-messages`. |
| Advisor insists it is some other model or vendor | The endpoint substituted a model for the id you asked for. When the response reports a different `model`, the advice header says `served as <id>` and a warning is shown. Nothing to fix here — routing is on the provider's side. |
| Advice looks truncated | Raise `ADVISOR_MAX_TOKENS`; lower `ADVISOR_MAX_CHARS` if the request is too big. |
| A `FREEPI_BYO` / origin error appears | That is free-pi's own BYO guard. Use the advisor's `ADVISOR_API_KEY` path instead, which passes the key per request. |

---

## Limitations

- The advisor is blind: transcript only, no tools, no file access. It cannot verify anything itself.
- One request per call, no retries, no streaming, no multi-turn debate.
- Session pins live in memory: restarting free-pi resets them (set `ADVISOR_MODEL` or the endpoint's `default` for something durable).
- Advice is advisory — the main model decides what to do with it.

## License

MIT © Priyanshu Naredi

Not affiliated with free-pi, OpenAI, Anthropic or any endpoint provider.
