import { describe, expect, it, vi } from "vitest";
import { PlankaClient, PlankaError } from "../../src/client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PlankaClient", () => {
  it("sends X-Api-Key, JSON body and builds /api path", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { item: { id: "1" } }));
    const c = new PlankaClient("https://p.example/", "KEY123", f);
    const res = await c.post("/lists/5/cards", { name: "x" });
    expect(res).toEqual({ item: { id: "1" } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://p.example/api/lists/5/cards");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Api-Key"]).toBe("KEY123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ name: "x" });
  });

  it("GET has no body or content-type", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { items: [] }));
    await new PlankaClient("https://p", "k", f).get("/projects");
    const [, init] = f.mock.calls[0];
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("maps non-2xx to PlankaError with Planka code and message", async () => {
    const f = vi.fn().mockResolvedValue(json(404, { code: "E_NOT_FOUND", message: "Card not found" }));
    const err = await new PlankaClient("https://p", "k", f).get("/cards/9").catch((e) => e);
    expect(err).toBeInstanceOf(PlankaError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("E_NOT_FOUND");
    expect(err.message).toContain("Card not found");
    expect(err.message).toContain("GET /cards/9");
  });

  it("includes validation problems when present", async () => {
    const f = vi.fn().mockResolvedValue(json(400, { code: "E_MISSING_OR_INVALID_PARAMS", problems: ["\"type\" is required"] }));
    const err = await new PlankaClient("https://p", "k", f).post("/lists/1/cards", {}).catch((e) => e);
    expect(err.message).toContain('"type" is required');
  });

  it("never leaks the API key in error messages", async () => {
    const f = vi.fn().mockResolvedValue(json(401, { code: "E_UNAUTHORIZED", message: "bad key SECRETKEY" }));
    const err = await new PlankaClient("https://p", "SECRETKEY", f).get("/users/me").catch((e) => e);
    expect(err.message).not.toContain("SECRETKEY");
    expect(err.message).toContain("***");
  });

  it("wraps network failures", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await new PlankaClient("https://p", "k", f).get("/projects").catch((e) => e);
    expect(err).toBeInstanceOf(PlankaError);
    expect(err.code).toBe("E_NETWORK");
    expect(err.status).toBe(0);
  });

  it("handles empty and non-JSON bodies", async () => {
    const f = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    expect(await new PlankaClient("https://p", "k", f).delete("/x/1")).toBeUndefined();
    const g = vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    const err = await new PlankaClient("https://p", "k", g).get("/x").catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Bad Gateway");
  });
});
