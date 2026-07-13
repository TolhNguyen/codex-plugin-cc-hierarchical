import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Minimal, dependency-free JSON Schema validator.
 *
 * Supports exactly: type (incl. "integer" vs "number" and "null"), required,
 * properties, additionalProperties: false, items, enum, pattern, minimum,
 * maximum, minLength, minItems. Any other keyword is ignored silently.
 */

function typeMatches(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function displayPath(pointer) {
  return pointer === "" ? "/" : pointer;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNode(value, schema, pointer, errors) {
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${displayPath(pointer)}: expected ${schema.type}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${displayPath(pointer)}: not one of ${schema.enum.join(", ")}`);
  }

  if (schema.pattern !== undefined && typeof value === "string") {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${displayPath(pointer)}: does not match pattern ${schema.pattern}`);
    }
  }

  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${displayPath(pointer)}: length below minimum ${schema.minLength}`);
  }

  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${displayPath(pointer)}: below minimum ${schema.minimum}`);
  }

  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(`${displayPath(pointer)}: above maximum ${schema.maximum}`);
  }

  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${displayPath(pointer)}: has fewer than ${schema.minItems} items`);
  }

  if (schema.required && isPlainObject(value)) {
    for (const key of schema.required) {
      if (!(key in value)) {
        errors.push(`${displayPath(pointer)}: missing required property "${key}"`);
      }
    }
  }

  if (schema.properties && isPlainObject(value)) {
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        validateNode(value[key], subSchema, `${pointer}/${key}`, errors);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${displayPath(`${pointer}/${key}`)}: additional property not allowed`);
        }
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      validateNode(item, schema.items, `${pointer}/${index}`, errors);
    });
  }
}

export function validateAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "", errors);
  return { valid: errors.length === 0, errors };
}

export function loadOrchestrationSchema(name) {
  const url = new URL(`../../schemas/orchestration/${name}.schema.json`, import.meta.url);
  const filePath = fileURLToPath(url);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Orchestration schema not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
