// Minimal MCP server (JSON-RPC 2.0 over stdio, one message per line). No dependencies.
export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

// Validation against the tools' (deliberately simple) inputSchema. Returns an error text or null.
export function validate(schema, args) {
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return 'arguments muss ein Objekt sein.';
  for (const key of schema.required || []) if (args[key] === undefined) return `${key} fehlt.`;
  for (const [key, value] of Object.entries(args)) {
    const p = schema.properties?.[key];
    if (!p) { if (schema.additionalProperties === false) return `Unbekannter Parameter: ${key}.`; continue; }
    const e = checkValue(p, value, key);
    if (e) return e;
  }
  return null;
}

function checkValue(p, v, key) {
  const t = p.type;
  if (t === 'string' && typeof v !== 'string') return `${key}: Text erwartet.`;
  if (t === 'boolean' && typeof v !== 'boolean') return `${key}: true/false erwartet.`;
  if ((t === 'number' || t === 'integer') && (typeof v !== 'number' || !Number.isFinite(v))) return `${key}: Zahl erwartet.`;
  if (t === 'integer' && !Number.isInteger(v)) return `${key}: ganze Zahl erwartet.`;
  if (t === 'array') {
    if (!Array.isArray(v)) return `${key}: Liste erwartet.`;
    if (p.minItems != null && v.length < p.minItems) return `${key}: mindestens ${p.minItems} Eintraege.`;
    if (p.maxItems != null && v.length > p.maxItems) return `${key}: hoechstens ${p.maxItems} Eintraege.`;
    for (const item of v) { const e = p.items && checkValue(p.items, item, key); if (e) return e; }
  }
  if (p.enum && !p.enum.includes(v)) return `${key}: erlaubt sind ${p.enum.join(', ')}.`;
  if (p.minimum != null && v < p.minimum) return `${key}: mindestens ${p.minimum}.`;
  if (p.maximum != null && v > p.maximum) return `${key}: hoechstens ${p.maximum}.`;
  return null;
}

// handleMessage returns the response (object) or null (notification).
export function createMcpServer({ name, version, instructions, tools, call, log = () => {} }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function handleMessage(msg) {
    if (Array.isArray(msg)) return fail(null, ERR.INVALID_REQUEST, 'JSON-RPC-Batches werden nicht unterstuetzt.');
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fail(msg?.id, ERR.INVALID_REQUEST, 'Ungueltige JSON-RPC-2.0-Nachricht.');
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    if (typeof method !== 'string') {
      if (!isNotification && ('result' in msg || 'error' in msg)) return null; // response from the client (e.g. to a ping)
      return fail(id, ERR.INVALID_REQUEST, 'method fehlt.');
    }
    if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name, version }, instructions });
      }
      case 'ping': return ok(id, {});
      case 'tools/list': return ok(id, { tools });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return fail(id, ERR.INVALID_PARAMS, `Unbekanntes Werkzeug: ${params?.name}`);
        const args = params.arguments ?? {};
        const bad = validate(tool.inputSchema, args);
        if (bad) return ok(id, { content: [{ type: 'text', text: `Ungueltige Eingabe: ${bad}` }], isError: true });
        try {
          const content = await call(tool.name, args);
          return ok(id, { content });
        } catch (e) {
          log(`Werkzeug ${tool.name}: ${e.stack || e.message}`);
          return ok(id, { content: [{ type: 'text', text: `Fehler${e.code && typeof e.code === 'string' ? ` (${e.code})` : ''}: ${e.message}` }], isError: true });
        }
      }
      case 'resources/list': return ok(id, { resources: [] });
      case 'prompts/list': return ok(id, { prompts: [] });
      default: return fail(id, ERR.METHOD_NOT_FOUND, `Methode nicht gefunden: ${method}`);
    }
  }

  // stdio: read lines, handle requests concurrently, write responses line by line. Logs go to stderr only.
  function serveStdio({ input = process.stdin, output = process.stdout, onClose } = {}) {
    let buf = '';
    const write = obj => { if (obj) output.write(JSON.stringify(obj) + '\n'); };
    input.setEncoding('utf8');
    input.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { write(fail(null, ERR.PARSE, 'Ungueltiges JSON.')); continue; }
        handleMessage(msg).then(write, e => write(fail(msg?.id, ERR.INTERNAL, e.message)));
      }
    });
    input.on('end', () => onClose?.());
  }

  return { handleMessage, serveStdio };
}
