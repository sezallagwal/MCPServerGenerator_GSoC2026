import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DslParseError, parseDsl } from "../../dsl/index.js";

describe("parseDsl", () => {
  it("parses a minimal project with one workflow and one step", () => {
    const dsl = `
PROJECT my-bot
DESCRIPTION A simple bot

WORKFLOW greet
  DESCRIPTION Greets users

  STEP say_hi : api_call
    LABEL Say Hi
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #general
    MAP text = Hello!
`;
    const result = parseDsl(dsl);
    assert.equal(result.projectName, "my-bot");
    assert.equal(result.description, "A simple bot");
    assert.equal(result.workflows.length, 1);
    assert.equal(result.workflows[0].name, "greet");
    assert.equal(result.workflows[0].description, "Greets users");
    assert.equal(result.workflows[0].steps.length, 1);

    const step = result.workflows[0].steps[0];
    assert.equal(step.id, "say_hi");
    assert.equal(step.type, "api_call");
    assert.equal(step.label, "Say Hi");
    assert.equal(step.operationId, "post-api-v1-chat_postMessage");
    assert.deepEqual(step.inputMapping, {
      channel: "#general",
      text: "Hello!",
    });
  });

  it("parses PARAM declarations into workflow params", () => {
    const dsl = `
PROJECT param-test
DESCRIPTION Tests PARAM syntax

WORKFLOW search
  DESCRIPTION Search rooms
  PARAM query : string : The search query
  PARAM room_id : string : The room to search in
  PARAM limit : number : Max results

  STEP do_search : api_call
    OPERATION get-api-v1-chat_search
    MAP roomId = {{params.room_id}}
    MAP searchText = {{params.query}}
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows.length, 1);
    const wf = result.workflows[0];
    assert.ok(wf.params);
    const props = wf.params!.properties;
    assert.deepEqual(props.query, {
      type: "string",
      description: "The search query",
    });
    assert.deepEqual(props.room_id, {
      type: "string",
      description: "The room to search in",
    });
    assert.deepEqual(props.limit, {
      type: "number",
      description: "Max results",
    });
  });

  it("parses PARAM without description", () => {
    const dsl = `
PROJECT param-test2
DESCRIPTION Minimal params

WORKFLOW w
  DESCRIPTION test
  PARAM flag : boolean

  STEP s : transform
    EXPRESSION true
`;
    const result = parseDsl(dsl);
    const props = result.workflows[0].params!.properties;
    assert.deepEqual(props.flag, { type: "boolean" });
  });

  it("rejects PARAM with invalid type", () => {
    const dsl = `
PROJECT param-test3
DESCRIPTION Bad type

WORKFLOW w
  DESCRIPTION test
  PARAM x : integer

  STEP s : transform
    EXPRESSION true
`;
    assert.throws(() => parseDsl(dsl), /PARAM type "integer" invalid/);
  });

  it("rejects PARAM without a colon separator", () => {
    const dsl = `
PROJECT param-test4
DESCRIPTION Missing colon

WORKFLOW w
  DESCRIPTION test
  PARAM query

  STEP s : transform
    EXPRESSION true
`;
    assert.throws(() => parseDsl(dsl), /PARAM requires format/);
  });

  it("rejects PARAM with empty name before colon", () => {
    const dsl = `
PROJECT param-test5
DESCRIPTION Empty param name

WORKFLOW w
  DESCRIPTION test
  PARAM : string

  STEP s : transform
    EXPRESSION true
`;
    assert.throws(() => parseDsl(dsl), /PARAM requires a name before ':'/);
  });

  it("reconstructs nested objects from MAP dot-paths", () => {
    const dsl = `
PROJECT map-test
DESCRIPTION Tests MAP syntax

WORKFLOW w
  DESCRIPTION test

  STEP send : api_call
    OPERATION post-api-v1-chat_sendMessage
    MAP message.rid = {{params.room.id}}
    MAP message.msg = Hello
    MAP message.tmid = {{params.threadId}}
`;
    const result = parseDsl(dsl);
    assert.deepEqual(result.workflows[0].steps[0].inputMapping, {
      message: {
        rid: "{{params.room.id}}",
        msg: "Hello",
        tmid: "{{params.threadId}}",
      },
    });
  });

  it("infers correct types for MAP values", () => {
    const dsl = `
PROJECT type-test
DESCRIPTION Tests value type inference

WORKFLOW w
  DESCRIPTION test

  STEP call : api_call
    OPERATION get-api-v1-channels_list
    MAP count = 5
    MAP sort = {"msgs": -1}
    MAP active = true
    MAP name = {{params.query}}
    MAP items = ["a", "b"]
`;
    const result = parseDsl(dsl);
    const mapping = result.workflows[0].steps[0].inputMapping!;
    assert.equal(mapping.count, 5);
    assert.deepEqual(mapping.sort, { msgs: -1 });
    assert.equal(mapping.active, true);
    assert.equal(mapping.name, "{{params.query}}");
    assert.deepEqual(mapping.items, ["a", "b"]);
  });

  it("parses heredoc expressions", () => {
    const dsl = `
PROJECT heredoc-test
DESCRIPTION Tests heredoc

WORKFLOW w
  DESCRIPTION test

  STEP merge : transform
    EXPRESSION <<<
      const a = steps.first || [];
      const b = steps.second || [];
      return [...a, ...b]
    >>>
`;
    const result = parseDsl(dsl);
    const expr = result.workflows[0].steps[0].expression!;
    assert.ok(expr.includes("const a = steps.first || [];"));
    assert.ok(expr.includes("return [...a, ...b]"));
  });

  it("parses heredoc prompts", () => {
    const dsl = `
PROJECT heredoc-test
DESCRIPTION Tests heredoc prompt

WORKFLOW w
  DESCRIPTION test

  STEP ask : sampling
    PROMPT <<<
      Query: {{params.query}}
      Results: {{steps.search}}
    >>>
    MAX_TOKENS 500
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.ok(step.prompt!.includes("Query: {{params.query}}"));
    assert.ok(step.prompt!.includes("Results: {{steps.search}}"));
    assert.equal(step.maxTokens, 500);
  });

  it("parses DEPENDS ON with multiple steps", () => {
    const dsl = `
PROJECT deps-test
DESCRIPTION Test dependencies

WORKFLOW w
  DESCRIPTION test

  STEP root : transform
    EXPRESSION true

  STEP a : transform
    DEPENDS ON root
    EXPRESSION 1

  STEP b : transform
    DEPENDS ON root a
    EXPRESSION 2
`;
    const result = parseDsl(dsl);
    assert.deepEqual(result.workflows[0].steps[1].dependsOn, ["root"]);
    assert.deepEqual(result.workflows[0].steps[2].dependsOn, ["root", "a"]);
  });

  it("parses conditional with THEN and ELSE", () => {
    const dsl = `
PROJECT cond-test
DESCRIPTION Test conditional

WORKFLOW w
  DESCRIPTION test

  STEP check : transform
    EXPRESSION true

  STEP gate : conditional
    DEPENDS ON check
    CONDITION steps.check === true
    THEN handle_yes
    ELSE handle_no

  STEP handle_yes : api_call
    DEPENDS ON gate
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #general
    MAP text = Yes

  STEP handle_no : api_call
    DEPENDS ON gate
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #general
    MAP text = No
`;
    const result = parseDsl(dsl);
    const gate = result.workflows[0].steps[1];
    assert.equal(gate.type, "conditional");
    assert.equal(gate.condition, "steps.check === true");
    assert.equal(gate.thenStep, "handle_yes");
    assert.equal(gate.elseStep, "handle_no");
  });

  it("parses conditional with THEN only (no ELSE)", () => {
    const dsl = `
PROJECT cond-test
DESCRIPTION Test conditional no else

WORKFLOW w
  DESCRIPTION test

  STEP check : transform
    EXPRESSION true

  STEP gate : conditional
    DEPENDS ON check
    CONDITION steps.check !== null
    THEN proceed

  STEP proceed : transform
    DEPENDS ON gate
    EXPRESSION "continuing"
`;
    const result = parseDsl(dsl);
    const gate = result.workflows[0].steps[1];
    assert.equal(gate.thenStep, "proceed");
    assert.equal(gate.elseStep, undefined);
  });

  it("parses sampling with systemPrompt, responseFormat, maxTokens", () => {
    const dsl = `
PROJECT sampling-test
DESCRIPTION Test sampling

WORKFLOW w
  DESCRIPTION test

  STEP analyze : sampling
    SYSTEM_PROMPT You are an analyst.
    PROMPT Analyze: {{params.query}}
    RESPONSE_FORMAT json
    MAX_TOKENS 2000
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.equal(step.type, "sampling");
    assert.equal(step.systemPrompt, "You are an analyst.");
    assert.equal(step.prompt, "Analyze: {{params.query}}");
    assert.equal(step.responseFormat, "json");
    assert.equal(step.maxTokens, 2000);
  });

  it("parses CONTENT_TEXT and CONTENT_IMAGE", () => {
    const dsl = `
PROJECT content-test
DESCRIPTION Test content array

WORKFLOW w
  DESCRIPTION test

  STEP analyze : sampling
    CONTENT_TEXT Does this image violate content policy?
    CONTENT_IMAGE {{steps.extract}}
    RESPONSE_FORMAT json
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.deepEqual(step.content, [
      { type: "text", text: "Does this image violate content policy?" },
      { type: "image", url: "{{steps.extract}}" },
    ]);
  });

  it("parses elicitation with SCHEMA and ON_DECLINE", () => {
    const dsl = `
PROJECT elicit-test
DESCRIPTION Test elicitation

WORKFLOW w
  DESCRIPTION test

  STEP ask : elicitation
    MESSAGE How should I format the results?
    SCHEMA {"type":"object","properties":{"format":{"type":"string","enum":["brief","detailed"]}},"required":["format"]}
    ON_DECLINE skip_remaining
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.equal(step.type, "elicitation");
    assert.equal(step.message, "How should I format the results?");
    assert.deepEqual(step.requestedSchema, {
      type: "object",
      properties: {
        format: { type: "string", enum: ["brief", "detailed"] },
      },
      required: ["format"],
    });
    assert.equal(step.onDecline, "skip_remaining");
  });

  it("parses FOR_EACH and AS", () => {
    const dsl = `
PROJECT loop-test
DESCRIPTION Test forEach

WORKFLOW w
  DESCRIPTION test

  STEP get_items : api_call
    OPERATION get-api-v1-channels_list

  STEP process : api_call
    DEPENDS ON get_items
    OPERATION get-api-v1-chat_getPinnedMessages
    FOR_EACH {{steps.get_items.channels}}
    AS chan
    MAP roomId = {{chan._id}}
    MAP count = 20
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[1];
    assert.equal(step.forEach, "{{steps.get_items.channels}}");
    assert.equal(step.as, "chan");
  });

  it("parses WEBHOOK endpoints", () => {
    const dsl = `
PROJECT webhook-test
DESCRIPTION Test webhooks

WORKFLOW w
  DESCRIPTION test

  STEP noop : transform
    EXPRESSION true

WEBHOOK /incoming-alert
  DESCRIPTION Receives external alert payloads
  METHODS post

WEBHOOK /status
  DESCRIPTION Health check
  METHODS get post
`;
    const result = parseDsl(dsl);
    assert.equal(result.webhookEndpoints!.length, 2);
    assert.equal(result.webhookEndpoints![0].path, "/incoming-alert");
    assert.equal(
      result.webhookEndpoints![0].description,
      "Receives external alert payloads",
    );
    assert.deepEqual(result.webhookEndpoints![0].methods, ["post"]);
    assert.deepEqual(result.webhookEndpoints![1].methods, ["get", "post"]);
  });

  it("ignores comments and blank lines", () => {
    const dsl = `
# This is a comment
PROJECT comment-test
DESCRIPTION Test comments

# Another comment
WORKFLOW w
  DESCRIPTION test

  # Step comment
  STEP noop : transform
    EXPRESSION true
`;
    const result = parseDsl(dsl);
    assert.equal(result.projectName, "comment-test");
    assert.equal(result.workflows[0].steps.length, 1);
  });

  it("parses multiple workflows in one DSL", () => {
    const dsl = `
PROJECT multi-test
DESCRIPTION Multiple workflows

WORKFLOW first
  DESCRIPTION First workflow

  STEP a : transform
    EXPRESSION 1

WORKFLOW second
  DESCRIPTION Second workflow

  STEP b : transform
    EXPRESSION 2

WORKFLOW third
  DESCRIPTION Third workflow

  STEP c : transform
    EXPRESSION 3
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows.length, 3);
    assert.equal(result.workflows[0].name, "first");
    assert.equal(result.workflows[1].name, "second");
    assert.equal(result.workflows[2].name, "third");
  });

  it("parses the full kb_search example", () => {
    const dsl = `
PROJECT team-hub
DESCRIPTION Knowledge-base search via slash command and image moderation

WORKFLOW kb_search
  DESCRIPTION Search pinned and matched messages, AI-rank, confirm, reply


  STEP get_channels : api_call
    LABEL Fetch Top Channels
    OPERATION get-api-v1-channels_list
    MAP count = 5
    MAP sort = {"msgs": -1}

  STEP fetch_pinned : api_call
    LABEL Get Pinned Per Channel
    DEPENDS ON get_channels
    OPERATION get-api-v1-chat_getPinnedMessages
    FOR_EACH {{steps.get_channels.channels}}
    AS channel
    MAP roomId = {{channel._id}}
    MAP count = 20

  STEP search_msgs : api_call
    LABEL Search Per Channel
    DEPENDS ON get_channels
    OPERATION get-api-v1-chat_search
    FOR_EACH {{steps.get_channels.channels}}
    AS ch
    MAP roomId = {{ch._id}}
    MAP searchText = {{params.query}}
    MAP count = 10

  STEP merge : transform
    LABEL Merge All Results
    DEPENDS ON fetch_pinned search_msgs
    EXPRESSION <<<
      const pinned = (steps.fetch_pinned || []).flatMap(r => r?.messages || []);
      const searched = (steps.search_msgs || []).flatMap(r => r?.messages || []);
      return [...pinned, ...searched].map(m => ({ id: m._id, text: m.msg, author: m.u?.username, room: m.rid }))
    >>>

  STEP rank : sampling
    LABEL AI-Rank Results
    DEPENDS ON merge
    SYSTEM_PROMPT You are a knowledge-base search assistant. Rank results by relevance.
    PROMPT <<<
      Query: {{params.query}}
      Candidate messages:
      {{steps.merge}}
      Return JSON: { results: [{ id, text, author, room, score }], hasRelevant: boolean }
    >>>
    RESPONSE_FORMAT json
    MAX_TOKENS 2000

  STEP check_found : conditional
    LABEL Any Relevant?
    DEPENDS ON rank
    CONDITION steps.rank.hasRelevant === true
    THEN ask_format
    ELSE suggest_help

  STEP ask_format : elicitation
    LABEL Ask User Preferences
    DEPENDS ON check_found
    MESSAGE Found results. How should I present them?
    SCHEMA {"type":"object","properties":{"format":{"type":"string","enum":["brief","detailed"]},"maxResults":{"type":"number"}},"required":["format"]}
    ON_DECLINE skip_remaining

  STEP compile : sampling
    LABEL Compile Final Answer
    DEPENDS ON ask_format
    PROMPT <<<
      User wants a {{steps.ask_format.format ?? "brief"}} summary.
      Compile the top {{steps.ask_format.maxResults ?? 3}} results:
      {{steps.rank.results}}
    >>>

  STEP reply_thread : api_call
    LABEL Reply in Thread
    DEPENDS ON compile
    OPERATION post-api-v1-chat_sendMessage
    MAP message.rid = {{params.room.id}}
    MAP message.msg = {{steps.compile}}
    MAP message.tmid = {{params.threadId}}

  STEP log_search : api_call
    LABEL Log to Channel
    DEPENDS ON compile
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #kb-activity
    MAP text = Search by @{{params.sender.username}}: {{params.query}}

  STEP save_state : transform
    LABEL Update History
    DEPENDS ON compile
    EXPRESSION ({ queries: [...(params.searchHistory?.queries || []).slice(-9), params.query] })

  STEP suggest_help : api_call
    LABEL Suggest Help
    DEPENDS ON check_found
    OPERATION post-api-v1-chat_sendMessage
    MAP message.rid = {{params.room.id}}
    MAP message.msg = No results for "{{params.query}}". Try #help.
    MAP message.tmid = {{params.threadId}}
`;
    const result = parseDsl(dsl);
    assert.equal(result.projectName, "team-hub");
    assert.equal(result.workflows.length, 1);

    const wf = result.workflows[0];
    assert.equal(wf.name, "kb_search");
    assert.equal(wf.steps.length, 12);

    const replyThread = wf.steps.find((s) => s.id === "reply_thread")!;
    assert.deepEqual(replyThread.inputMapping, {
      message: {
        rid: "{{params.room.id}}",
        msg: "{{steps.compile}}",
        tmid: "{{params.threadId}}",
      },
    });

    const fetchPinned = wf.steps.find((s) => s.id === "fetch_pinned")!;
    assert.equal(fetchPinned.forEach, "{{steps.get_channels.channels}}");
    assert.equal(fetchPinned.as, "channel");

    const checkFound = wf.steps.find((s) => s.id === "check_found")!;
    assert.equal(checkFound.thenStep, "ask_format");
    assert.equal(checkFound.elseStep, "suggest_help");

    const askFormat = wf.steps.find((s) => s.id === "ask_format")!;
    assert.ok(askFormat.requestedSchema);
    assert.equal(askFormat.onDecline, "skip_remaining");
  });

  describe("error cases", () => {
    it("throws on workflow with zero steps", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW empty
  DESCRIPTION does nothing
`;
      assert.throws(
        () => parseDsl(dsl),
        /WORKFLOW "empty" has no STEP declarations/,
      );
    });

    it("throws on duplicate workflow names", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW search
  DESCRIPTION First search
  STEP a : transform
    EXPRESSION 1

WORKFLOW search
  DESCRIPTION Second search
  STEP b : transform
    EXPRESSION 2
`;
      assert.throws(() => parseDsl(dsl), /Duplicate WORKFLOW name "search"/);
    });

    it("throws when THEN references non-existent step", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP gate : conditional
    CONDITION true
    THEN ghost_step
`;
      assert.throws(
        () => parseDsl(dsl),
        /THEN references unknown step "ghost_step"/,
      );
    });

    it("throws when ELSE references non-existent step", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP a : transform
    EXPRESSION true
  STEP gate : conditional
    CONDITION true
    THEN a
    ELSE ghost_step
`;
      assert.throws(
        () => parseDsl(dsl),
        /ELSE references unknown step "ghost_step"/,
      );
    });

    it("throws when DEPENDS ON references non-existent step", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP a : transform
    DEPENDS ON phantom
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /DEPENDS ON unknown step "phantom"/);
    });

    it("throws on MAP with empty value after =", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP key =
`;
      assert.throws(
        () => parseDsl(dsl),
        /MAP "key" requires a value after '='/,
      );
    });

    it("throws on missing PROJECT", () => {
      const dsl = `
WORKFLOW w
  DESCRIPTION test
  STEP noop : transform
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Missing PROJECT/);
    });

    it("throws on missing DESCRIPTION", () => {
      const dsl = `
PROJECT test
WORKFLOW w
  DESCRIPTION test
  STEP noop : transform
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Missing project DESCRIPTION/);
    });

    it("throws on no workflows", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
`;
      assert.throws(() => parseDsl(dsl), /No WORKFLOW/);
    });

    it("throws on invalid step type", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP bad : unknown_type
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Unknown step type/);
    });

    it("throws on extra text after STEP type", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP bad : api_call some text
    OPERATION op
`;
      assert.throws(
        () => parseDsl(dsl),
        /Unexpected text "some text" after step type "api_call"/,
      );
    });

    it("throws on unterminated heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION <<<
      some code here
`;
      assert.throws(() => parseDsl(dsl), /Unterminated heredoc/);
    });

    it("reports unterminated heredoc at the heredoc start line", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION <<<
      some code here
`;
      assert.throws(
        () => parseDsl(dsl),
        (error: unknown) =>
          error instanceof DslParseError &&
          error.line === 7 &&
          /Unterminated heredoc/.test(error.message),
      );
    });

    it("throws on STEP without colon separator", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP bad_step transform
`;
      assert.throws(() => parseDsl(dsl), /STEP requires format/);
    });

    it("throws on invalid SCHEMA JSON", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP ask : elicitation
    MESSAGE test
    SCHEMA {not valid json}
`;
      assert.throws(() => parseDsl(dsl), /SCHEMA value must be valid JSON/);
    });

    it("throws on bare EXPRESSION", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION
`;
      assert.throws(() => parseDsl(dsl), /EXPRESSION requires/);
    });

    it("throws on DESCRIPTION inside a step", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    DESCRIPTION This should be a label
`;
      assert.throws(
        () => parseDsl(dsl),
        /DESCRIPTION is not valid inside a STEP/,
      );
    });

    it("throws on duplicate OPERATION in a step", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION first
    OPERATION second
`;
      assert.throws(() => parseDsl(dsl), /Duplicate OPERATION/);
    });

    it("throws on duplicate PARAM in a workflow", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  PARAM query : string : first
  PARAM query : string : second
  STEP t : transform
    EXPRESSION true
`;
      assert.throws(
        () => parseDsl(dsl),
        /Duplicate PARAM "query" in workflow "w"/,
      );
    });

    it("throws on duplicate DESCRIPTION in a workflow", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION first
  DESCRIPTION second
  STEP t : transform
    EXPRESSION true
`;
      assert.throws(
        () => parseDsl(dsl),
        /Duplicate DESCRIPTION in workflow "w"/,
      );
    });

    it("throws on duplicate step IDs within a workflow", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP dup : transform
    EXPRESSION 1
  STEP dup : transform
    EXPRESSION 2
`;
      assert.throws(() => parseDsl(dsl), /Duplicate step ID "dup"/);
    });

    it("throws on MAP with heredoc syntax", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION test-op
    MAP body = <<<
`;
      assert.throws(() => parseDsl(dsl), /MAP does not support heredoc/);
    });

    it("throws on MAP without equals sign", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP channelGeneral
`;
      assert.throws(() => parseDsl(dsl), /MAP requires format/);
    });

    it("throws on MAP with empty field path before =", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP = someValue
`;
      assert.throws(() => parseDsl(dsl), /MAP requires a field path/);
    });

    it("throws on STEP with empty id before colon", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP : transform
`;
      assert.throws(() => parseDsl(dsl), /STEP requires an id/);
    });

    it("throws on STEP with empty type after colon", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP myStep :
`;
      assert.throws(() => parseDsl(dsl), /STEP requires a type/);
    });

    it("throws on MAX_TOKENS with non-numeric value", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : sampling
    PROMPT question
    MAX_TOKENS lots
`;
      assert.throws(() => parseDsl(dsl), /MAX_TOKENS must be a number/);
    });

    it("throws on duplicate DESCRIPTION at project level", () => {
      const dsl = `
PROJECT test
DESCRIPTION first description
DESCRIPTION second description
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
`;
      assert.throws(
        () => parseDsl(dsl),
        /Duplicate DESCRIPTION at project level/,
      );
    });

    it("throws on bare WORKFLOW keyword (no name) at root level", () => {
      // Note: "WORKFLOW" without trailing content doesn't match startsWith("WORKFLOW "),
      // so it falls through to the root-level unknown content error.
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW
`;
      assert.throws(() => parseDsl(dsl), /Unexpected content at root level/);
    });

    it("throws on bare WEBHOOK keyword (no path) consumed by step parser", () => {
      // Note: "WEBHOOK" without trailing content doesn't match startsWith("WEBHOOK "),
      // so the step parser sees it as an unknown keyword inside the preceding workflow.
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
WEBHOOK
`;
      assert.throws(() => parseDsl(dsl), /Unknown keyword "WEBHOOK"/);
    });

    it("throws on invalid webhook method", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
WEBHOOK /hook
  DESCRIPTION test hook
  METHODS put
`;
      assert.throws(() => parseDsl(dsl), /Invalid HTTP method "put"/);
    });

    it("throws on unknown keyword in WEBHOOK block", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
WEBHOOK /hook
  DESCRIPTION test hook
  UNKNOWN stuff
`;
      assert.throws(() => parseDsl(dsl), /Unknown keyword in WEBHOOK/);
    });

    it("throws on bare CONDITION (no value, no heredoc)", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : conditional
    CONDITION
`;
      assert.throws(() => parseDsl(dsl), /CONDITION requires/);
    });

    it("throws on bare PROMPT (no value, no heredoc)", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : sampling
    PROMPT
`;
      assert.throws(() => parseDsl(dsl), /PROMPT requires/);
    });

    it("throws on bare SYSTEM_PROMPT (no value, no heredoc)", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : sampling
    PROMPT question
    SYSTEM_PROMPT
`;
      assert.throws(() => parseDsl(dsl), /SYSTEM_PROMPT requires/);
    });

    it("throws on bare MESSAGE (no value, no heredoc)", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : elicitation
    MESSAGE
`;
      assert.throws(() => parseDsl(dsl), /MESSAGE requires/);
    });

    it("throws on bare CONTENT_TEXT (no value, no heredoc)", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : sampling
    CONTENT_TEXT
`;
      assert.throws(() => parseDsl(dsl), /CONTENT_TEXT requires/);
    });

    it("throws on bare SCHEMA (no value, no heredoc)", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : elicitation
    MESSAGE question
    SCHEMA
`;
      assert.throws(() => parseDsl(dsl), /SCHEMA requires/);
    });

    it("throws on unknown keyword in a workflow", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  UNKNOWN stuff
`;
      assert.throws(() => parseDsl(dsl), /Unknown keyword "UNKNOWN"/);
    });

    it("throws on unexpected content at root level", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
BOGUS line
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Unexpected content at root level/);
    });

    it("throws on unknown keyword in a step", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    BADKEYWORD value
`;
      assert.throws(() => parseDsl(dsl), /Unknown keyword "BADKEYWORD"/);
    });

    it("throws on api_call step without OPERATION", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    MAP channel = #general
`;
      assert.throws(
        () => parseDsl(dsl),
        /Step "t" \(api_call\) requires OPERATION/,
      );
    });

    it("throws on sampling step without PROMPT or CONTENT_TEXT", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : sampling
    RESPONSE_FORMAT json
`;
      assert.throws(
        () => parseDsl(dsl),
        /Step "t" \(sampling\) requires PROMPT or CONTENT_TEXT/,
      );
    });

    it("throws on conditional step without CONDITION", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : conditional
    THEN next
`;
      assert.throws(
        () => parseDsl(dsl),
        /Step "t" \(conditional\) requires CONDITION/,
      );
    });

    it("throws on conditional step without THEN or ELSE", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : conditional
    CONDITION true
`;
      assert.throws(
        () => parseDsl(dsl),
        /Step "t" \(conditional\) requires at least THEN or ELSE/,
      );
    });

    it("throws on transform step without EXPRESSION", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
`;
      assert.throws(
        () => parseDsl(dsl),
        /Step "t" \(transform\) requires EXPRESSION/,
      );
    });

    it("throws on elicitation step without MESSAGE", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : elicitation
    SCHEMA {"type":"object"}
`;
      assert.throws(
        () => parseDsl(dsl),
        /Step "t" \(elicitation\) requires MESSAGE/,
      );
    });

    it("throws on FOR_EACH without AS", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    FOR_EACH {{steps.items}}
`;
      assert.throws(() => parseDsl(dsl), /Step "t" has FOR_EACH without AS/);
    });

    it("throws on AS without FOR_EACH", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    AS item
`;
      assert.throws(() => parseDsl(dsl), /Step "t" has AS without FOR_EACH/);
    });

    it("throws on invalid SCHEMA JSON in heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : elicitation
    MESSAGE question
    SCHEMA <<<
      {invalid json here}
    >>>
`;
      assert.throws(() => parseDsl(dsl), /Invalid JSON in SCHEMA heredoc/);
    });

    it("throws on text that looks like heredoc content in step body", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : sampling
    PROMPT <<<
      the prompt
    >>>
    - bullet point text
`;
      assert.throws(() => parseDsl(dsl), /looks like text meant for a heredoc/);
    });

    it("reports correct line number for duplicate OPERATION", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION first
    OPERATION second
`;
      assert.throws(
        () => parseDsl(dsl),
        (error: unknown) =>
          error instanceof DslParseError &&
          error.line === 8 &&
          /Duplicate OPERATION/.test(error.message),
      );
    });

    it("reports correct line number for STEP format error", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP bad_step transform
`;
      assert.throws(
        () => parseDsl(dsl),
        (error: unknown) =>
          error instanceof DslParseError &&
          error.line === 6 &&
          /STEP requires format/.test(error.message),
      );
    });

    it("reports correct line number for MAP format error", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP noEqualsHere
`;
      assert.throws(
        () => parseDsl(dsl),
        (error: unknown) =>
          error instanceof DslParseError &&
          error.line === 8 &&
          /MAP requires format/.test(error.message),
      );
    });

    it("reports correct line number for bare EXPRESSION", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION
`;
      assert.throws(
        () => parseDsl(dsl),
        (error: unknown) =>
          error instanceof DslParseError &&
          error.line === 7 &&
          /EXPRESSION requires/.test(error.message),
      );
    });
  });

  it("parses inline single-line expression", () => {
    const dsl = `
PROJECT inline-test
DESCRIPTION Test inline

WORKFLOW w
  DESCRIPTION test

  STEP check : transform
    EXPRESSION params.message ? true : false
`;
    const result = parseDsl(dsl);
    assert.equal(
      result.workflows[0].steps[0].expression,
      "params.message ? true : false",
    );
  });

  it("parses CONTINUE_ON_ERROR flag", () => {
    const dsl = `
PROJECT err-test
DESCRIPTION Test continueOnError

WORKFLOW w
  DESCRIPTION test

  STEP risky : api_call
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #test
    MAP text = hi
    CONTINUE_ON_ERROR
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows[0].steps[0].continueOnError, true);
  });

  it("parses OUTPUT_PATH", () => {
    const dsl = `
PROJECT path-test
DESCRIPTION Test outputPath

WORKFLOW w
  DESCRIPTION test

  STEP get : api_call
    OPERATION get-api-v1-channels_list
    OUTPUT_PATH channels
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows[0].steps[0].outputPath, "channels");
  });

  it("parses SCHEMA as heredoc JSON", () => {
    const dsl = `
PROJECT schema-heredoc
DESCRIPTION Test heredoc schema

WORKFLOW w
  DESCRIPTION test

  STEP ask : elicitation
    MESSAGE Pick format
    SCHEMA <<<
      {
        "type": "object",
        "properties": {
          "fmt": { "type": "string" }
        }
      }
    >>>
`;
    const result = parseDsl(dsl);
    assert.deepEqual(result.workflows[0].steps[0].requestedSchema, {
      type: "object",
      properties: { fmt: { type: "string" } },
    });
  });

  describe("heredoc variants", () => {
    it("parses CONDITION via heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP gate : conditional
    CONDITION <<<
      steps.data.items.length > 0 &&
      steps.data.items[0].active === true
    >>>
    THEN proceed

  STEP proceed : transform
    DEPENDS ON gate
    EXPRESSION true
`;
      const result = parseDsl(dsl);
      const step = result.workflows[0].steps[0];
      assert.ok(step.condition!.includes("steps.data.items.length > 0"));
      assert.ok(
        step.condition!.includes("steps.data.items[0].active === true"),
      );
    });

    it("parses MESSAGE via heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP ask : elicitation
    MESSAGE <<<
      Please choose a format for the results.
      Options: brief, detailed, or custom.
    >>>
    SCHEMA {"type":"object","properties":{"choice":{"type":"string"}}}
`;
      const result = parseDsl(dsl);
      const step = result.workflows[0].steps[0];
      assert.ok(step.message!.includes("Please choose a format"));
      assert.ok(step.message!.includes("Options: brief, detailed, or custom."));
    });

    it("parses SYSTEM_PROMPT via heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP llm : sampling
    SYSTEM_PROMPT <<<
      You are a helpful assistant.
      Always respond in JSON format.
    >>>
    PROMPT What is 2+2?
`;
      const result = parseDsl(dsl);
      const step = result.workflows[0].steps[0];
      assert.ok(step.systemPrompt!.includes("You are a helpful assistant."));
      assert.ok(step.systemPrompt!.includes("Always respond in JSON format."));
    });

    it("parses CONTENT_TEXT via heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP analyze : sampling
    CONTENT_TEXT <<<
      Analyze the following data:
      {{steps.data}}
      Be thorough.
    >>>
`;
      const result = parseDsl(dsl);
      const step = result.workflows[0].steps[0];
      assert.equal(step.content!.length, 1);
      assert.equal(step.content![0].type, "text");
      const text = (step.content![0] as { type: "text"; text: string }).text;
      assert.ok(text.includes("Analyze the following data:"));
      assert.ok(text.includes("{{steps.data}}"));
      assert.ok(text.includes("Be thorough."));
    });
  });

  describe("edge cases", () => {
    it("preserves template expressions that look numeric as strings", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP count = {{params.count}}
`;
      const result = parseDsl(dsl);
      const mapping = result.workflows[0].steps[0].inputMapping!;
      assert.equal(mapping.count, "{{params.count}}");
      assert.equal(typeof mapping.count, "string");
    });

    it("handles negative numbers in MAP values", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP offset = -10
`;
      const result = parseDsl(dsl);
      assert.equal(result.workflows[0].steps[0].inputMapping!.offset, -10);
    });

    it("handles decimal numbers in MAP values", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP score = 3.14
`;
      const result = parseDsl(dsl);
      assert.equal(result.workflows[0].steps[0].inputMapping!.score, 3.14);
    });

    it("MAP boolean false is parsed as boolean, not string", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP active = false
`;
      const result = parseDsl(dsl);
      assert.equal(result.workflows[0].steps[0].inputMapping!.active, false);
      assert.equal(
        typeof result.workflows[0].steps[0].inputMapping!.active,
        "boolean",
      );
    });

    it("later MAP to same dot-path overwrites earlier value", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP config.timeout = 5000
    MAP config.timeout = 10000
`;
      const result = parseDsl(dsl);
      assert.deepEqual(result.workflows[0].steps[0].inputMapping, {
        config: { timeout: 10000 },
      });
    });

    it("deepMerge preserves sibling keys when overwriting nested path", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP config.host = localhost
    MAP config.port = 8080
    MAP config.host = remotehost
`;
      const result = parseDsl(dsl);
      assert.deepEqual(result.workflows[0].steps[0].inputMapping, {
        config: { host: "remotehost", port: 8080 },
      });
    });

    it("webhookEndpoints is undefined when no webhooks are declared", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
`;
      const result = parseDsl(dsl);
      assert.equal(result.webhookEndpoints, undefined);
    });

    it("handles triple-brace templates in heredoc by normalizing to double", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION <<<
      return {{{params.value}}}
    >>>
`;
      const result = parseDsl(dsl);
      assert.ok(
        result.workflows[0].steps[0].expression!.includes("{{params.value}}"),
      );
      assert.ok(!result.workflows[0].steps[0].expression!.includes("{{{"));
    });

    it("handles invalid JSON-looking MAP values as plain strings", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP data = {not: valid json}
`;
      const result = parseDsl(dsl);
      assert.equal(
        result.workflows[0].steps[0].inputMapping!.data,
        "{not: valid json}",
      );
    });

    it("handles MAP value with multiple equals signs", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : api_call
    OPERATION op
    MAP query = status=active&type=admin
`;
      const result = parseDsl(dsl);
      assert.equal(
        result.workflows[0].steps[0].inputMapping!.query,
        "status=active&type=admin",
      );
    });

    it("PARAM with colons in description preserves the full description", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  PARAM query : string : The search query: supports wildcards
  STEP t : transform
    EXPRESSION true
`;
      const result = parseDsl(dsl);
      const props = result.workflows[0].params!.properties;
      assert.equal(
        props.query.description,
        "The search query: supports wildcards",
      );
    });

    it("workflow without params has undefined params field", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION true
`;
      const result = parseDsl(dsl);
      assert.equal(result.workflows[0].params, undefined);
    });

    it("step without optional fields leaves them undefined", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION 42
`;
      const result = parseDsl(dsl);
      const step = result.workflows[0].steps[0];
      assert.equal(step.label, undefined);
      assert.equal(step.dependsOn, undefined);
      assert.equal(step.operationId, undefined);
      assert.equal(step.inputMapping, undefined);
      assert.equal(step.outputPath, undefined);
      assert.equal(step.forEach, undefined);
      assert.equal(step.as, undefined);
      assert.equal(step.continueOnError, undefined);
    });

    it("DslParseError has correct name, line, and message format", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
`;
      try {
        parseDsl(dsl);
        assert.fail("Expected DslParseError to be thrown");
      } catch (raw: unknown) {
        const err = raw as DslParseError;
        assert.ok(raw instanceof DslParseError);
        assert.equal(err.name, "DslParseError");
        assert.equal(typeof err.line, "number");
        assert.ok(err.message.startsWith(`Line ${err.line}:`));
      }
    });
  });
});
