import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PlankaClient, type FetchLike } from "../src/client.js";
import { createServer } from "../src/server.js";

export interface Call {
  method: string;
  path: string;
  body?: any;
  /** Set for multipart requests (file uploads). */
  form?: FormData;
}
type Handler = (call: Call) => unknown;

/**
 * Fake Planka API: routes are "METHOD /path" (without /api) → JSON body or handler.
 * A handler may return a Response (e.g. binary download) to send it as is.
 */
export function fakePlanka(routes: Record<string, unknown | Handler>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const form = init?.body instanceof FormData ? init.body : undefined;
    const call: Call = { method, path, form, body: form ? undefined : init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ code: "E_NOT_FOUND", message: `No fake route ${method} ${path}` }), { status: 404 });
    }
    const data = typeof route === "function" ? (route as Handler)(call) : route;
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200 });
  };
  return { calls, client: new PlankaClient("https://planka.test", "TESTKEY", fetchImpl) };
}

export async function connect(planka: PlankaClient, opts: { managers?: string[]; instructions?: string; filesDir?: string } = {}) {
  const server = createServer(planka, undefined, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: !!r.isError, data, text };
  };
  return { client, call };
}

export const echoItem = (extra: Record<string, unknown> = {}) => (c: Call) => ({ item: { id: "999", ...c.body, ...extra } });
