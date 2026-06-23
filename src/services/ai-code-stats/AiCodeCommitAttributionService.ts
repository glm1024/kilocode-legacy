// kilocode_change - new file

import crypto from "crypto"
import { exec as execCallback, spawn } from "child_process"
import * as path from "path"
import { promisify } from "util"

import { GitWatcher, type GitWatcherEvent } from "../../shared/GitWatcher"
import { getCurrentBranch, isDetachedHead } from "../code-index/managed/git-utils"
import { AiCodeDiffExtractor } from "./AiCodeDiffExtractor"
import { hashLineFingerprint } from "./AiCodeLineFingerprint"
import { AiCodeStatsStore } from "./AiCodeStatsStore"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	normalizePath,
	type AiCodeCommitChangedFile,
	type AiCodeCommitLifecycleConfidence,
	type AiCodeCommitLifecycleEventType,
	type AiCodeCommitLifecycleReason,
	type AiCodeCommitLifecycleReport,
	type AiCodePendingLineAttribution,
} from "./types"

const execAsync = promisify(execCallback)
const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const GIT_STDOUT_LIMIT_BYTES = 128 * 1024 * 1024
const GIT_FILE_DIFF_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024

interface AiCodeCommitWatcher {
	onEvent(handler: (event: GitWatcherEvent) => void): void
	start(): Promise<void>
	dispose(): void
}

export interface AiCodeCommitAttributionServiceOptions {
	createWatcher?: (repoRoot: string) => AiCodeCommitWatcher
	loadCommitPatch?: (repoRoot: string, previousCommit: string, newCommit: string) => Promise<string>
	loadCommitTimestamp?: (repoRoot: string, commitHash: string) => Promise<number>
	loadCommitIdentity?: (repoRoot: string, commitHash: string) => Promise<AiCodeCommitIdentity>
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
	loadCommitParent?: (repoRoot: string, commitHash: string) => Promise<string | undefined>
	mergeBase?: (repoRoot: string, leftCommit: string, rightCommit: string) => Promise<string | undefined>
	onCommitCollected?: (payload: AiCodeCommitFactsPayload) => Promise<void>
	onCommitLifecycleObserved?: (payload: AiCodeCommitLifecycleReport) => Promise<void>
	onCommitComparisonCompleted?: () => Promise<void>
}

const defaultCreateWatcher = (repoRoot: string): AiCodeCommitWatcher => new GitWatcher({ cwd: repoRoot })

const runGitStdout = async (repoRoot: string, args: string[], stdoutLimit = GIT_STDOUT_LIMIT_BYTES): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd: repoRoot })
		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []
		let stdoutBytes = 0
		let killedForSize = false

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength
			if (stdoutBytes > stdoutLimit) {
				killedForSize = true
				child.kill()
				return
			}
			stdoutChunks.push(chunk)
		})
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
		child.on("error", reject)
		child.on("close", (code) => {
			if (killedForSize) {
				reject(new Error(`git output exceeded ${stdoutLimit} bytes: git ${args.join(" ")}`))
				return
			}
			if (code !== 0) {
				const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
				reject(new Error(`git ${args.join(" ")} failed with code ${code}${stderr ? `: ${stderr}` : ""}`))
				return
			}
			resolve(Buffer.concat(stdoutChunks).toString("utf8"))
		})
	})

const splitGitOutputLines = (stdout: string): string[] =>
	stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)

const splitGitOutputNul = (stdout: string): string[] =>
	stdout
		.split("\0")
		.map((line) => line.trim())
		.filter(Boolean)

const listCommitChangedPaths = async (
	repoRoot: string,
	previousCommit: string,
	newCommit: string,
): Promise<string[]> => {
	const stdout = previousCommit.trim()
		? await runGitStdout(
				repoRoot,
				["diff", "--name-only", "-z", "--find-renames", previousCommit, newCommit],
				GIT_STDOUT_LIMIT_BYTES,
			)
		: await runGitStdout(
				repoRoot,
				["show", "--format=", "--name-only", "-z", "--find-renames", newCommit],
				GIT_STDOUT_LIMIT_BYTES,
			)
	return [...new Set(splitGitOutputNul(stdout).map((filePath) => normalizePath(filePath)))]
}

const defaultLoadCommitPatch = async (repoRoot: string, previousCommit: string, newCommit: string): Promise<string> => {
	const changedPaths = await listCommitChangedPaths(repoRoot, previousCommit, newCommit)
	if (changedPaths.length === 0) {
		return ""
	}
	const patchParts: string[] = []
	for (const changedPath of changedPaths) {
		const args = previousCommit.trim()
			? ["diff", "--find-renames", "--unified=0", previousCommit, newCommit, "--", changedPath]
			: ["show", "--format=", "--find-renames", "--unified=0", newCommit, "--", changedPath]
		const patchPart = await runGitStdout(repoRoot, args, GIT_FILE_DIFF_STDOUT_LIMIT_BYTES)
		if (patchPart.trim()) {
			patchParts.push(patchPart)
		}
	}
	return patchParts.join("\n")
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

export interface AiCodeCommitIdentity {
	authorName?: string
	authorEmail?: string
	committerName?: string
	committerEmail?: string
}

const GIT_IDENTITY_SEPARATOR = "\x1f"

const trimIdentityField = (value?: string): string | undefined => {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

const defaultLoadCommitIdentity = async (repoRoot: string, commitHash: string): Promise<AiCodeCommitIdentity> => {
	const stdout = await runGitStdout(repoRoot, ["show", "-s", "--format=%an%x1f%ae%x1f%cn%x1f%ce", commitHash])
	const parts = stdout.trimEnd().split(GIT_IDENTITY_SEPARATOR)
	return {
		authorName: trimIdentityField(parts[0]),
		authorEmail: trimIdentityField(parts[1]),
		committerName: trimIdentityField(parts[2]),
		committerEmail: trimIdentityField(parts[3]),
	}
}

const defaultLoadCommitFileContent = async (
	repoRoot: string,
	commitHash: string,
	repoRelativePath: string,
): Promise<string | undefined> => {
	try {
		return await runGitStdout(repoRoot, ["show", `${commitHash}:${normalizePath(repoRelativePath)}`])
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

const defaultLoadCommitParent = async (repoRoot: string, commitHash: string): Promise<string | undefined> => {
	try {
		const stdout = await runGitStdout(repoRoot, ["rev-parse", `${commitHash}^`])
		return stdout.trim() || undefined
	} catch {
		return undefined
	}
}

const defaultMergeBase = async (
	repoRoot: string,
	leftCommit: string,
	rightCommit: string,
): Promise<string | undefined> => {
	try {
		const stdout = await runGitStdout(repoRoot, ["merge-base", leftCommit, rightCommit])
		return stdout.trim() || undefined
	} catch {
		return undefined
	}
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
	authorName?: string
	authorEmail?: string
	committerName?: string
	committerEmail?: string
	changedFiles: AiCodeCommitChangedFile[]
}

export class AiCodeCommitAttributionService {
	private readonly watchers = new Map<string, AiCodeCommitWatcher>()
	private readonly repoQueues = new Map<string, Promise<void>>()
	private readonly extractor: AiCodeDiffExtractor
	private readonly createWatcher: (repoRoot: string) => AiCodeCommitWatcher
	private readonly loadCommitPatch: (repoRoot: string, previousCommit: string, newCommit: string) => Promise<string>
	private readonly loadCommitTimestamp: (repoRoot: string, commitHash: string) => Promise<number>
	private readonly loadCommitIdentity: (repoRoot: string, commitHash: string) => Promise<AiCodeCommitIdentity>
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
	private readonly loadCommitParent: (repoRoot: string, commitHash: string) => Promise<string | undefined>
	private readonly mergeBase: (
		repoRoot: string,
		leftCommit: string,
		rightCommit: string,
	) => Promise<string | undefined>
	private readonly onCommitCollected?: (payload: AiCodeCommitFactsPayload) => Promise<void>
	private readonly onCommitLifecycleObserved?: (payload: AiCodeCommitLifecycleReport) => Promise<void>
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
		this.loadCommitIdentity = options.loadCommitIdentity ?? defaultLoadCommitIdentity
		this.loadCommitFileContent = options.loadCommitFileContent ?? defaultLoadCommitFileContent
		this.getCurrentBranch = options.getCurrentBranch ?? getCurrentBranch
		this.getCurrentCommitSha = options.getCurrentCommitSha ?? defaultGetCurrentCommitSha
		this.getIsDetachedHead = options.isDetachedHead ?? isDetachedHead
		this.isAncestor = options.isAncestor ?? defaultIsAncestor
		this.listCommitsBetween = options.listCommitsBetween ?? defaultListCommitsBetween
		this.listCommitsSinceTimestamp = options.listCommitsSinceTimestamp ?? defaultListCommitsSinceTimestamp
		this.loadCommitParent = options.loadCommitParent ?? defaultLoadCommitParent
		this.mergeBase = options.mergeBase ?? defaultMergeBase
		this.onCommitCollected = options.onCommitCollected
		this.onCommitLifecycleObserved = options.onCommitLifecycleObserved
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

	async collectCommitFactsForReplay(
		repoRoot: string,
		commitHash: string,
		branch?: string,
	): Promise<AiCodeCommitFactsPayload> {
		const normalizedRepoRoot = normalizePath(path.resolve(repoRoot))
		const resolvedBranch = branch?.trim() || (await this.getCurrentBranch(normalizedRepoRoot))
		return this.loadCommitFacts(normalizedRepoRoot, resolvedBranch, commitHash, "")
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

		const rewriteReplayCommits = await this.resolveCommitEventRewriteReplay(repoRoot, event)
		if (rewriteReplayCommits === null) {
			return
		}
		if (rewriteReplayCommits) {
			await this.processReplayCommits(repoRoot, event.branch, event.newCommit, rewriteReplayCommits)
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

		await this.store.setRepoObservedCommit(repoRoot, event.newCommit, event.branch)
	}

	private async resolveCommitEventRewriteReplay(
		repoRoot: string,
		event: Extract<GitWatcherEvent, { type: "commit" }>,
	): Promise<string[] | null | undefined> {
		const lastObservedCommit = await this.store.getRepoObservedCommit(repoRoot, event.branch)
		if (!lastObservedCommit?.trim() || lastObservedCommit === event.newCommit) {
			return undefined
		}

		try {
			if (await this.isAncestor(repoRoot, lastObservedCommit, event.newCommit)) {
				return undefined
			}

			const pendingLines = await this.store.getPendingLineAttributions(repoRoot)
			if (pendingLines.length === 0) {
				await this.cleanupRepo(repoRoot)
				return []
			}

			return await this.resolveRewrittenCommitsToReplay(
				repoRoot,
				pendingLines,
				lastObservedCommit,
				event.newCommit,
				event.branch,
			)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to compare commit event ancestry:", error)
			return null
		}
	}

	private async processReplayCommits(
		repoRoot: string,
		branch: string,
		currentCommit: string,
		commitsToReplay: string[],
	): Promise<void> {
		let replayProcessed = false
		for (const commitHash of commitsToReplay) {
			const result = await this.processCommit(repoRoot, branch, commitHash, "")
			if (!result.processed) {
				return
			}

			replayProcessed = true

			if (result.remainingPendingLines === 0) {
				await this.notifyCommitComparisonCompleted()
				return
			}

			await this.store.setRepoObservedCommit(repoRoot, commitHash, branch)
		}

		if (replayProcessed) {
			await this.notifyCommitComparisonCompleted()
		}

		const remainingPendingLines = await this.store.getPendingLineAttributions(repoRoot)
		if (remainingPendingLines.length === 0) {
			await this.cleanupRepo(repoRoot)
			return
		}

		await this.store.setRepoObservedCommit(repoRoot, currentCommit, branch)
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

		const lastObservedCommit = await this.store.getRepoObservedCommit(repoRoot, currentBranch)
		const commitsToReplay = await this.resolveCommitsToReplay(
			repoRoot,
			pendingLines,
			lastObservedCommit,
			currentCommit,
			currentBranch,
		)
		if (commitsToReplay === null) {
			return
		}

		await this.processReplayCommits(repoRoot, currentBranch, currentCommit, commitsToReplay)
	}

	private async resolveCommitsToReplay(
		repoRoot: string,
		pendingLines: AiCodePendingLineAttribution[],
		lastObservedCommit: string | undefined,
		currentCommit: string,
		currentBranch: string,
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
				const rewrittenCommits = await this.resolveRewrittenCommitsToReplay(
					repoRoot,
					pendingLines,
					lastObservedCommit,
					currentCommit,
					currentBranch,
				)
				if (rewrittenCommits) {
					return rewrittenCommits
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

	private async resolveRewrittenCommitsToReplay(
		repoRoot: string,
		pendingLines: AiCodePendingLineAttribution[],
		lastObservedCommit: string,
		currentCommit: string,
		currentBranch: string,
	): Promise<string[] | null> {
		const currentIsAncestorOfCursor = await this.isAncestor(repoRoot, currentCommit, lastObservedCommit)
		if (currentIsAncestorOfCursor) {
			const abandonedCommits = await this.listCommitsBetween(repoRoot, currentCommit, lastObservedCommit)
			await this.emitCommitLifecycleReport({
				repoRoot,
				pendingLines,
				currentBranch,
				eventType: "commits_abandoned",
				reason: "reset",
				confidence: "strong",
				oldCommits: abandonedCommits.length > 0 ? abandonedCommits : [lastObservedCommit],
				newCommits: [],
			})
			return []
		}

		const [oldParent, newParent] = await Promise.all([
			this.loadCommitParent(repoRoot, lastObservedCommit),
			this.loadCommitParent(repoRoot, currentCommit),
		])
		if (oldParent && newParent && oldParent === newParent) {
			await this.emitCommitLifecycleReport({
				repoRoot,
				pendingLines,
				currentBranch,
				eventType: "commit_replaced",
				reason: "amend",
				confidence: "strong",
				oldCommits: [lastObservedCommit],
				newCommits: [currentCommit],
			})
			return [currentCommit]
		}

		const commonBase = await this.mergeBase(repoRoot, lastObservedCommit, currentCommit)
		if (commonBase && commonBase !== lastObservedCommit && commonBase !== currentCommit) {
			const [oldRange, newRange] = await Promise.all([
				this.listCommitsBetween(repoRoot, commonBase, lastObservedCommit),
				this.listCommitsBetween(repoRoot, commonBase, currentCommit),
			])
			if (oldRange.length > 0 && newRange.length > 0) {
				await this.emitCommitLifecycleReport({
					repoRoot,
					pendingLines,
					currentBranch,
					eventType: "branch_rewrite_observed",
					reason: "rewrite_unknown",
					confidence: "weak",
					oldCommits: oldRange,
					newCommits: newRange,
				})
				return []
			}
		}

		await this.emitCommitLifecycleReport({
			repoRoot,
			pendingLines,
			currentBranch,
			eventType: "branch_rewrite_observed",
			reason: "rewrite_unknown",
			confidence: "weak",
			oldCommits: [lastObservedCommit],
			newCommits: [currentCommit],
		})
		return []
	}

	private async emitCommitLifecycleReport(params: {
		repoRoot: string
		pendingLines: AiCodePendingLineAttribution[]
		currentBranch: string
		eventType: AiCodeCommitLifecycleEventType
		reason: AiCodeCommitLifecycleReason
		confidence: AiCodeCommitLifecycleConfidence
		oldCommits: string[]
		newCommits: string[]
	}): Promise<void> {
		if (!this.onCommitLifecycleObserved) {
			return
		}
		const oldCommits = this.uniqueCommitHashes(params.oldCommits)
		const newCommits = this.uniqueCommitHashes(params.newCommits)
		if (oldCommits.length === 0 && newCommits.length === 0) {
			return
		}
		const referenceLine = params.pendingLines[0]
		const now = Date.now()
		const report: AiCodeCommitLifecycleReport = {
			version: "v1",
			source: "kilocode-ai-code-stats",
			mode: "commit_lifecycle",
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			eventId: this.buildLifecycleEventId(
				params.repoRoot,
				params.currentBranch,
				params.eventType,
				params.reason,
				params.confidence,
				oldCommits,
				newCommits,
			),
			reportId: crypto.randomUUID(),
			eventOccurredAt: now,
			reportedAt: now,
			repoRoot: normalizePath(params.repoRoot),
			projectKey: referenceLine?.projectKey,
			projectName: referenceLine?.projectName,
			gitRemoteUrl: referenceLine?.gitRemoteUrl,
			gitBranch: params.currentBranch || referenceLine?.gitBranch,
			eventType: params.eventType,
			reason: params.reason,
			confidence: params.confidence,
			oldCommitHash: oldCommits[0],
			newCommitHash: newCommits[0],
			commitHashes: oldCommits,
			replacementCommitHashes: newCommits,
		}
		try {
			await this.onCommitLifecycleObserved(report)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to persist commit lifecycle report:", error)
		}
	}

	private buildLifecycleEventId(
		repoRoot: string,
		branch: string,
		eventType: AiCodeCommitLifecycleEventType,
		reason: AiCodeCommitLifecycleReason,
		confidence: AiCodeCommitLifecycleConfidence,
		oldCommits: string[],
		newCommits: string[],
	): string {
		const digest = crypto
			.createHash("sha256")
			.update(
				[
					normalizePath(repoRoot),
					branch,
					eventType,
					reason,
					confidence,
					oldCommits.join(","),
					newCommits.join(","),
				].join("\u0000"),
			)
			.digest("hex")
		return `lifecycle-${digest.slice(0, 32)}`
	}

	private uniqueCommitHashes(commits: string[]): string[] {
		return [...new Set(commits.map((commit) => commit.trim()).filter(Boolean))]
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

		let facts: AiCodeCommitFactsPayload
		try {
			facts = await this.loadCommitFacts(repoRoot, branch, commitHash, previousCommit)
		} catch (error) {
			console.error("[AiCodeCommitAttribution] Failed to load commit facts:", error)
			return {
				processed: false,
				remainingPendingLines: pendingLines.length,
			}
		}

		try {
			if (this.onCommitCollected) {
				await this.onCommitCollected(facts)
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
				commitOccurredAt: facts.commitOccurredAt,
			}
		}

		return {
			processed: true,
			remainingPendingLines: remainingPendingLines.length,
			commitOccurredAt: facts.commitOccurredAt,
		}
	}

	private async loadCommitFacts(
		repoRoot: string,
		branch: string,
		commitHash: string,
		previousCommit: string,
	): Promise<AiCodeCommitFactsPayload> {
		let patchContent = ""
		try {
			patchContent = await this.loadCommitPatch(repoRoot, previousCommit, commitHash)
		} catch (error) {
			throw new Error(`Failed to load commit patch: ${error instanceof Error ? error.message : String(error)}`)
		}

		let commitOccurredAt: number
		try {
			commitOccurredAt = await this.getCommitOccurredAt(repoRoot, commitHash)
		} catch (error) {
			throw new Error(
				`Failed to load commit timestamp: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		let commitIdentity: AiCodeCommitIdentity = {}
		try {
			commitIdentity = await this.loadCommitIdentity(repoRoot, commitHash)
		} catch (error) {
			console.warn("[AiCodeCommitAttribution] Failed to load commit author identity:", error)
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
					const deletedOccurrenceCounts = new Map<string, number>()
					const indexedDeletedLines = (file.deletedLines ?? []).map((line, index) => {
						const lineHash = hashLineFingerprint(line.content)
						const occurrenceIndex = (deletedOccurrenceCounts.get(lineHash) ?? 0) + 1
						deletedOccurrenceCounts.set(lineHash, occurrenceIndex)
						return {
							deletedIndex: index,
							lineNumber: line.lineNumber,
							content: line.content,
							lineHash,
							occurrenceIndex,
						}
					})

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
						deletedLines: indexedDeletedLines,
					})
				}
			}
		}

		return {
			repoRoot,
			branch,
			commitHash,
			previousCommit,
			commitOccurredAt,
			authorName: commitIdentity.authorName,
			authorEmail: commitIdentity.authorEmail,
			committerName: commitIdentity.committerName,
			committerEmail: commitIdentity.committerEmail,
			changedFiles,
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
