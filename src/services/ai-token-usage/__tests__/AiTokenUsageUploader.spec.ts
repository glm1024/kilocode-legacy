import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { createHash } from "crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setFetchRetryFactorForTests } from "../../../shared/http"
import { AiTokenUsageStore } from "../AiTokenUsageStore"
import { AiTokenUsageUploader } from "../AiTokenUsageUploader"
import { toLocalDateKey, type AiTokenUsageAggregateRow, type AiTokenUsageRecordInput } from "../types"

const buildUsageRecord = (overrides: Partial<AiTokenUsageRecordInput> = {}): AiTokenUsageRecordInput => ({
	occurredAt: overrides.occurredAt ?? Date.now(),
	timezone: overrides.timezone ?? "Asia/Shanghai",
	userName: overrides.userName ?? "alice",
	userEmail: Object.prototype.hasOwnProperty.call(overrides, "userEmail") ? overrides.userEmail : "alice@example.com",
	sourceIp: overrides.sourceIp ?? "203.0.113.7",
	userKey: overrides.userKey ?? "email:alice@example.com",
	projectKey: overrides.projectKey ?? "project-alpha",
	projectName: overrides.projectName ?? overrides.projectKey ?? "project-alpha",
	repoRoot: overrides.repoRoot ?? "/workspace/project-alpha",
	gitRemoteUrl: overrides.gitRemoteUrl ?? "https://github.com/example/project-alpha.git",
	gitBranch: overrides.gitBranch ?? "main",
	ide: overrides.ide ?? "vscode",
	provider: overrides.provider ?? "openai",
	model: overrides.model ?? "gpt-5.4",
	requestCount: overrides.requestCount ?? 1,
	inputTokens: overrides.inputTokens ?? 120,
	outputTokens: overrides.outputTokens ?? 80,
	cacheReadTokens: overrides.cacheReadTokens ?? 10,
	cacheWriteTokens: overrides.cacheWriteTokens ?? 5,
	totalTokens: overrides.totalTokens ?? 200,
	departmentName: overrides.departmentName,
	officeName: overrides.officeName,
	teamName: overrides.teamName,
	organizationId: overrides.organizationId,
	organizationName: overrides.organizationName,
})

const acceptedResponseForRequest = async (_url: string, init?: RequestInit): Promise<Response> => {
	const rawBody = String(init?.body)
	const body = JSON.parse(rawBody)
	return new Response(
		JSON.stringify({
			accepted: true,
			kind: "envelope",
			insertedEvents: body.rows.length,
			duplicateEvents: 0,
			payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
		}),
		{ status: 200 },
	)
}

describe("AiTokenUsageUploader", () => {
	let tmpDir: string
	let store: AiTokenUsageStore
	let uploader: AiTokenUsageUploader
	let unsetRetryFactor: (() => void) | undefined

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-usage-uploader-"))
		store = new AiTokenUsageStore(tmpDir)
		uploader = new AiTokenUsageUploader(store)
		unsetRetryFactor = setFetchRetryFactorForTests().unset
	})

	afterEach(() => {
		unsetRetryFactor?.()
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("uploads dirty rows for the current day on commit-triggered uploads", async () => {
		const occurredAt = Date.now()
		await store.recordUsage({
			occurredAt,
			timezone: "Asia/Shanghai",
			userName: "alice",
			userEmail: "alice@example.com",
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			sourceIp: "203.0.113.7",
			userKey: "email:alice@example.com",
			organizationId: "org-1",
			organizationName: "Example Org",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			gitRemoteUrl: "https://github.com/example/project-alpha.git",
			gitBranch: "main",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 120,
			outputTokens: 80,
			cacheReadTokens: 10,
			cacheWriteTokens: 5,
			totalTokens: 200,
		})

		const pendingBeforeUpload = await store.getPendingUploadRows()
		expect(pendingBeforeUpload).toHaveLength(1)
		expect(pendingBeforeUpload[0].dateKey).toBe(toLocalDateKey(occurredAt))

		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ webhookUrl: "https://example.com/webhook" },
			{
				client: { ide: "vscode", machineId: "machine-1" },
			},
		)

		expect(result.uploaded).toBe(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
		expect(requestInit?.body).toEqual(expect.any(String))
		const payload = JSON.parse(requestInit?.body as string)
		expect(payload.rows).toHaveLength(1)
		expect(payload.rows[0]).toMatchObject({
			dateKey: toLocalDateKey(occurredAt),
			userName: "alice",
			userEmail: "alice@example.com",
			departmentName: "云存储研发部",
			officeName: "架设处",
			teamName: "研发一组",
			sourceIp: "203.0.113.7",
			userKey: "email:alice@example.com",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			gitRemoteUrl: "https://github.com/example/project-alpha.git",
			provider: "openai",
			model: "gpt-5.4",
			totalTokens: 200,
		})
		expect(payload.rows[0]).not.toHaveProperty("gitBranch")

		expect(await store.getPendingUploadRows()).toHaveLength(0)
	})

	it("batches against the complete serialized token envelope", async () => {
		const occurredAt = Date.now()
		await store.recordUsage(
			buildUsageRecord({
				occurredAt,
				projectKey: "project-envelope-a",
				repoRoot: `/workspace/${"a".repeat(600)}`,
			}),
		)
		await store.recordUsage(
			buildUsageRecord({
				occurredAt,
				projectKey: "project-envelope-b",
				repoRoot: `/workspace/${"b".repeat(600)}`,
			}),
		)
		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		const result = await uploader.upload(
			{ webhookUrl: "https://example.com/webhook" },
			{
				client: { ide: "vscode", machineId: "machine-1" },
				maxPayloadBytes: 1800,
			},
		)

		expect(result).toEqual({ uploaded: 2, blocked: 0, invalid: 0 })
		expect(fetchMock).toHaveBeenCalledTimes(2)
		for (const call of fetchMock.mock.calls) {
			const serializedBody = call[1]?.body as string
			expect(Buffer.byteLength(serializedBody, "utf8")).toBeLessThanOrEqual(1800)
			expect(JSON.parse(serializedBody).rows).toHaveLength(1)
		}
		expect(await store.getPendingUploadRows()).toHaveLength(0)
	})

	it("isolates an overlong finite token dimension without blocking later rows", async () => {
		const occurredAt = Date.now()
		await store.recordUsage(
			buildUsageRecord({
				occurredAt,
				projectKey: "a-overlong-dimension",
				userName: "x".repeat(256),
			}),
		)
		await store.recordUsage(
			buildUsageRecord({
				occurredAt,
				projectKey: "z-valid-after-overlong",
			}),
		)
		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 1, blocked: 0, invalid: 1 })
		const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
		expect(body.rows.map((row: { projectKey: string }) => row.projectKey)).toEqual(["z-valid-after-overlong"])
		const [invalidRow] = await store.getPendingUploadRows()
		expect(invalidRow).toMatchObject({
			projectKey: "a-overlong-dimension",
			uploadIssueKind: "invalid",
			uploadIssueCode: "dimension_exceeds_protocol_limit",
		})
		const firstIssueAt = invalidRow.uploadIssueAt
		expect(
			await uploader.upload(
				{ webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 0, blocked: 0, invalid: 1 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await store.getPendingUploadRows())[0].uploadIssueAt).toBe(firstIssueAt)
	})

	it.each(["a timestamp outside the database range", "a reversed occurrence window"])(
		"isolates %s without blocking later token rows",
		async (label) => {
			const occurredAt = Date.now()
			await store.recordUsage(
				buildUsageRecord({
					occurredAt,
					projectKey: "a-invalid-timestamp",
				}),
			)
			await store.recordUsage(
				buildUsageRecord({
					occurredAt,
					projectKey: "z-valid-after-invalid-timestamp",
				}),
			)
			const statePath = path.join(tmpDir, "ai-token-usage", "v1", "state.json")
			const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
				rows: Record<string, AiTokenUsageAggregateRow>
			}
			const invalidRow = Object.values(persisted.rows).find((row) => row.projectKey === "a-invalid-timestamp")
			expect(invalidRow).toBeDefined()
			if (label === "a timestamp outside the database range") {
				invalidRow!.firstOccurredAt = Date.parse("1000-01-01T00:00:00.000Z")
				invalidRow!.lastOccurredAt = Date.parse("1000-01-01T00:00:00.000Z")
			} else {
				invalidRow!.firstOccurredAt = occurredAt + 1
				invalidRow!.lastOccurredAt = occurredAt
			}
			await fs.writeFile(statePath, JSON.stringify(persisted), "utf8")
			store = new AiTokenUsageStore(tmpDir)
			uploader = new AiTokenUsageUploader(store)
			const fetchMock = vi.fn(acceptedResponseForRequest)
			vi.stubGlobal("fetch", fetchMock)

			expect(
				await uploader.upload(
					{ webhookUrl: "https://example.com/webhook" },
					{ client: { ide: "vscode", machineId: "machine-1" } },
				),
			).toEqual({ uploaded: 1, blocked: 0, invalid: 1 })
			const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
			expect(body.rows.map((row: { projectKey: string }) => row.projectKey)).toEqual([
				"z-valid-after-invalid-timestamp",
			])
			expect(await store.getPendingUploadRows()).toEqual([
				expect.objectContaining({
					projectKey: "a-invalid-timestamp",
					uploadIssueKind: "invalid",
					uploadIssueCode:
						label === "a timestamp outside the database range"
							? "timestamp_outside_database_range"
							: "reversed_occurrence_window",
				}),
			])
		},
	)

	it("isolates a single row larger than the envelope budget without blocking later rows", async () => {
		const occurredAt = Date.now()
		await store.recordUsage(
			buildUsageRecord({
				occurredAt,
				projectKey: "a-oversized-envelope",
				repoRoot: `/${"x".repeat(4095)}`,
			}),
		)
		await store.recordUsage(
			buildUsageRecord({
				occurredAt,
				projectKey: "z-valid-after-oversized-envelope",
			}),
		)
		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ webhookUrl: "https://example.com/webhook" },
				{
					client: { ide: "vscode", machineId: "machine-1" },
					maxPayloadBytes: 1600,
				},
			),
		).toEqual({ uploaded: 1, blocked: 0, invalid: 1 })
		const serializedBody = fetchMock.mock.calls[0][1]?.body as string
		expect(Buffer.byteLength(serializedBody, "utf8")).toBeLessThanOrEqual(1600)
		expect(JSON.parse(serializedBody).rows[0].projectKey).toBe("z-valid-after-oversized-envelope")
		expect(await store.getPendingUploadRows()).toEqual([
			expect.objectContaining({
				projectKey: "a-oversized-envelope",
				uploadIssueKind: "invalid",
				uploadIssueCode: "row_exceeds_envelope_budget",
			}),
		])
	})

	it("persists a negative legacy counter as permanently invalid instead of letting the backend clamp it", async () => {
		await store.recordUsage(buildUsageRecord({ projectKey: "negative-counter" }))
		const statePath = path.join(tmpDir, "ai-token-usage", "v1", "state.json")
		const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
			rows: Record<string, AiTokenUsageAggregateRow>
		}
		Object.values(persisted.rows)[0].inputTokens = -1
		await fs.writeFile(statePath, JSON.stringify(persisted), "utf8")
		store = new AiTokenUsageStore(tmpDir)
		uploader = new AiTokenUsageUploader(store)
		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 0, blocked: 0, invalid: 1 })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getPendingUploadRows()).toEqual([
			expect.objectContaining({
				uploadIssueKind: "invalid",
				uploadIssueCode: "negative_token_counter",
			}),
		])
	})

	it("retains anonymous rows as blocked, then assigns only those rows after email configuration", async () => {
		await store.recordUsage(
			buildUsageRecord({
				userEmail: undefined,
				userKey: "anonymous-install:stable-install",
				identityKind: "anonymous",
			}),
		)
		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ webhookUrl: "https://example.com/webhook" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 0, blocked: 1, invalid: 0 })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await store.getPendingUploadRows()).toEqual([
			expect.objectContaining({
				identityKind: "anonymous",
				uploadIssueKind: "blocked",
				uploadIssueCode: "missing_configured_user_email",
			}),
		])

		expect(
			await uploader.upload(
				{
					webhookUrl: "https://example.com/webhook",
					userEmail: "configured@example.com",
					userName: "Configured User",
				},
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 1, blocked: 0, invalid: 0 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).rows[0]).toMatchObject({
			userEmail: "configured@example.com",
			userKey: "email:configured@example.com",
			userName: "Configured User",
		})
		expect(await store.getPendingUploadRows()).toHaveLength(0)
	})

	it("never rewrites a row already assigned to user A when current settings contain user B", async () => {
		await store.recordUsage(
			buildUsageRecord({
				userEmail: "user-a@example.com",
				userKey: "email:user-a@example.com",
				identityKind: "configured",
			}),
		)
		const fetchMock = vi.fn(acceptedResponseForRequest)
		vi.stubGlobal("fetch", fetchMock)

		expect(
			await uploader.upload(
				{ webhookUrl: "https://example.com/webhook", userEmail: "user-b@example.com" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).toEqual({ uploaded: 1, blocked: 0, invalid: 0 })
		expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).rows[0]).toMatchObject({
			userEmail: "user-a@example.com",
			userKey: "email:user-a@example.com",
		})
	})

	it.each([
		["an explicit rejection", JSON.stringify({ accepted: false })],
		["a non-JSON success body", "ok"],
		[
			"an acknowledgement for the webhook-test route",
			JSON.stringify({ accepted: true, kind: "webhook_test", insertedEvents: 0, duplicateEvents: 0 }),
		],
		[
			"an acknowledgement with the wrong row count",
			JSON.stringify({ accepted: true, kind: "envelope", insertedEvents: 0, duplicateEvents: 0 }),
		],
		[
			"an acknowledgement without the request digest",
			JSON.stringify({ accepted: true, kind: "envelope", insertedEvents: 1, duplicateEvents: 0 }),
		],
		[
			"an acknowledgement for another request body",
			JSON.stringify({
				accepted: true,
				kind: "envelope",
				insertedEvents: 1,
				duplicateEvents: 0,
				payloadSha256: "0".repeat(64),
			}),
		],
	])("keeps rows dirty when a 2xx response contains %s", async (_label, responseBody) => {
		await store.recordUsage({
			occurredAt: Date.now(),
			timezone: "Asia/Shanghai",
			userName: "alice",
			userEmail: "alice@example.com",
			sourceIp: "203.0.113.7",
			userKey: "email:alice@example.com",
			projectKey: "project-alpha",
			projectName: "project-alpha",
			repoRoot: "/workspace/project-alpha",
			ide: "vscode",
			provider: "openai",
			model: "gpt-5.4",
			requestCount: 1,
			inputTokens: 12,
			outputTokens: 8,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 20,
		})
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(responseBody, { status: 200 })))

		await expect(
			uploader.upload(
				{ webhookUrl: "https://example.com/webhook", userEmail: "fallback@example.com" },
				{ client: { ide: "vscode", machineId: "machine-1" } },
			),
		).rejects.toThrow(/acknowledgement|not accepted/)
		expect(await store.getPendingUploadRows()).toHaveLength(1)
	})
})
