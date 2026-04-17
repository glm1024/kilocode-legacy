// kilocode_change - new file

import crypto from "crypto"
import { exec as execCallback, execFile as execFileCallback } from "child_process"
import * as path from "path"
import { promisify } from "util"

import { GitWatcher, type GitWatcherEvent } from "../../shared/GitWatcher"
import { getCurrentBranch, isDetachedHead } from "../code-index/managed/git-utils"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
import { roundToFour } from "./AiCodeLineFeatures"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import {
	createSharedPartialMatcherExecutor,
	type AiCodeCommitPartialMatcherExecutor,
} from "./AiCodeCommitPartialMatcherWorkerClient"
import {
	AiCodeCommitPartialMatcher,
	PartialMatcherCancelledError,
	type AddedLineCandidate,
	type CommitAddedLine,
	type PartialAlignmentDebugStats,
	type PartialBlockMatchResult,
	type PartialLineCandidate,
	type PendingBlockCandidate,
} from "./AiCodeCommitPartialMatcher"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import {
	DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG,
	normalizePath,
	type AiCodeCommitAttributionConfig,
	type AiCodeCommitChangedFile,
	type AiCodeCommitLineMatchDetail,
	type AiCodeCommitMatchAdjustment,
	type AiCodeCommitMatchDetail,
	type AiCodeStatsEvent,
	type AiCodeCommittedBlock,
	type AiCodeCommitMatchStrategy,
	type AiCodePendingLineAttribution,
} from "./types"

const execAsync = promisify(execCallback)
const execFileAsync = promisify(execFileCallback)
const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024

interface AiCodeCommitWatcher {
	onEvent(handler: (event: GitWatcherEvent) => void): void
	start(): Promise<void>
	dispose(): void
}

interface MatchedPendingLine {
	pendingLine: AiCodePendingLineAttribution
	lineNumber: number
	addedIndex?: number
	content: string
	filePath: string
	relativePath: string
	matchStrategy: AiCodeCommitMatchStrategy
	lineScore: number
	lineMatchDetail?: AiCodeCommitLineMatchDetail
	exactMeta?: {
		pendingBlockId: string
		pendingBlockLineIndex: number
		isContinuousWithPreviousExact: boolean
		selectedFromDuplicateCandidate: boolean
	}
}

interface ExactMatchResult {
	matches: MatchedPendingLine[]
	matchedLineIds: Set<string>
	matchedAddedLineIndexes: Set<number>
	unmatchedAddedLines: CommitAddedLine[]
}

interface SuspiciousExactResolution {
	matches: MatchedPendingLine[]
	matchedLineIds: Set<string>
	matchedAddedLineIndexes: Set<number>
	unmatchedAddedLines: CommitAddedLine[]
	partialMatches: PartialBlockMatchResult[]
}

export interface AiCodeCommitAttributionServiceOptions {
	createWatcher?: (repoRoot: string) => AiCodeCommitWatcher
	loadCommitPatch?: (repoRoot: string, previousCommit: string, newCommit: string) => Promise<string>
	loadCommitTimestamp?: (repoRoot: string, commitHash: string) => Promise<number>
	loadCommitFileContent?: (
		repoRoot: string,
		commitHash: string,
		repoRelativePath: string,
	) => Promise<string | undefined>
	getCurrentBranch?: (repoRoot: string) => Promise<string>
	getCurrentCommitSha?: (repoRoot: string) => Promise<string>
	isDetachedHead?: (repoRoot: string) => Promise<boolean>
	isAncestor?: (repoRoot: string, olderCommit: string, newerCommit: string) => Promise<boolean>
	listCommitsBetween?: (repoRoot: string, fromExclusive: string, toInclusive: string) => Promise<string[]>
	listCommitsSinceTimestamp?: (repoRoot: string, sinceTs: number) => Promise<string[]>
	getAttributionConfig?: () => Promise<AiCodeCommitAttributionConfig>
	onCommitMatched?: (payload: AiCodeCommitMatchedPayload) => Promise<void>
	onCommitComparisonCompleted?: () => Promise<void>
	partialMatcherExecutor?: AiCodeCommitPartialMatcherExecutor
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

const defaultLoadCommitFileContent = async (
	repoRoot: string,
	commitHash: string,
	repoRelativePath: string,
): Promise<string | undefined> => {
	try {
		const { stdout } = await execFileAsync("git", ["show", `${commitHash}:${normalizePath(repoRelativePath)}`], {
			cwd: repoRoot,
			maxBuffer: EXEC_MAX_BUFFER_BYTES,
		})
		return stdout
	} catch (error) {
		console.warn(
			`[AiCodeCommitAttribution] Failed to load committed file snapshot for ${repoRelativePath} at ${commitHash}:`,
			error,
		)
		return undefined
	}
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
const SUSPICIOUS_EXACT_CONTEXT_LINES = 3
const SUSPICIOUS_EXACT_MAX_WINDOW_LINES = 12

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".js": "javascript",
	".jsx": "javascript",
	".ts": "typescript",
	".tsx": "typescript",
	".py": "python",
	".java": "java",
	".go": "go",
	".rb": "ruby",
	".php": "php",
	".rs": "rust",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".c": "c",
	".h": "c",
	".hpp": "cpp",
	".cs": "csharp",
	".kt": "kotlin",
	".swift": "swift",
	".sh": "bash",
	".bash": "bash",
	".sql": "sql",
	".json": "json",
	".yml": "yaml",
	".yaml": "yaml",
	".xml": "xml",
	".html": "html",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".vue": "vue",
}

const inferLanguageFromPath = (filePath: string): string | undefined =>
	LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()]

const buildLegacyCommittedEvent = (block: AiCodeCommittedBlock): AiCodeStatsEvent => ({
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
	matchDetail: block.matchDetail,
})

const aggregateCommittedBlockMatchDetail = (
	lineDetails: AiCodeCommitLineMatchDetail[],
): AiCodeCommitMatchDetail | undefined => {
	if (lineDetails.length === 0) {
		return undefined
	}

	const totals = lineDetails.reduce(
		(result, detail) => {
			result.finalScore += detail.finalScore
			result.baseScore += detail.baseScore
			result.editSimilarity += detail.editSimilarity
			result.tokenSimilarity += detail.tokenSimilarity
			result.overlapSimilarity += detail.overlapSimilarity
			for (const adjustment of detail.adjustments) {
				result.adjustments.add(adjustment)
			}
			return result
		},
		{
			finalScore: 0,
			baseScore: 0,
			editSimilarity: 0,
			tokenSimilarity: 0,
			overlapSimilarity: 0,
			adjustments: new Set<AiCodeCommitMatchAdjustment>(),
		},
	)
	const divisor = Math.max(lineDetails.length, 1)

	return {
		scoreSource: "attribution",
		finalScore: roundToFour(totals.finalScore / divisor),
		baseScore: roundToFour(totals.baseScore / divisor),
		editSimilarity: roundToFour(totals.editSimilarity / divisor),
		tokenSimilarity: roundToFour(totals.tokenSimilarity / divisor),
		overlapSimilarity: roundToFour(totals.overlapSimilarity / divisor),
		adjustments: [...totals.adjustments].sort((left, right) => left.localeCompare(right)),
		lineDetails: lineDetails.map((detail) => ({
			...detail,
			adjustments: [...detail.adjustments],
		})),
	}
}

interface CommitProcessResult {
	processed: boolean
	remainingPendingLines: number
	commitOccurredAt?: number
	committedBlocks: AiCodeCommittedBlock[]
	matchedLineIds: string[]
}

export interface AiCodeCommitMatchedPayload {
	repoRoot: string
	branch: string
	commitHash: string
	previousCommit: string
	commitOccurredAt: number
	committedBlocks: AiCodeCommittedBlock[]
	changedFiles: AiCodeCommitChangedFile[]
	matchedPendingLineIds: string[]
}

export class AiCodeCommitAttributionService {
	private readonly watchers = new Map<string, AiCodeCommitWatcher>()
	private readonly repoQueues = new Map<string, Promise<void>>()
	private readonly extractor: AiCodeDiffExtractor
	private readonly createWatcher: (repoRoot: string) => AiCodeCommitWatcher
	private readonly loadCommitPatch: (repoRoot: string, previousCommit: string, newCommit: string) => Promise<string>
	private readonly loadCommitTimestamp: (repoRoot: string, commitHash: string) => Promise<number>
	private readonly loadCommitFileContent: (
		repoRoot: string,
		commitHash: string,
		repoRelativePath: string,
	) => Promise<string | undefined>
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
	private readonly getAttributionConfig: () => Promise<AiCodeCommitAttributionConfig>
	private readonly onCommitMatched?: (payload: AiCodeCommitMatchedPayload) => Promise<void>
	private readonly onCommitComparisonCompleted?: () => Promise<void>
	private readonly partialMatcherExecutor: AiCodeCommitPartialMatcherExecutor
	private readonly partialMatcher = new AiCodeCommitPartialMatcher()
	private started = false

	constructor(
		private readonly store: AiCodeStatsStore,
		options: AiCodeCommitAttributionServiceOptions = {},
	) {
		this.extractor = new AiCodeDiffExtractor()
		this.createWatcher = options.createWatcher ?? defaultCreateWatcher
		this.loadCommitPatch = options.loadCommitPatch ?? defaultLoadCommitPatch
		this.loadCommitTimestamp = options.loadCommitTimestamp ?? defaultLoadCommitTimestamp
		this.loadCommitFileContent = options.loadCommitFileContent ?? defaultLoadCommitFileContent
		this.getCurrentBranch = options.getCurrentBranch ?? getCurrentBranch
		this.getCurrentCommitSha = options.getCurrentCommitSha ?? defaultGetCurrentCommitSha
		this.getIsDetachedHead = options.isDetachedHead ?? isDetachedHead
		this.isAncestor = options.isAncestor ?? defaultIsAncestor
		this.listCommitsBetween = options.listCommitsBetween ?? defaultListCommitsBetween
		this.listCommitsSinceTimestamp = options.listCommitsSinceTimestamp ?? defaultListCommitsSinceTimestamp
		this.getAttributionConfig =
			options.getAttributionConfig ?? (async () => DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG)
		this.onCommitMatched = options.onCommitMatched
		this.onCommitComparisonCompleted = options.onCommitComparisonCompleted
		this.partialMatcherExecutor = options.partialMatcherExecutor ?? createSharedPartialMatcherExecutor()
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
		this.partialMatcherExecutor.dispose()
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

	async refreshRepoTracking(repoRoot: string): Promise<void> {
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		if (!this.started) {
			return
		}

		const pendingLines = await this.store.getPendingLineAttributions(normalizedRepoRoot)
		if (pendingLines.length === 0) {
			await this.cleanupRepo(normalizedRepoRoot)
			return
		}

		await this.ensureWatcher(normalizedRepoRoot)
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
					return right.timestamp - left.timestamp
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
		commitOccurredAt: number,
	): ExactMatchResult {
		const currentFilePath = normalizePath(filePath)
		const previousPath = previousFilePath ? normalizePath(previousFilePath) : undefined
		const lookupPaths = [currentFilePath, previousPath].filter(Boolean) as string[]
		const absoluteFilePath = normalizePath(path.join(repoRoot, currentFilePath))
		const matches: MatchedPendingLine[] = []
		const matchedLineIds = new Set<string>()
		const matchedAddedLineIndexes = new Set<number>()

		for (const addedLine of addedLines) {
			const lineHash = hashLineFingerprint(addedLine.content)
			let pendingLine: AiCodePendingLineAttribution | undefined
			let selectedFromDuplicateCandidate = false

			for (const lookupPath of lookupPaths) {
				const bucket = pendingBuckets.get(buildBucketKey(lookupPath, lineHash))
				if (bucket && bucket.length > 0) {
					selectedFromDuplicateCandidate = bucket.length > 1
					pendingLine = this.pickExactPendingLine(
						bucket,
						matches[matches.length - 1]?.pendingLine,
						commitOccurredAt,
					)
					break
				}
			}

			if (!pendingLine) {
				continue
			}

			const previousExactLine = matches[matches.length - 1]?.pendingLine
			const isContinuousWithPreviousExact =
				!!previousExactLine &&
				pendingLine.blockId === previousExactLine.blockId &&
				pendingLine.repoRelativePath === previousExactLine.repoRelativePath &&
				pendingLine.blockLineIndex === previousExactLine.blockLineIndex + 1

			matches.push({
				pendingLine,
				lineNumber: addedLine.lineNumber,
				addedIndex: addedLine.index,
				content: addedLine.content,
				filePath: absoluteFilePath,
				relativePath: currentFilePath,
				matchStrategy: "exact",
				lineScore: 1,
				exactMeta: {
					pendingBlockId: pendingLine.blockId || pendingLine.generatedEventId,
					pendingBlockLineIndex: pendingLine.blockLineIndex,
					isContinuousWithPreviousExact,
					selectedFromDuplicateCandidate,
				},
			})
			matchedLineIds.add(pendingLine.id)
			matchedAddedLineIndexes.add(addedLine.index)
		}

		return {
			matches,
			matchedLineIds,
			matchedAddedLineIndexes,
			unmatchedAddedLines: addedLines.filter((line) => !matchedAddedLineIndexes.has(line.index)),
		}
	}

	private pickExactPendingLine(
		bucket: AiCodePendingLineAttribution[],
		previousPendingLine: AiCodePendingLineAttribution | undefined,
		commitOccurredAt: number,
	): AiCodePendingLineAttribution | undefined {
		if (!bucket.length) {
			return undefined
		}

		const findCandidateIndex = (requireTimestampFence: boolean, requireContinuation: boolean): number =>
			bucket.findIndex((candidate) => {
				if (requireTimestampFence && candidate.timestamp > commitOccurredAt) {
					return false
				}
				if (!requireContinuation || !previousPendingLine) {
					return true
				}
				return (
					candidate.blockId === previousPendingLine.blockId &&
					candidate.repoRelativePath === previousPendingLine.repoRelativePath &&
					candidate.blockLineIndex === previousPendingLine.blockLineIndex + 1
				)
			})

		const preferredCandidateIndex = (previousPendingLine && findCandidateIndex(true, true)) ?? -1
		if (preferredCandidateIndex >= 0) {
			return bucket.splice(preferredCandidateIndex, 1)[0]
		}

		const eligibleIndex = findCandidateIndex(true, false)
		if (eligibleIndex < 0) {
			const fallbackContinuationIndex = (previousPendingLine && findCandidateIndex(false, true)) ?? -1
			if (fallbackContinuationIndex >= 0) {
				return bucket.splice(fallbackContinuationIndex, 1)[0]
			}
			return bucket.shift()
		}
		return bucket.splice(eligibleIndex, 1)[0]
	}

	private resolveSuspiciousExactWindows(params: {
		repoRoot: string
		filePath: string
		previousFilePath?: string
		addedLines: CommitAddedLine[]
		pendingLines: AiCodePendingLineAttribution[]
		exactMatchResult: ExactMatchResult
		commitOccurredAt: number
		config: AiCodeCommitAttributionConfig
	}): SuspiciousExactResolution {
		let exactMatches = params.exactMatchResult.matches.slice()
		const partialMatches: PartialBlockMatchResult[] = []
		const visitedSuspiciousAddedIndexes = new Set<number>()

		while (true) {
			const suspiciousMatch = this.findSuspiciousExactMatch(
				exactMatches,
				params.addedLines,
				params.pendingLines,
				visitedSuspiciousAddedIndexes,
			)
			if (!suspiciousMatch) {
				break
			}
			visitedSuspiciousAddedIndexes.add(suspiciousMatch.current.addedIndex!)

			let localPartialMatches: PartialBlockMatchResult[]
			try {
				localPartialMatches = this.tryResolveSuspiciousExactMatchWithPartial({
					...params,
					exactMatches,
					previous: suspiciousMatch.previous,
					current: suspiciousMatch.current,
				})
			} catch (error) {
				console.warn("[AiCodeCommitAttribution] Failed to resolve suspicious exact match:", error)
				continue
			}
			if (localPartialMatches.length === 0) {
				continue
			}

			const replacedAddedIndexes = this.collectMatchedAddedIndexes(localPartialMatches)
			if (!replacedAddedIndexes.has(suspiciousMatch.current.addedIndex!)) {
				continue
			}

			exactMatches = exactMatches.filter(
				(match) => match.addedIndex === undefined || !replacedAddedIndexes.has(match.addedIndex),
			)
			partialMatches.push(...localPartialMatches)
		}

		return this.buildSuspiciousExactResolution(params.addedLines, exactMatches, partialMatches)
	}

	private findSuspiciousExactMatch(
		exactMatches: MatchedPendingLine[],
		addedLines: CommitAddedLine[],
		pendingLines: AiCodePendingLineAttribution[],
		visitedAddedIndexes: Set<number>,
	): { previous: MatchedPendingLine; current: MatchedPendingLine } | undefined {
		const sortedMatches = exactMatches
			.filter((match) => match.addedIndex !== undefined)
			.slice()
			.sort((left, right) => left.addedIndex! - right.addedIndex!)

		for (let currentIndex = 0; currentIndex < sortedMatches.length; currentIndex += 1) {
			const current = sortedMatches[currentIndex]
			if (current.addedIndex === undefined || visitedAddedIndexes.has(current.addedIndex)) {
				continue
			}
			if (!this.hasMeaningfulLineContent(current.content)) {
				continue
			}

			for (let previousIndex = currentIndex - 1; previousIndex >= 0; previousIndex -= 1) {
				const previous = sortedMatches[previousIndex]
				if (!this.isSamePendingBlock(previous.pendingLine, current.pendingLine)) {
					continue
				}
				if (previous.addedIndex === undefined) {
					continue
				}

				const addedDistance = current.addedIndex - previous.addedIndex
				const blockDistance = current.pendingLine.blockLineIndex - previous.pendingLine.blockLineIndex
				if (addedDistance <= 0) {
					break
				}
				if (blockDistance <= 0) {
					return { previous, current }
				}
				if (blockDistance <= addedDistance) {
					break
				}
				if (!this.hasMeaningfulSkippedPendingLine(pendingLines, previous.pendingLine, current.pendingLine)) {
					break
				}
				if (!this.hasMeaningfulAddedLineInRange(addedLines, previous.addedIndex + 1, current.addedIndex)) {
					break
				}
				return { previous, current }
			}
		}

		return undefined
	}

	private tryResolveSuspiciousExactMatchWithPartial(params: {
		repoRoot: string
		filePath: string
		previousFilePath?: string
		addedLines: CommitAddedLine[]
		pendingLines: AiCodePendingLineAttribution[]
		exactMatches: MatchedPendingLine[]
		previous: MatchedPendingLine
		current: MatchedPendingLine
		commitOccurredAt: number
		config: AiCodeCommitAttributionConfig
	}): PartialBlockMatchResult[] {
		if (params.previous.addedIndex === undefined || params.current.addedIndex === undefined) {
			return []
		}

		const windowStart = Math.max(
			params.previous.addedIndex + 1,
			params.current.addedIndex - SUSPICIOUS_EXACT_CONTEXT_LINES,
		)
		const windowEnd = Math.min(
			params.addedLines.length - 1,
			params.current.addedIndex + SUSPICIOUS_EXACT_CONTEXT_LINES,
			windowStart + SUSPICIOUS_EXACT_MAX_WINDOW_LINES - 1,
		)
		const localAddedLines = params.addedLines.filter((line) => line.index >= windowStart && line.index <= windowEnd)
		if (!localAddedLines.some((line) => this.hasMeaningfulLineContent(line.content))) {
			return []
		}

		const localMatchedLineIds = this.buildLocalPartialBlockedLineIds(
			params.pendingLines,
			params.exactMatches,
			params.previous,
			params.current,
			windowStart,
			windowEnd,
			params.current.pendingLine.blockLineIndex <= params.previous.pendingLine.blockLineIndex,
		)
		const localPartialMatches = this.partialMatcher.matchPartialPendingBlocks({
			repoRoot: params.repoRoot,
			filePath: params.filePath,
			previousFilePath: params.previousFilePath,
			addedLines: localAddedLines,
			pendingLines: params.pendingLines,
			matchedLineIds: localMatchedLineIds,
			exactMatches: params.exactMatches.filter((match) => match.addedIndex !== params.current.addedIndex),
			commitOccurredAt: params.commitOccurredAt,
			config: params.config,
		})
		if (!this.isAcceptableSuspiciousPartialReplacement(localPartialMatches, params.current.addedIndex)) {
			return []
		}
		return localPartialMatches
	}

	private buildLocalPartialBlockedLineIds(
		pendingLines: AiCodePendingLineAttribution[],
		exactMatches: MatchedPendingLine[],
		previous: MatchedPendingLine,
		current: MatchedPendingLine,
		windowStart: number,
		windowEnd: number,
		isOutOfOrderExact: boolean,
	): Set<string> {
		const allowedStart = previous.pendingLine.blockLineIndex + 1
		const allowedEnd = isOutOfOrderExact
			? previous.pendingLine.blockLineIndex + Math.max(1, current.addedIndex! - previous.addedIndex!)
			: current.pendingLine.blockLineIndex - 1
		const allowedLineIds = new Set(
			pendingLines
				.filter(
					(line) =>
						this.isSamePendingBlock(line, current.pendingLine) &&
						line.blockLineIndex >= allowedStart &&
						line.blockLineIndex <= allowedEnd,
				)
				.map((line) => line.id),
		)
		const blockedLineIds = new Set(
			pendingLines.filter((line) => !allowedLineIds.has(line.id)).map((line) => line.id),
		)
		for (const exactMatch of exactMatches) {
			if (
				exactMatch.addedIndex !== undefined &&
				exactMatch.addedIndex >= windowStart &&
				exactMatch.addedIndex <= windowEnd
			) {
				continue
			}
			if (allowedLineIds.has(exactMatch.pendingLine.id)) {
				continue
			}
			blockedLineIds.add(exactMatch.pendingLine.id)
		}
		return blockedLineIds
	}

	private isAcceptableSuspiciousPartialReplacement(
		partialMatches: PartialBlockMatchResult[],
		currentExactAddedIndex: number,
	): boolean {
		const matchedAddedIndexes = this.collectMatchedAddedIndexes(partialMatches)
		if (!matchedAddedIndexes.has(currentExactAddedIndex)) {
			return false
		}

		return partialMatches.some((partialMatch) => {
			if (!this.isMonotonicPartialMatch(partialMatch.matches)) {
				return false
			}
			return partialMatch.matches.some((match) => this.hasMeaningfulLineContent(match.content))
		})
	}

	private isMonotonicPartialMatch(matches: MatchedPendingLine[]): boolean {
		const sortedMatches = matches.slice().sort((left, right) => left.lineNumber - right.lineNumber)
		for (let index = 1; index < sortedMatches.length; index += 1) {
			const previous = sortedMatches[index - 1]
			const current = sortedMatches[index]
			if (!this.isSamePendingBlock(previous.pendingLine, current.pendingLine)) {
				continue
			}
			if (current.pendingLine.blockLineIndex <= previous.pendingLine.blockLineIndex) {
				return false
			}
		}
		return true
	}

	private buildSuspiciousExactResolution(
		addedLines: CommitAddedLine[],
		exactMatches: MatchedPendingLine[],
		partialMatches: PartialBlockMatchResult[],
	): SuspiciousExactResolution {
		const matchedLineIds = new Set<string>()
		const matchedAddedLineIndexes = new Set<number>()
		for (const exactMatch of exactMatches) {
			matchedLineIds.add(exactMatch.pendingLine.id)
			if (exactMatch.addedIndex !== undefined) {
				matchedAddedLineIndexes.add(exactMatch.addedIndex)
			}
		}
		for (const partialMatch of partialMatches) {
			for (const lineId of partialMatch.matchedLineIds) {
				matchedLineIds.add(lineId)
			}
			for (const addedIndex of partialMatch.matchedAddedLineIndexes) {
				matchedAddedLineIndexes.add(addedIndex)
			}
		}

		return {
			matches: exactMatches,
			matchedLineIds,
			matchedAddedLineIndexes,
			unmatchedAddedLines: addedLines.filter((line) => !matchedAddedLineIndexes.has(line.index)),
			partialMatches,
		}
	}

	private collectMatchedAddedIndexes(partialMatches: PartialBlockMatchResult[]): Set<number> {
		const matchedAddedIndexes = new Set<number>()
		for (const partialMatch of partialMatches) {
			for (const addedIndex of partialMatch.matchedAddedLineIndexes) {
				matchedAddedIndexes.add(addedIndex)
			}
		}
		return matchedAddedIndexes
	}

	private hasMeaningfulSkippedPendingLine(
		pendingLines: AiCodePendingLineAttribution[],
		previous: AiCodePendingLineAttribution,
		current: AiCodePendingLineAttribution,
	): boolean {
		return pendingLines.some(
			(line) =>
				this.isSamePendingBlock(line, current) &&
				line.blockLineIndex > previous.blockLineIndex &&
				line.blockLineIndex < current.blockLineIndex &&
				this.hasMeaningfulLineContent(line.rawLine),
		)
	}

	private hasMeaningfulAddedLineInRange(
		addedLines: CommitAddedLine[],
		startIndex: number,
		endIndex: number,
	): boolean {
		return addedLines.some(
			(line) => line.index >= startIndex && line.index <= endIndex && this.hasMeaningfulLineContent(line.content),
		)
	}

	private hasMeaningfulLineContent(value: string | undefined): boolean {
		return !!value && value.trim().length > 0
	}

	private isSamePendingBlock(left: AiCodePendingLineAttribution, right: AiCodePendingLineAttribution): boolean {
		const leftBlockId = left.blockId || left.generatedEventId
		const rightBlockId = right.blockId || right.generatedEventId
		return leftBlockId === rightBlockId && left.repoRelativePath === right.repoRelativePath
	}

	private buildCommittedBlocks(
		matches: MatchedPendingLine[],
		branch: string,
		commitHash: string,
		commitOccurredAt: number,
		fileSnapshotContent?: string,
	): AiCodeCommittedBlock[] {
		const blocks: AiCodeCommittedBlock[] = []
		let currentBlock: {
			pendingLine: AiCodePendingLineAttribution
			filePath: string
			relativePath: string
			lineStart: number
			lineEnd: number
			lines: string[]
			matchStrategy: AiCodeCommitMatchStrategy
			lastPendingLine: AiCodePendingLineAttribution
			scoreSum: number
			scoreCount: number
			lineMatchDetails: AiCodeCommitLineMatchDetail[]
		} | null = null

		const flushCurrentBlock = () => {
			if (!currentBlock) {
				return
			}

			const pendingLine = currentBlock.pendingLine
			const equivalentLineCount = roundToFour(currentBlock.scoreSum)
			const matchConfidence = roundToFour(currentBlock.scoreSum / Math.max(currentBlock.scoreCount, 1))
			blocks.push({
				eventId: crypto.randomUUID(),
				generatedBlockId: pendingLine.generatedEventId,
				timestamp: commitOccurredAt,
				sourceType: pendingLine.sourceType,
				ide: pendingLine.ide,
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
				fileSnapshotContent,
				taskId: pendingLine.taskId,
				commitHash,
				commitOccurredAt,
				matchStrategy: currentBlock.matchStrategy,
				matchConfidence,
				equivalentLineCount,
				matchDetail:
					currentBlock.matchStrategy === "partial"
						? aggregateCommittedBlockMatchDetail(currentBlock.lineMatchDetails)
						: undefined,
			})
			currentBlock = null
		}

		for (const match of matches) {
			const nextAverageScore = currentBlock ? currentBlock.scoreSum / Math.max(currentBlock.scoreCount, 1) : 0
			const hasContinuousExactPendingLine =
				!currentBlock ||
				match.matchStrategy !== "exact" ||
				currentBlock.matchStrategy !== "exact" ||
				match.pendingLine.blockLineIndex === currentBlock.lastPendingLine.blockLineIndex + 1
			const canExtendCurrentBlock =
				currentBlock &&
				currentBlock.pendingLine.blockId === match.pendingLine.blockId &&
				currentBlock.filePath === match.filePath &&
				currentBlock.lineEnd + 1 === match.lineNumber &&
				currentBlock.matchStrategy === match.matchStrategy &&
				hasContinuousExactPendingLine &&
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
					lastPendingLine: match.pendingLine,
					scoreSum: match.lineScore,
					scoreCount: 1,
					lineMatchDetails: match.lineMatchDetail ? [match.lineMatchDetail] : [],
				}
				continue
			}

			const activeBlock = currentBlock!
			activeBlock.lineEnd = match.lineNumber
			activeBlock.lines.push(match.content)
			activeBlock.lastPendingLine = match.pendingLine
			activeBlock.scoreSum += match.lineScore
			activeBlock.scoreCount += 1
			if (match.lineMatchDetail) {
				activeBlock.lineMatchDetails.push(match.lineMatchDetail)
			}
		}

		flushCurrentBlock()
		return blocks
	}

	private buildPendingBlockCandidates(
		pendingLines: AiCodePendingLineAttribution[],
		matchedLineIds: Set<string>,
		currentFilePath: string,
		previousFilePath: string | undefined,
		commitOccurredAt: number,
	): PendingBlockCandidate[] {
		return this.partialMatcher.buildPendingBlockCandidates(
			pendingLines,
			matchedLineIds,
			currentFilePath,
			previousFilePath,
			commitOccurredAt,
		)
	}

	private buildAddedLineCandidates(
		addedLines: CommitAddedLine[],
		filePath?: string,
		language?: string,
	): AddedLineCandidate[] {
		return this.partialMatcher.buildAddedLineCandidates(addedLines, filePath, language)
	}

	private alignPartialBlockCandidatesDenseReference(
		block: PendingBlockCandidate,
		addedLines: AddedLineCandidate[],
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
	): PartialLineCandidate[] {
		return this.partialMatcher.alignPartialBlockCandidatesDenseReference(block, addedLines, config, debugStats)
	}

	private alignPartialBlockCandidates(
		block: PendingBlockCandidate,
		addedLines: AddedLineCandidate[],
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
	): PartialLineCandidate[] {
		return this.partialMatcher.alignPartialBlockCandidates(block, addedLines, config, debugStats)
	}

	private comparePartialCandidates(left: PartialLineCandidate, right: PartialLineCandidate): number {
		return this.partialMatcher.comparePartialCandidates(left, right)
	}

	private matchPartialPendingBlocks(
		repoRoot: string,
		filePath: string,
		previousFilePath: string | undefined,
		addedLines: CommitAddedLine[],
		pendingLines: AiCodePendingLineAttribution[],
		matchedLineIds: Set<string>,
		commitOccurredAt: number,
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
	): PartialBlockMatchResult[] {
		return this.partialMatcher.matchPartialPendingBlocks({
			repoRoot,
			filePath,
			previousFilePath,
			addedLines,
			pendingLines,
			matchedLineIds,
			commitOccurredAt,
			config,
			debugStats,
		})
	}

	private async matchPartialPendingBlocksAsync(
		repoRoot: string,
		filePath: string,
		previousFilePath: string | undefined,
		addedLines: CommitAddedLine[],
		pendingLines: AiCodePendingLineAttribution[],
		matchedLineIds: Set<string>,
		exactMatches: MatchedPendingLine[],
		commitOccurredAt: number,
		config: AiCodeCommitAttributionConfig,
	): Promise<PartialBlockMatchResult[]> {
		return this.partialMatcherExecutor.matchPartialPendingBlocks({
			repoRoot,
			filePath,
			previousFilePath,
			addedLines,
			pendingLines,
			matchedLineIds,
			exactMatches,
			commitOccurredAt,
			config,
		})
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
			return { processed: false, remainingPendingLines: 0, committedBlocks: [], matchedLineIds: [] }
		}

		let patchContent = ""
		try {
			patchContent = await this.loadCommitPatch(repoRoot, previousCommit, commitHash)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to load commit patch:", error)
			return {
				processed: false,
				remainingPendingLines: pendingLines.length,
				committedBlocks: [],
				matchedLineIds: [],
			}
		}

		const commitOccurredAt = await this.getCommitOccurredAt(repoRoot, commitHash)
		let attributionConfig = DEFAULT_AI_CODE_COMMIT_ATTRIBUTION_CONFIG
		try {
			attributionConfig = await this.getAttributionConfig()
		} catch (error) {
			console.warn(
				"[AiCodeCommitAttribution] Failed to load attribution config, falling back to defaults:",
				error,
			)
		}

		const committedBlocks: AiCodeCommittedBlock[] = []
		const changedFiles: AiCodeCommitChangedFile[] = []
		const matchedLineIds = new Set<string>()
		const commitFileContentCache = new Map<string, Promise<string | undefined>>()
		if (patchContent.trim()) {
			const files = this.extractor.extractAddedLinesFromPatch(patchContent)
			if (files.length > 0) {
				const pendingBuckets = this.buildPendingBuckets(pendingLines)

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
						commitOccurredAt,
					)
					const exactResolution = this.resolveSuspiciousExactWindows({
						repoRoot,
						filePath: file.filePath,
						previousFilePath: file.previousFilePath,
						addedLines: indexedAddedLines,
						pendingLines,
						exactMatchResult,
						commitOccurredAt,
						config: attributionConfig,
					})
					for (const lineId of exactResolution.matchedLineIds) {
						matchedLineIds.add(lineId)
					}

					let partialMatches: PartialBlockMatchResult[]
					try {
						partialMatches = await this.matchPartialPendingBlocksAsync(
							repoRoot,
							file.filePath,
							file.previousFilePath,
							exactResolution.unmatchedAddedLines,
							pendingLines,
							matchedLineIds,
							exactResolution.matches,
							commitOccurredAt,
							attributionConfig,
						)
					} catch (error) {
						if (error instanceof PartialMatcherCancelledError) {
							return {
								processed: false,
								remainingPendingLines: pendingLines.length,
								committedBlocks: [],
								matchedLineIds: [],
							}
						}
						throw error
					}
					partialMatches = exactResolution.partialMatches.concat(partialMatches)
					const fileMatches = exactResolution.matches
						.concat(...partialMatches.map((result) => result.matches))
						.sort((left, right) => left.lineNumber - right.lineNumber)

					for (const partialMatch of partialMatches) {
						for (const lineId of partialMatch.matchedLineIds) {
							matchedLineIds.add(lineId)
						}
					}

					const normalizedRelativePath = normalizePath(file.filePath)
					const fileSnapshotPromise =
						commitFileContentCache.get(normalizedRelativePath) ??
						this.loadCommitFileContent(repoRoot, commitHash, normalizedRelativePath)
					commitFileContentCache.set(normalizedRelativePath, fileSnapshotPromise)
					const fileSnapshotContent = await fileSnapshotPromise

					if (fileMatches.length > 0) {
						committedBlocks.push(
							...this.buildCommittedBlocks(
								fileMatches,
								branch,
								commitHash,
								commitOccurredAt,
								fileSnapshotContent,
							),
						)
					}

					changedFiles.push({
						relativePath: normalizedRelativePath,
						filePath: normalizePath(path.join(repoRoot, normalizedRelativePath)),
						previousFilePath: file.previousFilePath
							? normalizePath(path.join(repoRoot, normalizePath(file.previousFilePath)))
							: undefined,
						language:
							fileMatches[0]?.pendingLine.language ||
							this.resolveChangedFileLanguage(file.filePath, file.previousFilePath),
						committedSnapshotContent: fileSnapshotContent,
						changedBlocks: file.changedBlocks.map((block) => ({
							startLine: block.startLine,
							endLine: block.endLine,
							lineCount: block.lineCount,
							codeSnippet: block.codeSnippet,
							displayOrder: block.displayOrder,
						})),
					})
				}
			}
		}

		try {
			if (this.onCommitMatched) {
				await this.onCommitMatched({
					repoRoot,
					branch,
					commitHash,
					previousCommit,
					commitOccurredAt,
					committedBlocks,
					changedFiles,
					matchedPendingLineIds: [...matchedLineIds],
				})
			} else if (committedBlocks.length > 0) {
				await this.store.appendHistoryEvents(committedBlocks.map((block) => buildLegacyCommittedEvent(block)))
				await this.store.removePendingLineAttributions([...matchedLineIds])
			}
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to persist commit attribution report:", error)
			return {
				processed: false,
				remainingPendingLines: pendingLines.length,
				committedBlocks: [],
				matchedLineIds: [],
			}
		}

		const remainingPendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (remainingPendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return {
				processed: true,
				remainingPendingLines: 0,
				commitOccurredAt,
				committedBlocks,
				matchedLineIds: [...matchedLineIds],
			}
		}

		return {
			processed: true,
			remainingPendingLines: remainingPendingLines.length,
			commitOccurredAt,
			committedBlocks,
			matchedLineIds: [...matchedLineIds],
		}
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

	private resolveChangedFileLanguage(filePath: string, previousFilePath?: string): string | undefined {
		return (
			inferLanguageFromPath(filePath) || (previousFilePath ? inferLanguageFromPath(previousFilePath) : undefined)
		)
	}
}
