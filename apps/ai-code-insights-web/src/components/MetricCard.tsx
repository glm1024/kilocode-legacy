import { formatNumber } from "../lib/insights"

export const MetricCard = ({
	label,
	value,
	accent,
	helper,
}: {
	label: string
	value: string | number
	accent?: string
	helper?: string
}) => (
	<div className="metric-card">
		<div className="metric-eyebrow" style={{ color: accent }}>
			{label}
		</div>
		<div className="metric-value" style={{ color: accent }}>
			{formatNumber(value)}
		</div>
		{helper ? <div className="metric-helper">{helper}</div> : null}
	</div>
)
