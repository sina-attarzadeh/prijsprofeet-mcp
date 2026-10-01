import type { Config } from './config.js';
import { describeError } from './spec.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly url: string,
    /** Whether this process was started with a key at all. Decides the 401 hint. */
    readonly keyConfigured = false,
  ) {
    super(`PrijsProfeet API ${status} ${statusText} for ${url}: ${truncate(body, 800)}`);
    this.name = 'ApiError';
  }

  /** Turns an upstream status into a hint the model can act on. */
  get hint(): string | undefined {
    if (this.status === 401) return this.keyProblemHint() ?? this.planHint();
    // The API reports both "this key is not valid" and "your plan does not cover
    // this endpoint" as a bare 403, so the body is the only thing that tells a
    // typo'd key apart from a missing upgrade.
    if (this.status === 402 || this.status === 403) return this.keyProblemHint() ?? this.planHint();
    if (this.status === 404) {
      return 'No such resource. Verify the id, EAN or path parameter.';
    }
    if (this.status === 422) {
      return 'The API rejected the parameters. Check the tool description for allowed values and ranges.';
    }
    if (this.status === 429) {
      return 'Rate limited. Slow down: use a smaller page_size and fewer calls.';
    }
    if (this.status >= 500) {
      return 'Upstream server error. Retry later.';
    }
    return undefined;
  }

  private keyProblemHint(): string | undefined {
    const mentionsKey =
      /invalid api key|unknown api key|unknown key|expired key|missing x-api-key|api key not found/i.test(this.body);
    if (!mentionsKey) return undefined;
    if (this.keyConfigured) {
      return 'The API rejected the configured X-API-Key: it is wrong, expired or revoked. Check PRIJSPROFEET_API_KEY.';
    }
    return 'This endpoint needs an API key and the server was started without one. Set PRIJSPROFEET_API_KEY — a free key is available at https://www.prijsprofeet.nl/api. The search, product, category and deal tools work without a key.';
  }

  private planHint(): string {
    return 'This endpoint needs a paid plan (trial, Pro or Business). Public endpoints such as search, products, categories and deals work without a key.';
  }
}

export type QueryValue = string | number | boolean | Array<string | number | boolean> | null | undefined;

export interface RequestOptions {
  method: string;
  path: string;
  pathParams?: Record<string, QueryValue>;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  data: unknown;
  raw: string;
  truncated: boolean;
  url: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class PrijsProfeetClient {
  constructor(private readonly config: Config) {}

  get hasApiKey(): boolean {
    return this.config.apiKey !== undefined;
  }

  async request(options: RequestOptions): Promise<ApiResponse> {
    const url = this.buildUrl(options);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        const response = await this.send(url, options);
        if (!response.ok) {
          const body = await readBounded(response, this.config.maxResponseBytes);
          const error = new ApiError(response.status, response.statusText, body.text, url, this.hasApiKey);
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
            lastError = error;
            await sleep(backoffDelay(attempt, response.headers.get('retry-after')));
            continue;
          }
          throw error;
        }
        return this.readSuccess(response, url);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (attempt >= this.config.maxRetries) {
          throw new Error(`Request to ${url} failed: ${describeError(error)}`);
        }
        lastError = error;
        await sleep(backoffDelay(attempt, null));
      }
    }

    throw new Error(`Request to ${url} failed: ${describeError(lastError)}`);
  }

  private buildUrl(options: RequestOptions): string {
    let path = options.path;

    for (const [name, value] of Object.entries(options.pathParams ?? {})) {
      if (value === undefined || value === null) {
        throw new Error(`Missing required path parameter "${name}" for ${options.path}`);
      }
      path = path.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }

    const remaining = path.match(/\{[^}]+\}/);
    if (remaining) {
      throw new Error(`Unresolved path template ${remaining[0]} in ${options.path}`);
    }

    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // form/explode semantics: repeat the key once per element
        for (const item of value) query.append(name, String(item));
      } else {
        query.append(name, String(value));
      }
    }

    const search = query.toString();
    return `${this.config.baseUrl}${path}${search.length > 0 ? `?${search}` : ''}`;
  }

  private async send(url: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.config.userAgent,
    };
    if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey;

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    return fetch(url, {
      method: options.method,
      headers,
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
  }

  private async readSuccess(response: Response, url: string): Promise<ApiResponse> {
    const raw = await readBounded(response, this.config.maxResponseBytes);
    if (raw.truncated) {
      return { status: response.status, data: null, raw: raw.text, truncated: true, url };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json') || raw.text.trimStart().startsWith('{') || raw.text.trimStart().startsWith('[')) {
      try {
        return { status: response.status, data: JSON.parse(raw.text), raw: raw.text, truncated: false, url };
      } catch {
        return { status: response.status, data: null, raw: raw.text, truncated: false, url };
      }
    }
    return { status: response.status, data: null, raw: raw.text, truncated: false, url };
  }
}

interface BoundedBody {
  text: string;
  truncated: boolean;
}

/** Reads at most `limit` bytes, so a runaway response cannot exhaust memory. */
async function readBounded(response: Response, limit: number): Promise<BoundedBody> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return { text: truncate(text, limit), truncated: text.length > limit };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        chunks.push(value.subarray(0, value.byteLength - (size - limit)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const text = new TextDecoder().decode(concat(chunks));
  return { text, truncated };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated]`;
}

function backoffDelay(attempt: number, retryAfter: string | null): number {
  const header = Number.parseInt(retryAfter ?? '', 10);
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
