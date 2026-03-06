// kilocode_change - new file
import { describe, expect, it } from "vitest"

import { AiCodeDiffExtractor } from "../AiCodeDiffExtractor"

describe("AiCodeDiffExtractor", () => {
	it("extracts added lines for pure insertion", () => {
		const extractor = new AiCodeDiffExtractor()
		const blocks = extractor.extractAddedBlocks("const a = 1\n", "const a = 1\nconst b = 2\n", "test.ts")

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toEqual({
			lineStart: 2,
			lineEnd: 2,
			lineCount: 1,
			codeSnippet: "const b = 2",
		})
	})

	it("extracts added lines for replacements", () => {
		const extractor = new AiCodeDiffExtractor()
		const blocks = extractor.extractAddedBlocks("const a = 1\n", "const a = 2\n", "test.ts")

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toEqual({
			lineStart: 1,
			lineEnd: 1,
			lineCount: 1,
			codeSnippet: "const a = 2",
		})
	})

	it("extracts multiple added blocks", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = ["line1", "line2", "line3", "line4"].join("\n") + "\n"
		const next = ["line1", "line2", "insert-a", "line3", "line4", "insert-b", "insert-c"].join("\n") + "\n"

		const blocks = extractor.extractAddedBlocks(original, next, "test.ts")
		expect(blocks).toHaveLength(2)
		expect(blocks[0]).toEqual({
			lineStart: 3,
			lineEnd: 3,
			lineCount: 1,
			codeSnippet: "insert-a",
		})
		expect(blocks[1]).toEqual({
			lineStart: 6,
			lineEnd: 7,
			lineCount: 2,
			codeSnippet: "insert-b\ninsert-c",
		})
	})
})
