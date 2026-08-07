import type { ExtensionContext } from "vscode"
import { RetryQueue } from "../RetryQueue.js"
import type { QueuedRequest } from "../types.js"

// Mock ExtensionContext. Clone values to model VS Code's durable serialization
// rather than letting in-memory request mutations alter the persisted snapshot.
const createMockContext = (storage = new Map<string, unknown>()): ExtensionContext => {
	return {
		workspaceState: {
			get: vi.fn((key: string) => {
				const value = storage.get(key)
				return value === undefined ? undefined : structuredClone(value)
			}),
			update: vi.fn(async (key: string, value: unknown) => {
				storage.set(key, structuredClone(value))
			}),
		},
	} as unknown as ExtensionContext
}

const createQueuedRequest = (id: string, url = `https://api.example.com/${id}`): QueuedRequest => ({
	id,
	url,
	options: { method: "POST" },
	timestamp: Date.now(),
	retryCount: 0,
	type: "telemetry",
})

describe("RetryQueue", () => {
	let mockContext: ExtensionContext
	let retryQueue: RetryQueue

	beforeEach(() => {
		vi.clearAllMocks()
		mockContext = createMockContext()
		retryQueue = new RetryQueue(mockContext)
	})

	afterEach(() => {
		retryQueue.dispose()
	})

	describe("enqueue", () => {
		it("should add a request to the queue", async () => {
			const url = "https://api.example.com/test"
			const options = { method: "POST", body: JSON.stringify({ test: "data" }) }

			await retryQueue.enqueue(url, options, "telemetry")

			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(1)
			expect(stats.byType["telemetry"]).toBe(1)
		})

		it("should enforce max queue size with FIFO eviction", async () => {
			// Create a queue with max size of 3
			retryQueue = new RetryQueue(mockContext, { maxQueueSize: 3 })

			// Add 4 requests
			for (let i = 1; i <= 4; i++) {
				await retryQueue.enqueue(`https://api.example.com/test${i}`, { method: "POST" }, "telemetry")
			}

			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(3) // Should only have 3 items (oldest was evicted)
		})

		it("should reject and restore the in-memory queue when initial persistence fails", async () => {
			await retryQueue.enqueue("https://api.example.com/existing", { method: "POST" }, "telemetry")
			const queuedListener = vi.fn()
			retryQueue.on("request-queued", queuedListener)
			vi.mocked(mockContext.workspaceState.update).mockRejectedValueOnce(new Error("disk unavailable"))

			await expect(
				retryQueue.enqueue("https://api.example.com/not-persisted", { method: "POST" }, "api-call"),
			).rejects.toThrow("disk unavailable")

			expect(retryQueue.getStats()).toMatchObject({
				totalQueued: 1,
				byType: { telemetry: 1 },
			})
			expect(queuedListener).not.toHaveBeenCalled()
		})

		it("should restore a FIFO-evicted request when a concurrent enqueue cannot persist", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext, { maxQueueSize: 2 })
			await retryQueue.enqueue("https://api.example.com/first", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/second", { method: "POST" }, "telemetry")

			const fetchMock = vi.fn().mockRejectedValue(new Error("network unavailable"))
			global.fetch = fetchMock
			const retry = retryQueue.retryAll()
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

			let rejectEnqueueWrite!: (error: Error) => void
			vi.mocked(mockContext.workspaceState.update).mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectEnqueueWrite = reject
					}),
			)
			const enqueue = retryQueue.enqueue("https://api.example.com/third", { method: "POST" }, "telemetry")
			await vi.waitFor(() => expect(mockContext.workspaceState.update).toHaveBeenCalledTimes(3))
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
			await vi.waitFor(() => expect(Reflect.get(retryQueue, "mutationEpoch")).toBe(4))

			rejectEnqueueWrite(new Error("storage unavailable"))

			await expect(enqueue).rejects.toThrow("storage unavailable")
			await retry
			expect(retryQueue.getStats()).toMatchObject({
				totalQueued: 2,
				totalRetries: 2,
			})
			expect(storage.get("roo.retryQueue")).toMatchObject({
				requests: [
					expect.objectContaining({ url: "https://api.example.com/first", retryCount: 1 }),
					expect.objectContaining({ url: "https://api.example.com/second", retryCount: 1 }),
				],
			})
		})

		it("should not move an enqueue waiting in the local tail to a different account", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer current-token",
			})
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await vi.waitFor(() => expect(retryQueue.getCurrentUserId()).toBe("user-a"))

			let resolveFirstWrite!: () => void
			vi.mocked(mockContext.workspaceState.update).mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveFirstWrite = resolve
					}),
			)
			const first = retryQueue.enqueue("https://api.example.com/user-a-first", { method: "POST" }, "telemetry")
			await vi.waitFor(() => expect(mockContext.workspaceState.update).toHaveBeenCalledTimes(2))
			const waiting = retryQueue.enqueue(
				"https://api.example.com/user-a-waiting",
				{ method: "POST" },
				"telemetry",
			)

			expect(retryQueue.clearIfUserChanged("user-b")).toBe(true)
			retryQueue.resume()
			resolveFirstWrite()

			await first
			await expect(waiting).rejects.toThrow("Retry queue owner changed before request could be queued")
			await retryQueue.retryAll()

			expect(retryQueue.getCurrentUserId()).toBe("user-b")
			expect(retryQueue.getStats().totalQueued).toBe(0)
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerUserId: "user-b",
				requests: [],
			})
		})

		it("should not resurrect a durably evicted request when retry persistence rolls back", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext, { maxQueueSize: 2 })
			await retryQueue.enqueue("https://api.example.com/first", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/second", { method: "POST" }, "telemetry")

			let rejectSecondRetry!: (error: Error) => void
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new Error("first network failure"))
				.mockReturnValueOnce(
					new Promise((_resolve, reject) => {
						rejectSecondRetry = reject
					}),
				)
			global.fetch = fetchMock
			const retry = retryQueue.retryAll()
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

			await retryQueue.enqueue("https://api.example.com/third", { method: "POST" }, "telemetry")
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
			vi.mocked(mockContext.workspaceState.update).mockRejectedValueOnce(new Error("storage unavailable"))
			rejectSecondRetry(new Error("second network failure"))

			await expect(retry).rejects.toThrow("storage unavailable")
			expect(retryQueue.getStats()).toMatchObject({
				totalQueued: 2,
				totalRetries: 0,
			})
			expect(storage.get("roo.retryQueue")).toMatchObject({
				requests: [
					expect.objectContaining({ url: "https://api.example.com/second", retryCount: 0 }),
					expect.objectContaining({ url: "https://api.example.com/third", retryCount: 0 }),
				],
			})
		})
	})

	describe("persistence", () => {
		it("should persist queue to workspace state", async () => {
			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			expect(mockContext.workspaceState.update).toHaveBeenCalledWith(
				"roo.retryQueue",
				expect.objectContaining({
					version: 1,
					ownerKnown: false,
					mutationEpoch: 1,
					requests: expect.arrayContaining([
						expect.objectContaining({
							url: "https://api.example.com/test",
							type: "telemetry",
						}),
					]),
				}),
			)
		})

		it("should load persisted queue on initialization", () => {
			const persistedRequests: QueuedRequest[] = [createQueuedRequest("test-1")]

			// Set up mock to return persisted data
			const storage = new Map([["roo.retryQueue", persistedRequests]])
			mockContext = createMockContext(storage)

			retryQueue = new RetryQueue(mockContext)

			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(1)
			expect(mockContext.workspaceState.get).toHaveBeenCalledWith("roo.retryQueue")
		})

		it("should quarantine legacy array storage until its unknown owner is discarded", async () => {
			const storage = new Map<string, unknown>([["roo.retryQueue", [createQueuedRequest("legacy")]]])
			mockContext = createMockContext(storage)
			const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
			global.fetch = fetchMock
			retryQueue = new RetryQueue(mockContext, {}, undefined, () => ({
				Authorization: "Bearer user-b",
			}))

			retryQueue.resume()
			await retryQueue.retryAll()

			expect(retryQueue.isPausedState()).toBe(true)
			expect(fetchMock).not.toHaveBeenCalled()
			expect(retryQueue.clearIfUserChanged("user-b")).toBe(true)
			retryQueue.resume()
			await retryQueue.retryAll()

			expect(retryQueue.getStats().totalQueued).toBe(0)
			expect(retryQueue.getCurrentUserId()).toBe("user-b")
			expect(fetchMock).not.toHaveBeenCalled()
			expect(storage.get("roo.retryQueue")).toMatchObject({
				version: 1,
				ownerKnown: true,
				ownerUserId: "user-b",
				requests: [],
			})
		})
	})

	describe("clear", () => {
		it("should clear all queued requests", async () => {
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "api-call")

			let stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(2)

			retryQueue.clear()

			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
		})

		it("should resume after a running queue is durably cleared", async () => {
			const clearListener = vi.fn()
			retryQueue.on("queue-cleared", clearListener)
			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			retryQueue.clear()

			expect(retryQueue.isPausedState()).toBe(true)
			await vi.waitFor(() => expect(clearListener).toHaveBeenCalledTimes(1))
			expect(retryQueue.isPausedState()).toBe(false)
		})
	})

	describe("getStats", () => {
		it("should return correct statistics", async () => {
			const now = Date.now()

			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "api-call")
			await retryQueue.enqueue("https://api.example.com/test3", { method: "POST" }, "telemetry")

			const stats = retryQueue.getStats()

			expect(stats.totalQueued).toBe(3)
			expect(stats.byType["telemetry"]).toBe(2)
			expect(stats.byType["api-call"]).toBe(1)
			expect(stats.oldestRequest).toBeDefined()
			expect(stats.newestRequest).toBeDefined()
			expect(stats.oldestRequest!.getTime()).toBeGreaterThanOrEqual(now)
			expect(stats.newestRequest!.getTime()).toBeGreaterThanOrEqual(now)
		})
	})

	describe("events", () => {
		it("should emit request-queued event when enqueueing", async () => {
			const listener = vi.fn()
			retryQueue.on("request-queued", listener)

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://api.example.com/test",
					type: "telemetry",
				}),
			)
		})

		it("should emit queue-cleared event only after clearing is durable", async () => {
			const listener = vi.fn()
			retryQueue.on("queue-cleared", listener)

			retryQueue.clear()

			expect(listener).not.toHaveBeenCalled()
			await vi.waitFor(() => expect(listener).toHaveBeenCalled())
		})
	})

	describe("auth state management", () => {
		it("should pause and resume the queue", () => {
			expect(retryQueue.isPausedState()).toBe(false)

			retryQueue.pause()
			expect(retryQueue.isPausedState()).toBe(true)

			retryQueue.resume()
			expect(retryQueue.isPausedState()).toBe(false)
		})

		it("should not process retries when paused", async () => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true })
			global.fetch = fetchMock

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// Pause the queue
			retryQueue.pause()

			// Try to retry all
			await retryQueue.retryAll()

			// Fetch should not be called because queue is paused
			expect(fetchMock).not.toHaveBeenCalled()

			// Resume and retry
			retryQueue.resume()
			await retryQueue.retryAll()

			// Now fetch should be called
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it("should track and update current user ID", () => {
			expect(retryQueue.getCurrentUserId()).toBeUndefined()

			retryQueue.setCurrentUserId("user_123")
			expect(retryQueue.getCurrentUserId()).toBe("user_123")

			retryQueue.setCurrentUserId("user_456")
			expect(retryQueue.getCurrentUserId()).toBe("user_456")

			retryQueue.setCurrentUserId(undefined)
			expect(retryQueue.getCurrentUserId()).toBeUndefined()
		})

		it("should clear queue when user changes", async () => {
			// Add some requests
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")

			let stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(2)

			// Set initial user
			retryQueue.setCurrentUserId("user_123")

			// Same user login - should not clear
			let wasCleared = retryQueue.clearIfUserChanged("user_123")
			expect(wasCleared).toBe(false)
			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(2)

			// Different user login - should clear
			wasCleared = retryQueue.clearIfUserChanged("user_456")
			expect(wasCleared).toBe(true)
			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
			expect(retryQueue.getCurrentUserId()).toBe("user_123")
			await vi.waitFor(() => expect(retryQueue.getCurrentUserId()).toBe("user_456"))
		})

		it("should clear queue on logout (undefined user)", async () => {
			// Set initial user
			retryQueue.setCurrentUserId("user_123")

			// Add some requests
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")

			let stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(2)

			// Logout (undefined user) - should clear
			const wasCleared = retryQueue.clearIfUserChanged(undefined)
			expect(wasCleared).toBe(true)
			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
			expect(retryQueue.getCurrentUserId()).toBe("user_123")
			await vi.waitFor(() => expect(retryQueue.getCurrentUserId()).toBeUndefined())
		})

		it("should not clear on first login (no previous user)", async () => {
			// Add some requests before any user is set
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")

			let stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(2)

			// First login - should not clear
			const wasCleared = retryQueue.clearIfUserChanged("user_123")
			expect(wasCleared).toBe(false)
			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(2)
			await vi.waitFor(() => expect(retryQueue.getCurrentUserId()).toBe("user_123"))
		})

		it("should handle multiple user transitions correctly", async () => {
			const clearListener = vi.fn()
			retryQueue.on("queue-cleared", clearListener)

			// First user logs in
			retryQueue.clearIfUserChanged("user_123")
			await retryQueue.enqueue("https://api.example.com/user1-req", { method: "POST" }, "telemetry")

			// User logs out
			const clearedOnLogout = retryQueue.clearIfUserChanged(undefined)
			expect(clearedOnLogout).toBe(true)
			await vi.waitFor(() => expect(clearListener).toHaveBeenCalledTimes(1))

			// Different user logs in
			await retryQueue.enqueue("https://api.example.com/user2-req", { method: "POST" }, "telemetry")
			const clearedOnNewUser = retryQueue.clearIfUserChanged("user_456")
			expect(clearedOnNewUser).toBe(true)
			await vi.waitFor(() => expect(clearListener).toHaveBeenCalledTimes(2))

			// Same user logs back in
			await retryQueue.enqueue("https://api.example.com/user2-req2", { method: "POST" }, "telemetry")
			const notCleared = retryQueue.clearIfUserChanged("user_456")
			expect(notCleared).toBe(false)
			expect(clearListener).toHaveBeenCalledTimes(2) // Still 2, not cleared

			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(1) // Only the last request remains
		})

		it("should remain paused and keep the durable owner when account-switch clearing cannot persist", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer current-token",
			})
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await retryQueue.enqueue("https://api.example.com/user-a-request", { method: "POST" }, "telemetry")

			vi.mocked(mockContext.workspaceState.update).mockRejectedValue(new Error("storage unavailable"))
			expect(retryQueue.clearIfUserChanged("user-b")).toBe(true)
			retryQueue.resume()

			await expect(retryQueue.retryAll()).rejects.toThrow("storage unavailable")
			expect(retryQueue.isPausedState()).toBe(true)
			expect(retryQueue.getCurrentUserId()).toBe("user-a")
			expect(retryQueue.getStats().totalQueued).toBe(0)
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerUserId: "user-a",
				requests: [expect.objectContaining({ url: "https://api.example.com/user-a-request" })],
			})

			// Simulate a crash/restart after the failed clear. The old envelope is
			// loaded as user-a, compared with user-b, and cleared before any retry.
			retryQueue.dispose()
			const restartedContext = createMockContext(storage)
			const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
			global.fetch = fetchMock
			retryQueue = new RetryQueue(restartedContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-b")).toBe(true)
			retryQueue.resume()
			await retryQueue.retryAll()

			expect(fetchMock).not.toHaveBeenCalled()
			expect(retryQueue.isPausedState()).toBe(false)
			expect(retryQueue.getCurrentUserId()).toBe("user-b")
			expect(retryQueue.getStats().totalQueued).toBe(0)
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerUserId: "user-b",
				requests: [],
			})
		})

		it("should let a newer active-session owner supersede an in-flight logout transition", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer user-a-token",
			})
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await retryQueue.enqueue("https://api.example.com/user-a-request", { method: "POST" }, "telemetry")

			let resolveLogoutWrite!: () => void
			vi.mocked(mockContext.workspaceState.update).mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveLogoutWrite = resolve
					}),
			)
			expect(retryQueue.clearIfUserChanged(undefined)).toBe(true)
			retryQueue.pauseUntilOwnerConfirmed()
			await vi.waitFor(() => expect(mockContext.workspaceState.update).toHaveBeenCalledTimes(3))

			expect(retryQueue.clearIfUserChanged("user-a")).toBe(true)
			retryQueue.resume()
			resolveLogoutWrite()
			await retryQueue.retryAll()

			expect(retryQueue.isPausedState()).toBe(false)
			expect(retryQueue.getCurrentUserId()).toBe("user-a")
			expect(retryQueue.getStats().totalQueued).toBe(0)
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerKnown: true,
				ownerUserId: "user-a",
				requests: [],
			})
		})
	})

	describe("retryAll", () => {
		let fetchMock: ReturnType<typeof vi.fn>

		beforeEach(() => {
			// Mock global fetch
			fetchMock = vi.fn()
			global.fetch = fetchMock
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it("should process requests in FIFO order", async () => {
			const successListener = vi.fn()
			retryQueue.on("request-retry-success", successListener)

			// Add multiple requests
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test3", { method: "POST" }, "telemetry")

			// Mock successful responses
			fetchMock.mockResolvedValue({ ok: true })

			await retryQueue.retryAll()

			// Check that fetch was called in FIFO order
			expect(fetchMock).toHaveBeenCalledTimes(3)
			expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/test1")
			expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example.com/test2")
			expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.example.com/test3")

			// Check that success events were emitted
			expect(successListener).toHaveBeenCalledTimes(3)

			// Queue should be empty after successful retries
			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
		})

		it("should restore and durably retain successful requests when deleting them cannot persist", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext)
			retryQueue.setCurrentUserId("user-a")
			await retryQueue.enqueue("https://api.example.com/restart-safe", { method: "POST" }, "telemetry")
			const successListener = vi.fn()
			retryQueue.on("request-retry-success", successListener)
			fetchMock.mockResolvedValue({ ok: true, status: 200 })
			vi.mocked(mockContext.workspaceState.update).mockRejectedValueOnce(new Error("storage unavailable"))

			await expect(retryQueue.retryAll()).rejects.toThrow("storage unavailable")

			expect(successListener).not.toHaveBeenCalled()
			expect(retryQueue.getStats().totalQueued).toBe(1)
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerUserId: "user-a",
				requests: [expect.objectContaining({ url: "https://api.example.com/restart-safe" })],
			})

			retryQueue.dispose()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await retryQueue.retryAll()

			expect(fetchMock).toHaveBeenCalledTimes(2)
			expect(retryQueue.getStats().totalQueued).toBe(0)
		})

		it("should not publish or retain retry-count mutations that failed to persist", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext)
			retryQueue.setCurrentUserId("user-a")
			await retryQueue.enqueue("https://api.example.com/retry-count", { method: "POST" }, "telemetry")
			const failedListener = vi.fn()
			retryQueue.on("request-retry-failed", failedListener)
			fetchMock.mockRejectedValue(new Error("network unavailable"))
			vi.mocked(mockContext.workspaceState.update).mockRejectedValueOnce(new Error("storage unavailable"))

			await expect(retryQueue.retryAll()).rejects.toThrow("storage unavailable")

			expect(failedListener).not.toHaveBeenCalled()
			expect(retryQueue.getStats()).toMatchObject({
				totalQueued: 1,
				totalRetries: 0,
				failedRetries: 0,
			})
			expect(storage.get("roo.retryQueue")).toMatchObject({
				requests: [
					expect.objectContaining({
						url: "https://api.example.com/retry-count",
						retryCount: 0,
					}),
				],
			})
		})

		it("should restore a durably persisted retry count without sending before owner confirmation", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer user-a-token",
			})
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await retryQueue.enqueue("https://api.example.com/retry-after-restart", { method: "POST" }, "telemetry")
			fetchMock.mockRejectedValueOnce(new Error("network unavailable"))
			await retryQueue.retryAll()
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerUserId: "user-a",
				requests: [
					expect.objectContaining({
						url: "https://api.example.com/retry-after-restart",
						retryCount: 1,
					}),
				],
			})

			retryQueue.dispose()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			fetchMock.mockClear()
			await retryQueue.retryAll()

			expect(fetchMock).not.toHaveBeenCalled()
			expect(retryQueue.getStats()).toMatchObject({
				totalQueued: 1,
				totalRetries: 1,
				failedRetries: 1,
			})

			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200 })
			await retryQueue.retryAll()

			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(retryQueue.getStats().totalQueued).toBe(0)
		})

		it("should discard an in-flight old-owner result when the account changes", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext)
			retryQueue.setCurrentUserId("user-a")
			await retryQueue.enqueue("https://api.example.com/user-a-in-flight", { method: "POST" }, "telemetry")
			const successListener = vi.fn()
			retryQueue.on("request-retry-success", successListener)
			let resolveRequest!: (response: { ok: boolean; status: number }) => void
			fetchMock.mockReturnValue(
				new Promise((resolve) => {
					resolveRequest = resolve
				}),
			)

			const retry = retryQueue.retryAll()
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
			expect(retryQueue.clearIfUserChanged("user-b")).toBe(true)
			retryQueue.resume()
			resolveRequest({ ok: true, status: 200 })
			await retry
			await vi.waitFor(() => expect(retryQueue.getCurrentUserId()).toBe("user-b"))

			expect(successListener).not.toHaveBeenCalled()
			expect(retryQueue.getStats().totalQueued).toBe(0)
			expect(storage.get("roo.retryQueue")).toMatchObject({
				ownerUserId: "user-b",
				requests: [],
			})
		})

		it("should handle failed retries and increment retry count", async () => {
			const failListener = vi.fn()
			retryQueue.on("request-retry-failed", failListener)

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// Mock failed response
			fetchMock.mockRejectedValue(new Error("Network error"))

			await retryQueue.retryAll()

			// Check that failure event was emitted
			expect(failListener).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://api.example.com/test",
					retryCount: 1,
					lastError: "Network error",
				}),
				expect.any(Error),
			)

			// Request should still be in queue
			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(1)
		})

		it("should enforce max retries limit", async () => {
			// Create queue with max retries of 2
			retryQueue = new RetryQueue(mockContext, { maxRetries: 2 })

			const maxRetriesListener = vi.fn()
			retryQueue.on("request-max-retries-exceeded", maxRetriesListener)

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// Mock failed responses
			fetchMock.mockRejectedValue(new Error("Network error"))

			// First retry
			await retryQueue.retryAll()
			let stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(1) // Still in queue

			// Second retry - should hit max retries
			await retryQueue.retryAll()

			// Check that max retries event was emitted
			expect(maxRetriesListener).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://api.example.com/test",
					retryCount: 2,
				}),
				expect.any(Error),
			)

			// Request should be removed from queue after exceeding max retries
			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
		})

		it("should not process if already processing", async () => {
			// Add a request
			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// Mock a slow response
			fetchMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 100)))

			// Start first retryAll (don't await)
			const firstCall = retryQueue.retryAll()

			// Try to call retryAll again immediately
			const secondCall = retryQueue.retryAll()

			// Both should complete without errors
			await Promise.all([firstCall, secondCall])

			// Fetch should only be called once (from the first call)
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it("should handle empty queue gracefully", async () => {
			// Call retryAll on empty queue
			await expect(retryQueue.retryAll()).resolves.toBeUndefined()

			// No fetch calls should be made
			expect(fetchMock).not.toHaveBeenCalled()
		})

		it("should use auth header provider if available", async () => {
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer fresh-token",
			})

			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user_123")).toBe(false)
			retryQueue.resume()

			await retryQueue.enqueue(
				"https://api.example.com/test",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
				},
				"telemetry",
			)

			fetchMock.mockResolvedValue({ ok: true })

			await retryQueue.retryAll()

			// Check that fresh auth headers were used
			expect(fetchMock).toHaveBeenCalledWith(
				"https://api.example.com/test",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer fresh-token",
						"Content-Type": "application/json",
						"X-Retry-Queue": "true",
					}),
				}),
			)

			expect(authHeaderProvider).toHaveBeenCalled()
		})

		it("should not send or consume retry budget when fresh auth headers are unavailable", async () => {
			const authHeaderProvider = vi.fn().mockReturnValue(undefined)
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user_123")).toBe(false)
			retryQueue.resume()
			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			await retryQueue.retryAll()

			expect(fetchMock).not.toHaveBeenCalled()
			expect(retryQueue.getStats()).toMatchObject({
				totalQueued: 1,
				totalRetries: 0,
				failedRetries: 0,
			})
		})

		it("should stop before the next request when authenticated ownership becomes unknown", async () => {
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer user-a-token",
			})
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await retryQueue.enqueue("https://api.example.com/first", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/second", { method: "POST" }, "telemetry")

			let resolveFirst!: (response: { ok: boolean; status: number }) => void
			fetchMock.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveFirst = resolve
				}),
			)
			const retry = retryQueue.retryAll()
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

			retryQueue.pauseUntilOwnerConfirmed()
			resolveFirst({ ok: true, status: 200 })
			await retry

			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(retryQueue.isPausedState()).toBe(true)
			expect(retryQueue.getStats().totalQueued).toBe(1)
		})

		it("should respect configurable timeout", async () => {
			// Create queue with custom timeout (short timeout for testing)
			retryQueue = new RetryQueue(mockContext, { requestTimeout: 100 })

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// Mock fetch to reject with abort error
			const abortError = new Error("The operation was aborted")
			abortError.name = "AbortError"
			fetchMock.mockRejectedValue(abortError)

			const failListener = vi.fn()
			retryQueue.on("request-retry-failed", failListener)

			await retryQueue.retryAll()

			// Check that the request failed with an abort error
			expect(failListener).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://api.example.com/test",
					lastError: "The operation was aborted",
				}),
				expect.any(Error),
			)

			// The timeout configuration is being used (verified by the constructor accepting it)
			// The actual timeout behavior is handled by the browser's AbortController
		})

		it("should retry on 500+ status codes", async () => {
			const failListener = vi.fn()
			const successListener = vi.fn()
			retryQueue.on("request-retry-failed", failListener)
			retryQueue.on("request-retry-success", successListener)

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// First attempt: 500 error
			fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" })

			await retryQueue.retryAll()

			// Should fail and remain in queue
			expect(failListener).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://api.example.com/test",
					retryCount: 1,
					lastError: "Server error: 500 Internal Server Error",
				}),
				expect.any(Error),
			)

			let stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(1)

			// Second attempt: success
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200 })

			await retryQueue.retryAll()

			// Should succeed and be removed from queue
			expect(successListener).toHaveBeenCalled()
			stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
		})

		it("should pause entire queue on 429 rate limiting with Retry-After header", async () => {
			// Add multiple requests to test queue-wide pause
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test3", { method: "POST" }, "telemetry")

			// Mock 429 response with Retry-After header (in seconds) for the first request
			const retryAfterResponse = {
				ok: false,
				status: 429,
				headers: {
					get: vi.fn((header: string) => {
						if (header === "Retry-After") return "2" // 2 seconds
						return null
					}),
				},
			}

			fetchMock.mockResolvedValueOnce(retryAfterResponse)

			await retryQueue.retryAll()

			// All requests should still be in queue
			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(3)

			// Only the first request should have been attempted
			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/test1", expect.any(Object))

			// Try to retry immediately - should be skipped due to queue-wide rate limiting
			fetchMock.mockClear()
			await retryQueue.retryAll()

			// No fetch calls should be made because the entire queue is paused
			expect(fetchMock).not.toHaveBeenCalled()
		})

		// kilocode_change start
		it("should keep the request queued when a 429 response omits Retry-After", async () => {
			const successListener = vi.fn()
			retryQueue.on("request-retry-success", successListener)

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: { get: vi.fn().mockReturnValue(null) },
			})

			await retryQueue.retryAll()

			expect(retryQueue.getStats().totalQueued).toBe(1)
			expect(successListener).not.toHaveBeenCalled()
		})

		it("should preserve a future Retry-After pause across restart", async () => {
			const storage = new Map<string, unknown>()
			mockContext = createMockContext(storage)
			const authHeaderProvider = vi.fn().mockReturnValue({
				Authorization: "Bearer user-a-token",
			})
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			await retryQueue.enqueue("https://api.example.com/rate-limited", { method: "POST" }, "telemetry")
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: { get: vi.fn().mockReturnValue("60") },
			})

			await retryQueue.retryAll()

			const persistedPause = (storage.get("roo.retryQueue") as { queuePausedUntil?: number }).queuePausedUntil
			expect(persistedPause).toBeGreaterThan(Date.now())
			retryQueue.dispose()

			mockContext = createMockContext(storage)
			retryQueue = new RetryQueue(mockContext, {}, undefined, authHeaderProvider)
			expect(retryQueue.clearIfUserChanged("user-a")).toBe(false)
			retryQueue.resume()
			fetchMock.mockClear()
			await retryQueue.retryAll()

			expect(fetchMock).not.toHaveBeenCalled()
			expect(retryQueue.getStats().totalQueued).toBe(1)
		})

		it.each([
			["an invalid value", "not-a-retry-date", 60 * 1000],
			["an invalid decimal value", "1.5", 60 * 1000],
			["an overflowing seconds value", "9".repeat(400), 24 * 60 * 60 * 1000],
			["a negative seconds value", "-30", 60_000],
			["a far-future date", "Fri, 31 Dec 9999 23:59:59 GMT", 24 * 60 * 60 * 1000],
		])("bounds Retry-After when the server returns %s", async (_label, retryAfter, expectedDelayMs) => {
			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: { get: vi.fn().mockReturnValue(retryAfter) },
			})
			const before = Date.now()

			await retryQueue.retryAll()

			const pausedUntil = Reflect.get(retryQueue, "queuePausedUntil") as number
			const observedDelay = pausedUntil - before
			expect(Number.isFinite(pausedUntil)).toBe(true)
			expect(() => new Date(pausedUntil).toISOString()).not.toThrow()
			expect(observedDelay).toBeGreaterThanOrEqual(expectedDelayMs)
			expect(observedDelay).toBeLessThanOrEqual(expectedDelayMs + 250)
			expect(retryQueue.getStats().totalQueued).toBe(1)
		})
		// kilocode_change end

		it("should process all requests after rate limit period expires", async () => {
			// Add multiple requests
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")

			// Mock 429 response with very short Retry-After (for testing)
			const retryAfterResponse = {
				ok: false,
				status: 429,
				headers: {
					get: vi.fn((header: string) => {
						if (header === "Retry-After") return "0" // 0 seconds (immediate)
						return null
					}),
				},
			}

			fetchMock.mockResolvedValueOnce(retryAfterResponse)

			await retryQueue.retryAll()

			// Queue should be paused but requests still in queue
			expect(retryQueue.getStats().totalQueued).toBe(2)

			// Wait a tiny bit for the rate limit to "expire"
			await new Promise((resolve) => setTimeout(resolve, 10))

			// Mock successful responses for both requests
			fetchMock.mockResolvedValue({ ok: true })

			// Now retry should process all requests
			await retryQueue.retryAll()

			// All requests should be processed and removed from queue
			expect(retryQueue.getStats().totalQueued).toBe(0)
			// First request will be retried plus the second one
			expect(fetchMock).toHaveBeenCalledTimes(3) // 1 (429) + 2 (success)
		})

		it("should not retry on 401/403 auth errors", async () => {
			const successListener = vi.fn()
			retryQueue.on("request-retry-success", successListener)

			await retryQueue.enqueue("https://api.example.com/test", { method: "POST" }, "telemetry")

			// Mock 401 error
			fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" })

			await retryQueue.retryAll()

			// Should be removed from queue without retry (401 is a client error)
			expect(successListener).toHaveBeenCalled()
			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)

			// Test 403 as well
			await retryQueue.enqueue("https://api.example.com/test2", { method: "POST" }, "telemetry")
			fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })

			await retryQueue.retryAll()

			// Should also be removed from queue without retry
			expect(successListener).toHaveBeenCalledTimes(2)
			const stats2 = retryQueue.getStats()
			expect(stats2.totalQueued).toBe(0)
		})

		it("should not retry on 400/404/422 client errors", async () => {
			const successListener = vi.fn()
			retryQueue.on("request-retry-success", successListener)

			// Test various 4xx errors that should not be retried
			const clientErrors = [
				{ status: 400, statusText: "Bad Request" },
				{ status: 404, statusText: "Not Found" },
				{ status: 422, statusText: "Unprocessable Entity" },
			]

			for (const error of clientErrors) {
				await retryQueue.enqueue(
					`https://api.example.com/test-${error.status}`,
					{ method: "POST" },
					"telemetry",
				)
				fetchMock.mockResolvedValueOnce({ ok: false, ...error })
			}

			await retryQueue.retryAll()

			// All requests should be removed from queue without retry
			expect(successListener).toHaveBeenCalledTimes(3)
			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
		})

		it("should prevent concurrent processing", async () => {
			// Add a single request
			await retryQueue.enqueue("https://api.example.com/test1", { method: "POST" }, "telemetry")

			// Mock slow response
			let resolveFirst: () => void
			const firstPromise = new Promise<{ ok: boolean }>((resolve) => {
				resolveFirst = () => resolve({ ok: true })
			})

			fetchMock.mockReturnValueOnce(firstPromise)

			// Start first retryAll (don't await)
			const firstCall = retryQueue.retryAll()

			// Try to call retryAll again immediately - should return immediately without processing
			const secondCall = retryQueue.retryAll()

			// Second call should return immediately
			await secondCall

			// Fetch should only be called once (from first call)
			expect(fetchMock).toHaveBeenCalledTimes(1)

			// Resolve the promise
			resolveFirst!()

			// Wait for first call to complete
			await firstCall

			// Queue should be empty
			const stats = retryQueue.getStats()
			expect(stats.totalQueued).toBe(0)
		})
	})
})
