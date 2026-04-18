import * as fs from "fs/promises"
import * as path from "path"

import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION, normalizePath, toLocalDateKey, type AiCodeStatsEvent } from "./types"

export class AiCodeUploadEventQueue {
	private readonly queueDir: string

	constructor(baseDir: string) {
		this.queueDir = path.join(baseDir, "upload-events")
	}

	async ensureReady(): Promise<void> {
		await fs.mkdir(this.queueDir, { recursive: true })
	}

	async append(events: AiCodeStatsEvent[]): Promise<void> {
		const normalizedEvents = events.flatMap((event) => {
			const normalizedEvent = this.normalizeEvent(event)
			return normalizedEvent ? [normalizedEvent] : []
		})
		if (normalizedEvents.length === 0) {
			return
		}
		await this.ensureReady()

		const dateBuckets = new Map<string, AiCodeStatsEvent[]>()
		for (const normalizedEvent of normalizedEvents) {
			const dateKey = toLocalDateKey(normalizedEvent.timestamp)
			const bucket = dateBuckets.get(dateKey) ?? []
			bucket.push(normalizedEvent)
			dateBuckets.set(dateKey, bucket)
		}

		for (const [dateKey, bucket] of dateBuckets.entries()) {
			const filePath = path.join(this.queueDir, `${dateKey}.ndjson`)
			const content = bucket.map((event) => JSON.stringify(event)).join("\n")
			await fs.appendFile(filePath, `${content}\n`, "utf8")
		}
	}

	async getPendingEvents(
		pendingEventIds: Set<string>,
		supersededEventIds: Set<string>,
		maxEvents?: number,
	): Promise<AiCodeStatsEvent[]> {
		if (pendingEventIds.size === 0) {
			return []
		}

		const events: AiCodeStatsEvent[] = []
		for (const filePath of await this.getFilesSorted()) {
			for (const event of await this.readFile(filePath)) {
				if (!pendingEventIds.has(event.eventId) || supersededEventIds.has(event.eventId)) {
					continue
				}
				events.push(event)
				if (maxEvents && events.length >= maxEvents) {
					return events
				}
			}
		}

		return events
	}

	async pruneBefore(cutoffKey: string): Promise<string[]> {
		const prunedEventIds: string[] = []
		for (const filePath of await this.getFilesSorted()) {
			const dateKey = this.dateKeyFromFilePath(filePath)
			if (dateKey >= cutoffKey) {
				continue
			}
			const events = await this.readFile(filePath)
			prunedEventIds.push(...events.map((event) => event.eventId))
			await fs.unlink(filePath).catch(() => undefined)
		}
		return prunedEventIds
	}

	private async getFilesSorted(): Promise<string[]> {
		await this.ensureReady()
		const names = await fs.readdir(this.queueDir).catch(() => [])
		return names
			.filter((name) => name.endsWith(".ndjson"))
			.sort((a, b) => a.localeCompare(b))
			.map((name) => path.join(this.queueDir, name))
	}

	private async readFile(filePath: string): Promise<AiCodeStatsEvent[]> {
		const raw = await fs.readFile(filePath, "utf8").catch(() => "")
		const events: AiCodeStatsEvent[] = []
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue
			}
			try {
				const parsed = JSON.parse(line) as Partial<AiCodeStatsEvent>
				if (
					parsed.eventId &&
					typeof parsed.timestamp === "number" &&
					parsed.semanticsVersion === CURRENT_AI_CODE_STATS_SEMANTICS_VERSION
				) {
					const normalizedEvent = this.normalizeEvent(parsed as AiCodeStatsEvent)
					if (normalizedEvent) {
						events.push(normalizedEvent)
					}
				}
			} catch {
				// Keep reading remaining queue records if one line is malformed.
			}
		}
		return events
	}

	private normalizeEvent(event: AiCodeStatsEvent): AiCodeStatsEvent | undefined {
		if (event.metricType !== "generated" && event.metricType !== "accepted") {
			return undefined
		}
		return {
			eventId: event.eventId,
			timestamp: event.timestamp,
			semanticsVersion: CURRENT_AI_CODE_STATS_SEMANTICS_VERSION,
			sourceType: "agent_insert",
			ide: event.ide === "jetbrains" ? "jetbrains" : "vscode",
			metricType: event.metricType,
			userName: event.userName,
			userEmail: event.userEmail,
			organizationId: event.organizationId,
			organizationName: event.organizationName,
			sourceIp: event.sourceIp,
			workspaceName: event.workspaceName ?? "",
			workspacePath: normalizePath(event.workspacePath ?? ""),
			projectKey: event.projectKey,
			filePath: normalizePath(event.filePath ?? ""),
			relativePath: normalizePath(event.relativePath ?? ""),
			language: event.language,
			gitRemoteUrl: event.gitRemoteUrl,
			gitBranch: event.gitBranch,
			lineStart: typeof event.lineStart === "number" ? event.lineStart : 1,
			lineEnd:
				typeof event.lineEnd === "number"
					? event.lineEnd
					: typeof event.lineStart === "number"
						? event.lineStart
						: 1,
			lineCount: typeof event.lineCount === "number" ? event.lineCount : 0,
			codeSnippet: typeof event.codeSnippet === "string" ? event.codeSnippet : "",
			fileSnapshotContent: typeof event.fileSnapshotContent === "string" ? event.fileSnapshotContent : undefined,
			taskId: event.taskId,
			commitHash: event.commitHash,
			commitOccurredAt: event.commitOccurredAt,
			generatedBlockId:
				typeof event.generatedBlockId === "string" && event.generatedBlockId.trim()
					? event.generatedBlockId
					: undefined,
		}
	}

	private dateKeyFromFilePath(filePath: string): string {
		return path.basename(filePath).replace(/\.ndjson$/, "")
	}
}
