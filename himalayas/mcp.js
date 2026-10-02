// Minimal client for Himalayas' public MCP server (https://mcp.himalayas.app/mcp).
// MCP over "Streamable HTTP" is just JSON-RPC 2.0 sent as a POST; the reply comes
// back either as JSON or as a Server-Sent Events stream (`data: {...}` lines).
// Public tools such as `get_company_details` need no auth.
// Docs: https://himalayas.app/docs/remote-jobs-mcp

import { fetchWithRetry } from './http.js';

const MCP_URL = 'https://mcp.himalayas.app/mcp';
const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  #id = 0;
  #sessionId = null;
  #initialized = null;

  constructor(opts = {}) {
    this.opts = opts; // forwarded to fetchWithRetry (signal, onRetry…)
  }

  async #rpc(method, params) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;

    const res = await fetchWithRetry(
      MCP_URL,
      { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }) },
      this.opts,
    );
    if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
    this.#sessionId = res.headers.get('mcp-session-id') ?? this.#sessionId;

    const text = await res.text();
    const msg = res.headers.get('content-type')?.includes('text/event-stream') ? lastSseMessage(text) : JSON.parse(text);
    if (msg.error) throw new Error(`MCP ${method} error: ${msg.error.message}`);
    return msg.result;
  }

  // The handshake is required by the protocol; the server is currently
  // stateless, but this keeps the client correct if that changes.
  #ensureInitialized() {
    this.#initialized ??= this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'himalayas-cli', version: '1.0.0' },
    });
    return this.#initialized;
  }

  /** Calls a tool and returns its text output. */
  async callTool(name, args) {
    await this.#ensureInitialized();
    const result = await this.#rpc('tools/call', { name, arguments: args });
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result.isError) throw new Error(`Tool ${name} failed: ${text}`);
    return text;
  }

  /** Returns parsed company details, or null if Himalayas has no profile for the slug. */
  async getCompanyDetails(slug) {
    const text = await this.callTool('get_company_details', { company_slug: slug });
    if (/^Company '.*' not found/.test(text)) return null;
    return parseCompanyMarkdown(text);
  }
}

function lastSseMessage(text) {
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  if (!data.length) throw new Error('MCP returned an empty event stream');
  return JSON.parse(data.at(-1));
}

/**
 * The tool returns Markdown meant for an AI to read, not JSON, so we parse it:
 *
 *   # lemon.io ✅ Verified
 *   **Size:** 51-200
 *   **Founded:** 2015
 *   **CEO:** Aleksandr Volodarsky
 *   **Location:** Andorra, Albania, …
 *   **Markets:** Technical-Recruiting, Job-Board
 *   ## About
 *   …
 *   ## Tech Stack
 *   **Analytics:** Google Analytics, Mixpanel
 *   ## Links
 *   🌐 **Website:** https://lemon.io?utm_source=himalayas.app…
 *   **Social:** Twitter: https://… • LinkedIn: https://… • Facebook: https://…
 */
export function parseCompanyMarkdown(md) {
  const sections = splitSections(md);
  const header = sections.get('') ?? '';
  const field = (label) => header.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'm'))?.[1].trim() ?? null;
  const list = (label) => field(label)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

  const website = cleanUrl(md.match(/\*\*Website:\*\*\s*(\S+)/)?.[1]);

  const socials = {};
  const socialLine = md.match(/^\*\*Social:\*\*\s*(.+)$/m)?.[1] ?? '';
  for (const part of socialLine.split('•')) {
    const m = part.trim().match(/^([^:]+):\s*(\S+)$/);
    if (m) socials[m[1].trim().toLowerCase()] = cleanUrl(m[2]);
  }

  const techStack = {};
  for (const m of (sections.get('Tech Stack') ?? '').matchAll(/^\*\*(.+?):\*\*\s*(.+)$/gm)) {
    techStack[m[1]] = m[2].split(',').map((s) => s.trim());
  }

  const founded = Number(field('Founded'));
  return {
    name: md.match(/^# (.+?)\s*(?:✅.*)?$/m)?.[1].trim() ?? null,
    verified: /^# .*✅/m.test(md),
    size: field('Size'),
    founded: Number.isFinite(founded) && founded > 0 ? founded : null,
    ceo: field('CEO'),
    locations: list('Location'),
    markets: list('Markets'),
    openPositions: Number(field('Open Positions')) || 0,
    about: sections.get('About')?.trim() || null,
    techStack,
    website,
    domain: toDomain(website),
    socials,
  };
}

// Splits on "## Heading" lines; text before the first heading is keyed ''.
function splitSections(md) {
  const map = new Map();
  let key = '';
  let buf = [];
  for (const line of md.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) { map.set(key, buf.join('\n')); key = h[1].trim(); buf = []; }
    else buf.push(line);
  }
  map.set(key, buf.join('\n'));
  return map;
}

// Drops the utm_/ref/source tracking params Himalayas appends to outbound links.
function cleanUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith('utm_') || k === 'ref' || k === 'source') u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function toDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
