import { randomUUID } from "crypto"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import * as readline from "readline"

import { syncDirectory } from "../../utils/safeWriteJson"
import { CURRENT_AI_CODE_STATS_SEMANTICS_VERSION, normalizePath, toLocalDateKey, type AiCodeStatsEvent } from "./types"

const MAX_SEGMENT_BYTES = 4 * 1024 * 1024

interface AiCodeUploadEventQueueOptions {
	open?: typeof fs.open
	rename?: typeof fs.rename
	unlink?: typeof fs.unlink
	syncDirectory?: typeof syncDirectory
}

export class AiCodeUploadEventQueue {
	private readonly queueDir: string
	private readonly openFile: typeof fs.open
	private readonly renameFile: typeof fs.rename
	private readonly unlinkFile: typeof fs.unlink
	private readonly syncQueueDirectory: typeof syncDirectory
	private readonly unprovenSegmentPaths = new Set<string>()
	private warnedAboutDirectoryDurability = false

	constructor(baseDir: string, options: AiCodeUploadEventQueueOptions = {}) {
		this.queueDir = path.join(baseDir, "upload-events")
		this.openFile = options.open ?? fs.open
		this.renameFile = options.rename ?? fs.rename
		this.unlinkFile = options.unlink ?? fs.unlink
		this.syncQueueDirectory = options.syncDirectory ?? syncDirectory
	}

	async ensureReady(): Promise<void> {
		await fs.mkdir(this.queueDir, { recursive: true })
	}

	async append(events: AiCodeStatsEvent[]): Promise<boolean> {
		return this.appendInternal(events, false)
	}

	async appendUnique(events: AiCodeStatsEvent[]): Promise<boolean> {
		return this.appendInternal(events, true)
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

	async confirmDirectoryDurability(): Promise<boolean> {
		await this.ensureReady()
		const durable = await this.syncQueueDirectory(this.queueDir)
		if (!durable) {
			this.warnDirectoryDurabilityDegraded()
		}
		return durable
	}

	private async appendInternal(events: AiCodeStatsEvent[], deduplicatePersistedEvents: boolean): Promise<boolean> {
		const normalizedEvents = events.flatMap((event) => {
			const normalizedEvent = this.normalizeEvent(event)
			return normalizedEvent ? [normalizedEvent] : []
		})
		if (normalizedEvents.length === 0) {
			return true
		}
		await this.ensureReady()
		const persistedEventSegments = deduplicatePersistedEvents
			? await this.findPersistedEventSegments(new Set(normalizedEvents.map((event) => event.eventId)))
			: new Map<string, string>()
		// A successful write() from the interrupted process is not itself a
		// durability proof. Re-open every segment that lets replay skip an event
		// and establish the same file-content fsync barrier used by normal appends.
		// Directory fsync below is a separate metadata barrier and cannot replace it.
		for (const filePath of new Set(persistedEventSegments.values())) {
			await this.syncExistingSegment(filePath)
		}
		const seenInputIds = new Set<string>()

		const dateBuckets = new Map<string, AiCodeStatsEvent[]>()
		for (const normalizedEvent of normalizedEvents) {
			if (persistedEventSegments.has(normalizedEvent.eventId) || seenInputIds.has(normalizedEvent.eventId)) {
				continue
			}
			seenInputIds.add(normalizedEvent.eventId)
			const dateKey = toLocalDateKey(normalizedEvent.timestamp)
			const bucket = dateBuckets.get(dateKey) ?? []
			bucket.push(normalizedEvent)
			dateBuckets.set(dateKey, bucket)
		}

		// A replay may find every event already present and therefore perform no
		// append. It must still report an earlier unproven segment so the store does
		// not clear its recovery journal merely because event-id de-duplication was
		// successful in the same process.
		let directoryDurabilitySupported = this.unprovenSegmentPaths.size === 0
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
				const appendDirectoryDurable = await this.appendRecordDurably(filePath, `${boundary}${record}`)
				directoryDurabilitySupported &&= appendDirectoryDurable
				currentBytes += Buffer.byteLength(boundary, "utf8") + recordBytes
				needsRecordBoundary = false
			}
		}
		return directoryDurabilitySupported
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
			await this.unlinkFile(filePath).catch((error) => {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					throw error
				}
			})
			if (!(await this.syncQueueDirectory(this.queueDir))) {
				this.warnDirectoryDurabilityDegraded()
			}
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
				await this.unlinkFile(filePath).catch((error) => {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
						throw error
					}
				})
				// A fully delivered segment is no longer the only recovery copy of
				// pending data. Windows may leave it behind after a crash, but unlinking
				// it cannot make an undelivered event disappear.
				if (!(await this.syncQueueDirectory(this.queueDir))) {
					this.warnDirectoryDurabilityDegraded()
				}
				continue
			}
			// Partial replacement must retain the old segment unless directory
			// metadata can be durably ordered. On Windows, skip this rewrite so the
			// pending event body remains recoverable.
			if (!(await this.canDurablyMutateDirectory())) {
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

	private async findPersistedEventSegments(candidateIds: Set<string>): Promise<Map<string, string>> {
		const persisted = new Map<string, string>()
		if (candidateIds.size === 0) {
			return persisted
		}
		for (const filePath of await this.getFilesSorted()) {
			for await (const event of this.readFile(filePath)) {
				if (candidateIds.has(event.eventId) && !persisted.has(event.eventId)) {
					persisted.set(event.eventId, filePath)
					if (persisted.size === candidateIds.size) {
						return persisted
					}
				}
			}
		}
		return persisted
	}

	private async syncExistingSegment(filePath: string): Promise<void> {
		let handle: fs.FileHandle | undefined
		try {
			// Windows may reject FlushFileBuffers for read-only handles. Queue
			// segments are writer-owned, so match safeWriteJson's recovery barrier.
			handle = await this.openFile(filePath, "r+")
			await handle.sync()
		} finally {
			await handle?.close()
		}
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
			handle = await this.openFile(filePath, "r")
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
			await this.writeFileDurably(tempPath, `${currentRecords.join("\n")}\n`)
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
				await this.renameFile(tempPaths[index], finalPaths[index])
			}
			// The old segment remains the last known-good copy until every replacement
			// rename is durably published. A crash before this barrier may leave
			// duplicates, which eventId de-duplication already tolerates.
			if (!(await this.syncQueueDirectory(this.queueDir))) {
				this.warnDirectoryDurabilityDegraded()
				return
			}
			await this.unlinkFile(filePath)
			await this.syncQueueDirectory(this.queueDir)
		} catch (error) {
			// Never delete already-renamed replacements on failure: together with the
			// untouched old segment they are conservative duplicate recovery evidence.
			await Promise.all(tempPaths.map((tempPath) => this.unlinkFile(tempPath).catch(() => undefined)))
			throw error
		}
	}

	private async appendRecordDurably(filePath: string, record: string): Promise<boolean> {
		const fileExisted = await this.pathExists(filePath)
		const segmentWasUnproven = this.unprovenSegmentPaths.has(filePath)
		let handle: fs.FileHandle | undefined
		try {
			handle = await this.openFile(filePath, "a", 0o600)
			await handle.writeFile(record, "utf8")
			await handle.sync()
		} finally {
			await handle?.close()
		}
		if (fileExisted && !segmentWasUnproven) {
			return true
		}
		const directoryDurable = await this.syncQueueDirectory(this.queueDir)
		if (directoryDurable) {
			this.unprovenSegmentPaths.delete(filePath)
		} else {
			// Keep reporting every later append to this segment as unproven. The
			// store transaction journal must retain all of those event bodies, not
			// only the first record that created the directory entry. Recovery keeps
			// the transaction evidence until the directory itself can be synced; if
			// the entry was lost, replay creates it again and remains unproven.
			this.unprovenSegmentPaths.add(filePath)
			this.warnDirectoryDurabilityDegraded()
		}
		return directoryDurable
	}

	private async writeFileDurably(filePath: string, content: string): Promise<void> {
		let handle: fs.FileHandle | undefined
		try {
			handle = await this.openFile(filePath, "wx", 0o600)
			await handle.writeFile(content, "utf8")
			await handle.sync()
		} finally {
			await handle?.close()
		}
	}

	private async pathExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				return false
			}
			throw error
		}
	}

	private async canDurablyMutateDirectory(): Promise<boolean> {
		await this.ensureReady()
		const supported = await this.syncQueueDirectory(this.queueDir)
		if (!supported) {
			this.warnDirectoryDurabilityDegraded()
		}
		return supported
	}

	private warnDirectoryDurabilityDegraded(): void {
		if (this.warnedAboutDirectoryDurability) {
			return
		}
		this.warnedAboutDirectoryDurability = true
		console.warn(
			"[AiCodeStats] Directory fsync is unavailable; retaining upload queue recovery artifacts and using degraded atomic durability",
		)
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
			repoRoot: this.normalizePersistedPath(event.repoRoot) as string | undefined,
			repoRelativePath: this.normalizePersistedPath(event.repoRelativePath) as string | undefined,
			filePath: this.normalizePersistedPath(event.filePath, "") as string,
			relativePath: this.normalizePersistedPath(event.relativePath, "") as string,
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
			codeSnippet: (event.codeSnippet === undefined ? "" : event.codeSnippet) as string,
			fileSnapshotContent: event.fileSnapshotContent,
			fileSnapshotHash: event.fileSnapshotHash,
			taskId: event.taskId,
			commitHash: event.commitHash,
			commitOccurredAt: event.commitOccurredAt,
			generatedBlockId:
				typeof event.generatedBlockId === "string"
					? event.generatedBlockId.trim()
						? event.generatedBlockId
						: undefined
					: event.generatedBlockId,
		}
	}

	private normalizePersistedPath(value: unknown, missingValue?: string): unknown {
		if (typeof value === "string") {
			return normalizePath(value)
		}
		return value === undefined ? missingValue : value
	}

	private dateKeyFromFilePath(filePath: string): string {
		return path.basename(filePath).slice(0, 10)
	}
}
