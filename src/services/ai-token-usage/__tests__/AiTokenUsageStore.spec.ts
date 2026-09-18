import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { AiTokenUsageStore } from "../AiTokenUsageStore"

describe("AiTokenUsageStore", () => {
	let tmpDir: string
	let store: AiTokenUsageStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-usage-store-"))
		store = new AiTokenUsageStore(tmpDir)
	})

	const recordUsage = async (
		occurredAt: string,
		totals: { input: number; output: number; total?: number },
		dimensions: { provider?: string; model?: string } = {},
		targetStore: AiTokenUsageStore = store,
	) => {
		const timestamp = new Date(occurredAt).getTime()
		await targetStore.recordUsage({
			occurredAt: timestamp,
			timezone: "Asia/Shanghai",
			userName: "glm7",
			userEmail: "glm7@example.com",
			sourceIp: "127.0.0.1",
			userKey: "email:glm7@example.com",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			gitRemoteUrl: "https://github.com/example/project-alpha.git",
			ide: "vscode",
			provider: dimensions.provider ?? "openai",
			model: dimensions.model ?? "gpt-5.4",
			requestCount: 1,
			inputTokens: totals.input,
			outputTokens: totals.output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: totals.total ?? totals.input + totals.output,
		})
	}

	it("aggregates token usage by today, week, month, all, and custom ranges", async () => {
		const now = new Date("2026-03-19T12:00:00.000Z").getTime()
		await recordUsage("2026-02-28T09:00:00.000Z", { input: 90, output: 10 })
		await recordUsage("2026-03-01T09:00:00.000Z", { input: 80, output: 20 })
		await recordUsage("2026-03-16T09:00:00.000Z", { input: 70, output: 30 })
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })

		await expect(store.getSummaryForRange({ type: "current" }, now)).resolves.toEqual({
			inputTokens: 40,
			outputTokens: 60,
			totalTokens: 100,
		})

		await expect(store.getSummaryForRange({ type: "last7days" }, now)).resolves.toEqual({
			inputTokens: 110,
			outputTokens: 90,
			totalTokens: 200,
		})

		await expect(store.getSummaryForRange({ type: "last30days" }, now)).resolves.toEqual({
			inputTokens: 190,
			outputTokens: 110,
			totalTokens: 300,
		})

		await expect(store.getSummaryForRange({ type: "all" }, now)).resolves.toEqual({
			inputTokens: 280,
			outputTokens: 120,
			totalTokens: 400,
		})

		await expect(
			store.getSummaryForRange({ type: "custom", startDate: "2026-03-01", endDate: "2026-03-16" }, now),
		).resolves.toEqual({
			inputTokens: 150,
			outputTokens: 50,
			totalTokens: 200,
		})
	})

	it("returns zeros when custom range dates are invalid", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })

		await expect(store.getSummaryForRange({ type: "custom", startDate: "2026-03-19" })).resolves.toEqual({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		})
	})

	it("keeps dirty rows when uploaded snapshot is older than current local totals", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })
		const [uploadedSnapshot] = await store.getPendingUploadRows()

		await recordUsage("2026-03-19T09:00:05.000Z", { input: 10, output: 5 })
		await store.markRowsUploaded([uploadedSnapshot], new Date("2026-03-19T09:00:10.000Z").getTime())

		const [pendingAfterStaleAck] = await store.getPendingUploadRows()
		expect(pendingAfterStaleAck).toMatchObject({
			requestCount: 2,
			inputTokens: 50,
			outputTokens: 65,
			totalTokens: 115,
			dirty: true,
		})

		await store.markRowsUploaded([pendingAfterStaleAck], new Date("2026-03-19T09:00:15.000Z").getTime())
		expect(await store.getPendingUploadRows()).toHaveLength(0)
	})

	it("aggregates cache observation coverage without treating legacy missing fields as known zero", async () => {
		const occurredAt = new Date("2026-03-19T09:00:00.000Z").getTime()
		await store.recordUsage({
			occurredAt,
			timezone: "Asia/Shanghai",
			userName: "glm7",
			userEmail: "glm7@example.com",
			sourceIp: "127.0.0.1",
			userKey: "email:glm7@example.com",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 40,
			outputTokens: 10,
			cacheReadTokens: 0,
			cacheReadObservedRequestCount: 1,
			cacheReadObservedInputTokens: 40,
			cacheWriteTokens: 0,
			totalTokens: 50,
		})
		await recordUsage("2026-03-19T09:00:05.000Z", { input: 20, output: 5 })

		const [row] = await store.getPendingUploadRows()
		expect(row).toMatchObject({
			requestCount: 2,
			inputTokens: 60,
			cacheReadObservedRequestCount: 1,
			cacheReadObservedInputTokens: 40,
		})

		const statePath = path.join(tmpDir, "ai-token-usage", "v1", "state.json")
		const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			rows: Record<string, Record<string, unknown>>
		}
		const persistedRow = Object.values(persisted.rows)[0]
		delete persistedRow.cacheReadObservedRequestCount
		delete persistedRow.cacheReadObservedInputTokens
		await fs.writeFile(statePath, JSON.stringify(persisted), "utf8")

		const [legacyRow] = await new AiTokenUsageStore(tmpDir).getPendingUploadRows()
		expect(legacyRow).toMatchObject({
			cacheReadObservedRequestCount: 0,
			cacheReadObservedInputTokens: 0,
		})
	})

	it("atomically assigns and merges only explicitly anonymous rows into a configured identity", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 10 })
		await store.recordUsage({
			occurredAt: new Date("2026-03-19T09:00:05.000Z").getTime(),
			timezone: "Asia/Shanghai",
			userName: "anonymous",
			userEmail: undefined,
			sourceIp: "127.0.0.1",
			userKey: "anonymous-install:stable-install",
			identityKind: "anonymous",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 20,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 25,
		})

		await expect(
			store.assignAnonymousRowsToConfiguredIdentity({
				userEmail: "glm7@example.com",
				userName: "Configured User",
				departmentName: "Cloud",
			}),
		).resolves.toBe(1)
		expect(await store.getPendingUploadRows()).toEqual([
			expect.objectContaining({
				identityKind: "configured",
				userEmail: "glm7@example.com",
				userKey: "email:glm7@example.com",
				userName: "Configured User",
				departmentName: "Cloud",
				requestCount: 2,
				inputTokens: 60,
				outputTokens: 15,
				totalTokens: 75,
				dirty: true,
			}),
		])
	})

	it("quarantines an object-email target without merging it into a configured identity", async () => {
		const occurredAt = new Date("2026-03-19T09:00:00.000Z").getTime()
		const sharedDimensions = {
			occurredAt,
			timezone: "Asia/Shanghai",
			sourceIp: "127.0.0.1",
			projectKey: "project-collision",
			projectName: "project-collision",
			repoRoot: "/workspace/project-collision",
			ide: "vscode" as const,
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 20,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 25,
		}
		await store.recordUsage({
			...sharedDimensions,
			userName: "Configured B",
			userEmail: "configured.b@example.com",
			userKey: "email:configured.b@example.com",
			identityKind: "configured",
		})
		await store.recordUsage({
			...sharedDimensions,
			userName: "Anonymous",
			userEmail: undefined,
			userKey: "anonymous-install:collision-source",
			identityKind: "anonymous",
		})
		const statePath = path.join(tmpDir, "ai-token-usage", "v1", "state.json")
		const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			rows: Record<string, { userKey: string; userEmail?: unknown }>
		}
		const collisionTarget = Object.values(persisted.rows).find(
			(row) => row.userKey === "email:configured.b@example.com",
		)
		expect(collisionTarget).toBeDefined()
		collisionTarget!.userEmail = { legacyOwner: "unknown" }
		await fs.writeFile(statePath, JSON.stringify(persisted), "utf8")
		store = new AiTokenUsageStore(tmpDir)

		await expect(
			store.assignAnonymousRowsToConfiguredIdentity({ userEmail: "configured.b@example.com" }),
		).resolves.toBe(1)
		const rows = await store.getPendingUploadRows()
		expect(rows).toEqual([
			expect.objectContaining({
				userKey: "email:configured.b@example.com",
				userEmail: "configured.b@example.com",
				identityKind: "configured",
				requestCount: 1,
				totalTokens: 25,
			}),
		])
		expect(await store.getQuarantinedRows()).toEqual([
			expect.objectContaining({
				issueCode: "invalid_persisted_row_structure",
				raw: expect.objectContaining({
					userKey: "email:configured.b@example.com",
					userEmail: { legacyOwner: "unknown" },
					requestCount: 1,
					totalTokens: 25,
				}),
			}),
		])
		expect(await new AiTokenUsageStore(tmpDir).getPendingUploadRows()).toEqual(rows)
	})

	it("does not let a later anonymous fact wash a poisoned identity into the current configured user", async () => {
		const occurredAt = new Date("2026-03-19T09:00:00.000Z").getTime()
		const anonymousRecord = {
			occurredAt,
			timezone: "Asia/Shanghai",
			userName: "Anonymous",
			userEmail: undefined,
			sourceIp: "127.0.0.1",
			userKey: "anonymous-install:poisoned-history",
			identityKind: "anonymous" as const,
			projectKey: "project-poison",
			projectName: "project-poison",
			repoRoot: "/workspace/project-poison",
			ide: "vscode" as const,
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 20,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 25,
		}
		await store.recordUsage(anonymousRecord)

		const statePath = path.join(tmpDir, "ai-token-usage", "v1", "state.json")
		const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			rows: Record<string, { userEmail?: unknown }>
		}
		Object.values(persisted.rows)[0].userEmail = { legacyOwner: "unknown" }
		await fs.writeFile(statePath, JSON.stringify(persisted), "utf8")

		store = new AiTokenUsageStore(tmpDir)
		await store.recordUsage({
			...anonymousRecord,
			occurredAt: occurredAt + 5_000,
			inputTokens: 7,
			outputTokens: 3,
			totalTokens: 10,
		})

		await expect(
			store.assignAnonymousRowsToConfiguredIdentity({ userEmail: "current-b@example.com" }),
		).resolves.toBe(1)
		const rows = await store.getPendingUploadRows()
		expect(rows).toEqual([
			expect.objectContaining({
				userEmail: "current-b@example.com",
				userKey: "email:current-b@example.com",
				requestCount: 1,
				totalTokens: 10,
				identityKind: "configured",
			}),
		])
		expect(await store.getQuarantinedRows()).toEqual([
			expect.objectContaining({
				issueCode: "invalid_persisted_row_structure",
				raw: expect.objectContaining({
					userEmail: { legacyOwner: "unknown" },
					userKey: "anonymous-install:poisoned-history",
					requestCount: 1,
					totalTokens: 25,
				}),
			}),
		])
	})

	it("isolates a newly recorded invalid identity without poisoning an existing anonymous aggregate", async () => {
		const occurredAt = new Date("2026-03-19T09:00:00.000Z").getTime()
		const anonymousRecord = {
			occurredAt,
			timezone: "Asia/Shanghai",
			userName: "Anonymous",
			userEmail: undefined,
			sourceIp: "127.0.0.1",
			userKey: "anonymous-install:healthy-history",
			identityKind: "anonymous" as const,
			projectKey: "project-poison-input",
			projectName: "project-poison-input",
			ide: "vscode" as const,
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 20,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 25,
		}
		await store.recordUsage(anonymousRecord)
		await store.recordUsage({
			...anonymousRecord,
			occurredAt: occurredAt + 5_000,
			userEmail: { malformed: true } as unknown as string,
			inputTokens: 7,
			outputTokens: 3,
			totalTokens: 10,
		})

		await expect(
			store.assignAnonymousRowsToConfiguredIdentity({ userEmail: "current-b@example.com" }),
		).resolves.toBe(1)
		const rows = await store.getPendingUploadRows()
		expect(rows).toHaveLength(2)
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userEmail: "current-b@example.com",
					requestCount: 1,
					totalTokens: 25,
				}),
				expect.objectContaining({
					userEmail: { malformed: true },
					requestCount: 1,
					totalTokens: 10,
					uploadIssueKind: "invalid",
					uploadIssueCode: "invalid_persisted_user_email",
				}),
			]),
		)
	})

	it("never changes a configured A identity when asked to assign anonymous facts to B", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 10 })

		await expect(store.assignAnonymousRowsToConfiguredIdentity({ userEmail: "user-b@example.com" })).resolves.toBe(
			0,
		)
		expect(await store.getPendingUploadRows()).toEqual([
			expect.objectContaining({
				userEmail: "glm7@example.com",
				userKey: "email:glm7@example.com",
				identityKind: "configured",
			}),
		])
	})

	it("derives configured keys from the email so a mismatched caller key cannot merge B into A", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 10 })
		await store.recordUsage({
			occurredAt: new Date("2026-03-19T09:00:05.000Z").getTime(),
			timezone: "Asia/Shanghai",
			userName: "User B",
			userEmail: "user-b@example.com",
			userKey: "email:glm7@example.com",
			identityKind: "configured",
			sourceIp: "127.0.0.1",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 20,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 25,
		})

		const rows = await store.getPendingUploadRows()
		expect(rows).toHaveLength(2)
		expect(rows.map((row) => [row.userEmail, row.userKey])).toEqual(
			expect.arrayContaining([
				["glm7@example.com", "email:glm7@example.com"],
				["user-b@example.com", "email:user-b@example.com"],
			]),
		)
	})

	it("never prunes an expired row before the server acknowledges it", async () => {
		await recordUsage("2020-01-01T09:00:00.000Z", { input: 40, output: 60 })
		await recordUsage(new Date().toISOString(), { input: 10, output: 5 })

		const pendingRows = await store.getPendingUploadRows()
		expect(pendingRows.some((row) => row.dateKey === "2020-01-01")).toBe(true)

		const expiredRow = pendingRows.find((row) => row.dateKey === "2020-01-01")
		expect(expiredRow).toBeDefined()
		await store.markRowsUploaded([expiredRow!])

		expect((await store.getPendingUploadRows()).some((row) => row.dateKey === "2020-01-01")).toBe(false)
	})

	it("saturates aggregate counters instead of persisting unsafe integers", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", {
			input: Number.MAX_SAFE_INTEGER,
			output: 0,
		})
		await recordUsage("2026-03-19T09:00:05.000Z", { input: 10, output: 5 })

		const [row] = await store.getPendingUploadRows()
		expect(row.inputTokens).toBe(Number.MAX_SAFE_INTEGER)
		expect(row.totalTokens).toBe(Number.MAX_SAFE_INTEGER)
	})

	it("reloads the last durable snapshot after a write failure", async () => {
		await store.getPendingUploadRows()
		const persistState = vi.spyOn(store as any, "persistState").mockRejectedValueOnce(new Error("disk full"))

		await expect(recordUsage("2026-03-19T09:00:00.000Z", { input: 10, output: 5 })).rejects.toThrow("disk full")
		persistState.mockRestore()

		expect(await store.getPendingUploadRows()).toHaveLength(0)
	})

	it("durably quarantines null, primitive, and field-type poison rows while retaining healthy rows", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })
		const statePath = path.join(tmpDir, "ai-token-usage", "v1", "state.json")
		const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			rows: Record<string, unknown>
			quarantinedRows?: Record<string, unknown>
		}
		const healthyRow = Object.values(persisted.rows)[0] as Record<string, unknown>
		persisted.rows["null-row"] = null
		persisted.rows["primitive-row"] = "legacy-poison"
		persisted.rows["object-email-row"] = {
			...healthyRow,
			key: "object-email-row",
			userName: "Historical A",
			userEmail: { historicalOwner: "user-a@example.com" },
			userKey: "anonymous-install:historical-a",
			identityKind: "anonymous",
		}
		persisted.rows["numeric-type-row"] = {
			...healthyRow,
			key: "numeric-type-row",
			requestCount: "1",
		}
		await fs.writeFile(statePath, JSON.stringify(persisted), "utf8")

		let recoveredStore = new AiTokenUsageStore(tmpDir)
		expect(await recoveredStore.getPendingUploadRows()).toEqual([
			expect.objectContaining({ projectKey: "project-alpha", inputTokens: 40, totalTokens: 100 }),
		])
		expect(await recoveredStore.getSummaryForRange({ type: "all" })).toEqual({
			inputTokens: 40,
			outputTokens: 60,
			totalTokens: 100,
		})
		const quarantinedRows = await recoveredStore.getQuarantinedRows()
		expect(quarantinedRows).toHaveLength(4)
		expect(quarantinedRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourceKey: "null-row", raw: null }),
				expect.objectContaining({ sourceKey: "primitive-row", raw: "legacy-poison" }),
				expect.objectContaining({
					sourceKey: "object-email-row",
					issueCode: "invalid_persisted_row_structure",
					raw: expect.objectContaining({
						userEmail: { historicalOwner: "user-a@example.com" },
						userKey: "anonymous-install:historical-a",
					}),
				}),
				expect.objectContaining({
					sourceKey: "numeric-type-row",
					raw: expect.objectContaining({ requestCount: "1" }),
				}),
			]),
		)
		expect(await recoveredStore.assignAnonymousRowsToConfiguredIdentity({ userEmail: "user-b@example.com" })).toBe(
			0,
		)

		const normalized = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			rows: Record<string, unknown>
			quarantinedRows: Record<string, unknown>
		}
		expect(Object.keys(normalized.rows)).toHaveLength(1)
		expect(Object.keys(normalized.quarantinedRows)).toHaveLength(4)

		recoveredStore = new AiTokenUsageStore(tmpDir)
		expect(await recoveredStore.getQuarantinedRows()).toEqual(quarantinedRows)
		expect(await recoveredStore.getQuarantinedRowCount()).toBe(4)
	})

	it("archives a corrupt state file instead of overwriting the only recovery evidence", async () => {
		const baseDir = path.join(tmpDir, "ai-token-usage", "v1")
		await fs.mkdir(baseDir, { recursive: true })
		await fs.writeFile(path.join(baseDir, "state.json"), "{not-json", "utf8")

		const recoveredStore = new AiTokenUsageStore(tmpDir)
		expect(await recoveredStore.getPendingUploadRows()).toHaveLength(0)
		expect((await fs.readdir(baseDir)).filter((name) => name.startsWith("state.json.corrupt-"))).toHaveLength(1)
	})

	it("recovers a fully written safe-write artifact before treating state as missing", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 40, output: 60 })
		const baseDir = path.join(tmpDir, "ai-token-usage", "v1")
		await fs.rename(
			path.join(baseDir, "state.json"),
			path.join(baseDir, ".state.json.new_1772500000000_recovery.tmp"),
		)

		const recoveredStore = new AiTokenUsageStore(tmpDir)

		expect(await recoveredStore.getSummaryForRange({ type: "all" })).toEqual({
			inputTokens: 40,
			outputTokens: 60,
			totalTokens: 100,
		})
	})

	it("does not merge dimensions that contain the legacy key delimiter", async () => {
		await recordUsage("2026-03-19T09:00:00.000Z", { input: 10, output: 5 }, { provider: "a::b", model: "c" })
		await recordUsage("2026-03-19T09:00:05.000Z", { input: 20, output: 10 }, { provider: "a", model: "b::c" })

		const rows = await store.getPendingUploadRows()
		expect(rows).toHaveLength(2)
		expect(rows.map((row) => [row.provider, row.model])).toEqual(
			expect.arrayContaining([
				["a", "b::c"],
				["a::b", "c"],
			]),
		)
	})

	it("merges read-modify-write updates from multiple extension hosts", async () => {
		const firstHost = new AiTokenUsageStore(tmpDir)
		const secondHost = new AiTokenUsageStore(tmpDir)
		await Promise.all([firstHost.getPendingUploadRows(), secondHost.getPendingUploadRows()])

		await recordUsage("2026-03-19T09:00:00.000Z", { input: 10, output: 5 }, {}, firstHost)
		await recordUsage("2026-03-19T09:00:05.000Z", { input: 20, output: 10 }, {}, secondHost)
		await recordUsage("2026-03-19T09:00:10.000Z", { input: 30, output: 15 }, {}, firstHost)

		const [persisted] = await new AiTokenUsageStore(tmpDir).getPendingUploadRows()
		expect(persisted).toMatchObject({
			requestCount: 3,
			inputTokens: 60,
			outputTokens: 30,
			totalTokens: 90,
			dirty: true,
		})
	})

	it("does not expose an in-flight aggregate before its state write commits", async () => {
		await store.getPendingUploadRows()
		const originalPersistState = (store as any).persistState.bind(store)
		let enterPersist!: () => void
		let releasePersist!: () => void
		const persistEntered = new Promise<void>((resolve) => {
			enterPersist = resolve
		})
		const persistReleased = new Promise<void>((resolve) => {
			releasePersist = resolve
		})
		const persistState = vi.spyOn(store as any, "persistState").mockImplementation(async () => {
			enterPersist()
			await persistReleased
			return originalPersistState()
		})

		const recordPromise = recordUsage("2026-03-19T09:00:00.000Z", { input: 10, output: 5 })
		await persistEntered
		let readSettled = false
		const readPromise = store.getPendingUploadRows().then((rows) => {
			readSettled = true
			return rows
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		const settledBeforeCommit = readSettled
		releasePersist()

		await recordPromise
		await expect(readPromise).resolves.toEqual([
			expect.objectContaining({
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
			}),
		])
		expect(settledBeforeCommit).toBe(false)
		persistState.mockRestore()
	})
})
