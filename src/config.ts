import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const str = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
};

const int = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

export type Transport = 'stdio' | 'http';
export type Plan = 'free' | 'pro';

export interface Config {
  /** Partner key sent as the `X-API-Key` header. Absent means the anonymous (Gratis) tier. */
  apiKey: string | undefined;
  /** API origin, without a trailing slash. */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** How many times a failed request is retried before giving up. */
  maxRetries: number;
  /** Responses larger than this are truncated, to keep the model's context sane. */
  maxResponseBytes: number;
  /** User-Agent sent with every request. */
  userAgent: string;
  /** Path to the OpenAPI document used to generate the tool surface. */
  specPath: string;
  /** When set, the OpenAPI document is fetched from this URL at startup. */
  specUrl: string | undefined;
  /** Fetch the OpenAPI document from `specUrl` at startup and overwrite the bundled copy. */
  refreshSpec: boolean;
  /** Prefix applied to every generated tool name. */
  toolPrefix: string;
  /** Which PrijsProfeet plan the configured key is on. Decides whether the Pro-gated tools are exposed. */
  plan: Plan;
  /**
   * Bearer tokens accepted by the HTTP transport. Empty means the MCP endpoint
   * is unauthenticated, which is only safe on loopback.
   */
  authTokens: string[];
  /** stdio for a locally launched client, http to serve a URL. */
  transport: Transport;
  /** Interface the HTTP transport binds to. */
  httpHost: string;
  /** Port the HTTP transport listens on. */
  httpPort: number;
  /** Path the HTTP transport is served under. */
  httpPath: string;
  /** When true, diagnostics go to stderr; stdout stays reserved for the MCP stream. */
  debug: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = str(
    env.PRIJSPROFEET_API_KEY ?? env.PP_API_KEY ?? env.X_API_KEY,
    '',
  );

  const specPath =
    env.PRIJSPROFEET_SPEC_PATH ??
    fileURLToPath(new URL('./openapi.json', import.meta.url));

  const specUrlRaw = str(env.PRIJSPROFEET_SPEC_URL, 'https://www.prijsprofeet.nl/openapi.json');

  const transport = str(env.PRIJSPROFEET_TRANSPORT, 'stdio').toLowerCase();
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`PRIJSPROFEET_TRANSPORT must be "stdio" or "http", got "${transport}"`);
  }

  const httpPath = str(env.PRIJSPROFEET_HTTP_PATH, '/mcp');
  if (!httpPath.startsWith('/')) {
    throw new Error(`PRIJSPROFEET_HTTP_PATH must start with "/", got "${httpPath}"`);
  }

  const plan = str(env.PRIJSPROFEET_PLAN, 'free').toLowerCase();
  if (plan !== 'free' && plan !== 'pro') {
    throw new Error(`PRIJSPROFEET_PLAN must be "free" or "pro", got "${plan}"`);
  }

  // Comma-separated so a token can be rotated without dropping connections:
  // add the new one, deploy, then remove the old.
  const authTokens = (env.MCP_AUTH_TOKEN ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return {
    apiKey: apiKey.length > 0 ? apiKey : undefined,
    baseUrl: str(env.PRIJSPROFEET_BASE_URL, 'https://www.prijsprofeet.nl').replace(/\/+$/, ''),
    timeoutMs: int(env.PRIJSPROFEET_TIMEOUT_MS, 30_000, 1_000, 300_000),
    maxRetries: int(env.PRIJSPROFEET_MAX_RETRIES, 2, 0, 10),
    maxResponseBytes: int(env.PRIJSPROFEET_MAX_RESPONSE_BYTES, 250_000, 1_000, 50_000_000),
    userAgent: str(env.PRIJSPROFEET_USER_AGENT, 'prijsprofeet-mcp/1.0'),
    specPath,
    specUrl: specUrlRaw.length > 0 ? specUrlRaw : undefined,
    refreshSpec: bool(env.PRIJSPROFEET_REFRESH_SPEC, false),
    toolPrefix: str(env.PRIJSPROFEET_TOOL_PREFIX, 'pp'),
    plan,
    authTokens,
    transport,
    // 0.0.0.0 rather than localhost: inside a container, binding to loopback
    // makes the server unreachable from the host, which looks like a hang.
    // `PORT` is what Render, Heroku and most PaaS inject, so honour it.
    httpHost: str(env.PRIJSPROFEET_HTTP_HOST, '0.0.0.0'),
    httpPort: int(env.PRIJSPROFEET_HTTP_PORT ?? env.PORT, 3000, 1, 65_535),
    httpPath,
    debug: bool(env.DEBUG, false) || bool(env.PRIJSPROFEET_DEBUG, false),
  };
}

export function readBundledSpec(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
