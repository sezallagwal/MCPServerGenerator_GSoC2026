import { bundleEngine } from "./engine-bundle.js";
import {
  generateEndpointMap,
  generateServerEntry,
  generateTestSetup,
  generateToolFile,
  generateToolTest,
} from "./codegen.js";
import {
  generateGitignore,
  generatePackageJson,
  generateTsConfig,
} from "./scaffold.js";
import type {
  GeneratedFile,
  GenerateProjectInput,
  GenerateProjectResult,
} from "./types.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import { generateWorkflowDiagram } from "./mermaid-codegen.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { RocketChatAdapter } from "../platform/rocketchat-adapter.js";

export function sanitizeServerName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = /^[a-z]/.test(cleaned) ? cleaned : `mcp_${cleaned}`;
  return safe || "mcp_server";
}

/** A workflow name is unconstrained DSL text; this makes it safe as a filename and an import. */
export function sanitizeModuleName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned === "") return "tool";
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `tool_${cleaned}`;
}

/** Aligned by index, with a numeric suffix wherever sanitization collides. */
export function assignModuleNames(workflows: WorkflowDefinition[]): string[] {
  const used = new Set<string>();
  return workflows.map((workflow) => {
    const base = sanitizeModuleName(workflow.name);
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${counter++}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/** Retry-safe steps get `continueOnError`; an explicit DSL value wins. Mutates a private copy. */
function applyErrorPolicy(
  workflows: WorkflowDefinition[],
  adapter: PlatformAdapter,
): void {
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (step.config.type !== "api_call") continue;
      if (step.config.continueOnError !== undefined) continue;
      if (adapter.shouldContinueOnError(step.config.operationId)) {
        step.config.continueOnError = true;
      }
    }
  }
}

export function generateProject(
  input: GenerateProjectInput,
): GenerateProjectResult {
  const serverName = sanitizeServerName(input.serverName);
  const { endpoints } = input;
  const adapter = input.adapter ?? new RocketChatAdapter();
  const transport = input.transport ?? "stdio";

  if (input.workflows.length === 0) {
    throw new Error("Cannot generate a project with no workflows.");
  }

  // Private copy, so a caller's workflows come back unchanged and this stays re-runnable.
  const workflows = structuredClone(input.workflows);

  const usesSampling = workflows.some((w) => w.usesSampling);
  const usesElicitation = workflows.some((w) => w.usesElicitation);

  applyErrorPolicy(workflows, adapter);

  const clientFile = adapter.clientFileName();
  const clientModule = clientFile.replace(/\.ts$/, "");

  const files: GeneratedFile[] = [];

  // Vendored engine.
  files.push(...bundleEngine());

  // Keyed by a safe unique basename, so an arbitrary workflow name cannot break a filename.
  const moduleNames = assignModuleNames(workflows);
  workflows.forEach((workflow, i) => {
    files.push({
      path: `src/tools/${moduleNames[i]}.ts`,
      content: generateToolFile(workflow),
    });
    files.push({
      path: `src/tests/${moduleNames[i]}.test.ts`,
      content: generateToolTest(workflow, moduleNames[i]),
    });
  });

  // Platform-neutral: it mocks the engine's own interfaces, so it bypasses the adapter.
  files.push({ path: "src/tests/setup.ts", content: generateTestSetup() });

  // Wiring + scaffolding.
  files.push({
    path: "src/endpoints.ts",
    content: generateEndpointMap(endpoints),
  });
  files.push({
    path: `src/${clientFile}`,
    content: adapter.generateRestClientCode(),
  });
  files.push({
    path: "src/server.ts",
    content: generateServerEntry(
      serverName,
      workflows,
      moduleNames,
      clientModule,
      transport,
    ),
  });
  files.push({
    path: "package.json",
    content: generatePackageJson(serverName),
  });
  files.push({ path: "tsconfig.json", content: generateTsConfig() });
  files.push({ path: ".gitignore", content: generateGitignore() });
  files.push({
    path: ".env.example",
    content: adapter.generateEnvExample({ usesSampling, transport }),
  });
  // Appended here, not per adapter README, so every platform gets it from one place.
  files.push({
    path: "README.md",
    content:
      adapter.generateReadme(serverName, workflows, endpoints) +
      generateWorkflowDiagram(workflows),
  });

  return {
    files,
    summary: {
      serverName,
      platformName: adapter.platformName,
      transport,
      workflowCount: workflows.length,
      endpointCount: endpoints.length,
      usesSampling,
      usesElicitation,
    },
  };
}
