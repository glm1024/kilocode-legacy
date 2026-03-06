// kilocode_change - new file

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
				"settings:sections.statistics": "Statistics",
				"settings:statistics.tip":
					"This page is used to track AI-generated code line counts and supports historical data backfill.",
				"settings:statistics.webhook.label": "Upload Server URL",
				"settings:statistics.webhook.placeholder": "https://example.com/webhook",
				"settings:statistics.webhook.description":
					"Used to receive AI code statistics data. Once filled, scheduled automatic uploads will run.",
				"settings:statistics.generatedLines.label": "Generated Code Lines",
				"settings:statistics.generatedLines.empty": "No data yet",
				"settings:statistics.range.current": "This day",
				"settings:statistics.range.last3days": "Last 3 days",
				"settings:statistics.range.last7days": "This week",
				"settings:statistics.range.last30days": "This month",
				"settings:statistics.range.custom": "Custom range",
				"settings:statistics.range.all": "All",
				"settings:statistics.lastSuccessfulUpload.label": "Last successful upload time",
				"settings:statistics.lastSuccessfulUpload.empty": "No successful uploads yet",
				"settings:statistics.uploadTest.title": "Historical data backfill",
				"settings:statistics.uploadTest.description":
					"You can backfill historical data for the selected range. After the upload URL is configured, automatic uploads run daily at 13:00 local time.",
				"settings:statistics.uploadTest.button": "Backfill now",
				"settings:statistics.uploadTest.testing": "Backfilling...",
				"settings:statistics.uploadTest.success": "Backfill succeeded",
				"settings:statistics.uploadTest.failed": "Backfill failed",
				"settings:statistics.uploadTest.webhookRequired": "Please configure the upload server URL first.",
			}
			return translations[key] ?? key
		},
	}),
}))

vi.mock("@/components/ui", () => ({
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
	VSCodeButton: ({ children, onClick, disabled, "data-testid": dataTestId }: any) => (
		<button onClick={onClick} disabled={disabled} data-testid={dataTestId}>
			{children}
		</button>
	),
}))

const getPostMessageCallsByType = (type: string) =>
	(vscode.postMessage as any).mock.calls.map((args: any[]) => args[0]).filter((message: any) => message.type === type)

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

	it("renders range generated lines and last successful upload time", async () => {
		render(
			<StatisticsSettings aiCodeStatsWebhookUrl="https://hooks.example.com/ai" setCachedStateField={vi.fn()} />,
		)

		window.postMessage(
			{
				type: "aiCodeStatsSummaryResponse",
				values: {
					generatedLines: 12,
					lastSuccessfulUploadAt: 1_772_500_000_000,
				},
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("ai-code-stats-generated-lines")).toHaveTextContent("12")
			expect(screen.getByTestId("ai-code-stats-last-successful-upload").textContent).toContain("2026")
		})
	})

	it("runs manual upload test and refreshes summary on success", async () => {
		render(
			<StatisticsSettings aiCodeStatsWebhookUrl="https://hooks.example.com/ai" setCachedStateField={vi.fn()} />,
		)

		fireEvent.change(screen.getByTestId("ai-code-stats-upload-range-select"), { target: { value: "last7days" } })
		fireEvent.click(screen.getByTestId("ai-code-stats-upload-test-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "testAiCodeStatsUpload",
			values: {
				range: { type: "last7days" },
			},
		})

		window.postMessage(
			{
				type: "aiCodeStatsUploadTestResult",
				success: true,
				text: "ok",
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("ai-code-stats-upload-test-result")).toHaveTextContent("ok")
		})

		const summaryCalls = getPostMessageCallsByType("getAiCodeStatsSummary")
		expect(summaryCalls.length).toBeGreaterThanOrEqual(2)
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

	it("shows localized error when upload test is clicked without webhook url", async () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		fireEvent.click(screen.getByTestId("ai-code-stats-upload-test-button"))

		await waitFor(() => {
			expect(screen.getByTestId("ai-code-stats-upload-test-result")).toHaveTextContent(
				"Please configure the upload server URL first.",
			)
		})
		expect(getPostMessageCallsByType("testAiCodeStatsUpload")).toHaveLength(0)
	})
})
