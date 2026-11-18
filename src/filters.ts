/**
 * Card and list filters shared by get_board and search_cards: list selection by name or ID,
 * closed state, and due date ranges.
 */
type Rec = Record<string, any>;

export interface CardFilter {
  /** true: only closed cards; false: only open cards. A card is closed if it is, or if its list has type "closed". */
  closed?: boolean;
  /** Due date bounds in epoch ms, inclusive. Any due filter leaves out cards without a due date. */
  dueFrom?: number;
  dueTo?: number;
  /** true: only cards whose due date is marked done; false: only those not marked done. */
  dueCompleted?: boolean;
}

/** How much of a card's description to return: false/undefined = none, true = short preview, "full" = all of it. */
export type DescriptionMode = boolean | "full";

export const hasDueFilter = (f?: CardFilter) =>
  !!f && (f.dueFrom !== undefined || f.dueTo !== undefined || f.dueCompleted !== undefined);

export const isClosedCard = (c: Rec, list?: Rec) => !!c.isClosed || list?.type === "closed";

export function cardPasses(c: Rec, list: Rec | undefined, f?: CardFilter): boolean {
  if (!f) return true;
  if (f.closed !== undefined && isClosedCard(c, list) !== f.closed) return false;
  if (!hasDueFilter(f)) return true;
  const t = c.dueDate ? Date.parse(c.dueDate) : NaN;
  if (Number.isNaN(t)) return false;
  if (f.dueFrom !== undefined && t < f.dueFrom) return false;
  if (f.dueTo !== undefined && t > f.dueTo) return false;
  if (f.dueCompleted !== undefined && !!c.isDueCompleted !== f.dueCompleted) return false;
  return true;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an ISO date or date-time bound. A plain date (YYYY-MM-DD) covers the whole day in UTC:
 * "from" starts at 00:00:00.000Z, "to" ends at 23:59:59.999Z.
 */
export function parseDueBound(s: string, edge: "from" | "to"): number {
  const v = s.trim();
  const t = DATE_ONLY.test(v) ? Date.parse(`${v}T${edge === "from" ? "00:00:00.000" : "23:59:59.999"}Z`) : Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid date "${s}": use an ISO date (2026-11-20) or date-time (2026-11-20T09:00:00Z)`);
  return t;
}

/** Build a card filter from tool input; throws for bad dates or dueFrom after dueTo. */
export function cardFilterFrom(input: {
  closed?: boolean;
  dueFrom?: string;
  dueTo?: string;
  dueCompleted?: boolean;
}): CardFilter | undefined {
  const f: CardFilter = {
    closed: input.closed,
    dueFrom: input.dueFrom !== undefined ? parseDueBound(input.dueFrom, "from") : undefined,
    dueTo: input.dueTo !== undefined ? parseDueBound(input.dueTo, "to") : undefined,
    dueCompleted: input.dueCompleted,
  };
  if (f.dueFrom !== undefined && f.dueTo !== undefined && f.dueFrom > f.dueTo) {
    throw new Error("dueFrom is after dueTo");
  }
  return Object.values(f).some((v) => v !== undefined) ? f : undefined;
}

/**
 * Pick lists by ID or by name (case-insensitive). Returns the selected list IDs and the requested
 * entries that matched no list.
 */
export function selectLists(lists: Rec[], wanted: string[]): { ids: Set<string>; missing: string[] } {
  const ids = new Set<string>();
  const missing: string[] = [];
  for (const w of wanted) {
    const n = w.trim().toLowerCase();
    const hit = lists.filter((l) => l.id === w.trim() || (n && String(l.name ?? "").trim().toLowerCase() === n));
    if (hit.length) for (const l of hit) ids.add(l.id);
    else if (!missing.includes(w)) missing.push(w);
  }
  return { ids, missing };
}
