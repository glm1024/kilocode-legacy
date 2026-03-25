// kilocode_change - new file

import crypto from "crypto"
import { exec as execCallback } from "child_process"
import * as path from "path"
import { promisify } from "util"

import { GitWatcher, type GitWatcherEvent } from "../../shared/GitWatcher"
import { getCurrentBranch, isDetachedHead } from "../code-index/managed/git-utils"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
import { computeLineSimilarity, extractLineFeatures, roundToFour } from "./AiCodeLineFeatures"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import {
	normalizePath,
	type AiCodeCommitMatchStrategy,
	type AiCodePendingLineAttribution,
	type AiCodeStatsEvent,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024

interface AiCodeCommitWatcher {
	onEvent(handler: (event: GitWatcherEvent) => void): void
	start(): Promise<void>
	dispose(): void
}

interface MatchedPendingLine {
	pendingLine: AiCodePendingLineAttribution
	lineNumber: number
	content: string
	filePath: string
	relativePath: string
	matchStrategy: AiCodeCommitMatchStrategy
	lineScore: number
}

interface CommitAddedLine {
	index: number
	lineNumber: number
	content: string
}

interface ExactMatchResult {
	matches: MatchedPendingLine[]
	matchedLineIds: Set<string>
	matchedBlockIds: Set<string>
	unmatchedAddedLines: CommitAddedLine[]
}

interface PendingBlockCandidate {
	blockId: string
	repoRelativePath: string
	filePath: string
	relativePath: string
	blockLineCount: number
	timestamp: number
	lines: AiCodePendingLineAttribution[]
}

interface PartialBlockMatchResult {
	matches: MatchedPendingLine[]
	matchedLineIds: Set<string>
	matchedAddedLineIndexes: Set<number>
	avgLineScore: number
	coverage: number
	equivalentLineCount: number
}

export interface AiCodeCommitAttributionServiceOptions {
	createWatcher?: (repoRoot: string) => AiCodeCommitWatcher
	loadCommitPatch?: (repoRoot: string, previousCommit: string, newCommit: string) => Promise<string>
	loadCommitTimestamp?: (repoRoot: string, commitHash: string) => Promise<number>
	getCurrentBranch?: (repoRoot: string) => Promise<string>
	getCurrentCommitSha?: (repoRoot: string) => Promise<string>
	isDetachedHead?: (repoRoot: string) => Promise<boolean>
	isAncestor?: (repoRoot: string, olderCommit: string, newerCommit: string) => Promise<boolean>
	listCommitsBetween?: (repoRoot: string, fromExclusive: string, toInclusive: string) => Promise<string[]>
	listCommitsSinceTimestamp?: (repoRoot: string, sinceTs: number) => Promise<string[]>
	onCommitComparisonCompleted?: () => Promise<void>
}

const defaultCreateWatcher = (repoRoot: string): AiCodeCommitWatcher => new GitWatcher({ cwd: repoRoot })

const splitGitOutputLines = (stdout: string): string[] =>
	stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)

const defaultLoadCommitPatch = async (repoRoot: string, previousCommit: string, newCommit: string): Promise<string> => {
	const command = previousCommit.trim()
		? `git diff --find-renames --unified=0 ${previousCommit} ${newCommit}`
		: `git show --format= --find-renames --unified=0 ${newCommit}`
	const { stdout } = await execAsync(command, {
		cwd: repoRoot,
		maxBuffer: EXEC_MAX_BUFFER_BYTES,
	})
	return stdout
}

const defaultLoadCommitTimestamp = async (repoRoot: string, commitHash: string): Promise<number> => {
	const { stdout } = await execAsync(`git show --format=%ct --no-patch ${commitHash}`, {
		cwd: repoRoot,
		maxBuffer: EXEC_MAX_BUFFER_BYTES,
	})
	const seconds = Number.parseInt(stdout.trim(), 10)
	return Number.isFinite(seconds) ? seconds * 1000 : Date.now()
}

const defaultGetCurrentCommitSha = async (repoRoot: string): Promise<string> => {
	const { stdout } = await execAsync("git rev-parse HEAD", {
		cwd: repoRoot,
		maxBuffer: EXEC_MAX_BUFFER_BYTES,
	})
	return stdout.trim()
}

const defaultIsAncestor = async (repoRoot: string, olderCommit: string, newerCommit: string): Promise<boolean> => {
	try {
		await execAsync(`git merge-base --is-ancestor ${olderCommit} ${newerCommit}`, {
			cwd: repoRoot,
			maxBuffer: EXEC_MAX_BUFFER_BYTES,
		})
		return true
	} catch (error) {
		if (typeof error === "object" && error && "code" in error && error.code === 1) {
			return false
		}

		throw error
	}
}

const defaultListCommitsBetween = async (
	repoRoot: string,
	fromExclusive: string,
	toInclusive: string,
): Promise<string[]> => {
	const { stdout } = await execAsync(`git rev-list --reverse ${fromExclusive}..${toInclusive}`, {
		cwd: repoRoot,
		maxBuffer: EXEC_MAX_BUFFER_BYTES,
	})
	return splitGitOutputLines(stdout)
}

const defaultListCommitsSinceTimestamp = async (repoRoot: string, sinceTs: number): Promise<string[]> => {
	const sinceIso = JSON.stringify(new Date(sinceTs).toISOString())
	const { stdout } = await execAsync(`git rev-list --reverse --since=${sinceIso} HEAD`, {
		cwd: repoRoot,
		maxBuffer: EXEC_MAX_BUFFER_BYTES,
	})
	return splitGitOutputLines(stdout)
}

const buildBucketKey = (repoRelativePath: string, lineHash: string) => `${repoRelativePath}\u0000${lineHash}`

interface CommitProcessResult {
	processed: boolean
	remainingPendingLines: number
}

export class AiCodeCommitAttributionService {
	private readonly watchers = new Map<string, AiCodeCommitWatcher>()
	private readonly repoQueues = new Map<string, Promise<void>>()
	private readonly extractor: AiCodeDiffExtractor
	private readonly createWatcher: (repoRoot: string) => AiCodeCommitWatcher
	private readonly loadCommitPatch: (repoRoot: string, previousCommit: string, newCommit: string) => Promise<string>
	private readonly loadCommitTimestamp: (repoRoot: string, commitHash: string) => Promise<number>
	private readonly getCurrentBranch: (repoRoot: string) => Promise<string>
	private readonly getCurrentCommitSha: (repoRoot: string) => Promise<string>
	private readonly getIsDetachedHead: (repoRoot: string) => Promise<boolean>
	private readonly isAncestor: (repoRoot: string, olderCommit: string, newerCommit: string) => Promise<boolean>
	private readonly listCommitsBetween: (
		repoRoot: string,
		fromExclusive: string,
		toInclusive: string,
	) => Promise<string[]>
	private readonly listCommitsSinceTimestamp: (repoRoot: string, sinceTs: number) => Promise<string[]>
	private readonly onCommitComparisonCompleted?: () => Promise<void>
	private started = false

	constructor(
		private readonly store: AiCodeStatsStore,
		options: AiCodeCommitAttributionServiceOptions = {},
	) {
		this.extractor = new AiCodeDiffExtractor()
		this.createWatcher = options.createWatcher ?? defaultCreateWatcher
		this.loadCommitPatch = options.loadCommitPatch ?? defaultLoadCommitPatch
		this.loadCommitTimestamp = options.loadCommitTimestamp ?? defaultLoadCommitTimestamp
		this.getCurrentBranch = options.getCurrentBranch ?? getCurrentBranch
		this.getCurrentCommitSha = options.getCurrentCommitSha ?? defaultGetCurrentCommitSha
		this.getIsDetachedHead = options.isDetachedHead ?? isDetachedHead
		this.isAncestor = options.isAncestor ?? defaultIsAncestor
		this.listCommitsBetween = options.listCommitsBetween ?? defaultListCommitsBetween
		this.listCommitsSinceTimestamp = options.listCommitsSinceTimestamp ?? defaultListCommitsSinceTimestamp
		this.onCommitComparisonCompleted = options.onCommitComparisonCompleted
	}

	async start(): Promise<void> {
		if (this.started) {
			return
		}

		this.started = true
		const pendingLines = await this.store.getPendingLineAttributions()
		const repoRoots = new Set(pendingLines.map((line) => line.repoRoot))
		for (const repoRoot of repoRoots) {
			await this.ensureWatcher(repoRoot)
		}
	}

	stop(): void {
		this.started = false
		for (const watcher of this.watchers.values()) {
			watcher.dispose()
		}
		this.watchers.clear()
		this.repoQueues.clear()
	}

	async registerPendingLineAttributions(lines: AiCodePendingLineAttribution[]): Promise<void> {
		if (lines.length === 0) {
			return
		}

		await this.store.addPendingLineAttributions(lines)
		if (!this.started) {
			return
		}

		const repoRoots = new Set(lines.map((line) => line.repoRoot))
		for (const repoRoot of repoRoots) {
			await this.ensureWatcher(repoRoot)
		}
	}

	private async ensureWatcher(repoRoot: string): Promise<void> {
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		if (this.watchers.has(normalizedRepoRoot)) {
			return
		}

		const watcher = this.createWatcher(normalizedRepoRoot)
		watcher.onEvent((event) => {
			void this.enqueueRepoWork(normalizedRepoRoot, async () => {
				if (event.type === "commit") {
					await this.handleCommitEvent(normalizedRepoRoot, event)
					return
				}

				if (event.type === "branch-changed") {
					await this.syncRepoToCurrentHead(normalizedRepoRoot)
				}
			})
		})
		await watcher.start()
		this.watchers.set(normalizedRepoRoot, watcher)
		void this.enqueueRepoWork(normalizedRepoRoot, async () => {
			await this.syncRepoToCurrentHead(normalizedRepoRoot)
		})
	}

	private async handleCommitEvent(
		repoRoot: string,
		event: Extract<GitWatcherEvent, { type: "commit" }>,
	): Promise<void> {
		if (!event.newCommit.trim()) {
			return
		}

		const result = await this.processCommit(repoRoot, event.branch, event.newCommit, event.previousCommit)
		if (!result.processed) {
			return
		}

		await this.notifyCommitComparisonCompleted()

		if (result.remainingPendingLines === 0) {
			return
		}

		await this.store.setRepoObservedCommit(repoRoot, event.newCommit)
	}

	private async syncRepoToCurrentHead(repoRoot: string): Promise<void> {
		const pendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (pendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return
		}

		try {
			if (await this.getIsDetachedHead(repoRoot)) {
				return
			}
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to determine HEAD state:", error)
			return
		}

		let currentCommit = ""
		let currentBranch = ""
		try {
			;[currentCommit, currentBranch] = await Promise.all([
				this.getCurrentCommitSha(repoRoot),
				this.getCurrentBranch(repoRoot),
			])
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to load current repository state:", error)
			return
		}

		if (!currentCommit.trim()) {
			return
		}

		const lastObservedCommit = await this.store.getRepoObservedCommit(repoRoot)
		const commitsToReplay = await this.resolveCommitsToReplay(
			repoRoot,
			pendingLines,
			lastObservedCommit,
			currentCommit,
		)
		if (commitsToReplay === null) {
			return
		}

		let replayProcessed = false
		for (const commitHash of commitsToReplay) {
			const result = await this.processCommit(repoRoot, currentBranch, commitHash, "")
			if (!result.processed) {
				return
			}

			replayProcessed = true

			if (result.remainingPendingLines === 0) {
				await this.notifyCommitComparisonCompleted()
				return
			}

			await this.store.setRepoObservedCommit(repoRoot, commitHash)
		}

		if (replayProcessed) {
			await this.notifyCommitComparisonCompleted()
		}

		const remainingPendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (remainingPendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return
		}

		await this.store.setRepoObservedCommit(repoRoot, currentCommit)
	}

	private buildPendingBuckets(
		pendingLines: AiCodePendingLineAttribution[],
	): Map<string, AiCodePendingLineAttribution[]> {
		const buckets = new Map<string, AiCodePendingLineAttribution[]>()

		for (const pendingLine of pendingLines) {
			const key = buildBucketKey(pendingLine.repoRelativePath, pendingLine.lineHash)
			const bucket = buckets.get(key) ?? []
			bucket.push(pendingLine)
			buckets.set(key, bucket)
		}

		for (const bucket of buckets.values()) {
			bucket.sort((left, right) => {
				if (left.timestamp !== right.timestamp) {
					return left.timestamp - right.timestamp
				}
				if (left.occurrenceIndex !== right.occurrenceIndex) {
					return left.occurrenceIndex - right.occurrenceIndex
				}
				return left.id.localeCompare(right.id)
			})
		}

		return buckets
	}

	private matchExactPendingLines(
		repoRoot: string,
		filePath: string,
		previousFilePath: string | undefined,
		addedLines: CommitAddedLine[],
		pendingBuckets: Map<string, AiCodePendingLineAttribution[]>,
	): ExactMatchResult {
		const currentFilePath = normalizePath(filePath)
		const previousPath = previousFilePath ? normalizePath(previousFilePath) : undefined
		const lookupPaths = [currentFilePath, previousPath].filter(Boolean) as string[]
		const absoluteFilePath = normalizePath(path.join(repoRoot, currentFilePath))
		const matches: MatchedPendingLine[] = []
		const matchedLineIds = new Set<string>()
		const matchedBlockIds = new Set<string>()
		const matchedAddedLineIndexes = new Set<number>()

		for (const addedLine of addedLines) {
			const lineHash = hashLineFingerprint(addedLine.content)
			let pendingLine: AiCodePendingLineAttribution | undefined

			for (const lookupPath of lookupPaths) {
				const bucket = pendingBuckets.get(buildBucketKey(lookupPath, lineHash))
				if (bucket && bucket.length > 0) {
					pendingLine = bucket.shift()
					break
				}
			}

			if (!pendingLine) {
				continue
			}

			matches.push({
				pendingLine,
				lineNumber: addedLine.lineNumber,
				content: addedLine.content,
				filePath: absoluteFilePath,
				relativePath: currentFilePath,
				matchStrategy: "exact",
				lineScore: 1,
			})
			matchedLineIds.add(pendingLine.id)
			matchedBlockIds.add(pendingLine.blockId || pendingLine.generatedEventId)
			matchedAddedLineIndexes.add(addedLine.index)
		}

		return {
			matches,
			matchedLineIds,
			matchedBlockIds,
			unmatchedAddedLines: addedLines.filter((line) => !matchedAddedLineIndexes.has(line.index)),
		}
	}

	private buildCommittedEvents(
		matches: MatchedPendingLine[],
		branch: string,
		commitHash: string,
		commitOccurredAt: number,
	): AiCodeStatsEvent[] {
		const events: AiCodeStatsEvent[] = []
		let currentBlock: {
			pendingLine: AiCodePendingLineAttribution
			filePath: string
			relativePath: string
			lineStart: number
			lineEnd: number
			lines: string[]
			matchStrategy: AiCodeCommitMatchStrategy
			scoreSum: number
			scoreCount: number
		} | null = null

		const flushCurrentBlock = () => {
			if (!currentBlock) {
				return
			}

			const pendingLine = currentBlock.pendingLine
			const equivalentLineCount = roundToFour(currentBlock.scoreSum)
			const matchConfidence = roundToFour(currentBlock.scoreSum / Math.max(currentBlock.scoreCount, 1))
			events.push({
				eventId: crypto.randomUUID(),
				timestamp: commitOccurredAt,
				sourceType: pendingLine.sourceType,
				ide: pendingLine.ide,
				metricType: "committed",
				userName: pendingLine.userName,
				userEmail: pendingLine.userEmail,
				organizationId: pendingLine.organizationId,
				organizationName: pendingLine.organizationName,
				sourceIp: pendingLine.sourceIp,
				workspaceName: pendingLine.workspaceName,
				workspacePath: pendingLine.workspacePath,
				projectKey: pendingLine.projectKey,
				filePath: currentBlock.filePath,
				relativePath: currentBlock.relativePath,
				language: pendingLine.language,
				gitRemoteUrl: pendingLine.gitRemoteUrl,
				gitBranch: branch || pendingLine.gitBranch,
				lineStart: currentBlock.lineStart,
				lineEnd: currentBlock.lineEnd,
				lineCount: currentBlock.lines.length,
				codeSnippet: currentBlock.lines.join("\n"),
				taskId: pendingLine.taskId,
				commitHash,
				commitOccurredAt,
				matchStrategy: currentBlock.matchStrategy,
				matchConfidence,
				equivalentLineCount,
			})
			currentBlock = null
		}

		for (const match of matches) {
			const nextAverageScore = currentBlock ? currentBlock.scoreSum / Math.max(currentBlock.scoreCount, 1) : 0
			const canExtendCurrentBlock =
				currentBlock &&
				currentBlock.pendingLine.blockId === match.pendingLine.blockId &&
				currentBlock.filePath === match.filePath &&
				currentBlock.lineEnd + 1 === match.lineNumber &&
				currentBlock.matchStrategy === match.matchStrategy &&
				Math.abs(nextAverageScore - match.lineScore) <= 0.02

			if (!canExtendCurrentBlock) {
				flushCurrentBlock()
				currentBlock = {
					pendingLine: match.pendingLine,
					filePath: match.filePath,
					relativePath: match.relativePath,
					lineStart: match.lineNumber,
					lineEnd: match.lineNumber,
					lines: [match.content],
					matchStrategy: match.matchStrategy,
					scoreSum: match.lineScore,
					scoreCount: 1,
				}
				continue
			}

			const activeBlock = currentBlock!
			activeBlock.lineEnd = match.lineNumber
			activeBlock.lines.push(match.content)
			activeBlock.scoreSum += match.lineScore
			activeBlock.scoreCount += 1
		}

		flushCurrentBlock()
		return events
	}

	private buildPendingBlockCandidates(
		pendingLines: AiCodePendingLineAttribution[],
		matchedLineIds: Set<string>,
		matchedBlockIds: Set<string>,
		currentFilePath: string,
		previousFilePath: string | undefined,
		commitOccurredAt: number,
	): PendingBlockCandidate[] {
		const lookupPaths = new Set([currentFilePath, previousFilePath].filter(Boolean) as string[])
		const candidates = new Map<string, PendingBlockCandidate>()

		for (const pendingLine of pendingLines) {
			if (matchedLineIds.has(pendingLine.id)) {
				continue
			}
			if (matchedBlockIds.has(pendingLine.blockId || pendingLine.generatedEventId)) {
				continue
			}
			if (pendingLine.timestamp > commitOccurredAt) {
				continue
			}
			if (!lookupPaths.has(pendingLine.repoRelativePath)) {
				continue
			}
			if (
				(pendingLine.normalizedLine || "").length === 0 ||
				(pendingLine.normalizedTokenLine || "").length === 0
			) {
				continue
			}

			const blockId = pendingLine.blockId || pendingLine.generatedEventId
			const existing = candidates.get(blockId)
			if (!existing) {
				candidates.set(blockId, {
					blockId,
					repoRelativePath: pendingLine.repoRelativePath,
					filePath: pendingLine.filePath,
					relativePath: currentFilePath,
					blockLineCount: Math.max(pendingLine.blockLineCount || 0, 1),
					timestamp: pendingLine.timestamp,
					lines: [pendingLine],
				})
				continue
			}

			existing.lines.push(pendingLine)
			existing.timestamp = Math.min(existing.timestamp, pendingLine.timestamp)
			existing.blockLineCount = Math.max(existing.blockLineCount, pendingLine.blockLineCount || 0)
		}

		return [...candidates.values()]
			.map((candidate) => ({
				...candidate,
				lines: candidate.lines
					.slice()
					.sort(
						(left, right) => left.blockLineIndex - right.blockLineIndex || left.id.localeCompare(right.id),
					),
			}))
			.filter((candidate) => candidate.lines.length >= 2 && candidate.blockLineCount >= 2)
	}

	private findBestPartialBlockMatch(
		repoRoot: string,
		block: PendingBlockCandidate,
		addedLines: CommitAddedLine[],
	): PartialBlockMatchResult | null {
		if (addedLines.length < 2 || block.lines.length < 2) {
			return null
		}

		const scores: number[][] = Array.from({ length: block.lines.length + 1 }, () =>
			new Array<number>(addedLines.length + 1).fill(0),
		)
		const decisions: Array<Array<"up" | "left" | "diag" | null>> = Array.from(
			{ length: block.lines.length + 1 },
			() => new Array<"up" | "left" | "diag" | null>(addedLines.length + 1).fill(null),
		)

		const lineScores = Array.from({ length: block.lines.length }, () =>
			new Array<number>(addedLines.length).fill(0),
		)

		for (let blockIndex = 1; blockIndex <= block.lines.length; blockIndex += 1) {
			for (let addedIndex = 1; addedIndex <= addedLines.length; addedIndex += 1) {
				const pendingLine = block.lines[blockIndex - 1]
				const addedLine = addedLines[addedIndex - 1]
				const similarity = computeLineSimilarity(pendingLine, extractLineFeatures(addedLine.content))
				const score = similarity.lineScore >= 0.85 ? similarity.lineScore : 0
				lineScores[blockIndex - 1][addedIndex - 1] = score

				const up = scores[blockIndex - 1][addedIndex]
				const left = scores[blockIndex][addedIndex - 1]
				const diagonal = score > 0 ? scores[blockIndex - 1][addedIndex - 1] + score : Number.NEGATIVE_INFINITY

				if (diagonal >= up && diagonal >= left) {
					scores[blockIndex][addedIndex] = diagonal
					decisions[blockIndex][addedIndex] = "diag"
				} else if (up >= left) {
					scores[blockIndex][addedIndex] = up
					decisions[blockIndex][addedIndex] = "up"
				} else {
					scores[blockIndex][addedIndex] = left
					decisions[blockIndex][addedIndex] = "left"
				}
			}
		}

		const alignedPairs: Array<{
			pendingLine: AiCodePendingLineAttribution
			addedLine: CommitAddedLine
			score: number
		}> = []
		let blockCursor = block.lines.length
		let addedCursor = addedLines.length
		while (blockCursor > 0 && addedCursor > 0) {
			const decision = decisions[blockCursor][addedCursor]
			if (decision === "diag") {
				const score = lineScores[blockCursor - 1][addedCursor - 1]
				if (score > 0) {
					alignedPairs.push({
						pendingLine: block.lines[blockCursor - 1],
						addedLine: addedLines[addedCursor - 1],
						score,
					})
				}
				blockCursor -= 1
				addedCursor -= 1
			} else if (decision === "up") {
				blockCursor -= 1
			} else {
				addedCursor -= 1
			}
		}

		alignedPairs.reverse()
		if (alignedPairs.length < 2) {
			return null
		}

		const scoreSum = alignedPairs.reduce((sum, pair) => sum + pair.score, 0)
		const avgLineScore = roundToFour(scoreSum / alignedPairs.length)
		const coverage = roundToFour(alignedPairs.length / Math.max(block.blockLineCount, 1))
		if (coverage < 0.6) {
			return null
		}
		if (avgLineScore < 0.88) {
			return null
		}
		if (coverage < 0.8 && avgLineScore < 0.92) {
			return null
		}

		const filePath = normalizePath(path.join(repoRoot, block.relativePath))
		return {
			matches: alignedPairs.map(({ pendingLine, addedLine, score }) => ({
				pendingLine,
				lineNumber: addedLine.lineNumber,
				content: addedLine.content,
				filePath,
				relativePath: block.relativePath,
				matchStrategy: "partial_block",
				lineScore: score,
			})),
			matchedLineIds: new Set(alignedPairs.map((pair) => pair.pendingLine.id)),
			matchedAddedLineIndexes: new Set(alignedPairs.map((pair) => pair.addedLine.index)),
			avgLineScore,
			coverage,
			equivalentLineCount: roundToFour(scoreSum),
		}
	}

	private matchPartialPendingBlocks(
		repoRoot: string,
		filePath: string,
		previousFilePath: string | undefined,
		addedLines: CommitAddedLine[],
		pendingLines: AiCodePendingLineAttribution[],
		matchedLineIds: Set<string>,
		matchedBlockIds: Set<string>,
		commitOccurredAt: number,
	): PartialBlockMatchResult[] {
		const currentFilePath = normalizePath(filePath)
		const previousPath = previousFilePath ? normalizePath(previousFilePath) : undefined
		let availableAddedLines = addedLines.slice()
		const acceptedMatches: PartialBlockMatchResult[] = []
		const blockCandidates = this.buildPendingBlockCandidates(
			pendingLines,
			matchedLineIds,
			matchedBlockIds,
			currentFilePath,
			previousPath,
			commitOccurredAt,
		)
		if (blockCandidates.length === 0) {
			return acceptedMatches
		}

		const remainingBlocks = new Map(blockCandidates.map((candidate) => [candidate.blockId, candidate]))
		while (availableAddedLines.length >= 2 && remainingBlocks.size > 0) {
			let bestCandidate: PartialBlockMatchResult | null = null
			let bestBlockId: string | null = null

			for (const block of remainingBlocks.values()) {
				const candidate = this.findBestPartialBlockMatch(repoRoot, block, availableAddedLines)
				if (!candidate) {
					continue
				}
				if (
					!bestCandidate ||
					candidate.avgLineScore > bestCandidate.avgLineScore ||
					(candidate.avgLineScore === bestCandidate.avgLineScore &&
						candidate.coverage > bestCandidate.coverage) ||
					(candidate.avgLineScore === bestCandidate.avgLineScore &&
						candidate.coverage === bestCandidate.coverage &&
						candidate.equivalentLineCount > bestCandidate.equivalentLineCount)
				) {
					bestCandidate = candidate
					bestBlockId = block.blockId
				}
			}

			if (!bestCandidate || !bestBlockId) {
				break
			}

			acceptedMatches.push(bestCandidate)
			remainingBlocks.delete(bestBlockId)
			availableAddedLines = availableAddedLines.filter(
				(line) => !bestCandidate?.matchedAddedLineIndexes.has(line.index),
			)
		}

		return acceptedMatches
	}

	private async resolveCommitsToReplay(
		repoRoot: string,
		pendingLines: AiCodePendingLineAttribution[],
		lastObservedCommit: string | undefined,
		currentCommit: string,
	): Promise<string[] | null> {
		if (lastObservedCommit?.trim()) {
			if (lastObservedCommit === currentCommit) {
				return []
			}

			try {
				const currentCommitDescendsFromCursor = await this.isAncestor(
					repoRoot,
					lastObservedCommit,
					currentCommit,
				)
				if (currentCommitDescendsFromCursor) {
					return await this.listCommitsBetween(repoRoot, lastObservedCommit, currentCommit)
				}
			} catch (error) {
				console.error("[AiCodeCommitAttribution] Failed to compare commit ancestry:", error)
				return null
			}
		}

		try {
			return await this.listCommitsSinceTimestamp(repoRoot, this.getEarliestPendingTimestamp(pendingLines))
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to list historical commits for catch-up:", error)
			return null
		}
	}

	private getEarliestPendingTimestamp(pendingLines: AiCodePendingLineAttribution[]): number {
		return pendingLines.reduce(
			(earliest, line) => Math.min(earliest, line.timestamp),
			pendingLines[0]?.timestamp ?? Date.now(),
		)
	}

	private async getCommitOccurredAt(repoRoot: string, commitHash: string): Promise<number> {
		try {
			return await this.loadCommitTimestamp(repoRoot, commitHash)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to load commit timestamp:", error)
			return Date.now()
		}
	}

	private async processCommit(
		repoRoot: string,
		branch: string,
		commitHash: string,
		previousCommit: string,
	): Promise<CommitProcessResult> {
		const pendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (pendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return { processed: false, remainingPendingLines: 0 }
		}

		let patchContent = ""
		try {
			patchContent = await this.loadCommitPatch(repoRoot, previousCommit, commitHash)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to load commit patch:", error)
			return { processed: false, remainingPendingLines: pendingLines.length }
		}

		if (!patchContent.trim()) {
			return { processed: true, remainingPendingLines: pendingLines.length }
		}

		const files = this.extractor.extractAddedLinesFromPatch(patchContent)
		if (files.length === 0) {
			return { processed: true, remainingPendingLines: pendingLines.length }
		}

		const pendingBuckets = this.buildPendingBuckets(pendingLines)
		const matchedLineIds = new Set<string>()
		const matchedBlockIds = new Set<string>()
		const commitOccurredAt = await this.getCommitOccurredAt(repoRoot, commitHash)
		const committedEvents: AiCodeStatsEvent[] = []

		for (const file of files) {
			const indexedAddedLines = file.addedLines.map((line, index) => ({
				index,
				lineNumber: line.lineNumber,
				content: line.content,
			}))
			const exactMatchResult = this.matchExactPendingLines(
				repoRoot,
				file.filePath,
				file.previousFilePath,
				indexedAddedLines,
				pendingBuckets,
			)
			for (const lineId of exactMatchResult.matchedLineIds) {
				matchedLineIds.add(lineId)
			}
			for (const blockId of exactMatchResult.matchedBlockIds) {
				matchedBlockIds.add(blockId)
			}

			const partialMatches = this.matchPartialPendingBlocks(
				repoRoot,
				file.filePath,
				file.previousFilePath,
				exactMatchResult.unmatchedAddedLines,
				pendingLines,
				matchedLineIds,
				matchedBlockIds,
				commitOccurredAt,
			)
			const fileMatches = exactMatchResult.matches
				.concat(...partialMatches.map((result) => result.matches))
				.sort((left, right) => left.lineNumber - right.lineNumber)

			for (const partialMatch of partialMatches) {
				for (const lineId of partialMatch.matchedLineIds) {
					matchedLineIds.add(lineId)
				}
			}

			if (fileMatches.length === 0) {
				continue
			}

			committedEvents.push(...this.buildCommittedEvents(fileMatches, branch, commitHash, commitOccurredAt))
		}

		if (committedEvents.length > 0) {
			for (const committedEvent of committedEvents) {
				await this.store.appendEvent(committedEvent)
			}

			await this.store.removePendingLineAttributions([...matchedLineIds])
		}

		const remainingPendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (remainingPendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return { processed: true, remainingPendingLines: 0 }
		}

		return { processed: true, remainingPendingLines: remainingPendingLines.length }
	}

	private async notifyCommitComparisonCompleted(): Promise<void> {
		if (!this.onCommitComparisonCompleted) {
			return
		}

		await this.onCommitComparisonCompleted()
	}

	private enqueueRepoWork(repoRoot: string, operation: () => Promise<void>): Promise<void> {
		const current = this.repoQueues.get(repoRoot) ?? Promise.resolve()
		const next = current.then(operation, operation)
		const wrapped = next.finally(() => this.clearRepoQueue(repoRoot, wrapped))
		this.repoQueues.set(repoRoot, wrapped)
		return wrapped
	}

	private clearRepoQueue(repoRoot: string, promise: Promise<void>): void {
		if (this.repoQueues.get(repoRoot) === promise) {
			this.repoQueues.delete(repoRoot)
		}
	}

	private stopWatcher(repoRoot: string): void {
		const watcher = this.watchers.get(repoRoot)
		if (!watcher) {
			return
		}

		watcher.dispose()
		this.watchers.delete(repoRoot)
	}

	private async cleanupRepo(repoRoot: string): Promise<void> {
		this.stopWatcher(repoRoot)
		await this.store.removeRepoObservedCommit(repoRoot)
	}
}
