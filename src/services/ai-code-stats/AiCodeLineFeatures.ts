const KEYWORD_STOPLIST = new Set([
	"if",
	"else",
	"for",
	"while",
	"return",
	"def",
	"import",
	"from",
	"as",
	"with",
	"try",
	"except",
	"finally",
	"lambda",
	"yield",
	"none",
	"and",
	"or",
	"not",
	"in",
	"is",
	"pass",
	"break",
	"continue",
	"global",
	"nonlocal",
	"assert",
	"async",
	"await",
	"true",
	"false",
	"null",
	"undefined",
	"const",
	"let",
	"var",
	"function",
	"class",
	"public",
	"private",
	"protected",
	"static",
	"final",
	"void",
	"int",
	"string",
	"boolean",
	"this",
	"super",
])

const TOKEN_REGEX =
	/(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?:[A-Za-z_][A-Za-z0-9_]*)|(?:===|!==|==|!=|<=|>=|=>|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||<<|>>>|>>|::|->)|[{}()[\].,;:?<>+\-*/%=&|!^~]/g

const STRING_LITERAL_REGEX = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/
const NUMBER_LITERAL_REGEX = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)$/
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/
const MARKDOWN_PATH_REGEX = /\.mdx?$/i
const CJK_CHAR_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/

export type AiCodeTextLineKind = "comment" | "docstring" | "markdown"

type PythonTripleQuote = '"""' | "'''"

export interface AiCodeTextScanState {
	activeDocstringQuote?: PythonTripleQuote
	activeMarkdownFence?: string
	activeDocComment?: boolean
}

export interface AiCodeTextLineAnalysis {
	kind: AiCodeTextLineKind | "code"
	isTextLike: boolean
	strippedText: string
	textTokens: string[]
	textTerms: string[]
	nextState: AiCodeTextScanState
}

export interface AiCodeLineFeatures {
	rawLine: string
	normalizedLine: string
	normalizedTokenLine: string
	rareIdentifiers: string[]
}

export interface AiCodeLineSimilarityFeatures {
	normalizedTextSim: number
	tokenSequenceSim: number
	rareIdentifierJaccard: number
	lineScore: number
}

export const normalizeLineForFingerprint = (value: string): string => value.replace(/\r?\n$/, "").trim()

export const normalizeLineForSimilarity = (value: string): string =>
	normalizeLineForFingerprint(value).replace(/\s+/g, " ")

export const extractLineFeatures = (value: string): AiCodeLineFeatures => {
	const rawLine = value.replace(/\r?\n$/, "")
	const normalizedLine = normalizeLineForSimilarity(rawLine)
	const tokens = tokenizeLine(normalizedLine)
	const normalizedTokenLine = tokens.join(" ")
	const rareIdentifiers = collectRareIdentifiers(normalizedLine)

	return {
		rawLine,
		normalizedLine,
		normalizedTokenLine,
		rareIdentifiers,
	}
}

export const analyzeTextLikeLine = (
	value: string,
	options: {
		filePath?: string
		language?: string
		state?: AiCodeTextScanState
	} = {},
): AiCodeTextLineAnalysis => {
	const normalizedLine = normalizeLineForSimilarity(value)
	const trimmedLine = normalizedLine.trim()
	const nextState: AiCodeTextScanState = {
		activeDocstringQuote: options.state?.activeDocstringQuote,
		activeMarkdownFence: options.state?.activeMarkdownFence,
		activeDocComment: options.state?.activeDocComment,
	}

	if (!trimmedLine) {
		return {
			kind: "code",
			isTextLike: false,
			strippedText: "",
			textTokens: [],
			textTerms: [],
			nextState,
		}
	}

	if (isMarkdownPath(options.filePath)) {
		const fenceMarker = parseMarkdownFenceMarker(trimmedLine)
		if (nextState.activeMarkdownFence) {
			if (fenceMarker === nextState.activeMarkdownFence) {
				nextState.activeMarkdownFence = undefined
			}
			return {
				kind: "code",
				isTextLike: false,
				strippedText: "",
				textTokens: [],
				textTerms: [],
				nextState,
			}
		}
		if (fenceMarker) {
			nextState.activeMarkdownFence = fenceMarker
			return {
				kind: "code",
				isTextLike: false,
				strippedText: "",
				textTokens: [],
				textTerms: [],
				nextState,
			}
		}

		const strippedMarkdownText = stripMarkdownSyntax(trimmedLine)
		if (strippedMarkdownText) {
			return buildTextLineAnalysis("markdown", strippedMarkdownText, nextState)
		}
	}

	if (isPythonSource(options.filePath, options.language)) {
		const activeDocstringQuote = nextState.activeDocstringQuote
		if (activeDocstringQuote) {
			if (countOccurrences(trimmedLine, activeDocstringQuote) % 2 === 1) {
				nextState.activeDocstringQuote = undefined
			}
			return buildTextLineAnalysis(
				"docstring",
				stripDocstringSyntax(trimmedLine, activeDocstringQuote),
				nextState,
			)
		}

		const openingDocstringQuote = detectDocstringOpeningQuote(trimmedLine)
		if (openingDocstringQuote) {
			if (countOccurrences(trimmedLine, openingDocstringQuote) % 2 === 1) {
				nextState.activeDocstringQuote = openingDocstringQuote
			}
			return buildTextLineAnalysis(
				"docstring",
				stripDocstringSyntax(trimmedLine, openingDocstringQuote),
				nextState,
			)
		}
	}

	if (nextState.activeDocComment) {
		if (trimmedLine.includes("*/")) {
			nextState.activeDocComment = undefined
		}
		return buildTextLineAnalysis("docstring", stripSlashDocCommentSyntax(trimmedLine), nextState)
	}

	const slashDocComment = detectSlashDocComment(trimmedLine)
	if (slashDocComment) {
		if (slashDocComment.entersBlock) {
			nextState.activeDocComment = true
		}
		return buildTextLineAnalysis("docstring", slashDocComment.strippedText, nextState)
	}

	const strippedCommentText = stripCommentSyntax(trimmedLine)
	if (strippedCommentText) {
		return buildTextLineAnalysis("comment", strippedCommentText, nextState)
	}

	return {
		kind: "code",
		isTextLike: false,
		strippedText: "",
		textTokens: [],
		textTerms: [],
		nextState,
	}
}

export const computeLineSimilarity = (
	left: Pick<AiCodeLineFeatures, "normalizedLine" | "normalizedTokenLine" | "rareIdentifiers">,
	right: Pick<AiCodeLineFeatures, "normalizedLine" | "normalizedTokenLine" | "rareIdentifiers">,
): AiCodeLineSimilarityFeatures => {
	const normalizedTextSim = computeNormalizedEditSimilarity(left.normalizedLine, right.normalizedLine)
	const tokenSequenceSim = computeTokenSequenceSimilarity(left.normalizedTokenLine, right.normalizedTokenLine)
	const rareIdentifierJaccard = computeRareIdentifierJaccard(left.rareIdentifiers, right.rareIdentifiers)
	const lineScore = roundToFour(0.4 * normalizedTextSim + 0.4 * tokenSequenceSim + 0.2 * rareIdentifierJaccard)

	return {
		normalizedTextSim,
		tokenSequenceSim,
		rareIdentifierJaccard,
		lineScore,
	}
}

export const roundToFour = (value: number): number => Math.round(value * 10_000) / 10_000

const tokenizeLine = (value: string): string[] => {
	if (!value) {
		return []
	}

	const identifierMap = new Map<string, string>()
	let nextIdentifierIndex = 1
	const matches = value.match(TOKEN_REGEX) ?? []

	return matches.map((token) => {
		if (STRING_LITERAL_REGEX.test(token)) {
			return "STR"
		}
		if (NUMBER_LITERAL_REGEX.test(token)) {
			return "NUM"
		}
		if (!IDENTIFIER_REGEX.test(token)) {
			return token
		}

		const normalizedToken = token.toLowerCase()
		if (KEYWORD_STOPLIST.has(normalizedToken)) {
			return normalizedToken
		}

		let alias = identifierMap.get(token)
		if (!alias) {
			alias = `ID${nextIdentifierIndex}`
			nextIdentifierIndex += 1
			identifierMap.set(token, alias)
		}
		return alias
	})
}

export const tokenizeTextContent = (value: string): string[] => {
	if (!value) {
		return []
	}

	const tokens: string[] = []
	let index = 0
	while (index < value.length) {
		const char = value[index]!
		if (/\s/.test(char)) {
			index += 1
			continue
		}
		if (isAsciiAlphaNumeric(char)) {
			let end = index + 1
			while (end < value.length && isAsciiAlphaNumeric(value[end]!)) {
				end += 1
			}
			tokens.push(value.slice(index, end).toLowerCase())
			index = end
			continue
		}
		if (isCjkChar(char)) {
			let end = index + 1
			while (end < value.length && isCjkChar(value[end]!)) {
				end += 1
			}
			const segment = value.slice(index, end)
			if (segment.length === 1) {
				tokens.push(segment)
			} else {
				for (let tokenIndex = 0; tokenIndex < segment.length - 1; tokenIndex += 1) {
					tokens.push(segment.slice(tokenIndex, tokenIndex + 2))
				}
			}
			index = end
			continue
		}
		index += 1
	}

	return tokens
}

const collectRareIdentifiers = (value: string): string[] => {
	if (!value) {
		return []
	}

	const identifiers = new Set<string>()
	const matches = value.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
	for (const token of matches) {
		const normalizedToken = token.toLowerCase()
		if (normalizedToken.length < 3 || KEYWORD_STOPLIST.has(normalizedToken)) {
			continue
		}
		identifiers.add(normalizedToken)
	}

	return [...identifiers].sort((left, right) => left.localeCompare(right))
}

const buildTextLineAnalysis = (
	kind: AiCodeTextLineKind,
	strippedText: string,
	nextState: AiCodeTextScanState,
): AiCodeTextLineAnalysis => {
	const normalizedStrippedText = normalizeLineForSimilarity(strippedText)
	const textTokens = normalizedStrippedText ? tokenizeTextContent(normalizedStrippedText) : []
	if (!normalizedStrippedText || textTokens.length === 0) {
		return {
			kind,
			isTextLike: false,
			strippedText: "",
			textTokens: [],
			textTerms: [],
			nextState,
		}
	}

	const textTerms = [...new Set(textTokens)].sort((left, right) => left.localeCompare(right))
	return {
		kind,
		isTextLike: true,
		strippedText: normalizedStrippedText,
		textTokens,
		textTerms,
		nextState,
	}
}

const isMarkdownPath = (filePath: string | undefined): boolean => !!filePath && MARKDOWN_PATH_REGEX.test(filePath)

const isPythonSource = (filePath: string | undefined, language: string | undefined): boolean =>
	(filePath ? /\.py$/i.test(filePath) : false) || (language ?? "").toLowerCase() === "python"

const parseMarkdownFenceMarker = (trimmedLine: string): string | undefined => {
	const match = trimmedLine.match(/^(`{3,}|~{3,})/)
	return match?.[1]
}

const stripMarkdownSyntax = (trimmedLine: string): string => {
	let next = trimmedLine
	let changed = true
	while (changed) {
		changed = false
		const before = next
		next = next
			.replace(/^#{1,6}\s+/, "")
			.replace(/^>\s*/, "")
			.replace(/^([-+*])\s+\[(?: |x|X)\]\s+/, "")
			.replace(/^[-+*]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.trim()
		changed = next !== before
	}

	if (/^(?:[-*_]\s*){3,}$/.test(next)) {
		return ""
	}
	return next
}

const detectDocstringOpeningQuote = (trimmedLine: string): PythonTripleQuote | undefined => {
	if (trimmedLine.startsWith('"""')) {
		return '"""'
	}
	if (trimmedLine.startsWith("'''")) {
		return "'''"
	}
	return undefined
}

const stripDocstringSyntax = (trimmedLine: string, quote: PythonTripleQuote): string =>
	trimmedLine.split(quote).join(" ").trim()

const detectSlashDocComment = (trimmedLine: string): { strippedText: string; entersBlock: boolean } | undefined => {
	if (trimmedLine.startsWith("/**") || trimmedLine.startsWith("/*!")) {
		return {
			strippedText: stripSlashDocCommentSyntax(trimmedLine),
			entersBlock: !trimmedLine.includes("*/"),
		}
	}

	if (trimmedLine.startsWith("///") || trimmedLine.startsWith("//!")) {
		return {
			strippedText: trimmedLine.slice(3).trim(),
			entersBlock: false,
		}
	}

	return undefined
}

const stripSlashDocCommentSyntax = (trimmedLine: string): string =>
	trimmedLine
		.replace(/^\/\*\*!?/, "")
		.replace(/^\/\*!/, "")
		.replace(/^\*/, "")
		.replace(/\*\/$/g, "")
		.trim()

const stripCommentSyntax = (trimmedLine: string): string => {
	if (trimmedLine.startsWith("<!--")) {
		return trimmedLine.slice(4).replace(/-->$/g, "").trim()
	}
	if (trimmedLine.startsWith("-->")) {
		return trimmedLine.slice(3).trim()
	}
	if (trimmedLine.startsWith("//")) {
		return trimmedLine.slice(2).trim()
	}
	if (trimmedLine.startsWith("#")) {
		return trimmedLine.slice(1).trim()
	}
	if (trimmedLine.startsWith("/*")) {
		return trimmedLine.slice(2).replace(/\*\/$/g, "").trim()
	}
	if (trimmedLine.startsWith("*")) {
		return trimmedLine.slice(1).replace(/\*\/$/g, "").trim()
	}
	return ""
}

const isAsciiAlphaNumeric = (char: string): boolean => /^[A-Za-z0-9]$/.test(char)

const isCjkChar = (char: string): boolean => CJK_CHAR_REGEX.test(char)

const countOccurrences = (value: string, fragment: string): number => {
	if (!value || !fragment) {
		return 0
	}

	let count = 0
	let searchIndex = 0
	while (searchIndex <= value.length - fragment.length) {
		const nextIndex = value.indexOf(fragment, searchIndex)
		if (nextIndex < 0) {
			break
		}
		count += 1
		searchIndex = nextIndex + fragment.length
	}
	return count
}

const computeNormalizedEditSimilarity = (left: string, right: string): number => {
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

const computeTokenSequenceSimilarity = (left: string, right: string): number => {
	const leftTokens = left ? left.split(/\s+/).filter(Boolean) : []
	const rightTokens = right ? right.split(/\s+/).filter(Boolean) : []
	if (leftTokens.length === 0 && rightTokens.length === 0) {
		return 1
	}
	if (leftTokens.length === 0 || rightTokens.length === 0) {
		return 0
	}

	const lcsLength = computeLcsLength(leftTokens, rightTokens)
	const denominator = Math.max(leftTokens.length, rightTokens.length)
	return denominator === 0 ? 1 : roundToFour(lcsLength / denominator)
}

const computeRareIdentifierJaccard = (left: string[], right: string[]): number => {
	if (left.length === 0 || right.length === 0) {
		return 0
	}

	const leftSet = new Set(left)
	const rightSet = new Set(right)
	let intersection = 0
	for (const token of leftSet) {
		if (rightSet.has(token)) {
			intersection += 1
		}
	}
	const union = new Set([...leftSet, ...rightSet]).size
	return union === 0 ? 0 : roundToFour(intersection / union)
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

const computeLcsLength = (left: string[], right: string[]): number => {
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
