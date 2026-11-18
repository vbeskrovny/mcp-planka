# mcp-planka

MCP server for [Planka](https://planka.app) **v2** kanban boards. It lets an AI assistant browse boards and manage cards, comments, checklists and labels. It can also report **new Backlog cards**, **cards people moved**, **ticked tasks**, **cards labelled START** and **new comments from people**, so you can talk with the assistant through card comments in both directions.

It is a standard [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, built on the official MCP SDK, with no dependency on a particular AI vendor. Any MCP client can use it: see [Other MCP clients](#other-mcp-clients).

**Tested with:** [Claude Code](https://docs.claude.com/claude-code) (CLI), on Linux/WSL, in Node and Docker mode, against a live Planka v2 server. Other clients are not tested yet, but they use the same protocol, so they are expected to work.

## Setup

```bash
npm install
npm run build
```

Every setting is named `MCP_APP_PLANKA_<name>`. It can be an environment variable, or a line in a `.env` file. The environment wins. The file is `$MCP_APP_PLANKA_CONFIG` if set, otherwise `.env` in the package root. The current directory is not searched: it's usually the project the assistant works on, and that project's own `.env` has nothing to do with Planka. CRLF line endings are fine, and other keys in the file are ignored, so one `.env` can hold the settings of several apps.

```ini
MCP_APP_PLANKA_URL=https://planka.example.com
MCP_APP_PLANKA_API_KEY=<api key>
```

**Upgrading:** `register.sh` and `register.ps1` migrate older configs for you.

Two older formats are recognized:
- a `.planka` file with `URL=`, `KEY=`, `MANAGERS=`, `INSTRUCTIONS=` and `FILES_DIR=`
- a `.env` with `PLANKA_<name>=` keys

How the migration works:
- **Renaming:** the keys get their `MCP_APP_PLANKA_` names (`KEY` and `PLANKA_API_KEY` become `MCP_APP_PLANKA_API_KEY`). A `.planka` is merged into `.env`, which gets mode 600. The `.planka` file is deleted once the result is verified.
- **Plain keys:** keys like `URL=` and `KEY=` are converted only in a file named `.planka*`. In a `.env` they may belong to another app, so they're left alone (`--no-bare`).
- **Conflicts:** if a key already has a different value, nothing is changed.
- **Doing it by hand:** `scripts/migrate-config.sh .planka .env`, or `scripts/migrate-config.sh --no-bare .env .env`. Neither script ever prints values.

Until the migration runs, the server refuses to start, and its error message names each old key with its new name.

| Setting (environment or `.env`) | Purpose |
|---|---|
| `MCP_APP_PLANKA_URL`, `MCP_APP_PLANKA_API_KEY` | Planka address and API key |
| `MCP_APP_PLANKA_CONFIG` | Path to the config file (default: `.env` in the package root). Environment only |
| `MCP_APP_PLANKA_MANAGERS` | Comma-separated users (id, username, email or name). They become editors of every board `planka_create_project` / `planka_create_board` creates. Projects are always private with a single owner (the API-key user), so they don't become project managers there. No confirmation needed |
| `MCP_APP_PLANKA_INSTRUCTIONS` | Workflow rules the server sends to the client as MCP *instructions* when it connects. They cover tracking work on the project board matching the folder name, comments without a signature, and preview plus confirmation before deletes. Unset: the built-in rules (`src/instructions.ts`). `off`: none. A file path: that file's text |
| `MCP_APP_PLANKA_FILES_DIR` | If set, the attachment tools only read and write local files inside this directory. Relative paths start there. Unset: any path the server process can access, relative to its working directory |
| `MCP_APP_PLANKA_STATE_DIR` | Where update-tracking snapshots are stored (default `~/.mcp-planka`) |
| `MCP_APP_PLANKA_BACKLOG_PATTERN` | Regex (case-insensitive) that marks a list as a backlog (default `backlog`) |
| `MCP_APP_PLANKA_START_LABEL` | Name of the label that asks the assistant to start a card now (case-insensitive, default `START`) |
| `MCP_APP_PLANKA_WATCH_INTERVAL` | Poll seconds for the watcher (default 60, min 10) |

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
./register.sh --name planka-me --config ~/planka-me.env  # second identity (another user's API key)
./register.sh --files-dir ~/planka-files                 # attachment folder (default: <repo>/attachments; "none" = no folder)
./register.sh --dry-run                                  # show what would happen
```
```powershell
.\register.ps1                    # Windows-native Claude Code; uses Windows Node >= 20, else Node inside WSL
.\register.ps1 -ForceWsl -Distro Debian   # use WSL even if Windows Node exists; pick the distro
.\register.ps1 -DryRun
```
With WSL, the script finds Node by absolute path, including nvm installs that only load in interactive shells, and registers `wsl.exe -e <node> <repo>/dist/index.js`. It rebuilds only when `src/` is newer than `dist/`.

In container mode:
- `.env` is mounted read-only as `/app/.env` and never copied into the image (`.dockerignore`).
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
      "env": { "MCP_APP_PLANKA_CONFIG": "/abs/path/mcp-planka/.env" }
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
               "-v", "/abs/path/mcp-planka/.env:/app/.env:ro",
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
| OpenAI Codex CLI | `~/.codex/config.toml` | `[mcp_servers.planka]` with `command = "node"`, `args = [...]`, `env = { MCP_APP_PLANKA_CONFIG = "..." }` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` format as above |
| Any other client | its MCP settings | command, args and env as above |

Check that it works by asking the assistant to "call planka_whoami". To test the server without any assistant, use `npx @modelcontextprotocol/inspector node dist/index.js`.

**What doesn't carry over from Claude Code:**
- **Registration:** `register.sh` / `register.ps1` only register with Claude Code. Other clients need the config entry above.
- **Workflow rules:** they ship with the server as MCP instructions (see `MCP_APP_PLANKA_INSTRUCTIONS` above), so every client that supports server instructions gets them. For a client that ignores them, copy `src/instructions.ts`'s text into that client's rules file: `AGENTS.md` (Codex), `.cursor/rules`, `GEMINI.md`, `.github/copilot-instructions.md`, and so on.
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
| Browse | `planka_whoami`, `planka_list_projects`, `planka_get_board`, `planka_get_card`, `planka_search_cards` | Read-only. The output is compact JSON. Search and `get_board` can filter by labels, lists, closed state and due date, see [Searching and filtering](#searching-and-filtering) |
| Projects | `planka_find_project`, `planka_create_project`, `planka_update_project`, `planka_create_board` | Find matches names case-insensitively. Create **always** makes a **private** project with an **UPPERCASE** name (`mcp-planka` → `MCP-PLANKA`; there is no shared option; verified: other users, admins included, don't see it). The `MANAGERS` from the config become editors of its board automatically. `update_project` renames a project (also to UPPERCASE), changes or clears its description, and toggles the hide option. It also sets up a default board: Backlog / In Progress / Testing / Done. `create_board` has `addProjectManagers: true` to make the project's managers editors (by default only the creator is a member) |
| Lists | `planka_create_list`, `planka_update_list`, `planka_move_list` | `type`: `active` / `closed`. `move_list` moves a list and its cards to another board, also in another project (see below) |
| Cards | `planka_create_card`, `planka_update_card`, `planka_move_card`, `planka_delete_card` | To close a card, move it into a `closed` list. `update_card` sets or clears the cover image (`coverAttachmentId`) |
| Attachments | `planka_list_attachments`, `planka_add_attachment`, `planka_rename_attachment`, `planka_delete_attachment`, `planka_download_attachment` | See [Attachments](#attachments). `get_card` also lists a card's attachments |
| Comments | `planka_add_comment`, `planka_update_comment`, `planka_delete_comment` | |
| Tasks | `planka_create_task_list`, `planka_add_task`, `planka_update_task`, `planka_delete_task` | |
| Labels | `planka_create_label`, `planka_add_label_to_card`, `planka_remove_label_from_card` | 42 Planka color names |
| Updates | `planka_check_updates` | New Backlog cards, moved cards, ticked/unticked tasks, START labels and new human comments since the last check |
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

## Searching and filtering

`planka_search_cards` finds cards by text (`query`, in names and descriptions), labels, due date and closed state. Give at least one of them; any combination works:

| You want | Call |
|---|---|
| Cards labelled monitoring **or** todo | `{ labels: ["monitoring", "todo"] }` (`match: "any"` is the default) |
| Cards labelled monitoring **and** todo | `{ labels: ["monitoring", "todo"], match: "all" }` |
| Cards labelled monitoring that mention "disk" | `{ query: "disk", labels: ["monitoring"] }` |
| Cards due in a period | `{ dueFrom: "2026-11-20", dueTo: "2026-11-27" }` |
| Overdue and not done | `{ dueTo: "<now, ISO date-time>", dueCompleted: false, closed: false }` |
| Every closed card (incl. Done / Cancelled lists) | `{ closed: true }` |
| Full descriptions in the results | add `includeDescriptions: "full"` (`true` gives a short preview) |
| Only in one project / board | add `projectId` or `boardId` |

- **Matching:** label names ignore case, and an unnamed label matches by its color. Each result lists its labels and its board and list. Archive and trash lists are skipped unless `includeArchived: true`.
- **Typos show up:** `labelsNotFound` names requested labels that exist on none of the searched boards. For a project or board search, `missingLabels` also lists them per board.
- **Due dates:** bounds are inclusive. A plain date (`2026-11-20`) covers the whole day in UTC; a date-time (`2026-11-20T09:00:00+01:00`) is used as is. Any due filter leaves out cards without a due date. With a due filter, results are sorted by due date across all searched boards, so `limit` keeps the earliest ones. Results carry `due`, `dueDone` and `closed`.
- **Closed:** a card counts as closed when it is closed itself or sits in a list of type "closed" (e.g. Done).
- **`planka_get_board`** takes the same `labels` / `match` filter. It returns only matching cards, leaves out lists without any, and adds `labelFilter` with the number of matches. It also takes:
  - `lists`: only these lists, by name (ignoring case) or ID. A named archive/trash list is included too. `listFilter.missingLists` names entries that matched no list.
  - `closed: false`: leaves out closed cards and lists of type "closed", so a board read doesn't grow with Done/Cancelled. Empty open lists are kept, so their IDs stay available. `closed: true` returns only closed cards.
  - `includeDescriptions: "full"` for complete card descriptions (`true` gives a 160-character preview).

**Search only reads your own private projects.** The search only reads **private projects owned by the API-key user**. Some projects are never read, so their content can't leak into results:
- **Shared projects.**
- **Other people's private projects,** even where the bot is a board member.

A `projectId` or `boardId` outside your own private projects is refused. An account-wide search reports how many visible projects it left out (`excludedProjects`).

## Attachments

| Tool | What it does |
|---|---|
| `planka_list_attachments` | A card's files and links: name, URL, MIME type, size, image size, which one is the cover |
| `planka_add_attachment` | Exactly one source: `filePath` (a local file), `content` (base64, with `filename`) or `url` (a link attachment). `setAsCover: true` makes an uploaded image the card cover. Needs board **editor** rights |
| `planka_rename_attachment` | Change the display name |
| `planka_delete_attachment` | Delete the attachment and its file. Destructive, so it's worth adding to the client's "ask before" list (see below) |
| `planka_download_attachment` | With `savePath`: saves the file. A directory keeps the attachment's name, and existing files are only replaced with `overwrite: true`. Without `savePath`: text files up to 256 KB come back as text, and images up to 2 MB as an image the assistant can look at. Larger or binary files need `savePath` |

- **Where files can be:** the server reads and writes local files with its own process rights. Set `MCP_APP_PLANKA_FILES_DIR` to limit it to one folder; then paths outside it are refused, even through symlinks.
- **Downloads keep the API key at home:** the key is only sent to your Planka host. A URL pointing anywhere else is refused.
- **Docker / Podman mode:** the container can't see your files unless a folder is mounted. See [Attachments in Docker / Podman mode](#attachments-in-docker--podman-mode).
- **Claude Code permission:** add `"mcp__planka__planka_delete_attachment"` to `permissions.ask` in `~/.claude/settings.json` to be asked before each delete, like the other delete tools.

### Attachments in Docker / Podman mode

The server runs in a throwaway container (`docker run --rm`), so it only sees the container's own filesystem:

| Without a mounted folder | Works? |
|---|---|
| Inline downloads (text up to 256 KB, images up to 2 MB) | yes |
| Uploads from `content` (base64) and link attachments | yes |
| Uploads from `filePath` | no: host files aren't visible in the container |
| Downloads with `savePath` | no: the file is written inside the container and lost when it exits |

**Setup:** none needed. `./register.sh` uses `<repo>/attachments` and creates it with mode 700 if it's missing. To use another folder, pass `--files-dir DIR` or set `MCP_APP_PLANKA_FILES_DIR=` in `.env`. `--files-dir none` registers no folder.

`register.sh` turns the path into an absolute one and adds `-v <repo>/attachments:/files:rw -e MCP_APP_PLANKA_FILES_DIR=/files` to the `docker run` command (Podman: `rw,z` for SELinux).

**Paths:**
- **Relative paths start in the folder:** inside the container the folder is `/files`. `filePath: "report.pdf"` reads `<repo>/attachments/report.pdf`, and `savePath: "./"` saves into `attachments/`.
- **Everything else is refused:** absolute host paths such as `/home/you/x.pdf` and paths that leave the folder, including through symlinks.
- **Subfolders:** `savePath: "in/"` works once `attachments/in/` exists.

**Good to know:**
- **Ownership:** files the server saves belong to root, because the container runs as root. With rootless Podman they belong to your user.
- **Kept out of git:** `attachments/` is in `.gitignore`, so downloads are never committed, for example by a script that runs `git add -A`, and never mirrored.
- **Re-running is enough:** after a `git pull`, `./register.sh` picks the same folder again: `--files-dir`, else `MCP_APP_PLANKA_FILES_DIR` from the environment, else from `.env`, else `<repo>/attachments`.
- **Node mode:** the server uses your own filesystem, so no mount is needed. The folder only sets `MCP_APP_PLANKA_FILES_DIR` to limit file access to it.
- **Config permissions:** if `.env` is readable by others and belongs to you, `register.sh` changes it to mode 600, since it holds the API key.

## Notifications & two-way comments

**Start a card from Planka:** add a label named `START` to any card. With the built-in instructions, the assistant handles START cards first. It moves the card to In Progress, then removes the label and comments that work has started. The label is removed only after the move, so a request is never lost. At session start the assistant also looks for START cards on the board, which covers labels added while no session was running.

The tracker saves a snapshot of every board (each card's list, comment count and ticked tasks) and reports what changed since then:

- `backlog_card`: a card was created in a list matching `MCP_APP_PLANKA_BACKLOG_PATTERN`, or moved into one (then with `fromList` and `by`). Cards the API-key user created are ignored.
- `card_moved`: a card was moved to any other list, with `fromList`, `list` and `by`.
- `task`: a task (checkbox) was ticked (`completed: true`) or unticked (`completed: false`), with `by`. Tasks created already ticked don't count.
- `start_request`: a card carries the `START` label (`MCP_APP_PLANKA_START_LABEL`), with its `labelId`. This is reported once when the label appears, and also on a board's first check, because it's pending work, not old activity.
- `comment`: a new comment by **anyone except the API-key user**. The assistant's own replies therefore never trigger events.

Who moved a card or ticked a task comes from the card's action log (`GET /cards/:id/actions`), so the assistant's own moves and ticks are skipped too. If the log can't be read, the change is still reported, without `by`. After an upgrade, task changes are reported from the second check of a board on, because the first check records the current ticks.

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

Automatic checks don't start by themselves. The built-in instructions tell the assistant to end its session-start summary with a one-line reminder: `/loop 1m …` in Claude Code, or the watcher for 30-second checks. It skips the reminder once a loop or watcher is running. Set `MCP_APP_PLANKA_INSTRUCTIONS=off` or use your own instructions file to drop it.

> **Can't comment on a board?** Planka only lets *board members* comment. Project managers can administer a board without being a member of it. A board created through the API key also starts with the key's user as its only member. Fix it with `planka_sync_board_members` (preview first with `dryRun: true`, then apply with `dryRun: false`), or add members in the board header.

Planka's own webhooks need a public HTTPS endpoint. Polling works from a laptop behind NAT.

## MCP vs. raw API token

| Aspect | Raw API token | This MCP server |
|---|---|---|
| Reach | Every endpoint your role allows | 36 curated tools |
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
MCP_APP_PLANKA_TEST_BOARD_ID=<id> npm run test:int   # live lifecycle test; creates and deletes temp lists
npm run typecheck
```
