import { parentPort } from "node:worker_threads"

import {
	AiCodeCommitPartialMatcher,
	PartialMatcherCancelledError,
} from "../services/ai-code-stats/AiCodeCommitPartialMatcher"
import {
	type PartialMatcherWorkerRequest,
	deserializeMatchPartialPendingBlocksParams,
	serializePartialBlockMatchResults,
} from "../services/ai-code-stats/AiCodeCommitPartialMatcherWorkerProtocol"

const matcher = new AiCodeCommitPartialMatcher()
const cancelledRequestIds = new Set<string>()

const waitForNextTurn = async (): Promise<void> => {
	await new Promise<void>((resolve) => {
		setImmediate(resolve)
	})
}

const sendMessage = (message: unknown): void => {
	parentPort?.postMessage(message)
}

const handleMatchRequest = async (request: Extract<PartialMatcherWorkerRequest, { type: "match" }>): Promise<void> => {
	try {
		const results = await matcher.matchPartialPendingBlocksBatched(
			deserializeMatchPartialPendingBlocksParams(request.params),
			{
				blockBatchSize: request.blockBatchSize,
				shouldCancel: () => cancelledRequestIds.has(request.requestId),
				onBatchComplete: async () => {
					if (cancelledRequestIds.has(request.requestId)) {
						throw new PartialMatcherCancelledError()
					}
					await waitForNextTurn()
				},
			},
		)

		if (cancelledRequestIds.has(request.requestId)) {
			sendMessage({
				type: "cancelled",
				requestId: request.requestId,
			})
			return
		}

		sendMessage({
			type: "result",
			requestId: request.requestId,
			results: serializePartialBlockMatchResults(results),
		})
	} catch (error) {
		if (error instanceof PartialMatcherCancelledError || cancelledRequestIds.has(request.requestId)) {
			sendMessage({
				type: "cancelled",
				requestId: request.requestId,
			})
			return
		}

		sendMessage({
			type: "error",
			requestId: request.requestId,
			error: error instanceof Error ? error.message : String(error),
		})
	} finally {
		cancelledRequestIds.delete(request.requestId)
	}
}

parentPort?.on("message", (request: PartialMatcherWorkerRequest) => {
	if (request.type === "cancel") {
		cancelledRequestIds.add(request.requestId)
		return
	}

	void handleMatchRequest(request)
})
