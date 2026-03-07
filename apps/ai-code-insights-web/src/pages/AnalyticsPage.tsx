import { useMemo, useState } from "react"

import { DataTable } from "../components/DataTable"
import { DonutChart, HeatGrid, HorizontalBars, LineChart } from "../components/charts/SvgCharts"
import { useDistribution, useEventsWindow, useRankings, useTrends } from "../hooks/useDashboardData"
import { bucketLineCounts, bucketSnippetLengths, buildHourHeatItems, toBarItems, toChartPoints } from "../lib/insights"

export const AnalyticsPage = ({ filters }: { filters: Record<string, string> }) => {
	const [granularity, setGranularity] = useState<"day" | "week" | "month">("week")
	const trends = useTrends(granularity, filters)
	const sourceIps = useRankings("sourceIp", filters)
	const projects = useRankings("project", filters)
	const languages = useRankings("language", filters)
	const sourceType = useDistribution("sourceType", filters)
	const events = useEventsWindow(filters, 120)

	const lineBuckets = useMemo(() => bucketLineCounts(events.data), [events.data])
	const snippetBuckets = useMemo(() => bucketSnippetLengths(events.data), [events.data])
	const heatItems = useMemo(() => buildHourHeatItems(events.data), [events.data])

	return (
		<div className="page-shell">
			<section className="chart-card">
				<div className="chart-head-inline">
					<div>
						<div className="chart-title">时间维度趋势</div>
						<p className="chart-subtitle">支持按天、周、月切换，观察 AI 代码生产的节奏变化。</p>
					</div>
					<div className="drawer-segmented">
						{(["day", "week", "month"] as const).map((value) => (
							<button
								key={value}
								className={`pill-button ${granularity === value ? "pill-button-active" : ""}`}
								onClick={() => setGranularity(value)}>
								{value === "day" ? "日" : value === "week" ? "周" : "月"}
							</button>
						))}
					</div>
				</div>
				<LineChart points={toChartPoints(trends.data)} />
			</section>

			<div className="panel-grid panel-grid-3">
				<section className="chart-card">
					<div className="chart-title">源 IP 排行</div>
					<HorizontalBars items={toBarItems(sourceIps.data)} maxItems={10} />
				</section>
				<section className="chart-card">
					<div className="chart-title">项目排行</div>
					<HorizontalBars items={toBarItems(projects.data)} maxItems={10} />
				</section>
				<section className="chart-card">
					<div className="chart-title">语言排行</div>
					<HorizontalBars items={toBarItems(languages.data)} maxItems={10} />
				</section>
			</div>

			<div className="panel-grid panel-grid-3">
				<section className="chart-card">
					<div className="chart-title">来源类型分布</div>
					<DonutChart
						items={(sourceType.data?.items ?? []).map((item) => ({ label: item.label, value: item.value }))}
					/>
				</section>
				<section className="chart-card">
					<div className="chart-title">任务粒度分布</div>
					<HorizontalBars items={lineBuckets} maxItems={4} />
				</section>
				<section className="chart-card">
					<div className="chart-title">代码片段长度分布</div>
					<HorizontalBars items={snippetBuckets} maxItems={4} />
				</section>
			</div>

			<div className="panel-grid panel-grid-2">
				<section className="chart-card">
					<div className="chart-title">小时热力</div>
					<HeatGrid items={heatItems} />
				</section>
				<section className="chart-card">
					<div className="chart-title">事件明细</div>
					<DataTable
						rows={events.data?.items ?? []}
						rowKey={(row) => row.eventId}
						columns={[
							{
								key: "occurredAt",
								header: "时间",
								render: (row) => new Date(row.occurredAt).toLocaleString(),
							},
							{ key: "sourceIp", header: "源 IP", render: (row) => row.sourceIp || "unknown" },
							{ key: "userName", header: "用户名", render: (row) => row.userName || "-" },
							{ key: "workspaceName", header: "项目" },
							{ key: "language", header: "语言", render: (row) => row.language || "unknown" },
							{ key: "lineCount", header: "行数" },
							{ key: "relativePath", header: "文件" },
						]}
					/>
				</section>
			</div>
		</div>
	)
}
