import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import { createRequire } from "module"
import { Worker } from "node:worker_threads"

import {
	AiCodeCommitPartialMatcher,
	PartialMatcherCancelledError,
	type MatchPartialPendingBlocksParams,
	type PartialBlockMatchResult,
} from "./AiCodeCommitPartialMatcher"
import {
	type PartialMatcherWorkerResponse,
	deserializePartialBlockMatchResults,
	serializeMatchPartialPendingBlocksParams,
} from "./AiCodeCommitPartialMatcherWorkerProtocol"

export interface AiCodeCommitPartialMatcherExecutor {
	matchPartialPendingBlocks(params: MatchPartialPendingBlocksParams): Promise<PartialBlockMatchResult[]>
	cancelAll(): void
	dispose(): void
}

interface PendingWorkerRequest {
	resolve: (value: PartialBlockMatchResult[]) => void
	reject: (error: unknown) => void
}

interface AiCodeCommitPartialMatcherWorkerClientOptions {
	blockBatchSize?: number
	useWorkerThread?: boolean
}

interface SharedExecutorState {
	client: AiCodeCommitPartialMatcherWorkerClient
	refCount: number
}

export const createInlinePartialMatcherExecutor = (): AiCodeCommitPartialMatcherExecutor => {
	const matcher = new AiCodeCommitPartialMatcher()
	return {
		matchPartialPendingBlocks: async (params) => matcher.matchPartialPendingBlocks(params),
		cancelAll: () => {},
		dispose: () => {},
	}
}

let sharedExecutorState: SharedExecutorState | null = null

export const createSharedPartialMatcherExecutor = (
	options: AiCodeCommitPartialMatcherWorkerClientOptions = {},
): AiCodeCommitPartialMatcherExecutor => {
	if (!sharedExecutorState) {
		sharedExecutorState = {
			client: new AiCodeCommitPartialMatcherWorkerClient(options),
			refCount: 0,
		}
	}

	sharedExecutorState.refCount += 1
	let disposed = false

	return {
		matchPartialPendingBlocks: async (params) => {
			if (disposed || !sharedExecutorState) {
				throw new PartialMatcherCancelledError()
			}
			return sharedExecutorState.client.matchPartialPendingBlocks(params)
		},
		cancelAll: () => {
			if (!sharedExecutorState || sharedExecutorState.refCount > 1) {
				return
			}
			sharedExecutorState.client.cancelAll()
		},
		dispose: () => {
			if (disposed || !sharedExecutorState) {
				return
			}
			disposed = true
			sharedExecutorState.refCount -= 1
			if (sharedExecutorState.refCount <= 0) {
				sharedExecutorState.client.dispose()
				sharedExecutorState = null
			}
		},
	}
}

export class AiCodeCommitPartialMatcherWorkerClient implements AiCodeCommitPartialMatcherExecutor {
	private readonly inlineMatcher = new AiCodeCommitPartialMatcher()
	private readonly blockBatchSize: number
	private readonly useWorkerThread: boolean
	private readonly requireFromHere = createRequire(__filename)
	private worker: Worker | null = null
	private fallbackToInline = false
	private disposed = false
	private activeRequestId: string | null = null
	private readonly pendingRequests = new Map<string, PendingWorkerRequest>()
	private queue: Promise<void> = Promise.resolve()
	private cancellationEpoch = 0

	constructor(options: AiCodeCommitPartialMatcherWorkerClientOptions = {}) {
		this.blockBatchSize = Math.max(1, options.blockBatchSize ?? 16)
		this.useWorkerThread = options.useWorkerThread ?? !process.env.AGENT_CONFIG
	}

	async matchPartialPendingBlocks(params: MatchPartialPendingBlocksParams): Promise<PartialBlockMatchResult[]> {
		if (this.disposed) {
			throw new PartialMatcherCancelledError()
		}

		const scheduledEpoch = this.cancellationEpoch
		return this.enqueue(async () => {
			if (scheduledEpoch !== this.cancellationEpoch || this.disposed) {
				throw new PartialMatcherCancelledError()
			}

			if (!this.useWorkerThread || this.fallbackToInline) {
				return this.inlineMatcher.matchPartialPendingBlocks(params)
			}

			try {
				return await this.executeWorkerRequest(params)
			} catch (error) {
				if (error instanceof PartialMatcherCancelledError) {
					throw error
				}

				this.fallbackToInline = true
				console.warn(
					"[AiCodeCommitAttribution] Falling back to inline partial matcher after worker failure:",
					error,
				)
				return this.inlineMatcher.matchPartialPendingBlocks(params)
			}
		})
	}

	cancelAll(): void {
		this.cancellationEpoch += 1
		if (this.worker && this.activeRequestId) {
			this.worker.postMessage({
				type: "cancel",
				requestId: this.activeRequestId,
			})
		}
	}

	dispose(): void {
		if (this.disposed) {
			return
		}

		this.disposed = true
		this.cancelAll()
		this.rejectAllPending(new PartialMatcherCancelledError())
		if (this.worker) {
			void this.worker.terminate()
			this.worker = null
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation)
		this.queue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	private async executeWorkerRequest(params: MatchPartialPendingBlocksParams): Promise<PartialBlockMatchResult[]> {
		const worker = this.ensureWorker()
		if (!worker) {
			return this.inlineMatcher.matchPartialPendingBlocks(params)
		}

		const requestId = randomUUID()
		const resultPromise = new Promise<PartialBlockMatchResult[]>((resolve, reject) => {
			this.pendingRequests.set(requestId, { resolve, reject })
		})

		this.activeRequestId = requestId
		worker.postMessage({
			type: "match",
			requestId,
			params: serializeMatchPartialPendingBlocksParams(params),
			blockBatchSize: this.blockBatchSize,
		})

		try {
			return await resultPromise
		} finally {
			this.pendingRequests.delete(requestId)
			if (this.activeRequestId === requestId) {
				this.activeRequestId = null
			}
		}
	}

	private ensureWorker(): Worker | null {
		if (this.worker) {
			return this.worker
		}
		if (!this.useWorkerThread || this.fallbackToInline || this.disposed) {
			return null
		}

		const workerEntry = this.resolveWorkerEntry()
		if (!workerEntry) {
			this.fallbackToInline = true
			return null
		}

		try {
			this.worker = new Worker(workerEntry.path, workerEntry.options)
			this.worker.on("message", (message: PartialMatcherWorkerResponse) => this.handleWorkerMessage(message))
			this.worker.on("error", (error) => this.handleWorkerFailure(error))
			this.worker.on("exit", (code) => {
				if (code !== 0 && !this.disposed) {
					this.handleWorkerFailure(
						new Error(`Partial matcher worker exited unexpectedly with code ${String(code)}`),
					)
				} else {
					this.worker = null
				}
			})
			return this.worker
		} catch (error) {
			this.fallbackToInline = true
			console.warn("[AiCodeCommitAttribution] Failed to start partial matcher worker:", error)
			return null
		}
	}

	private resolveWorkerEntry(): {
		path: string
		options?: ConstructorParameters<typeof Worker>[1]
	} | null {
		const distWorkerPath = path.join(__dirname, "..", "..", "workers", "aiCodeCommitPartialMatcherWorker.js")
		if (fs.existsSync(distWorkerPath)) {
			return { path: distWorkerPath }
		}

		const sourceWorkerPath = path.join(__dirname, "..", "..", "workers", "aiCodeCommitPartialMatcherWorker.ts")
		if (!fs.existsSync(sourceWorkerPath)) {
			return null
		}

		try {
			return {
				path: sourceWorkerPath,
				options: {
					execArgv: [
						"--import",
						this.requireFromHere.resolve("tsx"),
						"--experimental-specifier-resolution=node",
					],
				},
			}
		} catch (error) {
			console.warn("[AiCodeCommitAttribution] Failed to resolve tsx for partial matcher worker:", error)
			return null
		}
	}

	private handleWorkerMessage(message: PartialMatcherWorkerResponse): void {
		const pending = this.pendingRequests.get(message.requestId)
		if (!pending) {
			return
		}

		if (message.type === "result") {
			pending.resolve(deserializePartialBlockMatchResults(message.results))
			return
		}

		if (message.type === "cancelled") {
			pending.reject(new PartialMatcherCancelledError())
			return
		}

		pending.reject(new Error(message.error))
	}

	private handleWorkerFailure(error: unknown): void {
		if (this.disposed) {
			return
		}

		this.fallbackToInline = true
		if (this.worker) {
			void this.worker.terminate()
			this.worker = null
		}
		this.rejectAllPending(error instanceof Error ? error : new Error(String(error)))
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error)
		}
		this.pendingRequests.clear()
		this.activeRequestId = null
	}
}
