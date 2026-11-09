/**
 * Obsidian mirror (fork addition): the pure renderer and the vault writer.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, NotesSource } from "../src/core/contracts.ts";
import { MANAGED_MARKER, normaliseFolder, renderVault, safeNoteName } from "../src/core/obsidian-notes.ts";
import { writeVaultFiles } from "../src/store/obsidian-mirror.ts";

const node = (id: string, name: string, statement: string, chatId = "chat_a", createdAt = "2026-11-01T10:00:00.000Z"): GraphNode => ({
	id,
	name,
	statement,
	aliases: [],
	createdAt,
	provenance: [{ chatId, messageId: "m1" }],
});

const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [{ chatId: "chat_a", messageId: "m2" }],
	createdAt: "2026-11-01T10:05:00.000Z",
});

const sessions = [
	{ id: "chat_a", title: "AWS VPC basics", createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z", kind: "teach" as const, transcript: "## Teacher\n\nWhat does /24 mean?" },
	{ id: "chat_b", title: "Subnet practice", createdAt: "2026-11-02T09:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z", kind: "practice" as const },
];

const fileOf = (files: ReturnType<typeof renderVault>, rel: string): string => {
	const f = files.find((x) => x.relPath === rel);
	assert.ok(f, `expected ${rel} in ${files.map((x) => x.relPath).join(", ")}`);
	return f.content;
};

describe("safeNoteName", () => {
	it("strips characters Obsidian links and Windows file names reject", () => {
		assert.equal(safeNoteName('CIDR: a/b "test" #1 [x]|y', "id"), "CIDR a b test 1 x y");
	});
	it("falls back to the id for empty names and avoids reserved Windows names", () => {
		assert.equal(safeNoteName("  ...  ", "n_123"), "n_123");
		assert.equal(safeNoteName("CON", "id"), "CON note");
	});
	it("caps long names", () => {
		assert.ok(safeNoteName("x".repeat(200), "id").length <= 80);
	});
});

describe("normaliseFolder", () => {
	it("keeps the folder inside the vault", () => {
		assert.equal(normaliseFolder(undefined), "LearnHarness");
		assert.equal(normaliseFolder("../../etc"), "etc");
		assert.equal(normaliseFolder("Study\\Learning"), "Study/Learning");
	});
});

describe("renderVault", () => {
	const nodes = [
		node("n_aaaaaa1", "/24 block", "A /24 CIDR block contains 256 addresses."),
		node("n_bbbbbb2", "AWS reserves 5", "AWS reserves 5 addresses in every subnet."),
		node("n_cccccc3", "251 usable", "A /24 AWS subnet has 251 usable addresses."),
	];
	const chains = [chain("arg_1", ["n_aaaaaa1", "n_bbbbbb2"], "n_cccccc3")];
	const files = renderVault({ nodes, chains, sessions, sources: [] }, { folder: "LearnHarness", transcripts: true });

	it("writes one note per proposition and session, plus an index", () => {
		assert.equal(files.length, 3 + 2 + 1);
		for (const f of files) assert.ok(f.content.startsWith(`---\n${MANAGED_MARKER}\n`), f.relPath);
	});

	it("links joint premises to their conclusion both ways", () => {
		const conclusion = fileOf(files, "LearnHarness/Propositions/251 usable.md");
		assert.match(conclusion, /## Follows from\n\n- \[\[LearnHarness\/Propositions\/24 block\|\/24 block\]\] \+ \[\[LearnHarness\/Propositions\/AWS reserves 5\|AWS reserves 5\]\]/);
		const premise = fileOf(files, "LearnHarness/Propositions/AWS reserves 5.md");
		assert.match(premise, /## Leads to\n\n- \[\[LearnHarness\/Propositions\/251 usable\|251 usable\]\] \(together with \[\[LearnHarness\/Propositions\/24 block/);
	});

	it("links propositions to the session they came from and back", () => {
		const prop = fileOf(files, "LearnHarness/Propositions/24 block.md");
		assert.match(prop, /## Came up in\n\n- \[\[LearnHarness\/Sessions\/2026-11-01 AWS VPC basics\|AWS VPC basics\]\]/);
		const session = fileOf(files, "LearnHarness/Sessions/2026-11-01 AWS VPC basics.md");
		assert.match(session, /propositions: 3/);
		assert.match(session, /## Propositions from this session/);
		assert.match(session, /## Transcript\n\n#### Teacher/); // transcript headings demoted
		assert.match(fileOf(files, "LearnHarness/Sessions/2026-11-02 Subnet practice.md"), /type: "practice-session"/);
	});

	it("omits transcripts when turned off", () => {
		const off = renderVault({ nodes, chains, sessions, sources: [] }, { folder: "LearnHarness", transcripts: false });
		assert.doesNotMatch(fileOf(off, "LearnHarness/Sessions/2026-11-01 AWS VPC basics.md"), /## Transcript/);
	});

	it("gives colliding names (case-insensitive) a stable id suffix", () => {
		const dup = renderVault(
			{ nodes: [node("n_first01", "Subnet", "s1"), node("n_second2", "subnet", "s2", "chat_a", "2026-11-01T10:01:00.000Z")], chains: [], sessions: [], sources: [] },
			{ folder: "LH", transcripts: false },
		);
		const names = dup.map((f) => f.relPath).sort();
		assert.deepEqual(names, ["LH/LearnHarness.md", "LH/Propositions/Subnet.md", "LH/Propositions/subnet (econd2).md"]);
	});

	it("drops chains that reference a missing proposition", () => {
		const out = renderVault({ nodes: [nodes[0]!], chains, sessions: [], sources: [] }, { folder: "LH", transcripts: false });
		assert.doesNotMatch(fileOf(out, "LH/Propositions/24 block.md"), /Leads to/);
	});

	it("links imported notes, including back to an original note inside the vault", () => {
		const source: NotesSource = { id: "src_1", filePath: "C:\\Vault\\AWS\\VPC notes.md", importedAt: "2026-11-03T08:00:00.000Z" };
		const out = renderVault(
			{ nodes: [node("n_imp0001", "IGW", "An internet gateway connects a VPC to the internet.", "src_1")], chains: [], sessions: [], sources: [source], vaultPath: "C:\\Vault" },
			{ folder: "LearnHarness", transcripts: false },
		);
		const note = fileOf(out, "LearnHarness/Imports/VPC notes.md");
		assert.match(note, /Original note: \[\[AWS\/VPC notes\]\]/);
		assert.match(fileOf(out, "LearnHarness/Propositions/IGW.md"), /\[\[LearnHarness\/Imports\/VPC notes\|VPC notes\]\]/);
	});
});

describe("writeVaultFiles", () => {
	const managed = (body: string): string => `---\n${MANAGED_MARKER}\n---\n${body}\n`;

	it("writes, skips unchanged files, removes stale managed notes and keeps the user's own notes", () => {
		const vault = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-"));
		try {
			const first = writeVaultFiles(vault, "LearnHarness", [
				{ relPath: "LearnHarness/Propositions/A.md", content: managed("a") },
				{ relPath: "LearnHarness/Propositions/B.md", content: managed("b") },
			]);
			assert.deepEqual([first.written, first.unchanged, first.removed], [2, 0, 0]);

			// The user adds their own note inside the managed folder.
			fs.writeFileSync(path.join(vault, "LearnHarness", "Propositions", "My thoughts.md"), "# mine\n");

			const second = writeVaultFiles(vault, "LearnHarness", [{ relPath: "LearnHarness/Propositions/A.md", content: managed("a") }]);
			assert.deepEqual([second.written, second.unchanged, second.removed], [0, 1, 1]);
			assert.ok(!fs.existsSync(path.join(vault, "LearnHarness", "Propositions", "B.md")));
			assert.ok(fs.existsSync(path.join(vault, "LearnHarness", "Propositions", "My thoughts.md")));
		} finally {
			fs.rmSync(vault, { recursive: true, force: true });
		}
	});

	it("never writes outside the managed folder", () => {
		const vault = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-"));
		try {
			const result = writeVaultFiles(vault, "LearnHarness", [{ relPath: "../escape.md", content: managed("x") }, { relPath: "Other/x.md", content: managed("x") }]);
			assert.equal(result.written, 0);
			assert.ok(!fs.existsSync(path.join(vault, "Other")));
			assert.throws(() => writeVaultFiles(vault, "../outside", []));
		} finally {
			fs.rmSync(vault, { recursive: true, force: true });
		}
	});
});
