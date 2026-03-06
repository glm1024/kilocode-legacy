// kilocode_change - new file
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it } from "vitest"

import { AiCodeStatsStore } from "../AiCodeStatsStore"
import { type AiCodeStatsEvent } from "../types"

const buildEvent = (overrides: Partial<AiCodeStatsEvent> = {}): AiCodeStatsEvent => ({
	eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
	timestamp: overrides.timestamp ?? Date.now(),
	sourceType: overrides.sourceType ?? "agent_insert",
	ide: overrides.ide ?? "vscode",
	workspaceName: overrides.workspaceName ?? "project",
	workspacePath: overrides.workspacePath ?? "/workspace/project",
	filePath: overrides.filePath ?? "/workspace/project/src/a.ts",
	relativePath: overrides.relativePath ?? "src/a.ts",
	lineStart: overrides.lineStart ?? 1,
	lineEnd: overrides.lineEnd ?? 1,
	lineCount: overrides.lineCount ?? 1,
	codeSnippet: overrides.codeSnippet ?? "const x = 1",
	taskId: overrides.taskId,
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
		expect(summary.today.agentLines).toBe(5)
		expect(summary.today.totalLines).toBe(5)
		expect(summary.total.agentLines).toBe(5)
		expect(summary.total.totalLines).toBe(5)
		expect(summary.pendingEvents).toBe(1)
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

	it("supports today/this-week/this-month/custom range aggregation and tracks last successful upload time", async () => {
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
			mode: "backfill",
			trigger: "manual",
			uploadedEvents: 2,
		})
		const summary = await store.getSummary(now)
		expect(summary.lastSuccessfulUploadAt).toBe(now)
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
})

const toDateKey = (value: Date): string =>
	`${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
