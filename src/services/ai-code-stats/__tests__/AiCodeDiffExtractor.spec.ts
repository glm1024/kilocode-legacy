// kilocode_change - new file
import { describe, expect, it } from "vitest"
import { createPatch } from "diff"

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

	it("ignores eof carry-over lines when appending content without a trailing newline", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = "a\nline2"
		const next = ["a", "line2", "new1", "new2"].join("\n")

		expect(extractor.extractPatchHunks(original, next, "test.ts")).toEqual([
			{
				oldStart: 3,
				oldLines: 0,
				newStart: 3,
				newLines: 2,
			},
		])
		expect(extractor.extractAddedBlocks(original, next, "test.ts")).toEqual([
			{
				lineStart: 3,
				lineEnd: 4,
				lineCount: 2,
				codeSnippet: "new1\nnew2",
			},
		])

		const files = extractor.extractAddedLinesFromPatch(
			createPatch("test.ts", original, next, "", "", { context: 0 }),
		)
		expect(files).toHaveLength(1)
		expect(files[0].addedLines).toEqual([
			{ lineNumber: 3, content: "new1" },
			{ lineNumber: 4, content: "new2" },
		])
		expect(files[0].changedBlocks).toEqual([
			{
				startLine: 3,
				endLine: 4,
				lineCount: 2,
				codeSnippet: "new1\nnew2",
				displayOrder: 1,
			},
		])
	})

	it("ignores eof carry-over lines when appending a comment without a trailing newline", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = ["def f():", "    return 1"].join("\n")
		const next = ["def f():", "    return 1", "# tail"].join("\n")

		expect(extractor.extractAddedBlocks(original, next, "test.py")).toEqual([
			{
				lineStart: 3,
				lineEnd: 3,
				lineCount: 1,
				codeSnippet: "# tail",
			},
		])
	})

	it("does not create semantic additions when only a trailing newline is introduced", () => {
		const extractor = new AiCodeDiffExtractor()

		expect(extractor.extractPatchHunks("a\nline2", "a\nline2\n", "test.ts")).toEqual([])
		expect(extractor.extractAddedBlocks("a\nline2", "a\nline2\n", "test.ts")).toEqual([])
		expect(
			extractor.extractAddedLinesFromPatch(
				createPatch("test.ts", "a\nline2", "a\nline2\n", "", "", { context: 0 }),
			),
		).toEqual([])
	})

	it("extracts deleted blocks for pure deletions with old-file line numbers", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = ["keep1", "old1", "old2", "keep2"].join("\n") + "\n"
		const next = ["keep1", "keep2"].join("\n") + "\n"

		const blocks = extractor.extractDeletedBlocks(original, next, "test.ts")
		expect(blocks).toEqual([
			{
				lineStart: 2,
				lineEnd: 3,
				lineCount: 2,
				codeSnippet: "old1\nold2",
			},
		])
	})

	it("extracts old-side deleted blocks for replacements", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = ["keep1", "old", "keep2"].join("\n") + "\n"
		const next = ["keep1", "new", "keep2"].join("\n") + "\n"

		expect(extractor.extractDeletedBlocks(original, next, "test.ts")).toEqual([
			{
				lineStart: 2,
				lineEnd: 2,
				lineCount: 1,
				codeSnippet: "old",
			},
		])
	})

	it("does not extract deleted blocks when only a trailing newline changes", () => {
		const extractor = new AiCodeDiffExtractor()
		expect(extractor.extractDeletedBlocks("a\nline2\n", "a\nline2", "test.ts")).toEqual([])
		expect(extractor.extractDeletedBlocks("a\nline2", "a\nline2", "test.ts")).toEqual([])
	})

	it("extracts deleted lines from patches with old-side line numbers", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = ["keep1", "old1", "old2", "keep2"].join("\n") + "\n"
		const next = ["keep1", "keep2"].join("\n") + "\n"

		const files = extractor.extractAddedLinesFromPatch(
			createPatch("test.ts", original, next, "", "", { context: 0 }),
		)
		expect(files).toHaveLength(1)
		expect(files[0].addedLines).toEqual([])
		expect(files[0].deletedLines).toEqual([
			{ lineNumber: 2, content: "old1" },
			{ lineNumber: 3, content: "old2" },
		])
	})

	it("extracts both added and deleted lines for replacements in patches", () => {
		const extractor = new AiCodeDiffExtractor()
		const original = ["keep1", "old", "keep2"].join("\n") + "\n"
		const next = ["keep1", "new", "keep2"].join("\n") + "\n"

		const files = extractor.extractAddedLinesFromPatch(
			createPatch("test.ts", original, next, "", "", { context: 0 }),
		)
		expect(files).toHaveLength(1)
		expect(files[0].addedLines).toEqual([{ lineNumber: 2, content: "new" }])
		expect(files[0].deletedLines).toEqual([{ lineNumber: 2, content: "old" }])
	})

	it("keeps replacements on the last line semantic even without a trailing newline", () => {
		const extractor = new AiCodeDiffExtractor()

		expect(extractor.extractPatchHunks("a\nline2", "a\nlineX", "test.ts")).toEqual([
			{
				oldStart: 2,
				oldLines: 1,
				newStart: 2,
				newLines: 1,
			},
		])
		expect(extractor.extractAddedBlocks("a\nline2", "a\nlineX", "test.ts")).toEqual([
			{
				lineStart: 2,
				lineEnd: 2,
				lineCount: 1,
				codeSnippet: "lineX",
			},
		])
	})
})
