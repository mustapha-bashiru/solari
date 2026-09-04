/** Scratch diagnostic: list live Solari sandboxes. Not part of the showcase. */
import { readFile } from "node:fs/promises"
import { SolariClient } from "@solarisdk/sdk"

const envText = await readFile(new URL(".env", import.meta.url), "utf8")
for (const line of envText.split(/\r?\n/)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "")
}

const client = new SolariClient({ apiKey: process.env.SOLARI_API_KEY!.trim() })
const { sandboxes } = await client.sandboxes.list()
console.log(`live sandboxes: ${sandboxes.length}`)
for (const sandbox of sandboxes) {
  console.log(`  ${sandbox.id} kind=${sandbox.kind} state=${sandbox.state} expiresAt=${sandbox.expiresAt}`)
}

if (process.argv.includes("--kill")) {
  for (const sandbox of sandboxes) {
    await client.sandboxes.kill(sandbox.id).catch((error: unknown) => console.log(`  kill ${sandbox.id} failed: ${error}`))
    console.log(`  killed ${sandbox.id}`)
  }
}
