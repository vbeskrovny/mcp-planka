import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { UpdateTracker } from "../../src/updates.js";
import { fakePlanka } from "../helpers.js";

const ME = "1";
const HUMAN = "2";
const BOARD = "100";
const BACKLOG = "200";
const DOING = "201";

describe("UpdateTracker", () => {
  let statePath: string;
  let clock: number;
  const now = () => new Date(clock);
  beforeEach(() => {
    statePath = join(mkdtempSync(join(tmpdir(), "planka-state-")), "state.json");
    clock = Date.parse("2026-11-12T10:00:00Z");
  });

  const setup = () => {
    const w = { cards: [] as any[], comments: {} as Record<string, any[]> };
    const routes: Record<string, any> = {
      "GET /users/me": { item: { id: ME } },
      "GET /projects": { items: [{ id: "10" }], included: { boards: [{ id: BOARD, projectId: "10" }] } },
      [`GET /boards/${BOARD}`]: () => ({
        item: { id: BOARD, name: "Dev" },
        included: {
          lists: [
            { id: BACKLOG, name: "Backlog", type: "active" },
            { id: DOING, name: "Doing", type: "active" },
          ],
          users: [
            { id: ME, name: "Bot" },
            { id: HUMAN, name: "Olga" },
          ],
          cards: w.cards.map((c) => ({ ...c, commentsTotal: (w.comments[c.id] ?? []).length })),
        },
      }),
    };
    const f = fakePlanka(
      new Proxy(routes, {
        get(t, k: string) {
          const m = /^GET \/cards\/(\w+)\/comments$/.exec(k);
          if (m) return { items: w.comments[m[1]] ?? [], included: { users: [{ id: HUMAN, name: "Olga" }] } };
          return t[k];
        },
      }),
    );
    const tracker = new UpdateTracker(f.client, statePath, { now });
    const tick = (min: number) => {
      clock += min * 60_000;
      return new Date(clock).toISOString();
    };
    return { w, f, tracker, tick };
  };

  it("first check records a baseline without events", async () => {
    const { w, tracker } = setup();
    w.cards.push({ id: "c1", listId: BACKLOG, name: "old", creatorUserId: HUMAN, createdAt: "2020-01-01T00:00:00Z" });
    w.comments.c1 = [{ id: "m1", userId: HUMAN, text: "old", createdAt: "2020-01-01T00:00:00Z" }];
    const r = await tracker.check();
    expect(r.events).toEqual([]);
    expect(r.boards).toEqual([{ id: BOARD, name: "Dev", initialized: true }]);
  });

  it("reports new backlog cards by humans, not by the bot, and not in other lists", async () => {
    const { w, tracker, tick } = setup();
    await tracker.check();
    const at = tick(1);
    w.cards.push({ id: "c1", listId: BACKLOG, name: "Human idea", creatorUserId: HUMAN, createdAt: at });
    w.cards.push({ id: "c2", listId: BACKLOG, name: "Bot card", creatorUserId: ME, createdAt: at });
    w.cards.push({ id: "c3", listId: DOING, name: "Elsewhere", creatorUserId: HUMAN, createdAt: at });
    tick(1);
    const r = await tracker.check();
    expect(r.events).toEqual([
      expect.objectContaining({ type: "backlog_card", cardId: "c1", name: "Human idea", movedIn: false, by: "Olga", list: "Backlog" }),
    ]);
    expect((await tracker.check()).events).toEqual([]); // consumed
  });

  it("reports cards moved into the backlog", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c3", listId: DOING, name: "Bounce", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    await tracker.check();
    w.cards[0] = { ...w.cards[0], listId: BACKLOG, listChangedAt: tick(1) };
    const r = await tracker.check();
    expect(r.events).toEqual([expect.objectContaining({ type: "backlog_card", cardId: "c3", movedIn: true })]);
  });

  it("reports new human comments only, once", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c1", listId: DOING, name: "Task", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    w.comments.c1 = [{ id: "m0", userId: HUMAN, text: "before", createdAt: "2020-01-01T00:00:00Z" }];
    await tracker.check();
    w.comments.c1.push({ id: "m1", userId: HUMAN, text: "Can you take this?", createdAt: tick(1) });
    w.comments.c1.push({ id: "m2", userId: ME, text: "bot reply", createdAt: tick(1) });
    const r = await tracker.check();
    expect(r.events).toEqual([
      expect.objectContaining({ type: "comment", cardId: "c1", card: "Task", commentId: "m1", author: "Olga", text: "Can you take this?" }),
    ]);
    expect((await tracker.check()).events).toEqual([]);
  });

  it("peek does not consume events", async () => {
    const { w, tracker, tick } = setup();
    await tracker.check();
    w.cards.push({ id: "c1", listId: BACKLOG, name: "X", creatorUserId: HUMAN, createdAt: tick(1) });
    expect((await tracker.check({ peek: true })).events).toHaveLength(1);
    expect((await tracker.check()).events).toHaveLength(1);
    expect((await tracker.check()).events).toHaveLength(0);
  });

  it("state persists across tracker instances", async () => {
    const { w, f, tracker, tick } = setup();
    await tracker.check();
    w.cards.push({ id: "c1", listId: BACKLOG, name: "X", creatorUserId: HUMAN, createdAt: tick(1) });
    const fresh = new UpdateTracker(f.client, statePath, { now });
    expect((await fresh.check()).events).toHaveLength(1);
  });

  it("is exposed as planka_check_updates", async () => {
    const { w, f, tick } = setup();
    const { createServer } = await import("../../src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(f.client, new UpdateTracker(f.client, statePath, { now }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "planka_check_updates", arguments: {} });
    w.cards.push({ id: "c1", listId: BACKLOG, name: "X", creatorUserId: HUMAN, createdAt: tick(1) });
    const r: any = await client.callTool({ name: "planka_check_updates", arguments: { projectId: "10" } });
    expect(JSON.parse(r.content[0].text).events[0].cardId).toBe("c1");
  });
});
