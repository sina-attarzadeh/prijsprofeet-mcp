import type { OpenApiDocument, ParameterObject, SchemaObject } from './spec.js';

const MAX_DEPTH = 12;

const isNullSchema = (schema: SchemaObject): boolean =>
  schema.type === 'null' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null');

export class SchemaResolver {
  constructor(private readonly spec: OpenApiDocument) {}

  /** Replaces local `$ref`s with the schema they point at. Cycles stop at `MAX_DEPTH`. */
  resolve(schema: SchemaObject | undefined, depth = 0, seen: ReadonlySet<string> = new Set()): SchemaObject | undefined {
    if (!schema || depth > MAX_DEPTH) return undefined;

    if (typeof schema.$ref === 'string') {
      if (seen.has(schema.$ref)) return { type: 'object' };
      const target = this.lookup(schema.$ref);
      if (!target) return { type: 'object' };
      const siblings = { ...schema };
      delete siblings.$ref;
      const resolved = this.resolve(target, depth + 1, new Set([...seen, schema.$ref]));
      return this.merge(resolved ?? {}, siblings);
    }

    // OpenAPI 3.1 spells optionality as `anyOf: [T, {type: "null"}]`. Collapse that to T.
    for (const key of ['anyOf', 'oneOf'] as const) {
      const variants = schema[key];
      if (!Array.isArray(variants) || variants.length === 0) continue;
      const nonNull = variants.filter((variant) => !isNullSchema(variant));
      if (nonNull.length === 1) {
        const rest = { ...schema };
        delete rest[key];
        return this.merge(this.resolve(nonNull[0]!, depth, seen) ?? {}, rest);
      }
    }

    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
      const merged = schema.allOf.reduce<SchemaObject>(
        (acc, part) => this.merge(acc, this.resolve(part, depth, seen) ?? {}),
        {},
      );
      const rest = { ...schema };
      delete rest.allOf;
      return this.merge(merged, rest);
    }

    return schema;
  }

  private lookup(ref: string): SchemaObject | undefined {
    const pointer = ref.replace(/^#\//, '');
    let node: unknown = this.spec as unknown;
    for (const rawSegment of pointer.split('/')) {
      const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (typeof node !== 'object' || node === null) return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return typeof node === 'object' && node !== null ? (node as SchemaObject) : undefined;
  }

  private merge(base: SchemaObject, extra: SchemaObject): SchemaObject {
    const merged: SchemaObject = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || key === 'title') continue;
      merged[key] = value;
    }
    return merged;
  }
}

/**
 * Rewrites a spec schema into the plain JSON Schema dialect that MCP clients
 * expect: refs resolved, nullable unions collapsed, doc-only keywords removed.
 */
export function toJsonSchema(
  resolver: SchemaResolver,
  schema: SchemaObject | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> | undefined {
  if (!schema || depth > MAX_DEPTH) return undefined;

  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return { type: 'object' };
    const target = resolver.resolve(schema, 0, seen);
    return target ? toJsonSchema(resolver, target, depth + 1, new Set([...seen, schema.$ref])) : { type: 'object' };
  }

  const resolved = resolver.resolve(schema, depth, seen) ?? schema;
  const out: Record<string, unknown> = {};

  if (resolved.type !== undefined) out.type = resolved.type;
  if (resolved.format !== undefined) out.format = resolved.format;
  if (resolved.description !== undefined) out.description = resolved.description;
  if (resolved.default !== undefined) out.default = resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) out.enum = resolved.enum;
  if (resolved.minimum !== undefined) out.minimum = resolved.minimum;
  if (resolved.maximum !== undefined) out.maximum = resolved.maximum;
  if (resolved.minLength !== undefined) out.minLength = resolved.minLength;
  if (resolved.maxLength !== undefined) out.maxLength = resolved.maxLength;
  if (resolved.minItems !== undefined) out.minItems = resolved.minItems;
  if (resolved.maxItems !== undefined) out.maxItems = resolved.maxItems;
  if (resolved.pattern !== undefined) out.pattern = resolved.pattern;

  if (resolved.type === 'array' || resolved.items !== undefined) {
    const items = toJsonSchema(resolver, resolved.items, depth + 1, seen);
    out.type = 'array';
    out.items = items ?? { type: 'string' };
  }

  if (resolved.properties && Object.keys(resolved.properties).length > 0) {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(resolved.properties)) {
      const converted = toJsonSchema(resolver, value, depth + 1, seen);
      if (converted) properties[name] = converted;
    }
    out.type = out.type ?? 'object';
    out.properties = properties;
    if (Array.isArray(resolved.required) && resolved.required.length > 0) {
      out.required = resolved.required;
    }
    out.additionalProperties = false;
  }

  if (out.type === undefined && out.properties !== undefined) out.type = 'object';
  if (out.type === undefined) out.type = 'string';

  return out;
}

/** Flattens a parameter's schema into the shape used inside a tool's `inputSchema`. */
export function parameterToJsonSchema(
  resolver: SchemaResolver,
  parameter: ParameterObject,
): Record<string, unknown> | undefined {
  const base = toJsonSchema(resolver, parameter.schema);
  if (!base) return undefined;

  // Defaults belong in the description, not in the emitted schema: a client that
  // copies the schema would otherwise always send them, and the model has no way
  // to tell "unset" from "the default".
  const description = joinDescription(parameter.description, base.description as string | undefined);
  const converted: Record<string, unknown> = { ...base };

  if (converted.default !== undefined) {
    const fallback = converted.default;
    delete converted.default;
    converted.description = joinDescription(
      description,
      `Default when omitted: ${JSON.stringify(fallback)}.`,
    );
  }
  if (description) converted.description = description;
  if (parameter.example !== undefined && converted.examples === undefined) {
    converted.examples = [parameter.example];
  }

  return converted;
}

export function joinDescription(...parts: Array<string | undefined>): string | undefined {
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part === 'string') {
      const trimmed = part.trim();
      if (trimmed.length > 0) seen.add(trimmed);
    }
  }
  if (seen.size === 0) return undefined;
  return [...seen].join(' ');
}
