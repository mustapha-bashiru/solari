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
