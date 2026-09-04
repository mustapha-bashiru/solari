/**
 * AgentQA - an evidence-backed checkout QA agent using Solari.
 *
 * The model drives browser exploration through bounded tools. Deterministic
 * verification decides whether a suspected checkout defect is reportable.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserSession, Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url))
const DEMO_STORE_FILE = join(EXAMPLE_DIR, "demo-store.html")
const REPORT_FILE = join(EXAMPLE_DIR, "agentqa-report.html")
const ARTIFACT_DIR = join(EXAMPLE_DIR, "agentqa-artifacts")
const TARGET_PORT = 8000
const DEFAULT_MODEL = "gpt-4.1-mini"
const DEFAULT_MISSION = "Test checkout as a first-time customer."
const VERIFICATION_ATTEMPTS = 3
const RECORDING_FLUSH_MS = 2000
const CHAT_MAX_ATTEMPTS = 3
const CONFIRMATION_PATTERN = /order confirmed|thank you|order number/i
const SUBMISSION_ERROR_PATTERN = /order could not be submitted|unable to (?:place|submit) (?:the )?order/i

type Severity = "critical" | "high" | "medium" | "low" | "info"
type Page = Awaited<ReturnType<BrowserSession["newPage"]>>

interface Config {
  solariApiKey: string
  openaiApiKey: string
  openaiBaseUrl: string
  openaiModel: string
  providerHeaders: Record<string, string>
  targetUrl?: string
  mission: string
  maxTurns: number
  maxActions: number
}

interface TraceEntry {
  phase: "investigator" | "verifier" | "analysis"
  timestamp: string
  action: string
  result: string
  url?: string
  title?: string
  visibleText?: string
  screenshotPath?: string
}

interface SuspectedFinding {
  title: string
  severity: Severity
  expected: string
  actual: string
  steps: string[]
  rationale: string
}

interface VerificationAttempt {
  attempt: number
  outcome: "confirmed_failure" | "checkout_succeeded" | "inconclusive"
  observation: string
  screenshotPath?: string
}

interface PostSubmitInspection {
  outcome: VerificationAttempt["outcome"]
  observation: string
  screenshotPath?: string
}

interface AnalysisResult {
  confidence: number
  reproductionRate: string
  reproducible: boolean
  verifierSummary: string
}

interface Report {
  title: string
  severity: Severity
  confidence: number
  reproducible: boolean
  reproductionRate: string
  targetUrl: string
  sessionId: string
  replayUrl?: string
  replayStatus: string
  steps: Array<{ action: string; observation: string }>
  expected: string
  actual: string
  evidence: Array<{ label: string; value: string; screenshotSrc?: string }>
  investigatorSummary: string
  verifierSummary: string
  trace: TraceEntry[]
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ChatResponse {
  choices?: Array<{
    message?: ChatMessage
  }>
}

interface BrowserToolContext {
  phase: TraceEntry["phase"]
  page: Page
  trace: TraceEntry[]
  actionsUsed: number
  maxActions: number
}

class AgentQaError extends Error {}

/**
 * Unrecoverable: the recorded session is gone, so no later tool call can succeed.
 * Kept distinct from AgentQaError so the investigator loop stops instead of
 * feeding the failure back to the model and burning its whole turn budget.
 */
class BrowserGoneError extends AgentQaError {}

const BROWSER_GONE_PATTERN = /Target (?:page, context or browser has been closed|closed)|browser has been closed|Session closed/i

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

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AgentQaError(`${name} must be a positive integer.`)
  }
  return parsed
}

async function requireConfig(): Promise<Config> {
  await loadDotEnv()

  const solariApiKey = process.env.SOLARI_API_KEY?.trim()
  const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim().replace(/\/$/, "")
  const openaiApiKey = (process.env.OPENAI_API_KEY ?? "").trim()
  if (!solariApiKey) throw new AgentQaError("SOLARI_API_KEY is required. See .env.example.")
  if (!openaiApiKey) throw new AgentQaError("OPENAI_API_KEY is required. See .env.example.")

  const targetUrl = process.env.TARGET_URL?.trim()
  if (targetUrl) validateHttpUrl(targetUrl, "TARGET_URL")
  validateProviderConfig(openaiBaseUrl, openaiApiKey)

  return {
    solariApiKey,
    openaiApiKey,
    openaiBaseUrl,
    openaiModel: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    providerHeaders: providerHeadersFor(openaiBaseUrl),
    targetUrl,
    mission: process.env.AGENTQA_MISSION ?? DEFAULT_MISSION,
    maxTurns: parsePositiveInt(process.env.AGENTQA_MAX_TURNS, 12, "AGENTQA_MAX_TURNS"),
    maxActions: parsePositiveInt(process.env.AGENTQA_MAX_ACTIONS, 24, "AGENTQA_MAX_ACTIONS"),
  }
}

function validateProviderConfig(baseUrl: string, apiKey: string): void {
  const host = new URL(baseUrl).hostname
  if (host.endsWith("openrouter.ai") && !apiKey.startsWith("sk-or-")) {
    throw new AgentQaError(
      "OPENAI_BASE_URL points to OpenRouter, so OPENAI_API_KEY must be an OpenRouter API key. " +
        "Use a key that starts with sk-or-..., or switch OPENAI_BASE_URL to https://api.openai.com/v1 for an OpenAI key.",
    )
  }
}

function providerHeadersFor(baseUrl: string): Record<string, string> {
  const host = new URL(baseUrl).hostname
  if (!host.endsWith("openrouter.ai")) return {}
  return {
    "HTTP-Referer": "https://getsolari.com",
    "X-Title": "AgentQA",
  }
}

function validateHttpUrl(value: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AgentQaError(`${label} must be a valid URL.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgentQaError(`${label} must use http or https.`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clip(value: string, max = 1800): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

async function captureState(page: Page): Promise<{ url: string; title: string; visibleText: string }> {
  const [title, visibleText] = await Promise.all([
    page.title().catch(() => "Untitled"),
    page.locator("body").innerText({ timeout: 2000 }).catch(() => ""),
  ])
  return { url: page.url(), title: title.trim() || "Untitled", visibleText: clip(visibleText) }
}

async function traceAction(
  phase: TraceEntry["phase"],
  page: Page,
  trace: TraceEntry[],
  action: string,
  result: string,
  screenshotPath?: string,
): Promise<void> {
  const state = await captureState(page)
  trace.push({
    phase,
    timestamp: new Date().toISOString(),
    action,
    result,
    ...state,
    screenshotPath,
  })
}

async function provisionDemoTarget(config: Config): Promise<{ targetUrl: string; cleanup: () => Promise<void> }> {
  if (config.targetUrl) {
    console.log("target:", config.targetUrl)
    console.log("mode: TARGET_URL override (deterministic acceptance is only guaranteed for the bundled store)")
    return { targetUrl: config.targetUrl, cleanup: async () => undefined }
  }

  console.log("provisioning target sandbox...")
  const client = new SolariClient({ apiKey: config.solariApiKey })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 })
  await sandbox.connect()
  let released = false

  try {
    const storeHtml = await readFile(DEMO_STORE_FILE, "utf8")
    await sandbox.commands.run("mkdir", { args: ["-p", "/tmp/agentqa-store"] })
    await sandbox.files.write("/tmp/agentqa-store/index.html", storeHtml)
    await sandbox.commands.run("sh", {
      args: ["-c", `cd /tmp/agentqa-store && nohup python3 -m http.server ${TARGET_PORT} >/dev/null 2>&1 &`],
    })
    const { url } = await sandbox.previewUrl(TARGET_PORT)
    await waitForPreview(url)
    console.log("target:", url)
    return {
      targetUrl: url,
      // Idempotent. The caller releases the target as soon as browsing is done so
      // the analysis sandbox does not need a second concurrent session slot, and
      // releases it again from its outer finally on the error paths.
      cleanup: async () => {
        if (released) return
        released = true
        await sandbox.kill()
      },
    }
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    throw error
  }
}

async function waitForPreview(url: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    await sleep(1000)
    try {
      const response = await fetch(url)
      if (response.ok) return
      console.log(`waiting for target preview: HTTP ${response.status}`)
    } catch (error) {
      console.log(`waiting for target preview: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new AgentQaError("Target preview did not become reachable in time.")
}

function browserTools(): ToolDefinition[] {
  const selectorSchema = {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector, role-derived selector, or visible text selector." },
    },
    required: ["selector"],
    additionalProperties: false,
  }

  return [
    {
      type: "function",
      function: {
        name: "navigate",
        description: "Navigate to a valid http(s) URL.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "inspect_page",
        description: "Return the current page URL, title, visible text, and likely interactive controls.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "click",
        description: "Click a visible page element by selector or visible text.",
        parameters: selectorSchema,
      },
    },
    {
      type: "function",
      function: {
        name: "fill",
        description: "Fill a text-like input.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string" },
            value: { type: "string" },
          },
          required: ["selector", "value"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wait",
        description: "Wait briefly for UI updates.",
        parameters: {
          type: "object",
          properties: { ms: { type: "number", minimum: 250, maximum: 5000 } },
          required: ["ms"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "screenshot",
        description: "Capture a screenshot artifact of the current page.",
        parameters: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "report_suspected_failure",
        description: "Use only when checkout appears broken and you can describe expected vs actual behavior.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
            expected: { type: "string" },
            actual: { type: "string" },
            steps: { type: "array", items: { type: "string" }, minItems: 1 },
            rationale: { type: "string" },
          },
          required: ["title", "severity", "expected", "actual", "steps", "rationale"],
          additionalProperties: false,
        },
      },
    },
  ]
}

async function executeBrowserTool(
  name: string,
  rawArgs: string,
  context: BrowserToolContext,
): Promise<{ content: string; suspectedFinding?: SuspectedFinding }> {
  const args = parseToolArgs(rawArgs)
  if (context.page.isClosed()) {
    throw new BrowserGoneError("The recorded browser session closed before this action could run.")
  }
  if (name !== "inspect_page" && name !== "report_suspected_failure") {
    context.actionsUsed += 1
    if (context.actionsUsed > context.maxActions) {
      throw new AgentQaError(`Browser action budget exceeded (${context.maxActions}).`)
    }
  }

  if (name === "navigate") {
    const url = stringArg(args, "url", 2048)
    validateHttpUrl(url, "navigate.url")
    await context.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await traceAction(context.phase, context.page, context.trace, `navigate ${url}`, "navigation complete")
    return { content: JSON.stringify(await captureState(context.page)) }
  }

  if (name === "inspect_page") {
    const state = await captureState(context.page)
    const controls = await context.page
      .evaluate(() =>
        Array.from(document.querySelectorAll("a,button,input,select,textarea"))
          .slice(0, 40)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: (element.textContent || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim(),
            name: element.getAttribute("name"),
            id: element.id,
            type: element.getAttribute("type"),
          })),
      )
      .catch(() => [])
    await traceAction(context.phase, context.page, context.trace, "inspect_page", "captured page state")
    return { content: JSON.stringify({ ...state, controls }) }
  }

  if (name === "click") {
    const selector = stringArg(args, "selector", 200)
    const locator = context.page.locator(selector).first()
    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.click({ timeout: 5000 })
    } else {
      await context.page.getByText(selector, { exact: false }).first().click({ timeout: 5000 })
    }
    await context.page.waitForTimeout(500)
    await traceAction(context.phase, context.page, context.trace, `click ${selector}`, "click complete")
    if (/place-order|place order|submit/i.test(selector)) {
      const postSubmit = await capturePostSubmitEvidence(context)
      return { content: JSON.stringify({ ...(await captureState(context.page)), postSubmit }) }
    }
    return { content: JSON.stringify(await captureState(context.page)) }
  }

  if (name === "fill") {
    const selector = stringArg(args, "selector", 200)
    const value = stringArg(args, "value", 500)
    const locator = context.page.locator(selector).first()
    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.fill(value, { timeout: 5000 })
    } else {
      await context.page.getByLabel(selector, { exact: false }).fill(value, { timeout: 5000 })
    }
    await traceAction(context.phase, context.page, context.trace, `fill ${selector}`, `filled ${value.length} characters`)
    return { content: JSON.stringify(await captureState(context.page)) }
  }

  if (name === "wait") {
    const ms = Math.max(250, Math.min(5000, numberArg(args, "ms")))
    await context.page.waitForTimeout(ms)
    await traceAction(context.phase, context.page, context.trace, `wait ${ms}ms`, "wait complete")
    return { content: JSON.stringify(await captureState(context.page)) }
  }

  if (name === "screenshot") {
    const label = stringArg(args, "label", 80).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "screenshot"
    await mkdir(ARTIFACT_DIR, { recursive: true })
    const screenshotPath = join(ARTIFACT_DIR, `${Date.now()}-${label}.png`)
    await context.page.screenshot({ path: screenshotPath, fullPage: true })
    await traceAction(context.phase, context.page, context.trace, `screenshot ${label}`, "screenshot captured", screenshotPath)
    return { content: JSON.stringify({ screenshotPath, ...(await captureState(context.page)) }) }
  }

  if (name === "report_suspected_failure") {
    const finding: SuspectedFinding = {
      title: stringArg(args, "title", 140),
      severity: severityArg(args, "severity"),
      expected: stringArg(args, "expected", 1000),
      actual: stringArg(args, "actual", 1000),
      steps: arrayOfStringsArg(args, "steps", 12),
      rationale: stringArg(args, "rationale", 1500),
    }
    return { content: JSON.stringify({ acceptedForVerification: true, finding }), suspectedFinding: finding }
  }

  throw new AgentQaError(`Unsupported tool: ${name}`)
}

async function capturePostSubmitEvidence(context: BrowserToolContext): Promise<PostSubmitInspection> {
  const inspection = inspectPostSubmitText(await context.page.locator("body").innerText({ timeout: 2000 }))
  let screenshotPath: string | undefined

  try {
    await mkdir(ARTIFACT_DIR, { recursive: true })
    screenshotPath = join(ARTIFACT_DIR, `${Date.now()}-post-submit.png`)
    await context.page.screenshot({ path: screenshotPath, fullPage: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    inspection.observation += ` Screenshot unavailable: ${clip(message, 300)}`
  }

  await traceAction(
    context.phase,
    context.page,
    context.trace,
    "post-submit inspection",
    inspection.observation,
    screenshotPath,
  )
  return { ...inspection, screenshotPath }
}

function inspectPostSubmitText(visibleText: string): PostSubmitInspection {
  const confirmationText = matchingVisibleText(visibleText, CONFIRMATION_PATTERN)
  if (confirmationText) {
    return { outcome: "checkout_succeeded", observation: `Confirmation appeared after submission: "${confirmationText}"` }
  }

  const errorText = matchingVisibleText(visibleText, SUBMISSION_ERROR_PATTERN)
  if (errorText) {
    return { outcome: "confirmed_failure", observation: `Submission error appeared and no confirmation was present: "${errorText}"` }
  }

  return {
    outcome: "confirmed_failure",
    observation: `No confirmation was found after submission. Visible post-submit text: "${clip(visibleText, 700)}"`,
  }
}

function matchingVisibleText(visibleText: string, pattern: RegExp): string {
  return clip(
    visibleText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && pattern.test(line))
      .join(" "),
    700,
  )
}

function parseToolArgs(rawArgs: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs || "{}") as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
    return parsed as Record<string, unknown>
  } catch {
    throw new AgentQaError(`Model returned invalid tool arguments: ${rawArgs}`)
  }
}

function stringArg(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentQaError(`Tool argument ${key} must be a non-empty string.`)
  }
  return value.trim().slice(0, maxLength)
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgentQaError(`Tool argument ${key} must be a finite number.`)
  }
  return value
}

function severityArg(args: Record<string, unknown>, key: string): Severity {
  const value = stringArg(args, key, 20)
  if (["critical", "high", "medium", "low", "info"].includes(value)) return value as Severity
  throw new AgentQaError(`Tool argument ${key} must be a supported severity.`)
}

function arrayOfStringsArg(args: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentQaError(`Tool argument ${key} must be a non-empty string array.`)
  }
  return value.slice(0, maxItems).map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new AgentQaError(`Tool argument ${key} must contain only non-empty strings.`)
    }
    return item.trim().slice(0, 500)
  })
}

/** Unwrap the nested `cause` chain Node attaches to a failed fetch. */
function describeTransportError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: string }).code
    parts.push(code ? `${current.message} [${code}]` : current.message)
    current = current.cause
  }
  return parts.join(" <- ") || String(error)
}

async function chatCompletion(config: Config, messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
  const endpoint = `${config.openaiBaseUrl}/chat/completions`
  const body = JSON.stringify({
    model: config.openaiModel,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.2,
  })
  let lastFailure = "no attempt was made"

  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(attempt * 1000)

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openaiApiKey}`,
          ...config.providerHeaders,
        },
        body,
      })
    } catch (error) {
      // A rejected fetch never reached the provider, so no status exists and the
      // key was never evaluated. One transport blip must not discard a run that
      // has already paid for Solari resources.
      lastFailure = describeTransportError(error)
      console.log(`  chat transport failure (attempt ${attempt}/${CHAT_MAX_ATTEMPTS}): ${clip(lastFailure, 160)}`)
      continue
    }

    // 429 and 5xx are worth another attempt; every other non-2xx is a request
    // the provider understood and rejected, so retrying cannot help.
    if (response.status === 429 || response.status >= 500) {
      lastFailure = `HTTP ${response.status} ${clip(await response.text(), 300)}`
      console.log(`  chat retryable response (attempt ${attempt}/${CHAT_MAX_ATTEMPTS}): ${clip(lastFailure, 160)}`)
      continue
    }

    if (!response.ok) {
      const errorBody = await response.text()
      const authHint =
        response.status === 401
          ? " Check OPENAI_API_KEY and OPENAI_BASE_URL; OpenAI-compatible gateways must accept a Bearer token in the Authorization header."
          : ""
      throw new AgentQaError(
        `OpenAI-compatible chat completion failed: HTTP ${response.status} ${errorBody.slice(0, 500)}${authHint}`,
      )
    }

    const data = (await response.json()) as ChatResponse
    const message = data.choices?.[0]?.message
    if (!message) throw new AgentQaError("OpenAI-compatible chat completion returned no message.")
    return message
  }

  throw new AgentQaError(
    `Could not complete a chat request to ${endpoint} after ${CHAT_MAX_ATTEMPTS} attempts. Last failure: ${lastFailure}. ` +
      "A transport failure here is a connectivity problem rather than a rejected API key; " +
      "check OPENAI_BASE_URL, DNS, and any proxy, VPN, or firewall between this machine and that host.",
  )
}

async function runInvestigator(config: Config, page: Page, targetUrl: string, trace: TraceEntry[]): Promise<SuspectedFinding> {
  const tools = browserTools()
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are AgentQA, a careful web QA investigator. Use only the provided browser tools. " +
        "Do not guess, and never call report_suspected_failure on initial navigation or before attempting checkout. " +
        "You must interactively complete the entire checkout sequence before reporting any failure: " +
        "first navigate to the store page, click Add to Cart, proceed to Cart, click Checkout, and inspect the checkout form. " +
        "Then fill every required field with plausible test data, specifically #name, #email, #address, #city, and #postcode, " +
        "click the final Place Order or submit button, wait briefly for the application state to change, and inspect the post-submission page/state. " +
        "The submit result includes the exact visible post-submit text and a screenshot; use that evidence directly. " +
        "If a confirmation is present, record its text and screenshot as successful evidence. If a visible error appears or confirmation is absent, " +
        "call report_suspected_failure immediately with the observed text/state, expected confirmation behavior, and completed steps. " +
        "Do not spend turns on optional screenshots, repeated inspection, unrelated exploration, or revisiting pages before making this decision.",
    },
    {
      role: "user",
      content:
        `Mission: ${config.mission}\nTarget URL: ${targetUrl}\n` +
        "Start at the target URL, click Add to Cart, then complete checkout in this exact order: Cart -> Checkout -> inspect form -> " +
        "fill #name, #email, #address, #city, and #postcode -> Place Order -> wait briefly -> inspect the resulting state. " +
        "The post-submit result includes confirmation/error text and a screenshot. Do not call report_suspected_failure until after Place Order and that inspection. " +
        "Use plausible test data; record confirmation text if successful, otherwise report immediately with the observed details.",
    },
  ]
  const context: BrowserToolContext = { phase: "investigator", page, trace, actionsUsed: 0, maxActions: config.maxActions }

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    console.log(`investigator turn ${turn}/${config.maxTurns}`)
    const assistantMessage = await chatCompletion(config, messages, tools)
    messages.push(assistantMessage)

    const toolCalls = assistantMessage.tool_calls ?? []
    if (toolCalls.length === 0) {
      throw new AgentQaError(`Investigator stopped without reporting a suspected failure: ${assistantMessage.content ?? ""}`)
    }

    for (const call of toolCalls) {
      try {
        const result = await executeBrowserTool(call.function.name, call.function.arguments, context)
        console.log(`  ${call.function.name}: ${summarizeToolResult(result.content)}`)
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content })
        if (result.suspectedFinding) return result.suspectedFinding
      } catch (error) {
        if (error instanceof BrowserGoneError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (BROWSER_GONE_PATTERN.test(message)) {
          throw new BrowserGoneError(
            "The recorded browser session closed during investigation, so every later action would fail too. " +
              "Check the Solari plan's concurrent session limit and whether an earlier interrupted run leaked a session.",
          )
        }
        console.log(`  ${call.function.name}: error - ${message.slice(0, 160)}`)
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) })
      }
    }
  }

  throw new AgentQaError("Investigator reached the turn budget without a reportable suspected failure.")
}

function summarizeToolResult(content: string): string {
  try {
    const result = JSON.parse(content) as Record<string, unknown>
    if (result.acceptedForVerification) return "suspected failure reported"
    if (typeof result.screenshotPath === "string") return "screenshot captured"
    if (typeof result.url === "string") return `page ${result.url.slice(0, 120)}`
    return "completed"
  } catch {
    return "completed"
  }
}

async function verifyFinding(page: Page, targetUrl: string, trace: TraceEntry[]): Promise<VerificationAttempt[]> {
  console.log(`verifying suspected checkout failure with ${VERIFICATION_ATTEMPTS} fresh attempts...`)
  const attempts: VerificationAttempt[] = []
  await mkdir(ARTIFACT_DIR, { recursive: true })
  for (let attempt = 1; attempt <= VERIFICATION_ATTEMPTS; attempt++) {
    let outcome: VerificationAttempt["outcome"] = "inconclusive"
    let observation = "Verification attempt did not produce an observable checkout result."
    let screenshotPath: string | undefined

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
      await page.evaluate(() => {
        localStorage.clear()
        sessionStorage.clear()
      })
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })

      const result = await performCheckoutAttempt(page)
      outcome = result.outcome
      observation = result.observation
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      observation = `Verification interaction failed: ${clip(message, 500)}`
    }

    try {
      screenshotPath = join(ARTIFACT_DIR, `verification-${attempt}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true })
    } catch (error) {
      screenshotPath = undefined
      const message = error instanceof Error ? error.message : String(error)
      observation += ` Screenshot unavailable: ${clip(message, 300)}`
    }

    attempts.push({ attempt, outcome, observation, screenshotPath })
    await traceAction("verifier", page, trace, `verification attempt ${attempt}`, `outcome=${outcome}; ${observation}`, screenshotPath).catch(
      () => undefined,
    )
  }
  return attempts
}

async function performCheckoutAttempt(
  page: Page,
): Promise<{ outcome: VerificationAttempt["outcome"]; observation: string }> {
  await clickFirst(page, ["#add-to-cart", "button:has-text('Add to Cart')", "Add to Cart"])
  await page.waitForTimeout(300)
  await clickFirst(page, ["#view-cart", "a:has-text('Cart')", "Cart"])
  await page.waitForTimeout(300)
  await clickFirst(page, ["#checkout", "button:has-text('Checkout')", "Checkout"])
  await fillIfPresent(page, "#name", "Ada Lovelace")
  await fillIfPresent(page, "#email", "ada@example.com")
  await fillIfPresent(page, "#address", "123 Test Street")
  await fillIfPresent(page, "#city", "London")
  await fillIfPresent(page, "#postcode", "SW1A 1AA")
  await clickFirst(page, ["#place-order", "button:has-text('Place Order')", "Place Order"])
  await page.waitForTimeout(800)
  const visibleText = await page.locator("body").innerText({ timeout: 2000 })
  return inspectPostSubmitText(visibleText)
}

async function clickFirst(page: Page, selectors: string[]): Promise<void> {
  let lastError: unknown
  for (const selector of selectors) {
    try {
      const locator = selector.includes(":") || selector.startsWith("#") ? page.locator(selector).first() : page.getByText(selector, { exact: false }).first()
      await locator.click({ timeout: 3000 })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not click any of: ${selectors.join(", ")}`)
}

async function fillIfPresent(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector).first()
  if ((await locator.count().catch(() => 0)) > 0) {
    await locator.fill(value, { timeout: 3000 })
  }
}

async function analyzeEvidence(config: Config, trace: TraceEntry[], attempts: VerificationAttempt[]): Promise<AnalysisResult> {
  console.log("analyzing evidence in a second sandbox...")
  const client = new SolariClient({ apiKey: config.solariApiKey })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })
  await sandbox.connect()

  try {
    await sandbox.commands.run("mkdir", { args: ["-p", "/tmp/agentqa-analysis"] })
    await sandbox.files.write(
      "/tmp/agentqa-analysis/evidence.json",
      JSON.stringify({ trace, attempts, expectedAttempts: VERIFICATION_ATTEMPTS }, null, 2),
    )
    const analysis = await sandbox.commands.run("python3", {
      args: [
        "-c",
        `import json
data = json.load(open('/tmp/agentqa-analysis/evidence.json', encoding='utf-8'))
attempts = data['attempts']
expected = data['expectedAttempts']
total = len(attempts)
failed = sum(1 for item in attempts if item.get('outcome') == 'confirmed_failure')
succeeded = sum(1 for item in attempts if item.get('outcome') == 'checkout_succeeded')
inconclusive = sum(1 for item in attempts if item.get('outcome') == 'inconclusive')
reproducible = total == expected and failed == expected
result = {
  "confidence": 0.93 if reproducible else (0.55 if failed else 0.2),
  "reproductionRate": f"{failed}/{total}",
  "reproducible": reproducible,
  "verifierSummary": f"Verifier observed {failed} explicit failures, {succeeded} successful checkouts, and {inconclusive} inconclusive attempts across {total} fresh attempts."
}
open('/tmp/agentqa-analysis/result.json', 'w', encoding='utf-8').write(json.dumps(result, indent=2))
print(json.dumps(result))
`,
      ],
    })
    if (analysis.exitCode !== 0) {
      throw new AgentQaError(`Evidence analysis failed: ${analysis.stderr || analysis.stdout}`)
    }
    return JSON.parse((await sandbox.files.readText("/tmp/agentqa-analysis/result.json")) as string) as AnalysisResult
  } finally {
    await sandbox.kill()
  }
}

/**
 * Release the recorded session. A release failure must not discard a completed
 * investigation, so the error is returned for the report instead of thrown.
 */
async function releaseBrowser(browser: BrowserSession): Promise<string | undefined> {
  try {
    await browser.close()
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`browser release failed: ${clip(message, 200)}`)
    return message
  }
}

async function pollReplayUrl(solari: Solari, sessionId: string): Promise<{ replayUrl?: string; replayStatus: string }> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(3000)
    try {
      const replay = await solari.sessions.getReplayUrl(sessionId)
      return { replayUrl: replay.url, replayStatus: `available; expires in ${replay.expiresInSeconds}s` }
    } catch (error) {
      if (attempt === 10) {
        const message = error instanceof Error ? error.message : String(error)
        return { replayStatus: `not available after approximately 30 seconds: ${message.slice(0, 180)}` }
      }
    }
  }
  return { replayStatus: "not available" }
}

function buildReport(
  finding: SuspectedFinding,
  analysis: AnalysisResult,
  attempts: VerificationAttempt[],
  trace: TraceEntry[],
  targetUrl: string,
  sessionId: string,
  replay: { replayUrl?: string; replayStatus: string },
): Report {
  return {
    title: finding.title,
    severity: finding.severity,
    confidence: analysis.confidence,
    reproducible: analysis.reproducible,
    reproductionRate: analysis.reproductionRate,
    targetUrl,
    sessionId,
    replayUrl: replay.replayUrl,
    replayStatus: replay.replayStatus,
    steps: finding.steps.map((step, index) => ({
      action: `${index + 1}. ${step}`,
      observation: index === finding.steps.length - 1 ? finding.actual : "Completed during investigation.",
    })),
    expected: finding.expected,
    actual: finding.actual,
    evidence: attempts.map((attempt) => ({
      label: `Verification attempt ${attempt.attempt}: ${attempt.outcome.replaceAll("_", " ")}`,
      value: attempt.observation,
      screenshotSrc: attempt.screenshotPath ? `agentqa-artifacts/${attempt.screenshotPath.split(/[\\/]/).pop()}` : undefined,
    })),
    investigatorSummary: finding.rationale,
    verifierSummary: analysis.verifierSummary,
    trace,
  }
}

async function writeHtmlReport(report: Report): Promise<void> {
  const traceRows = report.trace
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.phase)}</td>
        <td>${escapeHtml(entry.timestamp)}</td>
        <td>${escapeHtml(entry.action)}</td>
        <td>${escapeHtml(entry.result)}</td>
        <td>${escapeHtml(entry.url ?? "")}</td>
      </tr>`,
    )
    .join("\n")
  const evidenceCards = report.evidence
    .map(
      (item) => `<figure class="evidence-card">
        ${
          item.screenshotSrc
            ? `<img src="${escapeHtml(item.screenshotSrc)}" alt="${escapeHtml(item.label)} screenshot" loading="lazy" />`
            : '<div class="screenshot-missing">Screenshot unavailable</div>'
        }
        <figcaption><strong>${escapeHtml(item.label)}</strong><br />${escapeHtml(item.value)}</figcaption>
      </figure>`,
    )
    .join("\n")

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(report.title)} - AgentQA</title>
  <style>
    :root { color-scheme: light; --ink: #172026; --muted: #60707c; --line: #d8e0e6; --bg: #f5f7f8; --panel: #ffffff; --accent: #0f766e; --warn: #b45309; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.5; }
    header { background: #102023; color: white; padding: 32px 20px; }
    main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 4vw, 46px); letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 22px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 18px; }
    .metric, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .metric strong { display: block; font-size: 24px; color: var(--accent); }
    .muted { color: var(--muted); }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-weight: 700; text-transform: uppercase; font-size: 12px; }
    .badge.confirmed { background: #e6f4f1; color: #0f5f59; }
    .badge.inconclusive { background: #fff3d6; color: #8a4b08; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .evidence-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .evidence-card { margin: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #fafcfc; }
    .evidence-card img { display: block; width: 100%; max-height: 420px; object-fit: contain; background: #edf2f4; }
    .evidence-card figcaption, .screenshot-missing { padding: 12px; }
    .screenshot-missing { min-height: 140px; display: grid; place-items: center; color: var(--muted); background: #edf2f4; }
    ol { padding-left: 22px; }
    li { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-top: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; word-break: break-word; }
    th { color: var(--muted); font-weight: 700; }
    a { color: #0f5f59; }
    code { background: #edf2f4; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <header>
    <div style="max-width:1080px;margin:0 auto;">
      <span class="badge ${report.reproducible ? "confirmed" : "inconclusive"}">${escapeHtml(report.reproducible ? "confirmed" : "inconclusive")}</span>
      <h1>${escapeHtml(report.title)}</h1>
      <p class="muted" style="color:#c4d0d5;">Evidence-backed checkout investigation from a recorded Solari browser session.</p>
    </div>
  </header>
  <main>
    <div class="summary">
      <div class="metric"><span>Severity</span><strong>${escapeHtml(report.severity)}</strong></div>
      <div class="metric"><span>Confidence</span><strong>${escapeHtml(Math.round(report.confidence * 100))}%</strong></div>
      <div class="metric"><span>Reproduction</span><strong>${escapeHtml(report.reproductionRate)}</strong></div>
      <div class="metric"><span>Session</span><strong>${escapeHtml(report.sessionId)}</strong></div>
    </div>

    <section>
      <h2>Finding</h2>
      <div class="grid">
        <p><strong>Expected</strong><br />${escapeHtml(report.expected)}</p>
        <p><strong>Actual</strong><br />${escapeHtml(report.actual)}</p>
      </div>
      <p><strong>Target:</strong> <a href="${escapeHtml(report.targetUrl)}">${escapeHtml(report.targetUrl)}</a></p>
      <p><strong>Recording:</strong> ${
        report.replayUrl
          ? `<a href="${escapeHtml(report.replayUrl)}">Download rrweb trace (NDJSON)</a> <span class="muted">${escapeHtml(report.replayStatus)}</span>`
          : escapeHtml(report.replayStatus)
      }</p>
    </section>

    <section>
      <h2>Steps</h2>
      <ol>${report.steps.map((step) => `<li><strong>${escapeHtml(step.action)}</strong><br />${escapeHtml(step.observation)}</li>`).join("")}</ol>
    </section>

    <section>
      <h2>Evidence</h2>
      <div class="evidence-grid">${evidenceCards}</div>
      <p><strong>Investigator:</strong> ${escapeHtml(report.investigatorSummary)}</p>
      <p><strong>Verifier:</strong> ${escapeHtml(report.verifierSummary)}</p>
    </section>

    <section>
      <h2>Trace</h2>
      <table>
        <thead><tr><th>Phase</th><th>Time</th><th>Action</th><th>Result</th><th>URL</th></tr></thead>
        <tbody>${traceRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`
  await writeFile(REPORT_FILE, html, "utf8")
}

async function main(): Promise<void> {
  const config = await requireConfig()
  const trace: TraceEntry[] = []
  let cleanupTarget: () => Promise<void> = async () => undefined
  const solari = new Solari({ apiKey: config.solariApiKey })
  let sessionId = ""

  try {
    const target = await provisionDemoTarget(config)
    cleanupTarget = target.cleanup
    console.log("launching recorded browser...")
    // probe verifies the session actually serves a browser before the model
    // starts spending turns on it; launch() otherwise returns dead sessions.
    const browser = await solari.launch({ recording: true, probe: true, probeTimeoutMs: 5000, retries: 2 })
    sessionId = browser.id

    try {
      const page = await browser.newPage()
      const finding = await runInvestigator(config, page, target.targetUrl, trace)
      const attempts = await verifyFinding(page, target.targetUrl, trace)
      await sleep(RECORDING_FLUSH_MS)
      const releaseNote = await releaseBrowser(browser)
      // Solari plans cap concurrent sandboxes, and nothing after verification
      // needs the target, so release it before the analysis sandbox is created.
      await cleanupTarget().catch(() => undefined)
      const analysis = await analyzeEvidence(config, trace, attempts)

      const replay = await pollReplayUrl(solari, sessionId)
      if (releaseNote) replay.replayStatus += `; browser release failed: ${clip(releaseNote, 200)}`
      const report = buildReport(finding, analysis, attempts, trace, target.targetUrl, sessionId, replay)
      await writeHtmlReport(report)

      console.log("report:", REPORT_FILE)
      console.log("status:", analysis.reproducible ? "confirmed" : "inconclusive")
      console.log("rrweb trace:", replay.replayUrl ?? replay.replayStatus)
    } finally {
      if (browser.isConnected()) {
        await sleep(RECORDING_FLUSH_MS)
        await browser.close().catch(() => undefined)
      }
    }
  } finally {
    await cleanupTarget().catch(() => undefined)
    await solari.close().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
