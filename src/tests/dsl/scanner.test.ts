import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DslScanner } from "../../dsl/scanner.js";
import { DslParseError } from "../../dsl/types.js";

describe("DslScanner", () => {
  it("lineNumber starts at 1", () => {
    const s = new DslScanner("hello\nworld");
    assert.equal(s.lineNumber, 1);
  });

  it("isEof is false for non-empty input", () => {
    const s = new DslScanner("content");
    assert.equal(s.isEof(), false);
  });

  it("isEof becomes true after all lines consumed", () => {
    const s = new DslScanner("one\ntwo");
    s.consumeLine();
    s.consumeLine();
    assert.equal(s.isEof(), true);
  });

  it("peekLine returns current line without advancing", () => {
    const s = new DslScanner("first\nsecond");
    assert.equal(s.peekLine(), "first");
    assert.equal(s.peekLine(), "first");
    assert.equal(s.lineNumber, 1);
  });

  it("peekLine returns empty string when at EOF", () => {
    const s = new DslScanner("only");
    s.consumeLine();
    assert.equal(s.peekLine(), "");
  });

  it("consumeLine returns lines in order and advances position", () => {
    const s = new DslScanner("a\nb\nc");
    assert.equal(s.consumeLine(), "a");
    assert.equal(s.lineNumber, 2);
    assert.equal(s.consumeLine(), "b");
    assert.equal(s.lineNumber, 3);
    assert.equal(s.consumeLine(), "c");
    assert.equal(s.isEof(), true);
  });

  it("consumeLine throws DslParseError at EOF", () => {
    const s = new DslScanner("only");
    s.consumeLine();
    assert.throws(
      () => s.consumeLine(),
      (err: unknown) =>
        err instanceof DslParseError &&
        /Unexpected end of input/.test(err.message),
    );
  });

  it("skipBlanks advances past empty lines", () => {
    const s = new DslScanner("\n\n\nCONTENT");
    s.skipBlanks();
    assert.equal(s.peekLine(), "CONTENT");
    assert.equal(s.lineNumber, 4);
  });

  it("skipBlanks advances past comment lines", () => {
    const s = new DslScanner("# comment one\n# comment two\nCONTENT");
    s.skipBlanks();
    assert.equal(s.peekLine(), "CONTENT");
    assert.equal(s.lineNumber, 3);
  });

  it("skipBlanks advances past interleaved blanks and comments", () => {
    const s = new DslScanner("\n# comment\n\n# another\nACTUAL");
    s.skipBlanks();
    assert.equal(s.peekLine(), "ACTUAL");
    assert.equal(s.lineNumber, 5);
  });

  it("skipBlanks does nothing when already at meaningful content", () => {
    const s = new DslScanner("MEANINGFUL");
    s.skipBlanks();
    assert.equal(s.peekLine(), "MEANINGFUL");
    assert.equal(s.lineNumber, 1);
  });

  it("skipBlanks reaches EOF when only blanks and comments remain", () => {
    const s = new DslScanner("\n# comment\n");
    s.skipBlanks();
    assert.equal(s.isEof(), true);
  });

  it("consumeHeredoc collects lines until >>> marker", () => {
    const s = new DslScanner("line one\nline two\n>>>\nafter");
    const result = s.consumeHeredoc();
    assert.equal(result, "line one\nline two");
    assert.equal(s.peekLine(), "after");
  });

  it("consumeHeredoc returns empty string for immediate >>>", () => {
    const s = new DslScanner(">>>\nrest");
    const result = s.consumeHeredoc();
    assert.equal(result, "");
    assert.equal(s.peekLine(), "rest");
  });

  it("consumeHeredoc detects >>> with surrounding whitespace", () => {
    const s = new DslScanner("content\n   >>>   \nafter");
    const result = s.consumeHeredoc();
    assert.equal(result, "content");
  });

  it("consumeHeredoc preserves indentation in collected lines", () => {
    const s = new DslScanner("  indented\n    more\n>>>");
    const result = s.consumeHeredoc();
    assert.equal(result, "  indented\n    more");
  });

  it("consumeHeredoc normalizes triple braces to double", () => {
    const s = new DslScanner("{{{params.x}}}\n>>>");
    const result = s.consumeHeredoc();
    assert.equal(result, "{{params.x}}");
  });

  it("consumeHeredoc normalizes quadruple+ braces to double", () => {
    const s = new DslScanner("{{{{value}}}}\n>>>");
    const result = s.consumeHeredoc();
    assert.equal(result, "{{value}}");
  });

  it("consumeHeredoc leaves double braces untouched", () => {
    const s = new DslScanner("{{normal}}\n>>>");
    const result = s.consumeHeredoc();
    assert.equal(result, "{{normal}}");
  });

  it("consumeHeredoc throws on unterminated input", () => {
    const s = new DslScanner("line one\nline two");
    assert.throws(
      () => s.consumeHeredoc(5),
      (err: unknown) =>
        err instanceof DslParseError &&
        err.line === 5 &&
        /Unterminated heredoc/.test(err.message),
    );
  });

  it("consumeHeredoc uses current lineNumber as default startLine", () => {
    const s = new DslScanner("filler\nline one\nline two");
    s.consumeLine();
    assert.throws(
      () => s.consumeHeredoc(),
      (err: unknown) => err instanceof DslParseError && err.line === 2,
    );
  });

  it("err throws DslParseError with current line number", () => {
    const s = new DslScanner("a\nb\nc");
    s.consumeLine();
    s.consumeLine();
    assert.throws(
      () => s.err("something went wrong"),
      (err: unknown) =>
        err instanceof DslParseError &&
        err.line === 3 &&
        /something went wrong/.test(err.message),
    );
  });
});
