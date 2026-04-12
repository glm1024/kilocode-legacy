import { createPatch, parsePatch } from "diff"
import { AiCodeAddedCodeBlock, AiCodeCommitChangedBlock, AiCodePatchFile, AiCodePatchHunk } from "./types"

interface SemanticPatchHunk extends AiCodePatchHunk {
	lines: string[]
}

/**
 * Extract added code blocks (+ lines) from a unified diff between original and final content.
 */
export class AiCodeDiffExtractor {
	extractPatchHunks(originalContent: string, finalContent: string, filePath: string): AiCodePatchHunk[] {
		const patch = createPatch(
			filePath,
			this.normalizeEol(originalContent),
			this.normalizeEol(finalContent),
			undefined,
			undefined,
			{ context: 0 },
		)

		const parsed = parsePatch(patch)
		if (!parsed || parsed.length === 0) {
			return []
		}

		const hunks: AiCodePatchHunk[] = []
		for (const filePatch of parsed) {
			for (const hunk of filePatch.hunks || []) {
				hunks.push(
					...this.buildSemanticHunks(hunk.oldStart, hunk.newStart, hunk.lines || []).map((semanticHunk) => ({
						oldStart: semanticHunk.oldStart,
						oldLines: semanticHunk.oldLines,
						newStart: semanticHunk.newStart,
						newLines: semanticHunk.newLines,
					})),
				)
			}
		}

		return hunks
	}

	extractAddedBlocks(originalContent: string, finalContent: string, filePath: string): AiCodeAddedCodeBlock[] {
		const patch = createPatch(
			filePath,
			this.normalizeEol(originalContent),
			this.normalizeEol(finalContent),
			undefined,
			undefined,
			{ context: 0 },
		)

		const parsed = parsePatch(patch)
		if (!parsed || parsed.length === 0) {
			return []
		}

		const blocks: AiCodeAddedCodeBlock[] = []

		for (const filePatch of parsed) {
			for (const hunk of filePatch.hunks || []) {
				for (const semanticHunk of this.buildSemanticHunks(hunk.oldStart, hunk.newStart, hunk.lines || [])) {
					let newLineCursor = semanticHunk.newStart
					let currentBlock: { lineStart: number; lines: string[] } | null = null

					const flushCurrentBlock = () => {
						if (!currentBlock || currentBlock.lines.length === 0) {
							currentBlock = null
							return
						}

						const lineCount = currentBlock.lines.length
						blocks.push({
							lineStart: currentBlock.lineStart,
							lineEnd: currentBlock.lineStart + lineCount - 1,
							lineCount,
							codeSnippet: currentBlock.lines.join("\n"),
						})
						currentBlock = null
					}

					for (const diffLine of semanticHunk.lines) {
						if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
							if (!currentBlock) {
								currentBlock = { lineStart: newLineCursor, lines: [] }
							}
							currentBlock.lines.push(diffLine.slice(1))
							newLineCursor++
							continue
						}

						flushCurrentBlock()

						if (diffLine.startsWith(" ")) {
							newLineCursor++
						}
					}

					flushCurrentBlock()
				}
			}
		}

		return blocks
	}

	extractDeletedBlocks(originalContent: string, finalContent: string, filePath: string): AiCodeAddedCodeBlock[] {
		const patch = createPatch(
			filePath,
			this.normalizeEol(originalContent),
			this.normalizeEol(finalContent),
			undefined,
			undefined,
			{ context: 0 },
		)

		const parsed = parsePatch(patch)
		if (!parsed || parsed.length === 0) {
			return []
		}

		const blocks: AiCodeAddedCodeBlock[] = []

		for (const filePatch of parsed) {
			for (const hunk of filePatch.hunks || []) {
				for (const semanticHunk of this.buildSemanticHunks(hunk.oldStart, hunk.newStart, hunk.lines || [])) {
					if (semanticHunk.oldLines <= 0 || semanticHunk.newLines !== 0) {
						continue
					}

					const deletedLines = semanticHunk.lines
						.filter((diffLine) => diffLine.startsWith("-") && !diffLine.startsWith("---"))
						.map((diffLine) => diffLine.slice(1))
					if (deletedLines.length === 0) {
						continue
					}

					blocks.push({
						lineStart: semanticHunk.oldStart,
						lineEnd: semanticHunk.oldStart + deletedLines.length - 1,
						lineCount: deletedLines.length,
						codeSnippet: deletedLines.join("\n"),
					})
				}
			}
		}

		return blocks
	}

	extractAddedLinesFromPatch(patchContent: string): AiCodePatchFile[] {
		const parsed = parsePatch(patchContent)
		if (!parsed || parsed.length === 0) {
			return []
		}

		const files: AiCodePatchFile[] = []

		for (const filePatch of parsed) {
			const filePath = this.normalizePatchPath(filePatch.newFileName || filePatch.oldFileName)
			const previousFilePath = this.normalizePatchPath(filePatch.oldFileName)
			if (!filePath) {
				continue
			}

			const addedLines: AiCodePatchFile["addedLines"] = []
			const changedBlocks: AiCodeCommitChangedBlock[] = []
			let displayOrder = 1
			for (const hunk of filePatch.hunks || []) {
				for (const semanticHunk of this.buildSemanticHunks(hunk.oldStart, hunk.newStart, hunk.lines || [])) {
					let newLineCursor = semanticHunk.newStart
					let currentBlock: { startLine: number; lines: string[] } | null = null

					const flushCurrentBlock = () => {
						if (!currentBlock || currentBlock.lines.length === 0) {
							currentBlock = null
							return
						}
						const lineCount = currentBlock.lines.length
						changedBlocks.push({
							startLine: currentBlock.startLine,
							endLine: currentBlock.startLine + lineCount - 1,
							lineCount,
							codeSnippet: currentBlock.lines.join("\n"),
							displayOrder,
						})
						displayOrder += 1
						currentBlock = null
					}

					for (const diffLine of semanticHunk.lines) {
						if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
							addedLines.push({
								lineNumber: newLineCursor,
								content: diffLine.slice(1),
							})
							if (!currentBlock) {
								currentBlock = {
									startLine: newLineCursor,
									lines: [],
								}
							}
							currentBlock.lines.push(diffLine.slice(1))
							newLineCursor++
							continue
						}

						flushCurrentBlock()

						if (diffLine.startsWith(" ")) {
							newLineCursor++
						}
					}

					flushCurrentBlock()
				}
			}

			if (addedLines.length === 0) {
				continue
			}

			files.push({
				filePath,
				previousFilePath,
				addedLines,
				changedBlocks,
			})
		}

		return files
	}

	private normalizeEol(value: string): string {
		return value.replace(/\r\n/g, "\n")
	}

	private buildSemanticHunks(oldStart: number, newStart: number, rawLines: string[]): SemanticPatchHunk[] {
		const normalizedLines = this.normalizeHunkLines(rawLines)
		const semanticHunks: SemanticPatchHunk[] = []
		let currentHunk: SemanticPatchHunk | null = null
		let oldCursor = oldStart
		let newCursor = newStart

		const flushCurrentHunk = () => {
			if (!currentHunk || (currentHunk.oldLines === 0 && currentHunk.newLines === 0)) {
				currentHunk = null
				return
			}
			semanticHunks.push(currentHunk)
			currentHunk = null
		}

		for (const diffLine of normalizedLines) {
			if (diffLine.startsWith(" ")) {
				flushCurrentHunk()
				oldCursor++
				newCursor++
				continue
			}

			if (!currentHunk) {
				currentHunk = {
					oldStart: oldCursor,
					oldLines: 0,
					newStart: newCursor,
					newLines: 0,
					lines: [],
				}
			}

			currentHunk.lines.push(diffLine)
			if (diffLine.startsWith("-") && !diffLine.startsWith("---")) {
				currentHunk.oldLines++
				oldCursor++
				continue
			}
			if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
				currentHunk.newLines++
				newCursor++
			}
		}

		flushCurrentHunk()
		return semanticHunks
	}

	private normalizeHunkLines(rawLines: string[]): string[] {
		const normalizedLines: string[] = []

		for (let index = 0; index < rawLines.length; index += 1) {
			const diffLine = rawLines[index]
			if (diffLine.startsWith("\\")) {
				continue
			}

			if (diffLine.startsWith("-") && !diffLine.startsWith("---")) {
				const carryOverAddedIndex = this.findEofCarryOverAddedIndex(rawLines, index)
				if (carryOverAddedIndex >= 0) {
					normalizedLines.push(` ${diffLine.slice(1)}`)
					index = carryOverAddedIndex
					continue
				}
			}

			normalizedLines.push(diffLine)
		}

		return normalizedLines
	}

	private findEofCarryOverAddedIndex(rawLines: string[], removalIndex: number): number {
		let cursor = removalIndex + 1
		let sawNoNewlineMarker = false

		while (cursor < rawLines.length && rawLines[cursor].startsWith("\\")) {
			sawNoNewlineMarker = sawNoNewlineMarker || /No newline at end of file/i.test(rawLines[cursor])
			cursor += 1
		}

		const nextLine = rawLines[cursor]
		if (!sawNoNewlineMarker || !nextLine || !nextLine.startsWith("+") || nextLine.startsWith("+++")) {
			return -1
		}

		return nextLine.slice(1) === rawLines[removalIndex].slice(1) ? cursor : -1
	}

	private normalizePatchPath(value?: string): string | undefined {
		if (!value || value === "/dev/null") {
			return undefined
		}

		return value.replace(/^a\//, "").replace(/^b\//, "")
	}
}
