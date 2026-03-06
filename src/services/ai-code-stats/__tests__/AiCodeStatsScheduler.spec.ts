// kilocode_change - new file
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AiCodeStatsScheduler } from "../AiCodeStatsScheduler"

describe("AiCodeStatsScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("schedules daily run", async () => {
		vi.setSystemTime(new Date("2026-03-05T04:00:00.000Z"))
		const scheduler = new AiCodeStatsScheduler(13)
		const runner = vi.fn().mockResolvedValue(undefined)

		scheduler.start(runner)
		const status = scheduler.getStatus()
		expect(status.isScheduled).toBe(true)

		await vi.advanceTimersByTimeAsync(9 * 60 * 60 * 1000 + 2000)
		expect(runner).toHaveBeenCalledTimes(1)

		scheduler.stop()
	})

	it("runs on next day when current time is past 13:00", async () => {
		vi.setSystemTime(new Date("2026-03-05T16:00:00.000Z"))
		const scheduler = new AiCodeStatsScheduler(13)
		const runner = vi.fn().mockResolvedValue(undefined)

		scheduler.start(runner)
		await vi.advanceTimersByTimeAsync(20 * 60 * 60 * 1000 + 2000)
		expect(runner).toHaveBeenCalledTimes(1)

		scheduler.stop()
	})
})
