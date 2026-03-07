export interface DashboardFiltersState {
	from_date: string
	to_date: string
	organization_id: string
	source_ip: string
	project_key: string
	language: string
	ide: string
	source_type: string
}

export const defaultFilters: DashboardFiltersState = {
	from_date: "",
	to_date: "",
	organization_id: "",
	source_ip: "",
	project_key: "",
	language: "",
	ide: "",
	source_type: "",
}

export const FilterBar = ({
	filters,
	onChange,
}: {
	filters: DashboardFiltersState
	onChange: (next: DashboardFiltersState) => void
}) => (
	<div className="filter-toolbar">
		<div className="filter-grid">
			<input
				className="control-input"
				type="date"
				value={filters.from_date}
				onChange={(e) => onChange({ ...filters, from_date: e.target.value })}
			/>
			<input
				className="control-input"
				type="date"
				value={filters.to_date}
				onChange={(e) => onChange({ ...filters, to_date: e.target.value })}
			/>
			<input
				className="control-input"
				placeholder="组织 ID"
				value={filters.organization_id}
				onChange={(e) => onChange({ ...filters, organization_id: e.target.value })}
			/>
			<input
				className="control-input"
				placeholder="源 IP"
				value={filters.source_ip}
				onChange={(e) => onChange({ ...filters, source_ip: e.target.value })}
			/>
			<input
				className="control-input"
				placeholder="项目 Key"
				value={filters.project_key}
				onChange={(e) => onChange({ ...filters, project_key: e.target.value })}
			/>
			<input
				className="control-input"
				placeholder="语言"
				value={filters.language}
				onChange={(e) => onChange({ ...filters, language: e.target.value })}
			/>
			<select
				className="control-input"
				value={filters.ide}
				onChange={(e) => onChange({ ...filters, ide: e.target.value })}>
				<option value="">全部 IDE</option>
				<option value="vscode">VS Code</option>
				<option value="jetbrains">JetBrains</option>
			</select>
			<select
				className="control-input"
				value={filters.source_type}
				onChange={(e) => onChange({ ...filters, source_type: e.target.value })}>
				<option value="">全部来源</option>
				<option value="agent_insert">Agent Insert</option>
				<option value="autocomplete">Autocomplete</option>
			</select>
		</div>
		<button className="secondary-button" onClick={() => onChange(defaultFilters)}>
			重置筛选
		</button>
	</div>
)
