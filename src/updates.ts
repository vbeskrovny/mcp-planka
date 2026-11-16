/**
 * Change tracking for "notifications": new cards in Backlog lists, cards moved between lists, ticked or
 * unticked tasks, cards labelled START (requests to start work), and new comments by humans.
 * Planka has no "changes since" API for this, so we keep a per-board snapshot
 * (card → listId + commentsTotal + completed task IDs) and diff against it on every check.
 * Who moved a card or ticked a task comes from the card's action log, so our own changes are skipped.
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
  /** For moved-in cards: the list it came from. */
  fromList?: string;
  by?: string;
  at: string;
}

/** A card moved to another list (other than a backlog list, which gives a backlog_card event) by someone else. */
export interface CardMovedEvent {
  type: "card_moved";
  boardId: string;
  board: string;
  cardId: string;
  name: string;
  fromListId: string;
  fromList: string;
  listId: string;
  list: string;
  /** Who moved it, when Planka's card actions say so. */
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

/** A task (checkbox) on a card was ticked or unticked by someone else. */
export interface TaskEvent {
  type: "task";
  boardId: string;
  board: string;
  list: string;
  cardId: string;
  card: string;
  taskId: string;
  task: string;
  taskList?: string;
  completed: boolean;
  by?: string;
  at: string;
}

/**
 * A card carries the start label (default "START"): a request to start working on it now. Reported once
 * when the label appears, and also on a board's first check, since it's pending work, not old activity.
 */
export interface StartRequestEvent {
  type: "start_request";
  boardId: string;
  board: string;
  listId: string;
  list: string;
  cardId: string;
  name: string;
  /** Label to remove (planka_remove_label_from_card) once the work has started. */
  labelId: string;
  label: string;
  at: string;
}

export type UpdateEvent = BacklogCardEvent | CardMovedEvent | TaskEvent | StartRequestEvent | CommentEvent;

interface CardActions {
  users: Map<string, string>;
  items: any[];
}

interface CardSnap {
  l: string; // listId
  c: number; // commentsTotal
  d?: string[]; // IDs of completed tasks (missing in state files from before task tracking)
  s?: 1; // carries the start label
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
  /** Name of the label that asks to start work on a card (case-insensitive). */
  readonly startLabel: string;

  constructor(
    private readonly client: PlankaClient,
    private readonly statePath: string = defaultStatePath(),
    opts: { backlogPattern?: RegExp; startLabel?: string; now?: () => Date } = {},
  ) {
    this.backlogPattern = opts.backlogPattern ?? new RegExp(process.env.PLANKA_BACKLOG_PATTERN || "backlog", "i");
    this.startLabel = (opts.startLabel ?? process.env.PLANKA_START_LABEL ?? "START").trim() || "START";
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

  /**
   * A card's action log (newest first), or undefined if it can't be read. Changes are then still
   * reported, just without an author.
   */
  private async cardActions(cardId: string): Promise<CardActions | undefined> {
    try {
      const resp = await this.client.get(`/cards/${cardId}/actions`);
      const users = new Map<string, string>((resp.included?.users ?? []).map((u: any) => [u.id, u.name ?? u.username ?? u.id]));
      const items = [...(resp.items ?? [])].sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { users, items };
    } catch {
      return undefined;
    }
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
      const taskLists = new Map<string, any>((inc.taskLists ?? []).map((t: any) => [t.id, t]));
      const tasksByCard = new Map<string, any[]>();
      for (const t of inc.tasks ?? []) {
        const cardId = taskLists.get(t.taskListId)?.cardId;
        if (!cardId) continue;
        if (!tasksByCard.has(cardId)) tasksByCard.set(cardId, []);
        tasksByCard.get(cardId)!.push(t);
      }
      // Cards carrying the start label: cardId -> the card-label link.
      const startLabels = new Map<string, any>(
        (inc.labels ?? [])
          .filter((l: any) => String(l.name ?? "").trim().toLowerCase() === this.startLabel.toLowerCase())
          .map((l: any) => [l.id, l]),
      );
      const startOf = new Map<string, any>();
      for (const cl of inc.cardLabels ?? []) if (startLabels.has(cl.labelId)) startOf.set(cl.cardId, cl);

      const prev = state.boards[boardId];
      const snap: BoardSnap = { lastCheck: checkedAt, cards: {} };
      for (const c of cards) {
        const done = (tasksByCard.get(c.id) ?? []).filter((t) => t.isCompleted).map((t) => t.id as string).sort();
        snap.cards[c.id] = { l: c.listId, c: c.commentsTotal ?? 0, d: done, ...(startOf.has(c.id) ? { s: 1 as const } : {}) };
      }

      // Start requests: newly labelled cards, and on a board's first check every labelled card (pending work).
      for (const c of cards) {
        const cl = startOf.get(c.id);
        if (!cl || (prev && prev.cards[c.id]?.s)) continue;
        result.events.push({
          type: "start_request", boardId, board: board.name, listId: c.listId, list: lists.get(c.listId)?.name ?? "",
          cardId: c.id, name: c.name, labelId: cl.labelId, label: startLabels.get(cl.labelId).name, at: cl.createdAt ?? checkedAt,
        });
      }

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

        const isBacklog = this.backlogPattern.test(listName);
        const moved = !!before && before.l !== c.listId;
        // The action log is fetched at most once per card, and only when something needs an author.
        let actions: CardActions | undefined | null = null;
        const getActions = async () => (actions === null ? (actions = await this.cardActions(c.id)) : actions);
        const nameOf = (a: CardActions | undefined, userId?: string) =>
          userId ? (a?.users.get(userId) ?? users.get(userId)) : undefined;

        if (moved) {
          // Moved to another list since the last check. Skip our own moves.
          const a = await getActions();
          const move = a?.items.find((x) => x.type === "moveCard");
          if (move?.userId !== me) {
            const fromList = move?.data?.fromList?.name ?? lists.get(before.l)?.name ?? before.l;
            const by = nameOf(a, move?.userId);
            const at = c.listChangedAt ?? move?.createdAt ?? checkedAt;
            if (isBacklog) {
              result.events.push({
                type: "backlog_card", boardId, board: board.name, listId: c.listId, list: listName,
                cardId: c.id, name: c.name, movedIn: true, fromList, by, at,
              });
            } else {
              result.events.push({
                type: "card_moved", boardId, board: board.name, cardId: c.id, name: c.name,
                fromListId: before.l, fromList, listId: c.listId, list: listName, by, at,
              });
            }
          }
        } else if (isBacklog && !before && c.creatorUserId !== me) {
          // New card created in a backlog list by someone else.
          result.events.push({
            type: "backlog_card", boardId, board: board.name, listId: c.listId, list: listName,
            cardId: c.id, name: c.name, movedIn: false, by: users.get(c.creatorUserId), at: c.createdAt ?? checkedAt,
          });
        }

        // Tasks ticked or unticked since the last check (needs a task baseline for this card).
        if (before?.d) {
          const wasDone = new Set(before.d);
          const nowDone = new Set(snap.cards[c.id].d);
          // Only tasks that existed at the last check: a task created already ticked is not a tick.
          const changed = (tasksByCard.get(c.id) ?? []).filter(
            (t) => wasDone.has(t.id) !== nowDone.has(t.id) && String(t.createdAt ?? "") <= prev.lastCheck,
          );
          for (const t of changed) {
            const completed = nowDone.has(t.id);
            const a = await getActions();
            const act = a?.items.find(
              (x) => (x.type === "completeTask" || x.type === "uncompleteTask") && x.data?.task?.id === t.id,
            );
            if (act?.userId === me) continue;
            result.events.push({
              type: "task", boardId, board: board.name, list: listName, cardId: c.id, card: c.name,
              taskId: t.id, task: t.name, taskList: taskLists.get(t.taskListId)?.name, completed,
              by: nameOf(a, act?.userId), at: act?.createdAt ?? t.updatedAt ?? checkedAt,
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
