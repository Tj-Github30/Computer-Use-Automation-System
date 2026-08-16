# Computer-Use Automation System

LLM discovers a back-office flow **once**. Replay invokes it as a typed  
capability with **no model in the loop**.

The target is a local CoreUnion member-servicing terminal: table layout, no
test IDs, runtime errors that happen in bank software, and two tenants of the
same vendor product.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm test
```

Default `.env` uses `USE_MOCK_LLM=true` (no API key). Replay never uses a
model. For a live discovery only:

```
USE_MOCK_LLM=false
LLM_PROVIDER=gemini
GEMINI_API_KEY=<your_key>
GEMINI_MODEL=gemini-3.5-flash
```

`.env` is gitignored. Never commit keys.

Pass CLI flags **after** `--` so npm forwards them:

```bash
npm run discover -- --spec ...
npm run invoke -- --capability ...
```



## Demo app

```bash
npm run demo-app
```

Serves `http://localhost:3000`. Leave this running for discover / invoke.
Westside tenant: `http://localhost:3000/?tenant=westside`.

### Members


| ID      | What happens                                         |
| ------- | ---------------------------------------------------- |
| `12345` | Jordan Hale — happy path (`$18,640.55` savings)      |
| `1001`  | Ava Martin — happy path                              |
| `2002`  | Noah Davis — proves parameterization                 |
| `3003`  | Priya Shah — extra record                            |
| `9999`  | `MEMBER_NOT_FOUND`                                   |
| `abc`   | `input_invalid` / validation                         |
| `4004`  | `PERMISSION_DENIED` — Login as Supervisor to resolve |
| `5005`  | `SESSION_EXPIRED` once — Login as Teller to resume   |
| `6006`  | Slow load (recoverable)                              |
| `7007`  | Unexpected dialog (recoverable)                      |
| `8008`  | App error (hard)                                     |
| `9009`  | Closed membership — sub-account denied               |


Sub-account products: `Money Market`, `Share Certificate`, `Checking`.

## Capabilities (already recorded)


| Name                    | Artifact                                  | Discovery             |
| ----------------------- | ----------------------------------------- | --------------------- |
| `member-balance-lookup` | `artifacts/member-balance-lookup.v1.json` | Live Gemini 3.5 Flash |
| `open-sub-account`      | `artifacts/open-sub-account.v1.json`      | Mock planner          |


Do not re-run `discover` for lookup unless you intend to overwrite the Gemini
artifact. Replay is enough to verify.

## Invoke (no LLM) — start here

```bash
npm run capabilities

npm run invoke -- --capability member-balance-lookup --inputs "memberId=12345" --headless true
npm run invoke -- --capability member-balance-lookup --inputs "memberId=2002" --headless true
npm run invoke -- --capability member-balance-lookup --inputs "memberId=9999" --headless true
npm run invoke -- --capability member-balance-lookup --inputs "memberId=abc" --headless true
npm run invoke -- --capability member-balance-lookup --inputs "memberId=7007" --headless true
npm run invoke -- --capability member-balance-lookup --inputs "memberId=4004" --headless true --escalate false
npm run invoke -- --capability member-balance-lookup --inputs "memberId=8008" --headless true --escalate false

npm run invoke -- --capability open-sub-account \
  --inputs "memberId=12345,productType=Money Market,openingAmount=250.00" --headless true
npm run invoke -- --capability open-sub-account \
  --inputs "memberId=12345,productType=Bogus,openingAmount=10" --headless true
npm run invoke -- --capability open-sub-account \
  --inputs "memberId=9009,productType=Checking,openingAmount=50.00" --headless true --escalate false

npm run invoke -- --capability member-balance-lookup --tenant westside \
  --inputs "memberId=12345" --headless true
```



## Human handoff

Terminal A:

```bash
npm run invoke -- --capability member-balance-lookup --inputs "memberId=5005" \
  --headless true --interactive false --takeoverPort 9222
```

Terminal B:

```bash
npm run operator
npm run operator -- --resolve "<dir>" --click "Login as Teller" --operator teller04
```

For `4004`, click `Login as Supervisor`.


## Commands


| Command                | Purpose                            |
| ---------------------- | ---------------------------------- |
| `npm run demo-app`     | Target app on `:3000`              |
| `npm run discover`     | Record a capability (LLM or mock)  |
| `npm run invoke`       | Replay by capability name (no LLM) |
| `npm run replay`       | Same engine via `--artifact`       |
| `npm run capabilities` | Catalogue                          |
| `npm run operator`     | Operator console for handoff       |
| `npm test`             | Typecheck + safety checks          |




## Layout


| Path            | Contents                           |
| --------------- | ---------------------------------- |
| `src/`          | Runtime                            |
| `capabilities/` | Authored specs + Westside override |
| `artifacts/`    | Recorded capabilities              |
| `evidence/`     | Discovery + replay logs            |
| `REPORT.md`     | Design write-up                    |
| `README.md`     | This file                          |


