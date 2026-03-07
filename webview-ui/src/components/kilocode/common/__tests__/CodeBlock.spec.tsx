// kilocode_change - new file

import { act, render } from "@/utils/test-utils"

import CodeBlock from "../CodeBlock"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"chat:codeblock.tooltips.copy_code": "Copy code",
				"chat:codeblock.tooltips.expand": "Expand code block",
				"chat:codeblock.tooltips.collapse": "Collapse code block",
				"chat:codeblock.tooltips.enable_wrap": "Enable wrap",
				"chat:codeblock.tooltips.disable_wrap": "Disable wrap",
			}
			return translations[key] || key
		},
	}),
}))

vi.mock("shiki", () => ({
	bundledLanguages: {
		typescript: {},
		javascript: {},
		txt: {},
	},
}))

vi.mock("@src/utils/highlighter", () => {
	const mockHighlighter = {
		codeToHast: vi.fn().mockImplementation((code, options) => ({
			type: "element",
			tagName: "pre",
			properties: {},
			children: [
				{
					type: "element",
					tagName: "code",
					properties: { className: [`hljs`, `language-${options.lang}`] },
					children: [
						{
							type: "text",
							value: code,
						},
					],
				},
			],
		})),
	}

	return {
		normalizeLanguage: vi.fn((lang) => lang || "txt"),
		isLanguageLoaded: vi.fn().mockReturnValue(true),
		getHighlighter: vi.fn().mockResolvedValue(mockHighlighter),
	}
})

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({
		showCopyFeedback: false,
		copyWithFeedback: vi.fn(),
	}),
}))

describe("KiloCodeBlock", () => {
	it("applies preStyle via inline styles", async () => {
		const code = "const x = 1;"
		let container: HTMLElement

		await act(async () => {
			;({ container } = render(
				<CodeBlock
					source={code}
					language="typescript"
					preStyle={{ marginTop: "12px", backgroundColor: "rgb(1, 2, 3)" }}
				/>,
			))
		})

		expect(container!.firstElementChild?.firstElementChild).toHaveAttribute(
			"style",
			expect.stringContaining("margin-top: 12px"),
		)
		expect(container!.firstElementChild?.firstElementChild).toHaveAttribute(
			"style",
			expect.stringContaining("background-color: rgb(1, 2, 3)"),
		)
	})
})
