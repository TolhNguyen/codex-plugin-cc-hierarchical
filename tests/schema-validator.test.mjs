import test from "node:test";
import assert from "node:assert/strict";

import {
  loadOrchestrationSchema,
  validateAgainstSchema
} from "../plugins/codex/scripts/lib/schema-validator.mjs";

test("valid value against a simple object schema reports no errors", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 }
    }
  };

  const result = validateAgainstSchema({ name: "ok" }, schema);

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("missing required property reports root path", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string" } }
  };

  const result = validateAgainstSchema({}, schema);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ['/: missing required property "id"']);
});

test("type mismatch at root reports expected type", () => {
  const result = validateAgainstSchema("nope", { type: "array" });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: expected array"]);
});

test("nested object/array type mismatch reports nested path", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ownership"],
    properties: {
      ownership: {
        type: "object",
        additionalProperties: false,
        required: ["primary"],
        properties: {
          primary: { type: "array", items: { type: "string" } }
        }
      }
    }
  };

  const result = validateAgainstSchema({ ownership: { primary: "x" } }, schema);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/ownership/primary: expected array"]);
});

test("integer type rejects non-integer numbers but accepts whole numbers", () => {
  const schema = { type: "integer", minimum: 1 };

  assert.equal(validateAgainstSchema(3, schema).valid, true);
  const result = validateAgainstSchema(1.5, schema);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: expected integer"]);
});

test("number type accepts integers and floats but rejects strings", () => {
  const schema = { type: "number" };

  assert.equal(validateAgainstSchema(3, schema).valid, true);
  assert.equal(validateAgainstSchema(3.5, schema).valid, true);
  const result = validateAgainstSchema("3", schema);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: expected number"]);
});

test("null type accepts null and rejects other values", () => {
  const schema = { type: "null" };

  assert.equal(validateAgainstSchema(null, schema).valid, true);
  const result = validateAgainstSchema(0, schema);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: expected null"]);
});

test("enum mismatch lists all allowed values", () => {
  const schema = { type: "string", enum: ["draft", "evaluating", "approved"] };

  const result = validateAgainstSchema("bogus", schema);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: not one of draft, evaluating, approved"]);
});

test("pattern mismatch and match", () => {
  const schema = { type: "string", pattern: "^[a-z]+$" };

  assert.equal(validateAgainstSchema("abc", schema).valid, true);
  const result = validateAgainstSchema("ABC", schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^\/: does not match pattern/);
});

test("minimum and maximum are enforced independently", () => {
  const schema = { type: "number", minimum: 0, maximum: 1 };

  assert.deepEqual(validateAgainstSchema(-1, schema).errors, ["/: below minimum 0"]);
  assert.deepEqual(validateAgainstSchema(2, schema).errors, ["/: above maximum 1"]);
  assert.equal(validateAgainstSchema(0.5, schema).valid, true);
});

test("minLength is enforced on strings", () => {
  const schema = { type: "string", minLength: 3 };

  const result = validateAgainstSchema("ab", schema);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: length below minimum 3"]);
});

test("minItems is enforced on arrays", () => {
  const schema = { type: "array", minItems: 1, items: { type: "string" } };

  const result = validateAgainstSchema([], schema);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/: has fewer than 1 items"]);
});

test("items validates each array element with an indexed path", () => {
  const schema = { type: "array", items: { type: "string", minLength: 1 } };

  const result = validateAgainstSchema(["ok", "", 5], schema);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["/1: length below minimum 1", "/2: expected string"]);
});

test("additionalProperties false reports the offending key by path", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" } }
  };

  const result = validateAgainstSchema({ a: "x", b: "y" }, schema);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^\/b: /);
});

test("multiple simultaneous errors are all collected, not short-circuited", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "status"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["active", "retired"] }
    }
  };

  const result = validateAgainstSchema({ status: "bogus", extra: true }, schema);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.some((e) => e.includes('missing required property "id"')));
  assert.ok(result.errors.some((e) => e.includes("/status: not one of active, retired")));
  assert.ok(result.errors.some((e) => e.startsWith("/extra: ")));
});

test("unknown keywords are ignored silently", () => {
  const schema = { type: "string", format: "email", unknownKeyword: 5 };

  const result = validateAgainstSchema("hello@example.com", schema);

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("loadOrchestrationSchema loads a known orchestration schema", () => {
  const schema = loadOrchestrationSchema("agent");

  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(Array.isArray(schema.required));
});

test("loadOrchestrationSchema throws a clear error naming the missing file", () => {
  assert.throws(
    () => loadOrchestrationSchema("does-not-exist"),
    /does-not-exist/
  );
});
