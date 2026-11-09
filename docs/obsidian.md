# Obsidian vault mirror (fork addition)

This fork of LearnHarness keeps everything upstream does — the same prober,
teacher and practice agents, prompts, background jobs, UI and data format — and
adds one thing: your knowledge graph and sessions are mirrored into an
Obsidian vault as linked notes, so Obsidian's graph view, search, backlinks and
your own notes all work on top of your learning record.

## What gets written

Inside a managed folder of your vault (default `LearnHarness/`):

| Note | Contents |
|---|---|
| `LearnHarness.md` | Index: counts, sessions newest first, imported files |
| `Propositions/<name>.md` | The statement, **Follows from** (the premises that jointly imply it, joined with `+`), **Leads to** (what it helps prove), other phrasings, and the sessions it came up in |
| `Sessions/<date> <title>.md` | Session type and dates, the propositions it produced, and the full transcript (your answers, confidence and thinking included) |
| `Imports/<file>.md` | Notes imported through **Extract files…**, with a link back to the original note when it lives in the same vault |

Reasoning chains become wikilinks between proposition notes, so Obsidian's graph
view draws the same structure as the in-app canvas.

## Rules that keep your vault safe

- **One-way.** The app's own files (`data/graph`, `data/chats`) stay the source of
  truth. The vault folder is rebuilt from them, so edits to generated notes are
  overwritten. Write your own notes anywhere and link *into* the generated ones.
- **Your notes are never deleted.** Only `.md` files whose frontmatter starts with
  `lh_managed: true` are ever removed, and only inside the managed folder.
- **Nothing is written outside `<vault>/<folder>`,** and the vault folder itself
  is never created — it must already exist.
- Files are only rewritten when their content changed.

## Turning it on

### Installed app (no Node needed)

Create `obsidian.json` in the app's data folder:

| OS | File |
|---|---|
| Windows | `%APPDATA%\LearnHarness\data\obsidian.json` |
| macOS | `~/Library/Application Support/LearnHarness/data/obsidian.json` |
| Linux | `~/.config/LearnHarness/data/obsidian.json` |

```json
{
	"vaultPath": "C:/Users/Jay/Documents/MyVault",
	"folder": "LearnHarness",
	"transcripts": true
}
```

Use forward slashes, or double every backslash (`C:\\Users\\...`). The mirror
starts on the next change the app saves (answering a question is enough), and
every sync is a full rebuild, so existing sessions and graph content appear too.

### Running from source

```bash
npm run obsidian:sync -- --vault "C:/Users/Jay/Documents/MyVault" --save
```

This writes `obsidian.json` for you and does a full rebuild immediately.
Without `--save` it rebuilds once without turning on automatic syncing.

| Option | Meaning |
|---|---|
| `--vault <path>` | Vault root |
| `--folder <name>` | Managed folder (default `LearnHarness`) |
| `--no-transcripts` | Session notes without the full transcript |
| `--data-dir <path>` | Learning data folder (default: the installed app's, if present, else `./data`) |
| `--off` | Stop automatic syncing; existing notes stay |

Environment variables `LH_OBSIDIAN_VAULT`, `LH_OBSIDIAN_FOLDER` and
`LH_OBSIDIAN_TRANSCRIPTS=0` override the file.

## Going the other way: Obsidian notes into the graph

That already exists upstream: in the graph view, use **Extract files… → Folder**
and pick a folder of your vault. Each note is run through the extraction
pipeline, and its propositions then appear in the mirror under `Imports/`, with a
link back to the original note.

## Implementation

| File | Role |
|---|---|
| `src/core/obsidian-notes.ts` | Pure renderer: graph + sessions → note files |
| `src/store/obsidian-mirror.ts` | Config, debounced sync, safe writer |
| `src/store/graph.ts`, `src/store/chats.ts` | One `scheduleObsidianSync()` call on each write path |
| `scripts/obsidian-sync.ts` | Setup and full rebuild command |
| `tests/obsidian-mirror.test.ts` | Renderer and writer tests |

`electron-builder.yml` also points the auto-updater at this fork's releases, so
an update can never silently replace the fork with the upstream app.

Licence: AGPL-3.0, same as upstream. If you distribute this fork or run it as a
service for others, you must publish its source.
