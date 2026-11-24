import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedMcpServer, WorkspaceMcpServerMeta } from '@lody/shared';
import { LanMcpAuthentication } from '@/lib/lan/lan-mcp-auth';
import {
  AGY_LAZY_FACADE_FLOOR_TOKENS,
  AGY_MCP_PROXY_HEADER,
  applyAgyExternalMcpProxyHeaders,
  computeAgyServerTokenShare,
  describeAgyExternalBudgetOverflow,
  estimateAgyToolTokens,
  formatAgyMcpProxyHeader,
  loadAgyMcpPermissionRules,
  parseAgyMcpPermissionRule,
  parseAgyMcpProxyHeader,
  parseMcpRpcResponseBody,
  resolveAgyConfigContext,
  rewriteToolsForAgyBudget,
  withAgyMcpBudgetProxy,
  type AgyMcpPermissionLoadResult,
  type AgyMcpPermissionRules,
  type UpstreamMcpTool,
} from './agy-external-mcp-proxy';
import { makeMcpAuthenticationIO, type McpRelayEndpoint } from './authentication/io';

function decodeFetchBody(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  return '{}';
}

function makeSyntheticTools(count: number, schemaPadBytes: number): UpstreamMcpTool[] {
  const pad = 'x'.repeat(schemaPadBytes);
  return Array.from({ length: count }, (_, idx) => ({
    name: idx === 0 ? 'notion-fetch' : idx === 1 ? 'notion-query-data-sources' : `tool_${idx}`,
    description: `Perform operation ${idx} on remote workspace resources with structured filtering.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `Identifier ${idx} ${pad}` },
      },
      required: ['id'],
    },
    annotations: idx === 0 ? { readOnlyHint: true } : undefined,
  }));
}

const EMPTY_RULES: AgyMcpPermissionRules = { allow: [], ask: [], deny: [] };
const OK_EMPTY_LOAD: AgyMcpPermissionLoadResult = { status: 'ok', rules: EMPTY_RULES };

async function startProxyRelay(
  upstreamFetch: typeof fetch,
  options: {
    readonly upstreamUrl?: string;
    readonly permissionRules?: AgyMcpPermissionRules | (() => AgyMcpPermissionRules);
    readonly useProductionPermissionLoader?: boolean;
    readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly onNonOk?: (status: number) => Promise<Record<string, string> | null>;
  } = {}
): Promise<{
  readonly endpoint: McpRelayEndpoint;
  readonly close: () => Promise<void>;
}> {
  const upstreamUrl = options.upstreamUrl ?? 'https://upstream.example/mcp';
  const loadPermissionRules = options.useProductionPermissionLoader
    ? undefined
    : typeof options.permissionRules === 'function'
      ? () => ({ status: 'ok' as const, rules: options.permissionRules!() })
      : () => ({ status: 'ok' as const, rules: options.permissionRules ?? EMPTY_RULES });
  const io = withAgyMcpBudgetProxy(makeMcpAuthenticationIO(upstreamFetch), {
    ...(loadPermissionRules ? { loadPermissionRules } : {}),
    delay: options.delay ?? (async () => undefined),
  });
  let activeHeaders: Record<string, string> = { authorization: 'Bearer initial-upstream-token' };
  const controller = new AbortController();
  const endpoint = await io.relay((job) => {
    void (async () => {
      try {
        let response = await io.forward(job, upstreamUrl, activeHeaders, controller.signal);
        if (response?.status === 401 && options.onNonOk) {
          const refreshed = await options.onNonOk(401);
          if (refreshed) {
            activeHeaders = refreshed;
            response = await io.forward(job, upstreamUrl, activeHeaders, controller.signal);
          }
        }
        if (response) {
          if (!job.response.headersSent) {
            job.response.writeHead(response.status, {
              'content-type': 'text/plain; charset=utf-8',
              ...(response.headers.get('mcp-session-id')
                ? { 'mcp-session-id': response.headers.get('mcp-session-id')! }
                : {}),
            });
          }
          job.response.end(`status:${response.status}`);
        }
      } catch (error) {
        if (!job.response.headersSent) job.response.writeHead(500);
        if (!job.response.writableEnded) {
          job.response.end(error instanceof Error ? error.message : 'proxy-error');
        }
      }
    })();
    return true;
  });
  return {
    endpoint,
    close: async () => {
      controller.abort();
      await endpoint.close();
    },
  };
}

describe('agy-external-mcp-proxy pure budget & parsing helpers', () => {
  it('parses and formats proxy headers safely while rejecting malformed inputs', () => {
    const header = formatAgyMcpProxyHeader({ share: 2500, serverName: 'mail-personal' });
    expect(parseAgyMcpProxyHeader(header)).toEqual({ share: 2500, serverName: 'mail-personal' });
    expect(parseAgyMcpProxyHeader('manual;share=1000')).toBeNull();
    expect(parseAgyMcpProxyHeader('')).toBeNull();
    expect(parseAgyMcpProxyHeader('auto;' + 'a'.repeat(300))).toBeNull();
    expect(parseAgyMcpProxyHeader('auto;share=50;server=my server!')).toEqual({
      share: AGY_LAZY_FACADE_FLOOR_TOKENS,
      serverName: 'myserver',
    });
  });

  it('reports when configured external budget is below the lazy facade floor for N servers', () => {
    const threeServers: ResolvedMcpServer[] = [1, 2, 3].map((i) => ({
      type: 'http',
      name: `srv_${i}`,
      url: `http://127.0.0.1:${41000 + i}/mcp`,
      headers: [],
    }));
    const warning = describeAgyExternalBudgetOverflow(threeServers, 800);
    expect(warning).toContain('3 external HTTP MCP servers');
    expect(warning).toContain('800');
    expect(describeAgyExternalBudgetOverflow(threeServers, 2000)).toBeNull();
  });

  it('preserves full upstream tool metadata verbatim in raw mode (including execution.taskSupport)', () => {
    const rawTool = {
      name: 'run_report',
      description: 'Generate async report.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      execution: { taskSupport: 'required' },
      icons: [{ src: 'https://example.com/icon.png' }],
      _meta: { vendor: 'acme' },
    };
    const res = rewriteToolsForAgyBudget(
      [
        {
          name: rawTool.name,
          description: rawTool.description,
          inputSchema: rawTool.inputSchema,
          outputSchema: rawTool.outputSchema,
          execution: rawTool.execution,
          _meta: rawTool._meta,
          raw: rawTool,
        },
      ],
      { share: 2000, serverName: 'reports' }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.snapshot.mode).toBe('raw');
    expect(res.advertisedTools).toEqual([rawTool]);
  });

  it('parses agy mcp(...) permission rules with exact and wildcard patterns', () => {
    expect(parseAgyMcpPermissionRule('mcp(*)')).toEqual({
      serverPattern: '*',
      toolPattern: '*',
    });
    expect(parseAgyMcpPermissionRule('mcp(notion/*)')).toEqual({
      serverPattern: 'notion',
      toolPattern: '*',
    });
    expect(parseAgyMcpPermissionRule('mcp(notion/notion-delete*)')).toEqual({
      serverPattern: 'notion',
      toolPattern: 'notion-delete*',
    });
    expect(parseAgyMcpPermissionRule('command(git status)')).toBeNull();
  });

  it('attaches proxy headers only to loopback HTTP servers without mutating inputs', () => {
    const input: ResolvedMcpServer[] = [
      {
        type: 'http',
        name: 'notion',
        url: 'http://127.0.0.1:41001/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer cap-1' }],
      },
      {
        type: 'http',
        name: 'mail-personal',
        url: 'http://127.0.0.1:41002/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer cap-2' }],
      },
      {
        type: 'http',
        name: 'direct-remote',
        url: 'https://mcp.example.com/mcp',
        headers: [],
      },
      {
        name: 'local-stdio',
        command: 'node',
        args: ['server.js'],
        env: [],
      },
    ];
    const snapshot = structuredClone(input);
    const updated = applyAgyExternalMcpProxyHeaders(input, 6000);

    expect(input).toEqual(snapshot);
    expect(computeAgyServerTokenShare(2, 6000)).toBe(3000);
    expect(updated[0]).toMatchObject({
      type: 'http',
      name: 'notion',
      headers: [
        { name: 'Authorization', value: 'Bearer cap-1' },
        { name: AGY_MCP_PROXY_HEADER, value: 'auto;share=3000;server=notion' },
      ],
    });
    expect(updated[1]).toMatchObject({
      type: 'http',
      name: 'mail-personal',
      headers: [
        { name: 'Authorization', value: 'Bearer cap-2' },
        { name: AGY_MCP_PROXY_HEADER, value: 'auto;share=3000;server=mail-personal' },
      ],
    });
    expect(updated[2]).toEqual(input[2]);
    expect(updated[3]).toEqual(input[3]);
  });

  it('selects raw, compact, and lazy tiers monotonically against agy token estimates', () => {
    const small: UpstreamMcpTool[] = [
      {
        name: 'hot_list',
        description: 'Fetch trending topics.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'search',
        description: 'Search articles.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
    const rawRes = rewriteToolsForAgyBudget(small, { share: 2000, serverName: 'zhihu' });
    expect(rawRes.ok).toBe(true);
    if (!rawRes.ok) throw new Error('expected raw ok');
    expect(rawRes.snapshot.mode).toBe('raw');
    expect(rawRes.advertisedTools).toEqual(small);

    // Medium server: raw exceeds 2500 tok, compact fits and tool count <= 25.
    const medium: UpstreamMcpTool[] = [
      {
        name: 'imap_list_accounts',
        description: 'List configured accounts.',
        inputSchema: { type: 'object', properties: {} },
      },
      ...makeSyntheticTools(16, 420),
    ];
    const compactRes = rewriteToolsForAgyBudget(medium, {
      share: 2500,
      serverName: 'mail-personal',
    });
    expect(compactRes.ok).toBe(true);
    if (!compactRes.ok) throw new Error('expected compact ok');
    expect(compactRes.snapshot.mode).toBe('compact');
    expect(compactRes.advertisedTools).toHaveLength(18);
    expect(compactRes.advertisedTools[0]?.name).toBe('tools_help');
    // Zero-arg tool keeps open object without a parameter-help prompt nag.
    expect(compactRes.advertisedTools[1]?.description).not.toContain('tools_help');
    // Parameterized tool compacts inputSchema and points to tools_help.
    expect(compactRes.advertisedTools[2]?.inputSchema).toEqual({ type: 'object' });
    expect(compactRes.advertisedTools[2]?.description).toContain('tools_help({tool:');
    const compactTokens = compactRes.advertisedTools.reduce(
      (sum, tool) =>
        sum +
        estimateAgyToolTokens({
          name: String(tool.name),
          description: typeof tool.description === 'string' ? tool.description : undefined,
          inputSchema: tool.inputSchema,
        }),
      0
    );
    expect(compactTokens).toBeLessThanOrEqual(2500);

    // Giant Notion-like server: 78 tools folds into 2-tool lazy facade <= 400 tokens.
    const giant = makeSyntheticTools(78, 2500);
    const lazyRes = rewriteToolsForAgyBudget(giant, { share: 2500, serverName: 'notion' });
    expect(lazyRes.ok).toBe(true);
    if (!lazyRes.ok) throw new Error('expected lazy ok');
    expect(lazyRes.snapshot.mode).toBe('lazy');
    expect(lazyRes.advertisedTools.map((tool) => tool.name)).toEqual(['tools_help', 'tools_call']);
    const lazyTokens = lazyRes.advertisedTools.reduce(
      (sum, tool) =>
        sum +
        estimateAgyToolTokens({
          name: String(tool.name),
          description: typeof tool.description === 'string' ? tool.description : undefined,
          inputSchema: tool.inputSchema,
        }),
      0
    );
    expect(lazyTokens).toBeLessThanOrEqual(AGY_LAZY_FACADE_FLOOR_TOKENS);
    expect(lazyRes.advertisedTools[0]?.description).toContain('notion-fetch');
    expect(lazyRes.advertisedTools[0]?.description).toContain('notion-query-data-sources');
    const callSchema = lazyRes.advertisedTools[1]?.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
    };
    expect(callSchema?.properties?.argumentsJson?.type).toBe('string');
    expect(callSchema?.properties?.argumentsJson?.description).toContain('non-ASCII');
    expect(lazyRes.advertisedTools[1]?.description).toContain('argumentsJson');

    // Long server names and collision-avoidance names at minimum share still trim preview to fit <= 400 tokens.
    for (const serverName of ['personal-external-notion-workspace-server', 'a'.repeat(64)]) {
      const tightRes = rewriteToolsForAgyBudget(
        [
          { name: 'tools_help', description: 'Upstream help', inputSchema: { type: 'object' } },
          { name: 'tools_call', description: 'Upstream call', inputSchema: { type: 'object' } },
          ...giant,
        ],
        { share: AGY_LAZY_FACADE_FLOOR_TOKENS, serverName }
      );
      expect(tightRes.ok).toBe(true);
      if (!tightRes.ok) throw new Error('expected tight lazy ok');
      const tightTokens = tightRes.advertisedTools.reduce(
        (sum, tool) =>
          sum +
          estimateAgyToolTokens({
            name: String(tool.name),
            description: typeof tool.description === 'string' ? tool.description : undefined,
            inputSchema: tool.inputSchema,
          }),
        0
      );
      expect(tightTokens).toBeLessThanOrEqual(AGY_LAZY_FACADE_FLOOR_TOKENS);
    }
  });

  it('avoids synthetic tool name collisions when upstream already exports tools_help/tools_call', () => {
    const colliding: UpstreamMcpTool[] = [
      { name: 'tools_help', description: 'Upstream help', inputSchema: { type: 'object' } },
      { name: 'tools_call', description: 'Upstream call', inputSchema: { type: 'object' } },
      ...makeSyntheticTools(30, 800),
    ];
    const res = rewriteToolsForAgyBudget(colliding, { share: 2000, serverName: 'custom' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected lazy ok');
    expect(res.snapshot.mode).toBe('lazy');
    expect(res.snapshot.helpToolName).toBe('lody_mcp_help');
    expect(res.snapshot.callToolName).toBe('lody_mcp_call');
    expect(res.advertisedTools.map((t) => t.name)).toEqual(['lody_mcp_help', 'lody_mcp_call']);
  });

  it('counts UTF-8 byte lengths for CJK tool metadata matching agy Go len()', () => {
    const ascii = estimateAgyToolTokens({
      name: 'search',
      description: 'abc',
      inputSchema: { type: 'object' },
    });
    const cjk = estimateAgyToolTokens({
      name: 'search',
      description: '知乎搜', // 3 chars = 9 UTF-8 bytes
      inputSchema: { type: 'object' },
    });
    expect(cjk - ascii).toBe(2); // +6 bytes / 3 = +2 tokens
  });

  it('extracts JSON-RPC responses from SSE streams with notifications and multi-line data', () => {
    const sse = [
      ': keepalive',
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0",',
      'data: "id":42,"result":{"tools":[{"name":"a"}]}}',
      '',
    ].join('\r\n');
    expect(parseMcpRpcResponseBody(sse, 'text/event-stream; charset=utf-8', 42)).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { tools: [{ name: 'a' }] },
    });
    // Strict ID matching: never falls back to a different JSON-RPC response ID.
    expect(parseMcpRpcResponseBody(sse, 'text/event-stream; charset=utf-8', 99)).toBeNull();
  });
});

describe('withAgyMcpBudgetProxy over loopback relay', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('passes non-agy requests (no proxy header) and GET/DELETE through untouched', async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push(Object.fromEntries(headers.entries()));
      if (init?.method === 'GET') {
        return new Response('event: ping\ndata: ok\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: makeSyntheticTools(30, 500) },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    // Non-agy POST gets full 30 upstream tools unmodified.
    const postRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${relay.endpoint.capability}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(postRes.status).toBe(200);
    const postJson = (await postRes.json()) as { result: { tools: UpstreamMcpTool[] } };
    expect(postJson.result.tools).toHaveLength(30);

    // GET SSE stream still flows cleanly.
    const getRes = await fetch(relay.endpoint.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${relay.endpoint.capability}`,
        Accept: 'text/event-stream',
        [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 1500, serverName: 'notion' }),
      },
    });
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('event: ping\ndata: ok\n\n');
    for (const headers of seenHeaders) {
      expect(headers[AGY_MCP_PROXY_HEADER]).toBeUndefined();
    }
  });

  it('aggregates paginated SSE tools/list, serves tools_help locally, and unwraps tools_call with SSE streaming', async () => {
    const page1Tools = makeSyntheticTools(40, 1200);
    const page2Tools: UpstreamMcpTool[] = [
      {
        name: 'notion-update-page',
        description: 'Update blocks or properties of an existing Notion page.',
        inputSchema: {
          type: 'object',
          properties: {
            page_id: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['page_id'],
        },
      },
    ];
    const upstreamCalls: Array<{
      method: string;
      name?: string;
      args?: unknown;
      session?: string;
    }> = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(AGY_MCP_PROXY_HEADER)).toBeNull();
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        upstreamCalls.push({ method: 'tools/list', session: headers.get('mcp-session-id') ?? '' });
        if (!rpc.params?.cursor) {
          const sse = [
            'event: message',
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { tools: page1Tools, nextCursor: 'page-2' },
            })}`,
            '',
          ].join('\n');
          return new Response(sse, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-notion-1' },
          });
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: page2Tools } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-notion-1' },
          }
        );
      }

      if (rpc.method === 'tools/call') {
        upstreamCalls.push({
          method: 'tools/call',
          name: String(rpc.params?.name),
          args: rpc.params?.arguments,
          session: headers.get('mcp-session-id') ?? '',
        });
        const sse = [
          'event: message',
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{ type: 'text', text: `updated:${JSON.stringify(rpc.params?.arguments)}` }],
            },
          })}`,
          '',
        ].join('\n');
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-notion-1' },
        });
      }

      return new Response('{}', { status: 200 });
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      'mcp-session-id': 'sess-notion-1',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2500, serverName: 'notion' }),
    };

    // 1. tools/list aggregates both pages and folds into 2-tool lazy facade.
    const listRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get('mcp-session-id')).toBe('sess-notion-1');
    const listJson = (await listRes.json()) as {
      result: { tools: UpstreamMcpTool[]; nextCursor?: string };
    };
    expect(listJson.result.nextCursor).toBeUndefined();
    expect(listJson.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);
    expect(upstreamCalls).toHaveLength(2);

    // 2. Batch tools_help served locally without hitting upstream.
    const helpRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'tools_help',
          arguments: { tools: ['notion-fetch', 'notion-update-page'] },
        },
      }),
    });
    const helpJson = (await helpRes.json()) as { result: { content: Array<{ text: string }> } };
    const helpPayload = JSON.parse(helpJson.result.content[0]!.text) as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    };
    expect(helpPayload.tools.map((t) => t.name)).toEqual(['notion-fetch', 'notion-update-page']);
    expect(helpPayload.tools[1]?.inputSchema.required).toEqual(['page_id']);
    expect(upstreamCalls).toHaveLength(2);

    // 3. tools_help query search finds notion-update-page locally.
    const searchRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tools_help', arguments: { query: 'update page' } },
      }),
    });
    const searchJson = (await searchRes.json()) as { result: { content: Array<{ text: string }> } };
    const searchPayload = JSON.parse(searchJson.result.content[0]!.text) as {
      matches: Array<{ name: string }>;
    };
    expect(searchPayload.matches[0]?.name).toBe('notion-update-page');

    // 4. Unknown tool in tools_call returns fuzzy suggestions locally without upstream call.
    const typoRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: 'notion_update_page', arguments: {} } },
      }),
    });
    const typoJson = (await typoRes.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(typoJson.result.isError).toBe(true);
    expect(typoJson.result.content[0]?.text).toContain('notion-update-page');
    expect(upstreamCalls).toHaveLength(2);

    // 5. tools_call accepts JSON-stringified arguments, rewrites to upstream tool, streams SSE back.
    const callRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'tools_call',
          arguments: {
            tool: 'notion-update-page',
            arguments: '{"page_id":"p-1","content":"hello"}',
          },
        },
      }),
    });
    expect(callRes.status).toBe(200);
    expect(callRes.headers.get('content-type')).toContain('text/event-stream');
    const callText = await callRes.text();
    const callRpc = parseMcpRpcResponseBody(callText, callRes.headers.get('content-type'), 5) as {
      result: { content: Array<{ text: string }> };
    };
    expect(callRpc.result.content[0]?.text).toBe('updated:{"page_id":"p-1","content":"hello"}');
    expect(upstreamCalls).toHaveLength(3);
    expect(upstreamCalls[2]).toEqual({
      method: 'tools/call',
      name: 'notion-update-page',
      args: { page_id: 'p-1', content: 'hello' },
      session: 'sess-notion-1',
    });
  });

  it('preserves 401 OAuth refresh-and-retry on both tools/list and rewritten tools_call', async () => {
    let refreshes = 0;
    const tools = makeSyntheticTools(30, 1200);
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (auth === 'Bearer initial-upstream-token') {
        return new Response('expired', { status: 401 });
      }
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpc.method === 'tools/call' && auth === 'Bearer token-v2') {
        return new Response('expired-again', { status: 401 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: `ok:${rpc.params?.name}` }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const relay = await startProxyRelay(upstreamFetch, {
      onNonOk: async () => {
        refreshes++;
        return { authorization: `Bearer token-v${refreshes + 1}` };
      },
    });
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'notion' }),
    };

    const listRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    expect(refreshes).toBe(1);

    const callRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: 'notion-fetch', arguments: { id: '1' } } },
      }),
    });
    expect(callRes.status).toBe(200);
    expect(refreshes).toBe(2);
    const callJson = (await callRes.json()) as { result: { content: Array<{ text: string }> } };
    expect(callJson.result.content[0]?.text).toBe('ok:notion-fetch');
  });

  it('warms a cold lease on tools_help and propagates upstream 404 protocol errors', async () => {
    const tools = makeSyntheticTools(30, 1200);
    let fail404 = false;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (fail404) {
        return new Response('session expired', {
          status: 404,
          headers: { 'mcp-session-id': 'expired-id' },
        });
      }
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as { id: string | number };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'notion' }),
    };

    // Cold tools_help warms catalog on demand.
    const helpRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tools_help', arguments: {} },
      }),
    });
    expect(helpRes.status).toBe(200);
    const helpJson = (await helpRes.json()) as { result: { content: Array<{ text: string }> } };
    const index = JSON.parse(helpJson.result.content[0]!.text) as { totalTools: number };
    expect(index.totalTools).toBe(30);

    // 404 on tools/list passes back to the relay handler cleanly.
    fail404 = true;
    const expiredRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(expiredRes.status).toBe(404);
    expect(expiredRes.headers.get('mcp-session-id')).toBe('expired-id');
  });

  it('supports non-loopback LAN http:// upstream MCP servers identically to base forward()', async () => {
    const tools = makeSyntheticTools(30, 1200);
    const seenUrls: string[] = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (input, init) => {
      seenUrls.push(String(input));
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as { id: string | number };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const relay = await startProxyRelay(upstreamFetch, {
      upstreamUrl: 'http://100.64.0.10:8080/mcp',
    });
    cleanups.push(relay.close);

    const res = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${relay.endpoint.capability}`,
        'Content-Type': 'application/json',
        [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'lan-mcp' }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(seenUrls).toEqual(['http://100.64.0.10:8080/mcp']);
    const payload = (await res.json()) as { result: { tools: UpstreamMcpTool[] } };
    expect(payload.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);
  });

  it('enforces agy mcp(...) deny and narrow ask/allow rules in lazy mode without leaking denied calls upstream', async () => {
    const tools: UpstreamMcpTool[] = [
      ...makeSyntheticTools(30, 1200),
      {
        name: 'notion-delete-page',
        description: 'Permanently delete a Notion page.',
        inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } },
      },
      {
        name: 'notion-update-page',
        description: 'Update a Notion page.',
        inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } },
      },
    ];
    const upstreamToolCalls: string[] = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpc.method === 'tools/call') {
        upstreamToolCalls.push(String(rpc.params?.name));
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: `ran:${rpc.params?.name}` }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const rules: AgyMcpPermissionRules = {
      allow: ['mcp(notion/notion-fetch)'],
      ask: ['mcp(notion/notion-update-page)'],
      deny: ['mcp(notion/notion-delete-*)'],
    };
    const relay = await startProxyRelay(upstreamFetch, { permissionRules: rules });
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'notion' }),
    };

    // 1. tools/list strips denied tools, pins narrow ask + narrow allow tools natively alongside lazy facade.
    const listRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    const advertisedNames = listJson.result.tools.map((t) => t.name);
    expect(advertisedNames).toEqual([
      'tools_help',
      'tools_call',
      'notion-update-page',
      'notion-fetch',
    ]);
    expect(advertisedNames).not.toContain('notion-delete-page');

    // 2. tools_help omits denied tool from index and rejects direct inspection.
    const helpRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'tools_help', arguments: {} },
      }),
    });
    const helpJson = (await helpRes.json()) as { result: { content: Array<{ text: string }> } };
    const index = JSON.parse(helpJson.result.content[0]!.text) as {
      tools: Array<{ name: string }>;
    };
    expect(index.tools.map((t) => t.name)).not.toContain('notion-delete-page');

    // Batch tools_help containing a pinned ask tool omits generic tools_call callHint.
    const pinnedBatchHelp = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: { name: 'tools_help', arguments: { tools: ['notion-update-page', 'tool_2'] } },
        }),
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(pinnedBatchHelp.result.content[0]!.text)).not.toHaveProperty('callHint');

    // 3. Denied tool is rejected both through tools_call and direct call; upstream never receives it.
    const deniedViaFacade = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: 'notion-delete-page', arguments: {} } },
      }),
    });
    const deniedFacadeJson = (await deniedViaFacade.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(deniedFacadeJson.result.isError).toBe(true);
    expect(deniedFacadeJson.result.content[0]?.text).toContain('denied by agy permission rules');

    const deniedDirect = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'notion-delete-page', arguments: {} },
      }),
    });
    const deniedDirectJson = (await deniedDirect.json()) as { result: { isError?: boolean } };
    expect(deniedDirectJson.result.isError).toBe(true);

    // 4. Narrow ask-governed tool is refused through tools_call (must use native name so agy prompts).
    const askBypass = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: 'notion-update-page', arguments: {} } },
      }),
    });
    const askBypassJson = (await askBypass.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(askBypassJson.result.isError).toBe(true);
    expect(askBypassJson.result.content[0]?.text).toContain('ask rule');

    // 5. Native direct invocation of ask-governed tool and tools_call of allowed tool both succeed.
    const directAskRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'notion-update-page', arguments: { page_id: 'p-1' } },
      }),
    });
    expect(directAskRes.status).toBe(200);

    const allowedFacadeRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: 'tool_2', arguments: { id: 'ok' } } },
      }),
    });
    expect(allowedFacadeRes.status).toBe(200);
    expect(upstreamToolCalls).toEqual(['notion-update-page', 'tool_2']);
  });

  it('handles incremental persistent SSE, Last-Event-ID resumability, and server-request fail-fast on tools/list', async () => {
    const encoder = new TextEncoder();
    const tools = makeSyntheticTools(30, 1200);
    let scenario: 'persistent' | 'resume' | 'server_req' = 'persistent';
    let lastEventHeaderSeen: string | null = null;
    let pendingRpcId: string | number = 1;

    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (scenario === 'persistent') {
        const rpc = JSON.parse(decodeFetchBody(init?.body)) as { id: string | number };
        // Stream never closes on its own; reader must resolve as soon as matching ID arrives.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } })}\n\n`
              )
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      if (scenario === 'resume') {
        if (init?.method === 'POST') {
          const rpc = JSON.parse(decodeFetchBody(init?.body)) as { id: string | number };
          pendingRpcId = rpc.id;
          // Emit priming event with id + retry and close stream before response (MCP 2025-11-25 resumability).
          return new Response('id: evt-1\nretry: 10\ndata: \n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-resume' },
          });
        }
        lastEventHeaderSeen = headers.get('last-event-id');
        return new Response(
          `id: evt-2\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: pendingRpcId, result: { tools } })}\n\n`,
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-resume' },
          }
        );
      }

      // Server sends interactive request expecting a client reply mid-stream -> must fail fast.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list', params: {} })}\n\n`
            )
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'notion' }),
    };

    // 1. Open SSE stream finishes immediately upon matching response event.
    const persistentRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
    });
    expect(persistentRes.status).toBe(200);
    const persistentJson = (await persistentRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(persistentJson.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);

    // 2. Resumable SSE disconnect follows GET + Last-Event-ID.
    scenario = 'resume';
    const resumeRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }),
    });
    expect(resumeRes.status).toBe(200);
    expect(lastEventHeaderSeen).toBe('evt-1');
    const resumeJson = (await resumeRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(resumeJson.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);

    // 3. Server-to-client request mid-list fails fast without deadlock.
    scenario = 'server_req';
    const srvReqRes = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list' }),
    });
    expect(srvReqRes.status).toBe(200);
    const srvReqJson = (await srvReqRes.json()) as { error?: { code: number; message: string } };
    expect(srvReqJson.error?.code).toBe(-32603);
    expect(srvReqJson.error?.message).toContain('roots/list');
  });

  it('allocates unique proxy JSON-RPC IDs across concurrent paginated listings', async () => {
    const seenIds: Array<string | number> = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        params?: { cursor?: string };
      };
      seenIds.push(rpc.id);
      if (!rpc.params?.cursor) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { tools: makeSyntheticTools(15, 1000), nextCursor: 'p2' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { tools: [{ name: 'final_tool', inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      'mcp-session-id': 'sess-concurrent',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'notion' }),
    };

    const [r1, r2] = await Promise.all([
      fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(seenIds).toHaveLength(4);
    expect(new Set(seenIds).size).toBe(4);
  });

  it('isolates cached catalogs per mcp-session-id on a shared lease and evicts on DELETE', async () => {
    const toolsA = makeSyntheticTools(30, 1200).map((t, i) => ({ ...t, name: `A_${i}` }));
    const toolsB = makeSyntheticTools(30, 1200).map((t, i) => ({ ...t, name: `B_${i}` }));
    let listCallsForA = 0;

    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const sessionId = headers.get('mcp-session-id') ?? '';
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as { id: string | number };
      if (sessionId === 'sess-A') listCallsForA += 1;
      const tools = sessionId === 'sess-A' ? toolsA : toolsB;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId },
      });
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const headersFor = (sessionId: string) => ({
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId,
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'multi' }),
    });

    await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: headersFor('sess-A'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: headersFor('sess-B'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    // Session A's tools_help must still see A_0, not B_0.
    const helpA = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: headersFor('sess-A'),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tools_help', arguments: {} },
      }),
    });
    const helpAJson = (await helpA.json()) as { result: { content: Array<{ text: string }> } };
    const indexA = JSON.parse(helpAJson.result.content[0]!.text) as {
      tools: Array<{ name: string }>;
    };
    expect(indexA.tools[0]?.name).toBe('A_0');
    expect(listCallsForA).toBe(1);

    // DELETE evicts sess-A snapshot so subsequent tools_help re-warms upstream.
    const delRes = await fetch(relay.endpoint.url, {
      method: 'DELETE',
      headers: headersFor('sess-A'),
    });
    expect(delRes.status).toBe(204);

    await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: headersFor('sess-A'),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'tools_help', arguments: {} },
      }),
    });
    expect(listCallsForA).toBe(2);
  });

  it('fails closed without caching when tools/list exceeds page limit, cycles cursors, or omits tools array', async () => {
    let mode: 'too_many_pages' | 'cycle' | 'invalid_shape' = 'too_many_pages';
    let pageCounter = 0;

    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        params?: { cursor?: string };
      };
      if (mode === 'too_many_pages') {
        pageCounter += 1;
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [{ name: `t_${pageCounter}`, inputSchema: { type: 'object' } }],
              nextCursor: `page-${pageCounter + 1}`,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (mode === 'cycle') {
        const nextCursor = rpc.params?.cursor === 'c1' ? 'c2' : 'c1';
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [{ name: `cycle_${nextCursor}`, inputSchema: { type: 'object' } }],
              nextCursor,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'broken' }),
    };

    const p1 = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    ).json()) as { error?: { code: number; message: string } };
    expect(p1.error?.code).toBe(-32603);
    expect(p1.error?.message).toContain('50 pages');

    mode = 'cycle';
    const p2 = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
    ).json()) as { error?: { code: number; message: string } };
    expect(p2.error?.code).toBe(-32603);
    expect(p2.error?.message).toContain('cursor cycle');

    mode = 'invalid_shape';
    const p3 = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      })
    ).json()) as { error?: { code: number; message: string } };
    expect(p3.error?.code).toBe(-32603);
    expect(p3.error?.message).toContain('invalid tools/list result');
  });

  it('integrates end-to-end with real LanMcpAuthentication including 404/405 protocol status passthrough', async () => {
    const tools = makeSyntheticTools(30, 1200);
    let nextStatus = 200;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { allow: 'POST' },
        });
      }
      if (nextStatus === 404) {
        return new Response('session expired', {
          status: 404,
          headers: { 'mcp-session-id': 'expired-lan' },
        });
      }
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'lan-sess-1' },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: `lan:${rpc.params?.name}` }] },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'lan-sess-1' },
        }
      );
    });

    const auth = new LanMcpAuthentication({
      userId: 'user-1',
      resolveHub: () => null,
      io: withAgyMcpBudgetProxy(makeMcpAuthenticationIO(upstreamFetch), {
        loadPermissionRules: () => OK_EMPTY_LOAD,
      }),
    });
    cleanups.push(() => auth.close());

    const serverMeta: WorkspaceMcpServerMeta = {
      id: 'srv-notion',
      name: 'notion',
      connection: {
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        authentication: 'none',
      },
    };
    const resolved: ResolvedMcpServer = {
      type: 'http',
      name: 'notion',
      url: 'https://mcp.example.test/mcp',
      headers: [],
    };
    const prepared = await auth.prepare(serverMeta, resolved, 'session-1', 'user-1');
    const budgeted = applyAgyExternalMcpProxyHeaders([prepared], 5_500)[0]!;
    expect(budgeted).toHaveProperty('type', 'http');
    const httpServer = budgeted as Extract<ResolvedMcpServer, { type: 'http' }>;
    const headers = Object.fromEntries(httpServer.headers.map((h) => [h.name, h.value]));

    // 1. tools/list folds to 2-tool lazy facade through LanMcpAuthentication relay.
    const listRes = await fetch(httpServer.url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listJson.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);

    // 2. GET 405 passes through LanMcpAuthentication's real writeProtocolStatusError.
    const get405 = await fetch(httpServer.url, {
      method: 'GET',
      headers: { ...headers, Accept: 'text/event-stream' },
    });
    expect(get405.status).toBe(405);
    expect(get405.headers.get('allow')).toBe('POST');

    // 3. POST 404 passes through LanMcpAuthentication's real writeProtocolStatusError.
    nextStatus = 404;
    const post404 = await fetch(httpServer.url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'mcp-session-id': 'lan-sess-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(post404.status).toBe(404);
    expect(post404.headers.get('mcp-session-id')).toBe('expired-lan');
  });

  it('loads permission rules from custom --gemini-dir via production loader and fails safe on corrupt files', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'lody-agy-proxy-perms-'));
    cleanups.push(async () => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    const customGeminiDir = path.join(tmpRoot, 'custom-gemini');
    const workdir = path.join(tmpRoot, 'workspace');
    mkdirSync(path.join(customGeminiDir, 'config'), { recursive: true });
    mkdirSync(workdir, { recursive: true });
    const configPath = path.join(customGeminiDir, 'config', 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        userSettings: {
          globalPermissionGrants: {
            deny: ['mcp(notion/notion-delete-page)'],
          },
        },
      })
    );

    const agyConfigContext = resolveAgyConfigContext(['acp', '--gemini-dir', customGeminiDir], {});
    expect(loadAgyMcpPermissionRules({ workdir, agyConfigContext })).toEqual({
      status: 'ok',
      rules: { allow: [], ask: [], deny: ['mcp(notion/notion-delete-page)'] },
    });

    const tools: UpstreamMcpTool[] = [
      ...makeSyntheticTools(30, 1200),
      { name: 'notion-delete-page', description: 'Delete page.', inputSchema: { type: 'object' } },
    ];
    const upstreamToolCalls: string[] = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      upstreamToolCalls.push(String(rpc.params?.name));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const relay = await startProxyRelay(upstreamFetch, { useProductionPermissionLoader: true });
    cleanups.push(relay.close);

    // Register session context through the production header helper.
    const budgeted = applyAgyExternalMcpProxyHeaders(
      [
        {
          type: 'http',
          name: 'notion',
          url: relay.endpoint.url,
          headers: [{ name: 'Authorization', value: `Bearer ${relay.endpoint.capability}` }],
        },
      ],
      { totalBudgetTokens: 2000, workdir, agyConfigContext }
    )[0] as Extract<ResolvedMcpServer, { type: 'http' }>;
    const headers = Object.fromEntries(budgeted.headers.map((h) => [h.name, h.value]));

    // 1. Custom --gemini-dir deny rule blocks notion-delete-page through production loader.
    const deniedRes = await fetch(budgeted.url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: 'notion-delete-page', arguments: {} } },
      }),
    });
    const deniedJson = (await deniedRes.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(deniedJson.result.isError).toBe(true);
    expect(deniedJson.result.content[0]?.text).toContain('denied by agy permission rules');
    expect(upstreamToolCalls).toEqual([]);

    // 2. Corrupt config.json fails safe: proxy preserves native tool names (compact) instead of lazy.
    writeFileSync(configPath, '{not valid json');
    const listRes = await fetch(budgeted.url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    const names = listJson.result.tools.map((t) => t.name);
    expect(names).toContain('notion-delete-page');
    expect(names).not.toContain('tools_call');
  });

  it('bounds narrow ask pins to budget share and preserves callability without silent overflow', async () => {
    const tools = makeSyntheticTools(30, 1200);
    const askRules = tools.slice(0, 21).map((t) => `mcp(srv/${t.name})`);

    // Case A: broad allow covers tools_call -> all 21 narrow ask tools are mandatory and exceed share=400.
    const overflowRes = rewriteToolsForAgyBudget(
      tools,
      { share: 400, serverName: 'srv' },
      { allow: ['mcp(srv/*)'], ask: askRules, deny: [] }
    );
    expect(overflowRes.ok).toBe(false);
    if (overflowRes.ok) throw new Error('expected budget overflow diagnostic');
    expect(overflowRes.message).toContain('400-token budget');

    // Case B: no broad allow on tools_call -> stays <= 400 tok, and the 21st ask tool remains callable via tools_call.
    const upstreamCalls: string[] = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      upstreamCalls.push(String(rpc.params?.name));
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const relay = await startProxyRelay(upstreamFetch, {
      permissionRules: { allow: [], ask: askRules, deny: [] },
    });
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 400, serverName: 'srv' }),
    };

    const listJson = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    ).json()) as { result: { tools: Array<Record<string, unknown>> } };
    const totalTokens = listJson.result.tools.reduce(
      (sum, t) =>
        sum +
        estimateAgyToolTokens({
          name: String(t.name),
          description: typeof t.description === 'string' ? t.description : undefined,
          inputSchema: t.inputSchema,
        }),
      0
    );
    expect(totalTokens).toBeLessThanOrEqual(400);

    // 21st ask tool (not pinned natively) is still callable through tools_call (prompted by agy).
    const tool21Name = tools[20]!.name;
    const call21 = await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'tools_call', arguments: { tool: tool21Name, arguments: { id: '21' } } },
      }),
    });
    expect(call21.status).toBe(200);
    expect(upstreamCalls).toEqual([tool21Name]);
  });

  it('answers upstream SSE ping inline and honors full SSE retry delay with timeout enforcement', async () => {
    const encoder = new TextEncoder();
    const tools = makeSyntheticTools(30, 1200);
    const observedDelays: number[] = [];
    const seenPingReplies: Array<Record<string, unknown>> = [];
    let pushPingDone: (() => void) | undefined;
    let mode: 'ping' | 'retry_2000' | 'retry_too_long' = 'ping';
    let pendingListId: string | number = 1;

    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (mode === 'ping') {
        const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
          id: string | number;
          method?: string;
          result?: unknown;
        };
        if (rpc.method === 'tools/list') {
          let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controllerRef = controller;
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'ping-7', method: 'ping' })}\n\n`
                )
              );
            },
          });
          // Push tools/list response only AFTER the ping reply arrives.
          pushPingDone = () => {
            controllerRef.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } })}\n\n`
              )
            );
          };
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-ping' },
          });
        }
        // Ping reply POST from proxy.
        seenPingReplies.push(rpc);
        pushPingDone?.();
        return new Response(null, { status: 202 });
      }

      if (init?.method === 'POST') {
        const rpc = JSON.parse(decodeFetchBody(init?.body)) as { id: string | number };
        pendingListId = rpc.id;
        const retryVal = mode === 'retry_2000' ? 2000 : 60_000;
        return new Response(`id: r-1\nretry: ${retryVal}\ndata: \n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(
        `id: r-2\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: pendingListId, result: { tools } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    });

    const relay = await startProxyRelay(upstreamFetch, {
      delay: async (ms) => {
        observedDelays.push(ms);
      },
    });
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'sse' }),
    };

    // 1. Inline ping reply unblocks upstream SSE tools/list cleanly.
    const pingRes = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(seenPingReplies).toEqual([{ jsonrpc: '2.0', id: 'ping-7', result: {} }]);
    expect(pingRes.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);

    // 2. retry: 2000 waits the full 2000ms (never truncated to 500ms).
    mode = 'retry_2000';
    const retryRes = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(observedDelays).toEqual([2000]);
    expect(retryRes.result.tools.map((t) => t.name)).toEqual(['tools_help', 'tools_call']);

    // 3. Excessive retry: 60000 returns timeout error without firing early.
    mode = 'retry_too_long';
    const timeoutRes = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      })
    ).json()) as { error?: { code: number; message: string } };
    expect(timeoutRes.error?.code).toBe(-32603);
    expect(timeoutRes.error?.message).toContain('60000ms');
    expect(observedDelays).toEqual([2000]);
  });

  it('pins execution.taskSupport="required" tools natively in lazy mode and forwards params.task', async () => {
    const tools: UpstreamMcpTool[] = [
      ...makeSyntheticTools(30, 1200),
      {
        name: 'long_export',
        description: 'Run an async workspace export.',
        inputSchema: { type: 'object', properties: { format: { type: 'string' } } },
        execution: { taskSupport: 'required' },
      },
    ];
    const forwardedParams: Array<Record<string, unknown>> = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      forwardedParams.push(rpc.params ?? {});
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { task: { taskId: 't-1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'exports' }),
    };

    const listJson = (await (
      await fetch(relay.endpoint.url, {
        method: 'POST',
        headers: agyHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    ).json()) as {
      result: { tools: Array<{ name: string; execution?: { taskSupport?: string } }> };
    };
    const pinnedTaskTool = listJson.result.tools.find((t) => t.name === 'long_export');
    expect(pinnedTaskTool?.execution).toEqual({ taskSupport: 'required' });

    // Calling via tools_call with params.task preserves params.task upstream.
    await fetch(relay.endpoint.url, {
      method: 'POST',
      headers: agyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'tools_call',
          task: { ttl: 60_000 },
          arguments: { tool: 'long_export', arguments: { format: 'csv' } },
        },
      }),
    });
    expect(forwardedParams).toEqual([
      {
        name: 'long_export',
        arguments: { format: 'csv' },
        task: { ttl: 60_000 },
      },
    ]);
  });

  it('supports mutually exclusive argumentsJson in tools_call, validates strictly, and preserves CJK/colon keys', async () => {
    const tools: UpstreamMcpTool[] = [
      ...makeSyntheticTools(30, 1200),
      {
        name: 'notion-update-page',
        description: 'Update properties of an existing Notion page.',
        inputSchema: {
          type: 'object',
          properties: {
            page_id: { type: 'string' },
            command: { type: 'string' },
            properties: { type: 'object' },
          },
          required: ['page_id'],
        },
      },
      {
        name: 'notion-ping',
        description: 'No-argument health check.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const upstreamCalls: Array<{
      name: string;
      arguments: unknown;
      task?: unknown;
    }> = [];
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const rpc = JSON.parse(decodeFetchBody(init?.body)) as {
        id: string | number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === 'tools/list') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (rpc.method === 'tools/call') {
        upstreamCalls.push({
          name: String(rpc.params?.name),
          arguments: rpc.params?.arguments,
          ...(rpc.params?.task !== undefined ? { task: rpc.params.task } : {}),
        });
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: 'ok' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const relay = await startProxyRelay(upstreamFetch);
    cleanups.push(relay.close);

    const agyHeaders = {
      Authorization: `Bearer ${relay.endpoint.capability}`,
      'Content-Type': 'application/json',
      [AGY_MCP_PROXY_HEADER]: formatAgyMcpProxyHeader({ share: 2000, serverName: 'notion' }),
    };

    const postRpc = async (id: number, method: string, params?: Record<string, unknown>) =>
      (await (
        await fetch(relay.endpoint.url, {
          method: 'POST',
          headers: agyHeaders,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
        })
      ).json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };

    // Warm lazy catalog and verify tools_help schema response includes argumentsJson callHint.
    await postRpc(1, 'tools/list');
    const helpJson = await postRpc(2, 'tools/call', {
      name: 'tools_help',
      arguments: { tool: 'notion-update-page' },
    });
    const helpPayload = JSON.parse(helpJson.result.content[0]!.text) as {
      name: string;
      callHint?: string;
    };
    expect(helpPayload.name).toBe('notion-update-page');
    expect(helpPayload.callHint).toContain('argumentsJson');

    // 1. Valid argumentsJson with CJK keys, colon keys, null value, and params.task forwards verbatim.
    const notionPayload = {
      page_id: '00000000-0000-0000-0000-000000000001',
      command: 'update_properties',
      properties: {
        阶段: '已完成',
        下一步: '示例跟进备注',
        主要待确认: '示例核对结果',
        'date:行动日期:start': null,
      },
    };
    const validRes = await postRpc(3, 'tools/call', {
      name: 'tools_call',
      task: { ttl: 30_000 },
      arguments: {
        tool: 'notion-update-page',
        argumentsJson: JSON.stringify(notionPayload),
      },
    });
    expect(validRes.result.isError).toBeUndefined();
    expect(upstreamCalls).toEqual([
      {
        name: 'notion-update-page',
        arguments: notionPayload,
        task: { ttl: 30_000 },
      },
    ]);

    // 2. Both arguments and argumentsJson omitted (or legacy standalone arguments: null) defaults to {}.
    const omittedRes = await postRpc(4, 'tools/call', {
      name: 'tools_call',
      arguments: { tool: 'notion-ping' },
    });
    expect(omittedRes.result.isError).toBeUndefined();
    expect(upstreamCalls[1]).toEqual({ name: 'notion-ping', arguments: {} });

    const standaloneNullArgsRes = await postRpc(5, 'tools/call', {
      name: 'tools_call',
      arguments: { tool: 'notion-ping', arguments: null },
    });
    expect(standaloneNullArgsRes.result.isError).toBeUndefined();
    expect(upstreamCalls[2]).toEqual({ name: 'notion-ping', arguments: {} });

    const callsBeforeInvalid = upstreamCalls.length;
    let nextId = 6;

    // 3. Passing both arguments (including explicit null) and argumentsJson fails without upstream call.
    for (const bothArgs of [
      { tool: 'notion-update-page', arguments: { page_id: '1' }, argumentsJson: '{"page_id":"2"}' },
      { tool: 'notion-update-page', arguments: {}, argumentsJson: '{}' },
      { tool: 'notion-update-page', arguments: null, argumentsJson: '{"page_id":"2"}' },
    ]) {
      const res = await postRpc(nextId++, 'tools/call', {
        name: 'tools_call',
        arguments: bothArgs,
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]?.text).toContain('Cannot pass both');
    }

    // 4. Malformed JSON strings fail cleanly without calling upstream.
    for (const badJson of ['{bad', '', '   ']) {
      const res = await postRpc(nextId++, 'tools/call', {
        name: 'tools_call',
        arguments: { tool: 'notion-update-page', argumentsJson: badJson },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]?.text).toContain('invalid JSON');
    }

    // 5. Valid JSON that is not a plain object (array, null, number, string, boolean) fails cleanly.
    for (const nonObjectJson of ['[]', 'null', '123', '"str"', 'true']) {
      const res = await postRpc(nextId++, 'tools/call', {
        name: 'tools_call',
        arguments: { tool: 'notion-update-page', argumentsJson: nonObjectJson },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]?.text).toContain('must parse to a JSON object');
    }

    // 6. Non-string argumentsJson values fail cleanly without calling upstream.
    for (const nonString of [null, 123, true, [], { page_id: '1' }]) {
      const res = await postRpc(nextId++, 'tools/call', {
        name: 'tools_call',
        arguments: { tool: 'notion-update-page', argumentsJson: nonString },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]?.text).toContain('must be a JSON object string');
    }

    expect(upstreamCalls).toHaveLength(callsBeforeInvalid);
  });
});
