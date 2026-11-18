import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { loadOwnScope } from "../scope.js";
import { cardFilterFrom, hasDueFilter } from "../filters.js";
import { formatBoard, formatCard, formatProjects, matchLabels, searchBoard, type SearchHit } from "../format.js";
import { id, safe } from "../util.js";

const RO = { readOnlyHint: true, openWorldHint: true } as const;

const labelsInput = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(20)
  .optional()
  .describe("Only cards with these labels (names, case-insensitive)");
const matchInput = z
  .enum(["any", "all"])
  .optional()
  .describe('With labels: "any" = at least one of them (OR, default), "all" = every one (AND)');

const descriptionsInput = z
  .union([z.boolean(), z.literal("full")])
  .optional()
  .describe('Card descriptions: true = short preview, "full" = complete text (default: none)');
const isoDate = (what: string) =>
  z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(`${what}: ISO date (2026-11-20, whole day in UTC) or date-time (2026-11-20T09:00:00Z), inclusive`);

const normLabel = (l: string) => l.trim().toLowerCase();
/** Requested labels (first spelling, deduplicated case-insensitively) that no searched board has. */
const labelsNotFound = (labels: string[], found: Set<string>) => {
  const seen = new Set<string>();
  return labels.filter((l) => {
    const n = normLabel(l);
    if (!n || seen.has(n) || found.has(n)) return false;
    seen.add(n);
    return true;
  });
};

export function registerBrowseTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_whoami",
    {
      title: "Who am I",
      description: "Return the Planka user the API key belongs to (id, name, role).",
      inputSchema: {},
      annotations: RO,
    },
    safe(async () => {
      const { item } = await client.get("/users/me");
      return { id: item.id, name: item.name, username: item.username, role: item.role, language: item.language };
    }),
  );

  server.registerTool(
    "planka_list_projects",
    {
      title: "List projects",
      description: "List all Planka projects visible to the user, each with its boards (id + name). Start here to find board IDs.",
      inputSchema: {},
      annotations: RO,
    },
    safe(async () => formatProjects(await client.get("/projects"))),
  );

  server.registerTool(
    "planka_get_board",
    {
      title: "Get board",
      description:
        "Get a board as lists → cards (with label names, task progress 'done/total', due date, comment count). " +
        "Also returns the board's labels and list IDs needed for creating/moving cards. With labels, only cards " +
        "carrying them are returned (match any/all), lists without such cards are left out, and labelFilter " +
        "reports the number of matches and any labels the board doesn't have. lists: only those lists (names or IDs; " +
        "listFilter reports names that matched none). closed: false leaves out closed cards and lists of type " +
        "\"closed\" (e.g. Done), closed: true returns only closed cards.",
      inputSchema: {
        boardId: id("Board ID"),
        includeArchived: z.boolean().optional().describe("Include archive/trash lists (default false)"),
        includeDescriptions: descriptionsInput,
        labels: labelsInput,
        match: matchInput,
        lists: z
          .array(z.string().min(1).max(1024))
          .min(1)
          .max(50)
          .optional()
          .describe("Only these lists: names (case-insensitive) or list IDs. Named archive/trash lists are included"),
        closed: z.boolean().optional().describe("false: open cards only, without closed lists; true: closed cards only"),
      },
      annotations: RO,
    },
    safe(async ({ boardId, includeArchived, includeDescriptions, labels, match, lists, closed }) =>
      formatBoard(await client.get(`/boards/${boardId}`), {
        includeArchived,
        includeDescriptions,
        labelFilter: labels ? { labels, match } : undefined,
        lists,
        cardFilter: cardFilterFrom({ closed }),
      }),
    ),
  );

  server.registerTool(
    "planka_get_card",
    {
      title: "Get card",
      description: "Get full card details: description, list, labels, due date, task lists with tasks (IDs), and comments.",
      inputSchema: { cardId: id("Card ID") },
      annotations: RO,
    },
    safe(async ({ cardId }) => {
      const card = await client.get(`/cards/${cardId}`);
      const [comments, board] = await Promise.all([
        client.get(`/cards/${cardId}/comments`),
        client.get(`/boards/${card.item.boardId}`),
      ]);
      return formatCard(card, comments, board);
    }),
  );

  server.registerTool(
    "planka_search_cards",
    {
      title: "Search cards",
      description:
        "Find cards by text, labels, due date and closed state. query: case-insensitive search over card names and " +
        "descriptions. labels: only cards with those labels (match \"any\" = OR, default; \"all\" = AND). " +
        "dueFrom/dueTo: due date in that range (inclusive; cards without a due date are left out), dueCompleted: due " +
        "date marked done or not, closed: closed or open cards. Give at least one of these; the rest are optional. " +
        "Example: overdue reminders = dueTo <now>, dueCompleted false, closed false. With a due filter, results are " +
        "sorted by due date across all searched boards. Results include due, dueDone and closed. " +
        "Only searches PRIVATE projects owned by the API-key user (shared projects and other people's projects are never " +
        "read). Scope to one of those boards or projects; with no scope, searches all of them. Each result lists its labels; " +
        "labels that exist on none of the searched boards are reported in labelsNotFound (and, for a board or project " +
        "search, per board in missingLabels), unreadable boards in skippedBoards.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Text to search for"),
        labels: labelsInput,
        match: matchInput,
        boardId: id("Board ID to search in").optional(),
        projectId: id("Project ID whose boards to search").optional(),
        includeArchived: z.boolean().optional().describe("Also search archive/trash lists (default false)"),
        dueFrom: isoDate("Due on or after"),
        dueTo: isoDate("Due on or before"),
        dueCompleted: z.boolean().optional().describe("true: due date marked done; false: not marked done"),
        closed: z.boolean().optional().describe("true: closed cards only (incl. cards in closed lists); false: open only"),
        includeDescriptions: descriptionsInput,
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      },
      annotations: RO,
    },
    safe(async (args) => {
      const { query, labels, match, boardId, projectId, includeArchived, includeDescriptions, limit = 50 } = args;
      const cardFilter = cardFilterFrom(args);
      if (!query && !labels?.length && !cardFilter) {
        throw new Error("Give query, labels, a due filter (dueFrom/dueTo/dueCompleted) or closed");
      }
      const byDue = hasDueFilter(cardFilter);
      const labelFilter = labels?.length ? { labels, match } : undefined;
      const scope = await loadOwnScope(client);
      let boardIds: string[];
      if (boardId) {
        if (!scope.projectIds.has(scope.boardProject.get(boardId) ?? "")) {
          throw new Error(`Board ${boardId} is not in one of your own private projects; search only reads those`);
        }
        boardIds = [boardId];
      } else if (projectId) {
        if (!scope.projectIds.has(projectId)) {
          throw new Error(`Project ${projectId} is not one of your own private projects; search only reads those`);
        }
        boardIds = scope.boards.filter((b) => b.projectId === projectId).map((b) => b.id);
      } else {
        boardIds = scope.boards.map((b) => b.id);
      }
      const hits: SearchHit[] = [];
      const missingLabels: { boardId: string; board: string; labels: string[] }[] = [];
      const foundSomewhere = new Set<string>();
      const skippedBoards: { boardId: string; error: string }[] = [];
      let searched = 0;
      for (const bid of boardIds) {
        let resp: any;
        try {
          resp = await client.get(`/boards/${bid}`);
        } catch (err) {
          // One unreadable board (e.g. no membership) shouldn't fail a project- or account-wide search.
          if (boardId) throw err;
          skippedBoards.push({ boardId: bid, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        searched++;
        if (labelFilter) {
          const { missing } = matchLabels(resp, labelFilter);
          const missingNorm = new Set(missing.map(normLabel));
          for (const l of labelFilter.labels) if (!missingNorm.has(normLabel(l))) foundSomewhere.add(normLabel(l));
          if (missing.length) missingLabels.push({ boardId: bid, board: resp.item.name, labels: missing });
        }
        hits.push(...searchBoard(resp, query, { includeArchived, labelFilter, cardFilter, includeDescriptions }));
        // Sorting by due date needs every board; otherwise stop once enough was found.
        if (!byDue && hits.length > limit) break;
      }
      if (byDue) hits.sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
      return {
        ...(query ? { query } : {}),
        ...(labelFilter ? { labels, match: match ?? "any" } : {}),
        boardsSearched: searched,
        ...(!boardId && !projectId && scope.excludedProjects ? { excludedProjects: scope.excludedProjects } : {}),
        total: Math.min(hits.length, limit),
        ...(hits.length > limit ? { truncated: true } : {}),
        results: hits.slice(0, limit),
        // Labels that exist on none of the searched boards (typo?); per-board gaps only for a scoped search.
        ...(labelFilter && labelsNotFound(labelFilter.labels, foundSomewhere).length
          ? { labelsNotFound: labelsNotFound(labelFilter.labels, foundSomewhere) }
          : {}),
        ...((boardId || projectId) && missingLabels.length ? { missingLabels } : {}),
        ...(skippedBoards.length ? { skippedBoards } : {}),
      };
    }),
  );
}
