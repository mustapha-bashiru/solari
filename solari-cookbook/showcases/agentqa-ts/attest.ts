/**
 * Attest an AgentQA report on Sepolia.
 *
 * Runs after `npm start`, against the report it produced:
 *
 *   npm run attest -- --dry-run    simulate only, nothing is broadcast
 *   npm run attest                 simulate, then broadcast and poll
 *
 * The report file is never modified, so the digest recorded on chain always
 * matches the bytes a reader can download and hash. The proof is written
 * alongside it as agentqa-attestation.json / .html.
 */
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  KeeperHubError,
  attest,
  dryRunAttestation,
  renderAttestationDocument,
  resolveKeeperHubConfig,
  sha256Hex,
} from "./keeperhub.ts"

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPORT = join(EXAMPLE_DIR, "agentqa-report.html")
const ATTESTATION_JSON = join(EXAMPLE_DIR, "agentqa-attestation.json")
const ATTESTATION_HTML = join(EXAMPLE_DIR, "agentqa-attestation.html")

async function loadDotEnv(): Promise<void> {
  try {
    const envText = await readFile(join(EXAMPLE_DIR, ".env"), "utf8")
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
      if (!match) continue
      const [, key, rawValue] = match
      if (process.env[key]) continue
      process.env[key] = rawValue.replace(/^["']|["']$/g, "")
    }
  } catch {
    // A .env file is optional; explicit environment variables work as well.
  }
}

async function main(): Promise<void> {
  await loadDotEnv()

  const args = process.argv.slice(2)
  const dryRunOnly = args.includes("--dry-run")
  const reportPath = resolve(args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_REPORT)

  const config = resolveKeeperHubConfig()
  if (!config) {
    console.log("keeperhub: KEEPERHUB_API_KEY is not set, nothing to attest. See .env.example.")
    return
  }

  let bytes: Buffer
  try {
    bytes = await readFile(reportPath)
  } catch {
    throw new KeeperHubError(`No report at ${reportPath}. Run \`npm start\` first, or pass a path.`)
  }

  console.log(`report:  ${reportPath}`)
  console.log(`digest:  sha256 ${sha256Hex(bytes)}`)
  console.log(`chain:   ${config.chainId}`)
  console.log(`wallet:  ${config.walletAddress} -> ${config.recipient} (${config.amountEth} ETH)`)

  if (dryRunOnly) {
    const result = await dryRunAttestation(bytes, config)
    if (!result) return
    console.log()
    console.log(`dry run:   ${result.dryRun.wouldRevert ? "would revert" : "passed, no revert"}`)
    console.log(`detail:    ${result.dryRun.detail}`)
    console.log("nothing was broadcast; re-run without --dry-run to attest")
    return
  }

  const attestation = await attest(bytes, config)
  if (!attestation) return

  await writeFile(ATTESTATION_JSON, `${JSON.stringify(attestation, null, 2)}\n`, "utf8")
  await writeFile(ATTESTATION_HTML, renderAttestationDocument(attestation), "utf8")

  console.log()
  console.log(`tx:        ${attestation.txHash}`)
  console.log(`explorer:  ${attestation.explorerUrl}`)
  console.log(`execution: ${attestation.executionId}`)
  console.log(`workflow:  ${attestation.workflowId}`)
  console.log(`status:    ${attestation.status}`)
  console.log(`validated: passed${attestation.validation.warnings.length ? ` (${attestation.validation.warnings.length} warning(s))` : ""}`)
  for (const warning of attestation.validation.warnings) {
    console.log(`  warn:    ${warning}`)
  }
  console.log(`on-chain:  ${attestation.onChain.verified ? "digest confirmed" : "NOT confirmed"} - ${attestation.onChain.detail}`)
  if (attestation.onChain.calldata) {
    console.log(`calldata:  ${attestation.onChain.calldata}`)
  }

  console.log()
  console.log("per-node logs:")
  if (attestation.logs.length === 0) {
    console.log("  (none returned)")
  }
  for (const step of attestation.logs) {
    const duration = step.durationMs === undefined ? "" : ` ${step.durationMs}ms`
    console.log(`  ${step.node}: ${step.status}${duration}${step.detail ? ` - ${step.detail}` : ""}`)
  }

  console.log()
  console.log(`proof:     ${ATTESTATION_JSON}`)
  console.log(`page:      ${ATTESTATION_HTML}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
