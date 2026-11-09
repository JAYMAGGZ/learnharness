/**
 * Obsidian vault rendering — the PURE half of the Obsidian mirror
 * (fork addition, 2026-11-09). Graph + sessions in, a list of markdown
 * files out. No fs, no config: src/store/obsidian-mirror.ts does the I/O.
 *
 * The ledgers stay the source of truth. The vault folder is a one-way,
 * regenerated VIEW of them, laid out so Obsidian's graph view draws the
 * same structure the in-app canvas does:
 *
 *   <folder>/LearnHarness.md          index: counts, sessions, imports
 *   <folder>/Propositions/<name>.md   one note per proposition
 *   <folder>/Sessions/<title>.md      one note per teach/practice session
 *   <folder>/Imports/<file>.md        one note per imported notes file
 *
 * Reasoning chains are not separate notes (they would clutter the graph
 * with implication nodes). Instead each proposition lists the chains that
 * conclude it ("Follows from", co-premises joined with +) and the chains it
 * feeds ("Leads to"), so every premise → conclusion relation is a wikilink.
 *
 * Every generated note carries `lh_managed: true` in its frontmatter. The
 * writer only ever deletes files that carry that marker, so the user's own
 * notes in the same folder are never touched.
 */

import type { GraphChain, GraphNode, NotesSource } from "./contracts.ts";

export const MANAGED_MARKER = "lh_managed: true";

export interface VaultSession {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	kind: "teach" | "practice";
	/** Rendered transcript (core/session-markdown.ts), when transcripts are on. */
	transcript?: string;
}

export interface VaultInput {
	nodes: ReadonlyArray<GraphNode>;
	chains: ReadonlyArray<GraphChain>;
	sessions: ReadonlyArray<VaultSession>;
	sources: ReadonlyArray<NotesSource>;
	/** Absolute vault root, used to link imports that already live in the vault. */
	vaultPath?: string;
}

export interface VaultOptions {
	/** Managed folder inside the vault (posix-style, relative). */
	folder: string;
	/** Include full session transcripts in session notes. */
	transcripts: boolean;
}

export interface VaultFile {
	/** Path relative to the vault root, posix separators. */
	relPath: string;
	content: string;
}

// ─── file names ─────────────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A file-system and wikilink safe note name. Obsidian links break on
 *  # ^ [ ] | and Windows refuses \ / : * ? " < >, so those become spaces. */
export function safeNoteName(raw: string, fallback: string): string {
	let name = raw
		.replace(/[\\/:*?"<>|#^[\]{}]/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	if (name.length > 80) name = name.slice(0, 80).replace(/[.\s]+$/, "");
	if (name.length === 0) name = fallback;
	if (WINDOWS_RESERVED.test(name)) name = `${name} note`;
	return name;
}

/** Assign unique names (case-insensitive, since Windows and macOS file
 *  systems are). Items are processed in the given order; the first claimant
 *  of a name keeps it, later ones get a short id suffix. Deterministic for
 *  a deterministic order. */
function uniqueNames<T>(items: ReadonlyArray<T>, idOf: (t: T) => string, nameOf: (t: T) => string): Map<string, string> {
	const taken = new Set<string>();
	const out = new Map<string, string>();
	for (const item of items) {
		const id = idOf(item);
		const base = safeNoteName(nameOf(item), id);
		let name = base;
		if (taken.has(name.toLowerCase())) name = `${base} (${id.slice(-6)})`;
		let n = 2;
		while (taken.has(name.toLowerCase())) name = `${base} (${id.slice(-6)}-${n++})`;
		taken.add(name.toLowerCase());
		out.set(id, name);
	}
	return out;
}

const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T): number =>
	a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// ─── small markdown helpers ─────────────────────────────────────────────────

/** JSON strings are valid YAML double-quoted scalars. */
const yamlString = (s: string): string => JSON.stringify(s);

function frontmatter(fields: Array<[string, string | string[] | number]>): string {
	const lines = ["---", MANAGED_MARKER];
	for (const [key, value] of fields) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				for (const v of value) lines.push(`  - ${yamlString(v)}`);
			}
		} else if (typeof value === "number") {
			lines.push(`${key}: ${value}`);
		} else {
			lines.push(`${key}: ${yamlString(value)}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

/** Text placed in a wikilink alias or a list line must not break the link. */
const linkLabel = (s: string): string => s.replace(/[[\]|\n\r]/g, " ").replace(/\s+/g, " ").trim();

const day = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso);

function posix(...parts: string[]): string {
	return parts
		.flatMap((p) => p.split(/[\\/]+/))
		.filter((p) => p.length > 0)
		.join("/");
}

/** Normalise a managed-folder setting: relative, no traversal. */
export function normaliseFolder(folder: string | undefined): string {
	const parts = (folder ?? "")
		.split(/[\\/]+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p !== "." && p !== "..");
	return parts.length > 0 ? parts.map((p) => safeNoteName(p, "LearnHarness")).join("/") : "LearnHarness";
}

// ─── rendering ──────────────────────────────────────────────────────────────

export function renderVault(input: VaultInput, opts: VaultOptions): VaultFile[] {
	const folder = normaliseFolder(opts.folder);
	const propDir = posix(folder, "Propositions");
	const sessDir = posix(folder, "Sessions");
	const srcDir = posix(folder, "Imports");

	const nodes = [...input.nodes].sort(byCreated);
	const sessions = [...input.sessions].sort(byCreated);
	const sources = [...input.sources].sort((a, b) =>
		a.importedAt < b.importedAt ? -1 : a.importedAt > b.importedAt ? 1 : a.id < b.id ? -1 : 1,
	);

	const nodeName = uniqueNames(nodes, (n) => n.id, (n) => n.name);
	const sessionName = uniqueNames(
		sessions,
		(s) => s.id,
		(s) => `${day(s.createdAt)} ${s.title}`,
	);
	const sourceName = uniqueNames(
		sources,
		(s) => s.id,
		(s) => {
			const base = s.filePath.split(/[\\/]/).pop() ?? s.id;
			return base.replace(/\.[^.]+$/, "");
		},
	);

	const nodeById = new Map(nodes.map((n) => [n.id, n]));
	const sessionById = new Map(sessions.map((s) => [s.id, s]));
	const sourceById = new Map(sources.map((s) => [s.id, s]));

	const nodeLink = (id: string): string | null => {
		const node = nodeById.get(id);
		const name = nodeName.get(id);
		if (!node || !name) return null;
		return `[[${propDir}/${name}|${linkLabel(node.name)}]]`;
	};
	const sessionLink = (id: string): string | null => {
		const s = sessionById.get(id);
		const name = sessionName.get(id);
		return s && name ? `[[${sessDir}/${name}|${linkLabel(s.title)}]]` : null;
	};
	const sourceLink = (id: string): string | null => {
		const name = sourceName.get(id);
		return name ? `[[${srcDir}/${name}|${linkLabel(name)}]]` : null;
	};

	// Live chains only: every member must be a live proposition.
	const chains = input.chains.filter(
		(c) => nodeById.has(c.conclusion) && c.premises.length > 0 && c.premises.every((p) => nodeById.has(p)),
	);
	const concluding = new Map<string, GraphChain[]>();
	const feeding = new Map<string, GraphChain[]>();
	for (const chain of chains) {
		(concluding.get(chain.conclusion) ?? concluding.set(chain.conclusion, []).get(chain.conclusion)!).push(chain);
		for (const p of new Set(chain.premises)) (feeding.get(p) ?? feeding.set(p, []).get(p)!).push(chain);
	}

	// Which propositions each session / source produced (provenance is
	// chat-level or src-level; both share the chatId field).
	const fromOrigin = new Map<string, string[]>();
	for (const node of nodes) {
		for (const origin of new Set(node.provenance.map((p) => p.chatId))) {
			(fromOrigin.get(origin) ?? fromOrigin.set(origin, []).get(origin)!).push(node.id);
		}
	}

	const files: VaultFile[] = [];

	// ── propositions ──
	for (const node of nodes) {
		const origins = [...new Set(node.provenance.map((p) => p.chatId))];
		const originLinks = origins
			.map((o) => sessionLink(o) ?? sourceLink(o))
			.filter((l): l is string => l !== null);

		const followsFrom = (concluding.get(node.id) ?? []).map((c) => {
			const premises = c.premises.map((p) => nodeLink(p)).filter((l): l is string => l !== null);
			return `- ${premises.join(" + ")}`;
		});
		const leadsTo = (feeding.get(node.id) ?? []).map((c) => {
			const target = nodeLink(c.conclusion) ?? "";
			const others = c.premises.filter((p) => p !== node.id).map((p) => nodeLink(p)).filter((l): l is string => l !== null);
			return others.length > 0 ? `- ${target} (together with ${others.join(", ")})` : `- ${target}`;
		});

		const body: string[] = [
			frontmatter([
				["lh_id", node.id],
				["type", "proposition"],
				["created", node.createdAt],
				["tags", ["learnharness/proposition"]],
			]),
			"",
			`# ${node.name}`,
			"",
			`> ${node.statement.replace(/\n+/g, " ")}`,
		];
		if (followsFrom.length > 0) body.push("", "## Follows from", "", ...followsFrom);
		if (leadsTo.length > 0) body.push("", "## Leads to", "", ...leadsTo);
		const phrasings = node.aliases.filter((a) => a.trim().length > 0 && a !== node.statement);
		if (phrasings.length > 0) body.push("", "## Other phrasings", "", ...phrasings.map((a) => `- ${a.replace(/\n+/g, " ")}`));
		if (originLinks.length > 0) body.push("", "## Came up in", "", ...originLinks.map((l) => `- ${l}`));

		files.push({ relPath: `${propDir}/${nodeName.get(node.id)}.md`, content: `${body.join("\n")}\n` });
	}

	// ── sessions ──
	for (const s of sessions) {
		const produced = (fromOrigin.get(s.id) ?? []).map((id) => nodeLink(id)).filter((l): l is string => l !== null);
		const body: string[] = [
			frontmatter([
				["lh_id", s.id],
				["type", s.kind === "practice" ? "practice-session" : "teaching-session"],
				["created", s.createdAt],
				["updated", s.updatedAt],
				["propositions", produced.length],
				["tags", [`learnharness/${s.kind === "practice" ? "practice" : "teaching"}`]],
			]),
			"",
			`# ${s.title}`,
			"",
			`${s.kind === "practice" ? "Practice" : "Teaching"} session started ${day(s.createdAt)}, last active ${day(s.updatedAt)}.`,
		];
		if (produced.length > 0) body.push("", "## Propositions from this session", "", ...produced.map((l) => `- ${l}`));
		if (opts.transcripts && s.transcript && s.transcript.trim().length > 0) {
			// Demote transcript headings below this note's own H1/H2.
			const transcript = s.transcript.replace(/^(#{1,4}) /gm, (_m, hashes: string) => `${"#".repeat(Math.min(hashes.length + 2, 6))} `);
			body.push("", "## Transcript", "", transcript);
		}
		files.push({ relPath: `${sessDir}/${sessionName.get(s.id)}.md`, content: `${body.join("\n")}\n` });
	}

	// ── imported notes ──
	const vaultRoot = input.vaultPath?.replace(/[\\/]+$/, "");
	for (const src of sources) {
		const produced = (fromOrigin.get(src.id) ?? []).map((id) => nodeLink(id)).filter((l): l is string => l !== null);
		const body: string[] = [
			frontmatter([
				["lh_id", src.id],
				["type", "imported-notes"],
				["imported", src.importedAt],
				["file", src.filePath],
				["tags", ["learnharness/import"]],
			]),
			"",
			`# ${sourceName.get(src.id)}`,
			"",
			`Imported ${day(src.importedAt)} from \`${src.filePath}\`.`,
		];
		// If the imported file is itself a note in this vault, link to it.
		if (vaultRoot) {
			const normFile = src.filePath.replace(/\\/g, "/");
			const normRoot = vaultRoot.replace(/\\/g, "/");
			if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`) && /\.md$/i.test(normFile)) {
				const rel = normFile.slice(normRoot.length + 1).replace(/\.md$/i, "");
				body.push("", `Original note: [[${rel}]]`);
			}
		}
		if (produced.length > 0) body.push("", "## Propositions extracted", "", ...produced.map((l) => `- ${l}`));
		files.push({ relPath: `${srcDir}/${sourceName.get(src.id)}.md`, content: `${body.join("\n")}\n` });
	}

	// ── index ──
	const index: string[] = [
		frontmatter([
			["type", "index"],
			["propositions", nodes.length],
			["chains", chains.length],
			["sessions", sessions.length],
			["tags", ["learnharness"]],
		]),
		"",
		"# LearnHarness",
		"",
		"This folder is generated from your LearnHarness learning record. Notes here are rebuilt automatically, so edits to them are overwritten. Write your own notes elsewhere and link into these.",
		"",
		`- ${nodes.length} propositions`,
		`- ${chains.length} reasoning chains`,
		`- ${sessions.length} sessions`,
		`- ${sources.length} imported files`,
	];
	const recent = [...sessions].reverse();
	if (recent.length > 0) {
		index.push("", "## Sessions", "", ...recent.map((s) => `- ${day(s.createdAt)} ${sessionLink(s.id)}${s.kind === "practice" ? " (practice)" : ""}`));
	}
	if (sources.length > 0) {
		index.push("", "## Imported notes", "", ...sources.map((s) => `- ${sourceLink(s.id)}`));
	}
	files.push({ relPath: `${folder}/LearnHarness.md`, content: `${index.join("\n")}\n` });

	return files;
}
