import { readBundledSpec, type Config } from './config.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  allOf?: SchemaObject[];
  additionalProperties?: boolean | SchemaObject;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  nullable?: boolean;
  deprecated?: boolean;
  [key: string]: unknown;
}

export interface ParameterObject {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaObject;
  example?: unknown;
  explode?: boolean;
  style?: string;
  /** OpenAPI allows a parameter to be a reference to a shared one. */
  $ref?: string;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: SchemaObject }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: SchemaObject }> }>;
  security?: Array<Record<string, string[]>> | null;
}

/** A path item carries its own `parameters`, which apply to every operation on it. */
export interface PathItemObject {
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, unknown>;
  };
}

const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['get', 'post', 'put', 'patch', 'delete']);

export interface Endpoint {
  /** `GET /api/v1/search` */
  id: string;
  method: HttpMethod;
  path: string;
  operation: OperationObject;
}

export function listEndpoints(spec: OpenApiDocument): Endpoint[] {
  const endpoints: Endpoint[] = [];

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!METHODS.has(method)) continue;
      const inherited = (item.parameters ?? []) as ParameterObject[];
      const merged: OperationObject = {
        ...operation,
        parameters: [...inherited, ...(operation.parameters ?? [])],
      };
      endpoints.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method as HttpMethod,
        path,
        operation: merged,
      });
    }
  }

  return endpoints;
}

/**
 * Resolves the OpenAPI document the tool surface is built from: the copy bundled
 * with the image, optionally refreshed from the live URL at startup.
 */
export async function loadSpec(config: Config, log: (msg: string) => void): Promise<OpenApiDocument> {
  if (config.refreshSpec && config.specUrl) {
    try {
      const response = await fetch(config.specUrl, {
        headers: { accept: 'application/json', 'user-agent': config.userAgent },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const remote = (await response.json()) as OpenApiDocument;
      if (remote.paths && Object.keys(remote.paths).length > 0) {
        log(`spec: refreshed from ${config.specUrl} (${Object.keys(remote.paths).length} paths)`);
        return remote;
      }
      log('spec: refreshed document had no paths, keeping bundled copy');
    } catch (error) {
      log(`spec: refresh failed (${describeError(error)}), using bundled copy`);
    }
  }

  const bundled = readBundledSpec(config.specPath) as OpenApiDocument;
  log(`spec: loaded bundled copy from ${config.specPath} (${Object.keys(bundled.paths ?? {}).length} paths)`);
  return bundled;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}
