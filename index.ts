import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

type SkillInfo = {
	name: string;
	description: string;
	path: string;
};

const STATE_ENTRY_TYPE = "skill-loader-state";
const PREFIX = "#";

/**
 * A `{$token}` in user input: the visible marker of a selected skill.
 * Selecting from the `#` suggestion box rewrites `#name` to this form.
 * Pi validates skill names as `^[a-z0-9-]+$` but still loads skills with
 * out-of-spec names (uppercase, underscores, dots), so match broadly and
 * resolve against known skills afterwards.
 */
const TOKEN_RE = /\{\$([A-Za-z0-9_.-]+)\}/g;

export function isPickerInput(text: string): boolean {
	return text.trim() === PREFIX;
}

function skillsByName(pi: ExtensionAPI): Map<string, SkillInfo> {
	const map = new Map<string, SkillInfo>();
	for (const c of pi.getCommands()) {
		if (c.source !== "skill") continue;
		const name = c.name.replace(/^skill:/, "");
		map.set(name, {
			name,
			description: c.description ?? "",
			path: c.sourceInfo.path,
		});
	}
	return map;
}

/** Resolve tokens to known skills: exact match, then case-insensitive. */
export function resolveSkill(
	tokens: string[],
	known: Map<string, SkillInfo>,
): { known: string[]; unknown: string[] } {
	const lowered = new Map<string, string>();
	for (const name of known.keys()) {
		if (!lowered.has(name.toLowerCase())) {
			lowered.set(name.toLowerCase(), name);
		}
	}
	const seen = new Set<string>();
	const knownNames: string[] = [];
	const unknown: string[] = [];
	for (const token of tokens) {
		const exact = known.has(token) ? token : lowered.get(token.toLowerCase());
		if (exact === undefined) {
			unknown.push(token);
			continue;
		}
		if (seen.has(exact)) continue;
		seen.add(exact);
		knownNames.push(exact);
	}
	return { known: knownNames, unknown };
}

/** True when the message holds nothing but `{$token}`s and separators. */
export function isSkillOnlyMessage(text: string): boolean {
	return text.replace(TOKEN_RE, "").replace(/[\s,]+/g, "") === "";
}

export type CompletionResult = {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
};

/**
 * Rewrite a just-applied `#name` skill completion into its `{$name}` marker
 * form. Returns the result unchanged when the completed value is not found
 * immediately before the cursor.
 */
export function rewriteSkillCompletion(
	result: CompletionResult,
	value: string,
	name: string,
): CompletionResult {
	const line = result.lines[result.cursorLine] ?? "";
	const before = line.slice(0, result.cursorCol);
	const after = line.slice(result.cursorCol);
	if (!before.endsWith(value)) {
		return result;
	}
	const rewritten = before.slice(0, before.length - value.length) + `{\$${name}}`;
	const lines = [...result.lines];
	lines[result.cursorLine] = rewritten + after;
	return {
		lines,
		cursorLine: result.cursorLine,
		cursorCol: rewritten.length,
	};
}

/** FZF-style fuzzy match: query chars must appear in order in target */
export function fuzzyMatch(query: string, target: string): boolean {
	let qi = 0;
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) qi++;
	}
	return qi === q.length;
}

/** Simple fzf-style score: prefer consecutive matches and earlier positions */
export function fuzzyScore(query: string, target: string): number {
	let score = 0;
	let qi = 0;
	let lastMatchIdx = -1;
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			if (lastMatchIdx >= 0 && ti === lastMatchIdx + 1) {
				score += 2; // consecutive match bonus
			}
			score += 1;
			if (ti < 3) score += 1; // early position bonus
			lastMatchIdx = ti;
			qi++;
		}
	}
	return qi === q.length ? score : -1;
}

export function stripFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (match) {
		return content.slice(match[0].length).trimStart();
	}
	return content;
}

function formatSkillBlock(skill: SkillInfo, content: string): string {
	return `Skill: ${skill.name}\nLocation: ${skill.path}\nReferences are relative to ${dirname(skill.path)}.\n\n${content}`;
}

// Default-foreground reset, NOT a full reset: theme accents are fg-only
// codes, and a full reset here would kill the cursor's reverse video when
// the cursor sits right after a tinted token.
const COLOR_END = "\x1b[39m";
const FALLBACK_COLOR_START = "\x1b[36m"; // cyan

// SGR, APC (hardware cursor marker), and OSC sequences.
const ESCAPE_SPLIT_RE =
	/(\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*(?:\x07|\x1b\\))/g;
const ESCAPE_ONLY_RE =
	/^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*(?:\x07|\x1b\\))$/;
const ANSI_STRIP_RE =
	/\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const FULL_BORDER_RE = /^─+$/;
const SCROLL_BORDER_RE = /^─── [↑↓] \d+ more ─*$/;

/**
 * Wrap accepted `{$token}` ranges in color codes. ANSI-aware: existing
 * escape sequences (cursor styling, hardware cursor marker) pass through
 * untouched, and the color is re-asserted after any inner sequence that
 * may reset it.
 */
export function colorizeLine(
	line: string,
	colorStart: string,
	colorEnd: string,
	isColored: (token: string) => boolean,
): string {
	const parts = line.split(ESCAPE_SPLIT_RE);
	let plain = "";
	for (const part of parts) {
		if (part === undefined || part === "" || ESCAPE_ONLY_RE.test(part)) {
			continue;
		}
		plain += part;
	}
	const ranges: Array<{ start: number; end: number }> = [];
	for (const m of plain.matchAll(TOKEN_RE)) {
		const token = m[1];
		if (token === undefined || m.index === undefined) continue;
		if (!isColored(token)) continue;
		ranges.push({ start: m.index, end: m.index + m[0].length });
	}
	if (ranges.length === 0) return line;

	const colored = new Array<boolean>(plain.length).fill(false);
	for (const r of ranges) {
		for (let i = r.start; i < r.end && i < colored.length; i++) {
			colored[i] = true;
		}
	}

	type Seg = { esc: string } | { text: string; start: number };
	const segs: Seg[] = [];
	let cursor = 0;
	for (const part of parts) {
		if (part === undefined || part === "") continue;
		if (ESCAPE_ONLY_RE.test(part)) {
			segs.push({ esc: part });
			continue;
		}
		segs.push({ text: part, start: cursor });
		cursor += part.length;
	}
	// nextColored[i]: colored state of the visible char right after seg i.
	const nextColored: boolean[] = new Array(segs.length).fill(false);
	let next = false;
	for (let i = segs.length - 1; i >= 0; i--) {
		nextColored[i] = next;
		const s = segs[i];
		if (s !== undefined && !("esc" in s)) {
			next = colored[s.start] ?? false;
		}
	}

	let out = "";
	let inColor = false;
	const setColor = (want: boolean) => {
		if (want === inColor) return;
		out += want ? colorStart : colorEnd;
		inColor = want;
	};
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i];
		if (s === undefined) continue;
		if ("esc" in s) {
			out += s.esc;
			if (inColor && (nextColored[i] ?? false)) out += colorStart;
			continue;
		}
		for (let j = 0; j < s.text.length; j++) {
			const ch = s.text[j];
			if (ch === undefined) continue;
			setColor(colored[s.start + j] ?? false);
			out += ch;
		}
	}
	setColor(false);
	return out;
}

/**
 * Colorize the content lines of editor render output. The first line is the
 * top border and autocomplete suggestions (if any) follow the bottom border,
 * so only lines strictly between them are touched. Returns the input
 * unchanged when the bottom border cannot be found.
 */
export function colorizeEditorLines(
	lines: string[],
	colorStart: string,
	colorEnd: string,
	isColored: (token: string) => boolean,
): string[] {
	if (lines.length < 2) return lines;
	let bottom = -1;
	for (let i = 1; i < lines.length; i++) {
		const stripped = (lines[i] ?? "").replace(ANSI_STRIP_RE, "");
		if (
			FULL_BORDER_RE.test(stripped) ||
			SCROLL_BORDER_RE.test(stripped)
		) {
			bottom = i;
			break;
		}
	}
	if (bottom === -1) return lines;
	return lines.map((line, i) =>
		i > 0 && i < bottom
			? colorizeLine(line, colorStart, colorEnd, isColored)
			: line,
	);
}

type HighlightHooks = {
	willLoad: (token: string) => boolean;
	colorStart: () => string;
};

/** Editor that tints `{$skill}` tokens so pending loads are visible. */
class SkillHighlightEditor extends CustomEditor {
	private highlight: HighlightHooks;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		highlight: HighlightHooks,
	) {
		super(tui, theme, keybindings);
		this.highlight = highlight;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		try {
			const start = this.highlight.colorStart();
			if (start === "") return lines;
			return colorizeEditorLines(lines, start, COLOR_END, (token) =>
				this.highlight.willLoad(token),
			);
		} catch {
			return lines;
		}
	}
}

export default function skillLoaderExtension(pi: ExtensionAPI) {
	const loadedSkills = new Set<string>();
	let editorConflictNotified = false;

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, {
			version: 2,
			loadedSkills: Array.from(loadedSkills),
		});
	}

	/** Submit each newly loaded skill once, without starting a model turn. */
	async function loadSkills(
		names: string[],
		ctx: ExtensionContext,
	): Promise<string[]> {
		const added: string[] = [];
		const known = skillsByName(pi);
		for (const name of names) {
			if (loadedSkills.has(name)) continue;
			const skill = known.get(name);
			if (!skill) continue;
			let content: string;
			try {
				content = stripFrontmatter(await readFile(skill.path, "utf-8"));
				if (content.trim() === "") throw new Error("Skill content is empty");
			} catch (error) {
				ctx.ui.notify(
					`Could not load ${name} (${skill.path}): ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				continue;
			}
			pi.sendMessage(
				{
					customType: "skill-loader-content",
					content: formatSkillBlock(skill, content),
					display: false,
				},
				{ triggerTurn: false },
			);
			loadedSkills.add(name);
			added.push(name);
		}
		if (added.length > 0) persistState();
		return added;
	}

	function clearSkills(): boolean {
		if (loadedSkills.size === 0) return false;
		loadedSkills.clear();
		persistState();
		return true;
	}

	async function restoreState(ctx: ExtensionContext): Promise<void> {
		// Restore loaded skills from session entries (take latest).
		loadedSkills.clear();
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry?.type === "custom" &&
				entry.customType === STATE_ENTRY_TYPE
			) {
				const data = entry.data as {
					version?: unknown;
					loadedSkills?: unknown;
				} | null;
				if (Array.isArray(data?.loadedSkills)) {
					const names = data.loadedSkills.filter(
						(name): name is string => typeof name === "string",
					);
					if (data.version === 2) {
						for (const name of names) loadedSkills.add(name);
					} else {
						// Older versions only injected system prompts, not durable messages.
						await loadSkills(names, ctx);
					}
				}
				break;
			}
		}
	}

	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
	pi.on("session_start", async (_event, ctx) => {
		await restoreState(ctx);

		// Highlight loadable {$skill} tokens in the input box. Skipped
		// when another extension already owns the editor component.
		if (ctx.hasUI) {
			if (ctx.ui.getEditorComponent() === undefined) {
				ctx.ui.setEditorComponent(
					(tui, theme, keybindings) =>
						new SkillHighlightEditor(tui, theme, keybindings, {
							willLoad: (token) => {
								const { known } = resolveSkill(
									[token],
									skillsByName(pi),
								);
								return known[0] !== undefined;
							},
							colorStart: () => {
								try {
									return ctx.ui.theme.getFgAnsi("accent");
								} catch {
									return FALLBACK_COLOR_START;
								}
							},
						}),
				);
			} else if (!editorConflictNotified) {
				editorConflictNotified = true;
				ctx.ui.notify(
					"skill-loader: another extension owns the editor; #skill highlighting disabled",
					"warning",
				);
			}
		}

		// Autocomplete provider for #skillname. Pi core auto-opens the box
		// on "#" and re-queries while typing, so no Tab is needed.
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, line, col, options) {
				const beforeCursor = (lines[line] ?? "").slice(0, col);
				const match = beforeCursor.match(/#([A-Za-z0-9_.-]*)$/);
				if (!match) {
					return current.getSuggestions(lines, line, col, options);
				}

				const prefix = match[1] ?? "";
				const allSkills = [...skillsByName(pi).values()];

				// Bare "#" browses every skill; a non-empty prefix with no
				// match delegates to the base provider so the box closes
				// instead of showing irrelevant skills.
				if (prefix !== "") {
					const filtered = allSkills
						.filter((s) => fuzzyMatch(prefix, s.name))
						.sort(
							(a, b) =>
								fuzzyScore(prefix, b.name) -
								fuzzyScore(prefix, a.name),
						);
					if (filtered.length === 0) {
						return current.getSuggestions(
							lines,
							line,
							col,
							options,
						);
					}
					return {
						prefix: `${PREFIX}${prefix}`,
						items: filtered.map((s) => ({
							value: `${PREFIX}${s.name}`,
							label:
								s.name +
								(loadedSkills.has(s.name) ? " (loaded)" : ""),
							description: s.description,
						})),
					};
				}

				return {
					prefix: PREFIX,
					items: allSkills.map((s) => ({
						value: `${PREFIX}${s.name}`,
						label:
							s.name +
							(loadedSkills.has(s.name) ? " (loaded)" : ""),
						description: s.description,
					})),
				};
			},
			applyCompletion(lines, line, col, item, prefix) {
				const result = current.applyCompletion(
					lines,
					line,
					col,
					item,
					prefix,
				);
				// Tab/Enter on one of our suggestions rewrites `#name` to
				// its `{$name}` marker form. Esc never reaches here, so
				// dismissed boxes leave plain text that will not load.
				if (!prefix.startsWith(PREFIX)) {
					return result;
				}
				const token = item.value.match(/^#([A-Za-z0-9_.-]+)$/)?.[1];
				if (token === undefined) {
					return result;
				}
				const { known } = resolveSkill([token], skillsByName(pi));
				if (known[0] === undefined) {
					return result;
				}
				return rewriteSkillCompletion(result, item.value, known[0]);
			},
			shouldTriggerFileCompletion(lines, line, col) {
				return (
					current.shouldTriggerFileCompletion?.(lines, line, col) ?? true
				);
			},
		}));
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		// Bare # → skill picker menu (notification fallback without UI).
		if (isPickerInput(event.text)) {
			const skills = [...skillsByName(pi).values()];
			if (skills.length === 0) {
				ctx.ui.notify("No skills available", "warning");
				return { action: "handled" };
			}
			if (!ctx.hasUI) {
				const names = skills.map((s) => s.name).join(", ");
				ctx.ui.notify(`Skills: ${names}`, "info");
				return { action: "handled" };
			}
			const options = skills.map(
				(s) => `${s.name} - ${s.description || "no description"}`,
			);
			const choice = await ctx.ui.select("Load skill", options);
			if (choice === undefined) {
				return { action: "handled" };
			}
			const selected = skills.find(
				(s) =>
					`${s.name} - ${s.description || "no description"}` ===
					choice,
			);
			if (selected) {
				const alreadyLoaded = loadedSkills.has(selected.name);
				const added = await loadSkills([selected.name], ctx);
				if (added.length === 0 && !alreadyLoaded) return { action: "handled" };
				ctx.ui.notify(
					added.length > 0
						? `Loaded: ${selected.name}`
						: `Already loaded: ${selected.name}`,
					"info",
				);
			}
			return { action: "handled" };
		}

		// Load every known `{$skill}` marker in the message. The text
		// passes through untouched so mentions stay visible; the marker
		// form itself is the selection, so plain `#words` and pasted
		// markdown never load.
		const known = skillsByName(pi);
		const tokens = [
			...new Set(
				[...event.text.matchAll(TOKEN_RE)]
					.map((m) => m[1])
					.filter((t): t is string => t !== undefined),
			),
		];
		const { known: names, unknown } = resolveSkill(tokens, known);

		if (names.length === 0) {
			return { action: "continue" };
		}

		const already = names.filter((n) => loadedSkills.has(n));
		const added = await loadSkills(names, ctx);
		const parts: string[] = [];
		if (added.length > 0) parts.push(`Loaded: ${added.join(", ")}`);
		if (already.length > 0)
			parts.push(`Already loaded: ${already.join(", ")}`);
		if (parts.length > 0) ctx.ui.notify(parts.join(" | "), "info");

		// A message of bare markers alone does not consume a turn.
		// Unknown markers still pass through; failed reads are reported above.
		if (isSkillOnlyMessage(event.text) && unknown.length === 0) {
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.registerCommand("skills", {
		description: "List currently loaded skills",
		handler: async (_args, ctx) => {
			if (loadedSkills.size === 0) {
				ctx.ui.notify("No skills loaded", "info");
				return;
			}
			ctx.ui.notify(
				`Loaded: ${Array.from(loadedSkills).join(", ")}`,
				"info",
			);
		},
	});

	pi.registerCommand("skills-clear", {
		description: "Reset loaded skill tracking",
		handler: async (_args, ctx) => {
			if (clearSkills()) {
				ctx.ui.notify(
					"Skill tracking cleared; previously submitted content remains in conversation history",
					"info",
				);
			} else {
				ctx.ui.notify("No skills loaded", "info");
			}
		},
	});
}
