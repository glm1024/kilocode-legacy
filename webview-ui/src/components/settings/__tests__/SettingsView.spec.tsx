// pnpm --filter @roo-code/vscode-webview test src/components/settings/__tests__/SettingsView.spec.tsx

import { fireEvent, render, screen, waitFor, within } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// kilocode_change start
// Mock the validate functions to prevent validation errors
vi.mock("@src/utils/validate", () => ({
	validateApiConfiguration: vi.fn().mockReturnValue(undefined),
	validateApiConfigurationExcludingModelErrors: vi.fn().mockReturnValue(undefined),
	validateModelId: vi.fn().mockReturnValue(undefined),
	getModelValidationError: vi.fn().mockReturnValue(undefined),
}))
// kilocode_change end

// Mock ApiConfigManager component
vi.mock("../ApiConfigManager", () => ({
	__esModule: true,
	default: ({ currentApiConfigName }: any) => (
		<div data-testid="api-config-management">
			<span>Current config: {currentApiConfigName}</span>
		</div>
	),
}))

// kilocode_change start
vi.mock("../StatisticsSettings", () => ({
	StatisticsSettings: ({
		aiCodeStatsWebhookUrl,
		aiCodeStatsDepartmentName,
		aiCodeStatsOfficeName,
		aiCodeStatsTeamName,
		aiCodeStatsUserName,
		aiCodeStatsUserEmail,
		setCachedStateField,
		webhookValidationError,
		identityValidationError,
	}: any) => (
		<div data-testid="statistics-settings">
			<input
				data-testid="statistics-department-name-input"
				value={aiCodeStatsDepartmentName ?? ""}
				onChange={(e) => setCachedStateField("aiCodeStatsDepartmentName", (e.target as HTMLInputElement).value)}
			/>
			<input
				data-testid="statistics-office-name-input"
				value={aiCodeStatsOfficeName ?? ""}
				onChange={(e) => setCachedStateField("aiCodeStatsOfficeName", (e.target as HTMLInputElement).value)}
			/>
			<input
				data-testid="statistics-team-name-input"
				value={aiCodeStatsTeamName ?? ""}
				onChange={(e) => setCachedStateField("aiCodeStatsTeamName", (e.target as HTMLInputElement).value)}
			/>
			<input
				data-testid="statistics-webhook-url-input"
				value={aiCodeStatsWebhookUrl ?? ""}
				onChange={(e) => setCachedStateField("aiCodeStatsWebhookUrl", (e.target as HTMLInputElement).value)}
			/>
			<input
				data-testid="statistics-user-name-input"
				value={aiCodeStatsUserName ?? ""}
				onChange={(e) => setCachedStateField("aiCodeStatsUserName", (e.target as HTMLInputElement).value)}
			/>
			<input
				data-testid="statistics-user-email-input"
				value={aiCodeStatsUserEmail ?? ""}
				onChange={(e) => setCachedStateField("aiCodeStatsUserEmail", (e.target as HTMLInputElement).value)}
			/>
			{identityValidationError && <div data-testid="statistics-identity-error">{identityValidationError}</div>}
			{webhookValidationError && <div data-testid="statistics-webhook-error">{webhookValidationError}</div>}
		</div>
	),
	getStatisticsTeamOptions: (departmentName?: string, officeName?: string) =>
		departmentName === "云存储研发部" && officeName === "架设处"
			? ["研发一组", "研发二组", "研发三组", "研发四组", "研发五组", "研发六组", "研发七组", "研发八组"]
			: [],
	getStatisticsIdentityValidationKey: () => undefined,
	normalizeStatisticsEmail: (value?: string) => value?.trim().toLowerCase() ?? "",
}))
// kilocode_change end

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, appearance, "data-testid": dataTestId }: any) =>
		appearance === "icon" ? (
			<button
				onClick={onClick}
				className="codicon codicon-close"
				aria-label="Remove command"
				data-testid={dataTestId}>
				<span className="codicon codicon-close" />
			</button>
		) : (
			<button onClick={onClick} data-appearance={appearance} data-testid={dataTestId}>
				{children}
			</button>
		),
	VSCodeCheckbox: ({ children, onChange, checked, "data-testid": dataTestId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				aria-label={typeof children === "string" ? children : undefined}
				data-testid={dataTestId}
			/>
			{children}
		</label>
	),
	VSCodeTextField: ({ value, onInput, placeholder, "data-testid": dataTestId }: any) => (
		<input
			type="text"
			value={value}
			onChange={(e) => onInput({ target: { value: e.target.value } })}
			placeholder={placeholder}
			data-testid={dataTestId}
		/>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href || "#"}>{children}</a>,
	VSCodeRadio: ({ value, checked, onChange }: any) => (
		<input type="radio" value={value} checked={checked} onChange={onChange} />
	),
	VSCodeRadioGroup: ({ children, onChange }: any) => <div onChange={onChange}>{children}</div>,
	VSCodeTextArea: ({ value, onChange, rows, className, "data-testid": dataTestId }: any) => (
		<textarea
			value={value}
			onChange={onChange}
			rows={rows}
			className={className}
			data-testid={dataTestId}
			role="textbox"
		/>
	),
	// kilocode_change start
	VSCodeDropdown: ({ children, value, onChange, className, "data-testid": dataTestId }: any) => (
		<select value={value} onChange={onChange} className={className} data-testid={dataTestId}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value, className }: any) => (
		<option value={value} className={className}>
			{children}
		</option>
	),
	// kilocode_change end
}))

vi.mock("../../../components/common/Tab", () => ({
	...vi.importActual("../../../components/common/Tab"),
	Tab: ({ children }: any) => <div data-testid="tab-container">{children}</div>,
	TabHeader: ({ children }: any) => <div data-testid="tab-header">{children}</div>,
	TabContent: ({ children, "data-testid": dataTestId }: any) => (
		<div data-testid={dataTestId || "tab-content"}>{children}</div>
	),
	TabList: ({ children, value, onValueChange, "data-testid": dataTestId }: any) => {
		// Store onValueChange in a global variable so TabTrigger can access it
		;(window as any).__onValueChange = onValueChange
		return (
			<div data-testid={dataTestId} data-value={value}>
				{children}
			</div>
		)
	},
	TabTrigger: ({ children, value, "data-testid": dataTestId, onClick, isSelected }: any) => {
		// This function simulates clicking on a tab and making its content visible
		const handleClick = () => {
			if (onClick) onClick()
			// Access onValueChange from the global variable
			const onValueChange = (window as any).__onValueChange
			if (onValueChange) onValueChange(value)
			// Make all tab contents invisible
			document.querySelectorAll("[data-tab-content]").forEach((el) => {
				;(el as HTMLElement).style.display = "none"
			})
			// Make this tab's content visible
			const tabContent = document.querySelector(`[data-tab-content="${value}"]`)
			if (tabContent) {
				;(tabContent as HTMLElement).style.display = "block"
			}
		}

		return (
			<button data-testid={dataTestId} data-value={value} data-selected={isSelected} onClick={handleClick}>
				{children}
			</button>
		)
	},
}))

vi.mock("@/components/ui", () => ({
	...vi.importActual("@/components/ui"),
	Popover: ({ children }: any) => <div data-testid="popover">{children}</div>,
	PopoverTrigger: ({ children }: any) => <div data-testid="popover-trigger">{children}</div>,
	PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
	Command: ({ children }: any) => <div data-testid="command">{children}</div>,
	CommandInput: ({ value, onValueChange }: any) => (
		<input data-testid="command-input" value={value} onChange={(e) => onValueChange(e.target.value)} />
	),
	CommandGroup: ({ children }: any) => <div data-testid="command-group">{children}</div>,
	CommandItem: ({ children, onSelect }: any) => (
		<div data-testid="command-item" onClick={onSelect}>
			{children}
		</div>
	),
	CommandList: ({ children }: any) => <div data-testid="command-list">{children}</div>,
	CommandEmpty: ({ children }: any) => <div data-testid="command-empty">{children}</div>,
	Slider: ({ value, onValueChange, "data-testid": dataTestId }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
			data-testid={dataTestId}
		/>
	),
	// kilocode_change start
	DropdownMenu: ({ children }: any) => <div data-testid="dropdown-menu">{children}</div>,
	DropdownMenuTrigger: ({ children }: any) => <div data-testid="dropdown-menu-trigger">{children}</div>,
	DropdownMenuContent: ({ children }: any) => <div data-testid="dropdown-menu-content">{children}</div>,
	DropdownMenuItem: ({ children, onClick }: any) => (
		<div data-testid="dropdown-menu-item" onClick={onClick}>
			{children}
		</div>
	),
	// kilocode_change end
	Button: ({ children, onClick, variant, className, "data-testid": dataTestId }: any) => (
		<button onClick={onClick} data-variant={variant} className={className} data-testid={dataTestId}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	Input: ({ value, onChange, placeholder, "data-testid": dataTestId }: any) => (
		<input type="text" value={value} onChange={onChange} placeholder={placeholder} data-testid={dataTestId} />
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button onClick={() => onValueChange && onValueChange("test-change")}>{value}</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
	SelectGroup: ({ children }: any) => <div data-testid="select-group">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value}>
			{children}
		</div>
	),
	SelectTrigger: ({ children }: any) => <div data-testid="select-trigger">{children}</div>,
	SelectValue: ({ placeholder }: any) => <div data-testid="select-value">{placeholder}</div>,
	SelectSeparator: () => <div data-testid="select-separator" />, // kilocode_change
	SearchableSelect: ({ value, onValueChange, options, placeholder }: any) => (
		<select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="searchable-select">
			{placeholder && <option value="">{placeholder}</option>}
			{options?.map((opt: any) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	),
	AlertDialog: ({ children, open }: any) => (
		<div data-testid="alert-dialog" data-open={open}>
			{children}
		</div>
	),
	AlertDialogContent: ({ children }: any) => <div data-testid="alert-dialog-content">{children}</div>,
	AlertDialogHeader: ({ children }: any) => <div data-testid="alert-dialog-header">{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-dialog-title">{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div data-testid="alert-dialog-description">{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div data-testid="alert-dialog-footer">{children}</div>,
	AlertDialogAction: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-action" onClick={onClick}>
			{children}
		</button>
	),
	AlertDialogCancel: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-cancel" onClick={onClick}>
			{children}
		</button>
	),
	// Add Collapsible components
	Collapsible: ({ children, open }: any) => (
		<div className="collapsible-mock" data-open={open}>
			{children}
		</div>
	),
	CollapsibleTrigger: ({ children, className, onClick }: any) => (
		<div className={`collapsible-trigger-mock ${className || ""}`} onClick={onClick}>
			{children}
		</div>
	),
	CollapsibleContent: ({ children, className }: any) => (
		<div className={`collapsible-content-mock ${className || ""}`}>{children}</div>
	),
}))

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: any) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				ttsEnabled: false,
				ttsSpeed: 1,
				soundEnabled: false,
				soundVolume: 0.5,
				aiCodeStatsDepartmentName: "云存储研发部",
				aiCodeStatsOfficeName: "架设处",
				aiCodeStatsTeamName: "研发一组",
				aiCodeStatsUserName: "Test User",
				aiCodeStatsUserEmail: "test.user@example.com",
				...state,
			},
		},
		"*",
	)
}

// kilocode_change on next line, initial state initialization to work with localized checkboxes
const renderSettingsView = (initialState = {}) => {
	const onDone = vi.fn()
	const queryClient = new QueryClient()

	const result = render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

	// Hydrate initial state.
	mockPostMessage(initialState)

	// Helper function to activate a tab and ensure its content is visible
	const activateTab = (tabId: string) => {
		// Skip trying to find and click the tab, just directly render with the target section
		// This bypasses the actual tab clicking mechanism but ensures the content is shown
		result.rerender(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<SettingsView onDone={onDone} targetSection={tabId} />
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)
	}

	// Helper to get elements within the settings content (not the indexing container)
	const getSettingsContent = () => screen.getByTestId("settings-content")

	return { onDone, activateTab, getSettingsContent }
}

const getPostMessageCallsByType = (type: string) => {
	return (vscode.postMessage as any).mock.calls
		.map((call: any[]) => call[0])
		.filter((message: Record<string, unknown>) => message?.type === type)
}

describe("SettingsView - Sound Settings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("initializes with tts disabled by default", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")
		expect(ttsCheckbox).not.toBeChecked()

		// Speed slider should not be visible when tts is disabled
		expect(within(content).queryByTestId("tts-speed-slider")).not.toBeInTheDocument()
	})

	it("initializes with sound disabled by default", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		expect(soundCheckbox).not.toBeChecked()

		// Volume slider should not be visible when sound is disabled
		expect(within(content).queryByTestId("sound-volume-slider")).not.toBeInTheDocument()
	})

	it("toggles tts setting and sends message to VSCode", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")

		// Enable tts
		fireEvent.click(ttsCheckbox)
		expect(ttsCheckbox).toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					ttsEnabled: true,
				}),
			}),
		)
	})

	it("toggles sound setting and sends message to VSCode", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")

		// Enable sound
		fireEvent.click(soundCheckbox)
		expect(soundCheckbox).toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundEnabled: true,
				}),
			}),
		)
	})

	it("shows tts slider when sound is enabled", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable tts
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")
		fireEvent.click(ttsCheckbox)

		// Speed slider should be visible
		const speedSlider = within(content).getByTestId("tts-speed-slider")
		expect(speedSlider).toBeInTheDocument()
		expect(speedSlider).toHaveValue("1")
	})

	it("shows volume slider when sound is enabled", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable sound
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		fireEvent.click(soundCheckbox)

		// Volume slider should be visible
		const volumeSlider = within(content).getByTestId("sound-volume-slider")
		expect(volumeSlider).toBeInTheDocument()
		expect(volumeSlider).toHaveValue("0.5")
	})

	it("updates speed and sends message to VSCode when slider changes", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable tts
		const ttsCheckbox = within(content).getByTestId("tts-enabled-checkbox")
		fireEvent.click(ttsCheckbox)

		// Change speed
		const speedSlider = within(content).getByTestId("tts-speed-slider")
		fireEvent.change(speedSlider, { target: { value: "0.75" } })

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify message sent to VSCode
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					ttsSpeed: 0.75,
				}),
			}),
		)
	})

	it("updates volume and sends message to VSCode when slider changes", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the notifications tab
		activateTab("notifications")

		const content = getSettingsContent()
		// Enable sound
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		fireEvent.click(soundCheckbox)

		// Change volume
		const volumeSlider = within(content).getByTestId("sound-volume-slider")
		fireEvent.change(volumeSlider, { target: { value: "0.75" } })

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify message sent to VSCode
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundVolume: 0.75,
				}),
			}),
		)
	})
})

describe("SettingsView - API Configuration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders ApiConfigManagement with correct props", () => {
		renderSettingsView()

		expect(screen.getByTestId("api-config-management")).toBeInTheDocument()
	})
})

describe("SettingsView - Allowed Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows allowed commands section when alwaysAllowExecute is enabled", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)
		// Verify allowed commands section appears
		expect(within(content).getByTestId("allowed-commands-heading")).toBeInTheDocument()
		expect(within(content).getByTestId("command-input")).toBeInTheDocument()
	})

	it("adds new command to the list", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a new command
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })

		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Verify command was added
		expect(within(content).getByText("npm test")).toBeInTheDocument()

		// Verify VSCode message was sent
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: {
				allowedCommands: ["npm test"],
			},
		})
	})

	it("removes command from the list", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Remove the command
		const removeButton = within(content).getByTestId("remove-command-0")
		fireEvent.click(removeButton)

		// Verify command was removed
		expect(within(content).queryByText("npm test")).not.toBeInTheDocument()

		// Verify VSCode message was sent
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "updateSettings",
			updatedSettings: {
				allowedCommands: [],
			},
		})
	})

	describe("SettingsView - Tab Navigation", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("renders with providers tab active by default", () => {
			renderSettingsView()

			// Check that the tab list is rendered
			const tabList = screen.getByTestId("settings-tab-list")
			expect(tabList).toBeInTheDocument()

			// Check that providers content is visible
			expect(screen.getByTestId("api-config-management")).toBeInTheDocument()
		})

		// kilocode_change start
		it("renders data upload tab in the second position", () => {
			renderSettingsView()

			const providersTab = screen.getByTestId("tab-providers")
			const statisticsTab = screen.getByTestId("tab-statistics")

			expect(statisticsTab).toBeInTheDocument()
			expect(providersTab.compareDocumentPosition(statisticsTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		})
		// kilocode_change end

		it("shows unsaved changes dialog when clicking Done with unsaved changes", () => {
			// Render once and get the activateTab helper
			const { activateTab, getSettingsContent } = renderSettingsView()

			// Activate the notifications tab
			activateTab("notifications")

			const content = getSettingsContent()
			// Make a change to create unsaved changes
			const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
			fireEvent.click(soundCheckbox)

			// Click the Done button
			const doneButton = screen.getByText("settings:common.done")
			fireEvent.click(doneButton)

			// Check that unsaved changes dialog is shown
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})

		it("renders with targetSection prop", () => {
			// Render with a specific target section
			render(
				<ExtensionStateContextProvider>
					<QueryClientProvider client={new QueryClient()}>
						<SettingsView onDone={vi.fn()} targetSection="browser" />
					</QueryClientProvider>
				</ExtensionStateContextProvider>,
			)

			// Hydrate initial state
			mockPostMessage({})

			// Verify browser-related content is visible and API config is not
			expect(screen.queryByTestId("api-config-management")).not.toBeInTheDocument()
		})
	})
})

describe("SettingsView - Duplicate Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("prevents duplicate commands", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command twice
		const input = within(content).getByTestId("command-input")
		const addButton = within(content).getByTestId("add-command-button")

		// First addition
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(addButton)

		// Second addition attempt
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(addButton)

		// Verify command appears only once in active tab
		const commands = within(content).getAllByText("npm test")
		expect(commands).toHaveLength(1)
	})

	it("saves allowed commands when clicking Save", () => {
		// Render once and get the activateTab helper
		const { activateTab, getSettingsContent } = renderSettingsView()

		// Activate the autoApprove tab
		activateTab("autoApprove")

		const content = getSettingsContent()
		// Enable always allow execute
		const executeCheckbox = within(content).getByTestId("always-allow-execute-toggle")
		fireEvent.click(executeCheckbox)

		// Add a command
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		const addButton = within(content).getByTestId("add-command-button")
		fireEvent.click(addButton)

		// Click Save
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify VSCode messages were sent
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					allowedCommands: ["npm test"],
				}),
			}),
		)
	})
})

describe("SettingsView - Statistics Webhook Save Validation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const completeWebhookTestIfRequested = () => {
		if (getPostMessageCallsByType("testAiCodeStatsWebhook").length === 0) {
			return
		}

		window.postMessage(
			{
				type: "aiCodeStatsWebhookTestResult",
				success: true,
				text: "",
			},
			"*",
		)
	}

	it("tests changed non-empty webhook before save and continues when test succeeds", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "https://old.example.com/webhook",
			aiCodeStatsUserName: "Old Name",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "https://new.example.com/webhook" },
		})
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "testAiCodeStatsWebhook",
			text: "https://new.example.com/webhook/api/v1/ingest/ai-code-stats",
		})
		expect(getPostMessageCallsByType("updateSettings")).toHaveLength(0)

		window.postMessage(
			{
				type: "aiCodeStatsWebhookTestResult",
				success: true,
				text: "ok",
			},
			"*",
		)

		await waitFor(() => {
			expect(getPostMessageCallsByType("updateSettings").length).toBeGreaterThan(0)
		})

		const updateSettings = getPostMessageCallsByType("updateSettings").at(-1)
		expect(updateSettings.updatedSettings.aiCodeStatsWebhookUrl).toBe("https://new.example.com/webhook")
	})

	it("normalizes a root server URL before testing but preserves the user input when saving", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "http://localhost:8081" },
		})
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "testAiCodeStatsWebhook",
			text: "http://localhost:8081/api/v1/ingest/ai-code-stats",
		})

		window.postMessage(
			{
				type: "aiCodeStatsWebhookTestResult",
				success: true,
				text: "",
			},
			"*",
		)

		await waitFor(() => {
			expect(getPostMessageCallsByType("updateSettings").length).toBeGreaterThan(0)
		})

		const updateSettings = getPostMessageCallsByType("updateSettings").at(-1)
		expect(updateSettings.updatedSettings.aiCodeStatsWebhookUrl).toBe("http://localhost:8081")
		expect(screen.getByTestId("statistics-webhook-url-input")).toHaveValue("http://localhost:8081")
	})

	// kilocode_change start
	it("trims the user name during save", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "https://old.example.com/webhook",
			aiCodeStatsUserName: "Old Name",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "https://old.example.com/webhook" },
		})
		fireEvent.change(screen.getByTestId("statistics-user-name-input"), {
			target: { value: "  Team Nine  " },
		})
		fireEvent.click(screen.getByTestId("save-button"))
		completeWebhookTestIfRequested()

		await waitFor(() => {
			expect(getPostMessageCallsByType("updateSettings").length).toBeGreaterThan(0)
		})

		const updateSettings = getPostMessageCallsByType("updateSettings").at(-1)
		expect(updateSettings.updatedSettings.aiCodeStatsUserName).toBe("Team Nine")
	})

	it("normalizes the company email during save", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "https://old.example.com/webhook",
			aiCodeStatsUserEmail: "old@example.com",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "https://old.example.com/webhook" },
		})
		fireEvent.change(screen.getByTestId("statistics-user-email-input"), {
			target: { value: "  Alice.Zhang@Example.COM  " },
		})
		fireEvent.click(screen.getByTestId("save-button"))
		completeWebhookTestIfRequested()

		await waitFor(() => {
			expect(getPostMessageCallsByType("updateSettings").length).toBeGreaterThan(0)
		})

		const updateSettings = getPostMessageCallsByType("updateSettings").at(-1)
		expect(updateSettings.updatedSettings.aiCodeStatsUserEmail).toBe("alice.zhang@example.com")
	})

	it("keeps the saved user name visible before extension state round-trips back", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "https://old.example.com/webhook",
			aiCodeStatsUserName: "",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "https://old.example.com/webhook" },
		})
		fireEvent.change(screen.getByTestId("statistics-user-name-input"), {
			target: { value: "Team Nine" },
		})
		fireEvent.click(screen.getByTestId("save-button"))
		completeWebhookTestIfRequested()

		await waitFor(() => {
			expect(getPostMessageCallsByType("updateSettings").length).toBeGreaterThan(0)
			expect(screen.getByTestId("statistics-user-name-input")).toHaveValue("Team Nine")
		})
	})

	it("keeps saved statistics values after leaving and reopening settings before extension state round-trips back", async () => {
		const queryClient = new QueryClient()

		const ReopenableSettings = () => {
			const [isOpen, setIsOpen] = useState(true)

			return isOpen ? (
				<SettingsView onDone={() => setIsOpen(false)} targetSection="statistics" />
			) : (
				<button data-testid="reopen-settings" onClick={() => setIsOpen(true)}>
					reopen
				</button>
			)
		}

		render(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<ReopenableSettings />
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)

		mockPostMessage({
			aiCodeStatsWebhookUrl: "",
			aiCodeStatsUserName: "",
		})

		fireEvent.change(screen.getByTestId("statistics-user-name-input"), {
			target: { value: "glm" },
		})
		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "http://localhost:8081" },
		})
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "testAiCodeStatsWebhook",
			text: "http://localhost:8081/api/v1/ingest/ai-code-stats",
		})

		window.postMessage(
			{
				type: "aiCodeStatsWebhookTestResult",
				success: true,
				text: "",
			},
			"*",
		)

		await waitFor(() => {
			expect(getPostMessageCallsByType("updateSettings").length).toBeGreaterThan(0)
		})

		fireEvent.click(screen.getByText("settings:common.done").closest("button")!)
		fireEvent.click(screen.getByTestId("reopen-settings"))

		expect(screen.getByTestId("statistics-user-name-input")).toHaveValue("glm")
		expect(screen.getByTestId("statistics-webhook-url-input")).toHaveValue("http://localhost:8081")
	})
	// kilocode_change end

	it("blocks save when webhook test fails", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "https://old.example.com/webhook",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "https://new.example.com/webhook" },
		})
		fireEvent.click(screen.getByTestId("save-button"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "testAiCodeStatsWebhook",
			text: "https://new.example.com/webhook/api/v1/ingest/ai-code-stats",
		})

		window.postMessage(
			{
				type: "aiCodeStatsWebhookTestResult",
				success: false,
				text: "network failed",
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("statistics-webhook-error")).toHaveTextContent(
				"settings:statistics.webhook.test.failed: network failed",
			)
		})

		expect(getPostMessageCallsByType("showSystemNotification")).toHaveLength(0)
		expect(getPostMessageCallsByType("updateSettings")).toHaveLength(0)
	})

	it("shows a specific validation message when the ingest endpoint is not found", async () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "http://localhost:8081" },
		})
		fireEvent.click(screen.getByTestId("save-button"))

		window.postMessage(
			{
				type: "aiCodeStatsWebhookTestResult",
				success: false,
				text: "",
				values: { errorCode: "endpoint_not_found" },
			},
			"*",
		)

		await waitFor(() => {
			expect(screen.getByTestId("statistics-webhook-error")).toHaveTextContent(
				"settings:statistics.webhook.test.endpointNotFound",
			)
		})

		expect(getPostMessageCallsByType("updateSettings")).toHaveLength(0)
	})

	it("blocks save when normalized url is empty", () => {
		const { activateTab } = renderSettingsView({
			aiCodeStatsWebhookUrl: "https://old.example.com/webhook",
			aiCodeStatsUserName: "Old Name",
		})
		activateTab("statistics")

		fireEvent.change(screen.getByTestId("statistics-webhook-url-input"), {
			target: { value: "   " },
		})
		fireEvent.click(screen.getByTestId("save-button"))

		expect(getPostMessageCallsByType("testAiCodeStatsWebhook")).toHaveLength(0)
		expect(screen.getByTestId("statistics-webhook-error")).toHaveTextContent(
			"settings:statistics.webhook.test.required",
		)
		expect(getPostMessageCallsByType("updateSettings")).toHaveLength(0)
	})
})
