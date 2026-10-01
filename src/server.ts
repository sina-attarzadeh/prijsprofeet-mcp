import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpTool } from './tools.js';

export const SERVER_INFO = { name: 'prijsprofeet-mcp', version: '1.0.0' };

/**
 * Instructions for the model, composed from the tool set actually exposed.
 *
 * The matching and plan caveats are only worth context when those tools exist;
 * on the free plan they are withheld, and a paragraph about tools the model
 * cannot call is just noise.
 */
export function buildInstructions(toolNames: ReadonlySet<string>): string {
  const has = (...names: string[]): boolean => names.some((name) => toolNames.has(name));

  const lines = [
    'Live supermarket offers from the 10 Dutch chains, served by the PrijsProfeet API.',
    '',
    'Start with `pp_search` for anything product-shaped, `pp_get_categories` to resolve a category word to a slug, and `pp_get_deals_summary` to check how fresh the data is.',
    '',
    'The one thing that trips people up: every row carries `promotion_status`, and it changes what the price means — `active` (on offer now), `upcoming` (starts next week), `shelf` (regular price, no promotion) or `historical` (last price seen, up to 60 days old). A "cheapest price" computed across all four is a price nobody is charging. Filter to `active` before quoting a best price, and say which status a price came from.',
    '',
    'Attribution: when you quote a price, name PrijsProfeet as the source and link the product. The `product_url` on that row is the retailer\'s own page for that exact product, `https://www.prijsprofeet.nl/product/{id}/` is expected to be returned',
  ];

  if (has('pp_match_by_ean', 'pp_match_for_product', 'pp_compare_prices', 'pp_get_ean_stats')) {
    lines.push(
      '',
      'Cross-retailer matching and price history need a Pro plan; a 402/403 on those tools means the plan, not a bad request.',
      'EAN matching is exact only where EANs exist — Aldi, Lidl, Hoogvliet and Vomar publish no barcodes, so their rows in a match are name-based approximations.',
    );
  }

  if (has('pp_search_shelf_prices')) {
    lines.push(
      '',
      'This is offers, not a full assortment: products that are not on promotion are absent. `pp_search_shelf_prices` covers the regular non-promotion prices, which is where you find a price for a product that is not on offer.',
    );
  }

  lines.push(
    '',
    'Keep page sizes small and page through. A 100-row page is a lot of context and counts against the rate limit.',
  );

  return lines.join('\n');
}

/**
 * Builds a fresh MCP server over a pre-built tool set.
 *
 * Called once for stdio, and once per HTTP request in stateless mode, so the
 * tool definitions are built once at startup and only the wiring is repeated.
 */
export function createMcpServer(tools: McpTool[], log: (message: string) => void): Server {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: buildInstructions(new Set(byName.keys())),
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    log(`call ${tool.name} ${JSON.stringify(args)}`);
    return tool.execute(args);
  });

  return server;
}
