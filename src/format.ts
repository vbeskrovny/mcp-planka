/**
 * Compact formatters: turn Planka's normalized `{item, included}` payloads into small,
 * nested JSON that is cheap for a model to read. IDs stay strings.
 */
import { cardPasses, hasDueFilter, selectLists, type CardFilter, type DescriptionMode } from "./filters.js";

type Rec = Record<string, any>;
const byPos = (a: Rec, b: Rec) => (a.position ?? 0) - (b.position ?? 0);
const HIDDEN_LIST_TYPES = new Set(["archive", "trash"]);

function compact<T extends Rec>(o: T): Partial<T> {
  const out: Rec = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export type LabelMatch = "any" | "all";
export interface LabelFilter {
  labels: string[];
  /** "any" (default): at least one of the labels; "all": every label. */
  match?: LabelMatch;
}

const normLabel = (s: unknown) => String(s ?? "").trim().toLowerCase();
/** A label's display name: its name, or its color for unnamed labels (as Planka shows them). */
const labelDisplay = (l: Rec) => l.name ?? l.color;

/**
 * Apply a label filter to one board payload. Names match case-insensitively; unnamed labels
 * match by color. Returns the matching card IDs and the requested labels the board doesn't have.
 */
export function matchLabels(resp: Rec, filter: LabelFilter): { cardIds: Set<string>; missing: string[] } {
  const inc = resp.included ?? {};
  const idsByName = new Map<string, Set<string>>();
  for (const l of inc.labels ?? []) {
    const n = normLabel(labelDisplay(l));
    if (!idsByName.has(n)) idsByName.set(n, new Set());
    idsByName.get(n)!.add(l.id);
  }
  const seen = new Set<string>();
  const wanted = filter.labels.filter((l) => {
    const n = normLabel(l);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  const missing = wanted.filter((l) => !idsByName.has(normLabel(l)));

  const labelsOfCard = new Map<string, Set<string>>();
  for (const cl of inc.cardLabels ?? []) {
    if (!labelsOfCard.has(cl.cardId)) labelsOfCard.set(cl.cardId, new Set());
    labelsOfCard.get(cl.cardId)!.add(cl.labelId);
  }
  const cardIds = new Set<string>();
  for (const c of inc.cards ?? []) {
    const own = labelsOfCard.get(c.id) ?? new Set<string>();
    const has = wanted.filter((l) => [...(idsByName.get(normLabel(l)) ?? [])].some((id) => own.has(id)));
    const ok = filter.match === "all" ? wanted.length > 0 && has.length === wanted.length : has.length > 0;
    if (ok) cardIds.add(c.id);
  }
  return { cardIds, missing };
}

export function truncate(s: string | null | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A card's description per mode: a short preview (true), all of it ("full") or nothing. */
function describe(text: string | null | undefined, mode: DescriptionMode | undefined, max = 160) {
  if (!mode) return undefined;
  return mode === "full" ? text?.trim() || undefined : truncate(text, max);
}

export function formatProjects(resp: Rec) {
  const boards: Rec[] = resp.included?.boards ?? [];
  return (resp.items ?? []).map((p: Rec) =>
    compact({
      id: p.id,
      name: p.name,
      description: truncate(p.description, 200),
      boards: boards
        .filter((b) => b.projectId === p.id)
        .sort(byPos)
        .map((b) => ({ id: b.id, name: b.name })),
    }),
  );
}

function taskProgress(cardId: string, taskLists: Rec[], tasks: Rec[]) {
  const listIds = new Set(taskLists.filter((t) => t.cardId === cardId).map((t) => t.id));
  const mine = tasks.filter((t) => listIds.has(t.taskListId));
  if (!mine.length) return undefined;
  return `${mine.filter((t) => t.isCompleted).length}/${mine.length}`;
}

export interface FormatBoardOptions {
  /** Include archive/trash lists (hidden by default). */
  includeArchived?: boolean;
  /** Description per card: true = short preview, "full" = complete text. */
  includeDescriptions?: DescriptionMode;
  /** Only keep cards with these labels; lists without matching cards are left out. */
  labelFilter?: LabelFilter;
  /** Only these lists (IDs or names, case-insensitive); named archive/trash lists are included too. */
  lists?: string[];
  /** Card filter. closed: false also leaves out lists of type "closed"; closed: true leaves out lists without closed cards. */
  cardFilter?: CardFilter;
}

export function formatBoard(resp: Rec, opts: FormatBoardOptions = {}) {
  const b = resp.item;
  const inc = resp.included ?? {};
  const labels: Rec[] = [...(inc.labels ?? [])].sort(byPos);
  const labelName = new Map(labels.map((l) => [l.id, labelDisplay(l)]));
  const filtered = opts.labelFilter?.labels.length ? matchLabels(resp, opts.labelFilter) : undefined;
  const cardLabels: Rec[] = inc.cardLabels ?? [];
  const taskLists: Rec[] = inc.taskLists ?? [];
  const tasks: Rec[] = inc.tasks ?? [];
  const cards: Rec[] = [...(inc.cards ?? [])].sort(byPos);
  const project = (inc.projects ?? []).find((p: Rec) => p.id === b.projectId);
  const listSel = opts.lists?.length ? selectLists(inc.lists ?? [], opts.lists) : undefined;
  const cf = opts.cardFilter;

  const lists = [...(inc.lists ?? [])]
    .filter((l: Rec) => (listSel ? listSel.ids.has(l.id) : opts.includeArchived || !HIDDEN_LIST_TYPES.has(l.type)))
    .filter((l: Rec) => !(cf?.closed === false && l.type === "closed"))
    .sort(byPos)
    .map((l: Rec) =>
      compact({
        id: l.id,
        name: l.name,
        type: l.type === "active" ? undefined : l.type,
        cards: cards
          .filter((c) => c.listId === l.id && (!filtered || filtered.cardIds.has(c.id)) && cardPasses(c, l, cf))
          .map((c) =>
            compact({
              id: c.id,
              name: c.name,
              labels: cardLabels.filter((cl) => cl.cardId === c.id).map((cl) => labelName.get(cl.labelId)),
              tasks: taskProgress(c.id, taskLists, tasks),
              due: c.dueDate ?? undefined,
              dueDone: c.dueDate ? c.isDueCompleted : undefined,
              comments: c.commentsTotal || undefined,
              closed: c.isClosed,
              description: describe(c.description, opts.includeDescriptions),
            }),
          ),
      }),
    );

  return compact({
    id: b.id,
    name: b.name,
    project: project ? { id: project.id, name: project.name } : { id: b.projectId },
    defaultCardType: b.defaultCardType,
    labels: labels.map((l) => compact({ id: l.id, name: l.name, color: l.color })),
    labelFilter: filtered
      ? compact({
          labels: opts.labelFilter!.labels,
          match: opts.labelFilter!.match ?? "any",
          matchingCards: lists.reduce((n: number, l: Rec) => n + (l.cards?.length ?? 0), 0),
          missingLabels: filtered.missing,
        })
      : undefined,
    listFilter: listSel ? compact({ lists: opts.lists, missingLists: listSel.missing }) : undefined,
    // Card filters that select cards (labels, closed: true, due) leave out lists with no matching card.
    lists: filtered || cf?.closed === true || hasDueFilter(cf) ? lists.filter((l: Rec) => l.cards?.length) : lists,
  });
}

/** Compact attachment: file (url, mimeType, size, image size) or link (url). */
export function formatAttachment(a: Rec, coverAttachmentId?: string | null, users?: Map<string, string>) {
  const d: Rec = a.data ?? {};
  return compact({
    id: a.id,
    name: a.name,
    type: a.type,
    url: d.url,
    mimeType: a.type === "file" ? d.mimeType ?? undefined : undefined,
    size: a.type === "file" ? d.size ?? d.sizeInBytes ?? undefined : undefined,
    image: d.image?.width ? `${d.image.width}x${d.image.height}` : undefined,
    isCover: coverAttachmentId ? a.id === coverAttachmentId : undefined,
    creator: users?.get(a.creatorUserId),
    createdAt: a.createdAt,
  });
}

export function formatCard(cardResp: Rec, commentsResp?: Rec, boardResp?: Rec) {
  const c = cardResp.item;
  const inc = cardResp.included ?? {};
  const boardInc = boardResp?.included ?? {};
  const labelById = new Map((boardInc.labels ?? []).map((l: Rec) => [l.id, l]));
  const list = (boardInc.lists ?? []).find((l: Rec) => l.id === c.listId);
  const users = new Map(
    [...(inc.users ?? []), ...(commentsResp?.included?.users ?? [])].map((u: Rec) => [u.id, u.name ?? u.username]),
  );
  const tasks: Rec[] = [...(inc.tasks ?? [])].sort(byPos);

  return compact({
    id: c.id,
    name: c.name,
    type: c.type,
    board: boardResp ? { id: boardResp.item.id, name: boardResp.item.name } : { id: c.boardId },
    list: list ? { id: list.id, name: list.name, type: list.type } : { id: c.listId },
    description: c.description ?? undefined,
    labels: (inc.cardLabels ?? []).map((cl: Rec) => {
      const l = labelById.get(cl.labelId) as Rec | undefined;
      return l ? compact({ id: l.id, name: l.name, color: l.color }) : { id: cl.labelId };
    }),
    dueDate: c.dueDate ?? undefined,
    isDueCompleted: c.dueDate ? c.isDueCompleted : undefined,
    isClosed: c.isClosed,
    creator: users.get(c.creatorUserId),
    attachments: [...(inc.attachments ?? [])]
      .sort((a: Rec, b: Rec) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((a: Rec) => formatAttachment(a, c.coverAttachmentId, users)),
    taskLists: [...(inc.taskLists ?? [])].sort(byPos).map((tl: Rec) => ({
      id: tl.id,
      name: tl.name,
      tasks: tasks
        .filter((t) => t.taskListId === tl.id)
        .map((t) => ({ id: t.id, name: t.name, done: !!t.isCompleted })),
    })),
    comments: [...(commentsResp?.items ?? [])]
      .sort((a: Rec, b: Rec) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((m: Rec) => compact({ id: m.id, author: users.get(m.userId), at: m.createdAt, text: m.text })),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt ?? undefined,
  });
}

export interface SearchHit {
  boardId: string;
  board: string;
  list: string;
  cardId: string;
  name: string;
  /** "labels" / "filter": no query; the card was selected by labels or by the other filters only. */
  matchedIn: "name" | "description" | "labels" | "filter";
  labels?: string[];
  due?: string;
  dueDone?: boolean;
  closed?: boolean;
  snippet?: string;
  description?: string;
}

export interface SearchBoardOptions {
  includeArchived?: boolean;
  labelFilter?: LabelFilter;
  cardFilter?: CardFilter;
  includeDescriptions?: DescriptionMode;
}

/**
 * Find cards on one board by text (name/description, case-insensitive), labels and/or card filters
 * (closed state, due date). Without a query, every card passing the filters is a hit (matchedIn
 * "labels" when a label filter was given, else "filter").
 */
export function searchBoard(resp: Rec, query: string | undefined, opts: SearchBoardOptions = {}): SearchHit[] {
  const q = query?.toLowerCase();
  const inc = resp.included ?? {};
  const filtered = opts.labelFilter?.labels.length ? matchLabels(resp, opts.labelFilter) : undefined;
  const labelName = new Map<string, string>((inc.labels ?? []).map((l: Rec) => [l.id, labelDisplay(l)]));
  const cardLabelNames = (cardId: string) =>
    (inc.cardLabels ?? []).filter((cl: Rec) => cl.cardId === cardId).map((cl: Rec) => labelName.get(cl.labelId)).filter(Boolean);
  const lists = new Map<string, Rec>((inc.lists ?? []).map((l: Rec) => [l.id, l]));
  const hits: SearchHit[] = [];
  const listPos = (c: Rec) => lists.get(c.listId)?.position ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...(inc.cards ?? [])].sort((a, b) => listPos(a) - listPos(b) || byPos(a, b));
  for (const c of ordered) {
    const list = lists.get(c.listId);
    if (!opts.includeArchived && list && HIDDEN_LIST_TYPES.has(list.type)) continue;
    if (filtered && !filtered.cardIds.has(c.id)) continue;
    if (!cardPasses(c, list, opts.cardFilter)) continue;
    const inName = q ? c.name?.toLowerCase().includes(q) : false;
    const descIdx = q && c.description ? c.description.toLowerCase().indexOf(q) : -1;
    if (q && !inName && descIdx < 0) continue;
    const labels = cardLabelNames(c.id);
    hits.push({
      boardId: resp.item.id,
      board: resp.item.name,
      list: list?.name ?? c.listId,
      cardId: c.id,
      name: c.name,
      matchedIn: q ? (inName ? "name" : "description") : filtered ? "labels" : "filter",
      ...(labels.length ? { labels } : {}),
      ...(c.dueDate ? { due: c.dueDate, ...(c.isDueCompleted ? { dueDone: true } : {}) } : {}),
      ...(c.isClosed || list?.type === "closed" ? { closed: true } : {}),
      snippet: !q || inName ? undefined : truncate(c.description.slice(Math.max(0, descIdx - 40), descIdx + 80), 120),
      ...(opts.includeDescriptions && c.description?.trim()
        ? { description: describe(c.description, opts.includeDescriptions) }
        : {}),
    });
  }
  return hits;
}
