/**
 * Compact formatters: turn Planka's normalized `{item, included}` payloads into small,
 * nested JSON that is cheap for a model to read. IDs stay strings.
 */
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

export function truncate(s: string | null | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
  /** Include a short description preview per card. */
  includeDescriptions?: boolean;
}

export function formatBoard(resp: Rec, opts: FormatBoardOptions = {}) {
  const b = resp.item;
  const inc = resp.included ?? {};
  const labels: Rec[] = [...(inc.labels ?? [])].sort(byPos);
  const labelName = new Map(labels.map((l) => [l.id, l.name ?? l.color]));
  const cardLabels: Rec[] = inc.cardLabels ?? [];
  const taskLists: Rec[] = inc.taskLists ?? [];
  const tasks: Rec[] = inc.tasks ?? [];
  const cards: Rec[] = [...(inc.cards ?? [])].sort(byPos);
  const project = (inc.projects ?? []).find((p: Rec) => p.id === b.projectId);

  const lists = [...(inc.lists ?? [])]
    .filter((l: Rec) => opts.includeArchived || !HIDDEN_LIST_TYPES.has(l.type))
    .sort(byPos)
    .map((l: Rec) =>
      compact({
        id: l.id,
        name: l.name,
        type: l.type === "active" ? undefined : l.type,
        cards: cards
          .filter((c) => c.listId === l.id)
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
              description: opts.includeDescriptions ? truncate(c.description, 160) : undefined,
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
    lists,
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
  matchedIn: "name" | "description";
  snippet?: string;
}

export function searchBoard(resp: Rec, query: string, opts: { includeArchived?: boolean } = {}): SearchHit[] {
  const q = query.toLowerCase();
  const inc = resp.included ?? {};
  const lists = new Map<string, Rec>((inc.lists ?? []).map((l: Rec) => [l.id, l]));
  const hits: SearchHit[] = [];
  const listPos = (c: Rec) => lists.get(c.listId)?.position ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...(inc.cards ?? [])].sort((a, b) => listPos(a) - listPos(b) || byPos(a, b));
  for (const c of ordered) {
    const list = lists.get(c.listId);
    if (!opts.includeArchived && list && HIDDEN_LIST_TYPES.has(list.type)) continue;
    const inName = c.name?.toLowerCase().includes(q);
    const descIdx = c.description ? c.description.toLowerCase().indexOf(q) : -1;
    if (!inName && descIdx < 0) continue;
    hits.push({
      boardId: resp.item.id,
      board: resp.item.name,
      list: list?.name ?? c.listId,
      cardId: c.id,
      name: c.name,
      matchedIn: inName ? "name" : "description",
      snippet: inName ? undefined : truncate(c.description.slice(Math.max(0, descIdx - 40), descIdx + 80), 120),
    });
  }
  return hits;
}
