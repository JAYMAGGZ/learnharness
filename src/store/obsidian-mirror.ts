/**
 * Obsidian mirror — the I/O half (fork addition, 2026-11-09). Reads the
 * graph ledgers, sources and chat records, renders them with
 * core/obsidian-notes.ts, and syncs the result into a managed folder of
 * the user's Obsidian vault.
 *
 * One-way and regenerated: the ledgers in data/graph stay the source of
 * truth; the vault folder is a view. Every write path in the graph and chat
 * stores calls scheduleObsidianSync(), which debounces and then rebuilds.
 *
 * Configuration (first match wins):
 *   1. env LH_OBSIDIAN_VAULT=<absolute vault path>  (+ optional
 *      LH_OBSIDIAN_FOLDER, LH_OBSIDIAN_TRANSCRIPTS=0)
 *   2. <data dir>/obsidian.json:
 *        { "vaultPath": "C:\\Users\\me\\Documents\\MyVault",
 *          "folder": "LearnHarness", "transcripts": true }
 * No configuration → the mirror is off and nothing is written.
 *
 * Safety: the vault root must already exist (it is never created); writes
 * stay inside <vault>/<folder>; deletions only remove .md files that carry
 * the lh_managed marker, so the user's own notes are never touched. Files
 * are only rewritten when their content changed, so Obsidian does not see
 * churn on every sync.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { MANAGED_MARKER, normaliseFolder, renderVault, type VaultSession } from "../core/obsidian-notes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export interface ObsidianConfig {
	vaultPath: string;
	folder: string;
	transcripts: boolean;
}

export const OBSIDIAN_CONFIG_FILE = path.join(PATHS.data, "obsidian.json");

let warnedMissingVault: string | null = null;

/** The effective configuration, or null when the mirror is off or the
 *  configured vault does not exist. */
export function readObsidianConfig(): ObsidianConfig | null {
	let vaultPath: string | undefined;
	let folder: string | undefined;
	let transcripts = true;

	const envVault = process.env.LH_OBSIDIAN_VAULT?.trim();
	if (envVault) {
		vaultPath = envVault;
		folder = process.env.LH_OBSIDIAN_FOLDER;
		transcripts = process.env.LH_OBSIDIAN_TRANSCRIPTS !== "0";
	} else {
		let raw: string;
		try {
			raw = fs.readFileSync(OBSIDIAN_CONFIG_FILE, "utf-8");
		} catch {
			return null; // no config file: the mirror is off
		}
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (typeof parsed.vaultPath === "string") vaultPath = parsed.vaultPath.trim();
			if (typeof parsed.folder === "string") folder = parsed.folder;
			if (parsed.transcripts === false) transcripts = false;
			if (parsed.enabled === false) return null;
		} catch (err) {
			console.warn(`[obsidian] ${OBSIDIAN_CONFIG_FILE} is not valid JSON; the mirror is off:`, err);
			return null;
		}
	}
	if (!vaultPath) return null;

	const resolved = path.resolve(vaultPath);
	let isDir = false;
	try {
		isDir = fs.statSync(resolved).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) {
		if (warnedMissingVault !== resolved) {
			console.warn(`[obsidian] vault folder ${resolved} does not exist; the mirror is off until it does`);
			warnedMissingVault = resolved;
		}
		return null;
	}
	return { vaultPath: resolved, folder: normaliseFolder(folder), transcripts };
}

export interface SyncResult {
	written: number;
	unchanged: number;
	removed: number;
	folder: string;
}

/** Rebuild the managed vault folder now. Returns null when the mirror is off. */
export async function syncObsidianVault(configOverride?: ObsidianConfig): Promise<SyncResult | null> {
	const config = configOverride ?? readObsidianConfig();
	if (!config) return null;

	// Lazy imports: the stores import this module for scheduling, so
	// loading them at module scope would be a cycle.
	const [{ graphStore }, { chatStore }, { getGraph }, { sessionMarkdown }] = await Promise.all([
		import("./graph.ts"),
		import("./chats.ts"),
		import("../core/graph.ts"),
		import("../core/session-markdown.ts"),
	]);

	const graph = getGraph(graphStore);
	const sessions: VaultSession[] = [];
	for (const summary of chatStore.listChats()) {
		const record = chatStore.getChat(summary.id);
		if (!record) continue;
		let transcript: string | undefined;
		if (config.transcripts) {
			try {
				transcript = sessionMarkdown(record.messages, { anchors: false });
			} catch (err) {
				console.warn(`[obsidian] could not render transcript for ${record.id}:`, err);
			}
		}
		sessions.push({
			id: record.id,
			title: record.title,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			kind: record.kind === "practice" ? "practice" : "teach",
			transcript,
		});
	}

	const files = renderVault(
		{ nodes: graph.nodes, chains: graph.chains, sessions, sources: graphStore.readSources(), vaultPath: config.vaultPath },
		{ folder: config.folder, transcripts: config.transcripts },
	);
	return writeVaultFiles(config.vaultPath, config.folder, files);
}

/** Write rendered files under <vault>/<folder> and remove stale managed
 *  notes. Exported for tests. */
export function writeVaultFiles(
	vaultPath: string,
	folder: string,
	files: ReadonlyArray<{ relPath: string; content: string }>,
): SyncResult {
	const root = path.resolve(vaultPath);
	const managedRoot = path.resolve(root, folder);
	if (!isInside(managedRoot, root)) throw new Error(`[obsidian] managed folder escapes the vault: ${folder}`);

	let written = 0;
	let unchanged = 0;
	const keep = new Set<string>();
	for (const file of files) {
		const abs = path.resolve(root, file.relPath);
		if (!isInside(abs, managedRoot)) continue; // belt and braces: never write outside the managed folder
		keep.add(abs.toLowerCase());
		let existing: string | null = null;
		try {
			existing = fs.readFileSync(abs, "utf-8");
		} catch {
			existing = null;
		}
		if (existing === file.content) {
			unchanged++;
			continue;
		}
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		writeFileAtomicSync(abs, file.content, { allowInPlaceFallback: true });
		written++;
	}

	let removed = 0;
	for (const abs of listMarkdown(managedRoot)) {
		if (keep.has(abs.toLowerCase())) continue;
		let head = "";
		try {
			head = fs.readFileSync(abs, "utf-8").slice(0, 200);
		} catch {
			continue;
		}
		if (!head.startsWith(`---\n${MANAGED_MARKER}`) && !head.startsWith(`---\r\n${MANAGED_MARKER}`)) continue; // the user's own note
		try {
			fs.unlinkSync(abs);
			removed++;
		} catch (err) {
			console.warn(`[obsidian] could not remove stale note ${abs}:`, err);
		}
	}
	return { written, unchanged, removed, folder: managedRoot };
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function listMarkdown(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listMarkdown(abs));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(abs);
	}
	return out;
}

// ─── debounced scheduling ───────────────────────────────────────────────────

const DEBOUNCE_MS = 1500;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;

/** Called by every graph/chat write path. Cheap when the mirror is off. */
export function scheduleObsidianSync(): void {
	if (process.env.NODE_ENV === "test" && process.env.LH_OBSIDIAN_IN_TESTS !== "1") return;
	if (!readObsidianConfig()) return;
	if (timer) clearTimeout(timer);
	timer = setTimeout(runScheduled, DEBOUNCE_MS);
	timer.unref?.();
}

function runScheduled(): void {
	timer = null;
	if (running) {
		again = true;
		return;
	}
	running = true;
	syncObsidianVault()
		.catch((err) => console.warn("[obsidian] vault sync failed:", err))
		.finally(() => {
			running = false;
			if (again) {
				again = false;
				scheduleObsidianSync();
			}
		});
}
