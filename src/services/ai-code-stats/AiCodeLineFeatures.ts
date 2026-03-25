const KEYWORD_STOPLIST = new Set([
	"if",
	"else",
	"for",
	"while",
	"return",
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
