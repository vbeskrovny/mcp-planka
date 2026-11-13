import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PlankaError } from "./client.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
}

export function fail(err: unknown): CallToolResult {
  const message =
    err instanceof PlankaError || err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wrap a tool handler so thrown errors become MCP error results instead of protocol errors. */
export function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Planka IDs are 64-bit snowflakes: always keep them as strings. */
export const id = (what: string) =>
  z.string().regex(/^\d+$/, `${what} must be a numeric string ID`).describe(`${what} (numeric string)`);

export const positionSpec = z
  .union([z.enum(["top", "bottom"]), z.number().int().min(0)])
  .optional()
  .describe('Where to place it: "top", "bottom" (default) or a 0-based index');
