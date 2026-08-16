# Evidence

Assignment §6: a saved example artifact plus logs from a discovery run and a
replay run, including at least one exceptional replay.

## Artifacts

| File | Provenance |
| --- | --- |
| `example-artifact.member-balance-lookup.json` | Live **Gemini 3.5 Flash** discovery (`discovery-2026-08-15T19-56-30-357Z`) |
| `example-artifact.open-sub-account.json` | Mock planner discovery (`discovery-2026-08-16T17-08-41-265Z`) — same observe → decide → act loop |

Copies also live in `artifacts/`. One live LLM discovery satisfies the brief;
sub-account uses mock recording so reviewers can re-run without an API key.

## Discovery runs

| Directory | What it shows |
| --- | --- |
| `discovery-2026-08-15T19-56-30-357Z/` | Live Gemini member lookup. `events.jsonl` has model rationales; success screenshot + aria/html snapshots. Balance is `[REDACTED]`. |
| `discovery-2026-08-16T17-08-41-265Z/` | Mock discovery of open-sub-account through the confirmation screen. |

## Replay runs (no LLM)

| Directory | What it shows |
| --- | --- |
| `replay-2026-08-16T17-08-51-162Z/` | Lookup success, `memberId=12345`, savings `$18,640.55`. |
| `replay-2026-08-16T17-08-51-966Z/` | Lookup success, `memberId=2002` — parameterization. |
| `replay-2026-08-16T17-08-52-749Z/` | `MEMBER_NOT_FOUND` as a **business outcome**. |
| `replay-2026-08-16T17-08-53-540Z/` | `input_invalid` rejected before the browser acted (`memberId=abc`). |
| `replay-2026-08-16T17-08-54-050Z/` | Recoverable unexpected dialog (`7007`), still success. |
| `replay-2026-08-16T17-08-54-859Z/` | Hard failure `PERMISSION_DENIED` (`4004`). |
| `replay-2026-08-16T17-08-55-639Z/` | Hard failure `APP_ERROR` (`8008`). |
| `replay-2026-08-16T17-08-56-430Z/` | Open sub-account success + `confirmationNumber`. |
| `replay-2026-08-16T17-08-57-353Z/` | Sub-account `VALIDATION_ERROR` (bogus product). |
| `replay-2026-08-16T17-09-24-206Z/` | Sub-account `PERMISSION_DENIED` on closed membership (`9009`). |
| `replay-2026-08-16T17-09-09-379Z/` | Westside tenant override on the **same** lookup artifact. |

Each run: `events.jsonl`, screenshots, and on failure `.aria.txt` + `.html`.
