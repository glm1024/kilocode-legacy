import * as actualFsPromises from "fs/promises"
import * as fsSyncActual from "fs"
import { Writable } from "stream"
import * as path from "path"
import * as os from "os"

import { recoverSafeWriteJson, safeWriteJson, withCrossProcessFileLock } from "../safeWriteJson"

const originalFsPromisesRename = actualFsPromises.rename
const originalFsPromisesUnlink = actualFsPromises.unlink
const originalFsPromisesWriteFile = actualFsPromises.writeFile
const _originalFsPromisesAccess = actualFsPromises.access
const originalFsPromisesMkdir = actualFsPromises.mkdir

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	// Start with all actual implementations.
	const mockedFs = { ...actual }
	// Selectively wrap functions with vi.fn() if they are spied on
	// or have their implementations changed in tests.
	// This ensures that other fs.promises functions used by the SUT
	// (like proper-lockfile's internals) will use their actual implementations.
	mockedFs.writeFile = vi.fn(actual.writeFile) as any
	mockedFs.readFile = vi.fn(actual.readFile) as any
	mockedFs.rename = vi.fn(actual.rename) as any
	mockedFs.unlink = vi.fn(actual.unlink) as any
	mockedFs.access = vi.fn(actual.access) as any
	mockedFs.mkdtemp = vi.fn(actual.mkdtemp) as any
	mockedFs.rm = vi.fn(actual.rm) as any
	mockedFs.readdir = vi.fn(actual.readdir) as any
	mockedFs.mkdir = vi.fn(actual.mkdir) as any
	// fs.stat and fs.lstat will be available via { ...actual }

	return mockedFs
})

// Mock the 'fs' module for fsSync.createWriteStream
vi.mock("fs", async () => {
	const actualFs = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actualFs, // Spread actual implementations
		createWriteStream: vi.fn(actualFs.createWriteStream) as any, // Default to actual, but mockable
	}
})

import * as fs from "fs/promises" // This will now be the mocked version

describe("safeWriteJson", () => {
	let originalConsoleError: typeof console.error

	beforeAll(() => {
		// Store original console.error
		originalConsoleError = console.error
	})

	afterAll(() => {
		// Restore original console.error
		console.error = originalConsoleError
	})

	let tempDir: string
	let currentTestFilePath: string

	beforeEach(async () => {
		// Create a temporary directory for each test
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safeWriteJson-test-"))

		// Create a unique file path for each test
		currentTestFilePath = path.join(tempDir, "test-file.json")

		// Pre-create the file with initial content to ensure it exists
		// This allows proper-lockfile to acquire a lock on an existing file.
		await fs.writeFile(currentTestFilePath, JSON.stringify({ initial: "content" }))
	})

	afterEach(async () => {
		// Clean up the temporary directory after each test
		await fs.rm(tempDir, { recursive: true, force: true })

		// Reset all mocks to their actual implementations
		vi.restoreAllMocks()
	})

	// Helper function to read file content
	async function readFileContent(filePath: string): Promise<any> {
		const readContent = await fs.readFile(filePath, "utf-8")
		return JSON.parse(readContent)
	}

	// Helper function to check if a file exists
	async function fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}

	// Success Scenarios
	// Note: Since we pre-create the file in beforeEach, this test will overwrite it.
	// If "creation from non-existence" is critical and locking prevents it, safeWriteJson or locking strategy needs review.
	test("should successfully write a new file (overwriting initial content from beforeEach)", async () => {
		const data = { message: "Hello, new world!" }

		await safeWriteJson(currentTestFilePath, data)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(data)
	})

	test("should successfully overwrite an existing file", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "Updated content" }

		// Write initial data (overwriting the pre-created file from beforeEach)
		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		await safeWriteJson(currentTestFilePath, newData)

		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	test("opens data files writable when flushing them for Windows compatibility", async () => {
		const openSpy = vi.spyOn(fs, "open")

		await safeWriteJson(currentTestFilePath, { message: "writable fsync handle" })

		const dataSyncCalls = openSpy.mock.calls.filter(
			([filePath, flags]) =>
				flags === "r+" &&
				(path.resolve(String(filePath)) === path.resolve(currentTestFilePath) ||
					String(filePath).includes(".test-file.json.new_")),
		)
		expect(dataSyncCalls).toHaveLength(2)
		expect(
			openSpy.mock.calls.some(
				([filePath, flags]) => path.resolve(String(filePath)) === path.resolve(tempDir) && flags === "r",
			),
		).toBe(true)
	})

	test.runIf(process.platform !== "win32")(
		"fsyncs data and directory rename boundaries before deleting the backup",
		async () => {
			const probeHandle = await fs.open(currentTestFilePath, "r")
			const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as { sync: () => Promise<void> }
			await probeHandle.close()
			const syncSpy = vi.spyOn(fileHandlePrototype, "sync")
			const renameSpy = vi.spyOn(fs, "rename")
			const unlinkSpy = vi.spyOn(fs, "unlink")

			await safeWriteJson(currentTestFilePath, { message: "durability ordering" })

			const renameOrders = renameSpy.mock.invocationCallOrder
			expect(renameOrders).toHaveLength(2)
			const backupUnlinkIndex = unlinkSpy.mock.calls.findIndex(([filePath]) => String(filePath).includes(".bak_"))
			expect(backupUnlinkIndex).toBeGreaterThanOrEqual(0)
			const backupUnlinkOrder = unlinkSpy.mock.invocationCallOrder[backupUnlinkIndex]
			const syncOrders = syncSpy.mock.invocationCallOrder

			// The fully written new file, exact intent and their directory entries are
			// durable before the committed target is moved aside.
			expect(syncOrders.filter((order) => order < renameOrders[0])).toHaveLength(3)
			// The exact backup rename is durable before publishing the new target.
			expect(syncOrders.filter((order) => order > renameOrders[0] && order < renameOrders[1])).toHaveLength(1)
			// The committed file and its directory entry are durable before backup deletion.
			expect(syncOrders.filter((order) => order > renameOrders[1] && order < backupUnlinkOrder)).toHaveLength(2)
		},
	)

	test("retains the current and prior backup when directory fsync is unsupported", async () => {
		const oldBackupPath = path.join(tempDir, ".test-file.json.bak_100_old.tmp")
		const priorBackupPath = path.join(tempDir, ".test-file.json.bak_200_prior.tmp")
		await fs.writeFile(oldBackupPath, JSON.stringify({ generation: "old" }))
		await fs.writeFile(priorBackupPath, JSON.stringify({ generation: "prior" }))

		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.spyOn(fs, "open").mockImplementation(async (filePath: any, flags: any, mode?: any) => {
			const handle = await actual.open(filePath, flags, mode)
			if (path.resolve(String(filePath)) !== path.resolve(tempDir)) {
				return handle
			}
			return new Proxy(handle, {
				get(target, property) {
					if (property === "sync") {
						return async () => {
							const error = new Error("directory fsync unsupported") as NodeJS.ErrnoException
							error.code = "EINVAL"
							throw error
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})

		await safeWriteJson(currentTestFilePath, { message: "new committed content" })

		expect(await readFileContent(currentTestFilePath)).toEqual({ message: "new committed content" })
		expect(await fileExists(oldBackupPath)).toBe(false)
		expect(await readFileContent(priorBackupPath)).toEqual({ generation: "prior" })
		const backupNames = (await fs.readdir(tempDir)).filter(
			(name) => name.startsWith(".test-file.json.bak_") && name.endsWith(".tmp"),
		)
		expect(backupNames).toHaveLength(2)
		const retainedContents = await Promise.all(backupNames.map((name) => readFileContent(path.join(tempDir, name))))
		expect(retainedContents).toContainEqual({ initial: "content" })
		expect(retainedContents).toContainEqual({ generation: "prior" })
		expect(await fileExists(path.join(tempDir, ".test-file.json.write-intent.json"))).toBe(true)
	})

	test("serializes complete read-modify-write critical sections", async () => {
		const lockPath = path.join(tempDir, "shared-store")
		let activeOperations = 0
		let maxActiveOperations = 0
		const runOperation = async () =>
			withCrossProcessFileLock(lockPath, async () => {
				activeOperations += 1
				maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
				await new Promise((resolve) => setTimeout(resolve, 20))
				activeOperations -= 1
			})

		await Promise.all([runOperation(), runOperation(), runOperation()])

		expect(maxActiveOperations).toBe(1)
	})

	test("takes the healthy path without parsing a current file when no recovery artifact exists", async () => {
		const readFileSpy = vi.spyOn(fs, "readFile")

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("current")

		expect(readFileSpy).not.toHaveBeenCalled()
	})

	test("recovers the exact prepared new artifact after a crash leaves the target missing", async () => {
		const recoveredData = { message: "durable new content" }
		const candidatePath = path.join(tempDir, ".test-file.json.new_1772500000000_recovery.tmp")
		const backupName = ".test-file.json.bak_1772500000000_recovery.tmp"
		await fs.unlink(currentTestFilePath)
		await fs.writeFile(candidatePath, JSON.stringify(recoveredData))
		await fs.writeFile(
			path.join(tempDir, ".test-file.json.write-intent.json"),
			JSON.stringify({
				version: 1,
				state: "prepared",
				newFileName: path.basename(candidatePath),
				backupFileName: backupName,
			}),
		)

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("new")

		expect(await readFileContent(currentTestFilePath)).toEqual(recoveredData)
		expect(await fileExists(candidatePath)).toBe(false)
	})

	test("keeps a valid current written by a mixed-version client over a stale prepared intent", async () => {
		const laterCurrentData = { message: "later mixed-version content" }
		const pendingData = { message: "older prepared content" }
		const previousData = { message: "previous committed content" }
		const candidatePath = path.join(tempDir, ".test-file.json.new_1772500000002_recovery.tmp")
		const backupName = ".test-file.json.bak_1772500000002_recovery.tmp"
		const backupPath = path.join(tempDir, backupName)
		await fs.writeFile(currentTestFilePath, JSON.stringify(laterCurrentData))
		await fs.writeFile(candidatePath, JSON.stringify(pendingData))
		await fs.writeFile(backupPath, JSON.stringify(previousData))
		await fs.writeFile(
			path.join(tempDir, ".test-file.json.write-intent.json"),
			JSON.stringify({
				version: 1,
				newFileName: path.basename(candidatePath),
				backupFileName: backupName,
			}),
		)

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("current")

		expect(await readFileContent(currentTestFilePath)).toEqual(laterCurrentData)
		if (process.platform !== "win32") {
			expect(await fileExists(candidatePath)).toBe(false)
			expect(await fileExists(backupPath)).toBe(false)
		}
	})

	test("never lets an unmarked orphan new artifact replace a valid current file even if its clock is newer", async () => {
		const currentData = { message: "committed current content" }
		const orphanData = { message: "uncommitted orphan content" }
		const candidatePath = path.join(tempDir, ".test-file.json.new_1999999999999_orphan.tmp")
		await fs.writeFile(currentTestFilePath, JSON.stringify(currentData))
		await fs.writeFile(candidatePath, JSON.stringify(orphanData))
		const currentTime = new Date("2026-01-01T00:00:00.000Z")
		const futureOrphanTime = new Date("2036-01-01T00:00:00.000Z")
		await fs.utimes(currentTestFilePath, currentTime, currentTime)
		await fs.utimes(candidatePath, futureOrphanTime, futureOrphanTime)

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("current")

		expect(await readFileContent(currentTestFilePath)).toEqual(currentData)
		if (process.platform !== "win32") {
			expect(await fileExists(candidatePath)).toBe(false)
		} else {
			expect(await readFileContent(candidatePath)).toEqual(orphanData)
		}
	})

	test("keeps the committed target when intent remains after the new artifact was already renamed", async () => {
		const committedData = { message: "committed new content" }
		const previousData = { message: "previous committed content" }
		const newName = ".test-file.json.new_1772500000005_recovery.tmp"
		const backupName = ".test-file.json.bak_1772500000005_recovery.tmp"
		const intentPath = path.join(tempDir, ".test-file.json.write-intent.json")
		const backupPath = path.join(tempDir, backupName)
		await fs.writeFile(currentTestFilePath, JSON.stringify(committedData))
		await fs.writeFile(backupPath, JSON.stringify(previousData))
		await fs.writeFile(intentPath, JSON.stringify({ version: 1, newFileName: newName, backupFileName: backupName }))

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("current")

		expect(await readFileContent(currentTestFilePath)).toEqual(committedData)
		if (process.platform !== "win32") {
			expect(await fileExists(intentPath)).toBe(false)
			expect(await fileExists(backupPath)).toBe(false)
		}
	})

	test("keeps a newer valid target when an older new artifact is left behind", async () => {
		const currentData = { message: "newer committed content" }
		const staleCandidateData = { message: "stale interrupted content" }
		const candidatePath = path.join(tempDir, ".test-file.json.new_1772500000004_recovery.tmp")
		await fs.writeFile(candidatePath, JSON.stringify(staleCandidateData))
		await fs.writeFile(currentTestFilePath, JSON.stringify(currentData))
		const oldTime = new Date("2026-01-01T00:00:00.000Z")
		const newTime = new Date("2026-01-01T00:00:10.000Z")
		await fs.utimes(candidatePath, oldTime, oldTime)
		await fs.utimes(currentTestFilePath, newTime, newTime)

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("current")

		expect(await readFileContent(currentTestFilePath)).toEqual(currentData)
		if (process.platform !== "win32") {
			expect(await fileExists(candidatePath)).toBe(false)
		}
	})

	test("falls back to a valid backup when the new crash artifact is incomplete", async () => {
		const backupData = { message: "last committed content" }
		const newCandidatePath = path.join(tempDir, ".test-file.json.new_1772500000001_recovery.tmp")
		const backupCandidatePath = path.join(tempDir, ".test-file.json.bak_1772500000000_recovery.tmp")
		await fs.unlink(currentTestFilePath)
		await fs.writeFile(newCandidatePath, '{"message":')
		await fs.writeFile(backupCandidatePath, JSON.stringify(backupData))

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("backup")

		expect(await readFileContent(currentTestFilePath)).toEqual(backupData)
		expect(await fileExists(newCandidatePath)).toBe(true)
	})

	test("uses the intent's exact backup instead of a clock-newer retained backup", async () => {
		const exactBackupData = { message: "immediately previous committed content" }
		const staleBackupData = { message: "older retained content" }
		const exactBackupName = ".test-file.json.bak_100_exact.tmp"
		const staleBackupPath = path.join(tempDir, ".test-file.json.bak_999_stale.tmp")
		const exactBackupPath = path.join(tempDir, exactBackupName)
		await fs.unlink(currentTestFilePath)
		await fs.writeFile(exactBackupPath, JSON.stringify(exactBackupData))
		await fs.writeFile(staleBackupPath, JSON.stringify(staleBackupData))
		const oldTime = new Date("2026-01-01T00:00:00.000Z")
		const misleadingFutureTime = new Date("2036-01-01T00:00:00.000Z")
		await fs.utimes(exactBackupPath, oldTime, oldTime)
		await fs.utimes(staleBackupPath, misleadingFutureTime, misleadingFutureTime)
		await fs.writeFile(
			path.join(tempDir, ".test-file.json.write-intent.json"),
			JSON.stringify({
				version: 1,
				state: "prepared",
				newFileName: ".test-file.json.new_100_missing.tmp",
				backupFileName: exactBackupName,
			}),
		)

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("backup")

		expect(await readFileContent(currentTestFilePath)).toEqual(exactBackupData)
		expect(await readFileContent(staleBackupPath)).toEqual(staleBackupData)
	})

	test("recovers a valid backup when the current target is corrupt", async () => {
		const backupData = { message: "last committed content" }
		const backupCandidatePath = path.join(tempDir, ".test-file.json.bak_1772500000003_recovery.tmp")
		await fs.writeFile(currentTestFilePath, '{"message":')
		await fs.writeFile(backupCandidatePath, JSON.stringify(backupData))

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("backup")

		expect(await readFileContent(currentTestFilePath)).toEqual(backupData)
		expect(await fileExists(backupCandidatePath)).toBe(false)
	})

	test("uses a recovery artifact as the last valid fallback after recovery itself crashes", async () => {
		const recoveryData = { message: "last valid displaced current" }
		const recoveryPath = path.join(tempDir, ".test-file.json.recovery_1772500000006_recovery.tmp")
		await fs.unlink(currentTestFilePath)
		await fs.writeFile(recoveryPath, JSON.stringify(recoveryData))

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("recovery")

		expect(await readFileContent(currentTestFilePath)).toEqual(recoveryData)
		expect(await fileExists(recoveryPath)).toBe(false)
	})

	test("rethrows candidate promotion failure even when displaced current rollback succeeds", async () => {
		const backupData = { message: "last committed backup" }
		const backupName = ".test-file.json.bak_1772500000007_recovery.tmp"
		const backupPath = path.join(tempDir, backupName)
		const intentPath = path.join(tempDir, ".test-file.json.write-intent.json")
		await fs.writeFile(currentTestFilePath, '{"message":')
		await fs.writeFile(backupPath, JSON.stringify(backupData))
		await fs.writeFile(
			intentPath,
			JSON.stringify({
				version: 1,
				state: "prepared",
				newFileName: ".test-file.json.new_1772500000007_missing.tmp",
				backupFileName: backupName,
			}),
		)
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
			if (path.resolve(String(oldPath)) === path.resolve(backupPath)) {
				throw new Error("Candidate promotion failed")
			}
			return originalFsPromisesRename(oldPath, newPath)
		})

		await expect(recoverSafeWriteJson(currentTestFilePath)).rejects.toThrow("Candidate promotion failed")

		expect(await fs.readFile(currentTestFilePath, "utf8")).toBe('{"message":')
		expect(await readFileContent(backupPath)).toEqual(backupData)
		expect(await fileExists(intentPath)).toBe(true)

		renameSpy.mockRestore()
		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("backup")
		expect(await readFileContent(currentTestFilePath)).toEqual(backupData)
	})

	// Failure Scenarios
	test("should handle failure when writing to tempNewFilePath", async () => {
		// currentTestFilePath exists due to beforeEach, allowing lock acquisition.
		const data = { message: "test write failure" }

		const mockErrorStream = new Writable() as any
		mockErrorStream._write = (_chunk: any, _encoding: any, callback: any) => {
			callback(new Error("Write stream error"))
		}
		// Add missing WriteStream properties
		mockErrorStream.close = vi.fn()
		mockErrorStream.bytesWritten = 0
		mockErrorStream.path = ""
		mockErrorStream.pending = false

		// Mock createWriteStream to return a stream that errors on write
		;(fsSyncActual.createWriteStream as any).mockImplementationOnce((_path: any, _options: any) => {
			return mockErrorStream
		})

		await expect(safeWriteJson(currentTestFilePath, data)).rejects.toThrow("Write stream error")

		// Verify the original file still exists and is unchanged
		const exists = await fileExists(currentTestFilePath)
		expect(exists).toBe(true)

		// Verify content is unchanged (should still have the initial content from beforeEach)
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual({ initial: "content" })
	})

	test("should handle failure when renaming filePath to tempBackupFilePath (filePath exists)", async () => {
		const initialData = { message: "Initial content, should remain" }
		const newData = { message: "New content, should not be written" }

		// Overwrite the pre-created file with specific initial data
		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		const renameSpy = vi.spyOn(fs, "rename")

		// Mock rename to fail on the first call (filePath -> tempBackupFilePath)
		renameSpy.mockImplementationOnce(async () => {
			throw new Error("Rename to backup failed")
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename to backup failed")

		// Verify the original file still exists with initial content
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
	})

	test("should handle failure when renaming tempNewFilePath to filePath (filePath exists, backup succeeded)", async () => {
		const initialData = { message: "Initial content, should be restored" }
		const newData = { message: "New content" }

		// Overwrite the pre-created file with specific initial data
		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		const renameSpy = vi.spyOn(fs, "rename")

		// Track rename calls
		let renameCallCount = 0

		// Mock rename to succeed on first call (filePath -> tempBackupFilePath)
		// and fail on second call (tempNewFilePath -> filePath)
		renameSpy.mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 1) {
				// First call: filePath -> tempBackupFilePath (should succeed)
				return originalFsPromisesRename(oldPath, newPath)
			} else if (renameCallCount === 2) {
				// Second call: tempNewFilePath -> filePath (should fail)
				throw new Error("Rename from temp to final failed")
			} else if (renameCallCount === 3) {
				// Third call: tempBackupFilePath -> filePath (rollback, should succeed)
				return originalFsPromisesRename(oldPath, newPath)
			}
			// Default: use original implementation
			return originalFsPromisesRename(oldPath, newPath)
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename from temp to final failed")

		// Verify the file was restored to initial content
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
	})

	// Tests for directory creation functionality
	test("should create parent directory if it doesn't exist", async () => {
		// Create a path in a non-existent subdirectory of the temp dir
		const subDir = path.join(tempDir, "new-subdir")
		const filePath = path.join(subDir, "file.json")
		const data = { test: "directory creation" }

		// Verify directory doesn't exist
		await expect(fs.access(subDir)).rejects.toThrow()

		// Write file
		await safeWriteJson(filePath, data)

		// Verify directory was created
		await expect(fs.access(subDir)).resolves.toBeUndefined()

		// Verify file was written
		const content = await readFileContent(filePath)
		expect(content).toEqual(data)
	})

	test("should handle multi-level directory creation", async () => {
		// Create a new non-existent subdirectory path with multiple levels
		const deepDir = path.join(tempDir, "level1", "level2", "level3")
		const filePath = path.join(deepDir, "deep-file.json")
		const data = { nested: "deeply" }

		// Verify none of the directories exist
		await expect(fs.access(path.join(tempDir, "level1"))).rejects.toThrow()

		// Write file
		await safeWriteJson(filePath, data)

		// Verify all directories were created
		await expect(fs.access(path.join(tempDir, "level1"))).resolves.toBeUndefined()
		await expect(fs.access(path.join(tempDir, "level1", "level2"))).resolves.toBeUndefined()
		await expect(fs.access(deepDir)).resolves.toBeUndefined()

		// Verify file was written
		const content = await readFileContent(filePath)
		expect(content).toEqual(data)
	})

	test("should handle directory creation permission errors", async () => {
		// Mock mkdir to simulate a permission error
		const mkdirSpy = vi.spyOn(fs, "mkdir")
		mkdirSpy.mockImplementationOnce(async () => {
			const error = new Error("EACCES: permission denied") as any
			error.code = "EACCES"
			throw error
		})

		const subDir = path.join(tempDir, "forbidden-dir")
		const filePath = path.join(subDir, "file.json")
		const data = { test: "permission error" }

		// Should throw the permission error
		await expect(safeWriteJson(filePath, data)).rejects.toThrow("EACCES: permission denied")

		// Verify directory was not created
		await expect(fs.access(subDir)).rejects.toThrow()
	})

	test("should successfully write to a non-existent file in an existing directory", async () => {
		// Create directory but not the file
		const subDir = path.join(tempDir, "existing-dir")
		await fs.mkdir(subDir)

		const filePath = path.join(subDir, "new-file.json")
		const data = { fresh: "file" }

		// Verify file doesn't exist yet
		await expect(fs.access(filePath)).rejects.toThrow()

		// Write file
		await safeWriteJson(filePath, data)

		// Verify file was created with correct content
		const content = await readFileContent(filePath)
		expect(content).toEqual(data)
	})

	test("should handle failure when deleting tempBackupFilePath (filePath exists, all renames succeed)", async () => {
		const initialData = { message: "Initial content" }
		const newData = { message: "Successfully written new content" }

		// Overwrite the pre-created file with specific initial data
		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		const unlinkSpy = vi.spyOn(fs, "unlink")

		// Mock unlink to fail when trying to delete the backup file
		unlinkSpy.mockImplementationOnce(async () => {
			throw new Error("Failed to delete backup file")
		})

		// The write should succeed even if backup deletion fails
		await safeWriteJson(currentTestFilePath, newData)

		// Verify the new content was written successfully
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(newData)
	})

	// Test for console error suppression during backup deletion
	test("should suppress console.error when backup deletion fails", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error
		const initialData = { message: "Initial" }
		const newData = { message: "New" }

		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		// Mock unlink to fail when deleting backup files
		const unlinkSpy = vi.spyOn(fs, "unlink")
		unlinkSpy.mockImplementation(async (filePath: any) => {
			if (filePath.toString().includes(".bak_")) {
				throw new Error("Backup deletion failed")
			}
			return originalFsPromisesUnlink(filePath)
		})

		await safeWriteJson(currentTestFilePath, newData)

		// Verify console.error was called with the expected message
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Successfully wrote"), expect.any(Error))

		consoleErrorSpy.mockRestore()
		unlinkSpy.mockRestore()
	})

	// The expected error message might need to change if the mock behaves differently.
	test("should handle failure when renaming tempNewFilePath to filePath (filePath initially exists)", async () => {
		// currentTestFilePath exists due to beforeEach.
		const initialData = { message: "Initial content" }
		const newData = { message: "New content" }

		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		const renameSpy = vi.spyOn(fs, "rename")
		// Mock rename to fail on the second call (tempNewFilePath -> filePath)
		// This test assumes that the first rename (filePath -> tempBackupFilePath) succeeds,
		// which is the expected behavior when the file exists.
		// The existing complex mock in `test("should handle failure when renaming tempNewFilePath to filePath (filePath exists, backup succeeded)"`
		// might be more relevant or adaptable here.

		let renameCallCount = 0
		renameSpy.mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 2) {
				// Second call: tempNewFilePath -> filePath (should fail)
				throw new Error("Rename failed")
			}
			// For all other calls, use the original implementation
			return originalFsPromisesRename(oldPath, newPath)
		})

		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Rename failed")

		// The file should be restored to its initial content
		const content = await readFileContent(currentTestFilePath)
		expect(content).toEqual(initialData)
	})

	test("should throw an error if an inter-process lock is already held for the filePath", async () => {
		vi.resetModules() // Clear module cache to ensure fresh imports for this test

		const data = { message: "test lock failure" }

		// Create a new file path for this specific test to avoid conflicts
		const lockTestFilePath = path.join(tempDir, "lock-test-file.json")
		await fs.writeFile(lockTestFilePath, JSON.stringify({ initial: "lock test content" }))

		vi.doMock("proper-lockfile", () => ({
			...vi.importActual("proper-lockfile"),
			lock: vi.fn().mockRejectedValueOnce(new Error("Failed to get lock.")),
		}))

		// Re-import safeWriteJson to use the mocked proper-lockfile
		const { safeWriteJson: mockedSafeWriteJson } = await import("../safeWriteJson")

		await expect(mockedSafeWriteJson(lockTestFilePath, data)).rejects.toThrow("Failed to get lock.")

		// Clean up
		await fs.unlink(lockTestFilePath).catch(() => {}) // Ignore errors if file doesn't exist
		vi.doUnmock("proper-lockfile") // Ensure the mock is removed after this test
	})
	test("should release lock even if an error occurs mid-operation", async () => {
		const data = { message: "test lock release on error" }

		// Mock createWriteStream to throw an error
		const createWriteStreamSpy = vi.spyOn(fsSyncActual, "createWriteStream")
		createWriteStreamSpy.mockImplementationOnce((_path: any, _options: any) => {
			const errorStream = new Writable() as any
			errorStream._write = (_chunk: any, _encoding: any, callback: any) => {
				callback(new Error("Stream write error"))
			}
			// Add missing WriteStream properties
			errorStream.close = vi.fn()
			errorStream.bytesWritten = 0
			errorStream.path = _path
			errorStream.pending = false
			return errorStream
		})

		// This should throw but still release the lock
		await expect(safeWriteJson(currentTestFilePath, data)).rejects.toThrow("Stream write error")

		// Reset the mock to allow the second call to work normally
		createWriteStreamSpy.mockRestore()

		// If the lock wasn't released, this second attempt would fail with a lock error
		// Instead, it should succeed (proving the lock was released)
		await expect(safeWriteJson(currentTestFilePath, data)).resolves.toBeUndefined()
	})

	test("should handle fs.access error that is not ENOENT", async () => {
		const data = { message: "access error test" }
		const accessSpy = vi.spyOn(fs, "access").mockImplementationOnce(async () => {
			const error = new Error("EACCES: permission denied") as any
			error.code = "EACCES"
			throw error
		})

		// Create a path that will trigger the access check
		const testPath = path.join(tempDir, "access-error-test.json")

		await expect(safeWriteJson(testPath, data)).rejects.toThrow("EACCES: permission denied")

		// Verify access was called
		expect(accessSpy).toHaveBeenCalled()
	})

	// Test for rollback failure scenario
	test("retains and recovers the committed backup if rollback and new-file cleanup fail", async () => {
		const initialData = { message: "Initial committed content" }
		const newData = { message: "New content" }

		await originalFsPromisesWriteFile(currentTestFilePath, JSON.stringify(initialData))

		const renameSpy = vi.spyOn(fs, "rename")
		vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
			if (String(filePath).includes(".new_")) {
				throw new Error("New artifact cleanup failed")
			}
			return originalFsPromisesUnlink(filePath)
		})
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // Suppress console.error

		let renameCallCount = 0
		renameSpy.mockImplementation(async (oldPath, newPath) => {
			renameCallCount++
			if (renameCallCount === 2) {
				// Second call: tempNewFilePath -> filePath (fail)
				throw new Error("Primary rename failed")
			} else if (renameCallCount === 3) {
				// Third call: tempBackupFilePath -> filePath (rollback, also fail)
				throw new Error("Rollback rename failed")
			}
			return originalFsPromisesRename(oldPath, newPath)
		})

		// Should throw the original error, not the rollback error
		await expect(safeWriteJson(currentTestFilePath, newData)).rejects.toThrow("Primary rename failed")

		// Verify console.error was called for the rollback failure
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to restore backup"),
			expect.objectContaining({ message: "Rollback rename failed" }),
		)
		const backupName = (await fs.readdir(tempDir)).find(
			(name) => name.startsWith(".test-file.json.bak_") && name.endsWith(".tmp"),
		)
		expect(backupName).toBeDefined()
		expect(await readFileContent(path.join(tempDir, backupName!))).toEqual(initialData)
		expect(
			(await fs.readdir(tempDir)).some(
				(name) => name.startsWith(".test-file.json.new_") && name.endsWith(".tmp"),
			),
		).toBe(true)

		await expect(recoverSafeWriteJson(currentTestFilePath)).resolves.toBe("backup")
		expect(await readFileContent(currentTestFilePath)).toEqual(initialData)

		consoleErrorSpy.mockRestore()
	})

	test("uses the same legacy-compatible lease for target writes and recovery", async () => {
		vi.resetModules()
		const lock = vi.fn().mockImplementation(async () => vi.fn().mockResolvedValue(undefined))
		vi.doMock("proper-lockfile", () => ({ lock }))

		try {
			const { recoverSafeWriteJson: recoverWithMockedLock, safeWriteJson: safeWriteWithMockedLock } =
				await import("../safeWriteJson")
			await safeWriteWithMockedLock(currentTestFilePath, { message: "uniform target lease" })
			await recoverWithMockedLock(currentTestFilePath)

			expect(lock).toHaveBeenCalledTimes(2)
			const selectLease = (options: any) => ({
				stale: options.stale,
				update: options.update,
				realpath: options.realpath,
				retries: options.retries,
			})
			expect(selectLease(lock.mock.calls[0][1])).toEqual(selectLease(lock.mock.calls[1][1]))
			expect(selectLease(lock.mock.calls[0][1])).toEqual({
				stale: 31_000,
				update: 10_000,
				realpath: false,
				retries: {
					retries: 5,
					factor: 1.5,
					minTimeout: 25,
					maxTimeout: 1_000,
					randomize: true,
				},
			})
		} finally {
			vi.doUnmock("proper-lockfile")
			vi.resetModules()
		}
	})

	test("rejects a committed write when releasing its lock fails", async () => {
		vi.resetModules()
		const releaseError = new Error("Release failed after commit")
		const releaseLock = vi.fn().mockRejectedValue(releaseError)
		vi.doMock("proper-lockfile", () => ({
			lock: vi.fn().mockResolvedValue(releaseLock),
		}))

		try {
			const { safeWriteJson: safeWriteWithFailingRelease } = await import("../safeWriteJson")
			await expect(
				safeWriteWithFailingRelease(currentTestFilePath, { message: "committed before release failure" }),
			).rejects.toThrow("Release failed after commit")
			expect(releaseLock).toHaveBeenCalledOnce()
			expect(await readFileContent(currentTestFilePath)).toEqual({
				message: "committed before release failure",
			})
		} finally {
			vi.doUnmock("proper-lockfile")
			vi.resetModules()
		}
	})

	test("preserves the primary mutation error when lock release also fails", async () => {
		vi.resetModules()
		const primaryError = new Error("Primary write failure")
		const releaseError = new Error("Release failed after mutation failure")
		const releaseLock = vi.fn().mockRejectedValue(releaseError)
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.doMock("proper-lockfile", () => ({
			lock: vi.fn().mockResolvedValue(releaseLock),
		}))
		vi.doMock("fs/promises", async () => {
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			return {
				...actual,
				rename: vi.fn().mockRejectedValue(primaryError),
			}
		})

		try {
			const { safeWriteJson: safeWriteWithTwoFailures } = await import("../safeWriteJson")
			await expect(safeWriteWithTwoFailures(currentTestFilePath, { message: "must not commit" })).rejects.toThrow(
				"Primary write failure",
			)
			expect(releaseLock).toHaveBeenCalledOnce()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to release lock"),
				releaseError,
			)
		} finally {
			vi.doUnmock("proper-lockfile")
			vi.doUnmock("fs/promises")
			vi.resetModules()
		}
	})
})
