import { EventEmitter } from "events"
import type { ExtensionContext } from "vscode"
import type { QueuedRequest, QueueStats, RetryQueueConfig, RetryQueueEvents } from "./types.js"

type AuthHeaderProvider = () => Record<string, string> | undefined

// kilocode_change start
class RetryQueueAuthUnavailableError extends Error {
	constructor() {
		super("Retry queue auth headers are unavailable")
		this.name = "RetryQueueAuthUnavailableError"
	}
}

const DEFAULT_RETRY_AFTER_MS = 60 * 1000
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
const RETRY_QUEUE_STORAGE_VERSION = 1

interface PersistedRetryQueue {
	version: typeof RETRY_QUEUE_STORAGE_VERSION
	ownerKnown: boolean
	ownerUserId?: string
	mutationEpoch: number
	queuePausedUntil?: number
	requests: QueuedRequest[]
}

interface PersistenceBarrier {
	ownershipEpoch: number
	targetOwnerKnown: boolean
	targetOwnerUserId?: string
	emitQueueCleared: boolean
	resumeRequested: boolean
	inFlight?: Promise<void>
}

interface EnqueueOwnerSnapshot {
	ownershipEpoch: number
	ownerKnown: boolean
	ownerUserId?: string
	requiresOwnerConfirmation: boolean
}
// kilocode_change end

export class RetryQueue extends EventEmitter<RetryQueueEvents> {
	private queue: Map<string, QueuedRequest> = new Map()
	private context: ExtensionContext
	private config: RetryQueueConfig
	private log: (...args: unknown[]) => void
	private isProcessing = false
	private retryTimer?: NodeJS.Timeout
	private readonly STORAGE_KEY = "roo.retryQueue"
	private authHeaderProvider?: AuthHeaderProvider
	private queuePausedUntil?: number // Timestamp when the queue can resume processing
	private isPaused = false // Manual pause state (e.g., for auth state changes)
	private currentUserId?: string // Track current user ID for conditional clearing
	private ownerKnown = false
	private requiresOwnerConfirmation = false
	private legacyQueueHasUnknownOwner = false
	private mutationEpoch = 0
	private ownershipEpoch = 0
	private pendingPersistenceBarrier?: PersistenceBarrier
	private persistenceTail: Promise<void> = Promise.resolve()
	private enqueueTail: Promise<void> = Promise.resolve()
	private pendingEnqueueIds = new Set<string>()
	private concurrentlyEvictedRequestIds = new Set<string>()

	constructor(
		context: ExtensionContext,
		config?: Partial<RetryQueueConfig>,
		log?: (...args: unknown[]) => void,
		authHeaderProvider?: AuthHeaderProvider,
	) {
		super()
		this.context = context
		this.log = log || console.log
		this.authHeaderProvider = authHeaderProvider

		this.config = {
			maxRetries: 0,
			retryDelay: 60000,
			maxQueueSize: 100,
			persistQueue: true,
			networkCheckInterval: 60000,
			requestTimeout: 30000,
			...config,
		}

		this.loadPersistedQueue()
		if (this.authHeaderProvider) {
			// Authenticated queues must not process persisted requests until the
			// current account has been compared with the durable owner.
			this.requiresOwnerConfirmation = true
			this.isPaused = true
		}
		this.startRetryTimer()
	}

	private loadPersistedQueue(): void {
		if (!this.config.persistQueue) return

		try {
			const stored = this.context.workspaceState.get<unknown>(this.STORAGE_KEY)
			if (Array.isArray(stored)) {
				// The previous format had no account owner. Sending these requests
				// with whichever account happens to log in next would cross an auth
				// boundary, so retain them only in quarantine until an account
				// transition durably replaces the legacy value.
				const requests = stored.filter(this.isQueuedRequest)
				requests.forEach((request) => this.queue.set(request.id, request))
				this.legacyQueueHasUnknownOwner = requests.length > 0
				this.requiresOwnerConfirmation = requests.length > 0
				this.isPaused = requests.length > 0
				this.log(
					`[RetryQueue] Loaded ${requests.length} legacy persisted requests with unknown owner; queue is quarantined`,
				)
				return
			}

			if (this.isPersistedRetryQueue(stored)) {
				stored.requests.forEach((request) => this.queue.set(request.id, request))
				this.ownerKnown = stored.ownerKnown
				this.currentUserId = stored.ownerUserId
				this.mutationEpoch = stored.mutationEpoch
				this.queuePausedUntil =
					stored.queuePausedUntil !== undefined && stored.queuePausedUntil > Date.now()
						? stored.queuePausedUntil
						: undefined
				this.legacyQueueHasUnknownOwner = !stored.ownerKnown && stored.requests.length > 0
				this.requiresOwnerConfirmation = true
				this.isPaused = true
				this.log(
					`[RetryQueue] Loaded ${stored.requests.length} persisted requests for ${
						stored.ownerKnown ? (stored.ownerUserId ?? "owner-without-id") : "unknown owner"
					}`,
				)
				return
			}

			if (stored !== undefined) {
				// Unknown future/corrupt formats are fail-closed. A subsequent
				// account confirmation will replace them with an empty envelope.
				this.legacyQueueHasUnknownOwner = true
				this.requiresOwnerConfirmation = true
				this.isPaused = true
				this.log("[RetryQueue] Unsupported persisted queue format; queue is quarantined")
			}
		} catch (error) {
			this.log("[RetryQueue] Failed to load persisted queue:", error)
			this.legacyQueueHasUnknownOwner = true
			this.requiresOwnerConfirmation = true
			this.isPaused = true
		}
	}

	private isPersistedRetryQueue(value: unknown): value is PersistedRetryQueue {
		if (!value || typeof value !== "object") {
			return false
		}

		const candidate = value as Partial<PersistedRetryQueue>
		return (
			candidate.version === RETRY_QUEUE_STORAGE_VERSION &&
			typeof candidate.ownerKnown === "boolean" &&
			(candidate.ownerUserId === undefined || typeof candidate.ownerUserId === "string") &&
			Number.isSafeInteger(candidate.mutationEpoch) &&
			(candidate.mutationEpoch ?? -1) >= 0 &&
			(candidate.queuePausedUntil === undefined ||
				(typeof candidate.queuePausedUntil === "number" &&
					Number.isFinite(candidate.queuePausedUntil) &&
					candidate.queuePausedUntil >= 0)) &&
			Array.isArray(candidate.requests) &&
			candidate.requests.every(this.isQueuedRequest)
		)
	}

	private isQueuedRequest(value: unknown): value is QueuedRequest {
		if (!value || typeof value !== "object") {
			return false
		}

		const candidate = value as Partial<QueuedRequest>
		return (
			typeof candidate.id === "string" &&
			typeof candidate.url === "string" &&
			typeof candidate.timestamp === "number" &&
			Number.isFinite(candidate.timestamp) &&
			typeof candidate.retryCount === "number" &&
			Number.isSafeInteger(candidate.retryCount) &&
			candidate.retryCount >= 0 &&
			typeof candidate.type === "string" &&
			!!candidate.options &&
			typeof candidate.options === "object"
		)
	}

	private cloneRequest(request: QueuedRequest): QueuedRequest {
		return {
			...request,
			options: {
				...request.options,
			},
		}
	}

	private cloneQueue(requests: Iterable<QueuedRequest> = this.queue.values()): Map<string, QueuedRequest> {
		return new Map(Array.from(requests, (request) => [request.id, this.cloneRequest(request)]))
	}

	private createPersistedSnapshot(owner?: { known: boolean; userId?: string }): PersistedRetryQueue {
		return {
			version: RETRY_QUEUE_STORAGE_VERSION,
			ownerKnown: owner?.known ?? this.ownerKnown,
			ownerUserId: owner ? owner.userId : this.currentUserId,
			mutationEpoch: this.mutationEpoch,
			queuePausedUntil: this.queuePausedUntil,
			requests: Array.from(this.queue.values(), (request) => this.cloneRequest(request)),
		}
	}

	private getEffectiveOwner(): { known: boolean; userId?: string } {
		return this.pendingPersistenceBarrier
			? {
					known: this.pendingPersistenceBarrier.targetOwnerKnown,
					userId: this.pendingPersistenceBarrier.targetOwnerUserId,
				}
			: {
					known: this.ownerKnown,
					userId: this.currentUserId,
				}
	}

	private async persistQueue(owner?: { known: boolean; userId?: string }): Promise<void> {
		if (!this.config.persistQueue) return

		const snapshot = this.createPersistedSnapshot(owner)
		const write = this.persistenceTail.then(() => this.context.workspaceState.update(this.STORAGE_KEY, snapshot))
		// Keep later writes ordered even when an earlier update rejects.
		this.persistenceTail = write.catch(() => undefined)

		try {
			await write
		} catch (error) {
			this.log("[RetryQueue] Failed to persist queue:", error)
			throw error
		}
	}

	private beginPersistenceBarrier(options: {
		clearQueue: boolean
		emitQueueCleared: boolean
		targetOwnerKnown?: boolean
		targetOwnerUserId?: string
		resumeAfterPersistence?: boolean
	}): void {
		const previousBarrier = this.pendingPersistenceBarrier
		const effectiveOwnerKnown = previousBarrier?.targetOwnerKnown ?? this.ownerKnown
		const effectiveOwnerUserId = previousBarrier ? previousBarrier.targetOwnerUserId : this.currentUserId
		this.ownershipEpoch++
		this.mutationEpoch++
		this.queuePausedUntil = undefined
		this.isPaused = true

		if (options.clearQueue) {
			this.queue.clear()
		}

		const barrier: PersistenceBarrier = {
			ownershipEpoch: this.ownershipEpoch,
			targetOwnerKnown: options.targetOwnerKnown ?? effectiveOwnerKnown,
			targetOwnerUserId:
				options.targetOwnerKnown === undefined ? effectiveOwnerUserId : options.targetOwnerUserId,
			emitQueueCleared: options.emitQueueCleared || previousBarrier?.emitQueueCleared === true,
			resumeRequested: options.resumeAfterPersistence ?? previousBarrier?.resumeRequested ?? false,
		}
		this.pendingPersistenceBarrier = barrier
		void this.ensurePersistenceBarrier().catch((error) => {
			this.log("[RetryQueue] Durable queue transition remains pending:", error)
		})
	}

	private async ensurePersistenceBarrier(): Promise<void> {
		while (this.pendingPersistenceBarrier) {
			const barrier = this.pendingPersistenceBarrier
			if (!barrier.inFlight) {
				barrier.inFlight = this.persistQueue({
					known: barrier.targetOwnerKnown,
					userId: barrier.targetOwnerUserId,
				})
			}

			try {
				await barrier.inFlight
			} catch (error) {
				barrier.inFlight = undefined
				if (this.pendingPersistenceBarrier !== barrier || barrier.ownershipEpoch !== this.ownershipEpoch) {
					continue
				}
				this.isPaused = true
				throw error
			}

			if (this.pendingPersistenceBarrier !== barrier || barrier.ownershipEpoch !== this.ownershipEpoch) {
				continue
			}

			this.pendingPersistenceBarrier = undefined
			this.ownerKnown = barrier.targetOwnerKnown
			this.currentUserId = barrier.targetOwnerUserId
			if (barrier.emitQueueCleared) {
				this.emit("queue-cleared")
			}
			if (barrier.resumeRequested && !this.requiresOwnerConfirmation) {
				this.isPaused = false
				this.log("[RetryQueue] Durable queue transition completed; queue resumed")
			}
		}
	}

	public async enqueue(
		url: string,
		options: RequestInit,
		type: QueuedRequest["type"] = "other",
		operation?: string,
	): Promise<void> {
		const effectiveOwner = this.getEffectiveOwner()
		const ownerSnapshot: EnqueueOwnerSnapshot = {
			ownershipEpoch: this.ownershipEpoch,
			ownerKnown: effectiveOwner.known,
			ownerUserId: effectiveOwner.userId,
			requiresOwnerConfirmation: this.requiresOwnerConfirmation,
		}
		const run = this.enqueueTail.then(() => this.enqueueInternal(url, options, type, operation, ownerSnapshot))
		this.enqueueTail = run.catch(() => undefined)
		return run
	}

	private async enqueueInternal(
		url: string,
		options: RequestInit,
		type: QueuedRequest["type"],
		operation: string | undefined,
		ownerSnapshot: EnqueueOwnerSnapshot,
	): Promise<void> {
		await this.ensurePersistenceBarrier()
		if (this.authHeaderProvider && (!ownerSnapshot.ownerKnown || ownerSnapshot.requiresOwnerConfirmation)) {
			throw new Error("Retry queue owner has not been confirmed")
		}
		if (
			this.ownershipEpoch !== ownerSnapshot.ownershipEpoch ||
			(this.authHeaderProvider &&
				(!this.ownerKnown ||
					this.currentUserId !== ownerSnapshot.ownerUserId ||
					this.requiresOwnerConfirmation))
		) {
			throw new Error("Retry queue owner changed before request could be queued")
		}

		const previousQueue = this.cloneQueue()
		const previousMutationEpoch = this.mutationEpoch
		const enqueueOwnershipEpoch = ownerSnapshot.ownershipEpoch
		let evictedRequest: QueuedRequest | undefined
		if (this.queue.size >= this.config.maxQueueSize) {
			const oldestId = Array.from(this.queue.keys())[0]
			if (oldestId) {
				const oldestRequest = this.queue.get(oldestId)
				evictedRequest = oldestRequest ? this.cloneRequest(oldestRequest) : undefined
				this.queue.delete(oldestId)
				if (this.isProcessing) {
					this.concurrentlyEvictedRequestIds.add(oldestId)
				}
			}
		}

		const request: QueuedRequest = {
			id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			url,
			options,
			timestamp: Date.now(),
			retryCount: 0,
			type,
			operation,
		}

		this.queue.set(request.id, request)
		this.pendingEnqueueIds.add(request.id)
		this.mutationEpoch++
		try {
			await this.persistQueue()
		} catch (error) {
			if (this.ownershipEpoch === enqueueOwnershipEpoch) {
				if (this.mutationEpoch === previousMutationEpoch + 1) {
					this.queue = previousQueue
					if (evictedRequest) {
						this.concurrentlyEvictedRequestIds.delete(evictedRequest.id)
					}
				} else {
					// Another retry mutation may have completed while this write
					// was pending. Remove only the request that was never durably
					// accepted instead of rewinding unrelated newer state.
					this.queue.delete(request.id)
					if (evictedRequest && !this.queue.has(evictedRequest.id)) {
						this.queue = new Map([
							[evictedRequest.id, this.cloneRequest(evictedRequest)],
							...this.queue.entries(),
						])
						this.concurrentlyEvictedRequestIds.delete(evictedRequest.id)
					}
				}
				this.mutationEpoch++
				try {
					await this.persistQueue()
				} catch (rollbackError) {
					this.log("[RetryQueue] Failed to persist enqueue rollback:", rollbackError)
				}
			}
			throw error
		} finally {
			this.pendingEnqueueIds.delete(request.id)
		}

		if (this.ownershipEpoch !== enqueueOwnershipEpoch || !this.queue.has(request.id)) {
			return
		}

		this.emit("request-queued", request)
		this.log(`[RetryQueue] Queued request: ${url}`)
	}

	public async retryAll(): Promise<void> {
		if (this.isProcessing) {
			this.log("[RetryQueue] Already processing, skipping retry cycle")
			return
		}
		this.isProcessing = true

		try {
			await this.ensurePersistenceBarrier()
		} catch (error) {
			// A failed owner/clear transition is retried by later timer cycles.
			// Until it is durable the queue must remain fail-closed.
			this.isProcessing = false
			throw error
		}

		// Check if the queue is manually paused (e.g., due to auth state)
		if (this.isPaused || this.requiresOwnerConfirmation || this.legacyQueueHasUnknownOwner) {
			this.log("[RetryQueue] Queue is manually paused")
			this.isProcessing = false
			return
		}

		// Check if the entire queue is paused due to rate limiting
		if (this.queuePausedUntil && Date.now() < this.queuePausedUntil) {
			this.log(`[RetryQueue] Queue is paused until ${new Date(this.queuePausedUntil).toISOString()}`)
			this.isProcessing = false
			return
		}

		const requests = Array.from(this.queue.values()).filter((request) => !this.pendingEnqueueIds.has(request.id))
		if (requests.length === 0) {
			this.isProcessing = false
			return
		}

		const retryOwnershipEpoch = this.ownershipEpoch
		const previousRequests = this.cloneQueue(requests)
		const deferredEvents: Array<() => void> = []
		let stateChanged = false

		try {
			// Sort by timestamp to process in FIFO order (oldest first)
			requests.sort((a, b) => a.timestamp - b.timestamp)

			// Process all requests in FIFO order
			for (const request of requests) {
				if (
					this.isPaused ||
					this.requiresOwnerConfirmation ||
					this.legacyQueueHasUnknownOwner ||
					this.ownershipEpoch !== retryOwnershipEpoch ||
					this.queue.get(request.id) !== request
				) {
					break
				}

				let response: Response
				try {
					response = await this.retryRequest(request)
				} catch (error) {
					if (this.ownershipEpoch !== retryOwnershipEpoch || this.queue.get(request.id) !== request) {
						break
					}
					if (error instanceof RetryQueueAuthUnavailableError) {
						this.log("[RetryQueue] Auth headers are unavailable; leaving queued requests untouched")
						break
					}

					request.retryCount++
					request.lastError = error instanceof Error ? error.message : String(error)
					stateChanged = true

					// Check if we've exceeded max retries
					if (this.config.maxRetries > 0 && request.retryCount >= this.config.maxRetries) {
						this.log(
							`[RetryQueue] Max retries (${this.config.maxRetries}) reached for request: ${request.url}`,
						)
						this.queue.delete(request.id)
						deferredEvents.push(() => this.emit("request-max-retries-exceeded", request, error as Error))
					} else {
						this.queue.set(request.id, request)
						deferredEvents.push(() => this.emit("request-retry-failed", request, error as Error))
					}

					// Add a small delay between retry attempts
					await this.delay(100)
					continue
				}

				if (this.ownershipEpoch !== retryOwnershipEpoch || this.queue.get(request.id) !== request) {
					break
				}

				// Check if we got a 429 rate limiting response
				if (response.status === 429) {
					// kilocode_change start
					const retryAfter = response.headers.get("Retry-After")
					const delayMs = this.parseRetryAfterDelay(retryAfter)
					// Retry-After is optional, so use a conservative default instead of dropping the request.
					this.queuePausedUntil = Date.now() + delayMs
					stateChanged = true
					this.log(`[RetryQueue] Rate limited, pausing entire queue for ${delayMs}ms`)
					break
					// kilocode_change end
				}

				this.queue.delete(request.id)
				stateChanged = true
				deferredEvents.push(() => this.emit("request-retry-success", request))
			}

			if (this.ownershipEpoch !== retryOwnershipEpoch || !stateChanged) {
				return
			}

			this.mutationEpoch++
			try {
				await this.persistQueue()
			} catch (error) {
				if (this.ownershipEpoch === retryOwnershipEpoch) {
					for (const previousRequest of previousRequests.values()) {
						if (!this.concurrentlyEvictedRequestIds.has(previousRequest.id)) {
							this.queue.set(previousRequest.id, this.cloneRequest(previousRequest))
						}
					}
					this.mutationEpoch++
					try {
						// A later concurrent enqueue may already have queued a
						// persistence write. Reconcile after it so the durable and
						// in-memory queues both retain the retry-cycle snapshot.
						await this.persistQueue()
					} catch (rollbackError) {
						this.log("[RetryQueue] Failed to persist retry rollback:", rollbackError)
					}
				}
				throw error
			}

			deferredEvents.forEach((emitEvent) => emitEvent())
		} finally {
			// Always reset the processing flag, even if an error occurs
			this.isProcessing = false
			this.concurrentlyEvictedRequestIds.clear()
		}
	}

	private parseRetryAfterDelay(retryAfter: string | null): number {
		const normalized = retryAfter?.trim()
		if (!normalized) {
			return DEFAULT_RETRY_AFTER_MS
		}

		let delayMs: number | undefined
		if (/^\d+$/.test(normalized)) {
			const seconds = Number(normalized)
			delayMs = Number.isFinite(seconds) ? seconds * 1000 : seconds > 0 ? MAX_RETRY_AFTER_MS : 0
		} else if (this.isHttpDate(normalized)) {
			const retryAt = Date.parse(normalized)
			if (Number.isFinite(retryAt)) {
				delayMs = retryAt - Date.now()
			}
		}

		if (delayMs === undefined || Number.isNaN(delayMs)) {
			return DEFAULT_RETRY_AFTER_MS
		}
		if (!Number.isFinite(delayMs)) {
			return delayMs > 0 ? MAX_RETRY_AFTER_MS : 0
		}
		return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delayMs))
	}

	private isHttpDate(value: string): boolean {
		return (
			/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(value) ||
			/^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/i.test(value) ||
			/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/i.test(value)
		)
	}

	private async retryRequest(request: QueuedRequest): Promise<Response> {
		this.log(`[RetryQueue] Retrying request: ${request.url}`)

		let headers = { ...request.options.headers }
		if (this.authHeaderProvider) {
			const freshAuthHeaders = this.authHeaderProvider()
			if (!freshAuthHeaders) {
				throw new RetryQueueAuthUnavailableError()
			}
			headers = {
				...headers,
				...freshAuthHeaders,
			}
		}

		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout)

		try {
			const response = await fetch(request.url, {
				...request.options,
				signal: controller.signal,
				headers: {
					...headers,
					"X-Retry-Queue": "true",
				},
			})

			clearTimeout(timeoutId)

			// Check for error status codes that should trigger retry
			if (!response.ok) {
				// Handle different status codes appropriately
				if (response.status >= 500) {
					// Server errors (5xx) should be retried
					throw new Error(`Server error: ${response.status} ${response.statusText}`)
				} else if (response.status === 429) {
					// Rate limiting - return response to let caller handle Retry-After
					return response
				} else if (response.status >= 400 && response.status < 500) {
					// Client errors (4xx including 401/403) should NOT be retried
					// These errors indicate problems with the request itself that won't be fixed by retrying
					this.log(`[RetryQueue] Non-retryable client error ${response.status}, removing from queue`)
					return response
				}
			}

			return response
		} catch (error) {
			clearTimeout(timeoutId)
			throw error
		}
	}

	private startRetryTimer(): void {
		if (this.retryTimer) {
			clearInterval(this.retryTimer)
		}

		this.retryTimer = setInterval(() => {
			this.retryAll().catch((error) => {
				this.log("[RetryQueue] Error during retry cycle:", error)
			})
		}, this.config.networkCheckInterval)
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	public getStats(): QueueStats {
		const requests = Array.from(this.queue.values())
		const byType: Record<string, number> = {}
		let totalRetries = 0
		let failedRetries = 0

		requests.forEach((request) => {
			byType[request.type] = (byType[request.type] || 0) + 1
			totalRetries += request.retryCount
			if (request.lastError) {
				failedRetries++
			}
		})

		const timestamps = requests.map((r) => r.timestamp)
		const oldestRequest = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : undefined
		const newestRequest = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : undefined

		return {
			totalQueued: requests.length,
			byType,
			oldestRequest,
			newestRequest,
			totalRetries,
			failedRetries,
		}
	}

	public clear(): void {
		const shouldResume = !this.isPaused && !this.requiresOwnerConfirmation && !this.legacyQueueHasUnknownOwner
		this.beginPersistenceBarrier({
			clearQueue: true,
			emitQueueCleared: true,
			resumeAfterPersistence: shouldResume ? true : undefined,
		})
	}

	/**
	 * Pause the retry queue. When paused, no retries will be processed.
	 * This is useful when auth state is not active or during logout.
	 */
	public pause(): void {
		this.isPaused = true
		if (this.pendingPersistenceBarrier) {
			this.pendingPersistenceBarrier.resumeRequested = false
		}
		this.log("[RetryQueue] Queue paused")
	}

	// kilocode_change start
	/**
	 * Pause retries and require a stable account ID before accepting or sending
	 * authenticated work again.
	 */
	public pauseUntilOwnerConfirmed(): void {
		if (this.authHeaderProvider) {
			this.requiresOwnerConfirmation = true
		}
		this.pause()
	}
	// kilocode_change end

	/**
	 * Resume the retry queue. Retries will be processed again on the next interval.
	 */
	public resume(): void {
		if (this.requiresOwnerConfirmation || this.legacyQueueHasUnknownOwner || this.pendingPersistenceBarrier) {
			this.isPaused = true
			if (this.pendingPersistenceBarrier) {
				this.pendingPersistenceBarrier.resumeRequested = true
				void this.ensurePersistenceBarrier().catch((error) => {
					this.log("[RetryQueue] Queue remains paused until durable transition succeeds:", error)
				})
			}
			this.log("[RetryQueue] Queue resume deferred until owner and storage are durable")
			return
		}

		this.isPaused = false
		this.log("[RetryQueue] Queue resumed")
	}

	/**
	 * Check if the queue is paused
	 */
	public isPausedState(): boolean {
		return this.isPaused
	}

	/**
	 * Set the current user ID for tracking user changes
	 */
	public setCurrentUserId(userId: string | undefined): void {
		this.currentUserId = userId
		if (userId !== undefined) {
			this.ownerKnown = true
		}
	}

	/**
	 * Get the current user ID
	 */
	public getCurrentUserId(): string | undefined {
		return this.currentUserId
	}

	/**
	 * Conditionally clear the queue based on user ID change.
	 * If newUserId is different from currentUserId, clear the queue.
	 * Returns true if queue was cleared, false otherwise.
	 */
	public clearIfUserChanged(newUserId: string | undefined): boolean {
		this.requiresOwnerConfirmation = false
		const effectiveOwner = this.getEffectiveOwner()

		if (!effectiveOwner.known) {
			if (this.legacyQueueHasUnknownOwner) {
				this.log("[RetryQueue] Discarding legacy requests because their account owner is unknown")
				this.legacyQueueHasUnknownOwner = false
				this.beginPersistenceBarrier({
					clearQueue: true,
					emitQueueCleared: true,
					targetOwnerKnown: true,
					targetOwnerUserId: newUserId,
				})
				return true
			}

			// Even an empty/new queue must durably record its owner before it can
			// be resumed. This makes a later failed account-switch clear
			// detectable after restart.
			this.beginPersistenceBarrier({
				clearQueue: false,
				emitQueueCleared: false,
				targetOwnerKnown: true,
				targetOwnerUserId: newUserId,
			})
			return false
		}

		// If user IDs are different (including logout case where newUserId is undefined)
		if (effectiveOwner.userId !== newUserId) {
			this.log(`[RetryQueue] User changed from ${effectiveOwner.userId} to ${newUserId}, clearing queue`)
			this.legacyQueueHasUnknownOwner = false
			this.beginPersistenceBarrier({
				clearQueue: true,
				emitQueueCleared: true,
				targetOwnerKnown: true,
				targetOwnerUserId: newUserId,
			})
			return true
		}

		return false
	}

	public dispose(): void {
		if (this.retryTimer) {
			clearInterval(this.retryTimer)
		}
		this.removeAllListeners()
	}
}
