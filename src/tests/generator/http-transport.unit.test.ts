import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { generateServerEntry } from "../../generator/codegen.js";
import type { WorkflowDefinition } from "../../workflow/types.js";

/** The entry point is only template strings, so broken emission is otherwise invisible. */

const workflow: WorkflowDefinition = {
  name: "ping",
  description: "d",
  params: { type: "object", properties: {} },
  steps: [
    {
      id: "s",
      label: "s",
      config: { type: "api_call", operationId: "op", inputMapping: {} },
    },
  ],
  requiredEndpoints: ["op"],
  usesSampling: false,
  usesElicitation: false,
};

const httpEntry = generateServerEntry(
  "srv",
  [workflow],
  ["ping"],
  "rc-client",
  "http",
);
const stdioEntry = generateServerEntry(
  "srv",
  [workflow],
  ["ping"],
  "rc-client",
  "stdio",
);

/** Syntactic diagnostics only — enough to catch a broken template. */
function syntaxErrors(source: string): string[] {
  const file = ts.createSourceFile(
    "server.ts",
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  // `parseDiagnostics` is not on the public type but is populated by the parser.
  const diagnostics =
    (file as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  return diagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, " "),
  );
}

describe("the generated server entry is syntactically valid", () => {
  it("parses for the http transport", () => {
    assert.deepEqual(syntaxErrors(httpEntry), []);
  });

  it("parses for the stdio transport", () => {
    assert.deepEqual(syntaxErrors(stdioEntry), []);
  });

  it("the parser really does report a broken template", () => {
    // Guards the guard: an unterminated template literal is what a careless edit produces.
    assert.ok(
      syntaxErrors("const a = `unterminated").length > 0,
      "syntaxErrors must actually detect a syntax error",
    );
  });
});

describe("resource limits are validated, not silently coerced", () => {
  for (const name of ["MCP_MAX_SESSIONS", "MCP_SESSION_TTL_MS"]) {
    it(`${name} goes through the validating reader`, () => {
      assert.match(
        httpEntry,
        new RegExp(`positiveIntEnv\\("${name}"`),
        `${name} must be validated`,
      );
      assert.ok(
        !new RegExp(`Number\\(\\s*process\\.env\\.${name}`).test(httpEntry),
        `a bare Number(process.env.${name}) turns a typo into NaN, which disables ` +
          `the limit instead of falling back to the default`,
      );
    });
  }

  it("refuses a non-positive or non-integer value rather than continuing", () => {
    assert.match(httpEntry, /must be a positive integer/);
    assert.match(httpEntry, /!Number\.isInteger\(n\) \|\| n < 1/);
  });

  it("still validates the port, which set the precedent", () => {
    assert.match(httpEntry, /Invalid MCP_PORT/);
  });
});

describe("bearer authentication", () => {
  it("matches the scheme case-insensitively, as RFC 7235 requires", () => {
    assert.ok(
      httpEntry.includes("bearerCredential"),
      "the credential must be parsed out of the header before comparison",
    );
    // Without the `i` flag a legal "bearer <token>" is rejected.
    const matcher = httpEntry
      .split("\n")
      .find((l) => l.includes("Bearer") && l.includes(".exec("));
    assert.ok(matcher, "expected a header matcher line");
    assert.match(
      matcher,
      /\/i\b/,
      `matcher is case-sensitive: ${matcher.trim()}`,
    );
  });

  it("does not compare the whole header verbatim against a fixed prefix", () => {
    assert.ok(
      !httpEntry.includes(
        'safeCompare(String(header), "Bearer " + AUTH_TOKEN)',
      ),
      'comparing the raw header rejected "bearer <token>", a legal spelling',
    );
  });

  it("compares in constant time over a fixed-length digest", () => {
    assert.match(httpEntry, /timingSafeEqual/);
    assert.match(httpEntry, /createHash\("sha256"\)/);
  });
});

describe("the HTTP listener ships closed by default", () => {
  it("binds to loopback unless the operator opts out", () => {
    assert.match(httpEntry, /process\.env\.MCP_BIND_HOST \|\| "127\.0\.0\.1"/);
  });

  it("validates the Host header against an allowlist that fails closed", () => {
    assert.match(httpEntry, /ALLOWED_HOSTS\.has\(hostHeader\)/);
    assert.match(httpEntry, /Host header not allowed/);
  });

  it("warns loudly when no auth token is configured", () => {
    assert.match(httpEntry, /WITHOUT authentication/);
  });

  it("answers health probes before the Host and auth gates", () => {
    const healthAt = httpEntry.indexOf('"/health"');
    const hostGateAt = httpEntry.indexOf("ALLOWED_HOSTS.has(hostHeader)");
    assert.ok(healthAt > 0 && hostGateAt > 0);
    assert.ok(
      healthAt < hostGateAt,
      "an orchestrator must be able to probe health without a token",
    );
  });

  it("caps concurrent sessions and reaps idle ones", () => {
    assert.match(httpEntry, /sessions\.size >= MAX_SESSIONS/);
    assert.match(httpEntry, /Retry-After/);
    assert.match(httpEntry, /reaper\.unref\(\)/);
  });
});

describe("transport selection", () => {
  it("emits no HTTP machinery for the stdio transport", () => {
    assert.ok(!stdioEntry.includes("MCP_AUTH_TOKEN"));
    assert.ok(!stdioEntry.includes("ALLOWED_HOSTS"));
    assert.match(stdioEntry, /StdioServerTransport/);
  });

  it("builds a server per session for http, since one cannot back two transports", () => {
    assert.match(httpEntry, /function createMcpServer\(\)/);
    assert.match(httpEntry, /const server = createMcpServer\(\);/);
  });
});
