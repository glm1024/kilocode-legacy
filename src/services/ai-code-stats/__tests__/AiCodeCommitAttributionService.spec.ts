import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile as execFileCallback } from "child_process"
import { promisify } from "util"

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
	AiCodeCommitAttributionService,
	type AiCodeCommitAttributionServiceOptions,
} from "../AiCodeCommitAttributionService"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import type { AiCodePendingLineAttribution } from "../types"

const execFileAsync = promisify(execFileCallback)

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

const buildPendingLine = (overrides: Partial<AiCodePendingLineAttribution> = {}): AiCodePendingLineAttribution => {
	const rawLine = overrides.rawLine ?? "const total = calculateTotal(items)"
	const id = overrides.id ?? "line-1"
	return {
		id,
		generatedEventId: overrides.generatedEventId ?? "generated-1",
		blockId: overrides.blockId ?? overrides.generatedEventId ?? "generated-1",
		timestamp: overrides.timestamp ?? 1_772_499_900_000,
		sourceType: overrides.sourceType ?? "agent_insert",
		ide: overrides.ide ?? "vscode",
		userName: overrides.userName,
		userEmail: overrides.userEmail,
		organizationId: overrides.organizationId,
		organizationName: overrides.organizationName,
		sourceIp: overrides.sourceIp,
		projectKey: overrides.projectKey ?? "repo",
		projectName: overrides.projectName ?? "repo",
		filePath: overrides.filePath ?? "/repo/src/old.ts",
		relativePath: overrides.relativePath ?? "src/old.ts",
		repoRoot: overrides.repoRoot ?? "/repo",
		repoRelativePath: overrides.repoRelativePath ?? "src/old.ts",
		language: overrides.language ?? "typescript",
		gitRemoteUrl: overrides.gitRemoteUrl ?? "git@example.com:acme/repo.git",
		gitBranch: overrides.gitBranch ?? "feature/stats",
		taskId: overrides.taskId ?? "task-1",
		rawLine,
		lineHash: overrides.lineHash ?? hashLineFingerprint(rawLine),
		blockLineIndex: overrides.blockLineIndex ?? 1,
		blockLineCount: overrides.blockLineCount ?? 1,
		occurrenceIndex: overrides.occurrenceIndex ?? 1,
	}
}

const initRealGitRepo = async (): Promise<string> => {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-commit-attribution-real-"))
	await execFileAsync("git", ["init"], { cwd: repoDir })
	await execFileAsync("git", ["config", "user.email", "tester@example.com"], { cwd: repoDir })
	await execFileAsync("git", ["config", "user.name", "Tester"], { cwd: repoDir })
	await fs.writeFile(path.join(repoDir, "README.md"), "initial\n", "utf8")
	await execFileAsync("git", ["add", "README.md"], { cwd: repoDir })
	await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir })
	return repoDir
}

const buildLargeSource = (prefix: string, lineCount: number): string =>
	Array.from(
		{ length: lineCount },
		(_, index) =>
			`export const ${prefix}${String(index).padStart(5, "0")} = "${prefix}-${String(index).padStart(5, "0")}-${"x".repeat(180)}"`,
	).join("\n") + "\n"

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
			loadCommitIdentity: async () => ({}),
			loadCommitFileContent: async (_repoRoot: string, _commitHash: string, repoRelativePath: string) =>
				`// committed snapshot for ${repoRelativePath}\nconst value = 1\n`,
			getCurrentBranch: async () => "feature/stats",
			getCurrentCommitSha: async () => "head-1",
			isDetachedHead: async () => false,
			isAncestor: async () => true,
			listCommitsBetween: async () => [],
			listCommitsSinceTimestamp: async () => [],
			...overrides,
		})

	it("reports raw commit facts without authoritative committed attribution", async () => {
		const onCommitCollected = vi.fn(async (_payload: any) => {})
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const service = createService({
			onCommitCollected,
			onCommitComparisonCompleted,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/old.ts b/src/new.ts",
					"similarity index 90%",
					"rename from src/old.ts",
					"rename to src/new.ts",
					"--- a/src/old.ts",
					"+++ b/src/new.ts",
					"@@ -0,0 +10,2 @@",
					"+const total = calculateTotal(items)",
					"+return total",
				].join("\n"),
			loadCommitIdentity: async () => ({
				authorName: "Zhang San",
				authorEmail: "zhang.san@example.com",
				committerName: "CI Bot",
				committerEmail: "ci@example.com",
			}),
			loadCommitFileContent: async () => "const total = calculateTotal(items)\nreturn total\n",
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				rawLine: "const total = calculateTotal(items)",
				blockLineIndex: 1,
				blockLineCount: 2,
			}),
			buildPendingLine({
				id: "line-2",
				rawLine: "return total",
				blockLineIndex: 2,
				blockLineCount: 2,
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

		await vi.waitFor(() => {
			expect(onCommitCollected).toHaveBeenCalledTimes(1)
		})

		const payload = onCommitCollected.mock.calls[0][0]
		expect(payload).toMatchObject({
			repoRoot: "/repo",
			branch: "feature/stats",
			commitHash: "def456",
			previousCommit: "abc123",
			commitOccurredAt: 1_772_500_000_000,
			authorName: "Zhang San",
			authorEmail: "zhang.san@example.com",
			committerName: "CI Bot",
			committerEmail: "ci@example.com",
		})
		expect(payload.changedFiles).toHaveLength(1)
		expect(payload.changedFiles[0]).toMatchObject({
			relativePath: "src/new.ts",
			filePath: "/repo/src/new.ts",
			previousFilePath: "/repo/src/old.ts",
			language: "typescript",
			committedSnapshotContent: "const total = calculateTotal(items)\nreturn total\n",
		})
		expect(payload.changedFiles[0].addedLines).toEqual([
			{
				addedIndex: 0,
				lineNumber: 10,
				content: "const total = calculateTotal(items)",
				lineHash: hashLineFingerprint("const total = calculateTotal(items)"),
			},
			{
				addedIndex: 1,
				lineNumber: 11,
				content: "return total",
				lineHash: hashLineFingerprint("return total"),
			},
		])
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(2)
		expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		expect(await store.getRepoObservedCommit("/repo", "feature/stats")).toBe("def456")
	})

	it("reports manual-only files while preserving candidate facts locally", async () => {
		const onCommitCollected = vi.fn(async (_payload: any) => {})
		const service = createService({
			onCommitCollected,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/manual.ts b/src/manual.ts",
					"--- a/src/manual.ts",
					"+++ b/src/manual.ts",
					"@@ -0,0 +1 @@",
					"+const manual = true",
				].join("\n"),
			loadCommitFileContent: async () => "const manual = true\n",
		})

		await service.start()
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "candidate-unrelated",
				repoRelativePath: "src/generated.ts",
				relativePath: "src/generated.ts",
				filePath: "/repo/src/generated.ts",
				rawLine: "const generated = true",
			}),
		])

		watchers[0].emit({
			type: "commit",
			previousCommit: "abc123",
			newCommit: "manual456",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(() => {
			expect(onCommitCollected).toHaveBeenCalledTimes(1)
		})

		const payload = onCommitCollected.mock.calls[0][0]
		expect(payload.changedFiles[0].addedLines).toEqual([
			{
				addedIndex: 0,
				lineNumber: 1,
				content: "const manual = true",
				lineHash: hashLineFingerprint("const manual = true"),
			},
		])
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
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
		await service.registerPendingLineAttributions([buildPendingLine()])

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
		expect(await store.getRepoObservedCommit("/repo", "feature/stats")).toBe("head-1")
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})

	it("observes amend rewrite as a strong commit_replaced lifecycle report", async () => {
		const onCommitLifecycleObserved = vi.fn(async (_payload: any) => {})
		await store.addPendingLineAttributions([buildPendingLine()])
		await store.setRepoObservedCommit("/repo", "old-amend", "feature/stats")
		const service = createService({
			onCommitLifecycleObserved,
			getCurrentCommitSha: async () => "new-amend",
			isAncestor: async (_repoRoot, olderCommit, newerCommit) => {
				if (olderCommit === "old-amend" && newerCommit === "new-amend") {
					return false
				}
				if (olderCommit === "new-amend" && newerCommit === "old-amend") {
					return false
				}
				return true
			},
			loadCommitParent: async (_repoRoot, commitHash) =>
				commitHash === "old-amend" || commitHash === "new-amend" ? "same-parent" : undefined,
		})

		await service.start()

		await vi.waitFor(() => {
			expect(onCommitLifecycleObserved).toHaveBeenCalledTimes(1)
		})
		expect(onCommitLifecycleObserved.mock.calls[0][0]).toMatchObject({
			mode: "commit_lifecycle",
			eventType: "commit_replaced",
			reason: "amend",
			confidence: "strong",
			repoRoot: "/repo",
			projectKey: "repo",
			projectName: "repo",
			gitRemoteUrl: "git@example.com:acme/repo.git",
			gitBranch: "feature/stats",
			oldCommitHash: "old-amend",
			newCommitHash: "new-amend",
			commitHashes: ["old-amend"],
			replacementCommitHashes: ["new-amend"],
		})
		expect(onCommitLifecycleObserved.mock.calls[0][0].eventId).toMatch(/^lifecycle-/)
	})

	it("observes amend rewrite from commit watcher events before replaying the new commit", async () => {
		const onCommitLifecycleObserved = vi.fn(async (_payload: any) => {})
		const onCommitCollected = vi.fn(async (_payload: any) => {})
		const loadCommitPatch = vi.fn(async () =>
			[
				"diff --git a/src/old.ts b/src/old.ts",
				"--- a/src/old.ts",
				"+++ b/src/old.ts",
				"@@ -0,0 +1,1 @@",
				"+const total = calculateTotal(items)",
			].join("\n"),
		)
		await store.addPendingLineAttributions([buildPendingLine()])
		await store.setRepoObservedCommit("/repo", "old-amend", "feature/stats")
		const service = createService({
			onCommitLifecycleObserved,
			onCommitCollected,
			loadCommitPatch,
			getCurrentCommitSha: async () => "old-amend",
			isAncestor: async (_repoRoot, olderCommit, newerCommit) => {
				if (olderCommit === "old-amend" && newerCommit === "new-amend") {
					return false
				}
				if (olderCommit === "new-amend" && newerCommit === "old-amend") {
					return false
				}
				return true
			},
			loadCommitParent: async (_repoRoot, commitHash) =>
				commitHash === "old-amend" || commitHash === "new-amend" ? "same-parent" : undefined,
		})

		await service.start()
		watchers[0].emit({
			type: "commit",
			previousCommit: "old-amend",
			newCommit: "new-amend",
			branch: "feature/stats",
			isBaseBranch: false,
			watcher: watchers[0],
			files: [],
		})

		await vi.waitFor(() => {
			expect(onCommitLifecycleObserved).toHaveBeenCalledTimes(1)
			expect(onCommitCollected).toHaveBeenCalledTimes(1)
		})
		expect(onCommitLifecycleObserved.mock.calls[0][0]).toMatchObject({
			mode: "commit_lifecycle",
			eventType: "commit_replaced",
			reason: "amend",
			confidence: "strong",
			oldCommitHash: "old-amend",
			newCommitHash: "new-amend",
		})
		expect(onCommitCollected.mock.calls[0][0]).toMatchObject({
			commitHash: "new-amend",
			previousCommit: "",
		})
		expect(loadCommitPatch).toHaveBeenCalledWith("/repo", "", "new-amend")
	})

	it("observes reset rewrite as a strong commits_abandoned lifecycle report", async () => {
		const onCommitLifecycleObserved = vi.fn(async (_payload: any) => {})
		await store.addPendingLineAttributions([buildPendingLine()])
		await store.setRepoObservedCommit("/repo", "old-reset-tip", "feature/stats")
		const service = createService({
			onCommitLifecycleObserved,
			getCurrentCommitSha: async () => "reset-base",
			isAncestor: async (_repoRoot, olderCommit, newerCommit) => {
				if (olderCommit === "old-reset-tip" && newerCommit === "reset-base") {
					return false
				}
				if (olderCommit === "reset-base" && newerCommit === "old-reset-tip") {
					return true
				}
				return false
			},
			listCommitsBetween: async (_repoRoot, fromExclusive, toInclusive) =>
				fromExclusive === "reset-base" && toInclusive === "old-reset-tip"
					? ["old-reset-a", "old-reset-tip"]
					: [],
		})

		await service.start()

		await vi.waitFor(() => {
			expect(onCommitLifecycleObserved).toHaveBeenCalledTimes(1)
		})
		expect(onCommitLifecycleObserved.mock.calls[0][0]).toMatchObject({
			mode: "commit_lifecycle",
			eventType: "commits_abandoned",
			reason: "reset",
			confidence: "strong",
			oldCommitHash: "old-reset-a",
			commitHashes: ["old-reset-a", "old-reset-tip"],
			replacementCommitHashes: [],
		})
		expect(await store.getRepoObservedCommit("/repo", "feature/stats")).toBe("reset-base")
	})

	it("observes non-fast-forward branch rewrite as weak diagnostic lifecycle report", async () => {
		const onCommitLifecycleObserved = vi.fn(async (_payload: any) => {})
		await store.addPendingLineAttributions([buildPendingLine()])
		await store.setRepoObservedCommit("/repo", "old-rewrite-tip", "feature/stats")
		const service = createService({
			onCommitLifecycleObserved,
			getCurrentCommitSha: async () => "new-rewrite-tip",
			isAncestor: async () => false,
			loadCommitParent: async (_repoRoot, commitHash) =>
				commitHash === "old-rewrite-tip" ? "old-parent" : "new-parent",
			mergeBase: async () => "rewrite-base",
			listCommitsBetween: async (_repoRoot, fromExclusive, toInclusive) => {
				if (fromExclusive === "rewrite-base" && toInclusive === "old-rewrite-tip") {
					return ["old-rewrite-a", "old-rewrite-tip"]
				}
				if (fromExclusive === "rewrite-base" && toInclusive === "new-rewrite-tip") {
					return ["new-rewrite-a", "new-rewrite-tip"]
				}
				return []
			},
		})

		await service.start()

		await vi.waitFor(() => {
			expect(onCommitLifecycleObserved).toHaveBeenCalledTimes(1)
		})
		expect(onCommitLifecycleObserved.mock.calls[0][0]).toMatchObject({
			mode: "commit_lifecycle",
			eventType: "branch_rewrite_observed",
			reason: "rewrite_unknown",
			confidence: "weak",
			commitHashes: ["old-rewrite-a", "old-rewrite-tip"],
			replacementCommitHashes: ["new-rewrite-a", "new-rewrite-tip"],
		})
	})

	it("loads large commit diffs per file instead of hitting the old 16MB git buffer", async () => {
		const repoDir = await initRealGitRepo()
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true })
		await fs.writeFile(path.join(repoDir, "src/large-a.ts"), buildLargeSource("a", 42_000), "utf8")
		await fs.writeFile(path.join(repoDir, "src/large-b.ts"), buildLargeSource("b", 42_000), "utf8")
		await execFileAsync("git", ["add", "src/large-a.ts", "src/large-b.ts"], { cwd: repoDir })
		await execFileAsync("git", ["commit", "-m", "large commit"], { cwd: repoDir })
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
		const commitHash = stdout.trim()

		const service = new AiCodeCommitAttributionService(store, {
			createWatcher: () => {
				const watcher = new FakeWatcher()
				watchers.push(watcher)
				return watcher
			},
			loadCommitFileContent: async () => undefined,
			getCurrentBranch: async () => "main",
		})

		const facts = await service.collectCommitFactsForReplay(repoDir, commitHash, "main")

		expect(facts.changedFiles.map((file) => file.relativePath).sort()).toEqual(["src/large-a.ts", "src/large-b.ts"])
		expect(facts.changedFiles.reduce((total, file) => total + (file.addedLines?.length ?? 0), 0)).toBe(84_000)
	}, 20_000)

	it("does not upload attribution facts when commit timestamp loading fails", async () => {
		const onCommitCollected = vi.fn(async (_payload: any) => {})
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const loadCommitTimestamp = vi.fn(async () => {
			throw new Error("timestamp failed")
		})
		const service = createService({
			onCommitCollected,
			onCommitComparisonCompleted,
			loadCommitTimestamp,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/file.ts b/src/file.ts",
					"--- a/src/file.ts",
					"+++ b/src/file.ts",
					"@@ -0,0 +1 @@",
					"+const total = calculateTotal(items)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions([buildPendingLine()])

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
			expect(loadCommitTimestamp).toHaveBeenCalledTimes(1)
		})

		expect(onCommitCollected).not.toHaveBeenCalled()
		expect(onCommitComparisonCompleted).not.toHaveBeenCalled()
		expect(await store.getRepoObservedCommit("/repo", "feature/stats")).toBe("head-1")
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(1)
	})
})
