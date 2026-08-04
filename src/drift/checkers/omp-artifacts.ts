import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { globSync } from "glob";
import type { DriftIssue } from "../../types.js";
import { extractFrontmatter } from "../../markdown.js";
import { parseFrontmatter } from "../frontmatter.js";
import { toPosix } from "../../paths.js";

/**
 * Marker written as the first line after the frontmatter block of every file
 * `mex setup` emits into `.omp/`. Files without it are hand-written by the user
 * and are none of mex's business.
 */
const GENERATED_MARKER = "<!-- mex-generated -->";

/** Generated per-pattern rules are named `mex-pattern-<slug>.md`. */
const PATTERN_RULE_PREFIX = "mex-pattern-";

/**
 * Verify the oh-my-pi (`omp`) artifacts `mex setup` projects into `.omp/`.
 *
 * Two gaps are deliberate in the projection design and can only be closed here:
 *
 * 1. `.omp/AGENTS.md` is a thin bridge whose whole payload is an `@` import of
 *    `.mex/AGENTS.md`. omp renders an unresolvable `@` import as a LITERAL
 *    TOKEN and warns about nothing, so a moved or deleted target means the mex
 *    anchor silently stops reaching the agent — nothing else in the system
 *    would ever notice.
 * 2. `.omp/rules/mex-pattern-<slug>.md` projects the `description` of
 *    `.mex/patterns/<slug>.md`. Rule bodies are pointers and cannot rot, but
 *    that one projected field can, and so can the pattern file's existence.
 */
export function checkOmpArtifacts(projectRoot: string): DriftIssue[] {
	const ompDir = resolve(projectRoot, ".omp");
	// The overwhelming majority of repos have never run omp setup: cost nothing.
	if (!existsSync(ompDir)) return [];

	return [...checkAnchorImports(projectRoot, ompDir), ...checkPatternRules(projectRoot, ompDir)];
}

/** Resolve every `@` import in `.omp/AGENTS.md` relative to the importing file's directory. */
function checkAnchorImports(projectRoot: string, ompDir: string): DriftIssue[] {
	const anchorPath = resolve(ompDir, "AGENTS.md");
	if (!existsSync(anchorPath)) return [];

	let content: string;
	try {
		content = readFileSync(anchorPath, "utf-8");
	} catch {
		// Unreadable file -- ignore rather than reporting a checker-internal error.
		return [];
	}

	const anchorFile = ".omp/AGENTS.md";
	const importerDir = dirname(anchorPath);
	const issues: DriftIssue[] = [];

	for (const { target, line } of findImports(content)) {
		const resolved = resolve(importerDir, target);
		if (existsSync(resolved)) continue;
		issues.push({
			code: "OMP_ANCHOR_BROKEN",
			severity: "error",
			file: anchorFile,
			line,
			message:
				`.omp/AGENTS.md imports @${target}, which resolves to ${toPosix(relative(projectRoot, resolved))} — that file does not exist. ` +
				`omp leaves an unresolvable @ import in the prompt as a literal token and warns about nothing, so the mex anchor silently stops reaching the agent. ` +
				`Restore the missing target, or re-run \`mex setup\` to regenerate the bridge.`,
		});
	}

	return issues;
}

/**
 * Import lines are lines whose first non-whitespace character is `@` followed by
 * a path. Fenced blocks, inline code spans and email-like tokens are skipped so
 * prose that merely mentions the syntax is never treated as a real import.
 */
function findImports(content: string): Array<{ target: string; line: number }> {
	const imports: Array<{ target: string; line: number }> = [];
	const lines = content.split(/\r?\n/);
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();

		const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
		if (fenceMatch) {
			const marker = fenceMatch[1][0].repeat(3);
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence !== null) continue;

		// Only a bare, leading `@path` is an import. A backtick-wrapped mention
		// (`` `@../x.md` ``) fails this on its first character, as does prose.
		const match = /^@(\S+)$/.exec(trimmed);
		if (!match) continue;

		const target = match[1];
		// `@` inside the token means an email/handle-like string, not a path.
		if (target.includes("@")) continue;
		if (target.includes("`")) continue;

		imports.push({ target, line: i + 1 });
	}

	return imports;
}

/** Compare each generated per-pattern rule against the pattern it was projected from. */
function checkPatternRules(projectRoot: string, ompDir: string): DriftIssue[] {
	const rulesDir = resolve(ompDir, "rules");
	if (!existsSync(rulesDir)) return [];

	const patternsDir = resolve(projectRoot, ".mex", "patterns");
	const issues: DriftIssue[] = [];

	const ruleFiles = globSync(`${PATTERN_RULE_PREFIX}*.md`, {
		cwd: rulesDir,
		ignore: ["node_modules/**"],
	}).sort();

	for (const ruleName of ruleFiles) {
		const slug = ruleName.slice(PATTERN_RULE_PREFIX.length, -".md".length);
		if (slug.length === 0) continue;

		let ruleContent: string;
		try {
			ruleContent = readFileSync(resolve(rulesDir, ruleName), "utf-8");
		} catch {
			// Unreadable file -- ignore rather than reporting a checker-internal error.
			continue;
		}
		// Hand-written user rules never carry the marker and are never reported.
		if (!ruleContent.includes(GENERATED_MARKER)) continue;

		const ruleFile = `.omp/rules/${ruleName}`;
		const patternFile = `.mex/patterns/${slug}.md`;
		const patternPath = resolve(patternsDir, `${slug}.md`);

		if (!existsSync(patternPath)) {
			issues.push({
				code: "OMP_RULE_ORPHAN",
				severity: "warning",
				file: ruleFile,
				line: null,
				message:
					`${ruleFile} was generated from ${patternFile}, but that pattern no longer exists — the rule points at a deleted or renamed pattern. ` +
					`Delete ${ruleFile}, or re-run \`mex setup\` to regenerate the rules from the current patterns.`,
			});
			continue;
		}

		const ruleDescription = extractFrontmatter(ruleContent)?.description;
		const patternDescription = parseFrontmatter(patternPath)?.description;
		// Only a confident comparison is reportable: a missing or malformed
		// frontmatter description on either side is ignored.
		if (typeof ruleDescription !== "string" || typeof patternDescription !== "string") continue;
		if (ruleDescription === patternDescription) continue;

		issues.push({
			code: "OMP_RULE_DRIFT",
			severity: "warning",
			file: ruleFile,
			line: null,
			message:
				`${ruleFile} projects description "${ruleDescription}" but ${patternFile} now says "${patternDescription}". ` +
				`The projection is stale — re-run \`mex setup\` to regenerate the rule from the pattern.`,
		});
	}

	return issues;
}
