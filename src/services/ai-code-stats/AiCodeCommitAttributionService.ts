// kilocode_change - new file

import { exec as execCallback, execFile as execFileCallback } from "child_process"
import * as path from "path"
import { promisify } from "util"

import { GitWatcher, type GitWatcherEvent } from "../../shared/GitWatcher"
import { getCurrentBranch, isDetachedHead } from "../code-index/managed/git-utils"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import { normalizePath, type AiCodeCommitChangedFile, type AiCodePendingLineAttribution } from "./types"

const execAsync = promisify(execCallback)
const execFileAsync = promisify(execFileCallback)
const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024

interface AiCodeCommitWatcher {
	onEvent(handler: (event: GitWatcherEvent) => void): void
	start(): Promise<void>
	dispose(): void
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
	onCommitCollected?: (payload: AiCodeCommitFactsPayload) => Promise<void>
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
	const trimmed = stdout.trim()
	const seconds = Number.parseInt(trimmed, 10)
	if (!/^\d+$/.test(trimmed) || !Number.isFinite(seconds)) {
		throw new Error(`Invalid commit timestamp for ${commitHash}: ${trimmed}`)
	}
	return seconds * 1000
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

interface CommitProcessResult {
	processed: boolean
	remainingPendingLines: number
	commitOccurredAt?: number
}

export interface AiCodeCommitFactsPayload {
	repoRoot: string
	branch: string
	commitHash: string
	previousCommit: string
	commitOccurredAt: number
	changedFiles: AiCodeCommitChangedFile[]
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
	private readonly onCommitCollected?: (payload: AiCodeCommitFactsPayload) => Promise<void>
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
		this.loadCommitFileContent = options.loadCommitFileContent ?? defaultLoadCommitFileContent
		this.getCurrentBranch = options.getCurrentBranch ?? getCurrentBranch
		this.getCurrentCommitSha = options.getCurrentCommitSha ?? defaultGetCurrentCommitSha
		this.getIsDetachedHead = options.isDetachedHead ?? isDetachedHead
		this.isAncestor = options.isAncestor ?? defaultIsAncestor
		this.listCommitsBetween = options.listCommitsBetween ?? defaultListCommitsBetween
		this.listCommitsSinceTimestamp = options.listCommitsSinceTimestamp ?? defaultListCommitsSinceTimestamp
		this.onCommitCollected = options.onCommitCollected
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
		const commitOccurredAt = await this.loadCommitTimestamp(repoRoot, commitHash)
		if (!Number.isFinite(commitOccurredAt)) {
			throw new Error(`Invalid commit timestamp for ${commitHash}: ${commitOccurredAt}`)
		}
		return commitOccurredAt
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
			return {
				processed: false,
				remainingPendingLines: pendingLines.length,
			}
		}

		let commitOccurredAt: number
		try {
			commitOccurredAt = await this.getCommitOccurredAt(repoRoot, commitHash)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to load commit timestamp:", error)
			return {
				processed: false,
				remainingPendingLines: pendingLines.length,
			}
		}

		const changedFiles: AiCodeCommitChangedFile[] = []
		const commitFileContentCache = new Map<string, Promise<string | undefined>>()
		if (patchContent.trim()) {
			const files = this.extractor.extractAddedLinesFromPatch(patchContent)
			if (files.length > 0) {
				for (const file of files) {
					const indexedAddedLines = file.addedLines.map((line, index) => ({
						index,
						lineNumber: line.lineNumber,
						content: line.content,
					}))

					const normalizedRelativePath = normalizePath(file.filePath)
					const fileSnapshotPromise =
						commitFileContentCache.get(normalizedRelativePath) ??
						this.loadCommitFileContent(repoRoot, commitHash, normalizedRelativePath)
					commitFileContentCache.set(normalizedRelativePath, fileSnapshotPromise)
					const fileSnapshotContent = await fileSnapshotPromise

					changedFiles.push({
						relativePath: normalizedRelativePath,
						filePath: normalizePath(path.join(repoRoot, normalizedRelativePath)),
						previousFilePath: file.previousFilePath
							? normalizePath(path.join(repoRoot, normalizePath(file.previousFilePath)))
							: undefined,
						language: this.resolveChangedFileLanguage(file.filePath, file.previousFilePath),
						committedSnapshotContent: fileSnapshotContent,
						changedBlocks: file.changedBlocks.map((block) => ({
							startLine: block.startLine,
							endLine: block.endLine,
							lineCount: block.lineCount,
							codeSnippet: block.codeSnippet,
							displayOrder: block.displayOrder,
						})),
						addedLines: indexedAddedLines.map((line) => ({
							addedIndex: line.index,
							lineNumber: line.lineNumber,
							content: line.content,
							lineHash: hashLineFingerprint(line.content),
						})),
					})
				}
			}
		}

		try {
			if (this.onCommitCollected) {
				await this.onCommitCollected({
					repoRoot,
					branch,
					commitHash,
					previousCommit,
					commitOccurredAt,
					changedFiles,
				})
			}
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to persist commit attribution report:", error)
			return {
				processed: false,
				remainingPendingLines: pendingLines.length,
			}
		}

		const remainingPendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (remainingPendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return {
				processed: true,
				remainingPendingLines: 0,
				commitOccurredAt,
			}
		}

		return {
			processed: true,
			remainingPendingLines: remainingPendingLines.length,
			commitOccurredAt,
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
