import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ApiError, type PrijsProfeetClient, type QueryValue } from './client.js';
import { parameterToJsonSchema, SchemaResolver, toJsonSchema } from './schema.js';
import { listEndpoints, type Endpoint, type OpenApiDocument, type ParameterObject, type SchemaObject } from './spec.js';

/**
 * Curated tool metadata, keyed by `METHOD /path`. The spec supplies the argument
 * schemas; this supplies the names and the caveats worth reading before a call.
 */
const CATALOG: Record<string, { name: string; description: string; readOnly?: boolean }> = {
  'GET /api/v1/health': {
    name: 'health_check',
    description:
      'Check that the PrijsProfeet API is reachable. Call this when another tool returns 5xx to tell an outage apart from a bad request.',
  },

  'GET /api/v1/search': {
    name: 'search',
    description: [
      'Search supermarket offers across the 10 Dutch chains (Albert Heijn, Aldi, DekaMarkt, Dirk, Ekoplaza, Hoogvliet, Jumbo, Lidl, PLUS, Vomar).',
      'Omit `q` or pass `*` to browse the whole catalogue.',
      '',
      'How to read a row: `promotion_status` decides what the price means. `active` = on offer right now, `upcoming` = starts next week, `shelf` = the regular price, `historical` = the last price seen, up to 60 days old.',
      'Taking the lowest `price` across rows can therefore return a price nobody is charging today — filter on `promotion_status` (or leave `current_only`-style filtering to the caller) before quoting a best price.',
      '',
      'Retailer slugs: albert_heijn, jumbo, aldi, lidl, ekoplaza, plus, dekamarkt, hoogvliet, vomar, dirk.',
      'Category slugs are not free text: call `pp_get_categories` first to map the user\'s word to a slug.',
      'Keep `page_size` modest; page through rather than asking for 100 rows when a question needs 3.',
    ].join('\n'),
  },

  'GET /api/v1/products': {
    name: 'list_products',
    description: [
      'List products with filters, newest extraction first. Use `pp_search` when the user named a product; use this when you need to enumerate by retailer, folder, promo group or validity window.',
      '`promo_group_id` returns every product in one shared action — read that field off a product to get the rest of its group.',
      '`min_valid_from` / `max_valid_from` (YYYY-MM-DD) bound the date the promotion starts.',
    ].join('\n'),
  },

  'GET /api/v1/products/{product_id}': {
    name: 'get_product',
    description:
      'Full detail for one product, including EAN, folder, promo group and dietary labels. `product_id` is the `product_id` field from any search or list result.',
  },

  'GET /api/v1/products/search/{query}': {
    name: 'search_products_by_name',
    description: [
      'Search products with the term inside the URL path. This is the older sibling of `pp_search`: same data, fewer filters, no sorting.',
      'Prefer `pp_search` for new work.',
    ].join('\n'),
  },

  'GET /api/v1/products/folder/{folder_id}': {
    name: 'get_products_by_folder',
    description: [
      'Every product in one promotional folder (a single actie). `folder_id` is the `folder_id` field on a product.',
      '`page_size` may go up to 1000 here, but a big page is expensive in context and in rate limit — ask for what the question needs.',
    ].join('\n'),
  },

  'GET /api/v1/products/retailer/{retailer}': {
    name: 'get_products_by_retailer',
    description:
      'Every product from one retailer, paginated. Takes a retailer slug (albert_heijn, jumbo, aldi, lidl, ekoplaza, plus, dekamarkt, hoogvliet, vomar, dirk), not a display name.',
  },

  'GET /api/v1/products/promotional/all': {
    name: 'get_promotional_products',
    description:
      'Everything currently on offer, newest first. Use `pp_list_products` with `is_promotional=true` instead when you also need a filter.',
  },

  'GET /api/v1/products/{product_id}/price-history': {
    name: 'get_price_history',
    description: [
      'Weekly price history for one product, from the price_history collection.',
      'Requires a paid plan (trial, Pro or Business) sent as X-API-Key. Without a paid key this returns 402/403, which means "upgrade", not "no data".',
    ].join('\n'),
  },

  'GET /api/v1/products/{product_id}/forecast': {
    name: 'get_price_forecast',
    description: [
      'Server-side backtested price forecast for one product ("Profeet voorspelt").',
      'A product with no forecast is not an error: the call returns HTTP 200 with a null forecast, and the reason arrives in the `X-Forecast-Reason` header. Report it as "no forecast available" rather than retrying.',
    ].join('\n'),
  },

  'GET /api/v1/categories': {
    name: 'get_categories',
    description: [
      'The unified categories with Dutch display names, product counts and group.',
      'Call this before `pp_search` to turn a user\'s word ("zuivel", "brood") into a valid `category` slug. Cheap, and worth it before a search that would otherwise return nothing.',
    ].join('\n'),
  },

  'GET /api/v1/filter-stats': {
    name: 'get_filter_stats',
    description:
      'Facet counts per retailer, promotion status and category. Pass `q` (and optionally `category`) to get the counts for one specific search — useful to show what a filter would still return, or to check whether a category exists before searching it.',
  },

  'GET /api/v1/shelf-prices': {
    name: 'search_shelf_prices',
    description: [
      'Search the regular, non-promotional assortment by name and/or EAN: what a retailer charges for a SKU that is not on offer, including the many products that never are.',
      'Requires a Pro, Business or trial key. A free key gets 403 on this endpoint specifically, even though it works elsewhere.',
      'Give at least one of `q`, `ean` or `retailer`. With none, the call pages through the entire collection, which is rarely what you want.',
      'Use this to turn a product name into an EAN for `pp_match_by_ean`, or to answer "what does it normally cost".',
    ].join('\n'),
  },

  'GET /api/v1/match/ean/{ean}': {
    name: 'match_by_ean',
    description: [
      'Find the same EAN at every retailer, with each retailer\'s price. Requires a paid plan (trial, Pro or Business).',
      'EAN matching is exact where EANs exist. Aldi, Lidl, Hoogvliet and Vomar do not publish barcodes at all, so for them the API falls back to matching on name, brand and category — indicative, not the same product. Say so when you report those rows.',
      'A chain with nothing on offer is not dropped: it comes back with `promotion_status: "shelf"` and its regular price. `current_only=true` keeps only prices that can actually be bought today, at the cost of coverage.',
    ].join('\n'),
  },

  'GET /api/v1/match/product/{product_id}': {
    name: 'match_for_product',
    description: [
      'The same cross-retailer comparison, starting from a PrijsProfeet `product_id` instead of an EAN. Requires a paid plan.',
      'Use this when you already hold a product from a search result and want the other chains\' prices for it.',
    ].join('\n'),
  },

  'GET /api/v1/match/compare/{ean}': {
    name: 'compare_prices',
    description: [
      'Price comparison for one EAN across retailers. Requires a paid plan.',
      'Read `promotion_status` per row before naming a winner: `upcoming` and `historical` rows are not prices you can pay today.',
    ].join('\n'),
  },

  'GET /api/v1/match/stats': {
    name: 'get_ean_stats',
    description:
      'EAN coverage per retailer, with the date the measurement was taken. Use this to explain why a chain never shows up in a match, instead of guessing. Requires a paid plan.',
  },

  'GET /api/v1/deals/top': {
    name: 'get_top_deals',
    description: [
      'Top deals grouped per brand, optionally narrowed to one or more retailers.',
      '`min_savings` defaults to 10%; raise it to cut the noise. Pass `retailer` as an array to scope the lists to specific chains.',
    ].join('\n'),
  },

  'GET /api/v1/deals/brand/{brand}': {
    name: 'get_brand_deals',
    description:
      'Every current deal for one brand, e.g. `Coca-Cola` or `Ahold`. Brand matching follows the capitalisation in the source data, so keep the brand as the user wrote it and do not normalise it.',
  },

  'GET /api/v1/deals/summary': {
    name: 'get_deals_summary',
    description:
      'Aggregate stats: total products, retailer count, biggest discount, last update. One cheap call to check that the data is fresh before reporting anything about "this week".',
  },

  'GET /api/v1/deals/popular': {
    name: 'get_popular_deals',
    description: 'The deals users click most often, capped at 30 rows.',
  },

  'GET /api/v1/deals/by-type': {
    name: 'get_deals_by_type',
    description:
      'Deals for one promotion mechanic, passed as a keyword such as `1+1`, `2+2` or `korting`. The `type` values used by `promotion_type` elsewhere are the internal names (percentage, multi_buy, one_plus_one, volume, limited, starting).',
  },

  'GET /api/v1/deals/new': {
    name: 'get_new_deals',
    description: 'The most recently started offers, capped at 30 rows.',
  },

  'POST /api/v1/partner/signup': {
    name: 'request_free_key',
    description: [
      'Request a free API key for an email address. A one-click link is mailed out; the key itself is never in the response.',
      'The response is deliberately identical whether or not that address already has a key, so a success here never confirms someone is a customer.',
      'Capped at 5 requests per hour per IP.',
      'This has a real-world side effect — it emails a stranger. Only call it when the user has explicitly asked for it in this conversation.',
    ].join('\n'),
    readOnly: false,
  },

  'GET /api/v1/partner/usage': {
    name: 'get_partner_usage',
    description:
      'Current rate-limit usage and account info for the configured API key. Requires a valid partner key, so it fails with 401 when the server is running without one.',
  },

  'GET /api/v1/sla/summary': {
    name: 'get_sla_summary',
    description:
      'Availability per calendar month, newest first. Answers "was the API down last Tuesday?" with a number instead of a guess.',
  },
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  endpoint: Endpoint;
  execute: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * Endpoints the PrijsProfeet API answers with 403 unless the key is on the Pro
 * plan. Verified against a live free key on 2026-09-25, not read off the docs:
 * the published changelog only mentions `/match/*` and price history, but
 * `shelf-prices` and `match/stats` are gated too.
 */
export const PRO_PLAN_ENDPOINTS: ReadonlySet<string> = new Set([
  'GET /api/v1/match/ean/{ean}',
  'GET /api/v1/match/product/{product_id}',
  'GET /api/v1/match/compare/{ean}',
  'GET /api/v1/match/stats',
  'GET /api/v1/shelf-prices',
  'GET /api/v1/products/{product_id}/price-history',
]);

export interface BuildResult {
  tools: McpTool[];
  /** Tool names withheld because the configured plan does not cover them. */
  excluded: string[];
}

export function buildTools(
  spec: OpenApiDocument,
  client: PrijsProfeetClient,
  toolPrefix: string,
  plan: 'free' | 'pro' = 'free',
): BuildResult {
  const resolver = new SchemaResolver(spec);
  const tools: McpTool[] = [];
  const excluded: string[] = [];
  const used = new Set<string>();

  for (const endpoint of collectEndpoints(spec)) {
    const curated = CATALOG[endpoint.id];
    const name = `${toolPrefix}_${curated?.name ?? fallbackName(endpoint)}`;
    if (used.has(name)) {
      throw new Error(`Duplicate tool name "${name}" for ${endpoint.id}`);
    }
    used.add(name);

    // A tool that always 403s is worse than no tool: it costs a round trip and
    // invites the model to invent a workaround. Withhold it instead.
    if (plan === 'free' && PRO_PLAN_ENDPOINTS.has(endpoint.id)) {
      excluded.push(name);
      continue;
    }

    const parameters = resolveParameters(resolver, endpoint);
    const bodyProperties = resolveBodyProperties(resolver, endpoint);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const parameter of parameters) {
      const schema = parameterToJsonSchema(resolver, parameter);
      if (!schema) continue;
      properties[parameter.name] = schema;
      if (parameter.required) required.push(parameter.name);
    }

    for (const [key, schema] of Object.entries(bodyProperties.properties)) {
      properties[key] = schema;
      if (bodyProperties.required.includes(key)) required.push(key);
    }

    const inputSchema: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) inputSchema.required = required;
    inputSchema.additionalProperties = false;

    const readOnly = curated?.readOnly ?? endpoint.method === 'get';

    tools.push({
      name,
      description: curated?.description ?? endpoint.operation.summary ?? `${endpoint.id} — no description in the spec.`,
      inputSchema,
      annotations: {
        title: curated?.name ?? name,
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
      endpoint,
      execute: (args) => callEndpoint(client, endpoint, parameters, bodyProperties.fields, args),
    });
  }

  return { tools, excluded };
}

function collectEndpoints(spec: OpenApiDocument): Endpoint[] {
  return listEndpoints(spec).sort((a, b) => a.id.localeCompare(b.id));
}

function fallbackName(endpoint: Endpoint): string {
  const slug = (endpoint.path.replace(/^\/api\/v1\//, '').replace(/[{}]/g, '') || 'root')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return endpoint.method === 'get' ? slug : `${slug}_${endpoint.method}`;
}

/** Flattens `parameters`, resolving `$ref`s and dropping the ones a caller must not set. */
function resolveParameters(resolver: SchemaResolver, endpoint: Endpoint): ParameterObject[] {
  const resolved = (endpoint.operation.parameters ?? []).map((parameter) => {
    if (!parameter.$ref) return parameter;
    const target = resolver.resolve(parameter as unknown as SchemaObject) as unknown as ParameterObject | undefined;
    return target ?? parameter;
  });

  return resolved.filter((parameter) => {
    // Cookies are browser plumbing (`pp_uid`) and headers are the auth key, which
    // the client injects. Neither is something a tool caller should be able to set.
    return parameter.in === 'path' || parameter.in === 'query';
  });
}

function resolveBodyProperties(
  resolver: SchemaResolver,
  endpoint: Endpoint,
): { properties: Record<string, unknown>; required: string[]; fields: Set<string> } {
  const content = endpoint.operation.requestBody?.content ?? {};
  const json = content['application/json'] ?? Object.values(content)[0];
  const resolved = toJsonSchema(resolver, json?.schema);
  if (!resolved || typeof resolved.properties !== 'object' || resolved.properties === null) {
    return { properties: {}, required: [], fields: new Set() };
  }
  const properties = resolved.properties as Record<string, unknown>;
  const required = Array.isArray(resolved.required) ? (resolved.required as string[]) : [];
  return { properties, required, fields: new Set(Object.keys(properties)) };
}

async function callEndpoint(
  client: PrijsProfeetClient,
  endpoint: Endpoint,
  parameters: ParameterObject[],
  bodyFields: Set<string>,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const pathParams: Record<string, QueryValue> = {};
  const query: Record<string, QueryValue> = {};

  for (const parameter of parameters) {
    const value = args[parameter.name];
    if (value === undefined || value === null) continue;
    if (parameter.in === 'path') pathParams[parameter.name] = value as QueryValue;
    else query[parameter.name] = value as QueryValue;
  }

  const body: Record<string, unknown> = {};
  for (const name of bodyFields) {
    const value = args[name];
    if (value !== undefined && value !== null) body[name] = value;
  }

  try {
    const response = await client.request({
      method: endpoint.method.toUpperCase(),
      path: endpoint.path,
      pathParams,
      query,
      body: Object.keys(body).length > 0 ? body : undefined,
    });

    return formatResult(endpoint, response.data, response.raw, response.truncated, response.url, response.status);
  } catch (error) {
    if (error instanceof ApiError) {
      const hint = error.hint ? `\n\nHint: ${error.hint}` : '';
      return {
        content: [{ type: 'text', text: `${error.message}${hint}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `${endpoint.id} failed: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

function formatResult(
  endpoint: Endpoint,
  data: unknown,
  raw: string,
  truncated: boolean,
  url: string,
  status: number,
): CallToolResult {
  if (truncated) {
    return {
      content: [
        {
          type: 'text',
          text: [
            `${endpoint.id} returned HTTP ${status} but the response was too large to include in full.`,
            'Narrow it down: add a filter, or ask for a smaller page_size.',
            '',
            `First ${raw.length} characters:`,
            raw,
          ].join('\n'),
        },
      ],
      structuredContent: { truncated: true, bytes: raw.length, url, status },
    };
  }

  if (data !== null && data !== undefined) {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: wrap(data, url, status),
    };
  }

  return {
    content: [{ type: 'text', text: raw.length > 0 ? raw : `${endpoint.id} returned HTTP ${status} with an empty body.` }],
    structuredContent: { empty: true, url, status },
  };
}

function wrap(data: unknown, url: string, status: number): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { result: data as never, _meta: { url, status } };
  }
  return { ...(data as Record<string, unknown>), _meta: { url, status } };
}

export const __testing = { CATALOG, fallbackName, collectEndpoints, PRO_PLAN_ENDPOINTS };
