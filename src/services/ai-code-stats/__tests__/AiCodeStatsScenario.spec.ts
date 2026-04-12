import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { createTwoFilesPatch } from "diff"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AiCodeCommitAttributionService, type AiCodeCommitMatchedPayload } from "../AiCodeCommitAttributionService"
import { AiCodeDiffExtractor } from "../AiCodeDiffExtractor"
import { extractLineFeatures } from "../AiCodeLineFeatures"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import {
	type AiCodeCommittedBlock,
	type AiCodeGeneratedBlockState,
	type AiCodePendingLineAttribution,
	type AiCodeStatsEvent,
} from "../types"

class FakeWatcher {
	private handlers: Array<(event: any) => void> = []

	onEvent(handler: (event: any) => void) {
		this.handlers.push(handler)
	}

	async start(): Promise<void> {}

	dispose(): void {}

	emit(event: any): void {
		for (const handler of this.handlers) {
			handler(event)
		}
	}
}

const normalizeContentLines = (content: string): string[] => {
	const normalized = content.replace(/\r\n/g, "\n")
	const lines = normalized.split("\n")
	if (normalized.endsWith("\n")) {
		lines.pop()
	}
	return lines
}

const buildLineOccurrenceIndexes = (content: string): number[] => {
	const counts = new Map<string, number>()
	const indexes: number[] = []

	for (const line of normalizeContentLines(content)) {
		const lineHash = hashLineFingerprint(line)
		const nextIndex = (counts.get(lineHash) ?? 0) + 1
		counts.set(lineHash, nextIndex)
		indexes.push(nextIndex)
	}

	return indexes
}

const toCommittedEvent = (block: AiCodeCommittedBlock): AiCodeStatsEvent => ({
	eventId: block.eventId,
	generatedBlockId: block.generatedBlockId,
	timestamp: block.timestamp,
	sourceType: block.sourceType,
	ide: block.ide,
	metricType: "committed",
	userName: block.userName,
	userEmail: block.userEmail,
	organizationId: block.organizationId,
	organizationName: block.organizationName,
	sourceIp: block.sourceIp,
	workspaceName: block.workspaceName,
	workspacePath: block.workspacePath,
	projectKey: block.projectKey,
	filePath: block.filePath,
	relativePath: block.relativePath,
	language: block.language,
	gitRemoteUrl: block.gitRemoteUrl,
	gitBranch: block.gitBranch,
	lineStart: block.lineStart,
	lineEnd: block.lineEnd,
	lineCount: block.lineCount,
	codeSnippet: block.codeSnippet,
	fileSnapshotContent: block.fileSnapshotContent,
	taskId: block.taskId,
	commitHash: block.commitHash,
	commitOccurredAt: block.commitOccurredAt,
	matchStrategy: block.matchStrategy,
	matchConfidence: block.matchConfidence,
	equivalentLineCount: block.equivalentLineCount,
})

interface SeedWriteParams {
	label: string
	relativePath: string
	originalContent: string
	newContent: string
	taskId: string
	timestamp: number
}

interface CommitFileInput {
	relativePath: string
	originalContent: string
	committedContent: string
}

class ScenarioHarness {
	readonly repoRoot = "/repo"
	readonly workspaceName = "workspace"
	readonly workspacePath = "/workspace"
	readonly projectKey = "project-scenarios"
	readonly gitRemoteUrl = "https://github.com/example/project-scenarios.git"
	readonly branch = "feature/stats"

	readonly store: AiCodeStatsStore
	readonly service: AiCodeCommitAttributionService
	readonly matchedPayloads: AiCodeCommitMatchedPayload[] = []

	private readonly extractor = new AiCodeDiffExtractor()
	private readonly patches = new Map<string, string>()
	private readonly commitTimestamps = new Map<string, number>()
	private readonly commitSnapshots = new Map<string, Map<string, string>>()
	private watcher: FakeWatcher | null = null

	private constructor(store: AiCodeStatsStore, service: AiCodeCommitAttributionService) {
		this.store = store
		this.service = service
	}

	static async create(): Promise<ScenarioHarness> {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-scenarios-"))
		const store = new AiCodeStatsStore(tmpDir)
		let harness: ScenarioHarness
		const service = new AiCodeCommitAttributionService(store, {
			createWatcher: () => {
				harness.watcher = new FakeWatcher()
				return harness.watcher
			},
			loadCommitPatch: async (_repoRoot, _previousCommit, newCommit) => harness.patches.get(newCommit) ?? "",
			loadCommitTimestamp: async (_repoRoot, commitHash) =>
				harness.commitTimestamps.get(commitHash) ?? Date.now(),
			loadCommitFileContent: async (_repoRoot, commitHash, repoRelativePath) =>
				harness.commitSnapshots.get(commitHash)?.get(repoRelativePath),
			getCurrentBranch: async () => harness.branch,
			getCurrentCommitSha: async () => "head-1",
			isDetachedHead: async () => false,
			isAncestor: async () => true,
			listCommitsBetween: async () => [],
			listCommitsSinceTimestamp: async () => [],
			onCommitMatched: async (payload) => {
				harness.matchedPayloads.push(payload)
				if (payload.committedBlocks.length > 0) {
					await harness.store.appendHistoryEvents(
						payload.committedBlocks.map((block) => toCommittedEvent(block)),
					)
				}
				if (payload.matchedPendingLineIds.length > 0) {
					await harness.store.removePendingLineAttributions(payload.matchedPendingLineIds)
				}
			},
		})
		harness = new ScenarioHarness(store, service)
		await harness.service.start()
		return harness
	}

	async dispose(): Promise<void> {
		this.service.stop()
	}

	async seedAgentWrite(params: SeedWriteParams): Promise<AiCodeGeneratedBlockState[]> {
		const filePath = path.join(this.repoRoot, params.relativePath)
		const addedBlocks = this.extractor.extractAddedBlocks(
			params.originalContent,
			params.newContent,
			params.relativePath,
		)
		const lineOccurrenceIndexes = buildLineOccurrenceIndexes(params.newContent)
		const generatedBlocks = addedBlocks.map((block, index) => {
			const generatedBlockId = `${params.label}-generated-${index + 1}`
			const eventId = `${params.label}-event-${index + 1}`
			return {
				stateId: `${params.label}-state-${index + 1}`,
				eventId,
				generatedBlockId,
				timestamp: params.timestamp,
				sourceType: "agent_insert" as const,
				ide: "vscode" as const,
				workspaceName: this.workspaceName,
				workspacePath: this.workspacePath,
				projectKey: this.projectKey,
				filePath,
				relativePath: params.relativePath,
				repoRoot: this.repoRoot,
				repoRelativePath: params.relativePath,
				language: "python",
				gitRemoteUrl: this.gitRemoteUrl,
				gitBranch: this.branch,
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				lineCount: block.lineCount,
				codeSnippet: block.codeSnippet,
				fileSnapshotContent: params.newContent,
				taskId: params.taskId,
				uploadStatus: "pending" as const,
			}
		})
		const pendingLines = generatedBlocks.flatMap((block) =>
			this.buildPendingLineAttributions(block, lineOccurrenceIndexes),
		)

		await this.store.replaceGeneratedStateForContext({
			filePath,
			taskId: params.taskId,
			sourceType: "agent_insert",
			nextBlocks: generatedBlocks,
			nextPendingLines: pendingLines,
		})
		await this.service.refreshRepoTracking(this.repoRoot)
		return generatedBlocks
	}

	registerCommit(commitHash: string, occurredAt: number, files: CommitFileInput[]): void {
		this.commitTimestamps.set(commitHash, occurredAt)
		this.commitSnapshots.set(commitHash, new Map(files.map((file) => [file.relativePath, file.committedContent])))
		this.patches.set(
			commitHash,
			files
				.map((file) =>
					createTwoFilesPatch(
						`a/${file.relativePath}`,
						`b/${file.relativePath}`,
						file.originalContent,
						file.committedContent,
						"",
						"",
						{ context: 0 },
					),
				)
				.join("\n"),
		)
	}

	async emitCommit(commitHash: string, previousCommit: string): Promise<AiCodeCommitMatchedPayload> {
		const expectedCount = this.matchedPayloads.length + 1
		expect(this.watcher).toBeTruthy()
		this.watcher!.emit({
			type: "commit",
			previousCommit,
			newCommit: commitHash,
			branch: this.branch,
			isBaseBranch: false,
			watcher: this.watcher!,
			files: [],
		})

		await vi.waitFor(() => {
			expect(this.matchedPayloads).toHaveLength(expectedCount)
		})

		return this.matchedPayloads.at(-1)!
	}

	async getCommittedEvents(commitHash: string): Promise<AiCodeStatsEvent[]> {
		const events = await this.store.getRecentEvents(365, undefined, 1_776_400_000_000)
		return events.filter((event) => event.metricType === "committed" && event.commitHash === commitHash)
	}

	async getPendingLines(relativePath?: string): Promise<AiCodePendingLineAttribution[]> {
		const lines = await this.store.getPendingLineAttributions(this.repoRoot)
		return relativePath ? lines.filter((line) => line.relativePath === relativePath) : lines
	}

	async getGeneratedBlocks(relativePath?: string): Promise<AiCodeGeneratedBlockState[]> {
		const blocks = await this.store.getGeneratedBlocksForTests()
		return relativePath ? blocks.filter((block) => block.relativePath === relativePath) : blocks
	}

	private buildPendingLineAttributions(
		block: AiCodeGeneratedBlockState,
		lineOccurrenceIndexes: number[],
	): AiCodePendingLineAttribution[] {
		const lines = normalizeContentLines(block.codeSnippet)
		return lines.map((line, index) => {
			const lineNumber = block.lineStart + index
			const occurrenceIndex = lineOccurrenceIndexes[lineNumber - 1] ?? index + 1
			const lineFeatures = extractLineFeatures(line)
			return {
				id: `${block.generatedBlockId}-line-${index + 1}`,
				generatedEventId: block.generatedBlockId,
				blockId: block.generatedBlockId,
				timestamp: block.timestamp,
				sourceType: block.sourceType,
				ide: block.ide,
				workspaceName: block.workspaceName,
				workspacePath: block.workspacePath,
				projectKey: block.projectKey,
				filePath: block.filePath,
				relativePath: block.relativePath,
				repoRoot: block.repoRoot || this.repoRoot,
				repoRelativePath: block.repoRelativePath || block.relativePath,
				language: block.language,
				gitRemoteUrl: block.gitRemoteUrl,
				gitBranch: block.gitBranch,
				taskId: block.taskId,
				rawLine: lineFeatures.rawLine,
				blockLineIndex: index + 1,
				blockLineCount: lines.length,
				lineHash: hashLineFingerprint(line),
				occurrenceIndex,
				normalizedLine: lineFeatures.normalizedLine,
				normalizedTokenLine: lineFeatures.normalizedTokenLine,
				rareIdentifiers: lineFeatures.rareIdentifiers,
			}
		})
	}
}

describe("AiCodeStatsScenario", () => {
	const harnesses: ScenarioHarness[] = []

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()!.dispose()
		}
	})

	it("covers the user-style three-commit python flow across exact and partial matches", async () => {
		const harness = await ScenarioHarness.create()
		harnesses.push(harness)

		const commit1Content = ["def alpha():", '    return "alpha"', "def beta():", '    return "beta"'].join("\n")
		const commit1Blocks = await harness.seedAgentWrite({
			label: "commit-1",
			relativePath: "a.py",
			originalContent: "",
			newContent: commit1Content,
			taskId: "task-a",
			timestamp: 1_776_000_000_000,
		})

		expect(commit1Blocks).toHaveLength(1)
		expect(await harness.getGeneratedBlocks("a.py")).toHaveLength(1)

		harness.registerCommit("commit-1", 1_776_000_010_000, [
			{
				relativePath: "a.py",
				originalContent: "",
				committedContent: commit1Content,
			},
		])

		const payload1 = await harness.emitCommit("commit-1", "")
		expect(payload1.changedFiles).toHaveLength(1)
		expect(payload1.committedBlocks).toHaveLength(1)
		expect(payload1.committedBlocks[0]).toMatchObject({
			relativePath: "a.py",
			lineStart: commit1Blocks[0].lineStart,
			lineEnd: commit1Blocks[0].lineEnd,
			lineCount: commit1Blocks[0].lineCount,
			matchStrategy: "exact",
			matchConfidence: 1,
			equivalentLineCount: commit1Blocks[0].lineCount,
		})
		expect(await harness.getPendingLines("a.py")).toHaveLength(0)
		expect(await harness.getCommittedEvents("commit-1")).toHaveLength(1)

		const commit2Content = [
			"def alpha():",
			'    return "alpha"',
			"def gamma():",
			'    return "gamma"',
			"def beta():",
			'    return "beta"',
			"def omega():",
			'    return "omega"',
		].join("\n")
		const commit2Blocks = await harness.seedAgentWrite({
			label: "commit-2",
			relativePath: "a.py",
			originalContent: commit1Content,
			newContent: commit2Content,
			taskId: "task-a",
			timestamp: 1_776_000_020_000,
		})

		expect(commit2Blocks).toHaveLength(2)
		expect(await harness.getGeneratedBlocks("a.py")).toHaveLength(2)

		harness.registerCommit("commit-2", 1_776_000_030_000, [
			{
				relativePath: "a.py",
				originalContent: commit1Content,
				committedContent: commit2Content,
			},
		])

		const payload2 = await harness.emitCommit("commit-2", "commit-1")
		expect(payload2.changedFiles).toHaveLength(1)
		expect(payload2.changedFiles[0].changedBlocks).toHaveLength(2)
		expect(payload2.committedBlocks).toHaveLength(2)
		expect(
			payload2.committedBlocks.map((block) => ({
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				lineCount: block.lineCount,
				matchStrategy: block.matchStrategy,
				equivalentLineCount: block.equivalentLineCount,
				matchConfidence: block.matchConfidence,
			})),
		).toEqual(
			commit2Blocks.map((block) => ({
				lineStart: block.lineStart,
				lineEnd: block.lineEnd,
				lineCount: block.lineCount,
				matchStrategy: "exact",
				equivalentLineCount: block.lineCount,
				matchConfidence: 1,
			})),
		)
		expect(await harness.getPendingLines("a.py")).toHaveLength(0)
		expect(await harness.getCommittedEvents("commit-2")).toHaveLength(2)

		const commit3AContent = [
			"def alpha():",
			'    return "alpha"',
			"def gamma():",
			'    return "gamma"',
			"def beta():",
			'    return "beta"',
			"def omega():",
			'    return "omega"',
			"def epsilon():",
			'    return "epsilon"',
		].join("\n")
		const commit3BGenerated = [
			"subtotal = calculate_subtotal(items, discount_rate)",
			"tax_rate = compute_tax_rate(region_code, 0.12)",
			'summary = format_currency(subtotal, "USD", locale_setting)',
			'logger.info("checkout total", {"subtotal": subtotal, "tax_rate": tax_rate})',
			"return summary",
			"",
		].join("\n")
		const commit3BCommitted = [
			"subtotal = calculate_subtotal(items, discountRate)",
			"tax_rate = compute_tax_rate(region_code, 0.15)",
			'summary = format_currency(subtotal, "USD", localeSetting)',
			"",
		].join("\n")

		const commit3ABlocks = await harness.seedAgentWrite({
			label: "commit-3-a",
			relativePath: "a.py",
			originalContent: commit2Content,
			newContent: commit3AContent,
			taskId: "task-a",
			timestamp: 1_776_000_040_000,
		})
		const commit3BBlocks = await harness.seedAgentWrite({
			label: "commit-3-b",
			relativePath: "b.py",
			originalContent: "",
			newContent: commit3BGenerated,
			taskId: "task-b",
			timestamp: 1_776_000_041_000,
		})

		expect(commit3ABlocks).toHaveLength(1)
		expect(commit3BBlocks).toHaveLength(1)
		expect(await harness.getGeneratedBlocks()).toHaveLength(2)

		harness.registerCommit("commit-3", 1_776_000_050_000, [
			{
				relativePath: "a.py",
				originalContent: commit2Content,
				committedContent: commit3AContent,
			},
			{
				relativePath: "b.py",
				originalContent: "",
				committedContent: commit3BCommitted,
			},
		])

		const payload3 = await harness.emitCommit("commit-3", "commit-2")
		expect(payload3.changedFiles).toHaveLength(2)

		const exactBlock = payload3.committedBlocks.find((block) => block.relativePath === "a.py")
		const partialBlocks = payload3.committedBlocks.filter((block) => block.relativePath === "b.py")

		expect(exactBlock).toMatchObject({
			lineStart: commit3ABlocks[0].lineStart,
			lineEnd: commit3ABlocks[0].lineEnd,
			lineCount: commit3ABlocks[0].lineCount,
			matchStrategy: "exact",
			matchConfidence: 1,
			equivalentLineCount: commit3ABlocks[0].lineCount,
		})
		expect(partialBlocks.length).toBeGreaterThanOrEqual(1)
		expect(partialBlocks.every((block) => block.matchStrategy === "partial")).toBe(true)
		expect(partialBlocks.reduce((total, block) => total + block.lineCount, 0)).toBe(3)
		const partialEquivalentLines = partialBlocks.reduce(
			(total, block) => total + (block.equivalentLineCount ?? 0),
			0,
		)
		expect(partialEquivalentLines).toBeGreaterThan(2.75)
		expect(partialEquivalentLines).toBeLessThan(3)
		expect(
			partialBlocks.every((block) => typeof block.matchConfidence === "number" && block.matchConfidence > 0.88),
		).toBe(true)

		const remainingPendingB = await harness.getPendingLines("b.py")
		expect(remainingPendingB).toHaveLength(2)
		expect(remainingPendingB.map((line) => line.blockLineIndex)).toEqual([4, 5])
		expect(await harness.getCommittedEvents("commit-3")).toHaveLength(payload3.committedBlocks.length)
	})

	it("does not attribute a generated python block after the user deletes it before commit", async () => {
		const harness = await ScenarioHarness.create()
		harnesses.push(harness)

		const aiGenerated = ["def generated_helper():", '    return "from-ai"', ""].join("\n")
		const manualCommitted = ["def manual_helper():", '    return "manual"', ""].join("\n")

		await harness.seedAgentWrite({
			label: "deleted-before-commit",
			relativePath: "deleted.py",
			originalContent: "",
			newContent: aiGenerated,
			taskId: "task-delete",
			timestamp: 1_776_100_000_000,
		})
		expect(await harness.getGeneratedBlocks("deleted.py")).toHaveLength(1)

		harness.registerCommit("commit-delete", 1_776_100_010_000, [
			{
				relativePath: "deleted.py",
				originalContent: "",
				committedContent: manualCommitted,
			},
		])

		const payload = await harness.emitCommit("commit-delete", "commit-3")
		expect(payload.changedFiles).toHaveLength(1)
		expect(payload.committedBlocks).toHaveLength(0)
		expect(await harness.getCommittedEvents("commit-delete")).toHaveLength(0)
		expect(await harness.getPendingLines("deleted.py")).toHaveLength(2)
	})

	it("keeps adjacent manual edits and manual-only files out of committed attribution", async () => {
		const harness = await ScenarioHarness.create()
		harnesses.push(harness)

		const aiContent = ["def ai_only():", '    return "ai"', ""].join("\n")
		const committedContent = [
			"def ai_only():",
			'    return "ai"',
			"",
			"def manual_neighbor():",
			'    return "manual"',
			"",
		].join("\n")
		const manualOnlyContent = ["def notes_entry():", '    return "manual-only"', ""].join("\n")

		await harness.seedAgentWrite({
			label: "manual-neighbor",
			relativePath: "a.py",
			originalContent: "",
			newContent: aiContent,
			taskId: "task-manual-neighbor",
			timestamp: 1_776_200_000_000,
		})

		harness.registerCommit("commit-manual-neighbor", 1_776_200_010_000, [
			{
				relativePath: "a.py",
				originalContent: "",
				committedContent,
			},
			{
				relativePath: "notes.py",
				originalContent: "",
				committedContent: manualOnlyContent,
			},
		])

		const payload = await harness.emitCommit("commit-manual-neighbor", "commit-delete")
		expect(payload.changedFiles).toHaveLength(2)
		expect(payload.committedBlocks).toHaveLength(1)
		expect(payload.committedBlocks[0]).toMatchObject({
			relativePath: "a.py",
			matchStrategy: "exact",
			lineStart: 1,
			lineEnd: 2,
			lineCount: 2,
		})
		expect(payload.changedFiles.find((file) => file.relativePath === "a.py")!.changedBlocks[0]).toMatchObject({
			startLine: 1,
			endLine: 5,
			lineCount: 5,
		})
		expect(payload.changedFiles.find((file) => file.relativePath === "notes.py")!.changedBlocks[0]).toMatchObject({
			startLine: 1,
			endLine: 2,
			lineCount: 2,
		})
		expect(await harness.getCommittedEvents("commit-manual-neighbor")).toHaveLength(1)
		expect(await harness.getPendingLines("a.py")).toHaveLength(0)
	})

	it("treats trailing-whitespace differences as normalized exact matches", async () => {
		const harness = await ScenarioHarness.create()
		harnesses.push(harness)

		const aiContent = ["def spaced():", '    return "same"', ""].join("\n")
		const committedContent = ["def spaced():   ", '    return "same"    ', ""].join("\n")

		await harness.seedAgentWrite({
			label: "normalized-exact",
			relativePath: "normalized.py",
			originalContent: "",
			newContent: aiContent,
			taskId: "task-normalized",
			timestamp: 1_776_300_000_000,
		})

		harness.registerCommit("commit-normalized-exact", 1_776_300_010_000, [
			{
				relativePath: "normalized.py",
				originalContent: "",
				committedContent,
			},
		])

		const payload = await harness.emitCommit("commit-normalized-exact", "commit-manual-neighbor")
		expect(payload.committedBlocks).toHaveLength(1)
		expect(payload.committedBlocks[0]).toMatchObject({
			relativePath: "normalized.py",
			matchStrategy: "exact",
			matchConfidence: 1,
			lineCount: 2,
			equivalentLineCount: 2,
		})
		expect(await harness.getPendingLines("normalized.py")).toHaveLength(0)
	})

	it("does not treat eof carry-over lines as newly generated on a later append", async () => {
		const harness = await ScenarioHarness.create()
		harnesses.push(harness)

		const firstAiContent = [
			"def add(a, b):",
			'    """add"""',
			"    return a + b",
			"",
			"",
			"def subtract(a, b):",
			'    """subtract"""',
			"    return a - b",
		].join("\n")

		await harness.seedAgentWrite({
			label: "eof-initial",
			relativePath: "test.py",
			originalContent: "",
			newContent: firstAiContent,
			taskId: "task-eof",
			timestamp: 1_776_400_000_000,
		})

		harness.registerCommit("commit-eof-1", 1_776_400_010_000, [
			{
				relativePath: "test.py",
				originalContent: "",
				committedContent: firstAiContent,
			},
		])
		await harness.emitCommit("commit-eof-1", "")

		const secondAiContent = [
			firstAiContent,
			"",
			"",
			"def multiply(a, b):",
			'    """multiply"""',
			"    return a * b",
		].join("\n")

		const secondGeneratedBlocks = await harness.seedAgentWrite({
			label: "eof-append",
			relativePath: "test.py",
			originalContent: firstAiContent,
			newContent: secondAiContent,
			taskId: "task-eof",
			timestamp: 1_776_400_020_000,
		})

		expect(secondGeneratedBlocks).toHaveLength(1)
		expect(secondGeneratedBlocks[0].codeSnippet).toContain("def multiply(a, b):")
		expect(secondGeneratedBlocks[0].codeSnippet).not.toContain("return a - b")

		const committedSecondContent = [
			"def add(a, b):",
			"    return a + b",
			"",
			"",
			"def subtract(a, b):",
			'    """subtract updated"""',
			"    return a - b",
			"",
			"",
			"def multiply(a, b):",
			'    """multiply"""',
			"    return a * b",
		].join("\n")

		harness.registerCommit("commit-eof-2", 1_776_400_030_000, [
			{
				relativePath: "test.py",
				originalContent: firstAiContent,
				committedContent: committedSecondContent,
			},
		])

		const payload = await harness.emitCommit("commit-eof-2", "commit-eof-1")
		expect(payload.committedBlocks).toHaveLength(1)
		expect(payload.committedBlocks[0]).toMatchObject({
			relativePath: "test.py",
			matchStrategy: "exact",
		})
		expect(payload.committedBlocks[0].codeSnippet).toContain("def multiply(a, b):")
		expect(payload.committedBlocks[0].codeSnippet).not.toContain("return a - b")
		expect(payload.changedFiles).toHaveLength(1)
		expect(payload.changedFiles[0].changedBlocks[0].codeSnippet).toContain("return a - b")
	})
})
