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
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { type AiCodePendingLineAttribution } from "../types"

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
			getCurrentBranch: async () => "feature/stats",
			getCurrentCommitSha: async () => "head-1",
			isDetachedHead: async () => false,
			isAncestor: async () => true,
			listCommitsBetween: async () => [],
			listCommitsSinceTimestamp: async () => [],
			...overrides,
		})

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
		await service.registerPendingLineAttributions([
			buildPendingLine({
				id: "line-1",
				generatedEventId: "generated-1",
				lineHash: hashLineFingerprint("const value = 1"),
				occurrenceIndex: 1,
			}),
			buildPendingLine({
				id: "line-2",
				generatedEventId: "generated-1",
				lineHash: hashLineFingerprint("const other = 2"),
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

		await vi.waitFor(async () => {
			const events = await store.getRecentEvents(1, undefined, 1_772_500_000_000)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				metricType: "committed",
				commitHash: "def456",
				commitOccurredAt: 1_772_500_000_000,
				filePath: "/repo/src/a.ts",
				relativePath: "src/a.ts",
				lineStart: 1,
				lineEnd: 2,
				lineCount: 2,
				codeSnippet: "const value = 1\nconst other = 2",
				matchStrategy: "exact",
				matchConfidence: 1,
				equivalentLineCount: 2,
			})
		})

		expect(onCommitComparisonCompleted).toHaveBeenCalledTimes(1)
		expect(await store.getPendingLineAttributions("/repo")).toHaveLength(0)
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
	})

	it("does not count modified lines as committed", async () => {
		const onCommitComparisonCompleted = vi.fn(async () => {})
		const service = createService({
			onCommitComparisonCompleted,
			loadCommitPatch: async () =>
				[
					"diff --git a/src/a.ts b/src/a.ts",
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -1 +1 @@",
					"+const value = 2",
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
			expect(await store.getRepoObservedCommit("/repo")).toBe("def456")
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
					"+const result = calculateTotal(items, taxRate)",
					"+return formatCurrency(result, currencyCode, localeSetting)",
				].join("\n"),
		})

		await service.start()
		await service.registerPendingLineAttributions(
			buildPendingBlock(
				[
					"const total = calculateTotal(items, taxRate)",
					"return formatCurrency(total, currencyCode, localeSetting)",
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
				metricType: "committed",
				matchStrategy: "partial_block",
				lineCount: 2,
				codeSnippet:
					"const result = calculateTotal(items, taxRate)\nreturn formatCurrency(result, currencyCode, localeSetting)",
			})
			expect(events[0].matchConfidence).toBeGreaterThanOrEqual(0.85)
			expect(events[0].matchConfidence).toBeLessThan(1)
			expect(events[0].equivalentLineCount).toBeGreaterThan(1.7)
			expect(events[0].equivalentLineCount).toBeLessThan(2)
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
			expect(events[0].matchStrategy).toBe("partial_block")
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
				matchStrategy: "partial_block",
				matchConfidence: 1,
				equivalentLineCount: 2,
			})
		})
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
				matchStrategy: "partial_block",
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
				matchStrategy: "partial_block",
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
})
