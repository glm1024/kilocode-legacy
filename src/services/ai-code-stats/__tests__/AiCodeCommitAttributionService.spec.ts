import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
	AiCodeCommitAttributionService,
	type AiCodeCommitAttributionServiceOptions,
} from "../AiCodeCommitAttributionService"
import { extractLineFeatures } from "../AiCodeLineFeatures"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import { AiCodeCommitPartialMatcher } from "../AiCodeCommitPartialMatcher"
import { createInlinePartialMatcherExecutor } from "../AiCodeCommitPartialMatcherWorkerClient"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import {
	DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
	type AiCodeCommitAttributionConfig,
	type AiCodeCommittedBlock,
	type AiCodePendingLineAttribution,
} from "../types"

class FakeWatcher {
	private handlers: Array<(event: any) => void> = []
	disposed = false

	onEvent(handler: (event: any) => void) {
		this.handlers.push(handler)
	}

	async start(): Promise<void> {}

	dispose(): void {
		this.disposed = true
	}

	emit(event: any): void {
		for (const handler of this.handlers) {
			handler(event)
		}
	}
}

const buildPendingLine = (overrides: Partial<AiCodePendingLineAttribution> = {}): AiCodePendingLineAttribution => ({
	...(() => {
		const rawLine = overrides.rawLine ?? "const value = 1"
		const features = extractLineFeatures(rawLine)
		return {
			rawLine,
			normalizedLine: overrides.normalizedLine ?? features.normalizedLine,
			normalizedTokenLine: overrides.normalizedTokenLine ?? features.normalizedTokenLine,
			rareIdentifiers: overrides.rareIdentifiers ?? features.rareIdentifiers,
		}
	})(),
	id: overrides.id ?? `line-${Math.random().toString(36).slice(2)}`,
	generatedEventId: overrides.generatedEventId ?? "generated-1",
	blockId: overrides.blockId ?? overrides.generatedEventId ?? "generated-1",
	timestamp: overrides.timestamp ?? 1_772_400_000_000,
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	workspaceName: overrides.workspaceName ?? "workspace",
	workspacePath: overrides.workspacePath ?? "/workspace",
	projectKey: overrides.projectKey ?? "project-key",
	filePath: overrides.filePath ?? "/repo/src/a.ts",
	relativePath: overrides.relativePath ?? "src/a.ts",
	repoRoot: overrides.repoRoot ?? "/repo",
	repoRelativePath: overrides.repoRelativePath ?? "src/a.ts",
	language: overrides.language ?? "typescript",
	gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/repo.git",
	gitBranch: overrides.gitBranch ?? "feature/stats",
	taskId: overrides.taskId,
	blockLineIndex: overrides.blockLineIndex ?? overrides.occurrenceIndex ?? 1,
	blockLineCount: overrides.blockLineCount ?? 1,
	lineHash: overrides.lineHash ?? hashLineFingerprint(overrides.rawLine ?? "const value = 1"),
	occurrenceIndex: overrides.occurrenceIndex ?? 1,
	...overrides,
})

const buildPendingBlock = (
	lines: string[],
	overrides: Partial<AiCodePendingLineAttribution> = {},
): AiCodePendingLineAttribution[] =>
	lines.map((rawLine, index) =>
		buildPendingLine({
			...overrides,
			id: overrides.id ? `${overrides.id}-${index + 1}` : undefined,
			rawLine,
			lineHash: hashLineFingerprint(rawLine),
			blockId: overrides.blockId ?? overrides.generatedEventId ?? "generated-1",
			blockLineIndex: index + 1,
			blockLineCount: lines.length,
			occurrenceIndex: index + 1,
		}),
	)

describe("AiCodeCommitAttributionService", () => {
	let tmpDir: string
	let store: AiCodeStatsStore
	let watchers: FakeWatcher[]

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-commit-attribution-"))
		store = new AiCodeStatsStore(tmpDir)
		watchers = []
	})

	const createService = (overrides: Partial<AiCodeCommitAttributionServiceOptions> = {}) =>
		new AiCodeCommitAttributionService(store, {
			createWatcher: () => {
				const watcher = new FakeWatcher()
				watchers.push(watcher)
				return watcher
			},
			loadCommitPatch: async () => "",
			loadCommitTimestamp: async () => 1_772_500_000_000,
			loadCommitFileContent: async (_repoRoot: string, _commitHash: string, repoRelativePath: string) =>
				`// committed snapshot for ${repoRelativePath}\nconst value = 1\n`,
			getCurrentBranch: async () => "feature/stats",
			getCurrentCommitSha: async () => "head-1",
			isDetachedHead: async () => false,
			isAncestor: async () => true,
			listCommitsBetween: async () => [],
			listCommitsSinceTimestamp: async () => [],
			partialMatcherExecutor: createInlinePartialMatcherExecutor(),
			...overrides,
		})

	type InternalCommitAddedLine = {
		index: number
		lineNumber: number
		content: string
	}

	type InternalPartialDebugStats = {
		totalPairCount: number
		tokenLcsCount: number
		levenshteinCount: number
		positiveEdgeCount: number
		processedBlockCount: number
		denseFallbackBlockCount: number
	}

	type InternalService = {
		buildPendingBlockCandidates: (
			pendingLines: AiCodePendingLineAttribution[],
			matchedLineIds: Set<string>,
			currentFilePath: string,
			previousFilePath: string | undefined,
			commitOccurredAt: number,
		) => any[]
		buildAddedLineCandidates: (addedLines: InternalCommitAddedLine[], filePath?: string, language?: string) => any[]
		alignPartialBlockCandidates: (
			block: any,
			addedLines: any[],
			config: AiCodeCommitAttributionConfig,
			debugStats?: InternalPartialDebugStats,
		) => any[]
		alignPartialBlockCandidatesDenseReference: (
			block: any,
			addedLines: any[],
			config: AiCodeCommitAttributionConfig,
			debugStats?: InternalPartialDebugStats,
		) => any[]
		comparePartialCandidates: (left: any, right: any) => number
		buildCommittedBlocks: (
			matches: any[],
			branch: string,
			commitHash: string,
			commitOccurredAt: number,
			fileSnapshotContent?: string,
		) => AiCodeCommittedBlock[]
	}

	const createPartialDebugStats = (): InternalPartialDebugStats => ({
		totalPairCount: 0,
		tokenLcsCount: 0,
		levenshteinCount: 0,
		positiveEdgeCount: 0,
		processedBlockCount: 0,
		denseFallbackBlockCount: 0,
	})

	const summarizeCommittedBlocks = (blocks: AiCodeCommittedBlock[]) =>
		blocks.map((block) => ({
			generatedBlockId: block.generatedBlockId,
			matchStrategy: block.matchStrategy,
			lineStart: block.lineStart,
			lineEnd: block.lineEnd,
			lineCount: block.lineCount,
			codeSnippet: block.codeSnippet,
			matchConfidence: block.matchConfidence,
			equivalentLineCount: block.equivalentLineCount,
			matchDetail: block.matchDetail,
		}))

	const runPartialMatcherWithStrategy = ({
		service,
		pendingLines,
		addedLines,
		filePath = "src/a.ts",
		previousFilePath,
		matchedLineIds = new Set<string>(),
		commitOccurredAt = 1_772_500_000_000,
		config = DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
		repoRoot = "/repo",
		branch = "feature/stats",
		commitHash = "partial-reference",
		fileSnapshotContent = "// committed snapshot",
		useDenseReference,
	}: {
		service: AiCodeCommitAttributionService
		pendingLines: AiCodePendingLineAttribution[]
		addedLines: readonly string[]
		filePath?: string
		previousFilePath?: string
		matchedLineIds?: Set<string>
		commitOccurredAt?: number
		config?: AiCodeCommitAttributionConfig
		repoRoot?: string
		branch?: string
		commitHash?: string
		fileSnapshotContent?: string
		useDenseReference: boolean
	}) => {
		const internal = service as unknown as InternalService
		const indexedAddedLines = addedLines.map((content, index) => ({
			index,
			lineNumber: index + 1,
			content,
		}))
		const blockCandidates = internal.buildPendingBlockCandidates(
			pendingLines,
			matchedLineIds,
			filePath,
			previousFilePath,
			commitOccurredAt,
		)
		const addedLineCandidates = internal.buildAddedLineCandidates(indexedAddedLines, filePath)
		const debugStats = createPartialDebugStats()
		const lineCandidates = blockCandidates.flatMap((block) =>
			useDenseReference
				? internal.alignPartialBlockCandidatesDenseReference(block, addedLineCandidates, config, debugStats)
				: internal.alignPartialBlockCandidates(block, addedLineCandidates, config, debugStats),
		)

		const candidatesByAddedLine = new Map<number, any[]>()
		for (const candidate of lineCandidates) {
			const existing = candidatesByAddedLine.get(candidate.addedLine.index) ?? []
			existing.push(candidate)
			candidatesByAddedLine.set(candidate.addedLine.index, existing)
		}

		const eligibleCandidates: any[] = []
		for (const candidates of candidatesByAddedLine.values()) {
			const rankedCandidates = candidates
				.slice()
				.sort((left, right) => internal.comparePartialCandidates(left, right))
			const bestCandidate = rankedCandidates[0]
			if (!bestCandidate) {
				continue
			}

			const secondBestCandidate = rankedCandidates[1]
			if (secondBestCandidate && bestCandidate.lineScore - secondBestCandidate.lineScore < config.ambiguityGap) {
				continue
			}

			const passesThreshold = bestCandidate.isGenericLine
				? bestCandidate.hasNeighborSupport && bestCandidate.lineScore >= config.contextualMinLineScore
				: bestCandidate.lineScore >= config.isolatedMinLineScore ||
					(bestCandidate.hasNeighborSupport && bestCandidate.lineScore >= config.contextualMinLineScore)
			if (!passesThreshold) {
				continue
			}

			eligibleCandidates.push(bestCandidate)
		}

		const usedAddedLineIndexes = new Set<number>()
		const usedPendingLineIds = new Set<string>()
		const acceptedMatches = eligibleCandidates
			.slice()
			.sort((left, right) => internal.comparePartialCandidates(left, right))
			.filter((candidate) => {
				if (
					usedAddedLineIndexes.has(candidate.addedLine.index) ||
					usedPendingLineIds.has(candidate.pendingLine.id)
				) {
					return false
				}
				usedAddedLineIndexes.add(candidate.addedLine.index)
				usedPendingLineIds.add(candidate.pendingLine.id)
				return true
			})
			.map((candidate) => ({
				pendingLine: candidate.pendingLine,
				lineNumber: candidate.addedLine.lineNumber,
				content: candidate.addedLine.content,
				filePath: path.join(repoRoot, filePath),
				relativePath: filePath,
				matchStrategy: "partial" as const,
				lineScore: candidate.lineScore,
				lineMatchDetail: candidate.lineMatchDetail,
			}))
			.sort((left, right) => left.lineNumber - right.lineNumber)

		const matchedIds = [...new Set(acceptedMatches.map((match) => match.pendingLine.id))].sort()
		const committedBlocks = internal.buildCommittedBlocks(
			acceptedMatches,
			branch,
			commitHash,
			commitOccurredAt,
			fileSnapshotContent,
		)

		return {
			matchedLineIds: matchedIds,
			committedBlocks: summarizeCommittedBlocks(committedBlocks),
			debugStats,
		}
	}

	const createSeededRandom = (seed: number): (() => number) => {
		let state = seed >>> 0
		return () => {
			state = (state * 1664525 + 1013904223) >>> 0
			return state / 0x100000000
		}
	}

	const pickOne = <T>(random: () => number, values: T[]): T => values[Math.floor(random() * values.length)]!

	const capitalize = (value: string): string => value.slice(0, 1).toUpperCase() + value.slice(1)

	const buildRandomPendingBlock = (seed: number, generatedEventId: string): AiCodePendingLineAttribution[] => {
		const random = createSeededRandom(seed)
		const identifiers = ["total", "subtotal", "amount", "receiptTotal", "taxRate", "localeSetting"]
		const collections = ["items", "lineItems", "cartItems", "orderItems"]
		const regions = ["regionCode", "countryCode", "localeCode"]
		const templates = [
			(primary: string, secondary: string, tertiary: string) =>
				`const ${primary} = calculateTotal(${secondary}, ${tertiary})`,
			(primary: string, secondary: string, tertiary: string) =>
				`return formatCurrency(${primary}, ${secondary}, ${tertiary})`,
			(primary: string, secondary: string, tertiary: string) =>
				`const ${secondary} = normalize${capitalize(primary)}(${primary}, ${tertiary})`,
			(primary: string, secondary: string, tertiary: string) =>
				`logger.info("${primary}", { ${secondary}, ${tertiary} })`,
		]

		const lineCount = 1 + Math.floor(random() * 4)
		const lines = Array.from({ length: lineCount }, () => {
			const template = pickOne(random, templates)
			return template(pickOne(random, identifiers), pickOne(random, collections), pickOne(random, regions))
		})

		return buildPendingBlock(lines, {
			id: generatedEventId,
			blockId: generatedEventId,
			generatedEventId,
		})
	}

	const mutateCodeLine = (random: () => number, line: string): string => {
		let next = line
		if (random() < 0.7) {
			next = next.replace(/,\s*/g, random() < 0.5 ? "," : ", ")
		}
		if (random() < 0.6) {
			next = next.replace(/\s*=\s*/g, random() < 0.5 ? "=" : " = ")
		}
		if (random() < 0.3) {
			next = next.replace(/\(\s*/g, "(").replace(/\s*\)/g, ")")
		}
		if (random() < 0.25) {
			next = next.replace(/\b(total|subtotal|amount)\b/, pickOne(random, ["total", "subtotal", "amount"]))
		}
		if (random() < 0.2) {
			next = next.replace(
				/\b(regionCode|countryCode|localeCode)\b/,
				pickOne(random, ["regionCode", "countryCode", "localeCode"]),
			)
		}
		return next
	}

	const buildRandomAddedLines = (seed: number, pendingLines: AiCodePendingLineAttribution[]): string[] => {
		const random = createSeededRandom(seed ^ 0x9e3779b9)
		const distractors = [
			"const manualValue = 1",
			'logger.debug("manual branch")',
			"return summary",
			"if (error) { return fallback }",
		]
		const addedLines: string[] = []
		if (random() < 0.5) {
			addedLines.push(pickOne(random, distractors))
		}
		for (const pendingLine of pendingLines) {
			if (random() < 0.8) {
				addedLines.push(mutateCodeLine(random, pendingLine.rawLine))
			}
			if (random() < 0.3) {
				addedLines.push(pickOne(random, distractors))
			}
		}
		if (addedLines.length === 0) {
			addedLines.push(mutateCodeLine(random, pendingLines[0]?.rawLine ?? "const value = 1"))
		}
		return addedLines
	}

	it("creates committed events for exact commit matches", async () => {
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const service = createService({
			onCommitComparisonCompleted,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,2 @@",
					"+const value = 1",
					"+const other = 2",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(["const value = 1", "const other = 2"], {
				id: "exact-block",
				generatedEventId: "generated-1",
			}),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				metricType: "committed",
				generatedBlockId: "generated-1",
				commitHash: "def456",
				commitOccurredAt: 1_772_500_000_000,
				filePath: "/repo/src/a.ts",
				relativePath: "src/a.ts",
				lineStart: 1,
				lineEnd: 2,
				lineCount: 2,
				codeSnippet: "const value = 1\nconst other = 2",
				fileSnapshotContent: "// committed snapshot for src/a.ts\nconst value = 1\n",
				matchStrategy: "exact",
				matchConfidence: 1,
				equivalentLineCount: 2,
			})
		})

		expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
	})

	it("splits exact committed blocks when generated lines are not consecutive", () => {
		const service = createService()
		const internal = service as unknown as InternalService
		const pendingLines = buildPendingBlock(["const first = 1", "const middle = 2", "const last = 3"], {
			id: "non-consecutive-exact",
			generatedEventId: "generated-non-consecutive-exact",
		})

		const blocks = internal.buildCommittedBlocks(
			[
				{
					pendingLine: pendingLines[0],
					lineNumber: 10,
					content: "const first = 1",
					filePath: "/repo/src/a.ts",
					relativePath: "src/a.ts",
					matchStrategy: "exact",
					lineScore: 1,
				},
				{
					pendingLine: pendingLines[2],
					lineNumber: 11,
					content: "const last = 3",
					filePath: "/repo/src/a.ts",
					relativePath: "src/a.ts",
					matchStrategy: "exact",
					lineScore: 1,
				},
			],
			"feature/stats",
			"commit-non-consecutive-exact",
			1_772_500_000_000,
		)

		expect(summarizeCommittedBlocks(blocks)).toEqual([
			expect.objectContaining({
				matchStrategy: "exact",
				lineStart: 10,
				lineEnd: 10,
				lineCount: 1,
				codeSnippet: "const first = 1",
			}),
			expect.objectContaining({
				matchStrategy: "exact",
				lineStart: 11,
				lineEnd: 11,
				lineCount: 1,
				codeSnippet: "const last = 3",
			}),
		])
	})

	it("prefers the newest exact block when generic lines are shared with an older block", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,6 @@",
					"+",
					"+def multiply(a, b):",
					'+    """',
					"+    math helper",
					'+    """',
					"+    return a * b",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			...buildPendingBlock(["", "def add(a, b):", '    """', "    math helper", '    """', "    return a + b"], {
				id: "old-block",
				generatedEventId: "generated-old",
				timestamp: 1_772_400_000_000,
				filePath: "/repo/src/a.ts",
				relativePath: "src/a.ts",
				repoRelativePath: "src/a.ts",
			}),
			...buildPendingBlock(
				["", "def multiply(a, b):", '    """', "    math helper", '    """', "    return a * b"],
				{
					id: "new-block",
					generatedEventId: "generated-new",
					timestamp: 1_772_400_100_000,
					filePath: "/repo/src/a.ts",
					relativePath: "src/a.ts",
					repoRelativePath: "src/a.ts",
				},
			),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				metricType: "committed",
				generatedBlockId: "generated-new",
				matchStrategy: "exact",
				lineStart: 1,
				lineEnd: 6,
				lineCount: 6,
			})
			expect(events[0].codeSnippet).toContain("def multiply(a, b):")
			expect(events[0].codeSnippet).toContain("return a * b")
		})

		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(6)
	})

	it("reports changed files for the whole commit patch, including manual-only blocks", async () => {
		const onCommitMatched = vi.fn(async (_payload: any) => {})
		const service = createService({
			onCommitMatched,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+const value = 1",
					"diff --git a/src/manual.ts b/src/manual.ts",
					"--- a/src/manual.ts",
					"+++ b/src/manual.ts",
					"@@ -0,0 +1,2 @@",
					"+const manual = true",
					"+console.log(manual)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				generatedEventId: "generated-1",
				lineHash: hashLineFingerprint("const value = 1"),
				occurrenceIndex: 1,
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(() => {
			expect(onCommitMatched).toHaveBeenCalledTimes(1)
		})

		const payload = onCommitMatched.mock.calls[0][0] as any
		expect(payload.changedFiles).toHaveLength(2)
		expect(payload.changedFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					relativePath: "src/a.ts",
					changedBlocks: [
						expect.objectContaining({
							startLine: 1,
							endLine: 1,
							lineCount: 1,
							codeSnippet: "const value = 1",
							displayOrder: 1,
						}),
					],
				}),
				expect.objectContaining({
					relativePath: "src/manual.ts",
					changedBlocks: [
						expect.objectContaining({
							startLine: 1,
							endLine: 2,
							lineCount: 2,
							codeSnippet: "const manual = true\nconsole.log(manual)",
							displayOrder: 1,
						}),
					],
				}),
			]),
		)
	})

	it("does not count unrelated manual additions as committed", async () => {
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const service = createService({
			onCommitComparisonCompleted,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -1 +1 @@",
					"+console.log(value)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		})

		expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		expect(await store.getRecentEvents(1, undefined, 1_772_500_000_000)).toHaveLength(0)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})

	it("attributes same-file block matches when identifiers are renamed", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,2 @@",
					"+const receiptTotal = calculateTotal(items, taxRate, localeSetting, currencyCode)",
					"+return formatCurrency(receiptTotal, currencyCode, localeSetting, taxRate)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"const orderTotal = calculateTotal(items, taxRate, localeSetting, currencyCode)",
					"return formatCurrency(orderTotal, currencyCode, localeSetting, taxRate)",
				],
				{
					id: "partial-identifiers",
					generatedEventId: "generated-partial-identifiers",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				generatedBlockId: "generated-partial-identifiers",
				metricType: "committed",
				matchStrategy: "partial",
				lineCount: 2,
				codeSnippet:
					"const receiptTotal = calculateTotal(items, taxRate, localeSetting, currencyCode)\nreturn formatCurrency(receiptTotal, currencyCode, localeSetting, taxRate)",
			})
			expect(events[0].matchConfidence).toBeGreaterThanOrEqual(0.85)
			expect(events[0].matchConfidence).toBeLessThan(1)
			expect(events[0].equivalentLineCount).toBeGreaterThan(1.7)
			expect(events[0].equivalentLineCount).toBeLessThan(2)
			expect(events[0].matchDetail).toMatchObject({
				scoreSource: "attribution",
				overlapSimilarity: expect.any(Number),
			})
			expect(events[0].matchDetail?.lineDetails).toHaveLength(2)
			expect(events[0].matchDetail?.lineDetails.every((detail) => detail.overlapKind === "identifier")).toBe(true)
		})

		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("attributes block matches when literals change but structure stays equivalent", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,2 @@",
					"+const taxRate = computeTaxRate(regionCode, 0.15)",
					"+const total = calculateTotal(items, taxRate, 120)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"const taxRate = computeTaxRate(regionCode, 0.12)",
					"const total = calculateTotal(items, taxRate, 100)",
				],
				{
					id: "partial-literals",
					generatedEventId: "generated-partial-literals",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0].matchStrategy).toBe("partial")
			expect(events[0].matchConfidence).toBeGreaterThanOrEqual(0.88)
			expect(events[0].matchConfidence).toBeLessThan(1)
			expect(events[0].equivalentLineCount).toBeGreaterThan(1.8)
			expect(events[0].equivalentLineCount).toBeLessThan(2)
		})

		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("attributes block matches when formatting changes inside a multi-line block", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,2 @@",
					"+const total = calculateTotal(items, taxRate)",
					"+return formatCurrency(total, currencyCode)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				["const  total = calculateTotal(items, taxRate)", "return  formatCurrency(total, currencyCode)"],
				{
					id: "partial-formatting",
					generatedEventId: "generated-partial-formatting",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				matchStrategy: "partial",
				matchConfidence: 1,
				equivalentLineCount: 2,
			})
		})
	})

	it("attributes a single-line partial match when similarity exceeds the isolated threshold", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+return formatCurrency(total, currencyCode)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "single-line-partial",
				generatedEventId: "generated-single-line-partial",
				rawLine: "return formatCurrency(total,currencyCode)",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				matchStrategy: "partial",
				lineCount: 1,
				codeSnippet: "return formatCurrency(total, currencyCode)",
			})
			expect(events[0].matchConfidence).toBeGreaterThanOrEqual(0.95)
			expect(events[0].equivalentLineCount).toBeGreaterThanOrEqual(0.95)
		})
	})

	it("supports mixed exact and partial attribution within the same original AI block", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,2 @@",
					"+const total=calculateTotal(items,taxRate)",
					"+return formatCurrency(total, currencyCode)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				["const total=calculateTotal(items,taxRate)", "return formatCurrency(total,currencyCode)"],
				{
					id: "mixed-block",
					generatedEventId: "generated-mixed-block",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({
				matchStrategy: "exact",
				lineCount: 1,
				codeSnippet: "const total=calculateTotal(items,taxRate)",
			})
			expect(events[1]).toMatchObject({
				matchStrategy: "partial",
				lineCount: 1,
				codeSnippet: "return formatCurrency(total, currencyCode)",
			})
		})
	})

	it("matches sparse partial candidates when blank lines create added-order gaps", () => {
		const matcher = new AiCodeCommitPartialMatcher()
		const pendingLines = buildPendingBlock(
			["const total=calculateTotal(items,taxRate)", "return formatCurrency(total,currencyCode)"],
			{
				id: "sparse-gap",
				generatedEventId: "generated-sparse-gap",
				filePath: "/repo/src/a.ts",
				relativePath: "src/a.ts",
				repoRelativePath: "src/a.ts",
			},
		)

		const partialMatches = matcher.matchPartialPendingBlocks({
			repoRoot: "/repo",
			filePath: "src/a.ts",
			addedLines: [
				{ index: 0, lineNumber: 1, content: "" },
				{ index: 1, lineNumber: 2, content: "const total = calculateTotal(items, taxRate)" },
				{ index: 2, lineNumber: 3, content: "" },
				{ index: 3, lineNumber: 4, content: "return formatCurrency(total, currencyCode)" },
			],
			pendingLines,
			matchedLineIds: new Set<string>(),
			commitOccurredAt: 1_772_500_000_000,
			config: DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
		})

		const matchedAddedIndexes = new Set(partialMatches.flatMap((match) => [...match.matchedAddedLineIndexes]))
		expect(matchedAddedIndexes).toEqual(new Set([1, 3]))
	})

	it("rechecks suspicious exact jumps with local partial matching", async () => {
		const committedCode = ["def add(a, b):", "    return a - b", "def subtractx(a, b):", "    return a - b"].join(
			"\n",
		)
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/test.py b/src/test.py",
					"--- a/src/test.py",
					"+++ b/src/test.py",
					"@@ -0,0 +1,4 @@",
					"+def add(a, b):",
					"+    return a - b",
					"+def subtractx(a, b):",
					"+    return a - b",
				].join("\n"),
			loadCommitFileContent: async () => `${committedCode}\n`,
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(["def add(a, b):", "    return a + b", "def subtract(a, b):", "    return a - b"], {
				id: "suspicious-exact-jump",
				generatedEventId: "generated-suspicious-exact-jump",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				repoRelativePath: "src/test.py",
				language: "python",
			}),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(10, undefined, 1_772_500_000_000)
			expect(events.some((event) => event.matchStrategy === "partial" && event.lineStart === 2)).toBe(true)
		})

		const events = await store.getRecentEvents(10, undefined, 1_772_500_000_000)
		const rewrittenReturn = events.find((event) => event.matchStrategy === "partial" && event.lineStart === 2)
		expect(rewrittenReturn).toMatchObject({
			filePath: "/repo/src/test.py",
			relativePath: "src/test.py",
			matchStrategy: "partial",
			lineStart: 2,
		})
		expect(rewrittenReturn?.codeSnippet).toContain("return a - b")
		expect(rewrittenReturn?.matchDetail).toMatchObject({
			scoreSource: "attribution",
			lineDetails: [
				expect.objectContaining({
					committedLineNumber: 2,
					generatedLineNumber: 2,
				}),
			],
		})
		expect(events.some((event) => event.matchStrategy === "exact" && event.lineStart === 2)).toBe(false)
	})

	it("does not merge out-of-order exact lines into a broad exact attribution block", async () => {
		const committedCode = [
			"def add(a, b):",
			"    return a - b",
			"",
			"",
			"def subtract(a, b):",
			'    """两数相减"""',
			"    # 哈哈哈",
			"    return a + b",
		].join("\n")
		const onCommitMatched = vi.fn(async (_payload: any) => {})
		const service = createService({
			onCommitMatched,
			loadCommitPatch: async () =>
				[
					"diff --git a/test.py b/test.py",
					"--- a/test.py",
					"+++ b/test.py",
					"@@ -0,0 +1,8 @@",
					"+def add(a, b):",
					"+    return a - b",
					"+",
					"+",
					"+def subtract(a, b):",
					'+    """两数相减"""',
					"+    # 哈哈哈",
					"+    return a + b",
				].join("\n"),
			loadCommitFileContent: async () => `${committedCode}\n`,
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"def add(a, b):",
					'    """两数相加"""',
					"    return a + b",
					"",
					"",
					"def subtract(a, b):",
					'    """两数相减"""',
					"    return a - b",
				],
				{
					id: "regression-84f3a6b8",
					generatedEventId: "generated-regression-84f3a6b8",
					filePath: "/repo/test.py",
					relativePath: "test.py",
					repoRelativePath: "test.py",
					language: "python",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "84f3a6b8",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(() => {
			expect(onCommitMatched).toHaveBeenCalledTimes(1)
		})

		const payload = onCommitMatched.mock.calls[0][0] as any
		const committedBlocks = payload.committedBlocks as AiCodeCommittedBlock[]
		expect(
			committedBlocks.some(
				(block) =>
					block.matchStrategy === "exact" &&
					block.relativePath === "test.py" &&
					block.lineStart === 1 &&
					block.lineEnd >= 6,
			),
		).toBe(false)
		expect(committedBlocks.some((block) => block.codeSnippet.includes("# 哈哈哈"))).toBe(false)
		expect(payload.changedFiles[0].changedBlocks[0].codeSnippet).toContain("# 哈哈哈")

		const partialBlocks = committedBlocks.filter((block) => block.matchStrategy === "partial")
		expect(partialBlocks.length).toBeGreaterThan(0)
		expect(
			partialBlocks.some(
				(block) =>
					typeof block.matchConfidence === "number" &&
					typeof block.equivalentLineCount === "number" &&
					block.matchDetail?.scoreSource === "attribution" &&
					(block.matchDetail.lineDetails?.length ?? 0) > 0,
			),
		).toBe(true)
	})

	it("handles suspicious exact fallback windows containing filtered blank lines", async () => {
		const committedCode = [
			"def add(a, b):",
			"    return a - b",
			"",
			"",
			"def subtract(a, b):",
			'    """hello"""',
			"    return a + b",
		].join("\n")
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/test.py b/src/test.py",
					"--- a/src/test.py",
					"+++ b/src/test.py",
					"@@ -0,0 +1,7 @@",
					"+def add(a, b):",
					"+    return a - b",
					"+",
					"+",
					"+def subtract(a, b):",
					'+    """hello"""',
					"+    return a + b",
				].join("\n"),
			loadCommitFileContent: async () => `${committedCode}\n`,
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"def add(a, b):",
					'    """两数相加"""',
					"    return a + b",
					"",
					"",
					"def subtract(a, b):",
					'    """两数相减"""',
					"    return a - b",
				],
				{
					id: "suspicious-exact-with-blanks",
					generatedEventId: "generated-suspicious-exact-with-blanks",
					filePath: "/repo/src/test.py",
					relativePath: "src/test.py",
					repoRelativePath: "src/test.py",
					language: "python",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
		})

		const events = await store.getRecentEvents(10, undefined, 1_772_500_000_000)
		expect(events.length).toBeGreaterThan(0)
		expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
	})

	it("does not attribute partial lines when competing candidates are ambiguous", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+return formatCurrency(total, currencyCode)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "ambiguous-1",
				generatedEventId: "generated-ambiguous-1",
				rawLine: "return formatCurrency(subtotal, currencyCode)",
			}),
			buildPendingLine({
				id: "ambiguous-2",
				generatedEventId: "generated-ambiguous-2",
				rawLine: "return formatCurrency(amount, currencyCode)",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
		})

		expect(await store.getRecentEvents(1, undefined, 1_772_500_000_000)).toHaveLength(0)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(2)
	})

	it("keeps generic short lines manual when they lack neighboring support", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+return;",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "generic-line",
				generatedEventId: "generated-generic-line",
				rawLine: "return",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
		})

		expect(await store.getRecentEvents(1, undefined, 1_772_500_000_000)).toHaveLength(0)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})

	it("keeps isolated short text lines manual when they lack neighboring support", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/test.py b/src/test.py",
					"--- a/src/test.py",
					"+++ b/src/test.py",
					"@@ -0,0 +1 @@",
					"+# 新说明",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "generic-text-line",
				generatedEventId: "generated-generic-text-line",
				rawLine: "# 说明",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				repoRelativePath: "src/test.py",
				language: "python",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
		})

		expect(await store.getRecentEvents(1, undefined, 1_772_500_000_000)).toHaveLength(0)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})

	it("keeps low-information manual comments out of partial attribution between exact neighbors", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/test.py b/src/test.py",
					"--- a/src/test.py",
					"+++ b/src/test.py",
					"@@ -0,0 +1,3 @@",
					"+def subtract(a, b):",
					"+    # 哈哈哈",
					"+    return a - b",
				].join("\n"),
			loadCommitFileContent: async () =>
				["def subtract(a, b):", "    # 哈哈哈", "    return a - b", ""].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(["def subtract(a, b):", '    """两数相减"""', "    return a - b"], {
				id: "manual-comment-between-exacts",
				generatedEventId: "generated-manual-comment-between-exacts",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				repoRelativePath: "src/test.py",
				language: "python",
			}),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
		})

		const events = await store.getRecentEvents(10, undefined, 1_772_500_000_000)
		expect(events.some((event) => event.codeSnippet.includes("# 哈哈哈"))).toBe(false)
		expect(events.every((event) => event.matchStrategy === "exact")).toBe(true)
	})

	it("matches Chinese comment lines through the text scorer", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/test.py b/src/test.py",
					"--- a/src/test.py",
					"+++ b/src/test.py",
					"@@ -0,0 +1 @@",
					"+# a两数相加函数",
				].join("\n"),
			loadCommitFileContent: async () => ["# a两数相加函数", ""].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "comment-line",
				generatedEventId: "generated-comment-line",
				rawLine: "# 两数相加函数",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				repoRelativePath: "src/test.py",
				language: "python",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				matchStrategy: "partial",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				lineStart: 1,
				lineEnd: 1,
				lineCount: 1,
				codeSnippet: "# a两数相加函数",
			})
		})

		const [event] = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
		expect(event?.matchConfidence).toBeGreaterThanOrEqual(0.8)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("matches Java doc comment blocks through the docstring scorer", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/Add.java b/src/Add.java",
					"--- a/src/Add.java",
					"+++ b/src/Add.java",
					"@@ -0,0 +1,7 @@",
					"+/**",
					"+ * a两数相加函数",
					"+ * 返回计算结果",
					"+ */",
					"+int add(int a, int b) {",
					"+    return a + b;",
					"+}",
				].join("\n"),
			loadCommitFileContent: async () =>
				[
					"/**",
					" * a两数相加函数",
					" * 返回计算结果",
					" */",
					"int add(int a, int b) {",
					"    return a + b;",
					"}",
					"",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"/**",
					" * 两数相加函数",
					" * 返回计算结果",
					" */",
					"int add(int a, int b) {",
					"    return a + b;",
					"}",
				],
				{
					id: "java-doc-comment-block",
					generatedEventId: "generated-java-doc-comment-block",
					filePath: "/repo/src/Add.java",
					relativePath: "src/Add.java",
					repoRelativePath: "src/Add.java",
					language: "java",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(7, undefined, 1_772_500_000_000)
			expect(
				events.some(
					(event) => event.matchStrategy === "partial" && event.codeSnippet.includes("a两数相加函数"),
				),
			).toBe(true)
		})

		const events = await store.getRecentEvents(7, undefined, 1_772_500_000_000)
		expect(
			events.some((event) => event.matchStrategy === "exact" && event.codeSnippet.includes("return a + b;")),
		).toBe(true)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("matches slash doc comments in C++ through the docstring scorer", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/add.cpp b/src/add.cpp",
					"--- a/src/add.cpp",
					"+++ b/src/add.cpp",
					"@@ -0,0 +1 @@",
					"+/// a两数相加函数",
				].join("\n"),
			loadCommitFileContent: async () => ["/// a两数相加函数", ""].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "cpp-doc-line",
				generatedEventId: "generated-cpp-doc-line",
				rawLine: "/// 两数相加函数",
				filePath: "/repo/src/add.cpp",
				relativePath: "src/add.cpp",
				repoRelativePath: "src/add.cpp",
				language: "cpp",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]?.matchStrategy).toBe("partial")
			expect(events[0]?.codeSnippet).toContain("a两数相加函数")
		})

		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("accepts a generic partial line when adjacent exact matches provide support", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/test.py b/src/test.py",
					"--- a/src/test.py",
					"+++ b/src/test.py",
					"@@ -0,0 +1,4 @@",
					"+def add(a, b):",
					'+    """a两数相加函数"""',
					"+    result = a + b",
					"+    return result",
				].join("\n"),
			loadCommitFileContent: async () =>
				["def add(a, b):", '    """a两数相加函数"""', "    result = a + b", "    return result", ""].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(["def add(a, b):", '    """两数相加函数"""', "    result = a + b", "    return result"], {
				id: "python-docstring-block",
				generatedEventId: "generated-python-docstring-block",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				repoRelativePath: "src/test.py",
				language: "python",
			}),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(3, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(3)
			expect(
				events.some(
					(event) => event.matchStrategy === "partial" && event.codeSnippet.includes("a两数相加函数"),
				),
			).toBe(true)
		})

		const events = await store.getRecentEvents(3, undefined, 1_772_500_000_000)
		const partialEvent = events.find((event) => event.matchStrategy === "partial")
		expect(partialEvent).toMatchObject({
			filePath: "/repo/src/test.py",
			relativePath: "src/test.py",
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: '    """a两数相加函数"""',
		})
		expect(partialEvent?.matchConfidence).toBeGreaterThanOrEqual(0.75)
		expect(partialEvent?.equivalentLineCount).toBeGreaterThanOrEqual(0.75)
		expect(partialEvent?.matchDetail).toMatchObject({
			scoreSource: "attribution",
			lineDetails: [
				expect.objectContaining({
					committedLineNumber: 2,
					generatedLineNumber: 2,
					overlapKind: "term",
				}),
			],
		})
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("matches markdown text outside fenced code blocks while keeping fenced code on the code path", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/docs/guide.md b/docs/guide.md",
					"--- a/docs/guide.md",
					"+++ b/docs/guide.md",
					"@@ -0,0 +1,5 @@",
					"+# a两数相加",
					"+- a计算两个整数之和",
					"+```python",
					"+def add(a, b):",
					"+```",
				].join("\n"),
			loadCommitFileContent: async () =>
				["# a两数相加", "- a计算两个整数之和", "```python", "def add(a, b):", "```", ""].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(["# 两数相加", "- 计算两个整数之和", "```python", "def add(a, b):", "```"], {
				id: "markdown-block",
				generatedEventId: "generated-markdown-block",
				filePath: "/repo/docs/guide.md",
				relativePath: "docs/guide.md",
				repoRelativePath: "docs/guide.md",
				language: "markdown",
			}),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(5, undefined, 1_772_500_000_000)
			expect(
				events.some((event) => event.matchStrategy === "partial" && event.codeSnippet.includes("# a两数相加")),
			).toBe(true)
			expect(
				events.some(
					(event) => event.matchStrategy === "partial" && event.codeSnippet.includes("a计算两个整数之和"),
				),
			).toBe(true)
		})

		const events = await store.getRecentEvents(5, undefined, 1_772_500_000_000)
		expect(
			events.some((event) => event.matchStrategy === "partial" && event.codeSnippet.includes("def add(a, b):")),
		).toBe(false)
		expect(
			events.some((event) => event.matchStrategy === "exact" && event.codeSnippet.includes("def add(a, b):")),
		).toBe(true)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("accepts partial blocks when three of five lines are adopted with high confidence", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1,3 @@",
					"+const subtotal = calculateSubtotal(items, discountRate)",
					"+const taxRate = computeTaxRate(regionCode, 0.15)",
					'+const summary = formatCurrency(subtotal, "USD", localeSetting)',
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"const subtotal=calculateSubtotal(items,discountRate)",
					"const taxRate = computeTaxRate(regionCode, 0.12)",
					'const summary = formatCurrency(subtotal,"USD",localeSetting)',
					'logger.info("checkout total", { subtotal, taxRate })',
					"return summary",
				],
				{
					id: "partial-coverage",
					generatedEventId: "generated-partial-coverage",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				matchStrategy: "partial",
				lineCount: 3,
			})
			expect(events[0].equivalentLineCount).toBeGreaterThan(2.9)
			expect(events[0].equivalentLineCount).toBeLessThan(3)
		})

		const pendingLines = await store.getPendingLineAttributions("/repo")
		expect(pendingLines).toHaveLength(2)
		expect(pendingLines.map((line) => line.blockLineIndex)).toEqual([4, 5])
	})

	it("supports partial attribution for renamed files", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/old.ts b/src/new.ts",
					"similarity index 90%",
					"rename from src/old.ts",
					"rename to src/new.ts",
					"--- a/src/old.ts",
					"+++ b/src/new.ts",
					"@@ -0,0 +1,2 @@",
					"+const total = calculateTotal(items, taxRate)",
					"+return formatCurrency(total, currencyCode)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				["const total=calculateTotal(items,taxRate)", "return formatCurrency(total,currencyCode)"],
				{
					id: "partial-rename",
					generatedEventId: "generated-partial-rename",
					filePath: "/repo/src/old.ts",
					relativePath: "src/old.ts",
					repoRelativePath: "src/old.ts",
				},
			),
		)

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				filePath: "/repo/src/new.ts",
				relativePath: "src/new.ts",
				matchStrategy: "partial",
				lineCount: 2,
			})
		})

		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
	})

	it("does not notify commit completion when patch loading fails", async () => {
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const loadCommitPatch = vi.fn(async () => {
			throw new Error("patch failed")
		})
		const service = createService({
			onCommitComparisonCompleted,
			loadCommitPatch,
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(() => {
			expect(loadCommitPatch).toHaveBeenCalledTimes(1)
		})

		expect(onCommitComparisonCompleted).not.toHaveBeenCalled()
		expect(await store.getRepoObservedCommit("/repo")).toBe("head-1")
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})

	it("matches renamed files and consumes duplicate hashes as a multiset", async () => {
		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/old.ts b/src/new.ts",
					"similarity index 90%",
					"rename from src/old.ts",
					"rename to src/new.ts",
					"--- a/src/old.ts",
					"+++ b/src/new.ts",
					"@@ -2,0 +2 @@",
					"+const duplicate = true",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				generatedEventId: "generated-rename",
				filePath: "/repo/src/old.ts",
				relativePath: "src/old.ts",
				repoRelativePath: "src/old.ts",
				lineHash: hashLineFingerprint("const duplicate = true"),
				occurrenceIndex: 1,
			}),
			buildPendingLine({
				id: "line-2",
				generatedEventId: "generated-rename",
				filePath: "/repo/src/old.ts",
				relativePath: "src/old.ts",
				repoRelativePath: "src/old.ts",
				lineHash: hashLineFingerprint("const duplicate = true"),
				occurrenceIndex: 2,
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "def456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				metricType: "committed",
				filePath: "/repo/src/new.ts",
				relativePath: "src/new.ts",
				lineCount: 1,
			})
		})

		const pendingLines = await store.getPendingLineAttributions("/repo")
		expect(pendingLines).toHaveLength(1)
		expect(pendingLines[0].id).toBe("line-2")
		expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
	})

	it("replays offline commits from the stored cursor in order and attributes the earliest matching commit", async () => {
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const loadCommitPatch = vi.fn(async (_repoRoot: string, previousCommit: string, newCommit: string) => {
			expect(previousCommit).toBe("")
			if (newCommit === "commit-a") {
				return [
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+const value = 1",
				].join("\n")
			}

			return [
				"diff --git a/src/a.ts b/src/a.ts",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -1 +1 @@",
				"+const value = 2",
			].join("\n")
		})

		await store.addPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				timestamp: new Date("2026-03-10T00:00:00.000Z").getTime(),
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])
		await store.setRepoObservedCommit("/repo", "cursor-0")

		const service = createService({
			onCommitComparisonCompleted,
			loadCommitPatch,
			getCurrentCommitSha: async () => "commit-b",
			listCommitsBetween: async () => ["commit-a", "commit-b"],
			loadCommitTimestamp: async (_repoRoot, commitHash) =>
				commitHash === "commit-a" ? 1_772_500_000_000 : 1_772_500_100_000,
		})

		await service.start()

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				metricType: "committed",
				commitHash: "commit-a",
				codeSnippet: "const value = 1",
			})
		})

		expect(loadCommitPatch).toHaveBeenCalledTimes(1)
		expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
		expect(watchers[0].disposed).toBe(true)
	})

	it("falls back to timestamp scan when no stored cursor exists", async () => {
		const listCommitsSinceTimestamp = vi.fn(async () => ["commit-a"])
		const pendingTimestamp = new Date("2026-03-11T08:00:00.000Z").getTime()

		await store.addPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				timestamp: pendingTimestamp,
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])

		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+const value = 1",
				].join("\n"),
			listCommitsSinceTimestamp,
		})

		await service.start()

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0].commitHash).toBe("commit-a")
		})

		expect(listCommitsSinceTimestamp).toHaveBeenCalledWith("/repo", pendingTimestamp)
	})

	it("falls back to timestamp scan when the stored cursor is no longer an ancestor", async () => {
		const listCommitsSinceTimestamp = vi.fn(async () => ["commit-fallback"])
		const listCommitsBetween = vi.fn(async () => [])

		await store.addPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				timestamp: new Date("2026-03-12T09:00:00.000Z").getTime(),
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])
		await store.setRepoObservedCommit("/repo", "old-cursor")

		const service = createService({
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -0,0 +1 @@",
					"+const value = 1",
				].join("\n"),
			isAncestor: async () => false,
			listCommitsBetween,
			listCommitsSinceTimestamp,
		})

		await service.start()

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0].commitHash).toBe("commit-fallback")
		})

		expect(listCommitsBetween).not.toHaveBeenCalled()
		expect(listCommitsSinceTimestamp).toHaveBeenCalledTimes(1)
	})

	it("syncs again on branch changes and catches up offline commits on the checked out branch", async () => {
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const getCurrentCommitSha = vi
			.fn(async (_repoRoot: string) => "head-old")
			.mockResolvedValueOnce("head-old")
			.mockResolvedValueOnce("head-new")
		const getCurrentBranch = vi
			.fn(async (_repoRoot: string) => "feature/old")
			.mockResolvedValueOnce("feature/old")
			.mockResolvedValueOnce("feature/new")
		const listCommitsBetween = vi.fn(async (_repoRoot: string, fromExclusive: string, toInclusive: string) => {
			if (fromExclusive === "head-old" && toInclusive === "head-new") {
				return ["offline-commit"]
			}
			return []
		})

		const service = createService({
			onCommitComparisonCompleted,
			loadCommitPatch: async (_repoRoot, _previousCommit, newCommit) =>
				newCommit === "offline-commit"
					? [
							"diff --git a/src/a.ts b/src/a.ts",
							"--- a/src/a.ts",
							"+++ b/src/a.ts",
							"@@ -0,0 +1 @@",
							"+const value = 1",
						].join("\n")
					: "",
			getCurrentCommitSha,
			getCurrentBranch,
			listCommitsBetween,
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])

		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("head-old")
		})

		watchers[0].emit({
			type: "branch-changed",
			previousBranch: "feature/old",
			newBranch: "feature/new",
			branch: "feature/new",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0].commitHash).toBe("offline-commit")
		})

		expect(listCommitsBetween).toHaveBeenCalledWith("/repo", "head-old", "head-new")
		expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
	})

	it("does not duplicate committed events when restarted with the same observed head", async () => {
		await store.addPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				lineHash: hashLineFingerprint("const value = 1"),
			}),
		])
		await store.setRepoObservedCommit("/repo", "head-1")

		const service1 = createService()
		await service1.start()
		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("head-1")
		})
		service1.stop()

		const service2 = createService()
		await service2.start()
		await vi.waitFor(async () => {
			expect(await store.getRepoObservedCommit("/repo")).toBe("head-1")
		})

		expect(await store.getRecentEvents(1, undefined, 1_772_500_000_000)).toHaveLength(0)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})

	it("matches the dense partial reference on deterministic random corpora", () => {
		const service = createService()

		for (let caseIndex = 0; caseIndex < 40; caseIndex += 1) {
			const pendingLines = buildRandomPendingBlock(caseIndex + 1, `generated-random-${caseIndex}`)
			const addedLines = buildRandomAddedLines(caseIndex + 1, pendingLines)

			const sparseResult = runPartialMatcherWithStrategy({
				service,
				pendingLines,
				addedLines,
				commitHash: `sparse-${caseIndex}`,
				useDenseReference: false,
			})
			const denseResult = runPartialMatcherWithStrategy({
				service,
				pendingLines,
				addedLines,
				commitHash: `dense-${caseIndex}`,
				useDenseReference: true,
			})

			expect(
				{
					matchedLineIds: sparseResult.matchedLineIds,
					committedBlocks: sparseResult.committedBlocks,
				},
				`random corpus case ${caseIndex}`,
			).toEqual({
				matchedLineIds: denseResult.matchedLineIds,
				committedBlocks: denseResult.committedBlocks,
			})
		}
	})

	it("matches the dense partial reference on text-focused corpora", () => {
		const service = createService()
		const textCases = [
			{
				name: "python-comments",
				filePath: "src/test.py",
				pendingLines: buildPendingBlock(["# 两数相加函数", "# 返回计算结果"], {
					id: "text-comment",
					blockId: "text-comment",
					generatedEventId: "generated-text-comment",
					filePath: "/repo/src/test.py",
					relativePath: "src/test.py",
					repoRelativePath: "src/test.py",
					language: "python",
				}),
				addedLines: ["# a两数相加函数", "# 返回计算结果并记录日志"],
			},
			{
				name: "python-docstring",
				filePath: "src/doc.py",
				pendingLines: buildPendingBlock(['"""两数相加函数"""', '"""返回计算结果"""'], {
					id: "text-docstring",
					blockId: "text-docstring",
					generatedEventId: "generated-text-docstring",
					filePath: "/repo/src/doc.py",
					relativePath: "src/doc.py",
					repoRelativePath: "src/doc.py",
					language: "python",
				}),
				addedLines: ['"""a两数相加函数"""', '"""返回计算结果并记录日志"""'],
			},
			{
				name: "markdown-text",
				filePath: "docs/guide.md",
				pendingLines: buildPendingBlock(["# 两数相加", "- 计算两个整数之和", "普通段落说明"], {
					id: "text-markdown",
					blockId: "text-markdown",
					generatedEventId: "generated-text-markdown",
					filePath: "/repo/docs/guide.md",
					relativePath: "docs/guide.md",
					repoRelativePath: "docs/guide.md",
					language: "markdown",
				}),
				addedLines: ["# a两数相加", "- a计算两个整数之和", "普通段落a说明"],
			},
		] as const

		for (const textCase of textCases) {
			const sparseResult = runPartialMatcherWithStrategy({
				service,
				pendingLines: textCase.pendingLines,
				addedLines: textCase.addedLines,
				filePath: textCase.filePath,
				commitHash: `sparse-${textCase.name}`,
				useDenseReference: false,
			})
			const denseResult = runPartialMatcherWithStrategy({
				service,
				pendingLines: textCase.pendingLines,
				addedLines: textCase.addedLines,
				filePath: textCase.filePath,
				commitHash: `dense-${textCase.name}`,
				useDenseReference: true,
			})

			expect(
				{
					matchedLineIds: sparseResult.matchedLineIds,
					committedBlocks: sparseResult.committedBlocks,
				},
				textCase.name,
			).toEqual({
				matchedLineIds: denseResult.matchedLineIds,
				committedBlocks: denseResult.committedBlocks,
			})
		}
	})

	it("matches inline-commented code lines when nested calls collapse into the final value", () => {
		const service = createService()
		const result = runPartialMatcherWithStrategy({
			service,
			filePath: "src/test.py",
			pendingLines: buildPendingBlock(["print(add(1, 2))  # 输出: 3", "print(add(5, 10))  # 输出: 15"], {
				id: "inline-print",
				blockId: "inline-print",
				generatedEventId: "generated-inline-print",
				filePath: "/repo/src/test.py",
				relativePath: "src/test.py",
				repoRelativePath: "src/test.py",
				language: "python",
			}),
			addedLines: ["print(add(3, 2))  # 输出: 5", "print(15)  # 输出: 15"],
			commitHash: "inline-comment-print-collapse",
			useDenseReference: false,
		})

		expect(result.matchedLineIds).toEqual(["inline-print-1", "inline-print-2"])
		expect(result.committedBlocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					lineStart: 2,
					lineEnd: 2,
					matchStrategy: "partial",
					codeSnippet: "print(15)  # 输出: 15",
				}),
			]),
		)
		expect(
			result.committedBlocks.find((block) => block.lineStart === 2 && block.lineEnd === 2)?.matchConfidence,
		).toBeGreaterThanOrEqual(0.65)
		const collapsedPrintBlock = result.committedBlocks.find((block) => block.lineStart === 2 && block.lineEnd === 2)
		expect(collapsedPrintBlock?.matchDetail).toMatchObject({
			scoreSource: "attribution",
			lineDetails: [
				expect.objectContaining({
					committedLineNumber: 2,
					generatedLineNumber: 2,
					adjustments: ["inline_comment_bonus"],
				}),
			],
		})
		expect(collapsedPrintBlock?.matchDetail?.baseScore).toBeLessThan(
			collapsedPrintBlock?.matchDetail?.finalScore ?? 0,
		)
	})

	it("falls back to the dense reference when sparse paths tie exactly", () => {
		const service = createService()
		const internal = service as unknown as InternalService
		const pendingLines = buildPendingBlock(
			["return formatCurrency(total, currencyCode)", "return formatCurrency(total, currencyCode)"],
			{
				id: "ambiguous-tie",
				blockId: "ambiguous-tie",
				generatedEventId: "generated-ambiguous-tie",
			},
		)
		const block = internal.buildPendingBlockCandidates(
			pendingLines,
			new Set<string>(),
			"src/a.ts",
			undefined,
			1_772_500_000_000,
		)[0]
		const addedLines = internal.buildAddedLineCandidates([
			{ index: 0, lineNumber: 1, content: "return formatCurrency(total, currencyCode)" },
			{ index: 1, lineNumber: 2, content: "const total = calculateTotal(items, taxRate)" },
			{ index: 2, lineNumber: 3, content: "const total = calculateTotal(items, taxRate)" },
		])
		const debugStats = createPartialDebugStats()

		const sparseResult = internal.alignPartialBlockCandidates(
			block,
			addedLines,
			DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
			debugStats,
		)
		const denseResult = internal.alignPartialBlockCandidatesDenseReference(
			block,
			addedLines,
			DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
			createPartialDebugStats(),
		)

		expect(debugStats.processedBlockCount).toBe(1)
		expect(debugStats.denseFallbackBlockCount).toBe(1)
		expect(
			sparseResult.map((candidate) => ({
				pendingLineId: candidate.pendingLine.id,
				addedIndex: candidate.addedLine.index,
				lineScore: candidate.lineScore,
			})),
		).toEqual(
			denseResult.map((candidate) => ({
				pendingLineId: candidate.pendingLine.id,
				addedIndex: candidate.addedLine.index,
				lineScore: candidate.lineScore,
			})),
		)
	})
})
