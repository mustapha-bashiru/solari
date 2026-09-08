````markdown
# AgentQA

**Autonomous QA agent for Web and Web3 applications, built with Solari.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933)](https://nodejs.org/)
[![Solari](https://img.shields.io/badge/Built%20with-Solari-0f766e)](https://getsolari.com)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## Overview

AgentQA is an autonomous QA agent that investigates web applications and produces evidence-backed bug reports.

A language model drives a recorded [Solari](https://getsolari.com) cloud browser through a bounded set of tools — navigate, inspect, click, fill, wait, and screenshot. The agent explores the target application rather than following a completely hard-coded path.

When it suspects a failure, AgentQA does not immediately file a bug. A deterministic verifier independently reproduces the suspected failure from clean state, an isolated Solari sandbox analyzes the collected evidence, and only then does AgentQA produce a report.

The current bundled demonstration uses a deterministic e-commerce checkout, but the architecture is intended to extend to **Web3 applications and dApps** including wallet connection, network switching, token approvals, contract transactions, NFT minting, staking, and DeFi workflows.

The result is an evidence-backed QA report containing the finding, reproduction steps, screenshots, structured trace data, reproduction rate, confidence, and — when available — a Solari session replay.

With the optional KeeperHub integration, the generated report can also be **cryptographically attested on-chain** by binding its SHA-256 digest to a Sepolia transaction.

---

## Features

- **Autonomous browser navigation** — the model explores the target site through a small tool surface instead of following a fully hard-coded script.

- **Web application testing** — currently demonstrated with product → cart → checkout → form fill → submit.

- **Web3-ready testing** — designed to support wallet connections, network selection, contract calls, token approvals, NFT minting, staking, DeFi interactions, and other dApp workflows.

- **Post-action inspection** — after important actions the agent inspects the actual rendered page state and classifies the outcome instead of relying on assumptions.

- **Bug detection** — a suspected defect must include severity, expected vs. actual behaviour, reproduction steps, and a rationale before it is accepted for verification.

- **Screenshot evidence** — captures are collected during investigation and verification and embedded into the generated report.

- **Three-run verification** — suspected failures are re-tested from freshly cleared browser state. The current checkout verifier requires a 3/3 reproduction before marking the defect confirmed.

- **Isolated evidence analysis** — trace and verification data are analyzed inside a separate Solari sandbox, keeping the final evidence assessment out of the investigator's control.

- **Session recording** — browsers are launched with recording enabled. A replay link is included when the Solari recording service makes the replay available.

- **Structured JSON output** — every run produces a machine-readable `agentqa-report.json` alongside the human-readable HTML report.

- **On-chain report attestation** — optionally hashes the report and records the digest in KeeperHub-managed Sepolia transaction calldata.

- **Independent on-chain verification** — the transaction is fetched back from the chain and its calldata is checked against the report digest rather than trusting KeeperHub's execution response alone.

---

## Architecture

AgentQA separates **investigation** from **proof**.

The investigator is model-driven and exploratory. The verifier is deterministic code that the model cannot influence.

```text
                         ┌──────────────────────────────┐
                         │       Target Application     │
                         │                              │
                         │  Web app / Web3 dApp        │
                         │  checkout / wallet / tx /    │
                         │  contract / DeFi workflow    │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │       INVESTIGATOR            │
                         │                              │
                         │  LLM + recorded Solari       │
                         │  browser                     │
                         │                              │
                         │  navigate · inspect · click  │
                         │  fill · wait · screenshot    │
                         └──────────────┬───────────────┘
                                        │
                              suspected finding
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │        VERIFIER               │
                         │        (no model)             │
                         │                              │
                         │  Fresh state                 │
                         │  Reproduction attempts       │
                         │  Explicit outcome checks     │
                         │  Screenshot evidence         │
                         └──────────────┬───────────────┘
                                        │
                              trace + evidence
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │    SOLARI ANALYSIS SANDBOX    │
                         │                              │
                         │  Evidence scoring            │
                         │  confidence                  │
                         │  reproduction rate           │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │       QA REPORT              │
                         │                              │
                         │  agentqa-report.json         │
                         │  agentqa-report.html         │
                         │  screenshots / trace         │
                         └──────────────┬───────────────┘
                                        │
                              SHA-256 digest
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │        KEEPERHUB              │
                         │                              │
                         │  workflow validation         │
                         │  simulation                  │
                         │  transaction execution       │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │       Ethereum Sepolia       │
                         │                              │
                         │  digest embedded in calldata │
                         │  transaction receipt         │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │  Independent Verification    │
                         │                              │
                         │  eth_getTransactionByHash    │
                         │  calldata → digest match     │
                         └──────────────────────────────┘
````

### Investigator

Runs the mission inside a Solari browser launched with recording enabled. Turn and action budgets prevent the model from wandering indefinitely.

The investigator can only report a suspected defect through the structured `report_suspected_failure` path.

### Verifier

The verifier ignores the investigator's conclusion and independently tests the suspected failure.

For the current checkout demonstration, it reloads the target, clears browser storage, performs the checkout sequence, and checks the resulting page state against explicit confirmation and error patterns.

Each attempt produces an outcome, observation, and screenshot.

### Evidence analysis

The collected trace and verification results are analyzed inside a separate Solari sandbox.

For the current deterministic checkout verifier:

* `3/3` failures → confidence `0.93` → **confirmed**
* partial reproduction → confidence `0.55`
* no reproduction → confidence `0.20` → **inconclusive**

---

## Web3 application support

The current demo is intentionally simple, but AgentQA is designed around **application workflows rather than e-commerce specifically**.

Potential Web3 missions include:

```text
Connect wallet
      │
      ▼
Check network
      │
      ▼
Switch network
      │
      ▼
Approve token
      │
      ▼
Execute contract transaction
      │
      ▼
Wait for confirmation
      │
      ▼
Verify resulting application state
```

This allows AgentQA to investigate failures such as:

* Wallet connection failures
* Wrong-network handling
* Wallet/provider detection problems
* Transaction rejection handling
* Contract transaction reverts
* Gas estimation failures
* Transactions stuck in pending state
* Token approval failures
* NFT mint failures
* Staking failures
* DeFi interaction failures
* Incorrect post-transaction UI state
* Missing transaction confirmation
* Application state disagreeing with on-chain state

The key principle is the same as the checkout demonstration:

> **The agent observes a failure, then independently reproduces it before declaring it a defect.**

---

## Installation

Requires Node.js 20+, a Solari API key, and an OpenAI-compatible API key.

```bash
git clone https://github.com/mustapha-bashiru/solari.git
cd solari/solari-cookbook/showcases/agentqa-ts
npm install
cp .env.example .env
```

Then configure:

```bash
SOLARI_API_KEY=slr_live_...
OPENAI_API_KEY=sk-...
```

---

## Usage

Run the complete AgentQA workflow:

```bash
npm start
```

AgentQA provisions its own target sandbox, launches the recorded browser, investigates the application, verifies the suspected failure, analyzes the evidence, and writes the report.

A typical run ends with:

```text
report: .../agentqa-report.html
status: confirmed
rrweb trace: ...
```

If the recording service has not made a replay available, the run can still complete and produce the report without a replay URL.

Open:

```text
agentqa-report.html
```

to inspect the finding.

The machine-readable report is:

```text
agentqa-report.json
```

---

## Configuration

| Variable              | Required | Default                                   | Purpose                       |
| --------------------- | -------- | ----------------------------------------- | ----------------------------- |
| `SOLARI_API_KEY`      | yes      | —                                         | Solari browsers and sandboxes |
| `OPENAI_API_KEY`      | yes      | —                                         | Investigator model            |
| `OPENAI_BASE_URL`     | no       | `https://api.openai.com/v1`               | OpenAI-compatible gateway     |
| `OPENAI_MODEL`        | no       | `gpt-4.1-mini`                            | Investigator model            |
| `TARGET_URL`          | no       | bundled demo store                        | Point AgentQA at another site |
| `AGENTQA_MISSION`     | no       | `Test checkout as a first-time customer.` | QA mission                    |
| `AGENTQA_MAX_TURNS`   | no       | `12`                                      | Model turn budget             |
| `AGENTQA_MAX_ACTIONS` | no       | `24`                                      | Browser action budget         |

Type-check without spending API credits:

```bash
npm run build
```

---

# KeeperHub On-Chain Attestation

AgentQA proves the **bug**.

KeeperHub optionally proves the **report**.

The attestation layer takes the generated report, computes its SHA-256 digest, and records that digest in transaction calldata on Ethereum Sepolia.

This creates a tamper-evident relationship between the generated report and an on-chain transaction.

```text
AgentQA report
      │
      ▼
 SHA-256
      │
      ▼
32-byte digest
      │
      ▼
KeeperHub workflow
      │
      ├── validate
      │
      ├── simulate
      │
      └── execute
             │
             ▼
      Sepolia transaction
             │
             ▼
      digest in calldata
```

A plain ETH transfer would not be sufficient because the transaction would have no cryptographic relationship with the report.

The digest in calldata is the important part.

---

## Attestation modes

There are two supported paths.

### Integrated `npm start`

The main AgentQA run writes the report JSON first, then attests those exact bytes, and finally renders the HTML report containing the resulting proof.

```ts
const reportJson = `${JSON.stringify(report, null, 2)}\n`

await writeFile(REPORT_JSON, reportJson, "utf8")

const attestation = await attestReport(reportJson)

await writeHtmlReport(report, attestation)
```

The digest therefore covers:

```text
agentqa-report.json
```

and **not the HTML file**.

This is intentional because the HTML contains the attestation information itself. Hashing the HTML after inserting its own digest would create a circular dependency.

### Standalone `npm run attest`

For an already-generated report:

```bash
npm run attest -- --dry-run
```

performs the attestation flow without broadcasting.

Then:

```bash
npm run attest
```

simulates, broadcasts, waits for confirmation, and verifies the transaction.

In this mode the existing:

```text
agentqa-report.html
```

is hashed and the proof is written beside it as an attestation sidecar.

---

## KeeperHub configuration

Set these variables in `.env`:

| Variable                      | Required     | Default       | Purpose                            |
| ----------------------------- | ------------ | ------------- | ---------------------------------- |
| `KEEPERHUB_API_KEY`           | no           | —             | Enables KeeperHub attestation      |
| `KEEPERHUB_WALLET_ADDRESS`    | when key set | —             | KeeperHub wallet address           |
| `KEEPERHUB_ATTEST_RECIPIENT`  | no           | wallet itself | Attestation recipient              |
| `KEEPERHUB_CHAIN_ID`          | no           | `11155111`    | Ethereum Sepolia                   |
| `KEEPERHUB_ATTEST_AMOUNT_ETH` | no           | `0.001`       | Testnet ETH amount                 |
| `KEEPERHUB_RPC_URL`           | no           | public RPC    | Read-only transaction verification |
| `KEEPERHUB_TIMEOUT_MS`        | no           | `180000`      | Receipt polling timeout            |

The KeeperHub API key is an organization API key and should remain local in `.env`. **Do not commit it or place it in source control.**

If `KEEPERHUB_API_KEY` is not configured, AgentQA behaves as before and simply skips the attestation layer.

---

## Attestation safety gates

The attestation flow does not immediately broadcast.

The intended sequence is:

```text
1. Locate/create workflow
        ↓
2. Validate workflow
        ↓
3. Simulate transaction
        ↓
4. Execute workflow
        ↓
5. Poll execution
        ↓
6. Fetch transaction independently
        ↓
7. Verify digest in calldata
```

Workflow validation and simulation happen before the transaction is signed.

An execution that remains `unconfirmed` is polled rather than blindly submitted again.

Idempotency is keyed from the report digest so identical reports should not unnecessarily pay twice.

After confirmation, AgentQA independently retrieves the transaction using `eth_getTransactionByHash` and checks that the calldata ends with the expected SHA-256 digest.

A digest mismatch is treated as a fatal verification failure.

---

## Verified KeeperHub run

The following end-to-end run was successfully executed on Ethereum Sepolia.

|                           |                                                                      |
| ------------------------- | -------------------------------------------------------------------- |
| **Report digest**         | `bf36a837ef308fc06d929f376e6fbfb696d69f8c4cb88e021f9e9c81a112bcd7`   |
| **Attested bytes**        | `18343`                                                              |
| **Transaction**           | `0x1d7f5c84e5590db30c8e874ccc51b81f87f728c88d7fa15f4e0508a1eb38fbdc` |
| **Chain**                 | `11155111` — Ethereum Sepolia                                        |
| **From**                  | `0x39B327D0950Ff2d9C23520D57e55890E3bE932c6`                         |
| **To**                    | `0x39B327D0950Ff2d9C23520D57e55890E3bE932c6`                         |
| **Amount**                | `0.001 ETH` testnet                                                  |
| **Execution ID**          | `ntr9pb5u4xo1t1wg4yk1a`                                              |
| **Workflow ID**           | `z8plgp2yjbvm4a39o2k3o`                                              |
| **Workflow validation**   | passed                                                               |
| **Simulation**            | passed, no revert                                                    |
| **Execution**             | success                                                              |
| **On-chain digest check** | confirmed                                                            |

Transaction:

[https://sepolia.etherscan.io/tx/0x1d7f5c84e5590db30c8e874ccc51b81f87f728c88d7fa15f4e0508a1eb38fbdc](https://sepolia.etherscan.io/tx/0x1d7f5c84e5590db30c8e874ccc51b81f87f728c88d7fa15f4e0508a1eb38fbdc)

To independently verify the report:

```bash
sha256sum agentqa-report.html
```

for a standalone HTML attestation, or:

```bash
sha256sum agentqa-report.json
```

when using the integrated `npm start` attestation path.

The resulting digest must match the digest recorded in the corresponding attestation.

---

## Project structure

```text
solari-cookbook/
├── showcases/
│   └── agentqa-ts/
│       ├── index.ts                 Agent, verifier, analysis, report writer
│       ├── keeperhub.ts             Optional on-chain report attestation
│       ├── attest.ts                npm run attest CLI
│       ├── demo-store.html          Deterministic checkout test target
│       ├── .env.example             Configuration template
│       ├── package.json
│       ├── tsconfig.json
│       ├── agentqa-report.html      Generated report
│       ├── agentqa-report.json      Generated structured report
│       ├── agentqa-attestation.*    Generated attestation proof
│       └── agentqa-artifacts/       Generated screenshots
│
├── examples/                        Upstream Solari Cookbook examples
│   ├── browser-quickstart-ts/
│   ├── browser-profiles-ts/
│   ├── browser-session-recording-py/
│   ├── browser-stealth-proxy-ts/
│   ├── sandbox-quickstart-ts/
│   ├── sandbox-code-interpreter-py/
│   ├── sandbox-port-preview-ts/
│   └── desktop-computer-use-py/
│
├── LICENSE
└── README.md
```

Generated reports, screenshots, and attestation artifacts are gitignored.

---

## Demo

### The report AgentQA generates

Every run produces a self-contained HTML report containing:

* status
* severity
* confidence
* reproduction rate
* expected behaviour
* actual behaviour
* reproduction steps
* screenshots
* investigator evidence
* verifier evidence
* structured trace
* KeeperHub attestation when enabled

![AgentQA report header: confirmed, high severity, 93% confidence, 3/3 reproduction](docs/media/solari-cookbook/docs/media/Screenshot%202026-09-04%20155543.png)

### Steps and evidence

The report shows the path the investigator actually took, followed by evidence from each independent verification attempt.

![AgentQA report steps and verification evidence](solari-cookbook/docs/media/Screenshot%202026-09-04%20155806.png)

### Investigator vs. verifier

The investigator and verifier approach the defect independently.

| Investigator                       | Verifier                                       |
| ---------------------------------- | ---------------------------------------------- |
| Model-driven exploration           | Deterministic reproduction                     |
| Chooses its own path and test data | Uses controlled verification inputs            |
| Produces a suspected finding       | Determines whether the failure is reproducible |

The separation is important: the model cannot simply declare its own suspicion to be true.

---

## End-to-end workflow

A typical AgentQA + KeeperHub run looks like this:

```text
1. Provision isolated target
        ↓
2. Launch recorded Solari browser
        ↓
3. Autonomous investigation
        ↓
4. Suspected failure
        ↓
5. Three independent verification attempts
        ↓
6. Evidence analysis
        ↓
7. Generate JSON report
        ↓
8. SHA-256 report
        ↓
9. KeeperHub workflow validation
        ↓
10. KeeperHub simulation
        ↓
11. KeeperHub execution
        ↓
12. Sepolia confirmation
        ↓
13. Re-read transaction from chain
        ↓
14. Verify digest
        ↓
15. Render final HTML report
```

This gives the project two separate proofs:

**QA proof**

> The application defect was observed and independently reproduced.

**Integrity proof**

> The generated report corresponds to the bytes whose digest was recorded on-chain.

---

## Example report summary

The bundled demonstration intentionally contains a checkout failure.

|                  |                                  |
| ---------------- | -------------------------------- |
| **Finding**      | Checkout order submission failed |
| **Status**       | Confirmed                        |
| **Severity**     | High                             |
| **Confidence**   | 93%                              |
| **Reproduction** | 3/3                              |

**Expected** — successful order placement followed by an order confirmation.

**Actual** — after clicking **Place Order**, the checkout displayed:

> "Order could not be submitted. Please try again."

The verifier reproduced the same explicit failure three times from fresh state.

---

## Future improvements

* **Multi-flow coverage** — signup, login, search, returns, wallet connection, token approvals, and other workflows driven by mission lists.

* **Dedicated Web3 verification** — wallet-aware verification and explicit on-chain state assertions for dApps.

* **Regression baselines** — persist reports per commit so AgentQA can distinguish new defects from known defects.

* **CI integration** — a GitHub Action that runs AgentQA on pull requests and fails the build on confirmed critical or high findings.

* **Richer verification** — network, console, accessibility, and transaction-level assertions alongside visible UI evidence.

* **Parallel verification** — run independent verification attempts concurrently across browser sessions.

* **Adaptive attempts** — escalate verification when initial attempts are inconclusive.

* **Issue filing** — open a GitHub issue directly from a confirmed report with evidence attached.

* **Persistent attestation history** — maintain a verifiable history of QA reports across application versions and deployments.

* **Developer dashboard** — visualize findings, verification history, transaction attestations, and regression trends.

---

## Credits

This project is built on top of the [Solari Cookbook](https://github.com/solari-sdk/solari-cookbook).

AgentQA is an extension of the original Solari showcase.

Solari resources:

* Docs — [https://docs.getsolari.com](https://docs.getsolari.com)
* Console — [https://console.getsolari.com](https://console.getsolari.com)

---

## License

MIT — see [LICENSE](LICENSE).

```
```