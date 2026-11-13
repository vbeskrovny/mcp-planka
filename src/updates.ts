/**
 * Change tracking for "notifications": new cards in Backlog lists and new comments by humans.
 * Planka has no "changes since" API for this, so we keep a per-board snapshot
 * (card → listId + commentsTotal) and diff against it on every check.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PlankaClient } from "./client.js";

export interface BacklogCardEvent {
  type: "backlog_card";
  boardId: string;
  board: string;
  listId: string;
  list: string;
  cardId: string;
  name: string;
  /** true if an existing card was moved into the backlog, false if newly created there. */
  movedIn: boolean;
  by?: string;
  at: string;
}

export interface CommentEvent {
  type: "comment";
  boardId: string;
  board: string;
  list: string;
  cardId: string;
  card: string;
  commentId: string;
  author: string;
  authorId: string;
  text: string;
  at: string;
}

export type UpdateEvent = BacklogCardEvent | CommentEvent;

interface CardSnap {
  l: string; // listId
  c: number; // commentsTotal
}
interface BoardSnap {
  lastCheck: string;
  cards: Record<string, CardSnap>;
}
export interface TrackerState {
  version: 1;
  boards: Record<string, BoardSnap>;
}

export interface CheckOptions {
  boardIds?: string[];
  projectId?: string;
  /** Do not persist the new snapshot (events will be reported again next time). */
  peek?: boolean;
}

export interface CheckResult {
  checkedAt: string;
  boards: { id: string; name: string; initialized?: boolean }[];
  events: UpdateEvent[];
}

export function defaultStatePath(name = "state.json"): string {
  const dir = process.env.PLANKA_STATE_DIR || join(homedir(), ".mcp-planka");
  return join(dir, name);
}

export class UpdateTracker {
  private me?: string;
  private readonly now: () => Date;
  readonly backlogPattern: RegExp;

  constructor(
    private readonly client: PlankaClient,
    private readonly statePath: string = defaultStatePath(),
    opts: { backlogPattern?: RegExp; now?: () => Date } = {},
  ) {
    this.backlogPattern = opts.backlogPattern ?? new RegExp(process.env.PLANKA_BACKLOG_PATTERN || "backlog", "i");
    this.now = opts.now ?? (() => new Date());
  }

  loadState(): TrackerState {
    if (!existsSync(this.statePath)) return { version: 1, boards: {} };
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8"));
      return s?.version === 1 && s.boards ? s : { version: 1, boards: {} };
    } catch {
      return { version: 1, boards: {} };
    }
  }

  private saveState(state: TrackerState) {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.statePath);
  }

  private async myUserId(): Promise<string> {
    if (!this.me) this.me = (await this.client.get("/users/me")).item.id as string;
    return this.me;
  }

  private async resolveBoards(opts: CheckOptions): Promise<string[]> {
    if (opts.boardIds?.length) return opts.boardIds;
    const projects = await this.client.get("/projects");
    return (projects.included?.boards ?? [])
      .filter((b: any) => !opts.projectId || b.projectId === opts.projectId)
      .map((b: any) => b.id as string);
  }

  async check(opts: CheckOptions = {}): Promise<CheckResult> {
    const me = await this.myUserId();
    const state = this.loadState();
    const checkedAt = this.now().toISOString();
    const result: CheckResult = { checkedAt, boards: [], events: [] };

    for (const boardId of await this.resolveBoards(opts)) {
      const resp = await this.client.get(`/boards/${boardId}`);
      const board = resp.item;
      const inc = resp.included ?? {};
      const lists = new Map<string, any>((inc.lists ?? []).map((l: any) => [l.id, l]));
      const users = new Map<string, string>((inc.users ?? []).map((u: any) => [u.id, u.name ?? u.username ?? u.id]));
      const cards: any[] = inc.cards ?? [];
      const prev = state.boards[boardId];
      const snap: BoardSnap = { lastCheck: checkedAt, cards: {} };
      for (const c of cards) snap.cards[c.id] = { l: c.listId, c: c.commentsTotal ?? 0 };

      if (!prev) {
        // First sight of this board: establish a baseline without flooding old activity.
        result.boards.push({ id: boardId, name: board.name, initialized: true });
        state.boards[boardId] = snap;
        continue;
      }
      result.boards.push({ id: boardId, name: board.name });

      for (const c of cards) {
        const before = prev.cards[c.id];
        const list = lists.get(c.listId);
        const listName: string = list?.name ?? "";

        // New card in (or moved into) a backlog list.
        if (this.backlogPattern.test(listName) && (!before || before.l !== c.listId)) {
          const movedIn = !!before;
          if (movedIn || c.creatorUserId !== me) {
            result.events.push({
              type: "backlog_card",
              boardId,
              board: board.name,
              listId: c.listId,
              list: listName,
              cardId: c.id,
              name: c.name,
              movedIn,
              by: movedIn ? undefined : users.get(c.creatorUserId),
              at: (movedIn ? c.listChangedAt : c.createdAt) ?? checkedAt,
            });
          }
        }

        // New comments (by anyone but the API-key user).
        const total = c.commentsTotal ?? 0;
        if (total > (before?.c ?? 0)) {
          const comments = await this.client.get(`/cards/${c.id}/comments`);
          const cusers = new Map<string, string>(
            (comments.included?.users ?? []).map((u: any) => [u.id, u.name ?? u.username ?? u.id]),
          );
          for (const m of comments.items ?? []) {
            if (m.userId === me) continue;
            if (String(m.createdAt) <= prev.lastCheck) continue;
            result.events.push({
              type: "comment",
              boardId,
              board: board.name,
              list: listName,
              cardId: c.id,
              card: c.name,
              commentId: m.id,
              author: cusers.get(m.userId) ?? users.get(m.userId) ?? m.userId,
              authorId: m.userId,
              text: m.text,
              at: m.createdAt,
            });
          }
        }
      }
      state.boards[boardId] = snap;
    }

    result.events.sort((a, b) => a.at.localeCompare(b.at));
    if (!opts.peek) this.saveState(state);
    return result;
  }
}
