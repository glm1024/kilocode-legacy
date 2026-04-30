// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it } from "vitest"

import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	type AiCodePendingLineAttribution,
	type AiCodeQueuedCommitReport,
} from "../types"

const buildPendingLine = (overrides: Partial<AiCodePendingLineAttribution> = {}): AiCodePendingLineAttribution => {
	const rawLine = overrides.rawLine ?? "const value = 1"

	return {
		id: overrides.id ?? `line-${Math.random().toString(36).slice(2)}`,
		generatedEventId: overrides.generatedEventId ?? "generated-1",
		blockId: overrides.blockId ?? overrides.generatedEventId ?? "generated-1",
		timestamp: overrides.timestamp ?? Date.now(),
		sourceType: overrides.sourceType ?? "agent_insert",
		ide: overrides.ide ?? "vscode",
		projectKey: overrides.projectKey ?? "project-key",
		projectName: overrides.projectName ?? "repo",
		filePath: overrides.filePath ?? "/repo/src/a.ts",
		relativePath: overrides.relativePath ?? "src/a.ts",
		repoRoot: overrides.repoRoot ?? "/repo",
		repoRelativePath: overrides.repoRelativePath ?? "src/a.ts",
		language: overrides.language ?? "typescript",
		gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/repo.git",
		gitBranch: overrides.gitBranch ?? "feature/stats",
		taskId: overrides.taskId,
		rawLine,
		blockLineIndex: overrides.blockLineIndex ?? overrides.occurrenceIndex ?? 1,
		blockLineCount: overrides.blockLineCount ?? 1,
		lineHash: overrides.lineHash ?? hashLineFingerprint(rawLine),
		occurrenceIndex: overrides.occurrenceIndex ?? 1,
	}
}

const buildQueuedReport = (overrides: Partial<AiCodeQueuedCommitReport> = {}): AiCodeQueuedCommitReport => ({
	report: overrides.report ?? {
		version: "v2",
		source: "kilocode-ai-code-stats",
		mode: "commit_report",
		reportId: "report-1",
		reportGeneratedAt: Date.now(),
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		client: { ide: "vscode" },
		repoRoot: "/repo",
		projectKey: "project-key",
		projectName: "repo",
		gitBranch: "feature/stats",
		commitHash: "commit-1",
		previousCommitHash: "commit-0",
		commitOccurredAt: Date.now(),
		acceptedBlocks: [],
		changedFiles: [],
	},
	createdAt: overrides.createdAt ?? Date.now(),
	generatedBlockIds: overrides.generatedBlockIds ?? [],
})

describe("AiCodeStatsStore", () => {
	let tmpDir: string
	let store: AiCodeStatsStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-store-"))
		store = new AiCodeStatsStore(tmpDir)
	})

	it("prunes old local commit facts", async () => {
		const oldTs = new Date("2026-01-01T00:00:00.000Z").getTime()
		const newTs = new Date("2026-03-05T00:00:00.000Z").getTime()
		await store.addPendingLineAttributions([
			buildPendingLine({ id: "old", timestamp: oldTs }),
			buildPendingLine({ id: "new", timestamp: newTs }),
		])

		await store.pruneOldData(30, newTs)

		const pending = await store.getPendingLineAttributions()
		expect(pending.map((line) => line.id)).toEqual(["new"])
	})

	it("preserves last upload status in queue state", async () => {
		const nowDate = new Date("2026-03-19T12:00:00.000Z")
		const now = nowDate.getTime()

		await store.setLastUploadStatus({
			status: "success",
			timestamp: now,
			mode: "incremental",
			trigger: "commit",
			uploadedEvents: 2,
		})
		const state = await store.getRawStateForTests()
		expect(state.lastUpload).toMatchObject({
			status: "success",
			timestamp: now,
			mode: "incremental",
			trigger: "commit",
			uploadedEvents: 2,
		})
	})

	it("loads current-version state files", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				lastUpload: { status: "idle" },
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		const state = await reloadedStore.getRawStateForTests()
		expect(state.repoObservedCommits).toEqual({})
	})

	it("discards incompatible persisted state versions and cold starts", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 6,
				lastUpload: { status: "success", uploadedEvents: 3 },
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		expect(await reloadedStore.getPendingEventCount()).toBe(0)
		expect((await reloadedStore.getRawStateForTests()).lastUpload).toEqual({ status: "idle" })
	})

	it("clears repo commit cursors when a repo no longer has pending lines", async () => {
		const pendingLine: AiCodePendingLineAttribution = buildPendingLine({ id: "line-1" })

		await store.addPendingLineAttributions([pendingLine])
		await store.setRepoObservedCommit("/repo", "abc123")
		expect(await store.getRepoObservedCommit("/repo")).toBe("abc123")

		await store.removePendingLineAttributions(["line-1"])
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
	})

	it("keeps pending lines while a queued report is waiting and after acknowledgement", async () => {
		await store.addPendingLineAttributions([buildPendingLine({ id: "line-1" }), buildPendingLine({ id: "line-2" })])
		await store.queueCommitReport(buildQueuedReport())

		const visiblePendingLines = await store.getPendingLineAttributions("/repo")
		expect(visiblePendingLines.map((line) => line.id)).toEqual(["line-1", "line-2"])

		await store.acknowledgeQueuedCommitReport("report-1")
		const persistedPendingLines = await store.getPendingLineAttributions("/repo")
		expect(persistedPendingLines.map((line) => line.id)).toEqual(["line-1", "line-2"])
	})

	it("queues commit reports without creating standalone upload events", async () => {
		const generationTs = new Date("2026-03-10T10:00:00.000Z").getTime()
		const commitTs = new Date("2026-03-11T10:00:00.000Z").getTime()

		await store.queueCommitReport(
			buildQueuedReport({
				report: {
					version: "v2",
					source: "kilocode-ai-code-stats",
					mode: "commit_report",
					reportId: "report-rebucket",
					reportGeneratedAt: commitTs,
					semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
					client: { ide: "vscode" },
					repoRoot: "/repo",
					projectKey: "project-key",
					projectName: "repo",
					gitBranch: "feature/stats",
					commitHash: "commit-1",
					previousCommitHash: "commit-0",
					commitOccurredAt: commitTs,
					generatedBlocks: [
						{
							eventId: "gen-baseline",
							generatedBlockId: "generated-block-1",
							timestamp: generationTs,
							semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
							sourceType: "agent_insert",
							ide: "vscode",
							projectKey: "project-key",
							projectName: "repo",
							repoRoot: "/repo",
							repoRelativePath: "src/a.ts",
							filePath: "/workspace/src/a.ts",
							relativePath: "src/a.ts",
							lineStart: 1,
							lineEnd: 4,
							lineCount: 4,
							codeSnippet: "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4",
						},
					],
					acceptedBlocks: [
						{
							eventId: "acc-baseline",
							generatedBlockId: "generated-block-1",
							timestamp: commitTs,
							semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
							sourceType: "agent_insert",
							ide: "vscode",
							projectKey: "project-key",
							projectName: "repo",
							repoRoot: "/repo",
							repoRelativePath: "src/a.ts",
							filePath: "/workspace/src/a.ts",
							relativePath: "src/a.ts",
							lineStart: 1,
							lineEnd: 4,
							lineCount: 4,
							codeSnippet: "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4",
						},
					],
					changedFiles: [],
				},
				createdAt: commitTs,
				generatedBlockIds: ["generated-block-1"],
			}),
		)

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports.map((report) => report.report.reportId)).toEqual(["report-rebucket"])
	})

	it("preserves product-level IDE values on queued commit report candidate lines", async () => {
		const report = buildQueuedReport()
		report.report.client = { ide: "goland" }
		report.report.candidateLines = [
			{
				clientLineId: "line-goland",
				generatedBlockId: "generated-1",
				baselineEventId: "accepted-1",
				baselineMetricType: "accepted",
				sourceTimestamp: new Date("2026-03-11T10:00:00.000Z").getTime(),
				sourceType: "agent_insert",
				ide: "goland",
				projectKey: "project-key",
				projectName: "repo",
				filePath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
				repoRoot: "/repo",
				repoRelativePath: "src/a.ts",
				lineNumber: 1,
				rawLine: "const value = 1",
				blockLineIndex: 1,
				blockLineCount: 1,
				lineHash: hashLineFingerprint("const value = 1"),
				occurrenceIndex: 1,
			},
		]

		await store.queueCommitReport(report)

		const queuedReports = await store.getQueuedReportsForTests()
		expect(queuedReports[0].report.client.ide).toBe("goland")
		expect(queuedReports[0].report.candidateLines?.[0].ide).toBe("goland")
	})

	it("prunes snapshot-store entries that are no longer referenced after queued report ack", async () => {
		const firstReport = buildQueuedReport({
			report: {
				...buildQueuedReport().report,
				reportId: "report-prune-1",
				commitHash: "commit-prune-1",
				acceptedBlocks: [
					{
						eventId: "accepted-prune-1",
						generatedBlockId: "generated-prune-1",
						timestamp: Date.now(),
						semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
						sourceType: "agent_insert",
						ide: "vscode",
						projectKey: "project-key",
						projectName: "repo",
						repoRoot: "/repo",
						repoRelativePath: "src/a.ts",
						filePath: "/repo/src/a.ts",
						relativePath: "src/a.ts",
						lineStart: 1,
						lineEnd: 1,
						lineCount: 1,
						codeSnippet: "const a = 1",
						fileSnapshotContent: "const a = 1\n",
					},
				],
				changedFiles: [],
			},
			generatedBlockIds: ["generated-prune-1"],
		})
		const secondReport = buildQueuedReport({
			report: {
				...buildQueuedReport().report,
				reportId: "report-prune-2",
				commitHash: "commit-prune-2",
				acceptedBlocks: [
					{
						eventId: "accepted-prune-2",
						generatedBlockId: "generated-prune-2",
						timestamp: Date.now(),
						semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
						sourceType: "agent_insert",
						ide: "vscode",
						projectKey: "project-key",
						projectName: "repo",
						repoRoot: "/repo",
						repoRelativePath: "src/b.ts",
						filePath: "/repo/src/b.ts",
						relativePath: "src/b.ts",
						lineStart: 1,
						lineEnd: 1,
						lineCount: 1,
						codeSnippet: "const b = 2",
						fileSnapshotContent: "const b = 2\n",
					},
				],
				changedFiles: [],
			},
			generatedBlockIds: ["generated-prune-2"],
		})

		await store.queueCommitReport(firstReport)
		await store.queueCommitReport(secondReport)
		expect(
			Object.values(await store.getSnapshotsForTests())
				.map((entry) => entry.content)
				.sort(),
		).toEqual(["const a = 1\n", "const b = 2\n"])

		await store.acknowledgeQueuedCommitReport("report-prune-1")

		expect(Object.values(await store.getSnapshotsForTests()).map((entry) => entry.content)).toEqual([
			"const b = 2\n",
		])
	})

	it("compacts old v2 queued reports on load while keeping snapshot content resolvable", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				pendingEventIds: [],
				supersededEventIds: [],
				repoObservedCommits: {},
				lastUpload: { status: "idle" },
			}),
			"utf8",
		)
		await fs.writeFile(
			path.join(baseDir, "queued-reports.json"),
			JSON.stringify([
				buildQueuedReport({
					report: {
						...buildQueuedReport().report,
						reportId: "report-old-v2",
						commitHash: "commit-old-v2",
						acceptedBlocks: [
							{
								eventId: "accepted-old-v2",
								generatedBlockId: "generated-old-v2",
								timestamp: Date.now(),
								semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
								sourceType: "agent_insert",
								ide: "vscode",
								projectKey: "project-key",
								projectName: "repo",
								repoRoot: "/repo",
								repoRelativePath: "src/old.ts",
								filePath: "/repo/src/old.ts",
								relativePath: "src/old.ts",
								lineStart: 1,
								lineEnd: 1,
								lineCount: 1,
								codeSnippet: "const oldValue = 1",
								fileSnapshotContent: "const oldValue = 1\n",
							},
						],
						changedFiles: [
							{
								relativePath: "src/old.ts",
								filePath: "/repo/src/old.ts",
								language: "typescript",
								committedSnapshotContent: "const oldValue = 1\n",
								changedBlocks: [],
							},
						],
					},
					generatedBlockIds: ["generated-old-v2"],
				}),
			]),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		const queuedReports = await reloadedStore.getQueuedReportsForTests()
		expect(queuedReports[0].report.acceptedBlocks?.[0].fileSnapshotContent).toBe("const oldValue = 1\n")
		expect(queuedReports[0].report.changedFiles[0].committedSnapshotContent).toBe("const oldValue = 1\n")

		const persistedQueuedReports = JSON.parse(await fs.readFile(path.join(baseDir, "queued-reports.json"), "utf8"))
		expect(persistedQueuedReports[0].report.acceptedBlocks[0].fileSnapshotContent).toBeUndefined()
		expect(persistedQueuedReports[0].report.acceptedBlocks[0].fileSnapshotHash).toEqual(expect.any(String))
		expect(persistedQueuedReports[0].report.changedFiles[0].committedSnapshotContent).toBeUndefined()
		expect(persistedQueuedReports[0].report.changedFiles[0].committedSnapshotHash).toEqual(expect.any(String))
		expect(Object.values(await reloadedStore.getSnapshotsForTests()).map((entry) => entry.content)).toEqual([
			"const oldValue = 1\n",
		])
	})

	it("does not enqueue client-side committed events", async () => {
		await store.appendEvent({
			eventId: "client-committed",
			timestamp: Date.now(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "committed",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/workspace/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const committed = true",
		} as any)

		expect(await store.getPendingEvents()).toHaveLength(0)
		expect(await store.getPendingEventCount()).toBe(0)
	})

	it("rejects queued commit reports when candidate sourceTimestamp is missing", async () => {
		const report = buildQueuedReport().report
		report.candidateLines = [
			{
				clientLineId: "line-without-source-time",
				generatedBlockId: "generated-1",
				baselineEventId: "accepted-1",
				baselineMetricType: "accepted",
				sourceType: "agent_insert",
				ide: "vscode",
				projectKey: "project-key",
				projectName: "repo",
				filePath: "/workspace/src/a.ts",
				relativePath: "src/a.ts",
				repoRoot: "/repo",
				repoRelativePath: "src/a.ts",
				lineNumber: 1,
				rawLine: "const value = 1",
				blockLineIndex: 1,
				blockLineCount: 1,
				lineHash: hashLineFingerprint("const value = 1"),
				occurrenceIndex: 1,
			} as any,
		]

		await expect(store.queueCommitReport(buildQueuedReport({ report }))).rejects.toThrow("without sourceTimestamp")
		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})
})
