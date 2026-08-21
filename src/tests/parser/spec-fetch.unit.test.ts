import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertSafeSpecUrl,
  dereferenceSpec,
  fetchSpecContent,
  MAX_FETCH_RETRIES,
  MAX_SPEC_BYTES,
} from "../../parser/spec-fetch.js";

/** The trust boundary: `$ref`s fetched unchecked, and a `file://` `$ref` past the allowlist. */

/** Start a loopback server; the caller must close it. */
async function serve(
  handler: (url: string) => {
    status?: number;
    body: string;
    headers?: Record<string, string>;
  },
): Promise<{ origin: string; srv: Server; hits: () => string[] }> {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(req.url ?? "");
    const r = handler(req.url ?? "");
    res.writeHead(r.status ?? 200, {
      "content-type": "application/json",
      ...(r.headers ?? {}),
    });
    res.end(r.body);
  });
  await new Promise<void>((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (srv.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, srv, hits: () => hits };
}

/** A minimal OpenAPI 3 document whose request-body schema is a single `$ref`. */
function specRefencing(ref: string): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "T", version: "1.0.0" },
    paths: {
      "/x": {
        post: {
          operationId: "x",
          tags: ["x"],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: ref } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
}

describe("assertSafeSpecUrl", () => {
  it("accepts http and https", () => {
    assert.equal(
      assertSafeSpecUrl("https://api.example.com/o.json").protocol,
      "https:",
    );
    assert.equal(
      assertSafeSpecUrl("http://127.0.0.1:8080/o.json").protocol,
      "http:",
    );
  });

  it("rejects a non-http scheme", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:application/json,{}",
      "ftp://example.com/spec.json",
    ]) {
      assert.throws(
        () => assertSafeSpecUrl(url),
        /Unsupported spec URL scheme/,
      );
    }
  });

  it("rejects an unparseable URL", () => {
    assert.throws(() => assertSafeSpecUrl("not a url"), /Invalid spec URL/);
  });

  it("rejects link-local hosts, which serve cloud instance metadata", () => {
    // Private ranges stay allowed, but no OpenAPI document lives at a metadata endpoint.
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.1.2/spec.json",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      assert.throws(() => assertSafeSpecUrl(url), /link-local/);
    }
  });

  it("still allows loopback and private hosts", () => {
    assert.doesNotThrow(() =>
      assertSafeSpecUrl("http://localhost:3000/spec.json"),
    );
    assert.doesNotThrow(() => assertSafeSpecUrl("http://10.0.0.5/spec.json"));
    assert.doesNotThrow(() =>
      assertSafeSpecUrl("http://192.168.1.10/spec.json"),
    );
  });
});

describe("$ref resolution is confined", () => {
  it("refuses a $ref pointing at another origin, and never contacts it", async () => {
    const internal = await serve(() => ({
      body: JSON.stringify({
        type: "object",
        properties: { SECRET: { type: "string" } },
      }),
    }));
    const outer = await serve(() => ({
      body: specRefencing(`${internal.origin}/internal-secret.json`),
    }));
    try {
      await assert.rejects(
        () => dereferenceSpec(`${outer.origin}/openapi.json`),
        /different origin/,
        "a cross-origin $ref must be refused with a message that says why",
      );
      assert.deepEqual(
        internal.hits(),
        [],
        "the other origin must never be contacted",
      );
    } finally {
      internal.srv.close();
      outer.srv.close();
    }
  });

  it("resolves a cross-origin $ref when the caller opts in", async () => {
    const internal = await serve(() => ({
      body: JSON.stringify({
        type: "object",
        properties: { shared: { type: "string" } },
      }),
    }));
    const outer = await serve(() => ({
      body: specRefencing(`${internal.origin}/fragment.json`),
    }));
    try {
      const spec = await dereferenceSpec(`${outer.origin}/openapi.json`, {
        allowCrossOriginRefs: true,
      });
      assert.match(JSON.stringify(spec), /shared/);
      assert.equal(internal.hits().length, 1);
    } finally {
      internal.srv.close();
      outer.srv.close();
    }
  });

  it("refuses a file:// $ref and does not read the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpgen-ref-"));
    const secret = join(dir, "secret.json");
    writeFileSync(
      secret,
      JSON.stringify({ type: "string", title: "LEAKED" }),
      "utf-8",
    );
    const outer = await serve(() => ({
      body: specRefencing(pathToFileURL(secret).href),
    }));
    try {
      let text = "";
      await assert.rejects(async () => {
        const spec = await dereferenceSpec(`${outer.origin}/openapi.json`);
        text = JSON.stringify(spec);
      });
      assert.ok(
        !text.includes("LEAKED"),
        "local file contents must never reach the dereferenced spec",
      );
    } finally {
      outer.srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still resolves internal and same-origin refs", async () => {
    const srv = await serve((url) =>
      url.includes("fragment")
        ? {
            body: JSON.stringify({
              type: "object",
              properties: { fromFragment: { type: "string" } },
            }),
          }
        : {
            body: JSON.stringify({
              openapi: "3.0.0",
              info: { title: "T", version: "1.0.0" },
              paths: {
                "/a": {
                  post: {
                    operationId: "a",
                    tags: ["a"],
                    requestBody: {
                      required: true,
                      content: {
                        "application/json": {
                          schema: { $ref: "./fragment.json" },
                        },
                      },
                    },
                    responses: {
                      "200": {
                        description: "ok",
                        content: {
                          "application/json": {
                            schema: { $ref: "#/components/schemas/Internal" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              components: {
                schemas: {
                  Internal: {
                    type: "object",
                    properties: { fromInternal: { type: "string" } },
                  },
                },
              },
            }),
          },
    );
    try {
      const spec = JSON.stringify(
        await dereferenceSpec(`${srv.origin}/openapi.json`),
      );
      assert.match(
        spec,
        /fromFragment/,
        "a same-origin relative ref must resolve",
      );
      assert.match(
        spec,
        /fromInternal/,
        "an internal #/components ref must resolve",
      );
    } finally {
      srv.srv.close();
    }
  });
});

describe("retry policy is decided by HTTP status, not by the error text", () => {
  it("fails a 404 fast even when the URL contains a retryable status number", async () => {
    // The message embeds the URL, so a bare status number matched a 404 at a path with "502".
    for (const path of [
      "/openapi.json",
      "/v502/openapi.json",
      "/api/429/spec.json",
    ]) {
      const srv = await serve(() => ({ status: 404, body: "nope" }));
      try {
        await assert.rejects(
          () => fetchSpecContent(`${srv.origin}${path}`),
          /HTTP 404/,
        );
        assert.equal(
          srv.hits().length,
          1,
          `a 404 at ${path} must be attempted exactly once`,
        );
      } finally {
        srv.srv.close();
      }
    }
  });

  it("does not retry other permanent statuses", async () => {
    for (const status of [400, 401, 403, 410]) {
      const srv = await serve(() => ({ status, body: "no" }));
      try {
        await assert.rejects(() => fetchSpecContent(`${srv.origin}/spec.json`));
        assert.equal(
          srv.hits().length,
          1,
          `HTTP ${status} must not be retried`,
        );
      } finally {
        srv.srv.close();
      }
    }
  });

  it("retries a transient status", async () => {
    const srv = await serve(() => ({ status: 503, body: "later" }));
    try {
      await assert.rejects(() => fetchSpecContent(`${srv.origin}/spec.json`));
      assert.equal(
        srv.hits().length,
        MAX_FETCH_RETRIES + 1,
        "a 503 must be retried up to the configured limit",
      );
    } finally {
      srv.srv.close();
    }
  });
});

describe("response size is bounded", () => {
  it("rejects a body that declares an oversized content-length", async () => {
    const srv = await serve(() => ({
      body: "{}",
      headers: { "content-length": String(MAX_SPEC_BYTES + 1) },
    }));
    try {
      await assert.rejects(
        () => fetchSpecContent(`${srv.origin}/big.json`),
        /over the .* limit/,
      );
    } finally {
      srv.srv.close();
    }
  });

  it("abandons a chunked body that grows past the cap", async () => {
    // With no content-length there is nothing to check up front, so measure the stream.
    const chunk = "x".repeat(1024 * 1024);
    const total = Math.ceil(MAX_SPEC_BYTES / chunk.length) + 2;
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let sent = 0;
      const push = () => {
        if (sent++ >= total) return res.end();
        if (res.write(chunk)) setImmediate(push);
        else res.once("drain", push);
      };
      push();
    });
    await new Promise<void>((resolve) =>
      srv.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (srv.address() as { port: number }).port;
    try {
      await assert.rejects(
        () => fetchSpecContent(`http://127.0.0.1:${port}/big.json`),
        /exceeds the .* limit/,
      );
    } finally {
      srv.close();
    }
  });

  it("reads a body under the cap intact, including multi-byte characters", async () => {
    // Manual decoding means owning UTF-8 reassembly across chunk boundaries.
    const payload = JSON.stringify({
      note: "héllo wörld — 日本語 🎉".repeat(2000),
    });
    const buf = Buffer.from(payload, "utf8");
    const step = 1023; // not a multiple of any character width
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let i = 0;
      const push = () => {
        if (i >= buf.length) return res.end();
        const slice = buf.subarray(i, i + step);
        i += step;
        if (res.write(slice)) setImmediate(push);
        else res.once("drain", push);
      };
      push();
    });
    await new Promise<void>((resolve) =>
      srv.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (srv.address() as { port: number }).port;
    try {
      const text = await fetchSpecContent(`http://127.0.0.1:${port}/spec.json`);
      assert.equal(text, payload);
    } finally {
      srv.close();
    }
  });
});
