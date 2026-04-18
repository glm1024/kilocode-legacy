import { fireEvent, render, screen } from "@/utils/test-utils"

import { StatisticsSettings } from "../StatisticsSettings"

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
				"settings:statistics.userName.placeholder": "e.g. Alice Zhang...",
				"settings:statistics.userName.description": "Please enter your real name.",
			}
			return translations[key] ?? key
		},
	}),
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
}))

describe("StatisticsSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("updates the webhook url", () => {
		const setCachedStateField = vi.fn()
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={setCachedStateField} />)

		fireEvent.change(screen.getByTestId("ai-code-stats-webhook-url"), {
			target: { value: "https://hooks.example.com/ai" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsWebhookUrl", "https://hooks.example.com/ai")
	})

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

	it("does not render local analysis metrics", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		expect(screen.queryByTestId("ai-code-stats-range-select")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-kpi-grid")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-token-panel")).not.toBeInTheDocument()
	})
})
