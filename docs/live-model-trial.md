# Manual live-model scout trial

Status: **NOT RUN — blocked on provider credentials.** No live result is recorded
here, and none is claimed. The deterministic scout tests (faux/scripted
provider) run in CI; this trial is the separate, billed, non-deterministic check
of real discovery quality required by Milestone 6.

## What the trial does

`npm run trial:live` (`scripts/live-trial.ts`) runs the **real** Pi Durable scout
(the `openai` provider, not the `faux` test provider) over the EMR-like fixture:
a legacy monolith, a modular target that depends on a shared health model, an
unrelated billing repo, and a migration document. It then prints the selected
repositories with intent and evidence counts, the exclusions and reasons, gaps,
and discovered commands so the result can be recorded against the model and
runtime versions.

It is not part of `npm test`. It reads the API key only from the environment and
prints only whether a key is present — never the key itself. It never writes a
credential to disk.

```bash
OPENAI_API_KEY=... WSG_TRIAL_MODEL=<model-id> npm run trial:live
```

When the key is absent the script exits `2` after printing `SKIP` and produces no
workspace, so a missing credential can never be mistaken for a passing trial.

## Availability inspection (this environment)

Checked without printing any secret value:

| Check | Result |
| --- | --- |
| `OPENAI_API_KEY` present in environment | no |
| `ANTHROPIC_API_KEY` / other provider key present | no |
| `~/.config/wsg/config.yaml` (or `$WSG_CONFIG`) | absent |
| `https://api.openai.com/v1` reachable | yes (HTTP `401`, i.e. reachable, no credential) |
| `@earendil-works/chord` | 1.0.2 (installed) |
| `@earendil-works/pi-ai` | 1.0.2 (installed) |
| `@earendil-works/pi-durable` | 1.0.2 (installed) |
| Node used | v25.9.0 |
| Git used | 2.54.0 (Apple Git-157) |

The optional Pi packages and the network are available; the only missing input is
a provider API key/configuration. No global credential or configuration was
created or modified to force a run.

## How to complete this trial

1. Provide an OpenAI API key in the environment (or configure another supported
   provider and extend the scout accordingly).
2. Run the command above. It builds the fixture, performs one live scout
   conversation, and materializes a workspace.
3. Record the results below, copying the script's output.

## Result record

- Date:
- Provider / model:
- Node / Git / Pi package versions:
- Exit code:
- Discovered repositories and count:
- Selected repositories (name, intent, evidence count):
- Exclusions and reasons:
- Gaps / truncation reported:
- Discovered commands:
- Observed discovery limits (e.g. tool-turn or byte budget reached, repos
  skipped, target ambiguity):
- Notes:

Until this record is filled in from a real run, Milestone 6 acceptance item
"manual live-model trial" remains **unfulfilled**.
