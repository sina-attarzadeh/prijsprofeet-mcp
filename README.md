# prijsprofeet-mcp
Unofficial MCP server for the PrijsProfeet API

> **Warning:** This is an unofficial project and is not developed, endorsed, or supported by PrijsProfeet.  
> For official information, see the [PrijsProfeet API](https://www.prijsprofeet.nl/api) and [API voorwaarden](https://www.prijsprofeet.nl/api-voorwaarden).  

A Dockerized [MCP](https://modelcontextprotocol.io) server for the [PrijsProfeet](https://www.prijsprofeet.nl) API:
live offers from 10 Dutch supermarket chains (Albert Heijn, Aldi, DekaMarkt, Dirk, Ekoplaza, Hoogvliet,
Jumbo, Lidl, PLUS, Vomar) as one normalised JSON API.

The 25 tools are generated from the OpenAPI document at `https://www.prijsprofeet.nl/openapi.json` (a copy is
bundled in the image, because the live one sits behind Cloudflare and is not reachable from a server). Argument
schemas come from the spec; the tool names and descriptions are curated, because a good description is what stops
a model from quoting a price nobody is charging.

## Quick start

```bash
docker build -t prijsprofeet-mcp .
docker run -i --rm -e PRIJSPROFEET_API_KEY prijsprofeet-mcp
```

That speaks MCP over stdio, so it wants to be run by an MCP client rather than by hand.

## Wiring it into a client

The key is read from the `PRIJSPROFEET_API_KEY` environment variable and sent as the `X-API-Key` header.

### stdio — the client launches the container

This is the default, and the right choice for a local Docker tool: no port, no auth surface, no network listener.

```bash
docker run -i --rm -e PRIJSPROFEET_API_KEY prijsprofeet-mcp:latest
```

#### opencode

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "prijsprofeet": {
      "type": "local",
      "command": ["docker", "run", "-i", "--rm", "-e", "PRIJSPROFEET_API_KEY", "prijsprofeet-mcp:latest"],
      "environment": { "PRIJSPROFEET_API_KEY": "{env:PRIJSPROFEET_API_KEY}" },
      "enabled": true
    }
  }
}
```

opencode prefixes tool names with the server name, so the tools arrive as `prijsprofeet_pp_search`,
`prijsprofeet_pp_get_categories`, and so on. Prompt with `use the prijsprofeet tools` to pull them in.

#### Claude Desktop / any stdio client

`claude_desktop_config.json` only accepts `command`-shaped servers, so the container is the entry point — Desktop
launches it and talks to it over pipes:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Settings → Developer → Edit Config opens it. Build the image once first, then point the entry at it:

```bash
docker build -t prijsprofeet-mcp:latest .
```

```json
{
  "mcpServers": {
    "prijsprofeet": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/to/.env",
        "prijsprofeet-mcp:latest"
      ]
    }
  }
}
```

Desktop apps launched from a dock do not inherit your shell environment, so `--env-file` is the reliable way to
get `PRIJSPROFEET_API_KEY` in; `-e PRIJSPROFEET_API_KEY` only works if the variable is already exported in the
process that started the app. Use an absolute path — the app's working directory is not your shell's.

Then fully quit and relaunch. Closing the window leaves the previous container running; the config is read once at
process start, so edits made while the app is open do nothing.

With stdio there is no port and therefore no `MCP_AUTH_TOKEN` — the client owns the container's lifetime and talks
to it over pipes. The token only exists in the [HTTP](#http--the-client-connects-to-a-url) transport.

> **Never paste a `url` into `claude_desktop_config.json`.** Desktop's config schema is stdio-only: an entry with
> `url`, `type`, or `headers` fails validation, and recent builds respond by rewriting the file with the whole
> `mcpServers` block removed — taking your working entries with it, silently
> ([#37286](https://github.com/anthropics/claude-code/issues/37286)). The `url` + `headers` + `"type": "http"` shape
> belongs to Claude Code's `~/.claude.json`, which is a different client with a different parser. For a remote
> endpoint, use the [mcp-remote bridge](#claude-desktop) below.

### HTTP — the client connects to a URL

Set `PRIJSPROFEET_TRANSPORT=http` and the same container serves Streamable HTTP instead:

```bash
docker run -d --rm -p 127.0.0.1:3000:3000 \
  -e PRIJSPROFEET_TRANSPORT=http \
  -e MCP_AUTH_TOKEN="$(openssl rand -base64 32)" \
  -e PRIJSPROFEET_API_KEY \
  prijsprofeet-mcp:latest
```

| Endpoint | Auth |
| --- | --- |
| `http://localhost:3000/mcp` | `Authorization: Bearer $MCP_AUTH_TOKEN` |
| `http://localhost:3000/healthz` | none, so a platform health check can poll it |

In opencode that is a remote server rather than a local one:

```jsonc
{
  "mcp": {
    "prijsprofeet": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "enabled": true
    }
  }
}
```

Or with compose, which keeps it bound to loopback:

```bash
cp .env.example .env   # then fill in the key
docker compose --profile http up -d prijsprofeet-mcp-http
```

##### Claude Desktop

Desktop has no schema for a remote endpoint, so a `command` entry is the only way in — `mcp-remote` is a stdio
bridge that speaks Streamable HTTP on the other side, and it carries the `Authorization` header that Desktop's own
remote path cannot:

```json
{
  "mcpServers": {
    "prijsprofeet": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://prijsprofeet-mcp.onrender.com/mcp",
        "--transport", "http-only",
        "--header", "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"
      ]
    }
  }
}
```

`--transport http-only` is not optional decoration: `mcp-remote` otherwise negotiates the SSE half of Streamable
HTTP first, `GET`s this endpoint, gets a `405` back, and stalls through a backoff before retrying as POST. With it
pinned, only the POST path is used.

Settings → Connectors → Add custom connector is not an alternative here. That flow is OAuth-only, and this server
authenticates with a bearer token it has no OAuth endpoints for.

Desktop reads the config once at process start, so fully quit and relaunch after editing — closing the window is
not enough. Check Settings → Developer for a `connected` entry with the tool count this server publishes.

That block works unchanged against the local `http://localhost:3000/mcp` from the compose service above, with
`Bearer $MCP_AUTH_TOKEN` in the header.

> **A `401` from this server is a dead end, not a login prompt.** Clients treat an unauthenticated `401` from an
> HTTP MCP server as a request to start an OAuth flow (Claude Desktop 1.24012.0+, and `mcp-remote` alike). This
> server has no OAuth endpoints, so the flow cannot complete: `mcp-remote` logs
> `Dynamic Client Registration rejected (HTTP 404)` and exits, and Desktop opens a browser to a sign-in page that
> can never succeed. Both mean the same thing — a typo in the token, a stale token after rotation, or a wrong
> `url`. The usual culprit is the literal string `YOUR_MCP_AUTH_TOKEN` still sitting in the file. A correctly
> configured client never sees a `401`.

The token sits in plaintext in this file, so `chmod 600` it and keep the file out of any repo. It is the
`MCP_AUTH_TOKEN` value, not `PRIJSPROFEET_API_KEY` — never put the partner key in a client config.

The HTTP transport is stateless — no session id, nothing held between requests — so the endpoint survives restarts
and needs no sticky sessions behind a load balancer. Requests must send `Accept: application/json, text/event-stream`
and `Content-Type: application/json`; it answers `406` and `415` respectively when you get that wrong, which is
what the MCP spec asks for.

> **The API key is server-side in this mode, so `MCP_AUTH_TOKEN` is the only thing standing between the public
> internet and your rate limit.** It is optional in code — unset, the server still starts and logs a warning — but
> treat an unset token as a deployment mistake, not a local-dev convenience. See [Security](#security).

`docker compose run --rm prijsprofeet-mcp` is still the right command for the stdio service: a stdio server has no
port, so the client has to own the container's lifetime.

## Deploying to Render

`render.yaml` is a Render blueprint, so the deploy is New → Blueprint → point at the repo. It builds the Dockerfile
as a `web` service in `frankfurt` with the health check on `/healthz`.

Two things in it are deliberate. One is a trade-off, the other is easy to "fix" in a way that breaks the deploy:

- **`plan: free` by default, which means the service sleeps.** 512 MB at $0, but a Free web service spins down after
  15 minutes without traffic and takes **about a minute** to wake. MCP clients fetch `tools/list` on connect with a
  timeout usually measured in seconds, so against a service that has been idle the client reports a timeout and gives
  up while the server is still booting — the server cannot distinguish that from being dead, and there is nothing to
  fix from the server side. Staying on `free` means picking one of:

  | Option | What it costs you |
  | --- | --- |
  | Raise the client timeout to ~90s | The first connect after every idle period eats the wait, or fails if the client caps out earlier |
  | `GET /healthz` a minute before you start | A manual step per session, and it only helps if you remember it |
  | Do nothing | Works while you are actively using it, times out on the first connect after a break |

  None of that is a server problem, it is the plan. If the endpoint has to be up the moment a client opens a session,
  switch to **`plan: 0.5c-512mb`** (formerly `starter`, $7/month): it never sleeps, the cold start disappears, and the
  only cost is the bill. It is one line in `render.yaml` — the free one is left commented out beside it.
- **No `PRIJSPROFEET_HTTP_PORT`.** Render injects `PORT`; the server reads that and falls back to 3000. Pinning the
  port in the blueprint or the Dockerfile shadows `PORT`, the container listens where nobody is looking, and Render
  reports the deploy as live while every request 502s.

Render prompts for `PRIJSPROFEET_API_KEY` on first deploy, so the partner key never enters the repo. It generates
`MCP_AUTH_TOKEN` for you — read it from Dashboard → Environment, then put it in your client's `headers`.

The service is stateless and single-instance, so deploys are not zero-downtime: a redeploy drops in-flight requests
and clients reconnect. `maxShutdownDelaySeconds` is left at the 30s default, which is more than the server's own 5s
drain needs.

## Security

The threat model is narrow and worth stating plainly: **this server has no user accounts, no database, and no writes
to your filesystem. What an attacker wants is your PrijsProfeet key's rate limit, or just the data you can query
with it.** Ordered by what actually helps:

**1. Set `MCP_AUTH_TOKEN`.** A 256-bit random string, compared in constant time via `crypto.timingSafeEqual`, and
returned as a `401` with a `WWW-Authenticate: Bearer` challenge when missing or wrong. Every failed attempt is
logged with the client IP, so scanning shows up in the Render log stream.

Rotation is comma-separated and overlap-friendly: set `MCP_AUTH_TOKEN=new,old`, deploy, move your client to `new`,
then drop `old`. No window where both are down.

**2. Remember what this is not.** A static bearer token is a deliberate deviation from the MCP spec, which asks
HTTP servers to implement OAuth 2.1. That is the right trade for a single-tenant tool with one operator, and the
wrong one for a shared or multi-user deployment — if you need per-caller identity, per-caller revocation, or
scoped access, put a real OAuth proxy in front of it rather than extending this.

**3. Lock the plan down, not just the endpoint.** `PRIJSPROFEET_PLAN=free` withholds the 6 Pro tools, so a leaked
token cannot reach the matching and price-history endpoints even if the key is Pro.

**4. Prefer a tunnel over a public hostname if you can.** Cloudflare Tunnel or Tailscale put the endpoint on a URL
nobody can scan, which removes the guessing game entirely. Render's own `ipAllowList` is *not* an option here — it
requires a Scale or Enterprise workspace.

**5. Do not set a suspicious User-Agent.** `bot`, `crawler`, `spider` and `slurp` in `PRIJSPROFEET_USER_AGENT` get
403 from PrijsProfeet on keyless requests, which looks like an outage but is not one. The server warns at startup.

**If the key or token ever leaks:** rotate the PrijsProfeet key in their dashboard, then rotate
`MCP_AUTH_TOKEN` as above. Rotating the token alone does not help if the key is what leaked, because the key is
what the attacker was spending.

## The tools

19 tools are exposed by default, which is everything the API serves on a free key. The remaining 6 need the Pro
plan and are withheld — see [Plans](#plans) below.

| Tool | What it does |
| --- | --- |
| `pp_search` | Search offers across all chains, filtered by retailer, category, status, price, savings, diet |
| `pp_get_categories` | The 25 category slugs with counts — call this before filtering by category |
| `pp_get_filter_stats` | Facet counts for a query, to see what a filter would still return |
| `pp_list_products` | Bulk list with retailer, folder, promo-group and validity-window filters |
| `pp_get_product` | Full detail for one product |
| `pp_get_products_by_folder` | Every product in one promotional folder |
| `pp_get_products_by_retailer` | Everything from one chain |
| `pp_get_promotional_products` | Everything currently on offer |
| `pp_search_products_by_name` | The older path-based product search; `pp_search` supersedes it |
| `pp_get_top_deals` / `pp_get_brand_deals` / `pp_get_deals_by_type` / `pp_get_new_deals` / `pp_get_popular_deals` / `pp_get_deals_summary` | Offer browsing and aggregates |
| `pp_get_price_forecast` | Backtested price forecast; returns `null` when there is none, which is not an error |
| `pp_health_check` | Liveness of the API and its backing services |
| `pp_get_sla_summary` | Availability per calendar month |
| `pp_get_partner_usage` | Rate-limit usage and account info for the configured key |

### Plans

`PRIJSPROFEET_PLAN` decides whether the Pro-gated tools are exposed. It defaults to `free`.

| `PRIJSPROFEET_PLAN` | Tools |
| --- | --- |
| `free` (default) | 19 — the set above |
| `pro` | 25 — adds the 6 below |

The withheld six, all of which answer `403 This endpoint requires the Pro plan` on a free key:

| Tool | Endpoint |
| --- | --- |
| `pp_match_by_ean` | `GET /api/v1/match/ean/{ean}` |
| `pp_match_for_product` | `GET /api/v1/match/product/{product_id}` |
| `pp_compare_prices` | `GET /api/v1/match/compare/{ean}` |
| `pp_get_ean_stats` | `GET /api/v1/match/stats` |
| `pp_search_shelf_prices` | `GET /api/v1/shelf-prices` |
| `pp_get_price_history` | `GET /api/v1/products/{id}/price-history` |

That list was verified call by call against a live free key, not read off the published docs, which only mention
`/match/*` and price history. Withholding is deliberate: a tool that always fails costs a round trip and invites
the model to invent a workaround, so on the free plan it is not merely unused but invisible — calling it returns
`Unknown tool`, and the server's instructions stop advertising the features. If you upgrade, set
`PRIJSPROFEET_PLAN=pro` and restart; no rebuild needed.

One endpoint is withheld on **every** plan, not just the free one: `POST /api/v1/partner/signup`, which mints a
PrijsProfeet key and mails it to an address the caller supplies. It is a write against a third party's signup flow,
reachable by anyone who can reach this server, and its net effect is to email a stranger — so it is off rather than
merely discouraged in the description. That is why the spec describes 26 endpoints and this server exposes 25 on
`pro`. There is no environment variable to re-enable it; `NEVER_EXPOSED_ENDPOINTS` in `src/tools.ts` is the only
place it is named. Ask at https://www.prijsprofeet.nl/api if you need a key.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRIJSPROFEET_API_KEY` | *(unset)* | Partner key, sent as `X-API-Key`. Unset means the anonymous Gratis tier. `PP_API_KEY` and `X_API_KEY` are accepted as aliases. |
| `PRIJSPROFEET_BASE_URL` | `https://www.prijsprofeet.nl` | API origin |
| `PRIJSPROFEET_PLAN` | `free` | `free` exposes 19 tools, `pro` exposes all 25 |
| `PRIJSPROFEET_TRANSPORT` | `stdio` | `stdio` (client launches the container) or `http` (serve a URL) |
| `MCP_AUTH_TOKEN` | *(unset)* | Comma-separated bearer tokens for the http transport. Unset means **no auth** — the server starts and warns, so this is only safe on loopback. |
| `PORT` | *(unset)* | Honoured when `PRIJSPROFEET_HTTP_PORT` is unset, which is what Render, Heroku and Fly inject |
| `PRIJSPROFEET_HTTP_HOST` | `0.0.0.0` | Interface for http mode |
| `PRIJSPROFEET_HTTP_PORT` | `3000` | Port for http mode |
| `PRIJSPROFEET_HTTP_PATH` | `/mcp` | Path for http mode |
| `PRIJSPROFEET_TIMEOUT_MS` | `30000` | Per-request timeout |
| `PRIJSPROFEET_MAX_RETRIES` | `2` | Retries on 429/5xx and network errors, with backoff honouring `Retry-After` |
| `PRIJSPROFEET_MAX_RESPONSE_BYTES` | `250000` | Responses above this are truncated with a note instead of returned whole |
| `PRIJSPROFEET_USER_AGENT` | `prijsprofeet-mcp/1.0` | Sent on every request |
| `PRIJSPROFEET_REFRESH_SPEC` | `0` | Fetch the OpenAPI document at startup instead of using the bundled copy |
| `PRIJSPROFEET_SPEC_URL` | `https://www.prijsprofeet.nl/openapi.json` | Where to refresh from |
| `PRIJSPROFEET_TOOL_PREFIX` | `pp` | Prefix on every tool name |
| `DEBUG` | `0` | Diagnostics on stderr |

## Things worth knowing before you trust a price

**A price is not a price until you read `promotion_status`.** Every row carries one of four values, and they mean
different things: `active` (on offer now), `upcoming` (starts next week), `shelf` (the regular price — no
promotion at all) and `historical` (the last price seen, up to 60 days old). Taking the lowest `price` across all
four hands you a number that no retailer is charging. The tool descriptions and the server instructions push back
on this, but it is the single easiest mistake to make with this API.

**This is offers, not an assortment.** Products that are not on promotion are absent, so a recipe app built on
`pp_search` alone will find a fraction of its ingredients, and a different fraction each week. On the free plan
there is no way around it: the only endpoint that exposes regular non-promotion prices, `pp_search_shelf_prices`,
is Pro-gated along with the matching tools. On Pro you get both that and cross-retailer comparison.

**Not every chain publishes an EAN.** Aldi, Lidl, Hoogvliet and Vomar do not, so for those chains the cross-retailer
match (Pro) falls back to name, brand and category. Those rows are indicative, not product identity.

**Pro-gated tools are withheld, not broken.** On the default `free` plan the six tools in
[Plans](#plans) are absent from `tools/list` entirely, so the model never spends a call discovering they 403. If
you call one by name you get `Unknown tool`. Set `PRIJSPROFEET_PLAN=pro` to get all 25.

**Do not put `bot`, `crawler`, `spider` or `slurp` in the User-Agent.** The API answers 403 to keyless requests
that look like a scraper, which reads like an outage but is not one. The default User-Agent is clean; the server
warns on stderr at startup if `PRIJSPROFEET_USER_AGENT` is set to something suspicious. Naming yourself is the
courteous thing to do and is the only way the API operator can reach you before a breaking change.

**Rate limits** are per IP: 120/min on search and product detail and 30/min on the bulk endpoints with no key,
150/min with a free key, 300/min on Pro, 1000/min on Business. A key is therefore always a rate-limit upgrade,
never a downgrade.

## Development

```bash
npm install
npm run build       # tsc + copy the spec into dist/
npm start           # run over stdio
npm run typecheck
npm run inspect     # print the generated tool surface, no transport
```

`npm run inspect -- --json` dumps the full tool definitions, which is the quickest way to see what a model
actually receives.

### Layout

| File | Role |
| --- | --- |
| `src/spec.ts` | OpenAPI types, endpoint collection, spec loading with fallback |
| `src/schema.ts` | Resolves `$ref`s, collapses OpenAPI 3.1 nullable unions, drops doc-only keywords |
| `src/tools.ts` | The curated tool catalogue and the spec-to-tool generator |
| `src/client.ts` | HTTP: auth header, retries, timeout, bounded reads, error hints |
| `src/server.ts` | MCP server factory and the instructions handed to the model |
| `src/index.ts` | Transport selection: stdio, or Streamable HTTP plus `/healthz` |
| `src/config.ts` | Environment parsing |
| `src/openapi.json` | Bundled copy of the spec, pinned at image build time |

To add a curated description for a new endpoint, add an entry to `CATALOG` in `src/tools.ts` keyed by
`"METHOD /path"`. Unlisted endpoints still appear, under a name derived from the path — the catalogue only
overrides.
