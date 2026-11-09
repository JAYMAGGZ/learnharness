/**
 * Obsidian vault setup and full rebuild (fork addition, 2026-11-09).
 *
 *   npm run obsidian:sync -- --vault "C:\Users\me\Documents\MyVault" --save
 *   npm run obsidian:sync                       (rebuild using saved config)
 *
 * Options:
 *   --vault <path>      Obsidian vault root (must already exist)
 *   --folder <name>     Managed folder inside the vault (default LearnHarness)
 *   --no-transcripts    Session notes without full transcripts
 *   --data-dir <path>   LearnHarness data folder (the one holding chats/ and
 *                       graph/). Default: the installed app's data folder if
 *                       it exists, otherwise ./data (the dev server's).
 *   --save              Write these settings to <data dir>/obsidian.json so the
 *                       running app keeps the vault in sync automatically.
 *   --off               Turn the automatic mirror off (keeps existing notes).
 *
 * The app mirrors automatically once obsidian.json exists; this script is
 * for first-time setup and for rebuilding from existing learning data.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function installedDataDir(): string {
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "LearnHarness", "data");
	if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "LearnHarness", "data");
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "LearnHarness", "data");
}

async function main(): Promise<void> {
	// Choose the data folder BEFORE config.ts is loaded — it reads LH_DATA_DIR once.
	const explicit = arg("data-dir");
	if (explicit) {
		process.env.LH_DATA_DIR = path.resolve(explicit);
	} else if (!process.env.LH_DATA_DIR && fs.existsSync(installedDataDir())) {
		process.env.LH_DATA_DIR = installedDataDir();
	}

	const { PATHS } = await import("../config.ts");
	const { OBSIDIAN_CONFIG_FILE, readObsidianConfig, syncObsidianVault } = await import("../src/store/obsidian-mirror.ts");
	const { normaliseFolder } = await import("../src/core/obsidian-notes.ts");
	console.log(`[obsidian] learning data: ${PATHS.data}`);

	if (flag("off")) {
		let saved: Record<string, unknown> = {};
		try {
			saved = JSON.parse(fs.readFileSync(OBSIDIAN_CONFIG_FILE, "utf-8")) as Record<string, unknown>;
		} catch {
			/* nothing saved */
		}
		fs.mkdirSync(path.dirname(OBSIDIAN_CONFIG_FILE), { recursive: true });
		fs.writeFileSync(OBSIDIAN_CONFIG_FILE, `${JSON.stringify({ ...saved, enabled: false }, null, "\t")}\n`);
		console.log("[obsidian] automatic mirror turned off. Existing notes were left in place.");
		return;
	}

	const vault = arg("vault");
	if (vault) {
		const resolved = path.resolve(vault);
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
			console.error(`[obsidian] vault folder not found: ${resolved}`);
			process.exitCode = 1;
			return;
		}
		if (!fs.existsSync(path.join(resolved, ".obsidian"))) {
			console.warn(`[obsidian] note: ${resolved} has no .obsidian folder. Is this the vault root? Continuing anyway.`);
		}
		const config = { vaultPath: resolved, folder: normaliseFolder(arg("folder")), transcripts: !flag("no-transcripts") };
		if (flag("save")) {
			fs.mkdirSync(path.dirname(OBSIDIAN_CONFIG_FILE), { recursive: true });
			fs.writeFileSync(OBSIDIAN_CONFIG_FILE, `${JSON.stringify({ ...config, enabled: true }, null, "\t")}\n`);
			console.log(`[obsidian] saved settings to ${OBSIDIAN_CONFIG_FILE}; the app will now keep the vault in sync`);
		}
		report(await syncObsidianVault(config));
		return;
	}

	const saved = readObsidianConfig();
	if (!saved) {
		console.error('[obsidian] no vault configured. Run with --vault "<path to your vault>" --save');
		process.exitCode = 1;
		return;
	}
	report(await syncObsidianVault(saved));
}

function report(result: Awaited<ReturnType<typeof import("../src/store/obsidian-mirror.ts").syncObsidianVault>>): void {
	if (!result) {
		console.log("[obsidian] mirror is off; nothing written");
		return;
	}
	console.log(`[obsidian] ${result.folder}: ${result.written} written, ${result.unchanged} unchanged, ${result.removed} removed`);
}

main().catch((err) => {
	console.error("[obsidian] sync failed:", err);
	process.exitCode = 1;
});
