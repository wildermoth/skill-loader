import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@mariozechner/pi-coding-agent";

import skillLoaderExtension, {
	colorizeEditorLines,
	colorizeLine,
	fuzzyMatch,
	fuzzyScore,
	isPickerInput,
	isSkillOnlyMessage,
	resolveSkill,
	rewriteSkillCompletion,
	stripFrontmatter,
} from "./index";

describe("isPickerInput", () => {
	test("bare hash opens the picker", () => {
		expect(isPickerInput("#")).toBe(true);
	});

	test("bare hash with surrounding whitespace opens the picker", () => {
		expect(isPickerInput("  #  ")).toBe(true);
	});

	test("hash with text is not picker input", () => {
		expect(isPickerInput("#caveman")).toBe(false);
	});
});

describe("isSkillOnlyMessage", () => {
	test("single marker is skill-only", () => {
		expect(isSkillOnlyMessage("{$caveman}")).toBe(true);
	});

	test("space-separated markers are skill-only", () => {
		expect(isSkillOnlyMessage("{$a} {$b}")).toBe(true);
	});

	test("comma-separated markers are skill-only", () => {
		expect(isSkillOnlyMessage("{$a}, {$b}")).toBe(true);
	});

	test("marker plus message is not skill-only", () => {
		expect(isSkillOnlyMessage("{$caveman} help me")).toBe(false);
	});

	test("plain hash words are not skill markers", () => {
		expect(isSkillOnlyMessage("#caveman")).toBe(false);
	});

	test("plain message is not skill-only", () => {
		expect(isSkillOnlyMessage("help me")).toBe(false);
	});

	test("shell-style interpolation is not a marker", () => {
		expect(isSkillOnlyMessage("${caveman}")).toBe(false);
	});
});

describe("rewriteSkillCompletion", () => {
	test("applied completion is wrapped in marker braces", () => {
		const result = rewriteSkillCompletion(
			{ lines: ["review #caveman"], cursorLine: 0, cursorCol: 15 },
			"#caveman",
			"caveman",
		);
		expect(result).toEqual({
			lines: ["review {$caveman}"],
			cursorLine: 0,
			cursorCol: 17,
		});
	});

	test("text after the cursor is preserved", () => {
		const result = rewriteSkillCompletion(
			{ lines: ["#caveman please"], cursorLine: 0, cursorCol: 8 },
			"#caveman",
			"caveman",
		);
		expect(result).toEqual({
			lines: ["{$caveman} please"],
			cursorLine: 0,
			cursorCol: 10,
		});
	});

	test("other lines are untouched", () => {
		const result = rewriteSkillCompletion(
			{
				lines: ["first", "review #caveman"],
				cursorLine: 1,
				cursorCol: 15,
			},
			"#caveman",
			"caveman",
		);
		expect(result.lines).toEqual(["first", "review {$caveman}"]);
	});

	test("result without the value is returned unchanged", () => {
		const input = {
			lines: ["review something else"],
			cursorLine: 0,
			cursorCol: 20,
		};
		expect(rewriteSkillCompletion(input, "#caveman", "caveman")).toBe(
			input,
		);
	});
});

describe("resolveSkill", () => {
	const known = new Map([
		["caveman", { name: "caveman", description: "", path: "/x" }],
		["gweb-conventions", { name: "gweb-conventions", description: "", path: "/y" }],
	]);

	test("exact names resolve", () => {
		expect(resolveSkill(["caveman"], known).known).toEqual(["caveman"]);
	});

	test("names resolve case-insensitively", () => {
		expect(resolveSkill(["Caveman"], known).known).toEqual(["caveman"]);
	});

	test("duplicates resolve once", () => {
		expect(resolveSkill(["caveman", "caveman"], known).known).toEqual([
			"caveman",
		]);
	});

	test("unknown names are reported separately", () => {
		expect(resolveSkill(["caveman", "nope"], known)).toEqual({
			known: ["caveman"],
			unknown: ["nope"],
		});
	});
});

describe("colorizeLine", () => {
	const START = "\x1b[36m";
	const END = "\x1b[39m";
	const armed = (t: string) => t === "caveman";

	test("marker token is wrapped in color", () => {
		expect(
			colorizeLine("review {$caveman} please", START, END, armed),
		).toBe(`review ${START}{$caveman}${END} please`);
	});

	test("rejected token is untouched", () => {
		expect(colorizeLine("review {$style} please", START, END, armed)).toBe(
			"review {$style} please",
		);
	});

	test("plain hash word is not a marker", () => {
		expect(
			colorizeLine("review #caveman please", START, END, () => true),
		).toBe("review #caveman please");
	});

	test("line without tokens is returned as-is", () => {
		expect(colorizeLine("just text", START, END, armed)).toBe("just text");
	});

	test("multiple tokens are each colored", () => {
		expect(
			colorizeLine("{$caveman} and {$caveman}", START, END, armed),
		).toBe(`${START}{$caveman}${END} and ${START}{$caveman}${END}`);
	});

	test("cursor styling inside a token keeps color on both sides", () => {
		const line = "review {$cav\x1b[7me\x1b[0mman} please";
		expect(colorizeLine(line, START, END, armed)).toBe(
			`review ${START}{$cav\x1b[7m${START}e\x1b[0m${START}man}${END} please`,
		);
	});

	test("hardware cursor marker passes through untouched", () => {
		const line = "review {$caveman}\x1b_pi:c\x07 please";
		expect(colorizeLine(line, START, END, armed)).toBe(
			`review ${START}{$caveman}\x1b_pi:c\x07${END} please`,
		);
	});

	test("end-of-line cursor after a token keeps reverse video", () => {
		const line = "  {$caveman}\x1b_pi:c\x07\x1b[7m \x1b[0m   ";
		expect(colorizeLine(line, START, END, armed)).toBe(
			`  ${START}{$caveman}\x1b_pi:c\x07\x1b[7m${END} \x1b[0m   `,
		);
	});
});

describe("colorizeEditorLines", () => {
	const START = "\x1b[36m";
	const END = "\x1b[39m";
	const armed = (t: string) => t === "caveman";

	test("only content lines between the borders are colored", () => {
		const lines = [
			"\x1b[90m─────\x1b[0m",
			"  review {$caveman}  ",
			"\x1b[90m─────\x1b[0m",
			"  {$caveman} suggestion  ",
		];
		expect(colorizeEditorLines(lines, START, END, armed)).toEqual([
			"\x1b[90m─────\x1b[0m",
			`  review ${START}{$caveman}${END}  `,
			"\x1b[90m─────\x1b[0m",
			"  {$caveman} suggestion  ",
		]);
	});

	test("scroll indicator bottom border is detected", () => {
		const lines = ["─────", "  {$caveman}  ", "─── ↓ 2 more ──"];
		expect(colorizeEditorLines(lines, START, END, armed)).toEqual([
			"─────",
			`  ${START}{$caveman}${END}  `,
			"─── ↓ 2 more ──",
		]);
	});

	test("missing bottom border returns lines unchanged", () => {
		const lines = ["─────", "  {$caveman}  "];
		expect(colorizeEditorLines(lines, START, END, armed)).toBe(lines);
	});
});

describe("fuzzyMatch", () => {
	test("matching chars in order match", () => {
		expect(fuzzyMatch("cave", "caveman")).toBe(true);
	});

	test("matching is case-insensitive", () => {
		expect(fuzzyMatch("CAVE", "caveman")).toBe(true);
	});

	test("out-of-order chars do not match", () => {
		expect(fuzzyMatch("evac", "caveman")).toBe(false);
	});

	test("empty query matches everything", () => {
		expect(fuzzyMatch("", "caveman")).toBe(true);
	});
});

describe("fuzzyScore", () => {
	test("consecutive matches outscore scattered ones", () => {
		expect(fuzzyScore("ab", "ab-cd")).toBeGreaterThan(
			fuzzyScore("ab", "a-cb"),
		);
	});

	test("non-match scores negative", () => {
		expect(fuzzyScore("xyz", "caveman")).toBe(-1);
	});
});

describe("stripFrontmatter", () => {
	test("yaml frontmatter is removed", () => {
		const content = "---\nname: caveman\ndescription: x\n---\n# Body\n";
		expect(stripFrontmatter(content)).toBe("# Body\n");
	});

	test("content without frontmatter is untouched", () => {
		expect(stripFrontmatter("# Body\n")).toBe("# Body\n");
	});

	test("crlf frontmatter is removed", () => {
		const content = "---\r\nname: x\r\n---\r\n# Body\n";
		expect(stripFrontmatter(content)).toBe("# Body\n");
	});
});

// The fixture implements only the host services exercised by this extension.
type StoredState = {
	type: "custom";
	customType: string;
	data: { loadedSkills: string[]; version?: number };
};
type HostHandler = (event: InputEvent | { type: string }, ctx: ExtensionContext) => unknown;

async function createHost() {
	const directory = await mkdtemp(join(tmpdir(), "skill-loader-test-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "SKILL.md");
	await writeFile(path, "---\nname: example\n---\n# Example\nRead references/guide.md.\n");
	let branch: StoredState[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const messages: Array<{ message: { content: string }; options: { triggerTurn?: boolean } }> = [];
	const handlers = new Map<string, HostHandler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const context = {
		hasUI: false,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			addAutocompleteProvider: () => {},
			getEditorComponent: () => ({}),
			select: async (_title: string, options: string[]) => options[0],
		},
	};
	const api = {
		on: (event: string, handler: HostHandler) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
		getCommands: () => [{ name: "skill:example", source: "skill", description: "Example skill", sourceInfo: { path } }],
		appendEntry: (customType: string, data: StoredState["data"]) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message: { content: string }, options: { triggerTurn?: boolean }) => messages.push({ message, options }),
	};
	function register() {
		skillLoaderExtension(api as unknown as ExtensionAPI);
	}
	async function emit(type: string, text = "", source: InputEvent["source"] = "interactive") {
		const handler = handlers.get(type);
		if (!handler) throw new Error(`No handler registered for ${type}`);
		const event = type === "input" ? { type: "input" as const, text, source } : { type };
		return handler(event, context as unknown as ExtensionContext);
	}
	register();
	await emit("session_start");
	return {
		path, directory, context, notifications, messages, emit,
		get branch() { return branch; },
		setBranch(entries: StoredState[]) { branch = entries; },
		async reload() { register(); await emit("session_start"); },
		async clear() {
			const command = commands.get("skills-clear");
			if (!command) throw new Error("Missing skills-clear command");
			await command.handler("", context as unknown as ExtensionCommandContext);
		},
	};
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("extension integration", () => {
	test("loads content once without starting a turn and includes reference context", async () => {
		const host = await createHost();
		expect(await host.emit("input", "{$example}")).toEqual({ action: "handled" });
		expect(await host.emit("input", "{$example}")).toEqual({ action: "handled" });
		expect(host.messages).toHaveLength(1);
		expect(host.messages[0]?.options).toEqual({ triggerTurn: false });
		expect(host.messages[0]?.message.content).toContain("# Example");
		expect(host.messages[0]?.message.content).toContain(host.path);
		expect(host.messages[0]?.message.content).toContain(host.directory);
		expect(host.messages[0]?.message.content).not.toContain("name: example");
		expect(host.branch).toHaveLength(1);
		expect(host.branch[0]?.data.loadedSkills).toEqual(["example"]);
	});

	test("combined input loads the skill and continues the user's turn", async () => {
		const host = await createHost();
		expect(await host.emit("input", "Review this {$example}")).toEqual({ action: "continue" });
		expect(host.messages).toHaveLength(1);
	});

	test("plain hashtags and extension-generated input do not load skills", async () => {
		const host = await createHost();
		expect(await host.emit("input", "#example")).toEqual({ action: "continue" });
		expect(await host.emit("input", "{$example}", "extension")).toEqual({ action: "continue" });
		expect(host.messages).toHaveLength(0);
		expect(host.branch).toHaveLength(0);
	});

	test("unknown markers are not swallowed when known markers load", async () => {
		const host = await createHost();
		expect(await host.emit("input", "{$example} {$missing}")).toEqual({ action: "continue" });
		expect(host.messages).toHaveLength(1);
	});

	test("unreadable files report failure without persistence and can be retried", async () => {
		const host = await createHost();
		await rm(host.path);
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(0);
		expect(host.branch).toHaveLength(0);
		expect(host.notifications.some(({ level }) => level === "error")).toBe(true);
		expect(host.notifications.some(({ message }) => message.startsWith("Loaded:"))).toBe(false);
		await writeFile(host.path, "Recovered content");
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(1);
		expect(host.branch).toHaveLength(1);
	});

	test("frontmatter-only files are rejected without marking them loaded", async () => {
		const host = await createHost();
		await writeFile(host.path, "---\nname: example\n---\n  \n");
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(0);
		expect(host.branch).toHaveLength(0);
		expect(host.notifications.some(({ level }) => level === "error")).toBe(true);
	});

	test("session tree navigation restores tracking from the selected branch", async () => {
		const host = await createHost();
		await host.emit("input", "{$example}");
		const loadedBranch = [...host.branch];
		host.setBranch([]);
		await host.emit("session_tree");
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(2);
		host.setBranch(loadedBranch);
		await host.emit("session_tree");
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(2);
	});

	test("reload restores tracking and does not duplicate submitted content", async () => {
		const host = await createHost();
		await host.emit("input", "{$example}");
		await host.reload();
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(1);
		expect(host.branch).toHaveLength(1);
	});

	test("legacy tracking entries submit content once and persist the migrated state", async () => {
		const host = await createHost();
		host.setBranch([{ type: "custom", customType: "skill-loader-state", data: { loadedSkills: ["example"] } }]);
		await host.reload();
		expect(host.messages).toHaveLength(1);
		expect(host.branch.at(-1)?.data.version).toBe(2);
		await host.reload();
		expect(host.messages).toHaveLength(1);
	});

	test("clearing tracking survives reload and permits resubmission", async () => {
		const host = await createHost();
		await host.emit("input", "{$example}");
		await host.clear();
		expect(host.branch.at(-1)?.data.loadedSkills).toEqual([]);
		await host.reload();
		await host.emit("input", "{$example}");
		expect(host.messages).toHaveLength(2);
	});

	test("bare-hash picker submits the selected skill without a model turn", async () => {
		const host = await createHost();
		host.context.hasUI = true;
		expect(await host.emit("input", "#")).toEqual({ action: "handled" });
		expect(host.messages).toHaveLength(1);
		expect(host.messages[0]?.options).toEqual({ triggerTurn: false });
	});
});
