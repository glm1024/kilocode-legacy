import type { MatchPartialPendingBlocksParams, PartialBlockMatchResult } from "./AiCodeCommitPartialMatcher"

export interface SerializedPartialBlockMatchResult {
	matches: PartialBlockMatchResult["matches"]
	matchedLineIds: string[]
	matchedAddedLineIndexes: number[]
	avgLineScore: number
	equivalentLineCount: number
	matchDetail?: PartialBlockMatchResult["matchDetail"]
}

export type SerializedMatchPartialPendingBlocksParams = Omit<MatchPartialPendingBlocksParams, "matchedLineIds"> & {
	matchedLineIds: string[]
}

export interface PartialMatcherMatchRequest {
	type: "match"
	requestId: string
	params: SerializedMatchPartialPendingBlocksParams
	blockBatchSize?: number
}

export interface PartialMatcherCancelRequest {
	type: "cancel"
	requestId: string
}

export type PartialMatcherWorkerRequest = PartialMatcherMatchRequest | PartialMatcherCancelRequest

export interface PartialMatcherResultResponse {
	type: "result"
	requestId: string
	results: SerializedPartialBlockMatchResult[]
}

export interface PartialMatcherCancelledResponse {
	type: "cancelled"
	requestId: string
}

export interface PartialMatcherErrorResponse {
	type: "error"
	requestId: string
	error: string
}

export type PartialMatcherWorkerResponse =
	| PartialMatcherResultResponse
	| PartialMatcherCancelledResponse
	| PartialMatcherErrorResponse

export const serializeMatchPartialPendingBlocksParams = (
	params: MatchPartialPendingBlocksParams,
): SerializedMatchPartialPendingBlocksParams => ({
	...params,
	matchedLineIds: [...params.matchedLineIds],
})

export const deserializeMatchPartialPendingBlocksParams = (
	params: SerializedMatchPartialPendingBlocksParams,
): MatchPartialPendingBlocksParams => ({
	...params,
	matchedLineIds: new Set(params.matchedLineIds),
})

export const serializePartialBlockMatchResults = (
	results: PartialBlockMatchResult[],
): SerializedPartialBlockMatchResult[] =>
	results.map((result) => ({
		matches: result.matches,
		matchedLineIds: [...result.matchedLineIds],
		matchedAddedLineIndexes: [...result.matchedAddedLineIndexes],
		avgLineScore: result.avgLineScore,
		equivalentLineCount: result.equivalentLineCount,
		matchDetail: result.matchDetail,
	}))

export const deserializePartialBlockMatchResults = (
	results: SerializedPartialBlockMatchResult[],
): PartialBlockMatchResult[] =>
	results.map((result) => ({
		matches: result.matches,
		matchedLineIds: new Set(result.matchedLineIds),
		matchedAddedLineIndexes: new Set(result.matchedAddedLineIndexes),
		avgLineScore: result.avgLineScore,
		equivalentLineCount: result.equivalentLineCount,
		matchDetail: result.matchDetail,
	}))
