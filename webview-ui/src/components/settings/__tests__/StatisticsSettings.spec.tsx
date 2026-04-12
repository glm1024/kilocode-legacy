import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"
import { StatisticsSettings } from "../StatisticsSettings"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:sections.statistics": "Coding Analysis",
				"settings:statistics.webhook.label": "Upload Server URL",
				"settings:statistics.webhook.placeholder": "e.g. http://100.7.132.102:8081",
				"settings:statistics.webhook.description":
					"Used to receive AI code statistics and token usage uploads. After you configure it, scheduled uploads will run and both ingest endpoints are validated on save.",
				"settings:statistics.userName.label": "Username",
				"settings:statistics.userName.placeholder": "e.g. Alice Zhang…",
				"settings:statistics.userName.description": "Please enter your real name.",
				"settings:statistics.analysis.label": "Analysis Range",
				"settings:statistics.customDate.startLabel": "Start Date",
				"settings:statistics.customDate.endLabel": "End Date",
				"settings:statistics.retentionRate.label": "Retention Rate",
				"settings:statistics.retentionRate.empty": "No data yet",
				"settings:statistics.retentionRate.tooltip": "Committed lines / accepted lines",
				"settings:statistics.retentionRate.ariaLabel": "Show retention rate details",
				"settings:statistics.generatedLines.label": "Generated Lines",
				"settings:statistics.generatedLines.empty": "No data yet",
				"settings:statistics.generatedLines.tooltip": "Total AI-generated code lines in the selected range",
				"settings:statistics.generatedLines.ariaLabel": "Show generated lines details",
				"settings:statistics.acceptedLines.label": "Accepted Lines",
				"settings:statistics.acceptedLines.empty": "No data yet",
				"settings:statistics.acceptedLines.tooltip": "Total AI code lines that were accepted",
				"settings:statistics.acceptedLines.ariaLabel": "Show accepted lines details",
				"settings:statistics.committedLines.label": "Committed Lines",
				"settings:statistics.committedLines.empty": "No data yet",
				"settings:statistics.committedLines.tooltip": "Total AI code lines that ultimately entered a commit",
				"settings:statistics.committedLines.ariaLabel": "Show committed lines details",
				"settings:statistics.adoptionRate.label": "Adoption Rate",
				"settings:statistics.adoptionRate.empty": "No data yet",
				"settings:statistics.adoptionRate.tooltip": "Accepted lines / generated lines",
				"settings:statistics.adoptionRate.ariaLabel": "Show adoption rate details",
				"settings:statistics.tokenUsage.label": "Token Usage",
				"settings:statistics.tokenUsage.empty": "No data yet",
				"settings:statistics.tokenUsage.tooltip":
					"Cumulative input, output, and total token usage in the selected range",
				"settings:statistics.tokenUsage.ariaLabel": "Show token usage details",
				"settings:statistics.tokenUsage.input": "Input",
				"settings:statistics.tokenUsage.output": "Output",
				"settings:statistics.tokenUsage.total": "Total Tokens",
				"settings:statistics.range.current": "This day",
				"settings:statistics.range.last7days": "This week",
				"settings:statistics.range.last30days": "This month",
				"settings:statistics.range.custom": "Custom range",
				"settings:statistics.range.all": "All",
			}
			return translations[key] ?? key
		},
	}),
}))

vi.mock("@/components/ui", () => ({
	Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onChange, placeholder, "data-testid": dataTestId }: any) => (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange({ target: { value: e.target.value } })}
			placeholder={placeholder}
			data-testid={dataTestId}
		/>
	),
	VSCodeDropdown: ({ value, onChange, children, "data-testid": dataTestId }: any) => (
		<select
			value={value}
			onChange={(e) => onChange({ target: { value: e.target.value } })}
			data-testid={dataTestId}>
			{children}
		</select>
	),
	VSCodeOption: ({ value, children }: any) => <option value={value}>{children}</option>,
}))

describe("StatisticsSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("requests summary on mount and updates webhook url", () => {
		const setCachedStateField = vi.fn()
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={setCachedStateField} />)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "getAiCodeStatsSummary",
			values: {
				range: { type: "current" },
			},
		})

		fireEvent.change(screen.getByTestId("ai-code-stats-webhook-url"), {
			target: { value: "https://hooks.example.com/ai" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsWebhookUrl", "https://hooks.example.com/ai")
	})

	// kilocode_change start
	it("renders and updates the user name field", () => {
		const setCachedStateField = vi.fn()
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsUserName="Alice"
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByTestId("ai-code-stats-user-name"), {
			target: { value: "Bob" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsUserName", "Bob")
		expect(screen.getByTestId("ai-code-stats-user-name-description")).toHaveTextContent(
			"Please enter your real name.",
		)
	})

	it("renders the user name field before the webhook field", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" aiCodeStatsUserName="" setCachedStateField={vi.fn()} />)

		const userNameInput = screen.getByTestId("ai-code-stats-user-name")
		const webhookInput = screen.getByTestId("ai-code-stats-webhook-url")

		expect(userNameInput.compareDocumentPosition(webhookInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})
	// kilocode_change end

	it("renders coding analysis metrics and token totals", async () => {
		render(
			<StatisticsSettings aiCodeStatsWebhookUrl="https://hooks.example.com/ai" setCachedStateField={vi.fn()} />,
		)

		window.postMessage(
			{
				type: "aiCodeStatsSummaryResponse",
				values: {
					generatedLines: 12,
					acceptedLines: 5.6,
					committedLines: 4,
					adoptionRate: 5.6 / 12,
					retentionRate: 4 / 5.6,
					inputTokens: 1200,
					outputTokens: 300,
					totalTokens: 1500,
				},
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("ai-code-stats-retention-rate")).toHaveTextContent("71.4%")
			expect(screen.getByTestId("ai-code-stats-accepted-lines")).toHaveTextContent("6")
			expect(screen.getByTestId("ai-code-stats-generated-lines")).toHaveTextContent("12")
			expect(screen.getByTestId("ai-code-stats-committed-lines")).toHaveTextContent("4")
			expect(screen.getByTestId("ai-code-stats-adoption-rate")).toHaveTextContent("46.7%")
			expect(screen.getByTestId("ai-code-stats-total-tokens")).toHaveTextContent("1,500")
			expect(screen.getByTestId("ai-code-stats-input-tokens")).toHaveTextContent("1,200")
			expect(screen.getByTestId("ai-code-stats-output-tokens")).toHaveTextContent("300")
		})
	})

	it("shows inline webhook validation error from save flow", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl="https://hooks.example.com/ai"
				setCachedStateField={vi.fn()}
				webhookValidationError="Webhook test failed"
			/>,
		)

		expect(screen.getByTestId("ai-code-stats-webhook-error")).toHaveTextContent("Webhook test failed")
	})

	it("renders token empty state when the selected range has no token usage", async () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		window.postMessage(
			{
				type: "aiCodeStatsSummaryResponse",
				values: {
					generatedLines: 0,
					acceptedLines: 0,
					committedLines: 0,
					adoptionRate: 0,
					retentionRate: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
				},
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("ai-code-stats-token-empty")).toHaveTextContent("No data yet")
		})
	})

	it("shows custom range date inputs when custom range is selected", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		fireEvent.change(screen.getByTestId("ai-code-stats-range-select"), {
			target: { value: "custom" },
		})

		expect(screen.getByTestId("ai-code-stats-custom-start")).toBeInTheDocument()
		expect(screen.getByTestId("ai-code-stats-custom-end")).toBeInTheDocument()
	})

	it("uses a compact two-column grid and a full-width token summary row", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		expect(screen.getByTestId("ai-code-stats-kpi-grid")).toHaveClass("min-[520px]:grid-cols-2")
		expect(screen.getByTestId("ai-code-stats-token-panel").parentElement).toHaveClass("min-[520px]:col-span-2")
	})

	it("renders token usage as a summary strip with grouped supporting metrics", async () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		window.postMessage(
			{
				type: "aiCodeStatsSummaryResponse",
				values: {
					generatedLines: 24,
					acceptedLines: 24,
					committedLines: 24,
					adoptionRate: 1,
					retentionRate: 1,
					inputTokens: 21758,
					outputTokens: 653,
					totalTokens: 22411,
				},
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("ai-code-stats-token-summary")).toBeInTheDocument()
			expect(screen.getByTestId("ai-code-stats-token-metrics")).toHaveClass("min-[640px]:border-l")
			expect(screen.getByTestId("ai-code-stats-total-tokens")).toHaveTextContent("22,411")
			expect(screen.getByTestId("ai-code-stats-input-tokens")).toHaveTextContent("21,758")
			expect(screen.getByTestId("ai-code-stats-output-tokens")).toHaveTextContent("653")
		})
	})

	it("does not render the removed historical backfill controls", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		expect(screen.queryByTestId("ai-code-stats-upload-range-select")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-upload-test-button")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-upload-test-result")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	})
})
