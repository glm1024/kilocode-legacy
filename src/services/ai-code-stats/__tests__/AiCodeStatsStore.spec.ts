// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	type AiCodePendingLineAttribution,
	type AiCodeQueuedCommitLifecycleReport,
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

const buildQueuedLifecycleReport = (
	overrides: Partial<AiCodeQueuedCommitLifecycleReport> = {},
): AiCodeQueuedCommitLifecycleReport => ({
	report: overrides.report ?? {
		version: "v1",
		source: "kilocode-ai-code-stats",
		mode: "commit_lifecycle",
		semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
		eventId: "lifecycle-1",
		reportId: "report-lifecycle-1",
		eventOccurredAt: Date.now(),
		reportedAt: Date.now(),
		client: { ide: "vscode" },
		repoRoot: "/repo",
		projectKey: "project-key",
		projectName: "repo",
		gitBranch: "feature/stats",
		eventType: "commit_replaced",
		reason: "amend",
		confidence: "strong",
		oldCommitHash: "old-commit",
		newCommitHash: "new-commit",
		commitHashes: ["old-commit"],
		replacementCommitHashes: ["new-commit"],
	},
	createdAt: overrides.createdAt ?? Date.now(),
})

const buildUploadEvent = (eventId: string, timestamp: number = Date.now()) => ({
	eventId,
	timestamp,
	semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: "agent_insert" as const,
	ide: "vscode",
	metricType: "generated" as const,
	projectKey: "project-key",
	projectName: "repo",
	repoRoot: "/repo",
	repoRelativePath: "src/a.ts",
	filePath: "/repo/src/a.ts",
	relativePath: "src/a.ts",
	lineStart: 1,
	lineEnd: 1,
	lineCount: 1,
	codeSnippet: `const ${eventId.replace(/[^a-zA-Z0-9_$]/g, "_")} = true`,
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

	it("retains unacknowledged upload outbox records beyond the attribution retention window", async () => {
		const oldTs = new Date("2026-01-01T00:00:00.000Z").getTime()
		const nowTs = new Date("2026-03-05T00:00:00.000Z").getTime()
		await store.appendEvent({
			eventId: "old-undelivered-event",
			timestamp: oldTs,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: "vscode",
			metricType: "generated",
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const retained = true",
		})
		await store.queueCommitLifecycleReport(
			buildQueuedLifecycleReport({
				createdAt: oldTs,
				report: {
					...buildQueuedLifecycleReport().report,
					eventId: "old-undelivered-lifecycle",
					reportId: "old-undelivered-lifecycle-report",
					eventOccurredAt: oldTs,
					reportedAt: oldTs,
				},
			}),
		)

		await store.pruneOldData(30, nowTs)

		expect((await store.getPendingEvents()).map((event) => event.eventId)).toEqual(["old-undelivered-event"])
		expect((await store.getQueuedCommitLifecycleReportsForTests()).map((item) => item.report.eventId)).toEqual([
			"old-undelivered-lifecycle",
		])
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

	it("replays a durable pending transaction before loading store state", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const event = {
			eventId: "event-from-pending-transaction",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "generated" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const recovered = true",
		}
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "pending-transaction.json"),
			JSON.stringify({
				version: 1,
				uploadEvents: [event],
				writes: [
					{
						key: "state",
						value: {
							version: 1,
							pendingEventIds: [event.eventId],
							supersededEventIds: [],
							repoObservedCommits: {},
							lastUpload: { status: "idle" },
						},
					},
					{
						key: "queuedReports",
						value: [buildQueuedReport()],
					},
				],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		expect((await reloadedStore.getQueuedReportsForTests()).map((item) => item.report.reportId)).toEqual([
			"report-1",
		])
		await expect(fs.access(path.join(baseDir, "pending-transaction.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("recovers a safe-write transaction artifact before replay", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, ".pending-transaction.json.new_1772500000000_recovery.tmp"),
			JSON.stringify({
				version: 1,
				writes: [
					{
						key: "state",
						value: {
							version: 1,
							pendingEventIds: [],
							supersededEventIds: [],
							repoObservedCommits: {},
							lastUpload: { status: "success", timestamp: 1_772_500_000_000 },
						},
					},
				],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getRawStateForTests()).lastUpload).toEqual({
			status: "success",
			timestamp: 1_772_500_000_000,
		})
		await expect(fs.access(path.join(baseDir, "pending-transaction.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("deduplicates an upload event when transaction recovery repeats an append", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const event = {
			eventId: "event-appended-before-crash",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "accepted" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const accepted = true",
		}
		const state = {
			version: 1,
			pendingEventIds: [event.eventId],
			supersededEventIds: [],
			repoObservedCommits: {},
			lastUpload: { status: "idle" },
		}
		await fs.mkdir(queueDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "state.json"), JSON.stringify(state), "utf8")
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), `${JSON.stringify(event)}\n`, "utf8")
		await fs.writeFile(
			path.join(baseDir, "pending-transaction.json"),
			JSON.stringify({
				version: 1,
				uploadEvents: [event],
				writes: [{ key: "state", value: state }],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		const persistedLines = (await fs.readFile(path.join(queueDir, "2026-03-19.ndjson"), "utf8"))
			.split("\n")
			.filter(Boolean)
		expect(persistedLines).toHaveLength(1)
	})

	it("separates a replayed event from an interrupted NDJSON tail", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const event = {
			eventId: "event-after-partial-tail",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "generated" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const recovered = true",
		}
		const state = {
			version: 1,
			pendingEventIds: [event.eventId],
			supersededEventIds: [],
			repoObservedCommits: {},
			lastUpload: { status: "idle" },
		}
		await fs.mkdir(queueDir, { recursive: true })
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), '{"eventId":"interrupted', "utf8")
		await fs.writeFile(
			path.join(baseDir, "pending-transaction.json"),
			JSON.stringify({
				version: 1,
				uploadEvents: [event],
				writes: [{ key: "state", value: state }],
			}),
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		const records = (await fs.readFile(path.join(queueDir, "2026-03-19.ndjson"), "utf8"))
			.split("\n")
			.filter(Boolean)
		expect(records).toHaveLength(2)
		expect(JSON.parse(records[1]).eventId).toBe(event.eventId)
	})

	it("archives an invalid pending transaction instead of permanently blocking the store", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "pending-transaction.json"), '{"version":1,"writes":', "utf8")

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		await expect(reloadedStore.getRawStateForTests()).resolves.toMatchObject({
			version: 1,
			pendingEventIds: [],
		})
		const files = await fs.readdir(baseDir)
		expect(files).not.toContain("pending-transaction.json")
		expect(files.some((fileName) => fileName.startsWith("pending-transaction.json.invalid-"))).toBe(true)
	})

	it("keeps automatic reanalysis records hidden from the visible failure list", async () => {
		await store.upsertCommitUploadRecord({
			commitHash: "commit-auto",
			repoRoot: "/repo",
			reportId: "replay-auto",
			status: "auto_reanalysis_pending",
			autoRetryCount: 1,
			nextAutoRetryAt: Date.now() + 5 * 60 * 1000,
		})
		await store.upsertCommitUploadRecord({
			commitHash: "commit-visible",
			repoRoot: "/repo",
			reportId: "replay-visible",
			status: "reanalysis_failed",
		})

		const allRecords = await store.getCommitUploadRecords()
		expect(allRecords.find((record) => record.commitHash === "commit-auto")).toMatchObject({
			status: "auto_reanalysis_pending",
			autoRetryCount: 1,
			nextAutoRetryAt: expect.any(Number),
		})

		const visibleRecords = await store.getVisibleCommitUploadRecords()
		expect(visibleRecords.map((record) => record.commitHash)).toEqual(["commit-visible"])
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
		const archivedStores = (await fs.readdir(path.join(tmpDir, "ai-code-stats"))).filter((name) =>
			name.startsWith("v1.incompatible-"),
		)
		expect(archivedStores).toHaveLength(1)
		expect(
			JSON.parse(await fs.readFile(path.join(tmpDir, "ai-code-stats", archivedStores[0], "state.json"), "utf8")),
		).toMatchObject({ version: 6 })
	})

	it("recovers durable event bodies when state.json is corrupt", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const queueDir = path.join(baseDir, "upload-events")
		const event = {
			eventId: "event-recovered-from-outbox",
			timestamp: new Date("2026-03-19T12:00:00.000Z").getTime(),
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert" as const,
			ide: "vscode",
			metricType: "generated" as const,
			projectKey: "project-key",
			projectName: "repo",
			repoRoot: "/repo",
			repoRelativePath: "src/a.ts",
			filePath: "/repo/src/a.ts",
			relativePath: "src/a.ts",
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const recovered = true",
		}
		await fs.mkdir(queueDir, { recursive: true })
		await fs.writeFile(path.join(queueDir, "2026-03-19.ndjson"), `${JSON.stringify(event)}\n`, "utf8")
		await fs.writeFile(path.join(baseDir, "state.json"), "{not-json", "utf8")

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect((await reloadedStore.getPendingEvents()).map((item) => item.eventId)).toEqual([event.eventId])
		const archivedStateFiles = (await fs.readdir(baseDir)).filter((name) => name.startsWith("state.json.corrupt-"))
		expect(archivedStateFiles).toHaveLength(1)
	})

	it("preserves a corrupt commit-report outbox file as forensic evidence", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "queued-reports.json"), "[broken", "utf8")

		const reloadedStore = new AiCodeStatsStore(tmpDir)

		expect(await reloadedStore.getQueuedReportsForTests()).toEqual([])
		const files = await fs.readdir(baseDir)
		expect(files.some((fileName) => fileName.startsWith("queued-reports.json.corrupt-"))).toBe(true)
		expect(JSON.parse(await fs.readFile(path.join(baseDir, "queued-reports.json"), "utf8"))).toEqual([])
	})

	it("reloads durable state after a persistence failure instead of leaking rejected in-memory mutations", async () => {
		await store.getRawStateForTests()
		const persistTransaction = vi
			.spyOn(store as any, "persistTransaction")
			.mockRejectedValueOnce(new Error("simulated disk failure"))

		await expect(store.queueCommitReport(buildQueuedReport())).rejects.toThrow("simulated disk failure")
		persistTransaction.mockRestore()

		expect(await store.getQueuedReportsForTests()).toHaveLength(0)
	})

	it("clears repo commit cursors when a repo no longer has pending lines", async () => {
		const pendingLine: AiCodePendingLineAttribution = buildPendingLine({ id: "line-1" })

		await store.addPendingLineAttributions([pendingLine])
		await store.setRepoObservedCommit("/repo", "abc123")
		await store.setRepoObservedCommit("/repo", "branch-a-tip", "feature/a")
		await store.setRepoObservedCommit("/repo", "branch-b-tip", "feature/b")
		expect(await store.getRepoObservedCommit("/repo")).toBe("abc123")
		expect(await store.getRepoObservedCommit("/repo", "feature/a")).toBe("branch-a-tip")
		expect(await store.getRepoObservedCommit("/repo", "feature/b")).toBe("branch-b-tip")

		await store.removePendingLineAttributions(["line-1"])
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
		expect(await store.getRepoObservedCommit("/repo", "feature/a")).toBeUndefined()
		expect(await store.getRepoObservedCommit("/repo", "feature/b")).toBeUndefined()
	})

	it("queues and acknowledges commit lifecycle reports independently from commit reports", async () => {
		await store.queueCommitReport(buildQueuedReport())
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())
		await store.queueCommitLifecycleReport(buildQueuedLifecycleReport())

		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
		const lifecycleReports = await store.getQueuedCommitLifecycleReportsForTests()
		expect(lifecycleReports).toHaveLength(1)
		expect(lifecycleReports[0].report).toMatchObject({
			mode: "commit_lifecycle",
			eventId: "lifecycle-1",
			eventType: "commit_replaced",
			reason: "amend",
			confidence: "strong",
			commitHashes: ["old-commit"],
			replacementCommitHashes: ["new-commit"],
		})

		await store.markQueuedCommitLifecycleReportBlocked("lifecycle-1", "invalid local lifecycle payload")
		const reloadedStore = new AiCodeStatsStore(tmpDir)
		expect((await reloadedStore.getQueuedCommitLifecycleReportsForTests())[0]).toMatchObject({
			blockedReason: "invalid local lifecycle payload",
			blockedAt: expect.any(Number),
		})

		await store.acknowledgeQueuedCommitLifecycleReport("lifecycle-1")

		expect(await store.getQueuedCommitLifecycleReportsForTests()).toEqual([])
		expect(await store.getQueuedReportsForTests()).toHaveLength(1)
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
				provider: "openai",
				model: "gpt-5.4",
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
		expect(queuedReports[0].report.candidateLines?.[0].provider).toBe("openai")
		expect(queuedReports[0].report.candidateLines?.[0].model).toBe("gpt-5.4")
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

	it("preserves updates from multiple extension hosts sharing global storage", async () => {
		const firstHost = new AiCodeStatsStore(tmpDir)
		const secondHost = new AiCodeStatsStore(tmpDir)
		await Promise.all([firstHost.getPendingEvents(), secondHost.getPendingEvents()])

		await firstHost.appendEvent(buildUploadEvent("event-from-first-host", 1_773_900_000_000))
		await secondHost.appendEvent(buildUploadEvent("event-from-second-host", 1_773_900_000_001))
		await firstHost.addPendingLineAttributions([buildPendingLine({ id: "line-from-first-host" })])
		await secondHost.addPendingLineAttributions([buildPendingLine({ id: "line-from-second-host" })])

		const persisted = new AiCodeStatsStore(tmpDir)
		expect((await persisted.getPendingEvents()).map((event) => event.eventId)).toEqual([
			"event-from-first-host",
			"event-from-second-host",
		])
		expect((await persisted.getPendingLineAttributions()).map((line) => line.id).sort()).toEqual([
			"line-from-first-host",
			"line-from-second-host",
		])
	})

	it("does not expose an in-flight mutation to unrelated reads before it is durable", async () => {
		await store.getPendingEvents()
		const originalPersistTransaction = (store as any).persistTransaction.bind(store)
		let enterPersist!: () => void
		let releasePersist!: () => void
		const persistEntered = new Promise<void>((resolve) => {
			enterPersist = resolve
		})
		const persistReleased = new Promise<void>((resolve) => {
			releasePersist = resolve
		})
		const persistTransaction = vi
			.spyOn(store as any, "persistTransaction")
			.mockImplementation(async (...args: unknown[]) => {
				enterPersist()
				await persistReleased
				return originalPersistTransaction(...args)
			})

		const appendPromise = store.appendEvent(buildUploadEvent("event-in-flight", 1_773_900_000_002))
		await persistEntered
		let readSettled = false
		const readPromise = store.getPendingEvents().then((events) => {
			readSettled = true
			return events
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		const settledBeforeCommit = readSettled
		releasePersist()

		await appendPromise
		await expect(readPromise).resolves.toEqual([
			expect.objectContaining({
				eventId: "event-in-flight",
			}),
		])
		expect(settledBeforeCommit).toBe(false)
		persistTransaction.mockRestore()
	})
})
