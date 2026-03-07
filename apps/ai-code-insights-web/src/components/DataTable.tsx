import type { ReactNode } from "react"

export const DataTable = <T extends Record<string, unknown>>({
	columns,
	rows,
	rowKey,
	emptyText = "暂无数据",
}: {
	columns: Array<{ key: string; header: string; render?: (row: T) => ReactNode }>
	rows: T[]
	rowKey: (row: T, index: number) => string
	emptyText?: string
}) => {
	if (!rows.length) {
		return <div className="table-empty">{emptyText}</div>
	}

	return (
		<div className="table-shell">
			<table className="data-table">
				<thead>
					<tr>
						{columns.map((column) => (
							<th key={column.key}>{column.header}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, index) => (
						<tr key={rowKey(row, index)}>
							{columns.map((column) => (
								<td key={column.key}>
									{column.render ? column.render(row) : String(row[column.key] ?? "-")}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
