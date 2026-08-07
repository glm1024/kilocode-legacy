import { randomUUID } from "crypto"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import * as readline from "readline"

import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION, normalizePath, toLocalDateKey, type AiCodeStatsEvent } from "./types"

const MAX_SEGMENT_BYTES = 4 * 1024 * 1024

export class AiCodeUploadEventQueue {
	private readonly queueDir: string

	constructor(baseDir: string) {
		this.queueDir = path.join(baseDir, "upload-events")
	}

	async ensureReady(): Promise<void> {
		await fs.mkdir(this.queueDir, { recursive: true })
	}

	async append(events: AiCodeStatsEvent[]): Promise<void> {
		await this.appendInternal(events, false)
	}

	async appendUnique(events: AiCodeStatsEvent[]): Promise<void> {
		await this.appendInternal(events, true)
	}

	async getAllEventIds(): Promise<string[]> {
		const eventIds = new Set<string>()
		for (const filePath of await this.getFilesSorted()) {
			for await (const event of this.readFile(filePath)) {
				eventIds.add(event.eventId)
			}
		}
		return [...eventIds]
	}

	private async appendInternal(events: AiCodeStatsEvent[], deduplicatePersistedEvents: boolean): Promise<void> {
		const normalizedEvents = events.flatMap((event) => {
			const normalizedEvent = this.normalizeEvent(event)
			return normalizedEvent ? [normalizedEvent] : []
		})
		if (normalizedEvents.length === 0) {
			return
		}
		await this.ensureReady()
		const existingEventIds = deduplicatePersistedEvents
			? await this.findPersistedEventIds(new Set(normalizedEvents.map((event) => event.eventId)))
			: new Set<string>()
		const seenInputIds = new Set<string>()

		const dateBuckets = new Map<string, AiCodeStatsEvent[]>()
		for (const normalizedEvent of normalizedEvents) {
			if (existingEventIds.has(normalizedEvent.eventId) || seenInputIds.has(normalizedEvent.eventId)) {
				continue
			}
			seenInputIds.add(normalizedEvent.eventId)
			const dateKey = toLocalDateKey(normalizedEvent.timestamp)
			const bucket = dateBuckets.get(dateKey) ?? []
			bucket.push(normalizedEvent)
			dateBuckets.set(dateKey, bucket)
		}

		for (const [dateKey, bucket] of dateBuckets.entries()) {
			let filePath = await this.getWritableSegmentPath(dateKey)
			let currentBytes = await this.fileSize(filePath)
			let needsRecordBoundary = currentBytes > 0 && (await this.needsRecordBoundary(filePath))
			for (const event of bucket) {
				const record = `${JSON.stringify(event)}\n`
				const recordBytes = Buffer.byteLength(record, "utf8")
				if (currentBytes > 0 && currentBytes + recordBytes > MAX_SEGMENT_BYTES) {
					filePath = this.createSegmentPath(dateKey)
					currentBytes = 0
					needsRecordBoundary = false
				}
				// appendFile can be interrupted after writing only part of an
				// NDJSON record. Transaction recovery must start the replayed
				// event on a fresh line or the corrupt tail and valid replay
				// would merge into one permanently unreadable record.
				const boundary = needsRecordBoundary ? "\n" : ""
				await fs.appendFile(filePath, `${boundary}${record}`, "utf8")
				currentBytes += Buffer.byteLength(boundary, "utf8") + recordBytes
				needsRecordBoundary = false
			}
		}
	}

	async getPendingEvents(
		pendingEventIds: Set<string>,
		supersededEventIds: Set<string>,
		maxEvents?: number,
		includeEvent: (event: AiCodeStatsEvent) => boolean = () => true,
	): Promise<AiCodeStatsEvent[]> {
		if (pendingEventIds.size === 0) {
			return []
		}

		const events: AiCodeStatsEvent[] = []
		const seenEventIds = new Set<string>()
		for (const filePath of await this.getFilesSorted()) {
			for await (const event of this.readFile(filePath)) {
				if (
					seenEventIds.has(event.eventId) ||
					!pendingEventIds.has(event.eventId) ||
					supersededEventIds.has(event.eventId) ||
					!includeEvent(event)
				) {
					continue
				}
				seenEventIds.add(event.eventId)
				events.push(event)
				if (maxEvents && events.length >= maxEvents) {
					return events
				}
			}
		}

		return events
	}

	async pruneBefore(cutoffKey: string, protectedEventIds: Set<string> = new Set()): Promise<string[]> {
		const prunedEventIds: string[] = []
		for (const filePath of await this.getFilesSorted()) {
			const dateKey = this.dateKeyFromFilePath(filePath)
			if (dateKey >= cutoffKey) {
				continue
			}
			const events: AiCodeStatsEvent[] = []
			for await (const event of this.readFile(filePath)) {
				events.push(event)
			}
			// A date bucket is the durable body for every event it contains. Do
			// not remove the bucket while even one event still needs delivery;
			// retaining already-delivered neighbours is cheaper and safer than
			// rewriting the outbox file during retention cleanup.
			if (events.some((event) => protectedEventIds.has(event.eventId))) {
				continue
			}
			prunedEventIds.push(...events.map((event) => event.eventId))
			await fs.unlink(filePath).catch(() => undefined)
		}
		return prunedEventIds
	}

	/**
	 * Removes fully acknowledged segments and rewrites partially acknowledged
	 * ones with only still-deliverable events. Segment replacement is
	 * duplicate-safe: replacements are committed before the old segment is
	 * removed, so a crash can retain duplicates but cannot lose a pending fact.
	 */
	async pruneDeliveredSegments(protectedEventIds: Set<string>, deliveredEventIds?: Set<string>): Promise<void> {
		const remainingDeliveredEventIds = deliveredEventIds ? new Set(deliveredEventIds) : undefined
		for (const filePath of await this.getFilesSorted()) {
			if (remainingDeliveredEventIds && remainingDeliveredEventIds.size === 0) {
				break
			}
			const protectedEvents: AiCodeStatsEvent[] = []
			let validEventCount = 0
			let containsTargetDeliveredEvent = !remainingDeliveredEventIds
			for await (const event of this.readFile(filePath)) {
				validEventCount += 1
				if (protectedEventIds.has(event.eventId)) {
					protectedEvents.push(event)
				}
				if (remainingDeliveredEventIds?.delete(event.eventId)) {
					containsTargetDeliveredEvent = true
				}
			}
			if (!containsTargetDeliveredEvent) {
				continue
			}
			if (validEventCount === 0 || protectedEvents.length === validEventCount) {
				continue
			}
			if (protectedEvents.length === 0) {
				await fs.unlink(filePath).catch((error) => {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
						throw error
					}
				})
				continue
			}
			await this.replaceSegmentWithProtectedEvents(filePath, protectedEvents)
		}
	}

	private async getFilesSorted(): Promise<string[]> {
		await this.ensureReady()
		const names = await fs.readdir(this.queueDir).catch(() => [])
		return names
			.filter((name) => name.endsWith(".ndjson"))
			.sort((a, b) => {
				const dateOrder = this.dateKeyFromFilePath(a).localeCompare(this.dateKeyFromFilePath(b))
				if (dateOrder !== 0) {
					return dateOrder
				}
				const aLegacy = /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(a)
				const bLegacy = /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(b)
				if (aLegacy !== bLegacy) {
					return aLegacy ? -1 : 1
				}
				return a.localeCompare(b)
			})
			.map((name) => path.join(this.queueDir, name))
	}

	private async findPersistedEventIds(candidateIds: Set<string>): Promise<Set<string>> {
		const persisted = new Set<string>()
		if (candidateIds.size === 0) {
			return persisted
		}
		for (const filePath of await this.getFilesSorted()) {
			for await (const event of this.readFile(filePath)) {
				if (candidateIds.has(event.eventId)) {
					persisted.add(event.eventId)
					if (persisted.size === candidateIds.size) {
						return persisted
					}
				}
			}
		}
		return persisted
	}

	private async getWritableSegmentPath(dateKey: string): Promise<string> {
		const files = (await this.getFilesSorted()).filter((filePath) => this.dateKeyFromFilePath(filePath) === dateKey)
		if (files.length === 0) {
			return path.join(this.queueDir, `${dateKey}.ndjson`)
		}
		const latest = files[files.length - 1]
		return (await this.fileSize(latest)) < MAX_SEGMENT_BYTES ? latest : this.createSegmentPath(dateKey)
	}

	private createSegmentPath(dateKey: string): string {
		return path.join(this.queueDir, `${dateKey}.${Date.now()}-${process.pid}-${randomUUID()}.ndjson`)
	}

	private async fileSize(filePath: string): Promise<number> {
		try {
			return (await fs.stat(filePath)).size
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				return 0
			}
			throw error
		}
	}

	private async needsRecordBoundary(filePath: string): Promise<boolean> {
		let handle: fs.FileHandle | undefined
		try {
			handle = await fs.open(filePath, "r")
			const stat = await handle.stat()
			if (stat.size === 0) {
				return false
			}
			const lastByte = Buffer.alloc(1)
			await handle.read(lastByte, 0, 1, stat.size - 1)
			return lastByte[0] !== 0x0a
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return false
			}
			throw error
		} finally {
			await handle?.close()
		}
	}

	private async *readFile(filePath: string): AsyncGenerator<AiCodeStatsEvent> {
		const input = fsSync.createReadStream(filePath, { encoding: "utf8" })
		const lines = readline.createInterface({ input, crlfDelay: Infinity })
		try {
			for await (const line of lines) {
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
							yield normalizedEvent
						}
					}
				} catch {
					// Keep reading remaining queue records if one line is malformed.
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw error
			}
		} finally {
			lines.close()
			input.destroy()
		}
	}

	private async replaceSegmentWithProtectedEvents(
		filePath: string,
		protectedEvents: AiCodeStatsEvent[],
	): Promise<void> {
		const dateKey = this.dateKeyFromFilePath(filePath)
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
			throw new Error(`Invalid AI code upload segment date: ${dateKey}`)
		}
		const baseName = path.basename(filePath, ".ndjson")
		const replacementBaseName = baseName === dateKey ? `${dateKey}.0000000000000` : baseName
		const replacementId = randomUUID()
		const tempPaths: string[] = []
		const finalPaths: string[] = []
		let currentRecords: string[] = []
		let currentBytes = 0
		let segmentIndex = 0

		const flush = async (): Promise<void> => {
			if (currentRecords.length === 0) {
				return
			}
			const suffix = `${replacementBaseName}.compact-${Date.now()}-${replacementId}-${segmentIndex}`
			const tempPath = path.join(this.queueDir, `.${suffix}.tmp`)
			const finalPath = path.join(this.queueDir, `${suffix}.ndjson`)
			tempPaths.push(tempPath)
			await fs.writeFile(tempPath, `${currentRecords.join("\n")}\n`, "utf8")
			finalPaths.push(finalPath)
			currentRecords = []
			currentBytes = 0
			segmentIndex += 1
		}

		try {
			for (const event of protectedEvents) {
				const record = JSON.stringify(event)
				const recordBytes = Buffer.byteLength(`${record}\n`, "utf8")
				if (currentRecords.length > 0 && currentBytes + recordBytes > MAX_SEGMENT_BYTES) {
					await flush()
				}
				currentRecords.push(record)
				currentBytes += recordBytes
			}
			await flush()
			for (let index = 0; index < tempPaths.length; index += 1) {
				await fs.rename(tempPaths[index], finalPaths[index])
			}
			await fs.unlink(filePath)
		} catch (error) {
			await Promise.all(tempPaths.map((tempPath) => fs.unlink(tempPath).catch(() => undefined)))
			throw error
		}
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
			ide: event.ide,
			metricType: event.metricType,
			changeType: event.changeType === "deletion" ? "deletion" : "addition",
			userName: event.userName,
			departmentName: event.departmentName,
			officeName: event.officeName,
			teamName: event.teamName,
			userEmail: event.userEmail,
			organizationId: event.organizationId,
			organizationName: event.organizationName,
			sourceIp: event.sourceIp,
			provider: event.provider,
			model: event.model,
			projectKey: event.projectKey,
			projectName: event.projectName,
			repoRoot: event.repoRoot ? normalizePath(event.repoRoot) : undefined,
			repoRelativePath: event.repoRelativePath ? normalizePath(event.repoRelativePath) : undefined,
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
			fileSnapshotHash: event.fileSnapshotHash,
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
		return path.basename(filePath).slice(0, 10)
	}
}
