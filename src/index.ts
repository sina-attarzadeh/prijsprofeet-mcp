#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadConfig, type Config } from './config.js';
import { PrijsProfeetClient } from './client.js';
import { describeError, loadSpec } from './spec.js';
import { createMcpServer } from './server.js';
import { buildTools, NEVER_EXPOSED_ENDPOINTS, type McpTool } from './tools.js';

const BANNED_USER_AGENT_TERMS = ['bot', 'crawler', 'spider', 'slurp'];

/**
 * Compares two secrets without leaking their contents or length through timing.
 * Hashing first gives both sides a fixed length, so timingSafeEqual does not
 * throw on a length mismatch and the mismatch itself is not a timing signal.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** The connecting peer, which behind Render's proxy is the proxy, not the client. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (chain ?? req.socket.remoteAddress ?? 'unknown').split(',')[0]!.trim();
}

/** A bad env var is an operator error, not a crash: report it and stop cleanly. */
function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    process.stderr.write(`[prijsprofeet-mcp] configuration error: ${describeError(error)}\n`);
    process.exit(1);
  }
}

const config = loadConfigOrExit();

/** stdout belongs to the MCP stdio stream; every diagnostic goes to stderr. */
const log = (message: string): void => {
  if (config.debug) process.stderr.write(`[prijsprofeet-mcp] ${message}\n`);
};

const userAgent = config.userAgent.toLowerCase();
const bannedTerm = BANNED_USER_AGENT_TERMS.find((term) => userAgent.includes(term));
if (bannedTerm) {
  process.stderr.write(
    `[prijsprofeet-mcp] warning: the User-Agent contains "${bannedTerm}". ` +
      'PrijsProfeet answers 403 to keyless requests from agents that look like a scraper, ' +
      'even though nothing is broken. Set PRIJSPROFEET_USER_AGENT to a plain app name.\n',
  );
}

async function start(): Promise<void> {
  const spec = await loadSpec(config, log);
  const client = new PrijsProfeetClient(config);
  const { tools, excluded } = buildTools(spec, client, config.toolPrefix, config.plan);

  log(`plan: ${config.plan}`);
  log(`tools: ${tools.length} exposed, ${excluded.length} withheld (Pro plan)`);
  for (const name of excluded) {
    log(`withheld: ${name}`);
  }
  log(`never exposed: ${[...NEVER_EXPOSED_ENDPOINTS].join(', ')}`);
  log(`api: ${config.baseUrl} (key ${config.apiKey ? 'configured' : 'absent — anonymous Gratis tier'})`);

  const keyNote = config.apiKey ? 'set' : 'not set (anonymous tier)';
  const planNote = config.plan === 'pro' ? 'pro' : `free (${excluded.length} Pro tools withheld)`;
  if (config.transport === 'http') {
    await startHttp(tools, log);
    process.stderr.write(
      `[prijsprofeet-mcp] ready — ${tools.length} tools on http://${config.httpHost}:${config.httpPort}${config.httpPath}, ` +
        `plan ${planNote}, api ${config.baseUrl}, key ${keyNote}\n`,
    );
  } else {
    await startStdio(tools, log);
    process.stderr.write(
      `[prijsprofeet-mcp] ready — ${tools.length} tools on stdio, plan ${planNote}, api ${config.baseUrl}, key ${keyNote}\n`,
    );
  }
}

async function startStdio(tools: McpTool[], log: (message: string) => void): Promise<void> {
  const server = createMcpServer(tools, log);
  await server.connect(new StdioServerTransport());
}

async function startHttp(tools: McpTool[], log: (message: string) => void): Promise<void> {
  const { httpHost, httpPort, httpPath, authTokens } = config;

  if (authTokens.length === 0) {
    const tier = config.apiKey ? 'the configured key' : 'the anonymous tier';
    process.stderr.write(
      `[prijsprofeet-mcp] WARNING: MCP_AUTH_TOKEN is unset, so ${httpPath} accepts unauthenticated calls.\n` +
        `[prijsprofeet-mcp] WARNING: anyone who can reach this URL spends ${tier} and its rate limit. ` +
        'Set MCP_AUTH_TOKEN before exposing this beyond loopback.\n',
    );
  }

  // The two secrets are independent and must stay that way: the token is handed
  // to every MCP client, the partner key is never. Reusing one value for both
  // means connecting a client hands over the PrijsProfeet key itself.
  const reusedToken = config.apiKey && authTokens.some((token) => constantTimeEquals(token, config.apiKey!));
  if (reusedToken) {
    process.stderr.write(
      `[prijsprofeet-mcp] WARNING: MCP_AUTH_TOKEN has the same value as PRIJSPROFEET_API_KEY.\n` +
        '[prijsprofeet-mcp] WARNING: every MCP client now holds your PrijsProfeet key. ' +
        'Use a separate random value for MCP_AUTH_TOKEN (openssl rand -base64 32).\n',
    );
  }

  const http = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log(`http error: ${describeError(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];

    // Left unauthenticated on purpose: the platform health check polls it, and
    // a liveness probe that 401s is a liveness probe that never passes.
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: tools.length }));
      return;
    }

    if (path !== httpPath) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', mcp: httpPath, health: '/healthz' }));
      return;
    }

    if (!isAuthorized(req, res)) return;

    // Stateless: one server + transport per request, torn down with the response.
    // No session state to keep, so the endpoint survives restarts and scales
    // behind a load balancer without session affinity.
    const server = createMcpServer(tools, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  /**
   * Static bearer-token check.
   *
   * A deliberate deviation from the MCP spec, which asks HTTP servers to
   * implement OAuth 2.1. A single-tenant tool with one operator does not need
   * a user model, and a static token is auditable in a way an OAuth flow is not
   * — but it means one shared secret, so rotate it if it ever leaks.
   */
  function isAuthorized(req: IncomingMessage, res: ServerResponse): boolean {
    if (authTokens.length === 0) return true;

    const header = req.headers.authorization ?? '';
    const presented = /^bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? '';
    const ok = presented.length > 0 && authTokens.some((token) => constantTimeEquals(presented, token));

    if (ok) return true;

    const ip = clientIp(req);
    process.stderr.write(`[prijsprofeet-mcp] 401 from ${ip} on ${httpPath}\n`);
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer realm="prijsprofeet-mcp", error="invalid_token", error_description="Send Authorization: Bearer <token>"`,
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(httpPort, httpHost, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const shutdown = (signal: string) => {
    log(`${signal} received, closing`);
    http.close(() => process.exit(0));
    // Do not let a hung keep-alive connection block the shutdown.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error: unknown) => {
  process.stderr.write(`[prijsprofeet-mcp] fatal: ${describeError(error)}\n`);
  process.exit(1);
});
