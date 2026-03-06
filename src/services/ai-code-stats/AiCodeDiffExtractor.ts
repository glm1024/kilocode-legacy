// kilocode_change - new file

import { createPatch, parsePatch } from "diff"
import { AiCodeAddedCodeBlock } from "./types"

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

	private normalizeEol(value: string): string {
		return value.replace(/\r\n/g, "\n")
	}
}
