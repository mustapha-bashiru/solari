# KeeperHub Blockchain Action for Solari AgentQA

## Goal

Keep AgentQA as Solari's autonomous browser QA capability and add one focused
KeeperHub action flow for the hackathon:

```text
User -> Solari / AgentQA
          |
          v
browser investigation -> deterministic verification
          |
          v
confirmed checkout failure + fixed transfer preview
          |
          v
explicit user approval
          |
          v
KeeperHub dry run / simulation
          |
          v
KeeperHub workflow execution
          |
          v
Ethereum Sepolia testnet transfer
          |
          v
AgentQA report: execution ID + tx hash + audit logs
```

This creates the story judges need: Solari investigates and decides when an
authorized action is relevant, while KeeperHub remains the deterministic,
auditable execution layer. The ETH transfer is a separate approved testnet
demonstration; it does not claim to fix the checkout bug.

## Repository Findings

- The checkout contains `solari-cookbook`, not a React/FastAPI Solari app.
- The existing showcase is `solari-cookbook/showcases/agentqa-ts/index.ts`.
- AgentQA already performs browser exploration, deterministic verification, and
  evidence-backed report generation.
- It currently has no blockchain execution capability.
- Cookbook patterns relevant to this work are environment-based credentials,
  bounded operations, and explicit async cleanup.
- No KeeperHub or Aave workflow files are present in this checkout. Existing
  workflows in the remote KeeperHub account must still be treated as protected.

## Decisions

- Preserve AgentQA's core investigator, verifier, evidence, and report flow.
- Do not create the previously proposed standalone React/FastAPI scaffold yet.
- First prove the workflow independently through the currently connected
  KeeperHub MCP; then add the smallest AgentQA/report integration.
- Inspect the actual MCP tool catalog and input/output schemas before every
  operation. Do not invent tool names or arguments from REST documentation.
- Use Ethereum Sepolia, chain ID `11155111`.
- Use KeeperHub's organization Turnkey wallet as sender and a separate public
  test wallet as recipient. Solari must never handle a private key, seed phrase,
  or wallet share.
- Create a new Manual-trigger workflow. Do not modify or duplicate Aave samples.
- Require explicit user approval after a confirmed AgentQA finding and before
  the dry run.
- Use fixed, server/configured demo values for recipient and amount. The agent,
  browser page, and user prompt cannot select arbitrary transfer parameters.
  Validate `KEEPERHUB_DEMO_RECIPIENT` and `KEEPERHUB_DEMO_AMOUNT_ETH` at startup
  and show the exact values in the approval preview.
- Broadcast only after dry run/simulation reports success and no predicted
  revert. Treat an unconfirmed receipt as unconfirmed, not successful.

## Ordered Tasks

### 1. Inspect connected KeeperHub MCP tools

Before making a write:

1. Inspect the connected KeeperHub MCP server and list its available tools.
2. Read schemas for workflow listing, workflow creation, workflow execution,
   dry run/simulation, status/wait, and execution logs.
3. Record exact tool names, required inputs, auth context, and result envelopes.
4. Determine whether simulation exists for workflow execution or only for direct
   transfer execution. If workflow simulation is unavailable, do not silently
   broadcast; report the limitation and use only a documented equivalent
   preflight if explicitly accepted.

Distinguish observed MCP facts from assumptions based on public REST docs.

### 2. Inspect workflows without changing samples

1. Use the read-only workflow catalog/list tool.
2. Identify Aave samples and leave them untouched.
3. Check for an existing workflow named `Solari Sepolia Test ETH Transfer`.
4. Reuse it only if it is clearly the dedicated Solari workflow, targets Sepolia,
   and contains no unsafe extra actions. Otherwise select a unique name.

### 3. Create the dedicated workflow

Create exactly this graph using the observed MCP schema:

```text
Manual trigger -> native ETH transfer
```

The workflow must have a Solari-specific name/description, fixed network
`11155111`, native ETH transfer action, and no schedule, webhook, Aave, swap,
condition, or notification node. Use trigger inputs only as permitted by the
actual schema, while keeping network and action type fixed.

Read the saved workflow back and verify its ID, node graph, and network. If MCP
creation rejects the shape, stop and report the exact error rather than guessing.

### 4. Prepare and document test wallets

1. Determine the KeeperHub organization wallet address for Sepolia.
2. Fund it with a small amount of Sepolia ETH. Gas sponsorship, if available,
   does not fund the ETH value being sent.
3. Create/select a separate recipient test wallet.
4. Use only its public address and configure it as the fixed demo recipient.
5. Choose a tiny configured amount, such as `0.001` ETH, subject to balance.

Do not put secrets in prompts, workflow inputs, logs, or files.

### 5. Prove dry run before broadcast

Run the exact observed simulation tool/schema with the fixed recipient, amount,
and Sepolia network. Require a positive success result and explicit no-revert
outcome. Capture sender, recipient, value, gas estimate, and warnings. If it
fails, stop without broadcasting and diagnose the returned balance/address/
workflow error.

State in the report whether this was workflow-level simulation or a documented
direct-transfer preflight.

### 6. Execute and collect proof

After simulation succeeds:

1. Invoke the workflow with a fresh idempotency key if supported.
2. Record workflow ID, execution ID, and initial status.
3. Wait/poll using the MCP interval or completion signal with a bounded timeout.
4. Require terminal success and receipt verification.
5. Retrieve execution details and logs.
6. Capture node IDs/names/types/statuses, resolved non-secret inputs, outputs,
   errors, timestamps, duration, gas, verification fields, retry information,
   and every canonical transaction hash.
7. Verify the hash on Sepolia Etherscan against sender, recipient, value, block,
   and receipt status.

For failures, preserve audit context but do not claim on-chain success. Never
infer a canonical hash from an untrusted log field when the canonical result is
empty.

### 7. Integrate the action at the AgentQA boundary

After the independent transaction succeeds, inspect `index.ts` and connect the
action only after the verifier returns a confirmed checkout finding and before
the final report is rendered. Do not change the investigator's browser tools or
the verifier's deterministic acceptance rules.

Add a small optional action phase with these states:

`not_requested` -> `awaiting_approval` -> `simulated` -> `executed` ->
`confirmed`, with `failed` and `unconfirmed` terminal alternatives.

The approval prompt must show the confirmed finding summary, purpose, fixed
recipient, amount, Sepolia network, and the fact that KeeperHub's organization
wallet will send the funds. Reject/no approval must produce a normal report
with no blockchain action.

The action result becomes a separate report section containing execution ID,
transaction hash/link, status, and KeeperHub audit logs. Clearly state that the
transfer demonstrates delegated execution and is not a repair of the checkout
failure.

### 8. Decide the next production integration

Based on the actual AgentQA runtime boundary, recommend MCP or REST for a later
Solari backend integration. The recommendation must cover:

- structured action request: purpose, recipient, amount, chain, finding ID,
  session/correlation ID
- approval and policy location
- secret custody and authentication
- status delivery and report/UI rendering
- persistence and idempotency requirements

Do not build React, FastAPI, persistence, or background execution in this phase.

## Acceptance Criteria

- AgentQA source and behavior remain intact except for the minimal optional
  post-verification action/report hook.
- Existing KeeperHub Aave samples are unchanged.
- A new Solari-specific Manual workflow targets Sepolia and transfers native ETH.
- MCP schemas were inspected before writes.
- Dry run succeeded before broadcast.
- One real Sepolia transaction completed with verified receipt.
- Final AgentQA report includes finding evidence plus separate KeeperHub proof:
  execution ID, transaction hash/link, status, and audit logs.
- No execution occurs without explicit approval.
- Recipient and amount come only from validated fixed configuration.
- No credentials or private wallet material are exposed or committed.
- The final report recommends the exact next integration boundary and MCP/REST
  choice.

## Validation

- Run the unchanged AgentQA type/build check before and after the hook.
- Exercise rejection/no-approval and confirm no MCP write occurs.
- Exercise simulation failure and confirm no broadcast occurs.
- Exercise execution failure/unconfirmed receipt and confirm honest report state.
- Exercise successful flow and verify all audit fields render safely.
- Inspect `git diff` to confirm no unrelated showcase or workflow changes.
- Verify no `.env`, API key, private key, or generated secret artifact is tracked.

## Out of Scope

- Automatic execution after a finding.
- User-entered arbitrary transfer values.
- Mainnet or non-Sepolia execution.
- React dashboard, FastAPI service, database, authentication, queue/workers,
  webhooks, websocket progress, token swaps, payments, staking, and production
  wallet/account management.

## Deliverable

Return a concise build report with observed MCP tools/schemas, workflow name and
ID, graph/network, simulation result, execution ID/status, verified Sepolia hash
and link, audit-trail fields/log entries, confirmation that AgentQA and Aave
samples were preserved, and the recommended next Solari integration point.
