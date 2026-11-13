import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { computePosition } from "../position.js";
import { id, positionSpec, safe } from "../util.js";

const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const fmt = (t: any) => ({ id: t.id, taskListId: t.taskListId, name: t.name, done: !!t.isCompleted });

export function registerTaskTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_create_task_list",
    {
      title: "Create task list",
      description: "Create a checklist (task list) on a card, optionally pre-filled with tasks.",
      inputSchema: {
        cardId: id("Card ID"),
        name: z.string().min(1).max(128),
        tasks: z.array(z.string().min(1).max(1024)).optional().describe("Task names to add in order"),
      },
      annotations: W,
    },
    safe(async ({ cardId, name, tasks = [] }) => {
      const card = await client.get(`/cards/${cardId}`);
      const existing = (card.included?.taskLists ?? []).map((t: any) => t.position as number);
      const { item } = await client.post(`/cards/${cardId}/task-lists`, { name, position: computePosition(existing) });
      const created = [];
      for (let i = 0; i < tasks.length; i++) {
        created.push(fmt((await client.post(`/task-lists/${item.id}/tasks`, { name: tasks[i], position: (i + 1) * 65536 })).item));
      }
      return { id: item.id, cardId: item.cardId, name: item.name, tasks: created };
    }),
  );

  server.registerTool(
    "planka_add_task",
    {
      title: "Add task",
      description: "Add a task (checklist item) to a task list.",
      inputSchema: {
        taskListId: id("Task list ID"),
        name: z.string().min(1).max(1024),
        isCompleted: z.boolean().optional(),
        position: positionSpec,
      },
      annotations: W,
    },
    safe(async ({ taskListId, name, isCompleted, position }) => {
      const tl = await client.get(`/task-lists/${taskListId}`);
      const existing = (tl.included?.tasks ?? []).map((t: any) => t.position as number);
      const body: Record<string, unknown> = { name, position: computePosition(existing, position) };
      if (isCompleted !== undefined) body.isCompleted = isCompleted;
      return fmt((await client.post(`/task-lists/${taskListId}/tasks`, body)).item);
    }),
  );

  server.registerTool(
    "planka_update_task",
    {
      title: "Update task",
      description: "Rename a task or mark it done / not done.",
      inputSchema: {
        taskId: id("Task ID"),
        name: z.string().min(1).max(1024).optional(),
        isCompleted: z.boolean().optional(),
      },
      annotations: W,
    },
    safe(async ({ taskId, name, isCompleted }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (isCompleted !== undefined) body.isCompleted = isCompleted;
      if (!Object.keys(body).length) throw new Error("Nothing to update: pass name or isCompleted");
      return fmt((await client.patch(`/tasks/${taskId}`, body)).item);
    }),
  );

  server.registerTool(
    "planka_delete_task",
    {
      title: "Delete task",
      description: "Delete a task from a task list.",
      inputSchema: { taskId: id("Task ID") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ taskId }) => {
      await client.delete(`/tasks/${taskId}`);
      return { deleted: true, id: taskId };
    }),
  );
}
