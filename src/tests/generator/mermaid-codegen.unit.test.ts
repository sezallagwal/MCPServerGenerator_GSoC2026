import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateWorkflowDiagram } from "../../generator/mermaid-codegen.js";
import type { WorkflowDefinition, WorkflowStep } from "../../workflow/types.js";

/** A false diagram is worse than none: sanitizing per use site merged steps and self-edged. */

function workflow(steps: WorkflowStep[], name = "wf"): WorkflowDefinition {
  return {
    name,
    description: "d",
    params: { type: "object", properties: {} },
    steps,
    requiredEndpoints: [],
    usesSampling: false,
    usesElicitation: false,
  };
}

const transform = (
  id: string,
  label: string,
  dependsOn?: string[],
): WorkflowStep => ({
  id,
  label,
  config: { type: "transform", expression: "1" },
  ...(dependsOn ? { dependsOn } : {}),
});

/** The lines inside the fenced mermaid block, trimmed. */
function diagramLines(wf: WorkflowDefinition): string[] {
  const body = generateWorkflowDiagram([wf]).split("```mermaid")[1];
  assert.ok(body, "expected a mermaid block");
  return body
    .split("```")[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Node identifiers from declaration lines like `id["label"]`. */
function declaredIds(lines: string[]): string[] {
  return lines
    .map((l) => /^([A-Za-z0-9_]+)[[{(/]/.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe("node identifiers are unique", () => {
  it("gives distinct nodes to step ids that sanitize identically", () => {
    const lines = diagramLines(
      workflow([
        transform("fetch-user", "by dash"),
        transform("fetch.user", "by dot", ["fetch-user"]),
      ]),
    );
    const ids = declaredIds(lines);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `duplicate node identifiers: ${ids.join(", ")}`,
    );
  });

  it("draws no self-edge when two step ids collide", () => {
    const lines = diagramLines(
      workflow([
        transform("fetch-user", "by dash"),
        transform("fetch.user", "by dot", ["fetch-user"]),
      ]),
    );
    for (const line of lines) {
      const edge = /^(\S+) --> (\S+)$/.exec(line);
      assert.ok(
        !edge || edge[1] !== edge[2],
        `self-edge asserts a loop the workflow does not have: ${line}`,
      );
    }
  });

  it("keeps Start and Done clear of a step that claims their name", () => {
    const lines = diagramLines(
      workflow([transform("START_wf", "adversarial")], "wf"),
    );
    const ids = declaredIds(lines);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `Start collided with a step id: ${ids.join(", ")}`,
    );
  });
});

describe("edges follow the dependency graph", () => {
  it("draws a dependency edge between the right two nodes", () => {
    const lines = diagramLines(
      workflow([transform("a", "first"), transform("b", "second", ["a"])]),
    );
    assert.ok(lines.includes("a --> b"));
  });

  it("hangs a step with no dependencies off Start and a leaf into Done", () => {
    const lines = diagramLines(
      workflow([transform("a", "first"), transform("b", "second", ["a"])]),
    );
    assert.ok(lines.some((l) => /^START_\w+ --> a$/.test(l)));
    assert.ok(lines.some((l) => /^b --> DONE_\w+$/.test(l)));
  });

  it("labels a conditional's branches and does not duplicate them", () => {
    const lines = diagramLines(
      workflow([
        {
          id: "check",
          label: "check",
          config: {
            type: "conditional",
            condition: "true",
            thenStep: "yes",
            elseStep: "no",
          },
        },
        transform("yes", "then", ["check"]),
        transform("no", "else", ["check"]),
      ]),
    );
    assert.ok(lines.includes("check -->|Yes| yes"));
    assert.ok(lines.includes("check -->|No| no"));
    assert.ok(
      !lines.includes("check --> yes"),
      "a branch edge must not also be drawn as a plain dependency",
    );
  });
});

describe("labels cannot break out of a node", () => {
  it("neutralizes quotes and brackets so no extra node is injected", () => {
    const lines = diagramLines(
      workflow([transform("s1", 'x"] --> HACKED[" ')]),
    );
    assert.ok(
      !lines.some((l) => l.includes("HACKED[")),
      `label escaped its node: ${lines.join(" | ")}`,
    );
    assert.ok(!lines.some((l) => l.includes('"] -->')));
  });
});

describe("empty input", () => {
  it("emits nothing for no workflows and for a workflow with no steps", () => {
    assert.equal(generateWorkflowDiagram([]), "");
    assert.equal(generateWorkflowDiagram([workflow([])]), "");
  });
});
