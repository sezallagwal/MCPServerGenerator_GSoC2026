import type { ConditionalStep, WorkflowDefinition } from "../workflow/types.js";

/** Mermaid flowcharts for the generated README, with edges from the real dependency graph. */
export function generateWorkflowDiagram(
  workflows: WorkflowDefinition[],
): string {
  if (workflows.length === 0) return "";

  const sections = workflows
    .filter((wf) => wf.steps.length > 0)
    .map((wf) => renderWorkflow(wf));
  if (sections.length === 0) return "";

  return `\n## Workflow diagrams\n${sections.join("")}`;
}

function renderWorkflow(wf: WorkflowDefinition): string {
  // Resolved once, here: `fetch-user` and `fetch.user` both sanitize to `fetch_user`.
  const nodeIds = assignNodeIds(wf);
  const nid = (stepId: string) => nodeIds.get(stepId) ?? sanitizeId(stepId);

  const startId = uniqueAux(`START_${sanitizeId(wf.name)}`, nodeIds);
  const doneId = uniqueAux(`DONE_${sanitizeId(wf.name)}`, nodeIds);

  const lines: string[] = ["flowchart TD"];
  lines.push(`  ${startId}([Start])`);

  for (const step of wf.steps) {
    lines.push(
      `  ${nodeDeclaration(nid(step.id), step.label || step.id, step.config.type)}`,
    );
  }

  // A conditional owns its branch edges, so they are drawn from it, not from dependsOn.
  const branchEdges = new Set<string>();
  for (const step of wf.steps) {
    if (step.config.type !== "conditional") continue;
    const cfg = step.config as ConditionalStep;
    if (cfg.thenStep) branchEdges.add(`${step.id}->${cfg.thenStep}`);
    if (cfg.elseStep) branchEdges.add(`${step.id}->${cfg.elseStep}`);
  }

  const hasIncoming = new Set<string>();
  const hasOutgoing = new Set<string>();
  const edges: string[] = [];

  for (const step of wf.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (branchEdges.has(`${dep}->${step.id}`)) continue;
      edges.push(`  ${nid(dep)} --> ${nid(step.id)}`);
      hasIncoming.add(step.id);
      hasOutgoing.add(dep);
    }
  }

  for (const step of wf.steps) {
    if (step.config.type !== "conditional") continue;
    const cfg = step.config as ConditionalStep;
    if (cfg.thenStep) {
      edges.push(`  ${nid(step.id)} -->|Yes| ${nid(cfg.thenStep)}`);
      hasIncoming.add(cfg.thenStep);
      hasOutgoing.add(step.id);
    }
    if (cfg.elseStep) {
      edges.push(`  ${nid(step.id)} -->|No| ${nid(cfg.elseStep)}`);
      hasIncoming.add(cfg.elseStep);
      hasOutgoing.add(step.id);
    }
  }

  // Entry points hang off Start; leaves feed into Done.
  for (const step of wf.steps) {
    if (!hasIncoming.has(step.id)) {
      edges.push(`  ${startId} --> ${nid(step.id)}`);
    }
  }
  const leaves = wf.steps.filter((s) => !hasOutgoing.has(s.id));
  if (leaves.length > 0) {
    lines.push(`  ${doneId}([Done])`);
    for (const step of leaves) {
      edges.push(`  ${nid(step.id)} --> ${doneId}`);
    }
  }

  const legend = `> Shapes: \`/parallelogram/\` API call, \`[[subroutine]]\` AI sampling, \`{{hexagon}}\` user prompt, \`[rectangle]\` transform, \`{diamond}\` condition.`;

  return (
    `\n### \`${wf.name}\`\n\n${legend}\n\n` +
    "```mermaid\n" +
    `${lines.concat(edges).join("\n")}\n` +
    "```\n"
  );
}

/** `safeId` is already collision-free; re-sanitizing would discard its numeric suffix. */
function nodeDeclaration(safeId: string, label: string, type: string): string {
  const text = escapeLabel(label) || safeId;
  switch (type) {
    case "api_call":
      return `${safeId}[/"${text} (API)"/]`;
    case "sampling":
      return `${safeId}[["${text} (AI)"]]`;
    case "elicitation":
      return `${safeId}{{"${text} (User)"}}`;
    case "transform":
      return `${safeId}["${text} (Transform)"]`;
    case "conditional":
      return `${safeId}{"${text}"}`;
    default:
      return `${safeId}["${text}"]`;
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Sanitizing is lossy, so a collision takes a numeric suffix in step order. */
function assignNodeIds(wf: WorkflowDefinition): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const step of wf.steps) {
    const base = sanitizeId(step.id) || "step";
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    used.add(candidate);
    assigned.set(step.id, candidate);
  }
  return assigned;
}

/** A workflow may legitimately hold a step called `START_<name>`, so reserve past it. */
function uniqueAux(base: string, nodeIds: Map<string, string>): string {
  const taken = new Set(nodeIds.values());
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  return candidate;
}

/** In a quoted Mermaid label a quote closes it early and brackets read as shape syntax. */
function escapeLabel(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/[[\]{}()]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}
