<h1 align="center">Rocket.Chat MCP Server Generator</h1>

<p align="center">
  An <a href="https://modelcontextprotocol.io/">MCP</a> server that generates other MCP servers — scoped to only the API operations a project actually needs.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-blue.svg" alt="TypeScript 5.9"></a>
  <a href="https://github.com/modelcontextprotocol/typescript-sdk"><img src="https://img.shields.io/badge/MCP%20SDK-1.x-purple.svg" alt="MCP SDK 1.x"></a>
  <a href="https://github.com/RocketChat/MCPServerGenerator_GSoC2026/actions/workflows/ci.yml"><img src="https://github.com/RocketChat/MCPServerGenerator_GSoC2026/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

## Overview

Rocket.Chat's public OpenAPI surface spans 12 domains and several hundred operations. An MCP server that wraps all of them has to declare all of them as tools, and a client re-sends those declarations on every turn — so a project pays context cost proportional to the tools it declares, not the ones it calls.

This generator takes a different approach. It exposes the API surface as discovery tools, so an AI client can find the operations a goal needs, describe them as multi-step **workflow tools**, and have a complete, runnable MCP server project written to disk. A generated server exposes one tool per workflow rather than one tool per endpoint.

Each workflow chains API calls, LLM reasoning, human confirmation, data transforms, and conditional branching behind a single tool call. The workflow engine is copied into the output, so a generated project has no runtime dependency on this generator.

## Features

- **Workflow tools, not endpoint wrappers** — five step types (`api_call`, `sampling`, `elicitation`, `transform`, `conditional`) composed into one MCP tool per workflow.
- **Live OpenAPI specs** — fetched from the [Rocket.Chat Open API repository](https://github.com/RocketChat/Rocket.Chat-Open-API) at runtime and cached for 24 hours, so new endpoints appear without hand-written definitions.
- **Fail-closed generation** — if any referenced `operationId` cannot be resolved against the spec, nothing is written.
- **Sandboxed expressions** — `transform` and `conditional` bodies are validated against an AST allowlist before they run.
- **Two transports** — stdio, or Streamable HTTP with closed-by-default network settings.
- **Additive regeneration** — add workflows to an existing project without overwriting files you have edited.
- **Derived permissions** — for Rocket.Chat, the generated README lists the permissions the server's account needs.
- **Self-contained output** — generated projects ship their own tests, README, and workflow diagram.

Rocket.Chat is the supported target. A `PlatformAdapter` seam keeps the generator core free of platform specifics, and an experimental generic OpenAPI adapter exists behind it, but it is not wired to a user-facing option yet.

## How it works

The generator is an MCP server exposing three tools, called in sequence:

| Tool                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `get_capability_guide` | Lists the available REST API operations with their operationIds  |
| `get_endpoint_schemas` | Returns the request and response schemas the spec documents      |
| `generate`             | Validates the workflows and writes a complete MCP server project |

### `generate` parameters

| Parameter   | Type                          | Default       | Purpose                            |
| ----------- | ----------------------------- | ------------- | ---------------------------------- |
| `dsl`       | `string`                      | required      | The workflow DSL document          |
| `outputDir` | `string`                      | `generated/`  | Where to write the project         |
| `writeMode` | `"overwrite"` \| `"additive"` | `"overwrite"` | See [Write modes](#write-modes)    |
| `transport` | `"stdio"` \| `"http"`         | `"stdio"`     | Transport for the generated server |

The project is written to `<outputDir>/<project-name>`, where the name is sanitized for use as a directory and identifier (`release-notifier` becomes `release_notifier`).

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v22 or newer
- An MCP-compatible client (Antigravity CLI, Claude Desktop, Cursor, VS Code, or any other)

### Setup

```bash
git clone https://github.com/RocketChat/MCPServerGenerator_GSoC2026.git
cd MCPServerGenerator_GSoC2026
npm install
```

### Register with an MCP client

The generator speaks MCP over stdio, so any MCP client can drive it:

```jsonc
{
  "mcpServers": {
    "mcp-server-generator": {
      "command": "node",
      "args": ["--import", "tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/MCPServerGenerator_GSoC2026",
    },
  },
}
```

Antigravity CLI reads workspace MCP servers from `.agents/mcp_config.json`; Claude Desktop uses `claude_desktop_config.json`. The block above is the same shape in both.

## Usage

Describe what you need, and the client drives the three tools:

```
> I need an MCP server that drafts a release announcement,
  asks me to approve it, then posts it to a channel
```

To run the generator directly instead:

```bash
npm run dev                  # from source via tsx
npm run build && npm start   # compiled
```

### Example

The DSL passed to `generate`:

```
PROJECT release-notifier
DESCRIPTION Drafts a release announcement, gets human sign-off, then posts it

WORKFLOW announce_release
  DESCRIPTION Draft an announcement, confirm it with a human, then post it
  PARAM channel : string : Target channel, e.g. #announcements
  PARAM highlights : string : Raw release notes to turn into an announcement

  STEP draft : sampling
    LABEL Draft the announcement
    PROMPT <<<
      Write a short release announcement from these highlights:
      {{params.highlights}}
    >>>

  STEP confirm : elicitation
    LABEL Human sign-off before posting
    MESSAGE Post this announcement? {{steps.draft}}
    SCHEMA {"type":"object","properties":{"approved":{"type":"boolean"}}}
    ON_DECLINE abort

  STEP post : api_call
    LABEL Post to the channel
    OPERATION post-api-v1-chat_postMessage
    MAP channel = {{params.channel}}
    MAP text = {{steps.draft}}
```

This produces one MCP tool, `announce_release`, taking `channel` and `highlights`. Behind that single call the engine asks the model for a draft, pauses for human approval, and posts the approved text — with `ON_DECLINE abort` stopping the run if approval is refused.

### Write modes

**`overwrite`** (default) writes the project fresh.

**`additive`** adds workflows to an existing generated project without clobbering files you have edited. Generated files are fingerprinted in `.mcp-gen-manifest.json`; on a re-run the generator compares fingerprints and reports what was added, refreshed, preserved, and where a conflict, stale scaffold, or orphan needs attention. A missing or unparseable manifest is treated as "not a generated project", and everything is preserved.

## Workflow DSL

The DSL is flat and line-oriented — every meaningful line is `KEYWORD value`, and indentation is cosmetic.

```
PROJECT <name>
DESCRIPTION <text>

WORKFLOW <name>            -> becomes one MCP tool
  DESCRIPTION <text>
  PARAM <name> : <type>    -> becomes a tool input
  STEP <id> : <type>       -> one unit of work
    <step keywords...>
```

### Step types

| Type          | Purpose                        | Required field                   |
| ------------- | ------------------------------ | -------------------------------- |
| `api_call`    | Call a REST endpoint           | `OPERATION`                      |
| `sampling`    | LLM reasoning over prior state | `PROMPT`                         |
| `elicitation` | Ask the user and wait          | `MESSAGE`                        |
| `transform`   | Reshape data with JavaScript   | `EXPRESSION`                     |
| `conditional` | Branch execution               | `CONDITION` + (`THEN` or `ELSE`) |

See the **[DSL Reference](docs/DSL_REFERENCE.md)** for the full grammar, template and `MAP` rules, iteration, and the complete error catalog.

> `WEBHOOK` blocks are parsed and validated but not yet emitted into generated servers.

## Generated output

```
<project-name>/
├── src/
│   ├── server.ts              # MCP server, tool registration, transport
│   ├── endpoints.ts           # operationId -> { method, path }
│   ├── rc-client.ts           # REST client
│   ├── engine/                # workflow runtime, copied in verbatim
│   │   ├── types.ts
│   │   ├── expression-security.ts
│   │   ├── templates.ts
│   │   ├── api-call.ts
│   │   ├── sampling.ts
│   │   ├── executor.ts
│   │   └── index.ts
│   ├── tools/<workflow>.ts    # one per workflow: step data + handler
│   └── tests/
│       ├── setup.ts           # network-free mocks
│       └── <workflow>.test.ts # one smoke test per workflow
├── .env.example
├── .gitignore
├── .mcp-gen-manifest.json
├── package.json
├── tsconfig.json
└── README.md
```

```bash
cd generated/<project-name>
npm install
cp .env.example .env    # fill in credentials
npm start
```

See **[Generated Project Anatomy](docs/GENERATED_PROJECT.md)** for a file-by-file walkthrough.

## Development

```bash
npm test         # full suite
npm run check    # format:check + lint + typecheck + test + build
```

| Script                     | Does                          |
| -------------------------- | ----------------------------- |
| `npm run dev`              | Run from source via tsx       |
| `npm start`                | Run compiled `dist/`          |
| `npm run build`            | Compile + copy engine sources |
| `npm test`                 | Full suite via `node:test`    |
| `npm run test:unit`        | Unit tests only               |
| `npm run test:integration` | Integration tests only        |
| `npm run typecheck`        | `tsc --noEmit`                |
| `npm run lint`             | ESLint                        |
| `npm run format`           | Prettier, write mode          |

Tests run on `node:test` via `tsx`. Unit tests are network-free; integration tests exercise the real OpenAPI fetch and cache path. See the **[Testing Guide](docs/TESTING.md)** for the suite map and conventions.

See **[Contributing](CONTRIBUTING.md)** for setup and workflow.
