// kilocode_change - new file

export class AiCodeStatsScheduler {
	private dailyTimer: NodeJS.Timeout | null = null
	private running = false

	constructor(private readonly dailyHour: number = 13) {}

	start(onDailyRun: () => Promise<void>): void {
		this.stop()
		this.scheduleNext(onDailyRun)
	}

	stop(): void {
		if (this.dailyTimer) {
			clearTimeout(this.dailyTimer)
			this.dailyTimer = null
		}
	}

	getStatus(): { isScheduled: boolean; nextRunAt?: number; isRunning: boolean } {
		return {
			isScheduled: this.dailyTimer !== null,
			nextRunAt: this.dailyTimer ? Date.now() + this.getDelayToNextRun() : undefined,
			isRunning: this.running,
		}
	}

	private scheduleNext(onDailyRun: () => Promise<void>): void {
		const delayMs = this.getDelayToNextRun()
		this.dailyTimer = setTimeout(async () => {
			try {
				this.running = true
				await onDailyRun()
			} finally {
				this.running = false
				this.scheduleNext(onDailyRun)
			}
		}, delayMs)
	}

	private getDelayToNextRun(now: Date = new Date()): number {
		const nextRun = new Date(now)
		nextRun.setHours(this.dailyHour, 0, 0, 0)
		if (nextRun.getTime() <= now.getTime()) {
			nextRun.setDate(nextRun.getDate() + 1)
		}

		return Math.max(1_000, nextRun.getTime() - now.getTime())
	}
}
