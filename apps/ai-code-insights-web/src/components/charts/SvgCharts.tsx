import { useMemo } from "react"

type Point = {
	label: string
	value: number
}

type Slice = {
	label: string
	value: number
}

const chartPalette = ["#2bd4ff", "#ff9f43", "#7af59f", "#ff6b81", "#9f7cff", "#ffd166"]

const formatCompact = (value: number) => Intl.NumberFormat("zh-CN", { notation: "compact" }).format(value)

export const LineChart = ({
	points,
	height = 280,
	color = "#2bd4ff",
}: {
	points: Point[]
	height?: number
	color?: string
}) => {
	const width = 820
	const padding = 22

	const { path, areaPath, ticks } = useMemo(() => {
		if (!points.length) {
			return { path: "", areaPath: "", ticks: [] as Array<{ x: number; label: string }> }
		}

		const maxValue = Math.max(...points.map((point) => point.value), 1)
		const stepX = points.length === 1 ? width - padding * 2 : (width - padding * 2) / (points.length - 1)
		const coords = points.map((point, index) => {
			const x = padding + stepX * index
			const y = height - padding - (point.value / maxValue) * (height - padding * 2)
			return { x, y }
		})
		const line = coords
			.map((coord, index) => `${index === 0 ? "M" : "L"} ${coord.x.toFixed(2)} ${coord.y.toFixed(2)}`)
			.join(" ")
		const firstCoord = coords[0]
		const lastCoord = coords[coords.length - 1]
		if (!firstCoord || !lastCoord) {
			return { path: "", areaPath: "", ticks: [] as Array<{ x: number; label: string }> }
		}
		const area =
			`${line} L ${lastCoord.x.toFixed(2)} ${(height - padding).toFixed(2)} ` +
			`L ${firstCoord.x.toFixed(2)} ${(height - padding).toFixed(2)} Z`

		return {
			path: line,
			areaPath: area,
			ticks: coords.map((coord, index) => ({ x: coord.x, label: points[index]?.label ?? "" })),
		}
	}, [height, points])

	if (!points.length) {
		return <div className="chart-empty">暂无数据</div>
	}

	return (
		<svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
			<defs>
				<linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stopColor={color} stopOpacity="0.28" />
					<stop offset="100%" stopColor={color} stopOpacity="0.02" />
				</linearGradient>
			</defs>
			{[0.25, 0.5, 0.75].map((ratio) => {
				const y = padding + (height - padding * 2) * ratio
				return <line key={ratio} className="chart-grid-line" x1={padding} x2={width - padding} y1={y} y2={y} />
			})}
			<path d={areaPath} fill="url(#trend-fill)" />
			<path d={path} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
			{ticks.map((tick, index) => (
				<g key={`${tick.label}-${index}`}>
					<circle cx={tick.x} cy={height - padding} r="2" fill="rgba(255,255,255,0.42)" />
					<text className="chart-axis-text" x={tick.x} y={height - 4} textAnchor="middle">
						{tick.label}
					</text>
				</g>
			))}
		</svg>
	)
}

export const HorizontalBars = ({ items, maxItems = 8 }: { items: Slice[]; maxItems?: number }) => {
	const rows = items.slice(0, maxItems)
	const maxValue = Math.max(...rows.map((item) => item.value), 1)

	if (!rows.length) {
		return <div className="chart-empty">暂无数据</div>
	}

	return (
		<div className="bar-list">
			{rows.map((item, index) => (
				<div key={item.label} className="bar-row">
					<div className="bar-row-head">
						<span>{item.label}</span>
						<strong>{formatCompact(item.value)}</strong>
					</div>
					<div className="bar-track">
						<div
							className="bar-fill"
							style={{
								width: `${Math.max((item.value / maxValue) * 100, 8)}%`,
								background: `linear-gradient(90deg, ${chartPalette[index % chartPalette.length]}, rgba(255,255,255,0.12))`,
							}}
						/>
					</div>
				</div>
			))}
		</div>
	)
}

export const DonutChart = ({ items }: { items: Slice[] }) => {
	const total = items.reduce((sum, item) => sum + item.value, 0)
	const radius = 58
	const circumference = 2 * Math.PI * radius

	if (!items.length || total === 0) {
		return <div className="chart-empty">暂无数据</div>
	}

	let offset = 0

	return (
		<div className="donut-wrap">
			<svg className="donut-svg" viewBox="0 0 180 180" role="img">
				<circle cx="90" cy="90" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="18" />
				{items.map((item, index) => {
					const strokeDasharray = `${(item.value / total) * circumference} ${circumference}`
					const segment = (
						<circle
							key={item.label}
							cx="90"
							cy="90"
							r={radius}
							fill="none"
							stroke={chartPalette[index % chartPalette.length]}
							strokeWidth="18"
							strokeDasharray={strokeDasharray}
							strokeDashoffset={-offset}
							transform="rotate(-90 90 90)"
							strokeLinecap="round"
						/>
					)
					offset += (item.value / total) * circumference
					return segment
				})}
				<text x="90" y="86" textAnchor="middle" className="donut-total-label">
					TOTAL
				</text>
				<text x="90" y="106" textAnchor="middle" className="donut-total-value">
					{formatCompact(total)}
				</text>
			</svg>
			<div className="legend-list">
				{items.map((item, index) => (
					<div key={item.label} className="legend-item">
						<span
							className="legend-dot"
							style={{ backgroundColor: chartPalette[index % chartPalette.length] }}
						/>
						<span>{item.label}</span>
						<strong>{Math.round((item.value / total) * 100)}%</strong>
					</div>
				))}
			</div>
		</div>
	)
}

export const HeatGrid = ({ items }: { items: Slice[] }) => {
	const maxValue = Math.max(...items.map((item) => item.value), 1)

	if (!items.length) {
		return <div className="chart-empty">暂无数据</div>
	}

	return (
		<div className="heat-grid">
			{items.map((item) => {
				const intensity = item.value / maxValue
				return (
					<div
						key={item.label}
						className="heat-cell"
						style={{
							background: `linear-gradient(180deg, rgba(43, 212, 255, ${0.18 + intensity * 0.42}), rgba(10, 24, 36, 0.96))`,
						}}>
						<div className="heat-cell-label">{item.label}</div>
						<strong>{formatCompact(item.value)}</strong>
					</div>
				)
			})}
		</div>
	)
}
