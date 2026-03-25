import { createPatch, parsePatch } from "diff"
import { AiCodeAddedCodeBlock, AiCodePatchFile } from "./types"

/**
 * Extract added code blocks (+ lines) from a unified diff between original and final content.
 */
export class AiCodeDiffExtractor {
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
				let newLineCursor = hunk.newStart
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

				for (const diffLine of hunk.lines || []) {
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
			for (const hunk of filePatch.hunks || []) {
				let newLineCursor = hunk.newStart
				for (const diffLine of hunk.lines || []) {
					if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
						addedLines.push({
							lineNumber: newLineCursor,
							content: diffLine.slice(1),
						})
						newLineCursor++
						continue
					}

					if (diffLine.startsWith(" ")) {
						newLineCursor++
					}
				}
			}

			if (addedLines.length === 0) {
				continue
			}

			files.push({
				filePath,
				previousFilePath,
				addedLines,
			})
		}

		return files
	}

	private normalizeEol(value: string): string {
		return value.replace(/\r\n/g, "\n")
	}

	private normalizePatchPath(value?: string): string | undefined {
		if (!value || value === "/dev/null") {
			return undefined
		}

		return value.replace(/^a\//, "").replace(/^b\//, "")
	}
}
