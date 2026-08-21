import { formatCapabilityGuide } from "./capability-guide.js";
import type { CapabilityGuideHints } from "./capability-guide.js";
import type { CapabilityGuideSource } from "../parser/index.js";

/** Hints are optional: an unannotated guide is the right output for a quirk-free platform. */
type GuideSource = CapabilityGuideSource & {
  capabilityGuideHints?(): CapabilityGuideHints;
};

export async function handleGetCapabilityGuide(source: GuideSource) {
  try {
    const endpoints = await source.listEndpoints(source.getAvailableDomains());
    const guide = formatCapabilityGuide(
      endpoints,
      source.capabilityGuideHints?.() ?? {},
    );
    return {
      content: [{ type: "text" as const, text: guide }],
    };
  } catch (err) {
    const domains = source.getAvailableDomains();
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Failed to generate capability guide: ${err instanceof Error ? err.message : String(err)}\n\n` +
            `Available domains: ${domains.join(", ")}`,
        },
      ],
      isError: true,
    };
  }
}
