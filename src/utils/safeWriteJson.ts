import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import Disassembler from "stream-json/Disassembler"
import Stringer from "stream-json/Stringer"

type SafeWriteRecoveryResult = "current" | "new" | "backup" | "recovery" | "none"

const SAFE_WRITE_INTENT_VERSION = 1 as const
const STORE_LOCK_STALE_MS = 120_000
const STORE_LOCK_UPDATE_MS = 10_000
const STORE_LOCK_RETRIES = 20
// Keep the per-target lease compatible with already deployed safeWriteJson
// clients. A newer 120s target lease can otherwise be stolen after 31s by an
// older extension host that still uses the legacy threshold.
const TARGET_LOCK_STALE_MS = 31_000
const TARGET_LOCK_UPDATE_MS = 10_000
const TARGET_LOCK_RETRIES = 5

interface SafeWriteIntent {
	version: typeof SAFE_WRITE_INTENT_VERSION
	state: "prepared" | "aborted"
	newFileName: string
	backupFileName: string
}

interface CrossProcessFileLockOptions {
	staleMs?: number
	updateMs?: number
	retries?: number
}

/**
 * Runs a complete read/modify/write operation under one inter-process lock.
 *
 * `safeWriteJson` locks an individual destination while it is replaced, but
 * that is intentionally narrower than a store transaction: two extension
 * hosts can both read the same old snapshot and then safely overwrite each
 * other with different new snapshots. Stores use this helper around the whole
 * operation so the read and every related write share one critical section.
 */
async function withCrossProcessFileLock<T>(
	lockPath: string,
	operation: () => Promise<T>,
	options: CrossProcessFileLockOptions = {},
): Promise<T> {
	const absoluteLockPath = path.resolve(lockPath)
	await fs.mkdir(path.dirname(absoluteLockPath), { recursive: true })

	let releaseLock: (() => Promise<void>) | undefined
	let operationFailed = false
	let operationError: unknown
	let result: T
	try {
		releaseLock = await lockfile.lock(absoluteLockPath, {
			stale: options.staleMs ?? STORE_LOCK_STALE_MS,
			update: options.updateMs ?? STORE_LOCK_UPDATE_MS,
			realpath: false,
			retries: {
				retries: options.retries ?? STORE_LOCK_RETRIES,
				factor: 1.5,
				minTimeout: 25,
				maxTimeout: 1_000,
				randomize: true,
			},
		})
		result = await operation()
	} catch (error) {
		operationFailed = true
		operationError = error
	}

	try {
		await releaseLock?.()
	} catch (releaseError) {
		if (!operationFailed) {
			throw releaseError
		}
		console.error(`Failed to release cross-process lock for ${absoluteLockPath}:`, releaseError)
	}
	if (operationFailed) {
		throw operationError
	}
	return result!
}

/**
 * Recovers the durable artifacts left if a process exits between safeWriteJson's
 * backup and commit renames. Only the `.new` file named by a valid write intent
 * can supersede a valid current target; a valid backup is the fallback when the
 * current target is missing or corrupt. Invalid artifacts are retained for
 * forensics.
 */
async function recoverSafeWriteJson(filePath: string): Promise<SafeWriteRecoveryResult> {
	const absoluteFilePath = path.resolve(filePath)
	return withCrossProcessFileLock(absoluteFilePath, () => recoverSafeWriteJsonLocked(absoluteFilePath), {
		staleMs: TARGET_LOCK_STALE_MS,
		updateMs: TARGET_LOCK_UPDATE_MS,
		retries: TARGET_LOCK_RETRIES,
	})
}

async function recoverSafeWriteJsonLocked(absoluteFilePath: string): Promise<SafeWriteRecoveryResult> {
	let currentExists = false
	try {
		await fs.access(absoluteFilePath)
		currentExists = true
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error
		}
	}

	const dirPath = path.dirname(absoluteFilePath)
	const baseName = path.basename(absoluteFilePath)
	const intentPath = safeWriteIntentPath(absoluteFilePath)
	let names: string[]
	try {
		names = await fs.readdir(dirPath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return "none"
		}
		throw error
	}

	const candidateNames = names.filter(
		(name) =>
			(name.startsWith(`.${baseName}.new_`) ||
				name.startsWith(`.${baseName}.bak_`) ||
				name.startsWith(`.${baseName}.recovery_`)) &&
			name.endsWith(".tmp"),
	)
	const intentFilePresent = names.includes(path.basename(intentPath))
	// The normal path has neither an interrupted-write marker nor recovery
	// artifacts. Do not parse a potentially very large current JSON file merely
	// to report that there is nothing to recover; each store validates it when it
	// performs its actual read.
	if (!intentFilePresent && candidateNames.length === 0) {
		return currentExists ? "current" : "none"
	}

	const candidates = await Promise.all(
		candidateNames.map(async (name) => {
			const candidatePath = path.join(dirPath, name)
			const stat = await fs.stat(candidatePath)
			return {
				path: candidatePath,
				kind: name.startsWith(`.${baseName}.new_`)
					? ("new" as const)
					: name.startsWith(`.${baseName}.bak_`)
						? ("backup" as const)
						: ("recovery" as const),
				mtimeMs: stat.mtimeMs,
			}
		}),
	)
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))

	const validCandidates: typeof candidates = []
	for (const candidate of candidates) {
		try {
			JSON.parse(await fs.readFile(candidate.path, "utf8"))
			validCandidates.push(candidate)
		} catch {
			// Keep invalid artifacts for diagnostics.
		}
	}

	const currentIsValid = currentExists && (await isValidJsonFile(absoluteFilePath))
	const intent = await readSafeWriteIntent(intentPath, baseName)
	const intendedNew = intent
		? validCandidates.find(
				(candidate) => candidate.kind === "new" && path.basename(candidate.path) === intent.newFileName,
			)
		: undefined
	const intendedBackup = intent
		? validCandidates.find(
				(candidate) => candidate.kind === "backup" && path.basename(candidate.path) === intent.backupFileName,
			)
		: undefined

	// A valid current file is the only version whose later-writer status can be
	// proven without a base digest. This conservative v1 rule prevents a stale
	// prepared/aborted intent from rolling back a current written by an older or
	// lock-bypassing client. First fsync the selected current and its directory;
	// only then may proven-superseded valid artifacts be removed.
	if (currentIsValid) {
		await syncFile(absoluteFilePath)
		const directorySynced = await syncDirectory(dirPath)
		await cleanupSupersededArtifacts(
			intentPath,
			Boolean(intent),
			validCandidates.map((candidate) => candidate.path),
			dirPath,
			directorySynced,
		)
		return "current"
	}

	const pendingNew = intent?.state === "prepared" ? intendedNew : undefined
	if (pendingNew && intent) {
		const displacedCurrentPath = await promoteRecoveryCandidate(
			pendingNew.path,
			absoluteFilePath,
			currentExists,
			true,
		)
		await syncFile(absoluteFilePath)
		const directorySynced = await syncDirectory(dirPath)
		await cleanupRecoveredIntent(intentPath, intent, dirPath, directorySynced)
		if (directorySynced && displacedCurrentPath) {
			await fs.unlink(displacedCurrentPath).catch(() => undefined)
			await syncDirectory(dirPath)
		}
		return "new"
	}

	const backup = intent
		? (intendedBackup ?? validCandidates.find((candidate) => candidate.kind === "backup"))
		: validCandidates.find((candidate) => candidate.kind === "backup")
	if (backup) {
		await promoteRecoveryCandidate(backup.path, absoluteFilePath, currentExists, true)
		await syncFile(absoluteFilePath)
		const directorySynced = await syncDirectory(dirPath)
		if (intent) {
			await cleanupRecoveredIntent(intentPath, intent, dirPath, directorySynced)
		}
		return "backup"
	}

	// Recovery itself uses two renames. If it crashes after displacing current
	// but before publishing the selected candidate, `.recovery_*` may be the last
	// remaining valid copy. It is deliberately below a committed backup and
	// above an unmarked `.new` artifact in the fallback order.
	const recovery = validCandidates.find((candidate) => candidate.kind === "recovery")
	if (recovery) {
		await promoteRecoveryCandidate(recovery.path, absoluteFilePath, currentExists, true)
		await syncFile(absoluteFilePath)
		const directorySynced = await syncDirectory(dirPath)
		if (intent) {
			await cleanupRecoveredIntent(intentPath, intent, dirPath, directorySynced)
		}
		return "recovery"
	}

	// Legacy writers did not leave an explicit intent marker. Never allow one
	// of their orphaned `.new` files to replace a valid target based on mtime;
	// clock rollback and coarse timestamp resolution can make that comparison
	// regress a newer committed file. If no committed target or backup survives,
	// the newest valid `.new` is the only remaining recovery evidence.
	const legacyNew = intent ? undefined : validCandidates.find((candidate) => candidate.kind === "new")
	if (legacyNew) {
		await promoteRecoveryCandidate(legacyNew.path, absoluteFilePath, currentExists, true)
		await syncFile(absoluteFilePath)
		await syncDirectory(dirPath)
		return "new"
	}

	return "none"
}

function safeWriteIntentPath(absoluteFilePath: string): string {
	return path.join(path.dirname(absoluteFilePath), `.${path.basename(absoluteFilePath)}.write-intent.json`)
}

async function readSafeWriteIntent(intentPath: string, baseName: string): Promise<SafeWriteIntent | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(intentPath, "utf8")) as Partial<SafeWriteIntent>
		if (
			parsed.version !== SAFE_WRITE_INTENT_VERSION ||
			(parsed.state !== undefined && parsed.state !== "prepared" && parsed.state !== "aborted") ||
			!isSafeWriteArtifactName(parsed.newFileName, baseName, "new") ||
			!isSafeWriteArtifactName(parsed.backupFileName, baseName, "bak")
		) {
			return undefined
		}
		return {
			version: SAFE_WRITE_INTENT_VERSION,
			state: parsed.state === "aborted" ? "aborted" : "prepared",
			newFileName: parsed.newFileName,
			backupFileName: parsed.backupFileName,
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return undefined
		}
		// Invalid or partially persisted intent files are retained for forensic
		// inspection. Without a valid marker recovery falls back to committed
		// target/backup artifacts and never guesses over a valid current file.
		return undefined
	}
}

function isSafeWriteArtifactName(value: unknown, baseName: string, kind: "new" | "bak"): value is string {
	return (
		typeof value === "string" &&
		path.basename(value) === value &&
		value.startsWith(`.${baseName}.${kind}_`) &&
		value.endsWith(".tmp")
	)
}

async function writeSafeWriteIntent(intentPath: string, intent: SafeWriteIntent): Promise<void> {
	let handle: fs.FileHandle | undefined
	try {
		handle = await fs.open(intentPath, "w", 0o600)
		await handle.writeFile(JSON.stringify(intent), "utf8")
		await handle.sync()
	} finally {
		await handle?.close()
	}
}

async function markSafeWriteIntentAbortedBestEffort(
	intentPath: string,
	intent: SafeWriteIntent | undefined,
	dirPath: string,
): Promise<void> {
	if (!intent) {
		return
	}
	try {
		await writeSafeWriteIntent(intentPath, { ...intent, state: "aborted" })
		await syncDirectory(dirPath)
	} catch (error) {
		console.error(`Failed to mark safe-write intent aborted for ${intentPath}:`, error)
	}
}

async function syncFile(filePath: string): Promise<void> {
	let handle: fs.FileHandle | undefined
	try {
		// Windows may reject FlushFileBuffers for a read-only handle. These are
		// files owned by the writer/recovery path, so reopen them writable before
		// fsync while keeping directory probes read-only in syncDirectory().
		handle = await fs.open(filePath, "r+")
		await handle.sync()
	} finally {
		await handle?.close()
	}
}

/**
 * Returns false only when the host filesystem does not expose directory fsync
 * through Node. POSIX filesystems use this as the durability boundary for
 * rename/unlink metadata. Windows and some mounted filesystems degrade to
 * atomic-rename plus retained-backup recovery instead of claiming fsync-grade
 * power-loss durability.
 */
async function syncDirectory(dirPath: string): Promise<boolean> {
	let handle: fs.FileHandle | undefined
	try {
		handle = await fs.open(dirPath, "r")
		await handle.sync()
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code
		if (["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(code ?? "")) {
			return false
		}
		throw error
	} finally {
		await handle?.close()
	}
}

async function cleanupRecoveredIntent(
	intentPath: string,
	intent: SafeWriteIntent,
	dirPath: string,
	directorySynced: boolean,
): Promise<void> {
	if (!directorySynced) {
		return
	}
	await fs.unlink(intentPath).catch((error) => {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error
		}
	})
	await fs.unlink(path.join(dirPath, intent.backupFileName)).catch((error) => {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error
		}
	})
	await syncDirectory(dirPath)
}

async function cleanupSupersededArtifacts(
	intentPath: string,
	intentIsValid: boolean,
	artifactPaths: string[],
	dirPath: string,
	directorySynced: boolean,
): Promise<void> {
	if (!directorySynced) {
		return
	}
	for (const artifactPath of artifactPaths) {
		await fs.unlink(artifactPath).catch((error) => {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw error
			}
		})
	}
	if (intentIsValid) {
		await fs.unlink(intentPath).catch((error) => {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw error
			}
		})
	}
	await syncDirectory(dirPath)
}

async function isValidJsonFile(filePath: string): Promise<boolean> {
	try {
		JSON.parse(await fs.readFile(filePath, "utf8"))
		return true
	} catch {
		return false
	}
}

async function promoteRecoveryCandidate(
	candidatePath: string,
	absoluteFilePath: string,
	currentExists: boolean,
	retainDisplacedCurrent: boolean,
): Promise<string | undefined> {
	let displacedCurrentPath: string | undefined
	if (currentExists) {
		displacedCurrentPath = path.join(
			path.dirname(absoluteFilePath),
			`.${path.basename(absoluteFilePath)}.recovery_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)
		try {
			await fs.rename(absoluteFilePath, displacedCurrentPath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw error
			}
			displacedCurrentPath = undefined
		}
	}

	try {
		await fs.rename(candidatePath, absoluteFilePath)
		if (displacedCurrentPath && !retainDisplacedCurrent) {
			await fs.unlink(displacedCurrentPath).catch(() => undefined)
		}
		return displacedCurrentPath
	} catch (error) {
		if (displacedCurrentPath) {
			await fs.rename(displacedCurrentPath, absoluteFilePath).catch(() => undefined)
		}
		// Even when restoring the displaced current succeeds, publishing the
		// requested candidate did not. Report that original failure so callers do
		// not acknowledge a recovery that never committed or delete its backup.
		throw error
	}
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Writes to a temporary file first.
 * - If the target file exists, it's backed up before being replaced.
 * - Attempts to roll back and clean up in case of errors.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {any} data - The data to serialize to JSON and write.
 * @returns {Promise<void>}
 */

async function safeWriteJson(filePath: string, data: any): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	let releaseLock = async () => {} // Initialized to a no-op

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	// Ensure directory structure exists with improved reliability
	try {
		// Create directory with recursive option
		await fs.mkdir(dirPath, { recursive: true })

		// Verify directory exists after creation attempt
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Acquire the lock before any file operations
	try {
		releaseLock = await lockfile.lock(absoluteFilePath, {
			stale: TARGET_LOCK_STALE_MS,
			update: TARGET_LOCK_UPDATE_MS,
			realpath: false, // the file may not exist yet, which is acceptable
			retries: {
				retries: TARGET_LOCK_RETRIES,
				factor: 1.5,
				minTimeout: 25,
				maxTimeout: 1_000,
				randomize: true,
			},
			onCompromised: (err) => {
				console.error(`Lock at ${absoluteFilePath} was compromised:`, err)
				throw err
			},
		})
	} catch (lockError) {
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		throw lockError
	}

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null
	let backupCreated = false
	const intentPath = safeWriteIntentPath(absoluteFilePath)
	let directoryDurabilitySupported = true
	let operationFailed = false
	let operationError: unknown
	let writeIntent: SafeWriteIntent | undefined
	let intentMayExist = false

	try {
		// Resolve an interrupted prior write while the same destination lock is
		// held. This prevents a new writer from overwriting the prior intent and
		// making its exact recovery ordering ambiguous.
		await recoverSafeWriteJsonLocked(absoluteFilePath)

		// Step 1: serialize and fsync the new artifact.
		actualTempNewFilePath = path.join(
			path.dirname(absoluteFilePath),
			`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)
		actualTempBackupFilePath = path.join(
			path.dirname(absoluteFilePath),
			`.${path.basename(absoluteFilePath)}.bak_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)

		await _streamDataToFile(actualTempNewFilePath, data)
		await syncFile(actualTempNewFilePath)
		writeIntent = {
			version: SAFE_WRITE_INTENT_VERSION,
			state: "prepared",
			newFileName: path.basename(actualTempNewFilePath),
			backupFileName: path.basename(actualTempBackupFilePath),
		}

		// Step 2: publish the exact new/backup pairing before moving current. A
		// crash after the later backup rename can therefore recover that exact
		// generation instead of guessing among retained backups by mtime. If a
		// crash occurs before the rename, recovery's valid-current-first rule keeps
		// the still-committed current and ignores this prepared intent.
		intentMayExist = true
		await writeSafeWriteIntent(intentPath, writeIntent)
		directoryDurabilitySupported = await syncDirectory(dirPath)

		// Step 3: move the last committed target to the exact path already named by
		// the durable intent, then persist that directory rename before commit.
		try {
			await fs.access(absoluteFilePath)
			await fs.rename(absoluteFilePath, actualTempBackupFilePath)
			backupCreated = true
		} catch (accessError: any) {
			if (accessError.code !== "ENOENT") {
				throw accessError
			}
			// No prior committed target exists. Keep the reserved backup name in
			// the intent so recovery can still validate the marker strictly.
		}
		if (directoryDurabilitySupported) {
			directoryDurabilitySupported = await syncDirectory(dirPath)
		}

		// Step 4: atomically publish, fsync the committed file, then make the
		// directory rename durable before any backup is eligible for deletion.
		await fs.rename(actualTempNewFilePath, absoluteFilePath)
		actualTempNewFilePath = null
		await syncFile(absoluteFilePath)
		if (directoryDurabilitySupported) {
			directoryDurabilitySupported = await syncDirectory(dirPath)
		}

		// Step 5: only a confirmed directory-fsync boundary permits removing the
		// intent and previous committed backup. On Windows/filesystems where Node
		// cannot fsync a directory, retain the current backup, one prior backup,
		// and the intent. Describe that guarantee as degraded atomic recovery, not
		// fsync-grade power-loss durability.
		if (directoryDurabilitySupported) {
			try {
				await fs.unlink(actualTempBackupFilePath)
				await syncDirectory(dirPath)
				actualTempBackupFilePath = null
			} catch (unlinkBackupError) {
				if ((unlinkBackupError as NodeJS.ErrnoException)?.code === "ENOENT") {
					actualTempBackupFilePath = null
				} else {
					console.error(
						`Successfully wrote ${absoluteFilePath}, but failed to clean up backup ${actualTempBackupFilePath}:`,
						unlinkBackupError,
					)
				}
			}

			try {
				await fs.unlink(intentPath)
				await syncDirectory(dirPath)
			} catch (cleanupIntentError) {
				console.error(
					`Successfully wrote ${absoluteFilePath}, but failed to clean up write intent ${intentPath}:`,
					cleanupIntentError,
				)
			}
		} else {
			await pruneOlderBackupArtifactsBestEffort(absoluteFilePath, actualTempBackupFilePath)
		}
	} catch (originalError) {
		operationFailed = true
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)
		await markSafeWriteIntentAbortedBestEffort(intentPath, intentMayExist ? writeIntent : undefined, dirPath)

		const newFileToCleanupWithinCatch = actualTempNewFilePath
		const backupFileToRollbackOrCleanupWithinCatch = backupCreated ? actualTempBackupFilePath : null

		// Attempt rollback if a backup was made
		if (backupFileToRollbackOrCleanupWithinCatch) {
			try {
				await fs.rename(backupFileToRollbackOrCleanupWithinCatch, absoluteFilePath)
				await syncFile(absoluteFilePath)
				await syncDirectory(dirPath)
				// Mark as handled, prevent later unlink of this path
				actualTempBackupFilePath = null
			} catch (rollbackError) {
				// actualTempBackupFilePath (outer scope) remains pointing to backupFileToRollbackOrCleanupWithinCatch
				console.error(
					`[Catch] Failed to restore backup ${backupFileToRollbackOrCleanupWithinCatch} to ${absoluteFilePath}:`,
					rollbackError,
				)
			}
		}

		// Cleanup the .new file if it exists
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary new file ${newFileToCleanupWithinCatch}:`,
					cleanupError,
				)
			}
		}

		// If rollback failed, the backup is the only known-good committed copy.
		// Keep it in place so the next startup recovery can restore it; deleting it
		// here would turn a transient rename error into permanent local data loss.
		operationError = originalError
	}

	try {
		await releaseLock()
	} catch (unlockError) {
		if (!operationFailed) {
			// The data may already be committed, but callers must not receive a
			// clean success while mutual exclusion is compromised. They need an
			// explicit failure signal so they can reconcile durable state.
			operationFailed = true
			operationError = unlockError
		} else {
			// Preserve the original mutation error when both operation and unlock
			// fail; replacing it with cleanup noise would hide the root cause.
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
	}

	if (operationFailed) {
		throw operationError
	}
}

async function pruneOlderBackupArtifactsBestEffort(absoluteFilePath: string, backupToRetain: string): Promise<void> {
	const dirPath = path.dirname(absoluteFilePath)
	const prefix = `.${path.basename(absoluteFilePath)}.bak_`
	try {
		const names = await fs.readdir(dirPath)
		const olderBackupPaths = names
			.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
			.map((name) => path.join(dirPath, name))
			.filter((candidatePath) => candidatePath !== backupToRetain)
			.sort()
		// The just-created backup directory entry is exactly the one whose
		// fsync could not be proven. Retain one prior backup as independently
		// established recovery evidence instead of deleting the only copy that
		// may survive a sudden power loss.
		const priorBackupToRetain = olderBackupPaths.at(-1)
		await Promise.all(
			olderBackupPaths
				.filter((candidatePath) => candidatePath !== priorBackupToRetain)
				.map((candidatePath) => fs.unlink(candidatePath).catch(() => undefined)),
		)
	} catch (error) {
		console.error(`Failed to prune older safe-write backups for ${absoluteFilePath}:`, error)
	}
}

/**
 * Helper function to stream JSON data to a file.
 * @param targetPath The path to write the stream to.
 * @param data The data to stream.
 * @returns Promise<void>
 */
async function _streamDataToFile(targetPath: string, data: any): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8" })
	const disassembler = Disassembler.disassembler()
	// Output will be compact JSON as standard Stringer is used.
	const stringer = Stringer.stringer()

	return new Promise<void>((resolve, reject) => {
		let errorOccurred = false
		const handleError = (_streamName: string) => (err: Error) => {
			if (!errorOccurred) {
				errorOccurred = true
				if (!fileWriteStream.destroyed) {
					fileWriteStream.destroy(err)
				}
				reject(err)
			}
		}

		disassembler.on("error", handleError("Disassembler"))
		stringer.on("error", handleError("Stringer"))
		fileWriteStream.on("error", (err: Error) => {
			if (!errorOccurred) {
				errorOccurred = true
				reject(err)
			}
		})

		fileWriteStream.on("finish", () => {
			if (!errorOccurred) {
				resolve()
			}
		})

		disassembler.pipe(stringer).pipe(fileWriteStream)

		// stream-json's Disassembler might error if `data` is undefined.
		// JSON.stringify(undefined) would produce the string "undefined" if it's the root value.
		// Writing 'null' is a safer JSON representation for a root undefined value.
		if (data === undefined) {
			disassembler.write(null)
		} else {
			disassembler.write(data)
		}
		disassembler.end()
	})
}

export { recoverSafeWriteJson, safeWriteJson, withCrossProcessFileLock }
export type { CrossProcessFileLockOptions }
