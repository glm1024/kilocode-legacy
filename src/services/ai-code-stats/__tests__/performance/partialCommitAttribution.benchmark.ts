// Manual benchmark:
// pnpm exec tsx services/ai-code-stats/__tests__/performance/partialCommitAttribution.benchmark.ts

import assert from "node:assert/strict"
import * as fs from "fs/promises"
import Module from "module"
import * as os from "os"
import * as path from "path"
import { performance } from "perf_hooks"

import { extractLineFeatures } from "../../AiCodeLineFeatures"
import { hashLineFingerprint } from "../../AiCodeLineFingerprint"
import { AiCodeStatsStore } from "../../AiCodeStatsStore"
import { DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG } from "../../types"

type PendingLine = {
	id: string
	generatedEventId: string
	blockId: string
	timestamp: number
	sourceType: string
	ide: string
	workspaceName: string
	workspacePath: string
	projectKey: string
	filePath: string
	relativePath: string
	repoRoot: string
	repoRelativePath: string
	language: string
	gitRemoteUrl: string
	gitBranch: string
	taskId?: string
	blockLineIndex: number
	blockLineCount: number
	lineHash: string
	occurrenceIndex: number
	rawLine: string
	normalizedLine: string
	normalizedTokenLine: string
	rareIdentifiers: string[]
}

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

type BenchmarkCase = {
	name: string
	filePath: string
	previousFilePath?: string
	pendingLines: PendingLine[]
	addedLines: string[]
	iterations: number
}

type InternalService = {
	buildPendingBlockCandidates: (
		pendingLines: PendingLine[],
		matchedLineIds: Set<string>,
		currentFilePath: string,
		previousFilePath: string | undefined,
		commitOccurredAt: number,
	) => any[]
	buildAddedLineCandidates: (addedLines: InternalCommitAddedLine[], filePath?: string, language?: string) => any[]
	alignPartialBlockCandidates: (
		block: any,
		addedLines: any[],
		config: typeof DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
		debugStats?: InternalPartialDebugStats,
	) => any[]
	alignPartialBlockCandidatesDenseReference: (
		block: any,
		addedLines: any[],
		config: typeof DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
		debugStats?: InternalPartialDebugStats,
	) => any[]
	comparePartialCandidates: (left: any, right: any) => number
	buildCommittedBlocks: (
		matches: any[],
		branch: string,
		commitHash: string,
		commitOccurredAt: number,
		fileSnapshotContent?: string,
	) => Array<{
		generatedBlockId: string
		matchStrategy: string
		lineStart: number
		lineEnd: number
		lineCount: number
		codeSnippet: string
		matchConfidence: number
		equivalentLineCount: number
	}>
}

type ModuleLoader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown

const moduleWithLoad = Module as unknown as { _load: ModuleLoader }
const originalLoad = moduleWithLoad._load
moduleWithLoad._load = function patchedLoad(
	this: unknown,
	request: string,
	parent: NodeModule | null,
	isMain: boolean,
) {
	if (request === "vscode") {
		return {
			Disposable: class Disposable {
				dispose(): void {}
			},
		}
	}
	return originalLoad.call(this, request, parent, isMain)
}

const buildPendingLine = (overrides: Partial<PendingLine> = {}): PendingLine => ({
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

const buildPendingBlock = (lines: string[], overrides: Partial<PendingLine> = {}): PendingLine[] =>
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

const createSeededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0
		return state / 0x100000000
	}
}

const pickOne = <T>(random: () => number, values: T[]): T => values[Math.floor(random() * values.length)]!
const capitalize = (value: string): string => value.slice(0, 1).toUpperCase() + value.slice(1)

const buildChineseCommentLine = (index: number): string => {
	const topics = ["总额", "折扣", "税额", "边界条件", "异常场景", "返回结果"]
	const verbs = ["计算", "校验", "格式化", "记录", "更新", "处理"]
	return `# ${pickOne(createSeededRandom(index + 101), verbs)}${pickOne(createSeededRandom(index + 202), topics)}说明${index}`
}

const mutateChineseCommentLine = (line: string, index: number): string =>
	index % 2 === 0 ? line.replace(/^#\s*/, "# a") : line.replace(/说明/, "说明并记录")

const buildMarkdownTextLine = (index: number): string => {
	if (index % 3 === 0) {
		return `# 两数相加说明${index}`
	}
	if (index % 3 === 1) {
		return `- 计算两个整数之和并返回结果${index}`
	}
	return `普通段落说明${index}，用于描述参数和边界条件`
}

const mutateMarkdownTextLine = (line: string, index: number): string =>
	index % 2 === 0 ? line.replace(/说明/, "a说明") : line.replace(/^([#>\-]\s*)?/, "$1a")

const buildCodeLine = (random: () => number): string => {
	const identifiers = ["total", "subtotal", "amount", "receiptTotal", "discountRate", "taxRate"]
	const collections = ["items", "lineItems", "cartItems", "orderItems"]
	const regions = ["regionCode", "countryCode", "localeCode", "currencyCode"]
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

	return pickOne(random, templates)(
		pickOne(random, identifiers),
		pickOne(random, collections),
		pickOne(random, regions),
	)
}

const buildIndexedCodeLine = (index: number): string => {
	const bucket = index % 4
	if (bucket === 0) {
		return `const total${index} = calculateTotal(items${index % 9}, taxRate${index % 7})`
	}
	if (bucket === 1) {
		return `return formatCurrency(total${index - 1}, currencyCode, localeCode${index % 5})`
	}
	if (bucket === 2) {
		return `const normalized${index} = normalizeTotal(total${index - 2}, localeCode${index % 5})`
	}
	return `logger.info("total${index}", { total${index - 3}, localeCode${index % 5} })`
}

const mutateCodeLine = (random: () => number, line: string, mode: "dense" | "sparse"): string => {
	let next = line
	if (random() < 0.85) {
		next = next.replace(/,\s*/g, random() < 0.5 ? "," : ", ")
	}
	if (random() < 0.7) {
		next = next.replace(/\s*=\s*/g, random() < 0.5 ? "=" : " = ")
	}
	if (random() < 0.45) {
		next = next.replace(/\(\s*/g, "(").replace(/\s*\)/g, ")")
	}
	if (mode === "dense" && random() < 0.5) {
		next = next.replace(/\b(total|subtotal|amount)\b/, pickOne(random, ["total", "subtotal", "amount"]))
	}
	if (mode === "dense" && random() < 0.35) {
		next = next.replace(
			/\b(regionCode|countryCode|localeCode|currencyCode)\b/,
			pickOne(random, ["regionCode", "countryCode", "localeCode", "currencyCode"]),
		)
	}
	if (mode === "sparse" && random() < 0.2) {
		next = next.replace(/\b(total|subtotal|amount)\b/, "manualValue")
	}
	return next
}

const createPartialDebugStats = (): InternalPartialDebugStats => ({
	totalPairCount: 0,
	tokenLcsCount: 0,
	levenshteinCount: 0,
	positiveEdgeCount: 0,
	processedBlockCount: 0,
	denseFallbackBlockCount: 0,
})

const summarizeCommittedBlocks = (
	blocks: ReturnType<InternalService["buildCommittedBlocks"]>,
): Array<{
	generatedBlockId: string
	matchStrategy: string
	lineStart: number
	lineEnd: number
	lineCount: number
	codeSnippet: string
	matchConfidence: number
	equivalentLineCount: number
}> =>
	blocks.map((block) => ({
		generatedBlockId: block.generatedBlockId,
		matchStrategy: block.matchStrategy,
		lineStart: block.lineStart,
		lineEnd: block.lineEnd,
		lineCount: block.lineCount,
		codeSnippet: block.codeSnippet,
		matchConfidence: block.matchConfidence,
		equivalentLineCount: block.equivalentLineCount,
	}))

const runPartialMatcherWithStrategy = ({
	service,
	pendingLines,
	addedLines,
	filePath,
	previousFilePath,
	useDenseReference,
}: {
	service: InternalService
	pendingLines: PendingLine[]
	addedLines: string[]
	filePath: string
	previousFilePath?: string
	useDenseReference: boolean
}) => {
	const indexedAddedLines = addedLines.map((content, index) => ({
		index,
		lineNumber: index + 1,
		content,
	}))
	const debugStats = createPartialDebugStats()
	const blockCandidates = service.buildPendingBlockCandidates(
		pendingLines,
		new Set<string>(),
		filePath,
		previousFilePath,
		1_772_500_000_000,
	)
	const addedLineCandidates = service.buildAddedLineCandidates(indexedAddedLines, filePath)
	const lineCandidates = blockCandidates.flatMap((block) =>
		useDenseReference
			? service.alignPartialBlockCandidatesDenseReference(
					block,
					addedLineCandidates,
					DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
					debugStats,
				)
			: service.alignPartialBlockCandidates(
					block,
					addedLineCandidates,
					DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
					debugStats,
				),
	)

	const candidatesByAddedLine = new Map<number, any[]>()
	for (const candidate of lineCandidates) {
		const existing = candidatesByAddedLine.get(candidate.addedLine.index) ?? []
		existing.push(candidate)
		candidatesByAddedLine.set(candidate.addedLine.index, existing)
	}

	const eligibleCandidates: any[] = []
	for (const candidates of candidatesByAddedLine.values()) {
		const rankedCandidates = candidates.slice().sort((left, right) => service.comparePartialCandidates(left, right))
		const bestCandidate = rankedCandidates[0]
		if (!bestCandidate) {
			continue
		}

		const secondBestCandidate = rankedCandidates[1]
		if (
			secondBestCandidate &&
			bestCandidate.lineScore - secondBestCandidate.lineScore <
				DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG.ambiguityGap
		) {
			continue
		}

		const passesThreshold = bestCandidate.isGenericLine
			? bestCandidate.hasNeighborSupport &&
				bestCandidate.lineScore >= DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG.contextualMinLineScore
			: bestCandidate.lineScore >= DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG.isolatedMinLineScore ||
				(bestCandidate.hasNeighborSupport &&
					bestCandidate.lineScore >= DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG.contextualMinLineScore)
		if (!passesThreshold) {
			continue
		}

		eligibleCandidates.push(bestCandidate)
	}

	const usedAddedLineIndexes = new Set<number>()
	const usedPendingLineIds = new Set<string>()
	const acceptedMatches = eligibleCandidates
		.slice()
		.sort((left, right) => service.comparePartialCandidates(left, right))
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
			filePath: path.join("/repo", filePath),
			relativePath: filePath,
			matchStrategy: "partial" as const,
			lineScore: candidate.lineScore,
		}))
		.sort((left, right) => left.lineNumber - right.lineNumber)

	return {
		matchedLineIds: [...new Set(acceptedMatches.map((match) => match.pendingLine.id))].sort(),
		committedBlocks: summarizeCommittedBlocks(
			service.buildCommittedBlocks(
				acceptedMatches,
				"feature/stats",
				"benchmark-commit",
				1_772_500_000_000,
				"// committed snapshot",
			),
		),
		debugStats,
	}
}

const measureAverageDuration = (iterations: number, run: () => void): number => {
	for (let index = 0; index < 3; index += 1) {
		run()
	}

	const startedAt = performance.now()
	for (let index = 0; index < iterations; index += 1) {
		run()
	}
	return (performance.now() - startedAt) / iterations
}

const createDenseNearThresholdCase = (): BenchmarkCase => {
	const pendingLines = buildPendingBlock(
		Array.from({ length: 96 }, (_, index) => buildIndexedCodeLine(index)),
		{
			id: "dense-near-threshold",
			blockId: "dense-near-threshold",
			generatedEventId: "generated-dense-near-threshold",
		},
	)
	const random = createSeededRandom(11)
	const addedLines = pendingLines.map((line, index) =>
		mutateCodeLine(
			random,
			line.rawLine.replace(/total(\d+)/g, (_match, value) => `total${Number(value) + (index % 2)}`),
			"dense",
		),
	)

	return {
		name: "dense near-threshold",
		filePath: "src/a.ts",
		pendingLines,
		addedLines,
		iterations: 4,
	}
}

const createRealLikeSparseCase = (): BenchmarkCase => {
	const random = createSeededRandom(23)
	const pendingLines = buildPendingBlock(
		Array.from({ length: 36 }, () => buildCodeLine(random)),
		{
			id: "real-like-sparse",
			blockId: "real-like-sparse",
			generatedEventId: "generated-real-like-sparse",
		},
	)
	const manualDistractors = [
		"const manualValue = 1",
		"return manualValue",
		'logger.debug("manual branch")',
		"if (error) { return fallback }",
	]
	const addedLines = Array.from({ length: 44 }, (_, index) =>
		index % 3 === 0
			? mutateCodeLine(random, pendingLines[index % pendingLines.length]!.rawLine, "sparse")
			: pickOne(random, manualDistractors),
	)

	return {
		name: "real-like sparse",
		filePath: "src/a.ts",
		pendingLines,
		addedLines,
		iterations: 10,
	}
}

const createRenameCase = (): BenchmarkCase => {
	const pendingLines = buildPendingBlock(
		Array.from({ length: 72 }, (_, index) => buildIndexedCodeLine(index + 200)),
		{
			id: "rename-case",
			blockId: "rename-case",
			generatedEventId: "generated-rename-case",
			filePath: "/repo/src/old-name.ts",
			relativePath: "src/old-name.ts",
			repoRelativePath: "src/old-name.ts",
		},
	)
	const random = createSeededRandom(37)
	const addedLines = pendingLines.map((line, index) =>
		mutateCodeLine(
			random,
			line.rawLine.replace(/localeCode(\d+)/g, (_match, value) => `localeCode${(Number(value) + index) % 5}`),
			"dense",
		),
	)

	return {
		name: "rename case",
		filePath: "src/new-name.ts",
		previousFilePath: "src/old-name.ts",
		pendingLines,
		addedLines,
		iterations: 4,
	}
}

const createAmbiguousCase = (): BenchmarkCase => {
	const pendingLines = [
		...buildPendingBlock(
			[
				"return formatCurrency(total, currencyCode)",
				"return formatCurrency(total, currencyCode)",
				"return formatCurrency(amount, currencyCode)",
				"return formatCurrency(amount, currencyCode)",
			],
			{
				id: "ambiguous-a",
				blockId: "ambiguous-a",
				generatedEventId: "generated-ambiguous-a",
			},
		),
		...buildPendingBlock(
			[
				"const total = calculateTotal(items, taxRate)",
				"const total = calculateTotal(items, taxRate)",
				"return formatCurrency(total, currencyCode)",
				"return formatCurrency(total, currencyCode)",
			],
			{
				id: "ambiguous-b",
				blockId: "ambiguous-b",
				generatedEventId: "generated-ambiguous-b",
			},
		),
	]
	const addedLines = [
		"return formatCurrency(total, currencyCode)",
		"return formatCurrency(total, currencyCode)",
		"return formatCurrency(amount, currencyCode)",
		"return formatCurrency(amount, currencyCode)",
		"const total = calculateTotal(items, taxRate)",
		"const total = calculateTotal(items, taxRate)",
		"return formatCurrency(total, currencyCode)",
		"return formatCurrency(total, currencyCode)",
	]

	return {
		name: "ambiguous case",
		filePath: "src/a.ts",
		pendingLines,
		addedLines,
		iterations: 12,
	}
}

const createChineseCommentDenseCase = (): BenchmarkCase => {
	const pendingLines = buildPendingBlock(
		Array.from({ length: 64 }, (_, index) => buildChineseCommentLine(index)),
		{
			id: "comment-dense",
			blockId: "comment-dense",
			generatedEventId: "generated-comment-dense",
			filePath: "/repo/src/commented.py",
			relativePath: "src/commented.py",
			repoRelativePath: "src/commented.py",
			language: "python",
		},
	)
	const addedLines = pendingLines.map((line, index) => mutateChineseCommentLine(line.rawLine, index))

	return {
		name: "chinese comment dense",
		filePath: "src/commented.py",
		pendingLines,
		addedLines,
		iterations: 6,
	}
}

const createMarkdownTextSparseCase = (): BenchmarkCase => {
	const pendingLines = buildPendingBlock(
		Array.from({ length: 24 }, (_, index) => buildMarkdownTextLine(index)),
		{
			id: "markdown-sparse",
			blockId: "markdown-sparse",
			generatedEventId: "generated-markdown-sparse",
			filePath: "/repo/docs/guide.md",
			relativePath: "docs/guide.md",
			repoRelativePath: "docs/guide.md",
			language: "markdown",
		},
	)
	const distractors = ["# 手工标题", "- 人工补充说明", "普通段落说明，来自人工修改", "> 引用段落，来自人工修改"]
	const addedLines = Array.from({ length: 30 }, (_, index) =>
		index % 3 === 0
			? mutateMarkdownTextLine(pendingLines[index % pendingLines.length]!.rawLine, index)
			: distractors[index % distractors.length]!,
	)

	return {
		name: "markdown text sparse",
		filePath: "docs/guide.md",
		pendingLines,
		addedLines,
		iterations: 10,
	}
}

const main = async () => {
	const { AiCodeCommitAttributionService } = await import("../../AiCodeCommitAttributionService")
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-commit-benchmark-"))
	const store = new AiCodeStatsStore(tmpDir)
	const service = new AiCodeCommitAttributionService(store, {
		loadCommitPatch: async () => "",
		loadCommitTimestamp: async () => 1_772_500_000_000,
		loadCommitFileContent: async () => "// committed snapshot\n",
		getCurrentBranch: async () => "feature/stats",
		getCurrentCommitSha: async () => "head-1",
		isDetachedHead: async () => false,
		isAncestor: async () => true,
		listCommitsBetween: async () => [],
		listCommitsSinceTimestamp: async () => [],
	}) as unknown as InternalService

	const benchmarkCases = [
		createDenseNearThresholdCase(),
		createRealLikeSparseCase(),
		createRenameCase(),
		createAmbiguousCase(),
		createChineseCommentDenseCase(),
		createMarkdownTextSparseCase(),
	]

	console.log("")
	console.log(
		"| Case | Dense ms | Sparse ms | Speedup | Pairs | Token LCS | Levenshtein | Positive edges | Fallback ratio |",
	)
	console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

	for (const benchmarkCase of benchmarkCases) {
		const sparseBaseline = runPartialMatcherWithStrategy({
			service,
			pendingLines: benchmarkCase.pendingLines,
			addedLines: benchmarkCase.addedLines,
			filePath: benchmarkCase.filePath,
			previousFilePath: benchmarkCase.previousFilePath,
			useDenseReference: false,
		})
		const denseBaseline = runPartialMatcherWithStrategy({
			service,
			pendingLines: benchmarkCase.pendingLines,
			addedLines: benchmarkCase.addedLines,
			filePath: benchmarkCase.filePath,
			previousFilePath: benchmarkCase.previousFilePath,
			useDenseReference: true,
		})

		assert.deepStrictEqual(
			{
				matchedLineIds: sparseBaseline.matchedLineIds,
				committedBlocks: sparseBaseline.committedBlocks,
			},
			{
				matchedLineIds: denseBaseline.matchedLineIds,
				committedBlocks: denseBaseline.committedBlocks,
			},
			`${benchmarkCase.name} parity check failed`,
		)

		const denseMs = measureAverageDuration(benchmarkCase.iterations, () => {
			runPartialMatcherWithStrategy({
				service,
				pendingLines: benchmarkCase.pendingLines,
				addedLines: benchmarkCase.addedLines,
				filePath: benchmarkCase.filePath,
				previousFilePath: benchmarkCase.previousFilePath,
				useDenseReference: true,
			})
		})
		const sparseMs = measureAverageDuration(benchmarkCase.iterations, () => {
			runPartialMatcherWithStrategy({
				service,
				pendingLines: benchmarkCase.pendingLines,
				addedLines: benchmarkCase.addedLines,
				filePath: benchmarkCase.filePath,
				previousFilePath: benchmarkCase.previousFilePath,
				useDenseReference: false,
			})
		})
		const fallbackRatio =
			sparseBaseline.debugStats.processedBlockCount === 0
				? 0
				: sparseBaseline.debugStats.denseFallbackBlockCount / sparseBaseline.debugStats.processedBlockCount

		console.log(
			`| ${benchmarkCase.name} | ${denseMs.toFixed(2)} | ${sparseMs.toFixed(2)} | ${(denseMs / sparseMs).toFixed(2)} | ` +
				`${sparseBaseline.debugStats.totalPairCount} | ${sparseBaseline.debugStats.tokenLcsCount} | ` +
				`${sparseBaseline.debugStats.levenshteinCount} | ${sparseBaseline.debugStats.positiveEdgeCount} | ${fallbackRatio.toFixed(2)} |`,
		)
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
