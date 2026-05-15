import { fireEvent, render, screen } from "@/utils/test-utils"

import {
	STATISTICS_DEPARTMENT_OPTIONS,
	StatisticsSettings,
	getStatisticsIdentityValidationKey,
	getStatisticsTeamOptions,
} from "../StatisticsSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:sections.statistics": "Data Upload",
				"settings:statistics.webhook.label": "Upload Server URL",
				"settings:statistics.webhook.placeholder": "e.g. http://100.7.132.102:8081",
				"settings:statistics.department.label": "Department",
				"settings:statistics.department.placeholder": "Select department",
				"settings:statistics.office.label": "Office",
				"settings:statistics.office.placeholder": "Select office",
				"settings:statistics.team.label": "Team",
				"settings:statistics.team.placeholder": "Select team",
				"settings:statistics.userName.label": "Name",
				"settings:statistics.userName.placeholder": "e.g. Alice Zhang...",
				"settings:statistics.userEmail.label": "Company Email",
				"settings:statistics.userEmail.placeholder": "e.g. alice.zhang@example.com",
			}
			return translations[key] ?? key
		},
	}),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onChange, placeholder, type, inputMode, "data-testid": dataTestId }: any) => (
		<input
			type={type ?? "text"}
			inputMode={inputMode}
			value={value}
			onChange={(e) => onChange({ target: { value: e.target.value } })}
			placeholder={placeholder}
			data-testid={dataTestId}
		/>
	),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange, disabled, "data-testid": dataTestId }: any) => (
		<select
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
			disabled={disabled}
			data-testid={dataTestId}>
			<option value="">placeholder</option>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectGroup: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
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

	it("renders and updates the name field", () => {
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
		expect(screen.getByText("Name")).toBeInTheDocument()
		expect(screen.queryByText("Please enter your real name.")).not.toBeInTheDocument()
	})

	it("renders and updates the company email field", () => {
		const setCachedStateField = vi.fn()
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsUserEmail="alice@example.com"
				setCachedStateField={setCachedStateField}
			/>,
		)

		const emailInput = screen.getByTestId("ai-code-stats-user-email")
		expect(emailInput).toHaveAttribute("type", "email")
		expect(emailInput).toHaveAttribute("inputmode", "email")

		fireEvent.change(emailInput, {
			target: { value: "Bob@Example.COM" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsUserEmail", "Bob@Example.COM")
		expect(screen.getByText("Company Email")).toBeInTheDocument()
	})

	it("renders department, office, team, name, company email, and webhook in order", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云存储研发部"
				aiCodeStatsOfficeName="架设处"
				aiCodeStatsTeamName="研发一组"
				aiCodeStatsUserName=""
				setCachedStateField={vi.fn()}
			/>,
		)

		const departmentSelect = screen.getByTestId("ai-code-stats-department-name")
		const officeSelect = screen.getByTestId("ai-code-stats-office-name")
		const teamSelect = screen.getByTestId("ai-code-stats-team-name")
		const userNameInput = screen.getByTestId("ai-code-stats-user-name")
		const userEmailInput = screen.getByTestId("ai-code-stats-user-email")
		const webhookInput = screen.getByTestId("ai-code-stats-webhook-url")

		expect(departmentSelect.compareDocumentPosition(officeSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(officeSelect.compareDocumentPosition(teamSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(teamSelect.compareDocumentPosition(userNameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(userNameInput.compareDocumentPosition(userEmailInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(userEmailInput.compareDocumentPosition(webhookInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it("cascades organization select values and hides team when an office has no teams", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云存储研发部"
				aiCodeStatsOfficeName="架设处"
				aiCodeStatsTeamName="研发一组"
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByTestId("ai-code-stats-department-name"), {
			target: { value: "云计算研发部" },
		})
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsDepartmentName", "云计算研发部")
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsOfficeName", "")
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsTeamName", "")

		fireEvent.change(screen.getByTestId("ai-code-stats-office-name"), {
			target: { value: "经理室" },
		})
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsOfficeName", "经理室")
		expect(setCachedStateField).toHaveBeenCalledWith("aiCodeStatsTeamName", "")

		rerender(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云计算研发部"
				aiCodeStatsOfficeName="经理室"
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(screen.queryByTestId("ai-code-stats-team-name")).not.toBeInTheDocument()
	})

	it("uses the configured upload departments and cloud computing teams", () => {
		expect(STATISTICS_DEPARTMENT_OPTIONS.map((department) => department.name)).toEqual([
			"云计算研发部",
			"云存储研发部",
		])
		expect(getStatisticsTeamOptions("云计算研发部", "研发四处")).toEqual([
			"经理室",
			"研发一组",
			"研发二组",
			"研发三组",
			"研发四组",
			"研发五组",
			"研发六组",
		])
		expect(getStatisticsTeamOptions("云计算研发部", "研发五处")).toEqual([
			"经理室",
			"研发一组",
			"研发二组",
			"研发三组",
			"研发四组",
		])
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

	it("renders identity validation error below the field that failed validation", () => {
		render(
			<StatisticsSettings
				aiCodeStatsWebhookUrl=""
				aiCodeStatsDepartmentName="云存储研发部"
				identityValidationError="Please select an office."
				identityValidationErrorField="office"
				setCachedStateField={vi.fn()}
			/>,
		)

		const officeSelect = screen.getByTestId("ai-code-stats-office-name")
		const userNameInput = screen.getByTestId("ai-code-stats-user-name")
		const error = screen.getByTestId("ai-code-stats-identity-error")

		expect(error).toHaveTextContent("Please select an office.")
		expect(error).toHaveAttribute("data-validation-field", "office")
		expect(officeSelect.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(error.compareDocumentPosition(userNameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it("validates required identity fields and requires team only when the office has teams", () => {
		expect(getStatisticsIdentityValidationKey({})).toBe("settings:statistics.validation.departmentRequired")
		expect(getStatisticsIdentityValidationKey({ departmentName: "云存储研发部" })).toBe(
			"settings:statistics.validation.officeRequired",
		)
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "架设处",
				userName: "Alice",
				userEmail: "alice@example.com",
			}),
		).toBe("settings:statistics.validation.teamRequired")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "经理室",
				userName: "Alice",
			}),
		).toBe("settings:statistics.validation.emailRequired")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "经理室",
				userName: "Alice",
				userEmail: "not-an-email",
			}),
		).toBe("settings:statistics.validation.emailInvalid")
		expect(
			getStatisticsIdentityValidationKey({
				departmentName: "云存储研发部",
				officeName: "经理室",
				userName: "Alice",
				userEmail: "Alice@Example.COM",
			}),
		).toBeUndefined()
	})

	it("does not render local analysis metrics", () => {
		render(<StatisticsSettings aiCodeStatsWebhookUrl="" setCachedStateField={vi.fn()} />)

		expect(screen.queryByTestId("ai-code-stats-range-select")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-kpi-grid")).not.toBeInTheDocument()
		expect(screen.queryByTestId("ai-code-stats-token-panel")).not.toBeInTheDocument()
	})
})
