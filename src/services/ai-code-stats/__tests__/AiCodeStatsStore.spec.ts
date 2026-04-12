// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it } from "vitest"

import { extractLineFeatures } from "../AiCodeLineFeatures"
import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { hashLineFingerprint } from "../AiCodeLineFingerprint"
import {
	CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	type AiCodePendingLineAttribution,
	type AiCodeQueuedCommitReport,
	type AiCodeStatsEvent,
} from "../types"

const buildEvent = (overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
	timestamp: overrides.timestamp ?? Date.now(),
	semanticsVersion: overrides.semanticsVersion ?? CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	metricType: overrides.metricType ?? "generated",
	workspaceName: overrides.workspaceName ?? "project",
	workspacePath: overrides.workspacePath ?? "/workspace/project",
	filePath: overrides.filePath ?? "/workspace/project/src/a.ts",
	relativePath: overrides.relativePath ?? "src/a.ts",
	lineStart: overrides.lineStart ?? 1,
	lineEnd: overrides.lineEnd ?? 1,
	lineCount: overrides.lineCount ?? 1,
	codeSnippet: overrides.codeSnippet ?? "const x = 1",
	taskId: overrides.taskId,
	matchStrategy: overrides.matchStrategy,
	matchConfidence: overrides.matchConfidence,
	equivalentLineCount: overrides.equivalentLineCount,
	commitHash: overrides.commitHash,
	commitOccurredAt: overrides.commitOccurredAt,
	generatedBlockId: overrides.generatedBlockId,
})

const buildPendingLine = (overrides: Partial<AiCodePendingLineAttribution> = {}): AiCodePendingLineAttribution => {
	const rawLine = overrides.rawLine ?? "const value = 1"
	const features = extractLineFeatures(rawLine)

	return {
		id: overrides.id ?? `line-${Math.random().toString(36).slice(2)}`,
		generatedEventId: overrides.generatedEventId ?? "generated-1",
		blockId: overrides.blockId ?? overrides.generatedEventId ?? "generated-1",
		timestamp: overrides.timestamp ?? Date.now(),
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
		rawLine,
		blockLineIndex: overrides.blockLineIndex ?? overrides.occurrenceIndex ?? 1,
		blockLineCount: overrides.blockLineCount ?? 1,
		lineHash: overrides.lineHash ?? hashLineFingerprint(rawLine),
		occurrenceIndex: overrides.occurrenceIndex ?? 1,
		normalizedLine: overrides.normalizedLine ?? features.normalizedLine,
		normalizedTokenLine: overrides.normalizedTokenLine ?? features.normalizedTokenLine,
		rareIdentifiers: overrides.rareIdentifiers ?? features.rareIdentifiers,
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
		workspaceName: "workspace",
		workspacePath: "/workspace",
		projectKey: "project-key",
		gitBranch: "feature/stats",
		commitHash: "commit-1",
		previousCommitHash: "commit-0",
		commitOccurredAt: Date.now(),
		acceptedBlocks: [],
		committedBlocks: [],
		changedFiles: [],
	},
	createdAt: overrides.createdAt ?? Date.now(),
	generatedBlockIds: overrides.generatedBlockIds ?? [],
	matchedPendingLineIds: overrides.matchedPendingLineIds ?? [],
})

describe("AiCodeStatsStore", () => {
	let tmpDir: string
	let store: AiCodeStatsStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-code-stats-store-"))
		store = new AiCodeStatsStore(tmpDir)
	})

	it("appends events and computes summary", async () => {
		const now = new Date("2026-03-05T08:00:00.000Z").getTime()
		await store.appendEvent(buildEvent({ eventId: "e1", timestamp: now, sourceType: "autocomplete", lineCount: 3 }))
		await store.appendEvent(buildEvent({ eventId: "e2", timestamp: now, sourceType: "agent_insert", lineCount: 5 }))

		const summary = await store.getSummary(now)
		expect(summary.today.suggestedLines).toBe(0)
		expect(summary.today.generatedLines).toBe(8)
		expect(summary.today.committedLines).toBe(0)
		expect(summary.total.suggestedLines).toBe(0)
		expect(summary.total.generatedLines).toBe(8)
		expect(summary.total.committedLines).toBe(0)
		expect(summary.pendingEvents).toBe(2)
	})

	it("tracks accepted, strict committed, and equivalent committed lines separately", async () => {
		const now = new Date("2026-03-05T08:00:00.000Z").getTime()
		await store.appendEvent(
			buildEvent({
				eventId: "generated-1",
				timestamp: now,
				lineCount: 4,
			}),
		)
		await store.appendEvent(
			buildEvent({
				eventId: "accepted-1",
				timestamp: now,
				metricType: "accepted",
				lineCount: 4,
			}),
		)
		await store.appendEvent(
			buildEvent({
				eventId: "committed-1",
				timestamp: now,
				metricType: "committed",
				lineCount: 3,
				equivalentLineCount: 2.7345,
				matchStrategy: "partial",
				matchConfidence: 0.9115,
				commitHash: "abc123",
				commitOccurredAt: now,
			}),
		)

		const summary = await store.getSummary(now)
		expect(summary.today.committedLines).toBe(3)
		expect(summary.today.acceptedLines).toBe(4)
		expect(summary.today.retentionRate).toBeCloseTo(3 / 4, 6)
		expect(summary.today.strictCommittedLines).toBe(3)
		expect(summary.today.equivalentCommittedLines).toBe(2.7345)
		expect(summary.today.adoptionRate).toBe(1)
		expect(summary.today.strictAdoptionRate).toBe(1)
		expect(summary.today.equivalentAdoptionRate).toBeCloseTo(0.683625, 6)
		expect(summary.total.acceptedLines).toBe(4)
		expect(summary.total.retentionRate).toBeCloseTo(3 / 4, 6)
		expect(summary.total.equivalentCommittedLines).toBe(2.7345)
	})

	it("records suggested lines without creating detailed events", async () => {
		const now = new Date("2026-03-05T08:00:00.000Z").getTime()
		await store.addSuggestedLines(7, now)

		const summary = await store.getSummary(now)
		expect(summary.today.suggestedLines).toBe(7)
		expect(summary.total.suggestedLines).toBe(7)
		expect(summary.total.generatedLines).toBe(0)
		expect(summary.total.committedLines).toBe(0)
		expect(await store.getPendingEventCount()).toBe(0)
		expect(await store.getSuggestedLinesForRange({ type: "current" }, now)).toBe(7)
	})

	it("marks uploaded events and keeps pending cursor", async () => {
		const now = Date.now()
		await store.appendEvent(buildEvent({ eventId: "e1", timestamp: now }))
		await store.appendEvent(buildEvent({ eventId: "e2", timestamp: now }))

		await store.markEventsUploaded(["e1"])
		const pending = await store.getPendingEvents()
		expect(pending.map((e) => e.eventId)).toEqual(["e2"])
	})

	it("prunes old files and pending ids", async () => {
		const oldTs = new Date("2026-01-01T00:00:00.000Z").getTime()
		const newTs = new Date("2026-03-05T00:00:00.000Z").getTime()
		await store.appendEvent(buildEvent({ eventId: "old", timestamp: oldTs }))
		await store.appendEvent(buildEvent({ eventId: "new", timestamp: newTs }))

		await store.pruneOldData(30, newTs)

		const pending = await store.getPendingEvents()
		expect(pending.map((e) => e.eventId)).toEqual(["new"])

		const state = await store.getRawStateForTests()
		expect(state.pendingEventIds).toEqual(["new"])
		expect(Object.values(state.dailyAggregates).length).toBe(1)
	})

	it("returns recent events window", async () => {
		const day1 = new Date("2026-03-01T00:00:00.000Z").getTime()
		const day4 = new Date("2026-03-04T00:00:00.000Z").getTime()
		await store.appendEvent(buildEvent({ eventId: "a", timestamp: day1 }))
		await store.appendEvent(buildEvent({ eventId: "b", timestamp: day4 }))

		const realNow = Date.now
		Date.now = () => new Date("2026-03-05T10:00:00.000Z").getTime()
		try {
			const events = await store.getRecentEvents(3)
			expect(events.map((e) => e.eventId)).toEqual(["b"])
		} finally {
			Date.now = realNow
		}
	})

	it("supports today/this-week/this-month/custom range aggregation while preserving last upload status", async () => {
		const nowDate = new Date("2026-03-19T12:00:00.000Z")
		const now = nowDate.getTime()

		const weekStart = new Date(nowDate)
		weekStart.setHours(0, 0, 0, 0)
		weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))

		const monthStart = new Date(nowDate)
		monthStart.setHours(0, 0, 0, 0)
		monthStart.setDate(1)

		const previousWeek = new Date(weekStart)
		previousWeek.setDate(previousWeek.getDate() - 1)
		previousWeek.setHours(12, 0, 0, 0)

		const previousMonth = new Date(monthStart)
		previousMonth.setDate(0)
		previousMonth.setHours(12, 0, 0, 0)

		const weekStartNoon = new Date(weekStart)
		weekStartNoon.setHours(12, 0, 0, 0)
		const monthStartNoon = new Date(monthStart)
		monthStartNoon.setHours(12, 0, 0, 0)

		await store.appendEvent(buildEvent({ eventId: "prev-month", timestamp: previousMonth.getTime(), lineCount: 2 }))
		await store.appendEvent(buildEvent({ eventId: "prev-week", timestamp: previousWeek.getTime(), lineCount: 3 }))
		await store.appendEvent(
			buildEvent({ eventId: "month-start", timestamp: monthStartNoon.getTime(), lineCount: 5 }),
		)
		await store.appendEvent(buildEvent({ eventId: "week-start", timestamp: weekStartNoon.getTime(), lineCount: 7 }))
		await store.appendEvent(buildEvent({ eventId: "today", timestamp: now, lineCount: 11 }))

		const todayLines = await store.getGeneratedLinesForRange({ type: "current" }, now)
		expect(todayLines).toBe(11)

		const thisWeekLines = await store.getGeneratedLinesForRange({ type: "last7days" }, now)
		expect(thisWeekLines).toBe(18)

		const thisMonthLines = await store.getGeneratedLinesForRange({ type: "last30days" }, now)
		expect(thisMonthLines).toBe(26)

		const customLines = await store.getGeneratedLinesForRange(
			{ type: "custom", startDate: toDateKey(monthStartNoon), endDate: toDateKey(monthStartNoon) },
			now,
		)
		expect(customLines).toBe(5)

		await store.setLastUploadStatus({
			status: "success",
			timestamp: now,
			mode: "incremental",
			trigger: "manual",
			uploadedEvents: 2,
		})
		const summary = await store.getSummary(now)
		expect(summary.lastUpload).toMatchObject({
			status: "success",
			timestamp: now,
			mode: "incremental",
			trigger: "manual",
			uploadedEvents: 2,
		})
	})

	it("calculates range lines from event files even when state aggregates are stale", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		const eventsDir = path.join(baseDir, "events")
		await fs.mkdir(eventsDir, { recursive: true })

		const writeDayEvents = async (dateKey: string, events: AiCodeStatsEvent[]) => {
			const filePath = path.join(eventsDir, `${dateKey}.ndjson`)
			const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
			await fs.writeFile(filePath, content, "utf8")
		}

		const buildDayEvent = (dateKey: string, lineCount: number, eventId: string): AiCodeStatsEvent =>
			buildEvent({
				eventId,
				timestamp: new Date(`${dateKey}T12:00:00`).getTime(),
				lineCount,
				sourceType: "agent_insert",
			})

		await writeDayEvents("2026-02-20", [buildDayEvent("2026-02-20", 8, "d1")])
		await writeDayEvents("2026-03-01", [buildDayEvent("2026-03-01", 5, "d2")])
		await writeDayEvents("2026-03-03", [buildDayEvent("2026-03-03", 4, "d3")])
		await writeDayEvents("2026-03-04", [buildDayEvent("2026-03-04", 6, "d4")])
		await writeDayEvents("2026-03-05", [buildDayEvent("2026-03-05", 2, "d5")])
		await writeDayEvents("2026-03-06", [buildDayEvent("2026-03-06", 7, "d6")])

		// Keep only today's aggregate in state to simulate stale cache.
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				dailyAggregates: {
					"2026-03-06": { agentLines: 7, totalLines: 7, eventCount: 1 },
				},
				pendingEventIds: ["d6"],
				lastUpload: { status: "idle" },
			}),
			"utf8",
		)

		const now = new Date(2026, 2, 6, 12, 0, 0).getTime()
		expect(await store.getGeneratedLinesForRange({ type: "current" }, now)).toBe(7)
		expect(await store.getGeneratedLinesForRange({ type: "last7days" }, now)).toBe(19)
		expect(await store.getGeneratedLinesForRange({ type: "last30days" }, now)).toBe(24)
		expect(await store.getGeneratedLinesForRange({ type: "all" }, now)).toBe(32)
		expect(
			await store.getGeneratedLinesForRange(
				{ type: "custom", startDate: "2026-03-03", endDate: "2026-03-04" },
				now,
			),
		).toBe(10)
	})

	it("returns range summary with accepted lines and retention rate aligned to strict committed lines", async () => {
		const now = new Date("2026-03-19T12:00:00.000Z").getTime()
		await store.appendEvent(
			buildEvent({
				eventId: "generated-1",
				timestamp: now,
				lineCount: 20,
			}),
		)
		await store.appendEvent(
			buildEvent({
				eventId: "accepted-1",
				timestamp: now,
				metricType: "accepted",
				lineCount: 10,
			}),
		)
		await store.appendEvent(
			buildEvent({
				eventId: "committed-1",
				timestamp: now,
				metricType: "committed",
				lineCount: 8,
				equivalentLineCount: 10.25,
				commitHash: "abc123",
				commitOccurredAt: now,
			}),
		)

		const summary = await store.getRangeSummary({ type: "current" }, now)
		expect(summary.generatedLines).toBe(20)
		expect(summary.acceptedLines).toBe(10)
		expect(summary.committedLines).toBe(8)
		expect(summary.adoptionRate).toBe(10 / 20)
		expect(summary.retentionRate).toBeCloseTo(8 / 10, 6)
	})

	it("loads current-version state files", async () => {
		const baseDir = path.join(tmpDir, "ai-code-stats", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "state.json"),
			JSON.stringify({
				version: 1,
				dailyAggregates: {},
				pendingEventIds: [],
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
				dailyAggregates: {
					"2026-03-06": {
						generatedLines: 12,
						acceptedLines: 12,
						committedLines: 8,
						equivalentCommittedLines: 8,
						suggestedLines: 0,
						eventCount: 3,
					},
				},
				pendingEventIds: ["legacy-event"],
				lastUpload: { status: "success", uploadedEvents: 3 },
			}),
			"utf8",
		)
		await fs.mkdir(path.join(baseDir, "events"), { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "events", "2026-03-06.ndjson"),
			`${JSON.stringify(buildEvent({ eventId: "legacy-event" }))}\n`,
			"utf8",
		)

		const reloadedStore = new AiCodeStatsStore(tmpDir)
		expect(await reloadedStore.getSummary()).toMatchObject({
			total: {
				generatedLines: 0,
				acceptedLines: 0,
				committedLines: 0,
			},
			lastUpload: {
				status: "idle",
			},
			pendingEvents: 0,
		})
		expect(await reloadedStore.getEventsForRange({ type: "all" })).toEqual([])
	})

	it("clears repo commit cursors when a repo no longer has pending lines", async () => {
		const pendingLine: AiCodePendingLineAttribution = buildPendingLine({ id: "line-1" })

		await store.addPendingLineAttributions([pendingLine])
		await store.setRepoObservedCommit("/repo", "abc123")
		expect(await store.getRepoObservedCommit("/repo")).toBe("abc123")

		await store.removePendingLineAttributions(["line-1"])
		expect(await store.getRepoObservedCommit("/repo")).toBeUndefined()
	})

	it("hides matched pending lines while a queued report is waiting and removes them on acknowledgement", async () => {
		await store.addPendingLineAttributions([buildPendingLine({ id: "line-1" }), buildPendingLine({ id: "line-2" })])
		await store.queueCommitReport(
			buildQueuedReport({
				matchedPendingLineIds: ["line-1"],
			}),
		)

		const visiblePendingLines = await store.getPendingLineAttributions("/repo")
		expect(visiblePendingLines.map((line) => line.id)).toEqual(["line-2"])

		await store.acknowledgeQueuedCommitReport("report-1")
		const persistedPendingLines = await store.getPendingLineAttributions("/repo")
		expect(persistedPendingLines.map((line) => line.id)).toEqual(["line-2"])
	})

	it("reattributes pending generated and accepted lines to the commit day when queueing a report", async () => {
		const generationTs = new Date("2026-03-10T10:00:00.000Z").getTime()
		const commitTs = new Date("2026-03-11T10:00:00.000Z").getTime()

		await store.appendEvent(
			buildEvent({
				eventId: "gen-pending",
				generatedBlockId: "generated-block-1",
				timestamp: generationTs,
				lineCount: 4,
			}),
		)
		await store.appendEvent(
			buildEvent({
				eventId: "acc-pending",
				generatedBlockId: "generated-block-1",
				timestamp: generationTs,
				metricType: "accepted",
				lineCount: 4,
			}),
		)

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
					workspaceName: "workspace",
					workspacePath: "/workspace",
					projectKey: "project-key",
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
							workspaceName: "workspace",
							workspacePath: "/workspace",
							projectKey: "project-key",
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
							workspaceName: "workspace",
							workspacePath: "/workspace",
							projectKey: "project-key",
							filePath: "/workspace/src/a.ts",
							relativePath: "src/a.ts",
							lineStart: 1,
							lineEnd: 4,
							lineCount: 4,
							codeSnippet: "const a = 1\nconst b = 2\nconst c = 3\nconst d = 4",
						},
					],
					committedBlocks: [],
					changedFiles: [],
				},
				createdAt: commitTs,
				generatedBlockIds: ["generated-block-1"],
			}),
		)

		expect(await store.getPendingEvents()).toEqual([])

		const generationDay = await store.getRangeSummary(
			{ type: "custom", startDate: "2026-03-10", endDate: "2026-03-10" },
			commitTs,
		)
		expect(generationDay.generatedLines).toBe(0)
		expect(generationDay.acceptedLines).toBe(0)

		const commitDay = await store.getRangeSummary(
			{ type: "custom", startDate: "2026-03-11", endDate: "2026-03-11" },
			commitTs,
		)
		expect(commitDay.generatedLines).toBe(4)
		expect(commitDay.acceptedLines).toBe(4)

		const state = await store.getRawStateForTests()
		expect(state.supersededEventIds).toEqual(["gen-pending", "acc-pending"])

		const commitDayEvents = await store.getEventsForRange(
			{ type: "custom", startDate: "2026-03-11", endDate: "2026-03-11" },
			undefined,
			commitTs,
		)
		expect(commitDayEvents.map((event) => event.eventId)).toEqual(["gen-baseline", "acc-baseline"])
	})
})

const toDateKey = (value: Date): string =>
	`${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
