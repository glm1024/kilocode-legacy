import { useQuery } from "@tanstack/react-query"

import { insightsApi } from "../lib/api"

export const useOverview = (filters: Record<string, string>) =>
	useQuery({
		queryKey: ["overview", filters],
		queryFn: () => insightsApi.getOverview(filters),
	})

export const useTrends = (granularity: string, filters: Record<string, string>) =>
	useQuery({
		queryKey: ["trends", granularity, filters],
		queryFn: () => insightsApi.getTrends(granularity, filters),
	})

export const useRankings = (dimension: string, filters: Record<string, string>) =>
	useQuery({
		queryKey: ["rankings", dimension, filters],
		queryFn: () => insightsApi.getRankings(dimension, filters),
	})

export const useDistribution = (dimension: string, filters: Record<string, string>) =>
	useQuery({
		queryKey: ["distribution", dimension, filters],
		queryFn: () => insightsApi.getDistribution(dimension, filters),
	})

export const useEvents = (filters: Record<string, string>) =>
	useQuery({
		queryKey: ["events", filters],
		queryFn: () => insightsApi.getEvents({ ...filters, page: 1, page_size: 20 }),
	})

export const useEventsWindow = (filters: Record<string, string>, pageSize: number) =>
	useQuery({
		queryKey: ["events", filters, pageSize],
		queryFn: () => insightsApi.getEvents({ ...filters, page: 1, page_size: pageSize }),
	})
