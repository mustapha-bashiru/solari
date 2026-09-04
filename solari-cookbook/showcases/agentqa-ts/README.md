# AgentQA with Solari

AgentQA is a TypeScript CLI showcase that uses a recorded Solari browser to test a checkout flow, verify a suspected failure from fresh state three times, analyze the evidence in an isolated Solari sandbox, and emit an HTML bug report with screenshots and a downloadable rrweb trace.

This is an end-to-end showcase rather than one of the repository's deliberately small examples. It remains a focused CLI, not a React or FastAPI application.

## Setup

```bash
cd showcases/agentqa-ts
npm install
cp .env.example .env
# add SOLARI_API_KEY and OPENAI_API_KEY
npm start
```

## Environment

Required:

```bash
SOLARI_API_KEY=slr_live_...
OPENAI_API_KEY=sk-...
```

Optional:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
TARGET_URL=https://example.com
AGENTQA_MISSION=Test checkout as a first-time customer.
AGENTQA_MAX_TURNS=12
AGENTQA_MAX_ACTIONS=24
```

OpenRouter and other OpenAI-compatible providers can be selected with `OPENAI_BASE_URL`; provide their token through `OPENAI_API_KEY`.

`TARGET_URL` is useful for exploratory runs against another site. The deterministic acceptance path uses the bundled demo store because it contains one canonical seeded defect: clicking `Place Order` never reaches an order confirmation.

## What the script does

1. Validates `SOLARI_API_KEY` and `OPENAI_API_KEY` before creating remote resources.
2. Creates a Solari sandbox and serves `demo-store.html` with `python3 -m http.server`.
3. Launches a Solari browser with `recording: true`.
4. Gives the model a bounded checkout mission and a small set of browser tools: navigate, inspect, click, fill, wait, screenshot, and report suspected failure.
5. Runs deterministic verification from fresh state three times. After each submission it inspects the page, records the exact confirmation text and captures a screenshot when successful, or immediately records a suspected failure with the visible error/state and screenshot when confirmation is absent.
6. Gives rrweb two seconds to flush, releases the browser, and then releases the target sandbox.
7. Sends trace and verification data to a second Solari sandbox for Python evidence analysis.
8. Polls for about 30 seconds for the recording URL and writes `agentqa-report.html` for the confirmed result, including post-submit text and screenshots.

The two sandboxes are used sequentially, not concurrently. The target is released before the analysis sandbox is created, so the run needs only one concurrent sandbox and does not fail with `Too many concurrent sessions` on plans that allow a single session. The recorded browser draws from a separate pool and overlaps the target sandbox only while the agent is browsing.

Generated reports and screenshots are local artifacts and should not be committed.

## Expected output

A successful run prints:

```text
report: .../agentqa-report.html
status: confirmed
rrweb trace: https://...
```

The report includes status, severity, confidence, reproduction rate, expected vs actual behavior, numbered steps, rendered screenshots, action trace, target URL, session ID, and recording status.

The recording is gzipped rrweb NDJSON, a DOM-level trace rather than a video or hosted player. Upload is asynchronous after browser release, so the script polls for about 30 seconds. If it is not ready, the report states that status instead of pretending a watchable replay exists.

A completed verification writes a report with the post-submit confirmation/error text and screenshots. Configuration, provisioning, malformed model responses, and sandbox-analysis failures still exit nonzero.

## Demo script

1. Run `npm start` from this directory.
2. Explain that AgentQA provisions an isolated Solari sandbox target instead of relying on a pre-scripted local page.
3. Show the model planning and acting through the browser tools while Solari Chrome navigates product -> cart -> checkout.
4. Point out that a single failed click is not enough: AgentQA verifies from fresh page state three times.
5. Open `agentqa-report.html` and show `3/3`, expected vs actual, rendered screenshots, confidence, and trace.
6. Point out the recording status and downloadable rrweb NDJSON trace, which maps the report back to the recorded browser session without presenting it as video playback.

## LinkedIn/X post template

```text
Built AgentQA: a Solari-powered QA agent that explores checkout, reproduces a seeded defect 3/3 times with an explicit visible failure signal, analyzes evidence in a sandbox, and emits an HTML bug report with screenshots and an rrweb trace.

Recorded browser + isolated sandbox + tri-state deterministic verifier = fewer unsupported AI bug claims.

@harrychow_ @getsolari
```

## Validation

```bash
npm run build
```

For full validation, run the CLI with valid Solari and OpenAI-compatible credentials and inspect the generated report. Also test missing `SOLARI_API_KEY` and missing `OPENAI_API_KEY` to confirm fast, actionable configuration failures without creating Solari resources.
