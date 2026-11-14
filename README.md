# mcp-planka

MCP server for [Planka](https://planka.app) **v2** kanban boards. It lets an AI assistant browse boards and manage cards, comments, checklists and labels. It can also report **new Backlog cards** and **new comments from people**, so you can talk with the assistant through card comments in both directions.

It is a standard [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, built on the official MCP SDK, with no dependency on a particular AI vendor. Any MCP client can use it: see [Other MCP clients](#other-mcp-clients).

**Tested with:** [Claude Code](https://docs.claude.com/claude-code) (CLI), on Linux/WSL, in Node and Docker mode, against a live Planka v2 server. Other clients are not tested yet, but they use the same protocol, so they are expected to work.

## Setup

```bash
npm install
npm run build
```

Config is read from environment variables first, then from a `.planka` file. The server looks for that file in `$PLANKA_CONFIG`, then the current directory, then the package root. CRLF line endings are fine.

```ini
URL=https://planka.example.com
KEY=<api key>
```

| Env var | Purpose |
|---|---|
| `PLANKA_URL`, `PLANKA_API_KEY` | Override the `.planka` file |
| `PLANKA_CONFIG` | Path to a `.planka` file |
| `PLANKA_MANAGERS` / `MANAGERS=` in `.planka` | Comma-separated users (id, username, email or name). They become editors of every board `planka_create_project` / `planka_create_board` creates. Projects are always private with a single owner (the API-key user), so they don't become project managers there. No confirmation needed |
| `PLANKA_INSTRUCTIONS` / `INSTRUCTIONS=` in `.planka` | Workflow rules the server sends to the client as MCP *instructions* when it connects. They cover tracking work on the project board matching the folder name, comments without a signature, and preview plus confirmation before deletes. Unset: the built-in rules (`src/instructions.ts`). `off`: none. A file path: that file's text |
| `PLANKA_STATE_DIR` | Where update-tracking snapshots are stored (default `~/.mcp-planka`) |
| `PLANKA_BACKLOG_PATTERN` | Regex (case-insensitive) that marks a list as a backlog (default `backlog`) |
| `PLANKA_WATCH_INTERVAL` | Poll seconds for the watcher (default 60, min 10) |

To create an API key in Planka v2, open your user settings and go to API key. Requests send it in the `X-Api-Key` header.

### Register with Claude Code (tested)

`./register.sh` first tests what works on this host:
- Node ≥ 20 with npm
- Docker: installed **and** its daemon reachable (`docker info`)
- Podman: installed **and** `podman info` succeeds

It then recommends an option and asks which one to use:

| Mode | How Claude Code starts the server | Recommended when |
|---|---|---|
| `node` | `node dist/index.js` (the script installs and builds here) | Node ≥ 20 is available |
| `podman` | `podman run -i --rm … mcp-planka` (image built locally) | no Node, and Podman works |
| `docker` | `docker run -i --rm … mcp-planka` (image built locally) | no Node or Podman, and Docker works |

The script then checks the API key against the server, replaces any existing registration, and registers the server in **user** scope (all projects).

```bash
./register.sh                                            # detect, recommend, ask
./register.sh --yes                                      # take the recommendation without asking
./register.sh --mode docker                              # pick a mode yourself
./register.sh --name planka-me --config ~/.planka-me     # second identity (another user's API key)
./register.sh --dry-run                                  # show what would happen
```
```powershell
.\register.ps1        # Windows-native Claude Code; uses Windows Node, or WSL if no Node is installed
```

In container mode:
- `.planka` is mounted read-only and never copied into the image (`.dockerignore`).
- The update-tracking state lives in the `mcp-planka-state` volume.
- After `git pull`, run `./register.sh` again to rebuild the image.

Restart Claude Code afterwards. `/mcp` only lists servers that were loaded when the session started.

### Other MCP clients

Every MCP client starts the server the same way: it runs a command and talks to it over stdin/stdout. Build it first (`npm install && npm run build`), or build the image (`docker build -t mcp-planka .`). Then add one of these entries to the client's config, with your absolute paths:

**Node**
```json
{
  "mcpServers": {
    "planka": {
      "command": "node",
      "args": ["/abs/path/mcp-planka/dist/index.js"],
      "env": { "PLANKA_CONFIG": "/abs/path/mcp-planka/.planka" }
    }
  }
}
```

**Docker** (use `podman` the same way; for Podman on SELinux hosts, use `:ro,z` instead of `:ro`)
```json
{
  "mcpServers": {
    "planka": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--pull=never",
               "-v", "/abs/path/mcp-planka/.planka:/app/.planka:ro",
               "-v", "mcp-planka-state:/data", "mcp-planka:latest"]
    }
  }
}
```

Where each client keeps that config:

| Client | Config file | Notes |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` (Settings → Developer → Edit Config) | `mcpServers` format as above |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) | `mcpServers` format as above |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` format as above |
| Cline / Roo Code | MCP Servers panel → Configure (`cline_mcp_settings.json`) | `mcpServers` format as above |
| VS Code (Copilot agent mode) | `.vscode/mcp.json` or user settings | top-level key is `servers` instead of `mcpServers`; add `"type": "stdio"` |
| OpenAI Codex CLI | `~/.codex/config.toml` | `[mcp_servers.planka]` with `command = "node"`, `args = [...]`, `env = { PLANKA_CONFIG = "..." }` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` format as above |
| Any other client | its MCP settings | command, args and env as above |

Check that it works by asking the assistant to "call planka_whoami". To test the server without any assistant, use `npx @modelcontextprotocol/inspector node dist/index.js`.

**What doesn't carry over from Claude Code:**
- **Registration:** `register.sh` / `register.ps1` only register with Claude Code. Other clients need the config entry above.
- **Workflow rules:** they ship with the server as MCP instructions (see `INSTRUCTIONS` above), so every client that supports server instructions gets them. For a client that ignores them, copy `src/instructions.ts`'s text into that client's rules file: `AGENTS.md` (Codex), `.cursor/rules`, `GEMINI.md`, `.github/copilot-instructions.md`, and so on.
- **Approval prompts:** whether the client asks you before running a tool is up to the client. The server's own safeguards work in every client:
  - Projects are always private.
  - Deletes need a preview and then the exact name.
  - The bot's rights are checked before a board teardown starts.
  - Membership changes need `dryRun: false`.
- **Push notifications:** the watcher (`dist/watch.js`) prints JSON lines. In Claude Code the Monitor tool feeds them into the session. Elsewhere, pipe them into any notifier, or ask the assistant to call `planka_check_updates`.

**Why `npm run build`?** The source is TypeScript (`src/*.ts`), and Node runs the compiled JavaScript in `dist/`. `dist/` is generated and not committed. Rebuild after every source change: a running MCP client (e.g. a Claude Code session) keeps using the old `dist/` until you rebuild and restart. (`node src/index.ts` fails: the imports use the `.js` paths that only exist after compiling (`Cannot find module src/client.js`), and Node's type stripping doesn't support TS-only syntax such as constructor parameter properties. `npm run dev` runs the source through `tsx` without building, but it starts slower and needs the dev dependencies.)

## Tools

| Area | Tool | Notes |
|---|---|---|
| Browse | `planka_whoami`, `planka_list_projects`, `planka_get_board`, `planka_get_card`, `planka_search_cards` | Read-only. The output is compact JSON |
| Projects | `planka_find_project`, `planka_create_project`, `planka_update_project`, `planka_create_board` | Find matches names case-insensitively. Create **always** makes a **private** project with an **UPPERCASE** name (`mcp-planka` → `MCP-PLANKA`; there is no shared option; verified: other users, admins included, don't see it). The `MANAGERS` from the config become editors of its board automatically. `update_project` renames a project (also to UPPERCASE), changes or clears its description, and toggles the hide option. It also sets up a default board: Backlog / In Progress / Testing / Done. `create_board` has `addProjectManagers: true` to make the project's managers editors (by default only the creator is a member) |
| Lists | `planka_create_list`, `planka_update_list`, `planka_move_list` | `type`: `active` / `closed`. `move_list` moves a list and its cards to another board, also in another project (see below) |
| Cards | `planka_create_card`, `planka_update_card`, `planka_move_card`, `planka_delete_card` | To close a card, move it into a `closed` list |
| Comments | `planka_add_comment`, `planka_update_comment`, `planka_delete_comment` | |
| Tasks | `planka_create_task_list`, `planka_add_task`, `planka_update_task`, `planka_delete_task` | |
| Labels | `planka_create_label`, `planka_add_label_to_card`, `planka_remove_label_from_card` | 42 Planka color names |
| Updates | `planka_check_updates` | New Backlog cards and new human comments since the last check |
| Delete | `planka_delete_list`, `planka_delete_board`, `planka_delete_project` | **Two-step:** without `confirm` they only return a preview. They delete only when `confirm` is the item's exact name (see below) |
| Access | `planka_sync_board_members` | Adds project managers as board members (editor by default) so they can comment. **Dry run by default** |

Tools that take a position accept `"top"`, `"bottom"` (the default) or a 0-based index. IDs are numeric **strings**, because they are 64-bit snowflakes.

Card member assignment, custom fields and attachments are not in scope for v1.

**Deleting lists, boards and projects:** every delete tool works in two steps:
1. Call it without `confirm`: it returns a preview of what would go (board, card counts, boards in a project) and deletes nothing.
2. After the user confirms, call it again with `confirm` set to the **exact name**. A wrong name deletes nothing.

What Planka does:
- **List:** its cards move to the board's Trash and can be restored.
- **Board:** removed permanently in stages, each reported in the result:
  1. empty the lists: delete their cards, then clear the board's Trash
  2. delete the lists
  3. remove all board members, with the API-key user last
  4. delete the board

  The API-key user must be **project manager** and **board editor**. The tool checks this before step 1, so it never stops halfway because of missing rights. If a step fails anyway, the error names the step and what was already done.
- **Project:** Planka only deletes projects without boards. Pass `deleteBoards: true` to remove its boards first, using the same staged teardown. Needs project manager rights.

**Moving a list to another board or project** (`planka_move_list`): the API-key user must be an **editor on both** boards. The tool checks the target board before moving. Planka then adjusts the moved cards:
- labels are re-created by name on the target board, or matched to an existing label with the same name
- card members and task assignees who aren't members of the target board are removed
- custom fields are detached

## Notifications & two-way comments

The tracker saves a snapshot of every board (each card's list and comment count) and reports what changed since then:

- `backlog_card`: a card was created in a list matching `PLANKA_BACKLOG_PATTERN`, or moved into one. Cards the API-key user created are ignored.
- `comment`: a new comment by **anyone except the API-key user**. The assistant's own replies therefore never trigger events.

The first check of a board only records a baseline. Replies go back with `planka_add_comment` on the same `cardId`, which gives you a conversation inside the card.

You can receive events in three ways:
1. **On demand**: ask the assistant to "check Planka updates". This calls `planka_check_updates`, with state in `~/.mcp-planka/state.json`.
2. **Push, via a watcher**:

   ```bash
   node dist/watch.js --project <projectId> --interval 60   # one JSON line per event on stdout
   node dist/watch.js --board <id> --board <id> --once       # single check
   ```

   In Claude Code, run the watcher under the **Monitor** tool. Each event then arrives in the session and Claude can answer it on the card. With other clients, pipe the JSON lines into your own notifier. The watcher keeps its own state (`watch-state.json`), so it never consumes the MCP tool's events.
3. **Scheduled**: in Claude Code, `/loop 10m check planka updates and reply to new comments`. Other clients can use their own scheduler or cron.

> **Can't comment on a board?** Planka only lets *board members* comment. Project managers can administer a board without being a member of it. A board created through the API key also starts with the key's user as its only member. Fix it with `planka_sync_board_members` (preview first with `dryRun: true`, then apply with `dryRun: false`), or add members in the board header.

Planka's own webhooks need a public HTTPS endpoint. Polling works from a laptop behind NAT.

## MCP vs. raw API token

| Aspect | Raw API token | This MCP server |
|---|---|---|
| Reach | Every endpoint your role allows | 31 curated tools |
| Consumer | You or a script that knows routes and bodies | An AI assistant (any MCP client), from natural-language requests |
| IDs / positions | You look them up and calculate them by hand | Resolved from `get_board`/`search_cards`; `top`/`bottom`/index |
| Tokens | Raw board JSON: 17–100 KB | **12.1× smaller** (398 KB → 33 KB, measured over 8 real boards) |
| Safety | The token's full power | Limited set of tools; delete tools marked `destructiveHint` |
| Validation | Server-side only | zod checks before the request, plus clear Planka errors |
| Notifications | Webhooks need a public endpoint | `planka_check_updates` and the watch CLI |
| Best for | Bulk, cron, admin | Interactive triage, summaries, conversations in comments |

## Development

```bash
npm test                    # unit tests (offline, fake Planka backend + in-memory MCP client)
PLANKA_TEST_BOARD_ID=<id> npm run test:int   # live lifecycle test; creates and deletes temp lists
npm run typecheck
```
