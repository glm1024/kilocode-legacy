import * as path from "path"

import {
	analyzeTextLikeLine,
	extractLineFeatures,
	roundToFour,
	tokenizeTextContent,
	type AiCodeTextScanState,
} from "./AiCodeLineFeatures"
import {
	normalizePath,
	type AiCodeCommitAttributionConfig,
	type AiCodeCommitLineMatchDetail,
	type AiCodeCommitMatchAdjustment,
	type AiCodeCommitMatchDetail,
	type AiCodeCommitMatchOverlapKind,
	type AiCodeCommitMatchStrategy,
	type AiCodePendingLineAttribution,
} from "./types"

export interface MatchedPendingLine {
	pendingLine: AiCodePendingLineAttribution
	lineNumber: number
	content: string
	filePath: string
	relativePath: string
	matchStrategy: AiCodeCommitMatchStrategy
	lineScore: number
	lineMatchDetail?: AiCodeCommitLineMatchDetail
}

export interface CommitAddedLine {
	index: number
	lineNumber: number
	content: string
}

export interface PendingBlockCandidate {
	blockId: string
	repoRelativePath: string
	filePath: string
	relativePath: string
	blockLineCount: number
	timestamp: number
	lines: PendingBlockLineCandidate[]
}

interface LineSimilarityProfile {
	normalizedLine: string
	normalizedLength: number
	tokenCount: number
	rareIdentifierCount: number
	normalizedTokens: string[]
	tokenHistogram: Map<string, number>
	charHistogram: Uint16Array
	rareIdentifiersSorted: string[]
	textProfile?: TextSimilarityProfile
	inlineCommentProfile?: TextSimilarityProfile
}

interface TextSimilarityProfile {
	kind: "comment" | "docstring" | "markdown"
	strippedText: string
	textLength: number
	textTokenCount: number
	textTokens: string[]
	textTokenHistogram: Map<string, number>
	textCharHistogram: Uint16Array
	textTermsSorted: string[]
	textTermCount: number
}

interface PendingBlockLineCandidate {
	pendingLine: AiCodePendingLineAttribution
	profile: LineSimilarityProfile
	isGenericLine: boolean
}

export interface AddedLineCandidate {
	addedOrder: number
	addedLine: CommitAddedLine
	features: ReturnType<typeof extractLineFeatures>
	profile: LineSimilarityProfile
}

export interface PartialBlockMatchResult {
	matches: MatchedPendingLine[]
	matchedLineIds: Set<string>
	matchedAddedLineIndexes: Set<number>
	avgLineScore: number
	equivalentLineCount: number
	matchDetail?: AiCodeCommitMatchDetail
}

export interface PartialLineCandidate {
	blockId: string
	pendingLine: AiCodePendingLineAttribution
	addedLine: CommitAddedLine
	lineScore: number
	lineMatchDetail: AiCodeCommitLineMatchDetail
	hasNeighborSupport: boolean
	supportStrength: number
	isGenericLine: boolean
}

interface CandidateScoreBreakdown {
	finalScore: number
	baseScore: number
	editSimilarity: number
	tokenSimilarity: number
	overlapSimilarity: number
	overlapKind: AiCodeCommitMatchOverlapKind
	adjustments: AiCodeCommitMatchAdjustment[]
}

interface PartialAlignmentEdge {
	id: number
	blockLineIndex: number
	addedOrder: number
	addedIndex: number
	lineScore: number
	lineMatchDetail: AiCodeCommitLineMatchDetail
	pendingLine: PendingBlockLineCandidate
	addedLine: AddedLineCandidate
}

interface PartialAlignmentState {
	scoreSum: number
	edgeId: number
	previousEdgeId: number
	pairCount: number
	lastAddedOrder: number
	ambiguous: boolean
}

export interface PartialAlignmentDebugStats {
	totalPairCount: number
	tokenLcsCount: number
	levenshteinCount: number
	positiveEdgeCount: number
	processedBlockCount: number
	denseFallbackBlockCount: number
}

export interface MatchPartialPendingBlocksParams {
	repoRoot: string
	filePath: string
	previousFilePath?: string
	addedLines: CommitAddedLine[]
	pendingLines: AiCodePendingLineAttribution[]
	matchedLineIds: Iterable<string>
	exactMatches?: MatchedPendingLine[]
	commitOccurredAt: number
	config: AiCodeCommitAttributionConfig
	debugStats?: PartialAlignmentDebugStats
}

export interface MatchPartialPendingBlocksBatchOptions {
	blockBatchSize?: number
	shouldCancel?: () => boolean
	onBatchComplete?: () => void | Promise<void>
}

export class PartialMatcherCancelledError extends Error {
	constructor() {
		super("Partial matcher work cancelled")
		this.name = "PartialMatcherCancelledError"
	}
}

const EMPTY_ALIGNMENT_STATE: PartialAlignmentState = {
	scoreSum: 0,
	edgeId: -1,
	previousEdgeId: -1,
	pairCount: 0,
	lastAddedOrder: -1,
	ambiguous: false,
}

const splitNormalizedTokens = (normalizedTokenLine: string): string[] =>
	normalizedTokenLine ? normalizedTokenLine.split(/\s+/).filter(Boolean) : []

const SAFE_SIMILARITY_SCALE = 10_000
const NON_ASCII_CHAR_BUCKET_INDEX = 128
const CHAR_HISTOGRAM_BUCKET_COUNT = NON_ASCII_CHAR_BUCKET_INDEX + 1
const INLINE_COMMENT_NEAR_MISS_MARGIN = 0.1

const ceilToFour = (value: number): number => {
	if (value <= 0) {
		return 0
	}
	if (value >= 1) {
		return 1
	}
	return Math.ceil(value * SAFE_SIMILARITY_SCALE - 1e-9) / SAFE_SIMILARITY_SCALE
}

const buildTokenHistogram = (tokens: string[]): Map<string, number> => {
	const histogram = new Map<string, number>()
	for (const token of tokens) {
		histogram.set(token, (histogram.get(token) ?? 0) + 1)
	}
	return histogram
}

const buildCharHistogram = (value: string): Uint16Array => {
	const histogram = new Uint16Array(CHAR_HISTOGRAM_BUCKET_COUNT)
	for (let index = 0; index < value.length; index += 1) {
		const charCode = value.charCodeAt(index)
		const bucketIndex = charCode < NON_ASCII_CHAR_BUCKET_INDEX ? charCode : NON_ASCII_CHAR_BUCKET_INDEX
		histogram[bucketIndex] += 1
	}
	return histogram
}

const buildSortedTerms = (values: Iterable<string>): string[] =>
	[...new Set(values)].sort((left, right) => left.localeCompare(right))

const buildTextSimilarityProfile = (
	kind: TextSimilarityProfile["kind"],
	strippedText: string,
	textTokens: string[] = tokenizeTextContent(strippedText),
	textTerms: Iterable<string> = textTokens,
): TextSimilarityProfile => {
	const textTermsSorted = buildSortedTerms(textTerms)
	return {
		kind,
		strippedText,
		textLength: strippedText.length,
		textTokenCount: textTokens.length,
		textTokens,
		textTokenHistogram: buildTokenHistogram(textTokens),
		textCharHistogram: buildCharHistogram(strippedText),
		textTermsSorted,
		textTermCount: textTermsSorted.length,
	}
}

const extractInlineCommentText = (normalizedLine: string): string => {
	let activeQuote: '"' | "'" | "`" | "" = ""
	let escaped = false
	for (let index = 0; index < normalizedLine.length; index += 1) {
		const current = normalizedLine[index]
		if (!current) {
			continue
		}
		if (activeQuote) {
			if (escaped) {
				escaped = false
				continue
			}
			if (current === "\\") {
				escaped = true
				continue
			}
			if (current === activeQuote) {
				activeQuote = ""
			}
			continue
		}
		if (current === '"' || current === "'" || current === "`") {
			activeQuote = current
			continue
		}
		if (current === "#") {
			return normalizedLine.slice(index + 1).trim()
		}
		if (current === "/" && normalizedLine[index + 1] === "/") {
			return normalizedLine.slice(index + 2).trim()
		}
	}
	return ""
}

const buildLineSimilarityProfile = (
	line: Pick<ReturnType<typeof extractLineFeatures>, "normalizedLine" | "normalizedTokenLine" | "rareIdentifiers">,
	textAnalysis?: ReturnType<typeof analyzeTextLikeLine>,
): LineSimilarityProfile => {
	const normalizedTokens = splitNormalizedTokens(line.normalizedTokenLine)
	const rareIdentifiersSorted = [...line.rareIdentifiers]
	const strippedText = textAnalysis?.isTextLike ? textAnalysis.strippedText : ""
	const inlineCommentText = !textAnalysis?.isTextLike ? extractInlineCommentText(line.normalizedLine) : ""
	return {
		normalizedLine: line.normalizedLine,
		normalizedLength: line.normalizedLine.length,
		tokenCount: normalizedTokens.length,
		rareIdentifierCount: rareIdentifiersSorted.length,
		normalizedTokens,
		tokenHistogram: buildTokenHistogram(normalizedTokens),
		charHistogram: buildCharHistogram(line.normalizedLine),
		rareIdentifiersSorted,
		textProfile:
			textAnalysis?.isTextLike && textAnalysis.kind !== "code" && strippedText
				? buildTextSimilarityProfile(
						textAnalysis.kind,
						strippedText,
						textAnalysis.textTokens,
						textAnalysis.textTerms,
					)
				: undefined,
		inlineCommentProfile: inlineCommentText ? buildTextSimilarityProfile("comment", inlineCommentText) : undefined,
	}
}

const computeRatioUpperBound = (left: number, right: number): number => {
	if (left === 0 && right === 0) {
		return 1
	}
	if (left === 0 || right === 0) {
		return 0
	}
	return ceilToFour(Math.min(left, right) / Math.max(left, right))
}

const computeTokenSequenceUpperBound = (left: LineSimilarityProfile, right: LineSimilarityProfile): number => {
	return computeTokenSequenceUpperBoundByHistogram(
		left.tokenCount,
		left.tokenHistogram,
		right.tokenCount,
		right.tokenHistogram,
	)
}

const computeTokenSequenceUpperBoundByHistogram = (
	leftCount: number,
	leftHistogram: Map<string, number>,
	rightCount: number,
	rightHistogram: Map<string, number>,
): number => {
	if (leftCount === 0 && rightCount === 0) {
		return 1
	}
	if (leftCount === 0 || rightCount === 0) {
		return 0
	}

	const [smaller, larger] =
		leftHistogram.size <= rightHistogram.size ? [leftHistogram, rightHistogram] : [rightHistogram, leftHistogram]
	let intersection = 0
	for (const [token, count] of smaller) {
		intersection += Math.min(count, larger.get(token) ?? 0)
	}

	return ceilToFour(intersection / Math.max(leftCount, rightCount))
}

const computeEditDistanceLowerBound = (left: LineSimilarityProfile, right: LineSimilarityProfile): number => {
	return computeEditDistanceLowerBoundByHistogram(
		left.normalizedLength,
		left.charHistogram,
		right.normalizedLength,
		right.charHistogram,
	)
}

const computeEditDistanceLowerBoundByHistogram = (
	leftLength: number,
	leftHistogram: Uint16Array,
	rightLength: number,
	rightHistogram: Uint16Array,
): number => {
	let histogramDistance = 0
	for (let index = 0; index < CHAR_HISTOGRAM_BUCKET_COUNT; index += 1) {
		histogramDistance += Math.abs(leftHistogram[index] - rightHistogram[index])
	}

	const charCountLowerBound = Math.ceil(histogramDistance / 2)
	return Math.max(Math.abs(leftLength - rightLength), charCountLowerBound)
}

const computeNormalizedEditSimilarityUpperBound = (
	left: LineSimilarityProfile,
	right: LineSimilarityProfile,
): number => {
	return computeNormalizedEditSimilarityUpperBoundByHistogram(
		left.normalizedLength,
		left.charHistogram,
		right.normalizedLength,
		right.charHistogram,
	)
}

const computeNormalizedEditSimilarityUpperBoundByHistogram = (
	leftLength: number,
	leftHistogram: Uint16Array,
	rightLength: number,
	rightHistogram: Uint16Array,
): number => {
	if (leftLength === 0 && rightLength === 0) {
		return 1
	}
	if (leftLength === 0 || rightLength === 0) {
		return 0
	}

	const maxLength = Math.max(leftLength, rightLength)
	const lowerBound = computeEditDistanceLowerBoundByHistogram(leftLength, leftHistogram, rightLength, rightHistogram)
	return ceilToFour(1 - lowerBound / maxLength)
}

const computeRareIdentifierJaccardExact = (left: LineSimilarityProfile, right: LineSimilarityProfile): number => {
	return computeSortedSetJaccardExact(
		left.rareIdentifiersSorted,
		left.rareIdentifierCount,
		right.rareIdentifiersSorted,
		right.rareIdentifierCount,
	)
}

const computeSortedSetJaccardExact = (
	leftItems: string[],
	leftCount: number,
	rightItems: string[],
	rightCount: number,
): number => {
	if (leftCount === 0 || rightCount === 0) {
		return 0
	}

	let leftIndex = 0
	let rightIndex = 0
	let intersection = 0
	while (leftIndex < leftItems.length && rightIndex < rightItems.length) {
		const leftToken = leftItems[leftIndex]
		const rightToken = rightItems[rightIndex]
		if (leftToken === rightToken) {
			intersection += 1
			leftIndex += 1
			rightIndex += 1
		} else if (leftToken < rightToken) {
			leftIndex += 1
		} else {
			rightIndex += 1
		}
	}

	const union = leftCount + rightCount - intersection
	return union === 0 ? 0 : roundToFour(intersection / union)
}

const computeTokenSequenceSimilarityExact = (left: LineSimilarityProfile, right: LineSimilarityProfile): number => {
	return computeTokenSequenceSimilarityExactByTokens(
		left.normalizedTokens,
		left.tokenCount,
		right.normalizedTokens,
		right.tokenCount,
	)
}

const computeTokenSequenceSimilarityExactByTokens = (
	leftTokens: string[],
	leftCount: number,
	rightTokens: string[],
	rightCount: number,
): number => {
	if (leftCount === 0 && rightCount === 0) {
		return 1
	}
	if (leftCount === 0 || rightCount === 0) {
		return 0
	}

	const lcsLength = computeTokenLcsLength(leftTokens, rightTokens)
	const denominator = Math.max(leftCount, rightCount)
	return denominator === 0 ? 1 : roundToFour(lcsLength / denominator)
}

const computeNormalizedEditSimilarityExact = (left: string, right: string): number => {
	if (!left && !right) {
		return 1
	}
	if (!left || !right) {
		return 0
	}

	const distance = computeLevenshteinDistance(left, right)
	const maxLength = Math.max(left.length, right.length)
	return maxLength === 0 ? 1 : roundToFour(1 - distance / maxLength)
}

const buildCandidateScoreBreakdown = (
	editSimilarity: number,
	tokenSimilarity: number,
	overlapSimilarity: number,
	overlapKind: AiCodeCommitMatchOverlapKind,
	adjustments: AiCodeCommitMatchAdjustment[] = [],
	finalScore?: number,
): CandidateScoreBreakdown => {
	const baseScore = roundToFour(0.4 * editSimilarity + 0.4 * tokenSimilarity + 0.2 * overlapSimilarity)
	return {
		finalScore: typeof finalScore === "number" ? roundToFour(finalScore) : baseScore,
		baseScore,
		editSimilarity: roundToFour(editSimilarity),
		tokenSimilarity: roundToFour(tokenSimilarity),
		overlapSimilarity: roundToFour(overlapSimilarity),
		overlapKind,
		adjustments: [...adjustments],
	}
}

const scoreTextSimilarityProfilePair = (
	left: TextSimilarityProfile | undefined,
	right: TextSimilarityProfile | undefined,
	config: AiCodeCommitAttributionConfig,
): CandidateScoreBreakdown | null => {
	if (!left || !right) {
		return null
	}

	const lengthTextUpperBound = computeRatioUpperBound(left.textLength, right.textLength)
	const termJaccardExact = computeSortedSetJaccardExact(
		left.textTermsSorted,
		left.textTermCount,
		right.textTermsSorted,
		right.textTermCount,
	)
	const tokenUpperBound = computeTokenSequenceUpperBoundByHistogram(
		left.textTokenCount,
		left.textTokenHistogram,
		right.textTokenCount,
		right.textTokenHistogram,
	)
	if (
		0.4 * lengthTextUpperBound + 0.4 * tokenUpperBound + 0.2 * termJaccardExact + 1e-9 <
		config.candidateMinLineScore
	) {
		return null
	}

	const tokenSequenceExact = computeTokenSequenceSimilarityExactByTokens(
		left.textTokens,
		left.textTokenCount,
		right.textTokens,
		right.textTokenCount,
	)
	if (termJaccardExact === 0 && tokenSequenceExact === 0 && Math.min(left.textTermCount, right.textTermCount) <= 1) {
		return null
	}
	if (
		0.4 * lengthTextUpperBound + 0.4 * tokenSequenceExact + 0.2 * termJaccardExact + 1e-9 <
		config.candidateMinLineScore
	) {
		return null
	}

	const editTextUpperBound = computeNormalizedEditSimilarityUpperBoundByHistogram(
		left.textLength,
		left.textCharHistogram,
		right.textLength,
		right.textCharHistogram,
	)
	if (
		0.4 * editTextUpperBound + 0.4 * tokenSequenceExact + 0.2 * termJaccardExact + 1e-9 <
		config.candidateMinLineScore
	) {
		return null
	}

	const strippedTextExact = computeNormalizedEditSimilarityExact(left.strippedText, right.strippedText)
	const breakdown = buildCandidateScoreBreakdown(strippedTextExact, tokenSequenceExact, termJaccardExact, "term")
	return breakdown.finalScore + 1e-9 < config.candidateMinLineScore ? null : breakdown
}

const adjustCodeLineScoreWithInlineComment = (
	breakdown: CandidateScoreBreakdown,
	left: LineSimilarityProfile,
	right: LineSimilarityProfile,
	config: AiCodeCommitAttributionConfig,
): CandidateScoreBreakdown => {
	const baseScore = breakdown.baseScore
	if (
		baseScore + 1e-9 >= config.candidateMinLineScore ||
		baseScore + INLINE_COMMENT_NEAR_MISS_MARGIN + 1e-9 < config.candidateMinLineScore
	) {
		return breakdown
	}
	if (breakdown.tokenSimilarity < 0.45 || breakdown.overlapSimilarity <= 0) {
		return breakdown
	}

	const inlineCommentBreakdown = scoreTextSimilarityProfilePair(
		left.inlineCommentProfile,
		right.inlineCommentProfile,
		config,
	)
	if (!inlineCommentBreakdown) {
		return breakdown
	}

	const finalScore = roundToFour(Math.max(baseScore, 0.8 * baseScore + 0.2 * inlineCommentBreakdown.finalScore))
	if (finalScore <= breakdown.finalScore) {
		return breakdown
	}

	return {
		...breakdown,
		finalScore,
		adjustments: [...breakdown.adjustments, "inline_comment_bonus"],
	}
}

const computeInlineCommentSimilarity = (
	left: TextSimilarityProfile | undefined,
	right: TextSimilarityProfile | undefined,
): number => {
	if (!left || !right) {
		return 0
	}
	return computeNormalizedEditSimilarityExact(left.strippedText, right.strippedText)
}

const buildLineMatchDetail = (
	breakdown: CandidateScoreBreakdown,
	committedLineNumber: number,
	generatedLineNumber: number,
): AiCodeCommitLineMatchDetail => ({
	committedLineNumber,
	generatedLineNumber,
	scoreSource: "attribution",
	finalScore: breakdown.finalScore,
	baseScore: breakdown.baseScore,
	editSimilarity: breakdown.editSimilarity,
	tokenSimilarity: breakdown.tokenSimilarity,
	overlapSimilarity: breakdown.overlapSimilarity,
	overlapKind: breakdown.overlapKind,
	adjustments: [...breakdown.adjustments],
})

const resolveGeneratedLineNumber = (pendingLine: PendingBlockLineCandidate): number => {
	const explicitLineNumber = (pendingLine.pendingLine as { lineStart?: unknown }).lineStart
	if (typeof explicitLineNumber === "number" && Number.isFinite(explicitLineNumber) && explicitLineNumber > 0) {
		return explicitLineNumber
	}

	const blockLineIndex = pendingLine.pendingLine.blockLineIndex
	if (typeof blockLineIndex === "number" && Number.isFinite(blockLineIndex) && blockLineIndex > 0) {
		return blockLineIndex
	}

	const occurrenceIndex = pendingLine.pendingLine.occurrenceIndex
	if (typeof occurrenceIndex === "number" && Number.isFinite(occurrenceIndex) && occurrenceIndex > 0) {
		return occurrenceIndex
	}

	return 1
}

const buildBlockMatchDetail = (lineDetails: AiCodeCommitLineMatchDetail[]): AiCodeCommitMatchDetail | undefined => {
	if (lineDetails.length === 0) {
		return undefined
	}

	const aggregate = lineDetails.reduce(
		(result, detail) => {
			result.finalScore += detail.finalScore
			result.baseScore += detail.baseScore
			result.editSimilarity += detail.editSimilarity
			result.tokenSimilarity += detail.tokenSimilarity
			result.overlapSimilarity += detail.overlapSimilarity
			for (const adjustment of detail.adjustments) {
				result.adjustments.add(adjustment)
			}
			return result
		},
		{
			finalScore: 0,
			baseScore: 0,
			editSimilarity: 0,
			tokenSimilarity: 0,
			overlapSimilarity: 0,
			adjustments: new Set<AiCodeCommitMatchAdjustment>(),
		},
	)
	const divisor = Math.max(lineDetails.length, 1)

	return {
		scoreSource: "attribution",
		finalScore: roundToFour(aggregate.finalScore / divisor),
		baseScore: roundToFour(aggregate.baseScore / divisor),
		editSimilarity: roundToFour(aggregate.editSimilarity / divisor),
		tokenSimilarity: roundToFour(aggregate.tokenSimilarity / divisor),
		overlapSimilarity: roundToFour(aggregate.overlapSimilarity / divisor),
		adjustments: [...aggregate.adjustments].sort((left, right) => left.localeCompare(right)),
		lineDetails: lineDetails.map((detail) => ({
			...detail,
			adjustments: [...detail.adjustments],
		})),
	}
}

const computeLevenshteinDistance = (left: string, right: string): number => {
	const previous = new Array<number>(right.length + 1).fill(0)
	for (let index = 0; index <= right.length; index += 1) {
		previous[index] = index
	}

	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		let diagonal = previous[0]
		previous[0] = leftIndex
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const temp = previous[rightIndex]
			const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
			previous[rightIndex] = Math.min(previous[rightIndex] + 1, previous[rightIndex - 1] + 1, diagonal + cost)
			diagonal = temp
		}
	}

	return previous[right.length]
}

const computeTokenLcsLength = (left: string[], right: string[]): number => {
	const previous = new Array<number>(right.length + 1).fill(0)
	const current = new Array<number>(right.length + 1).fill(0)

	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		current[0] = 0
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			if (left[leftIndex - 1] === right[rightIndex - 1]) {
				current[rightIndex] = previous[rightIndex - 1] + 1
			} else {
				current[rightIndex] = Math.max(previous[rightIndex], current[rightIndex - 1])
			}
		}

		for (let index = 0; index <= right.length; index += 1) {
			previous[index] = current[index]
		}
	}

	return previous[right.length]
}

const mergeAlignmentStates = (left: PartialAlignmentState, right: PartialAlignmentState): PartialAlignmentState => {
	if (left.edgeId < 0) {
		return right
	}
	if (right.edgeId < 0) {
		return left
	}
	if (right.scoreSum > left.scoreSum + 1e-9) {
		return right
	}
	if (left.scoreSum > right.scoreSum + 1e-9) {
		return left
	}
	if (right.pairCount > left.pairCount) {
		return right
	}
	if (left.pairCount > right.pairCount) {
		return left
	}
	if (right.lastAddedOrder > left.lastAddedOrder) {
		return right
	}
	if (left.lastAddedOrder > right.lastAddedOrder) {
		return left
	}

	if (left.edgeId === right.edgeId) {
		return {
			...left,
			ambiguous: left.ambiguous || right.ambiguous,
		}
	}

	return {
		...(right.edgeId > left.edgeId ? right : left),
		ambiguous: true,
	}
}

class PrefixMaxFenwick {
	private readonly tree: PartialAlignmentState[]

	constructor(size: number) {
		this.tree = Array.from({ length: size + 1 }, () => ({ ...EMPTY_ALIGNMENT_STATE }))
	}

	query(index: number): PartialAlignmentState {
		let cursor = Math.min(Math.max(index, 0), this.tree.length - 1)
		let best = { ...EMPTY_ALIGNMENT_STATE }
		while (cursor > 0) {
			best = mergeAlignmentStates(best, this.tree[cursor])
			cursor -= cursor & -cursor
		}
		return best
	}

	update(index: number, state: PartialAlignmentState): void {
		let cursor = index
		while (cursor < this.tree.length) {
			this.tree[cursor] = mergeAlignmentStates(this.tree[cursor], state)
			cursor += cursor & -cursor
		}
	}
}

const buildExactNeighborSupportKey = (blockId: string, blockLineIndex: number, lineNumber: number): string =>
	`${blockId}\u0000${blockLineIndex}\u0000${lineNumber}`

const incrementExactNeighborSupport = (supportCounts: Map<string, number>, key: string): void => {
	supportCounts.set(key, (supportCounts.get(key) ?? 0) + 1)
}

const buildExactNeighborSupportCounts = (exactMatches: MatchedPendingLine[] | undefined): Map<string, number> => {
	const supportCounts = new Map<string, number>()
	if (!exactMatches?.length) {
		return supportCounts
	}

	for (const exactMatch of exactMatches) {
		const blockId = exactMatch.pendingLine.blockId || exactMatch.pendingLine.generatedEventId
		const previousBlockLineIndex = exactMatch.pendingLine.blockLineIndex - 1
		const previousLineNumber = exactMatch.lineNumber - 1
		if (previousBlockLineIndex >= 1 && previousLineNumber >= 1) {
			incrementExactNeighborSupport(
				supportCounts,
				buildExactNeighborSupportKey(blockId, previousBlockLineIndex, previousLineNumber),
			)
		}

		const nextBlockLineIndex = exactMatch.pendingLine.blockLineIndex + 1
		const nextLineNumber = exactMatch.lineNumber + 1
		if (nextBlockLineIndex >= 1 && nextLineNumber >= 1) {
			incrementExactNeighborSupport(
				supportCounts,
				buildExactNeighborSupportKey(blockId, nextBlockLineIndex, nextLineNumber),
			)
		}
	}

	return supportCounts
}

const hasCodeSimilarityFeatures = (
	line: Pick<ReturnType<typeof extractLineFeatures>, "normalizedLine" | "normalizedTokenLine">,
): boolean => line.normalizedLine.length > 0 && line.normalizedTokenLine.length > 0

const hasTextSimilarityFeatures = (profile: TextSimilarityProfile | undefined): boolean =>
	!!profile && profile.strippedText.length > 0

const buildPendingBlockLineCandidates = (lines: AiCodePendingLineAttribution[]): PendingBlockLineCandidate[] => {
	let textScanState: AiCodeTextScanState | undefined = undefined
	const candidates: PendingBlockLineCandidate[] = []

	for (const pendingLine of lines) {
		const textAnalysis = analyzeTextLikeLine(pendingLine.rawLine, {
			filePath: pendingLine.repoRelativePath || pendingLine.relativePath || pendingLine.filePath,
			language: pendingLine.language,
			state: textScanState,
		})
		textScanState = textAnalysis.nextState
		const profile = buildLineSimilarityProfile(pendingLine, textAnalysis)
		if (!hasCodeSimilarityFeatures(pendingLine) && !hasTextSimilarityFeatures(profile.textProfile)) {
			continue
		}

		candidates.push({
			pendingLine,
			profile,
			isGenericLine: isGenericLineProfile(profile),
		})
	}

	return candidates
}

const isGenericLineProfile = (profile: LineSimilarityProfile): boolean => {
	if (profile.textProfile) {
		return profile.textProfile.textTokenCount > 0 && profile.textProfile.textTokenCount <= 2
	}
	return profile.rareIdentifierCount === 0 && profile.tokenCount > 0 && profile.tokenCount <= 4
}

export class AiCodeCommitPartialMatcher {
	buildPendingBlockCandidates(
		pendingLines: AiCodePendingLineAttribution[],
		matchedLineIds: Set<string>,
		currentFilePath: string,
		previousFilePath: string | undefined,
		commitOccurredAt: number,
	): PendingBlockCandidate[] {
		const lookupPaths = new Set([currentFilePath, previousFilePath].filter(Boolean) as string[])
		const candidates = new Map<string, PendingBlockCandidate>()

		for (const pendingLine of pendingLines) {
			if (matchedLineIds.has(pendingLine.id)) {
				continue
			}
			if (pendingLine.timestamp > commitOccurredAt) {
				continue
			}
			if (!lookupPaths.has(pendingLine.repoRelativePath)) {
				continue
			}

			const blockId = pendingLine.blockId || pendingLine.generatedEventId
			const existing = candidates.get(blockId)
			if (!existing) {
				candidates.set(blockId, {
					blockId,
					repoRelativePath: pendingLine.repoRelativePath,
					filePath: pendingLine.filePath,
					relativePath: currentFilePath,
					blockLineCount: Math.max(pendingLine.blockLineCount || 0, 1),
					timestamp: pendingLine.timestamp,
					lines: [],
				})
			}

			const candidate = candidates.get(blockId)!
			candidate.lines.push({
				pendingLine,
				profile: buildLineSimilarityProfile(pendingLine),
				isGenericLine: false,
			})
			candidate.timestamp = Math.min(candidate.timestamp, pendingLine.timestamp)
			candidate.blockLineCount = Math.max(candidate.blockLineCount, pendingLine.blockLineCount || 0)
		}

		return [...candidates.values()]
			.map((candidate) => ({
				...candidate,
				lines: buildPendingBlockLineCandidates(
					candidate.lines
						.map((lineCandidate) => lineCandidate.pendingLine)
						.slice()
						.sort(
							(left, right) =>
								left.blockLineIndex - right.blockLineIndex || left.id.localeCompare(right.id),
						),
				),
			}))
			.filter((candidate) => candidate.lines.length > 0)
	}

	buildAddedLineCandidates(
		addedLines: CommitAddedLine[],
		filePath?: string,
		language?: string,
	): AddedLineCandidate[] {
		let textScanState: AiCodeTextScanState | undefined = undefined
		return addedLines.flatMap((addedLine, addedOrder) => {
			const features = extractLineFeatures(addedLine.content)
			const textAnalysis = analyzeTextLikeLine(addedLine.content, {
				filePath,
				language,
				state: textScanState,
			})
			textScanState = textAnalysis.nextState
			const profile = buildLineSimilarityProfile(features, textAnalysis)
			if (!hasCodeSimilarityFeatures(features) && !hasTextSimilarityFeatures(profile.textProfile)) {
				return []
			}
			return {
				addedOrder,
				addedLine,
				features,
				profile,
			}
		})
	}

	alignPartialBlockCandidatesDenseReference(
		block: PendingBlockCandidate,
		addedLines: AddedLineCandidate[],
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
		exactNeighborSupportCounts?: Map<string, number>,
	): PartialLineCandidate[] {
		if (addedLines.length === 0 || block.lines.length === 0) {
			return []
		}

		const width = addedLines.length + 1
		const scoreIndex = (blockIndex: number, addedIndex: number) => blockIndex * width + addedIndex
		const pairIndex = (blockIndex: number, addedIndex: number) => blockIndex * addedLines.length + addedIndex
		const scores = new Float64Array((block.lines.length + 1) * width)
		const decisions = new Uint8Array((block.lines.length + 1) * width)
		const lineScores = new Float64Array(block.lines.length * addedLines.length)
		const lineDetails = new Map<number, AiCodeCommitLineMatchDetail>()

		for (let blockIndex = 1; blockIndex <= block.lines.length; blockIndex += 1) {
			const pendingLine = block.lines[blockIndex - 1]
			for (let addedIndex = 1; addedIndex <= addedLines.length; addedIndex += 1) {
				const addedLine = addedLines[addedIndex - 1]
				const scoreBreakdown = this.scorePartialCandidatePair(pendingLine, addedLine, config, debugStats)
				const score = scoreBreakdown?.finalScore ?? 0
				const currentPairIndex = pairIndex(blockIndex - 1, addedIndex - 1)
				lineScores[currentPairIndex] = score
				if (scoreBreakdown) {
					lineDetails.set(
						currentPairIndex,
						buildLineMatchDetail(
							scoreBreakdown,
							addedLine.addedLine.lineNumber,
							resolveGeneratedLineNumber(pendingLine),
						),
					)
				}

				const up = scores[scoreIndex(blockIndex - 1, addedIndex)]
				const left = scores[scoreIndex(blockIndex, addedIndex - 1)]
				const diagonal =
					score > 0 ? scores[scoreIndex(blockIndex - 1, addedIndex - 1)] + score : Number.NEGATIVE_INFINITY
				const currentIndex = scoreIndex(blockIndex, addedIndex)

				if (diagonal >= up && diagonal >= left) {
					scores[currentIndex] = diagonal
					decisions[currentIndex] = 3
				} else if (up >= left) {
					scores[currentIndex] = up
					decisions[currentIndex] = 1
				} else {
					scores[currentIndex] = left
					decisions[currentIndex] = 2
				}
			}
		}

		const alignedEdges: PartialAlignmentEdge[] = []
		let blockCursor = block.lines.length
		let addedCursor = addedLines.length
		while (blockCursor > 0 && addedCursor > 0) {
			const decision = decisions[scoreIndex(blockCursor, addedCursor)]
			if (decision === 3) {
				const score = lineScores[pairIndex(blockCursor - 1, addedCursor - 1)]
				if (score > 0) {
					const currentPairIndex = pairIndex(blockCursor - 1, addedCursor - 1)
					alignedEdges.push({
						id: -1,
						blockLineIndex: block.lines[blockCursor - 1].pendingLine.blockLineIndex,
						addedOrder: addedCursor - 1,
						addedIndex: addedLines[addedCursor - 1].addedLine.index,
						lineScore: score,
						lineMatchDetail: lineDetails.get(currentPairIndex)!,
						pendingLine: block.lines[blockCursor - 1],
						addedLine: addedLines[addedCursor - 1],
					})
				}
				blockCursor -= 1
				addedCursor -= 1
			} else if (decision === 1) {
				blockCursor -= 1
			} else {
				addedCursor -= 1
			}
		}

		alignedEdges.reverse()
		return this.buildPartialLineCandidatesFromEdges(block, alignedEdges, exactNeighborSupportCounts)
	}

	alignPartialBlockCandidates(
		block: PendingBlockCandidate,
		addedLines: AddedLineCandidate[],
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
		exactNeighborSupportCounts?: Map<string, number>,
	): PartialLineCandidate[] {
		if (addedLines.length === 0 || block.lines.length === 0) {
			return []
		}
		if (debugStats) {
			debugStats.processedBlockCount += 1
		}

		const sparseResult = this.alignPartialBlockCandidatesSparse(
			block,
			addedLines,
			config,
			debugStats,
			exactNeighborSupportCounts,
		)
		if (!sparseResult.ambiguousOptimalPath) {
			return sparseResult.candidates
		}

		if (debugStats) {
			debugStats.denseFallbackBlockCount += 1
		}
		return this.alignPartialBlockCandidatesDenseReference(
			block,
			addedLines,
			config,
			debugStats,
			exactNeighborSupportCounts,
		)
	}

	matchPartialPendingBlocks(params: MatchPartialPendingBlocksParams): PartialBlockMatchResult[] {
		const matchedLineIds =
			params.matchedLineIds instanceof Set ? params.matchedLineIds : new Set(params.matchedLineIds)
		return this.matchPartialPendingBlocksInternal(params, matchedLineIds)
	}

	async matchPartialPendingBlocksBatched(
		params: MatchPartialPendingBlocksParams,
		options: MatchPartialPendingBlocksBatchOptions = {},
	): Promise<PartialBlockMatchResult[]> {
		if (params.addedLines.length === 0) {
			return []
		}

		const matchedLineIds =
			params.matchedLineIds instanceof Set ? params.matchedLineIds : new Set(params.matchedLineIds)
		const currentFilePath = normalizePath(params.filePath)
		const previousPath = params.previousFilePath ? normalizePath(params.previousFilePath) : undefined
		const exactNeighborSupportCounts = buildExactNeighborSupportCounts(params.exactMatches)
		const blockCandidates = this.buildPendingBlockCandidates(
			params.pendingLines,
			matchedLineIds,
			currentFilePath,
			previousPath,
			params.commitOccurredAt,
		)
		if (blockCandidates.length === 0) {
			return []
		}

		const addedLineCandidates = this.buildAddedLineCandidates(params.addedLines, currentFilePath)
		const lineCandidates: PartialLineCandidate[] = []
		const blockBatchSize = Math.max(1, options.blockBatchSize ?? 16)

		for (let startIndex = 0; startIndex < blockCandidates.length; startIndex += blockBatchSize) {
			if (options.shouldCancel?.()) {
				throw new PartialMatcherCancelledError()
			}

			const blockBatch = blockCandidates.slice(startIndex, startIndex + blockBatchSize)
			for (const block of blockBatch) {
				lineCandidates.push(
					...this.alignPartialBlockCandidates(
						block,
						addedLineCandidates,
						params.config,
						params.debugStats,
						exactNeighborSupportCounts,
					),
				)
			}

			if (startIndex + blockBatchSize < blockCandidates.length && options.onBatchComplete) {
				await options.onBatchComplete()
			}
		}

		if (options.shouldCancel?.()) {
			throw new PartialMatcherCancelledError()
		}

		return this.buildPartialBlockMatchResults(params.repoRoot, currentFilePath, lineCandidates, params.config)
	}

	private matchPartialPendingBlocksInternal(
		params: MatchPartialPendingBlocksParams,
		matchedLineIds: Set<string>,
	): PartialBlockMatchResult[] {
		if (params.addedLines.length === 0) {
			return []
		}

		const currentFilePath = normalizePath(params.filePath)
		const previousPath = params.previousFilePath ? normalizePath(params.previousFilePath) : undefined
		const exactNeighborSupportCounts = buildExactNeighborSupportCounts(params.exactMatches)
		const blockCandidates = this.buildPendingBlockCandidates(
			params.pendingLines,
			matchedLineIds,
			currentFilePath,
			previousPath,
			params.commitOccurredAt,
		)
		if (blockCandidates.length === 0) {
			return []
		}

		const addedLineCandidates = this.buildAddedLineCandidates(params.addedLines, currentFilePath)
		const lineCandidates = blockCandidates.flatMap((block) =>
			this.alignPartialBlockCandidates(
				block,
				addedLineCandidates,
				params.config,
				params.debugStats,
				exactNeighborSupportCounts,
			),
		)
		if (lineCandidates.length === 0) {
			return []
		}

		return this.buildPartialBlockMatchResults(params.repoRoot, currentFilePath, lineCandidates, params.config)
	}

	private buildPartialBlockMatchResults(
		repoRoot: string,
		currentFilePath: string,
		lineCandidates: PartialLineCandidate[],
		config: AiCodeCommitAttributionConfig,
	): PartialBlockMatchResult[] {
		if (lineCandidates.length === 0) {
			return []
		}

		const candidatesByAddedLine = new Map<number, PartialLineCandidate[]>()
		for (const candidate of lineCandidates) {
			const existing = candidatesByAddedLine.get(candidate.addedLine.index) ?? []
			existing.push(candidate)
			candidatesByAddedLine.set(candidate.addedLine.index, existing)
		}

		const eligibleCandidates: PartialLineCandidate[] = []
		for (const candidates of candidatesByAddedLine.values()) {
			const rankedCandidates = candidates
				.slice()
				.sort((left, right) => this.comparePartialCandidates(left, right))
			const bestCandidate = rankedCandidates[0]
			if (!bestCandidate) {
				continue
			}

			const secondBestCandidate = rankedCandidates[1]
			if (secondBestCandidate && bestCandidate.lineScore - secondBestCandidate.lineScore < config.ambiguityGap) {
				continue
			}

			const passesThreshold = bestCandidate.isGenericLine
				? bestCandidate.hasNeighborSupport && bestCandidate.lineScore >= config.contextualMinLineScore
				: bestCandidate.lineScore >= config.isolatedMinLineScore ||
					(bestCandidate.hasNeighborSupport && bestCandidate.lineScore >= config.contextualMinLineScore)
			if (!passesThreshold) {
				continue
			}

			eligibleCandidates.push(bestCandidate)
		}

		if (eligibleCandidates.length === 0) {
			return []
		}

		const usedAddedLineIndexes = new Set<number>()
		const usedPendingLineIds = new Set<string>()
		const acceptedMatches = eligibleCandidates
			.slice()
			.sort((left, right) => this.comparePartialCandidates(left, right))
			.filter((candidate) => {
				if (
					usedAddedLineIndexes.has(candidate.addedLine.index) ||
					usedPendingLineIds.has(candidate.pendingLine.id)
				) {
					return false
				}
				usedAddedLineIndexes.add(candidate.addedLine.index)
				usedPendingLineIds.add(candidate.pendingLine.id)
				return true
			})

		const filePathAbsolute = normalizePath(path.join(repoRoot, currentFilePath))
		const resultsByBlock = new Map<string, PartialBlockMatchResult>()
		for (const acceptedMatch of acceptedMatches.sort(
			(left, right) => left.addedLine.lineNumber - right.addedLine.lineNumber,
		)) {
			const existing = resultsByBlock.get(acceptedMatch.blockId) ?? {
				matches: [],
				matchedLineIds: new Set<string>(),
				matchedAddedLineIndexes: new Set<number>(),
				avgLineScore: 0,
				equivalentLineCount: 0,
				matchDetail: undefined,
			}
			existing.matches.push({
				pendingLine: acceptedMatch.pendingLine,
				lineNumber: acceptedMatch.addedLine.lineNumber,
				content: acceptedMatch.addedLine.content,
				filePath: filePathAbsolute,
				relativePath: currentFilePath,
				matchStrategy: "partial",
				lineScore: acceptedMatch.lineScore,
				lineMatchDetail: acceptedMatch.lineMatchDetail,
			})
			existing.matchedLineIds.add(acceptedMatch.pendingLine.id)
			existing.matchedAddedLineIndexes.add(acceptedMatch.addedLine.index)
			existing.equivalentLineCount = roundToFour(existing.equivalentLineCount + acceptedMatch.lineScore)
			existing.avgLineScore = roundToFour(existing.equivalentLineCount / existing.matches.length)
			existing.matchDetail = buildBlockMatchDetail(
				existing.matches
					.map((match) => match.lineMatchDetail)
					.filter((detail): detail is AiCodeCommitLineMatchDetail => !!detail),
			)
			resultsByBlock.set(acceptedMatch.blockId, existing)
		}

		return [...resultsByBlock.values()]
	}

	private scorePartialCandidatePair(
		pendingLine: PendingBlockLineCandidate,
		addedLine: AddedLineCandidate,
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
	): CandidateScoreBreakdown | null {
		if (debugStats) {
			debugStats.totalPairCount += 1
		}

		const pendingTextProfile = pendingLine.profile.textProfile
		const addedTextProfile = addedLine.profile.textProfile
		if (pendingTextProfile && addedTextProfile) {
			if (debugStats) {
				debugStats.tokenLcsCount += 1
				debugStats.levenshteinCount += 1
			}
			const lineScoreBreakdown = scoreTextSimilarityProfilePair(pendingTextProfile, addedTextProfile, config)
			if (!lineScoreBreakdown) {
				return null
			}

			if (debugStats) {
				debugStats.positiveEdgeCount += 1
			}
			return lineScoreBreakdown
		}

		const lengthTextUpperBound = computeRatioUpperBound(
			pendingLine.profile.normalizedLength,
			addedLine.profile.normalizedLength,
		)
		const rareIdentifierExact = computeRareIdentifierJaccardExact(pendingLine.profile, addedLine.profile)
		const inlineCommentExact = computeInlineCommentSimilarity(
			pendingLine.profile.inlineCommentProfile,
			addedLine.profile.inlineCommentProfile,
		)
		const candidateMinScore =
			inlineCommentExact >= 0.9 && rareIdentifierExact > 0
				? Math.max(0, config.candidateMinLineScore - 0.05)
				: config.candidateMinLineScore
		const tokenUpperBound = computeTokenSequenceUpperBound(pendingLine.profile, addedLine.profile)
		if (0.4 * lengthTextUpperBound + 0.4 * tokenUpperBound + 0.2 * rareIdentifierExact + 1e-9 < candidateMinScore) {
			return null
		}

		if (debugStats) {
			debugStats.tokenLcsCount += 1
		}
		const tokenSequenceExact = computeTokenSequenceSimilarityExact(pendingLine.profile, addedLine.profile)
		if (
			0.4 * lengthTextUpperBound + 0.4 * tokenSequenceExact + 0.2 * rareIdentifierExact + 1e-9 <
			candidateMinScore
		) {
			return null
		}

		const editTextUpperBound = computeNormalizedEditSimilarityUpperBound(pendingLine.profile, addedLine.profile)
		if (
			0.4 * editTextUpperBound + 0.4 * tokenSequenceExact + 0.2 * rareIdentifierExact + 1e-9 <
			candidateMinScore
		) {
			return null
		}

		if (debugStats) {
			debugStats.levenshteinCount += 1
		}
		const normalizedTextExact = computeNormalizedEditSimilarityExact(
			pendingLine.pendingLine.normalizedLine,
			addedLine.features.normalizedLine,
		)
		const lineScore = adjustCodeLineScoreWithInlineComment(
			buildCandidateScoreBreakdown(normalizedTextExact, tokenSequenceExact, rareIdentifierExact, "identifier"),
			pendingLine.profile,
			addedLine.profile,
			config,
		)
		if (rareIdentifierExact === 0 && inlineCommentExact === 0 && normalizedTextExact < 0.75) {
			return null
		}
		if (lineScore.finalScore + 1e-9 < candidateMinScore) {
			return null
		}

		if (debugStats) {
			debugStats.positiveEdgeCount += 1
		}
		return lineScore
	}

	private buildPositivePartialAlignmentEdges(
		block: PendingBlockCandidate,
		addedLines: AddedLineCandidate[],
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
	): PartialAlignmentEdge[] {
		const edges: PartialAlignmentEdge[] = []
		let edgeId = 0

		for (const pendingLine of block.lines) {
			for (const addedLine of addedLines) {
				const lineScore = this.scorePartialCandidatePair(pendingLine, addedLine, config, debugStats)
				if (!lineScore) {
					continue
				}

				edges.push({
					id: edgeId,
					blockLineIndex: pendingLine.pendingLine.blockLineIndex,
					addedOrder: addedLine.addedOrder,
					addedIndex: addedLine.addedLine.index,
					lineScore: lineScore.finalScore,
					lineMatchDetail: buildLineMatchDetail(
						lineScore,
						addedLine.addedLine.lineNumber,
						resolveGeneratedLineNumber(pendingLine),
					),
					pendingLine,
					addedLine,
				})
				edgeId += 1
			}
		}

		return edges
	}

	private buildPartialLineCandidatesFromEdges(
		block: PendingBlockCandidate,
		alignedEdges: PartialAlignmentEdge[],
		exactNeighborSupportCounts?: Map<string, number>,
	): PartialLineCandidate[] {
		if (alignedEdges.length === 0) {
			return []
		}

		return alignedEdges.map((edge, index) => {
			const previousEdge = alignedEdges[index - 1]
			const nextEdge = alignedEdges[index + 1]
			const hasPreviousSupport =
				!!previousEdge &&
				previousEdge.blockLineIndex + 1 === edge.blockLineIndex &&
				previousEdge.addedIndex + 1 === edge.addedIndex
			const hasNextSupport =
				!!nextEdge &&
				edge.blockLineIndex + 1 === nextEdge.blockLineIndex &&
				edge.addedIndex + 1 === nextEdge.addedIndex
			const exactSupportStrength =
				exactNeighborSupportCounts?.get(
					buildExactNeighborSupportKey(
						block.blockId,
						edge.pendingLine.pendingLine.blockLineIndex,
						edge.addedLine.addedLine.lineNumber,
					),
				) ?? 0
			const supportStrength = Number(hasPreviousSupport) + Number(hasNextSupport) + exactSupportStrength

			return {
				blockId: block.blockId,
				pendingLine: edge.pendingLine.pendingLine,
				addedLine: edge.addedLine.addedLine,
				lineScore: edge.lineScore,
				lineMatchDetail: edge.lineMatchDetail,
				hasNeighborSupport: supportStrength > 0,
				supportStrength,
				isGenericLine: edge.pendingLine.isGenericLine,
			}
		})
	}

	private alignPartialBlockCandidatesSparse(
		block: PendingBlockCandidate,
		addedLines: AddedLineCandidate[],
		config: AiCodeCommitAttributionConfig,
		debugStats?: PartialAlignmentDebugStats,
		exactNeighborSupportCounts?: Map<string, number>,
	): { candidates: PartialLineCandidate[]; ambiguousOptimalPath: boolean } {
		const edges = this.buildPositivePartialAlignmentEdges(block, addedLines, config, debugStats)
		if (edges.length === 0) {
			return { candidates: [], ambiguousOptimalPath: false }
		}

		const addedOrderLimit = addedLines.reduce((max, line) => Math.max(max, line.addedOrder + 1), 0)
		const fenwick = new PrefixMaxFenwick(addedOrderLimit)
		const edgeStates = new Map<number, PartialAlignmentState>()
		let ambiguousOptimalPath = false
		let edgeCursor = 0

		while (edgeCursor < edges.length) {
			const currentBlockLineIndex = edges[edgeCursor].blockLineIndex
			const pendingUpdates: Array<{ treeIndex: number; state: PartialAlignmentState }> = []
			while (edgeCursor < edges.length && edges[edgeCursor].blockLineIndex === currentBlockLineIndex) {
				const edge = edges[edgeCursor]
				const previousState = fenwick.query(edge.addedOrder)
				if (previousState.ambiguous) {
					ambiguousOptimalPath = true
				}
				const nextState: PartialAlignmentState = {
					scoreSum: previousState.scoreSum + edge.lineScore,
					edgeId: edge.id,
					previousEdgeId: previousState.edgeId,
					pairCount: previousState.pairCount + 1,
					lastAddedOrder: edge.addedOrder,
					ambiguous: previousState.ambiguous,
				}
				edgeStates.set(edge.id, nextState)
				pendingUpdates.push({
					treeIndex: edge.addedOrder + 1,
					state: nextState,
				})
				edgeCursor += 1
			}

			for (const update of pendingUpdates) {
				fenwick.update(update.treeIndex, update.state)
			}
		}

		const bestState = fenwick.query(addedOrderLimit)
		if (bestState.edgeId < 0) {
			return { candidates: [], ambiguousOptimalPath }
		}
		if (bestState.ambiguous) {
			ambiguousOptimalPath = true
		}
		if (ambiguousOptimalPath) {
			return { candidates: [], ambiguousOptimalPath: true }
		}

		const edgesById = new Map(edges.map((edge) => [edge.id, edge]))
		const alignedEdges: PartialAlignmentEdge[] = []
		let currentEdgeId = bestState.edgeId
		while (currentEdgeId >= 0) {
			const edge = edgesById.get(currentEdgeId)
			const state = edgeStates.get(currentEdgeId)
			if (!edge || !state) {
				break
			}
			alignedEdges.push(edge)
			currentEdgeId = state.previousEdgeId
		}
		alignedEdges.reverse()

		return {
			candidates: this.buildPartialLineCandidatesFromEdges(block, alignedEdges, exactNeighborSupportCounts),
			ambiguousOptimalPath: false,
		}
	}

	comparePartialCandidates(left: PartialLineCandidate, right: PartialLineCandidate): number {
		if (left.lineScore !== right.lineScore) {
			return right.lineScore - left.lineScore
		}
		if (left.supportStrength !== right.supportStrength) {
			return right.supportStrength - left.supportStrength
		}
		if (left.pendingLine.timestamp !== right.pendingLine.timestamp) {
			return left.pendingLine.timestamp - right.pendingLine.timestamp
		}
		return left.pendingLine.id.localeCompare(right.pendingLine.id)
	}
}
