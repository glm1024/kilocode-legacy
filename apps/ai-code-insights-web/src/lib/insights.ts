import type { EventsResponse, RankingsResponse, TrendsResponse } from "./api"

export const formatNumber = (value: number | string) =>
	typeof value === "number" ? Intl.NumberFormat("zh-CN").format(value) : value

export const toChartPoints = (response?: TrendsResponse) =>
	(response?.points ?? []).map((point) => ({
		label: point.bucket,
		value: point.totalLines,
	}))

export const toBarItems = (response?: RankingsResponse) =>
	(response?.items ?? []).map((item) => ({
		label: item.label,
		value: item.totalLines,
	}))

export const bucketLineCounts = (events?: EventsResponse) => {
	const buckets = [
		{ label: "1-10 行", min: 1, max: 10, value: 0 },
		{ label: "11-30 行", min: 11, max: 30, value: 0 },
		{ label: "31-80 行", min: 31, max: 80, value: 0 },
		{ label: "80+ 行", min: 81, max: Infinity, value: 0 },
	]

	events?.items.forEach((item) => {
		const bucket = buckets.find((candidate) => item.lineCount >= candidate.min && item.lineCount <= candidate.max)
		if (bucket) {
			bucket.value += 1
		}
	})

	return buckets.map(({ label, value }) => ({ label, value }))
}

export const bucketSnippetLengths = (events?: EventsResponse) => {
	const buckets = [
		{ label: "<80 字符", min: 0, max: 79, value: 0 },
		{ label: "80-200", min: 80, max: 200, value: 0 },
		{ label: "201-500", min: 201, max: 500, value: 0 },
		{ label: "500+", min: 501, max: Infinity, value: 0 },
	]

	events?.items.forEach((item) => {
		const size = item.codeSnippet.length
		const bucket = buckets.find((candidate) => size >= candidate.min && size <= candidate.max)
		if (bucket) {
			bucket.value += 1
		}
	})

	return buckets.map(({ label, value }) => ({ label, value }))
}

export const buildHourHeatItems = (events?: EventsResponse) => {
	const hours = Array.from({ length: 24 }, (_, hour) => ({
		label: `${String(hour).padStart(2, "0")}:00`,
		value: 0,
	}))

	events?.items.forEach((item) => {
		const hour = new Date(item.occurredAt).getHours()
		const bucket = hours[hour]
		if (bucket) {
			bucket.value += item.lineCount
		}
	})

	return hours
}

export const topContributionShare = (response?: RankingsResponse) => {
	const items = response?.items ?? []
	const total = items.reduce((sum, item) => sum + item.totalLines, 0)
	return items.slice(0, 5).map((item) => ({
		label: item.label,
		value: total ? Math.round((item.totalLines / total) * 100) : 0,
	}))
}
