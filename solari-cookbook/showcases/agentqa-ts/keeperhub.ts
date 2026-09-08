/**
 * Optional KeeperHub attestation - binds an AgentQA report to a Sepolia transaction.
 *
 * AgentQA proves a bug with browser evidence. This module proves the *report*
 * was not edited afterwards: it hashes the report bytes and writes that digest
 * into the calldata of a 0.001 test-ETH self-send on Sepolia. Anyone can then
 * recompute sha256 over the published report and compare it against the
 * calldata recorded on chain.
 *
 * A bare value transfer would prove nothing - the tx hash would have no
 * relationship to the report. The digest in calldata is what makes the link
 * verifiable.
 *
 * Every export degrades to a no-op when KEEPERHUB_API_KEY is unset, so AgentQA
 * runs unchanged without KeeperHub configured.
 */
import { createHash } from "node:crypto"

const DEFAULT_BASE_URL = "https://app.keeperhub.com"
const DEFAULT_CHAIN_ID = 11155111
const DEFAULT_AMOUNT_ETH = "0.001"
const DEFAULT_WORKFLOW_NAME = "AgentQA Report Attestation (Sepolia)"
const MCP_PROTOCOL_VERSION = "2025-06-18"
const POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * An EOA accepts any calldata: it is ignored by the EVM, never reverts, and is
 * stored in the transaction permanently. That makes a self-send the cheapest
 * durable place to put a digest, and it needs no deployed contract - KeeperHub
 * has no contract-deploy action, and the signing key lives in KeeperHub rather
 * than locally, so deploying one is not an option.
 *
 * `web3/transfer-funds` has no data field, so the transfer is expressed as a
 * payable "contract call" to the EOA instead. That is the only shape in which
 * KeeperHub will attach calldata to a native-value transaction.
 */
const ATTEST_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "payable",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [],
  },
] as const

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
}

/**
 * Public read-only endpoints, used only to re-read the broadcast transaction.
 * KeeperHub reports what it says it sent; the digest check has to come from the
 * chain itself, or it is just KeeperHub vouching for KeeperHub.
 */
const DEFAULT_RPC_URLS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  84532: "https://base-sepolia-rpc.publicnode.com",
}

const TERMINAL_OK = new Set(["completed", "success"])
const TERMINAL_BAD = new Set(["failed", "error", "system_error", "external_error", "cancelled"])

export class KeeperHubError extends Error {}

export interface KeeperHubConfig {
  apiKey: string
  baseUrl: string
  chainId: number
  amountEth: string
  /** Wallet that signs. Also the recipient, so the transfer is a self-send. */
  walletAddress: string
  recipient: string
  workflowName: string
  timeoutMs: number
  /** Read-only endpoint for the independent digest check. */
  rpcUrl: string
}

export interface AttestationStep {
  node: string
  status: string
  detail?: string
  durationMs?: number
}

/** Result of `validate_workflow`, run before anything is signed. */
export interface WorkflowValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/** Independent re-read of the broadcast transaction's calldata. */
export interface OnChainCheck {
  verified: boolean
  detail: string
  calldata?: string
}

export interface Attestation {
  digest: string
  digestAlgorithm: "sha256"
  attestedBytes: number
  chainId: number
  from: string
  to: string
  amountEth: string
  txHash: string
  explorerUrl: string
  executionId: string
  workflowId: string
  status: string
  validation: WorkflowValidation
  dryRun: { simulated: boolean; wouldRevert: boolean; detail: string }
  onChain: OnChainCheck
  logs: AttestationStep[]
  attestedAt: string
  verifyCommand: string
}

/**
 * Resolve configuration, or null when KeeperHub is not set up. Callers treat
 * null as "skip attestation" rather than as an error - that is what keeps the
 * dependency optional.
 */
export function resolveKeeperHubConfig(): KeeperHubConfig | null {
  const apiKey = process.env.KEEPERHUB_API_KEY?.trim()
  if (!apiKey) return null

  const walletAddress = process.env.KEEPERHUB_WALLET_ADDRESS?.trim()
  if (!walletAddress) {
    throw new KeeperHubError(
      "KEEPERHUB_API_KEY is set but KEEPERHUB_WALLET_ADDRESS is missing. " +
        "Set it to the wallet integration's address, or unset KEEPERHUB_API_KEY to skip attestation.",
    )
  }
  assertAddress(walletAddress, "KEEPERHUB_WALLET_ADDRESS")

  const recipient = process.env.KEEPERHUB_ATTEST_RECIPIENT?.trim() || walletAddress
  assertAddress(recipient, "KEEPERHUB_ATTEST_RECIPIENT")

  const chainId = Number.parseInt(process.env.KEEPERHUB_CHAIN_ID ?? String(DEFAULT_CHAIN_ID), 10)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new KeeperHubError("KEEPERHUB_CHAIN_ID must be a positive integer.")
  }

  const amountEth = (process.env.KEEPERHUB_ATTEST_AMOUNT_ETH ?? DEFAULT_AMOUNT_ETH).trim()
  if (!/^\d+(\.\d+)?$/.test(amountEth)) {
    throw new KeeperHubError("KEEPERHUB_ATTEST_AMOUNT_ETH must be a decimal amount in ether, e.g. 0.001.")
  }

  const timeoutMs = Number.parseInt(process.env.KEEPERHUB_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new KeeperHubError("KEEPERHUB_TIMEOUT_MS must be a positive integer.")
  }

  return {
    apiKey,
    baseUrl: (process.env.KEEPERHUB_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/$/, ""),
    chainId,
    amountEth,
    walletAddress,
    recipient,
    workflowName: process.env.KEEPERHUB_WORKFLOW_NAME?.trim() || DEFAULT_WORKFLOW_NAME,
    timeoutMs,
    rpcUrl: (process.env.KEEPERHUB_RPC_URL ?? DEFAULT_RPC_URLS[chainId] ?? "").trim(),
  }
}

function assertAddress(value: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new KeeperHubError(`${label} must be a 0x-prefixed 20-byte address.`)
  }
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clip(value: string, max = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

/**
 * Minimal MCP-over-HTTP client.
 *
 * KeeperHub exposes a REST API under /api, but its MCP endpoint is the surface
 * whose tool names and argument shapes are published via `tools/list`, so it is
 * the one that can be called without guessing route paths. Swapping to REST
 * means replacing this class and nothing else.
 */
class KeeperHubClient {
  private sessionId?: string
  private initialized = false
  private nextId = 1

  constructor(private readonly config: KeeperHubConfig) {}

  private get endpoint(): string {
    return `${this.config.baseUrl}/mcp`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.config.apiKey}`,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    }
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    return headers
  }

  private async rpc(method: string, params?: unknown, notification = false): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method }
    if (params !== undefined) body.params = params
    if (!notification) body.id = this.nextId++

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      throw new KeeperHubError(`KeeperHub request failed (${method}): ${describeTransportError(error)}`)
    }

    // The server assigns a session on initialize; reuse it for every later call.
    const assigned = response.headers.get("mcp-session-id")
    if (assigned) this.sessionId = assigned

    const text = await response.text()
    if (!response.ok) {
      throw new KeeperHubError(`KeeperHub returned HTTP ${response.status} for ${method}: ${clip(text)}`)
    }
    // Notifications carry no reply; a 202 with an empty body is the success case.
    if (notification) return undefined

    const payload = parseRpcPayload(text)
    if (payload === undefined) {
      throw new KeeperHubError(`KeeperHub returned an unreadable response for ${method}: ${clip(text)}`)
    }
    const envelope = payload as { error?: { message?: string; code?: number }; result?: unknown }
    if (envelope.error) {
      throw new KeeperHubError(
        `KeeperHub rejected ${method}: ${envelope.error.message ?? "unknown error"}` +
          (envelope.error.code ? ` (code ${envelope.error.code})` : ""),
      )
    }
    return envelope.result
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agentqa-attestation", version: "0.1.0" },
    })
    await this.rpc("notifications/initialized", undefined, true)
    this.initialized = true
  }

  /** Call a KeeperHub tool and decode its JSON payload. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized()
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
      structuredContent?: unknown
    }

    const text = result?.content?.find((part) => part?.type === "text")?.text ?? ""
    if (result?.isError) {
      throw new KeeperHubError(`KeeperHub tool ${name} failed: ${clip(text) || "no detail returned"}`)
    }
    if (result?.structuredContent !== undefined) return result.structuredContent as T

    try {
      return JSON.parse(text) as T
    } catch {
      // Some tools answer with prose rather than JSON; hand it back as-is.
      return text as unknown as T
    }
  }
}

/** Unwrap the nested `cause` chain Node attaches to a failed fetch. */
function describeTransportError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    const code = (current as { code?: string }).code
    parts.push(code ? `${current.message} (${code})` : current.message)
    current = current.cause
  }
  return parts.join(" <- ") || String(error)
}

/** Extract the JSON-RPC body from either a plain JSON or an SSE response. */
function parseRpcPayload(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  // Streamable HTTP: take the last `data:` frame, which carries the response.
  let last: unknown
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const chunk = line.slice(5).trim()
    if (!chunk || chunk === "[DONE]") continue
    try {
      last = JSON.parse(chunk)
    } catch {
      // Ignore keep-alive and partial frames.
    }
  }
  return last
}

function explorerTxUrl(chainId: number, txHash: string): string {
  const base = EXPLORERS[chainId]
  return base ? `${base}/tx/${txHash}` : txHash
}

function attestationWorkflowNodes(config: KeeperHubConfig, digest: string) {
  return [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        type: "trigger",
        label: "Trigger",
        // Driven only by execute_workflow; the workflow stays disabled so no
        // schedule or webhook can fire it on its own.
        config: { triggerType: "Manual" },
        status: "idle",
      },
    },
    {
      id: "attest-1",
      type: "action",
      position: { x: 252, y: 0 },
      data: {
        type: "action",
        label: "Attest Report Digest",
        description: "Self-send carrying the report's sha256 digest as calldata",
        config: {
          actionType: "web3/write-contract",
          network: String(config.chainId),
          contractAddress: config.recipient,
          abi: JSON.stringify(ATTEST_ABI),
          abiFunction: "attest",
          functionArgs: JSON.stringify([`0x${digest}`]),
          ethValue: config.amountEth,
        },
        status: "idle",
      },
    },
  ]
}

const ATTESTATION_EDGES = [{ id: "e-trigger-1-attest-1", source: "trigger-1", target: "attest-1" }]

interface WorkflowSummary {
  id: string
  name: string
}

/**
 * Simulate the attestation transaction without signing or broadcasting.
 *
 * `execute_workflow` has no dry-run flag, so the rehearsal goes through the
 * direct-execution path with identical arguments. It proves the chain accepts
 * the call (gas, balance, no revert); it does not exercise the workflow wiring,
 * which `validate_workflow` covers instead.
 */
async function dryRun(client: KeeperHubClient, config: KeeperHubConfig, digest: string): Promise<Attestation["dryRun"]> {
  const result = await client.call<unknown>("execute_contract_call", {
    contract_address: config.recipient,
    chain_id: String(config.chainId),
    function_name: "attest",
    function_args: JSON.stringify([`0x${digest}`]),
    abi: JSON.stringify(ATTEST_ABI),
    value: config.amountEth,
    simulate: true,
  })

  // A non-JSON (prose) response must never count as a passed simulation, and
  // the documented contract is explicit: proceed only on success === true and
  // wouldRevert === false. Anything else stops here, before signing.
  if (typeof result !== "object" || result === null) {
    throw new KeeperHubError(
      `Attestation dry run returned an unreadable response, so nothing was broadcast: ${clip(String(result))}`,
    )
  }

  const record = result as Record<string, unknown>
  const wouldRevert = record.wouldRevert === true
  const detail = clip(
    typeof record.error === "string" && record.error
      ? record.error
      : typeof record.message === "string" && record.message
        ? record.message
        : JSON.stringify(record),
  )

  if (record.success !== true || wouldRevert) {
    throw new KeeperHubError(
      `Attestation dry run failed, so nothing was broadcast: ${detail}. ` +
        `Check that ${config.walletAddress} holds enough native token on chain ${config.chainId} for ${config.amountEth} plus gas.`,
    )
  }
  return { simulated: true, wouldRevert, detail }
}

/** Find the attestation workflow by name, creating it if it does not exist. */
async function ensureWorkflow(client: KeeperHubClient, config: KeeperHubConfig, digest: string): Promise<string> {
  const workflows = await client.call<WorkflowSummary[]>("list_workflows", {})
  const existing = Array.isArray(workflows) ? workflows.find((item) => item?.name === config.workflowName) : undefined

  const nodes = attestationWorkflowNodes(config, digest)

  if (existing?.id) {
    // The digest is baked into node config, so it is rewritten per report.
    await client.call("update_workflow", {
      workflowId: existing.id,
      nodes,
      edges: ATTESTATION_EDGES,
      enabled: false,
    })
    return existing.id
  }

  const created = await client.call<{ id?: string }>("create_workflow", {
    name: config.workflowName,
    description:
      "Writes the sha256 digest of an AgentQA report into the calldata of a self-send, making the report tamper-evident.",
    nodes,
    edges: ATTESTATION_EDGES,
    enabled: false,
  })
  if (!created?.id) {
    throw new KeeperHubError("KeeperHub did not return a workflow id from create_workflow.")
  }
  return created.id
}

/**
 * Structural and Web3 validation of the workflow, before anything is signed.
 *
 * `deepCheck` also bytecode-matches the ABI against the target address, which
 * matters here in an unusual way: the target is a plain EOA with no bytecode,
 * so a mismatch is *expected*. KeeperHub reports those as warnings rather than
 * errors, which is why warnings are surfaced but only errors are fatal.
 */
async function validateWorkflow(client: KeeperHubClient, workflowId: string): Promise<WorkflowValidation> {
  const raw = await client.call<unknown>("validate_workflow", { workflowId, deepCheck: true })
  const result = unwrapResult(raw)
  if (typeof result !== "object" || result === null) {
    throw new KeeperHubError(`validate_workflow returned an unreadable response: ${clip(String(raw))}`)
  }

  const record = result as Record<string, unknown>
  const errors = describeIssues(record.errors)
  const warnings = describeIssues(record.warnings)

  if (record.valid !== true || errors.length > 0) {
    throw new KeeperHubError(
      `Workflow ${workflowId} failed validation, so nothing was broadcast: ` +
        (errors.join("; ") || clip(JSON.stringify(record))),
    )
  }
  return { valid: true, errors, warnings }
}

/** Tools answer either bare or wrapped in an `{ ok, result }` envelope. */
function unwrapResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  return "result" in record && typeof record.result === "object" && record.result !== null ? record.result : record
}

/** Flatten `{ code, message, parameterPath }` issues into readable lines. */
function describeIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === "string") return clip(item)
    const issue = (item ?? {}) as Record<string, unknown>
    const code = typeof issue.code === "string" ? `[${issue.code}] ` : ""
    const path = typeof issue.parameterPath === "string" ? ` at ${issue.parameterPath}` : ""
    return clip(`${code}${issue.message ?? JSON.stringify(issue)}${path}`)
  })
}

/**
 * Re-read the broadcast transaction from a public node and confirm its calldata
 * ends with the digest.
 *
 * Without this the proof rests on KeeperHub's own account of what it sent. A
 * mismatch is fatal: an attestation pointing at the wrong bytes is worse than
 * no attestation, because it still looks like proof. An unreachable RPC is not
 * fatal - it leaves the claim unverified rather than asserting something false.
 */
async function verifyOnChain(
  chainId: number,
  rpcUrl: string,
  txHash: string,
  digest: string,
): Promise<OnChainCheck> {
  const unchecked = (reason: string): OnChainCheck => ({
    verified: false,
    detail: `${reason}; the digest was not independently checked.`,
  })
  if (!rpcUrl) return unchecked(`No RPC endpoint known for chain ${chainId}`)

  let input: string
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [txHash] }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return unchecked(`RPC returned HTTP ${response.status}`)

    const payload = (await response.json()) as {
      result?: { input?: string } | null
      error?: { message?: string }
    }
    if (payload.error) return unchecked(`RPC error: ${clip(payload.error.message ?? "unknown")}`)

    const candidate = payload.result?.input
    if (typeof candidate !== "string") return unchecked("RPC returned no calldata for that transaction")
    input = candidate
  } catch (error) {
    return unchecked(`RPC unreachable (${describeTransportError(error)})`)
  }

  const normalized = input.toLowerCase()
  const calldata = normalized.startsWith("0x") ? normalized : `0x${normalized}`
  if (!calldata.endsWith(digest.toLowerCase())) {
    throw new KeeperHubError(
      `Transaction ${txHash} does not carry the report digest. Expected calldata ending in ${digest}, ` +
        `got ${clip(calldata, 200)}. The attestation is void - do not publish it.`,
    )
  }
  return {
    verified: true,
    detail: `Calldata re-read from chain ${chainId} ends with the report digest.`,
    calldata,
  }
}

interface ExecutionLogEntry {
  nodeId?: string
  nodeName?: string
  status?: string
  error?: string
  /** KeeperHub sends this as a numeric string, not a number. */
  duration?: number | string
  output?: Record<string, unknown>
}

interface ExecutionResponse {
  status?: { status?: string; error?: string } | string
  /**
   * Shape varies: an array of entries, an object nesting one under `logs`, or
   * an object keyed by node id. `logEntries` normalizes all three.
   */
  logs?: unknown
}

/** Candidate keys under which a log array may be nested. */
const LOG_ARRAY_KEYS = ["logs", "entries", "steps", "nodes", "items"]

/**
 * Normalize whatever `get_execution` returned into a list of log entries.
 *
 * KeeperHub documents this field as a "logs sub-object" in one place and
 * iterates it as an array in another, so the shape is not something to assume.
 */
function logEntries(response: ExecutionResponse): ExecutionLogEntry[] {
  const raw: unknown = response?.logs
  if (Array.isArray(raw)) return raw as ExecutionLogEntry[]
  if (typeof raw !== "object" || raw === null) return []

  const record = raw as Record<string, unknown>
  for (const key of LOG_ARRAY_KEYS) {
    if (Array.isArray(record[key])) return record[key] as ExecutionLogEntry[]
  }
  // Keyed by node id: the values are the entries. Carry the key across as
  // nodeId so a step still has a name when the entry itself omits one.
  return Object.entries(record)
    .filter(([, value]) => typeof value === "object" && value !== null && !Array.isArray(value))
    .map(([key, value]) => ({ nodeId: key, ...(value as ExecutionLogEntry) }))
}

function collectLogError(response: ExecutionResponse): string | undefined {
  const fromStatus = typeof response?.status === "object" ? response.status?.error : undefined
  if (fromStatus) return fromStatus
  return logEntries(response).find((entry) => entry?.error)?.error
}

function toSteps(response: ExecutionResponse): AttestationStep[] {
  return logEntries(response).map((entry) => ({
    node: entry?.nodeName ?? entry?.nodeId ?? "step",
    status: entry?.status ?? "unknown",
    detail: entry?.error ? clip(entry.error) : undefined,
    durationMs: toMillis(entry?.duration),
  }))
}

/** Accept both `16403` and `"16403"`; KeeperHub returns the latter. */
function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const TX_HASH_KEY_RE = /(^|_|\b)(tx|transaction)_?hash(es)?$|^hash$/i

/**
 * Find the transaction hash anywhere in the execution response.
 *
 * KeeperHub surfaces it in more than one place depending on the action -
 * `output.transactionHash`, or a `transactionHashes[]` array carrying receipt
 * status - so this walks the response instead of guessing a path again.
 *
 * The digest is also 32 bytes of hex, and it appears in this response as
 * calldata, so it is excluded explicitly: matching it would report the payload
 * as though it were the transaction that carried it.
 */
function findTxHash(response: unknown, digest: string): { txHash?: string; chainId?: number } {
  const excluded = `0x${digest.toLowerCase()}`
  let fallback: string | undefined
  let chainId: number | undefined

  const visit = (value: unknown, key: string): string | undefined => {
    if (typeof value === "string") {
      if (!TX_HASH_RE.test(value) || value.toLowerCase() === excluded) return undefined
      if (TX_HASH_KEY_RE.test(key)) return value
      // Right shape but an unrecognized key; keep it only as a last resort.
      fallback ??= value
      return undefined
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, key)
        if (found) return found
      }
      return undefined
    }
    if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(value)) {
        if (/^chain_?id$/i.test(childKey)) {
          const parsed = typeof child === "number" ? child : Number.parseInt(String(child ?? ""), 10)
          if (Number.isInteger(parsed) && parsed > 0) chainId ??= parsed
        }
        const found = visit(child, childKey)
        if (found) return found
      }
    }
    return undefined
  }

  return { txHash: visit(response, "") ?? fallback, chainId }
}

function statusOf(response: ExecutionResponse): string {
  if (typeof response?.status === "string") return response.status
  return response?.status?.status ?? "unknown"
}

/**
 * Poll until the execution reaches a terminal state.
 *
 * `unconfirmed` means the transaction is on chain but not yet confirmed - it is
 * not a failure and must never trigger a re-send, which would move the funds
 * twice.
 */
async function waitForExecution(
  client: KeeperHubClient,
  executionId: string,
  timeoutMs: number,
): Promise<ExecutionResponse> {
  const deadline = Date.now() + timeoutMs
  let last: ExecutionResponse = {}

  while (Date.now() < deadline) {
    last = await client.call<ExecutionResponse>("get_execution", { executionId })
    const status = statusOf(last).toLowerCase()
    if (TERMINAL_OK.has(status)) return last
    if (TERMINAL_BAD.has(status)) {
      const detail = collectLogError(last) ?? "no error detail returned"
      throw new KeeperHubError(`Attestation execution ${executionId} ended as ${status}: ${clip(detail)}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new KeeperHubError(
    `Attestation execution ${executionId} did not reach a terminal state within ${Math.round(timeoutMs / 1000)}s ` +
      `(last status: ${statusOf(last)}). The transaction may still land - check KeeperHub rather than re-running.`,
  )
}

function toBuffer(bytes: Buffer | string): Buffer {
  return typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes
}

export interface DryRunReport {
  digest: string
  attestedBytes: number
  dryRun: Attestation["dryRun"]
}

/**
 * Simulate the attestation and stop. Nothing is signed or broadcast, so this is
 * safe to run repeatedly. Returns null when KeeperHub is not configured.
 */
export async function dryRunAttestation(
  bytes: Buffer | string,
  config = resolveKeeperHubConfig(),
): Promise<DryRunReport | null> {
  if (!config) return null
  const payload = toBuffer(bytes)
  const digest = sha256Hex(payload)
  const result = await dryRun(new KeeperHubClient(config), config, digest)
  return { digest, attestedBytes: payload.byteLength, dryRun: result }
}

/**
 * Attest `bytes` on chain and return the proof, or null when KeeperHub is not
 * configured. Throws only when KeeperHub is configured but unusable, so a
 * misconfiguration is loud rather than silently skipped.
 */
export async function attest(
  bytes: Buffer | string,
  config = resolveKeeperHubConfig(),
  options: { verifyCommand?: string } = {},
): Promise<Attestation | null> {
  if (!config) return null

  const payload = toBuffer(bytes)
  const digest = sha256Hex(payload)
  const client = new KeeperHubClient(config)

  console.log(`keeperhub: attesting sha256 ${digest.slice(0, 16)}... (${payload.byteLength} bytes)`)

  const workflowId = await ensureWorkflow(client, config, digest)
  console.log(`keeperhub: workflow ${workflowId}`)

  // Validate the wiring before the chain is touched, then simulate before
  // anything is signed. Both gates are cheap; broadcasting is not.
  const validation = await validateWorkflow(client, workflowId)
  console.log(
    `keeperhub: validation passed${validation.warnings.length ? ` (${validation.warnings.length} warning(s))` : ""}`,
  )

  const dryRunResult = await dryRun(client, config, digest)
  console.log("keeperhub: dry run passed, broadcasting")

  const triggered = await client.call<{ executionId?: string }>("execute_workflow", {
    workflowId,
    // Keyed on the digest: re-attesting an identical report returns the original
    // execution instead of paying twice.
    idempotency_key: `agentqa-attest-${digest.slice(0, 32)}`,
  })
  const executionId = triggered?.executionId
  if (!executionId) {
    throw new KeeperHubError("KeeperHub did not return an executionId from execute_workflow.")
  }
  // Print it before polling: if anything downstream fails, the id is what makes
  // the broadcast recoverable instead of orphaned.
  console.log(`keeperhub: execution ${executionId}, polling for a receipt`)

  const execution = await waitForExecution(client, executionId, config.timeoutMs)

  // The response shape has already surprised us once; make it inspectable
  // rather than something to re-guess from a stack trace.
  if (process.env.KEEPERHUB_DEBUG) {
    console.log(`keeperhub: raw get_execution response\n${JSON.stringify(execution, null, 2)}`)
  }

  const { txHash, chainId } = findTxHash(execution, digest)
  if (!txHash) {
    throw new KeeperHubError(
      `Attestation execution ${executionId} completed without reporting a transaction hash, so nothing can be verified. ` +
        "Re-run with KEEPERHUB_DEBUG=1 to dump the response.",
    )
  }

  const effectiveChainId = chainId ?? config.chainId
  const rpcUrl = process.env.KEEPERHUB_RPC_URL?.trim() || DEFAULT_RPC_URLS[effectiveChainId] || config.rpcUrl
  const onChain = await verifyOnChain(effectiveChainId, rpcUrl, txHash, digest)
  console.log(`keeperhub: ${onChain.verified ? "digest confirmed on chain" : `digest unverified - ${onChain.detail}`}`)

  return {
    digest,
    digestAlgorithm: "sha256",
    attestedBytes: payload.byteLength,
    chainId: effectiveChainId,
    from: config.walletAddress,
    to: config.recipient,
    amountEth: config.amountEth,
    txHash,
    explorerUrl: explorerTxUrl(effectiveChainId, txHash),
    executionId,
    workflowId,
    status: statusOf(execution),
    validation,
    dryRun: dryRunResult,
    onChain,
    logs: toSteps(execution),
    attestedAt: new Date().toISOString(),
    verifyCommand: options.verifyCommand ?? "sha256sum agentqa-report.html",
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/**
 * Render the attestation as an HTML fragment, or "" when there is nothing to
 * show. Every value is escaped: a transaction hash, status string, or node
 * error is remote input just like page text is.
 */
export function renderAttestationSection(attestation: Attestation | null): string {
  if (!attestation) return ""

  const logRows =
    attestation.logs
      .map(
        (step) => `<tr>
        <td>${escapeHtml(step.node)}</td>
        <td>${escapeHtml(step.status)}</td>
        <td>${escapeHtml(step.durationMs === undefined ? "" : `${step.durationMs} ms`)}</td>
        <td>${escapeHtml(step.detail ?? "")}</td>
      </tr>`,
      )
      .join("\n") || '<tr><td colspan="4" class="muted">No step logs returned.</td></tr>'

  return `
    <section>
      <h2>On-chain attestation</h2>
      <p class="muted">
        The sha256 digest below is recorded in this transaction's calldata. Recompute it over the
        report file and compare: if the two match, the report has not been altered since it was
        attested. The transfer itself is incidental - the digest is the proof.
      </p>
      <table>
        <tbody>
          <tr><th>Report digest (sha256)</th><td><code>${escapeHtml(attestation.digest)}</code></td></tr>
          <tr><th>Attested bytes</th><td>${escapeHtml(attestation.attestedBytes)}</td></tr>
          <tr><th>Transaction</th><td><a href="${escapeHtml(attestation.explorerUrl)}"><code>${escapeHtml(attestation.txHash)}</code></a></td></tr>
          <tr><th>Chain</th><td>${escapeHtml(attestation.chainId)}</td></tr>
          <tr><th>From &rarr; to</th><td><code>${escapeHtml(attestation.from)}</code> &rarr; <code>${escapeHtml(attestation.to)}</code> (${escapeHtml(attestation.amountEth)} ETH)</td></tr>
          <tr><th>Execution ID</th><td><code>${escapeHtml(attestation.executionId)}</code></td></tr>
          <tr><th>Workflow ID</th><td><code>${escapeHtml(attestation.workflowId)}</code></td></tr>
          <tr><th>Status</th><td>${escapeHtml(attestation.status)}</td></tr>
          <tr><th>Workflow validation</th><td>${escapeHtml(
            attestation.validation.warnings.length
              ? `passed (${attestation.validation.warnings.length} warning(s): ${attestation.validation.warnings.join("; ")})`
              : "passed",
          )}</td></tr>
          <tr><th>Dry run</th><td>${escapeHtml(attestation.dryRun.wouldRevert ? "would revert" : "passed, no revert")}</td></tr>
          <tr><th>On-chain digest check</th><td>${escapeHtml(
            attestation.onChain.verified ? `confirmed - ${attestation.onChain.detail}` : `not confirmed - ${attestation.onChain.detail}`,
          )}</td></tr>
          <tr><th>Attested at</th><td>${escapeHtml(attestation.attestedAt)}</td></tr>
          <tr><th>Verify with</th><td><code>${escapeHtml(attestation.verifyCommand)}</code></td></tr>
        </tbody>
      </table>
      <h3>Execution log</h3>
      <table>
        <thead><tr><th>Node</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </section>`
}

/** Standalone attestation page, for use when the main report is left untouched. */
export function renderAttestationDocument(attestation: Attestation): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Report attestation - AgentQA</title>
  <style>
    :root { color-scheme: light; --ink: #172026; --muted: #60707c; --line: #d8e0e6; --bg: #f5f7f8; --panel: #ffffff; --accent: #0f766e; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.5; }
    header { background: #102023; color: white; padding: 32px 20px; }
    main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 38px); }
    h2 { margin: 28px 0 12px; font-size: 22px; }
    h3 { margin: 20px 0 8px; font-size: 17px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .muted { color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-top: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; word-break: break-word; }
    th { color: var(--muted); font-weight: 700; width: 210px; }
    a { color: #0f5f59; }
    code { background: #edf2f4; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <div style="max-width:1080px;margin:0 auto;">
      <h1>Report attestation</h1>
      <p class="muted" style="color:#c4d0d5;">Cryptographic binding between an AgentQA report and a Sepolia transaction.</p>
    </div>
  </header>
  <main>${renderAttestationSection(attestation)}</main>
</body>
</html>`
}
