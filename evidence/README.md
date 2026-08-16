# Evidence

Assignment §6: example artifacts, a discovery run, replay runs including
exceptional states, and a live-session handoff.

## Artifacts

| File | Provenance |
| --- | --- |
| `example-artifact.member-balance-lookup.json` | Live **Gemini 3.5 Flash** (`discovery-2026-08-15T19-56-30-357Z`) |
| `example-artifact.open-sub-account.json` | Mock planner (`discovery-2026-08-16T17-08-41-265Z`) — same observe → decide → act loop |

Copies also live in `artifacts/`. One live LLM discovery satisfies the brief.

## Discovery

| Directory | What it shows |
| --- | --- |
| `discovery-2026-08-15T19-56-30-357Z/` | Live Gemini member lookup. Rationales in `events.jsonl`. Balance is `[REDACTED]`. |
| `discovery-2026-08-16T17-08-41-265Z/` | Sub-account through the confirmation screen. |

## Replay (no LLM)

| Directory | What it shows |
| --- | --- |
| `replay-2026-08-16T17-08-51-162Z/` | Lookup `12345` success (`$18,640.55`). |
| `replay-2026-08-16T17-08-51-966Z/` | Lookup `2002` (parameterization). |
| `replay-2026-08-16T17-08-52-749Z/` | `MEMBER_NOT_FOUND`. |
| `replay-2026-08-16T17-08-53-540Z/` | `input_invalid`. |
| `replay-2026-08-16T17-08-54-050Z/` | Recovered dialog (`7007`). |
| `replay-2026-08-16T17-08-54-859Z/` | `PERMISSION_DENIED` (`4004`). |
| `replay-2026-08-16T17-08-55-639Z/` | `APP_ERROR` (`8008`). |
| `replay-2026-08-16T17-08-56-430Z/` | Sub-account success. |
| `replay-2026-08-16T17-08-57-353Z/` | Sub-account `VALIDATION_ERROR`. |
| `replay-2026-08-16T17-09-24-206Z/` | Closed membership denied (`9009`) as `PERMISSION_DENIED`. |
| `replay-2026-08-16T17-09-09-379Z/` | Westside tenant override. |

## Live-session handoff

`handoff-session-expired-5005/` — member `5005` (`SESSION_EXPIRED`):

- `events.jsonl` — `intervention_requested`, `control_transfer` automation→human,
  operator `teller04` clicked “Login as Teller”, `control_transfer` human→automation,
  run completed `success` with savings `$2,145.60`.
- `interventions/int-*/request.json` — reason, step, URL, takeover endpoint,
  `access.actionable`.
- `before-handoff.png` / `.aria.txt` / `.html` and `after-handoff.*`.
- `resolution.json` — resume, operator id, notes, `manualActions`, `urlChanged`, `pageChanged`.
- `success.png`.

## Automated coverage

`npm test` runs typecheck, `src/checks.ts`, and `src/integration.ts`:

1. Happy path `12345`
2. Business outcome `9999`
3. Recoverable dialog `7007`
4. Hard `PERMISSION_DENIED` `4004`
5. Westside tenant override
6. Click “Open Core Processor Portal” cannot land on `evil.example.com`
7. Handoff for `5005` (operator attaches over CDP and resumes)
