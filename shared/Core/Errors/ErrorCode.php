<?php
/**
 * Error-code registry. Every refusal, failure, blocked reason and readiness
 * code the specification names has exactly one entry here; code elsewhere
 * refers to these cases, never to free strings (enforced by a unit test that
 * scans the source tree for quoted UPPER_SNAKE codes).
 *
 * `httpStatus()` is set only where §F.4 defines one.
 */

declare(strict_types=1);

namespace DeployAgent\Core\Errors;

enum ErrorCode: string
{
    // API (§F.4) — defined now, used from Slice 2 on.
    case IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
    case DEPLOYMENT_IN_PROGRESS = 'DEPLOYMENT_IN_PROGRESS';
    case MAINTENANCE_IN_PROGRESS = 'MAINTENANCE_IN_PROGRESS';
    case SITE_NEEDS_ATTENTION = 'SITE_NEEDS_ATTENTION';
    case ENVIRONMENT_MISMATCH = 'ENVIRONMENT_MISMATCH';
    case TARGET_NOT_GRANTED = 'TARGET_NOT_GRANTED';
    case SCOPE_DENIED = 'SCOPE_DENIED';
    case AUTH_FAILED = 'AUTH_FAILED';
    case AUTH_CLOCK_SKEW = 'AUTH_CLOCK_SKEW';
    case AUTH_REPLAY = 'AUTH_REPLAY';
    case INSECURE_TRANSPORT = 'INSECURE_TRANSPORT';
    case ARTIFACT_TOO_LARGE = 'ARTIFACT_TOO_LARGE';
    case MUTATIONS_UNAVAILABLE = 'MUTATIONS_UNAVAILABLE';
    case DATABASE_EFFECT_ACK_REQUIRED = 'DATABASE_EFFECT_ACK_REQUIRED';
    case WRONG_CONTEXT = 'WRONG_CONTEXT';
    case RATE_LIMITED = 'RATE_LIMITED';
    case SCHEMA_INVALID = 'SCHEMA_INVALID';
    case SCHEMA_UNSUPPORTED = 'SCHEMA_UNSUPPORTED';
    case SCHEMA_UNKNOWN_FIELD = 'SCHEMA_UNKNOWN_FIELD';
    case ARTIFACT_CHECKSUM_MISMATCH = 'ARTIFACT_CHECKSUM_MISMATCH';
    case INVALID_STATE = 'INVALID_STATE';

    // Deployment failure and blocked codes (§F.4, §J.4.4).
    case DRAIN_TIMEOUT = 'DRAIN_TIMEOUT';
    case GUARD_NOT_ARMED = 'GUARD_NOT_ARMED';
    case SNAPSHOT_DRIFT = 'SNAPSHOT_DRIFT';
    case GEN_LOCK_UNAVAILABLE = 'GEN_LOCK_UNAVAILABLE';
    case JOURNAL_ANOMALY = 'JOURNAL_ANOMALY';
    case MIRROR_WRITE_FAILED = 'MIRROR_WRITE_FAILED';
    case DB_UNAVAILABLE = 'DB_UNAVAILABLE';
    case RUNNER_DEADLINE = 'RUNNER_DEADLINE';
    case RECOVERY_STALLED = 'RECOVERY_STALLED';
    case WORKER_LOST = 'WORKER_LOST';
    case OPERATOR_ABANDONED = 'OPERATOR_ABANDONED';
    case R5_UNVERIFIED_LIVE = 'R5_UNVERIFIED_LIVE';
    case WORK_ROOT_NOT_ISOLATED = 'WORK_ROOT_NOT_ISOLATED';
    case EDGE_UNVERIFIED = 'EDGE_UNVERIFIED';
    case JOURNAL_WRITE_FAILED = 'JOURNAL_WRITE_FAILED';
    case IDENTITY_MISMATCH = 'IDENTITY_MISMATCH';
    case HEALTH_CHECK_FAILED = 'HEALTH_CHECK_FAILED';
    case HEALTH_CHECK_INCONCLUSIVE = 'HEALTH_CHECK_INCONCLUSIVE';
    case EXTERNAL_WRITE_SUSPECTED = 'EXTERNAL_WRITE_SUSPECTED';
    case ARTIFACT_INVALID_ARCHIVE = 'ARTIFACT_INVALID_ARCHIVE';
    case BACKUP_UNSUPPORTED_CONTENT = 'BACKUP_UNSUPPORTED_CONTENT';
    case REQUIREMENTS_UNMET = 'REQUIREMENTS_UNMET';
    case PRE_GUARD_LOAD = 'PRE_GUARD_LOAD';

    // Database contract (§J.3.2.1, §D.1).
    case DB_FINGERPRINT_MISMATCH = 'DB_FINGERPRINT_MISMATCH';
    case DB_TOPOLOGY_UNSUPPORTED = 'DB_TOPOLOGY_UNSUPPORTED';
    case DB_UNSUPPORTED = 'DB_UNSUPPORTED';
    case DB_NONTRANSACTIONAL = 'DB_NONTRANSACTIONAL';
    case SCHEMA_INCOMPLETE = 'SCHEMA_INCOMPLETE';
    case CONTROL_CONNECTION_LOST = 'CONTROL_CONNECTION_LOST';
    case FENCE_REJECTED = 'FENCE_REJECTED';

    // Migrations (§Q.2).
    case MIGRATION_PENDING = 'MIGRATION_PENDING';
    case MIGRATION_LOCKED = 'MIGRATION_LOCKED';
    case MIGRATION_SQL_ACTIVE = 'MIGRATION_SQL_ACTIVE';
    case MIGRATION_OWNER_UNKNOWN = 'MIGRATION_OWNER_UNKNOWN';
    case MIGRATION_BLOCKED_REBIND = 'MIGRATION_BLOCKED_REBIND';
    case MIGRATION_READ_ONLY = 'MIGRATION_READ_ONLY';
    case SCHEMA_NEWER_THAN_CODE = 'SCHEMA_NEWER_THAN_CODE';
    case INSTALLATION_INCOMPLETE = 'INSTALLATION_INCOMPLETE';
    case OWNER_ROW_CHANGED = 'OWNER_ROW_CHANGED';

    // Locks, trust foundation, bootstrap (§H.4, §I.7.1).
    case LOCK_HELD = 'LOCK_HELD';
    case LOCK_FILE_REPLACED = 'LOCK_FILE_REPLACED';
    case ANCHOR_LOCK_REPLACED = 'ANCHOR_LOCK_REPLACED';
    case ANCHOR_INVALID = 'ANCHOR_INVALID';
    case ANCHOR_LOST = 'ANCHOR_LOST';
    case ANCHOR_ORPHANED = 'ANCHOR_ORPHANED';
    case INSTALL_STALLED = 'INSTALL_STALLED';
    case INSTALLATION_AWAITING_FPM = 'INSTALLATION_AWAITING_FPM';
    case CONFIG_PENDING = 'CONFIG_PENDING';
    case CONFIG_TAMPERED = 'CONFIG_TAMPERED';
    case GENERATION_EXHAUSTED = 'GENERATION_EXHAUSTED';
    case LOCK_EPOCH_UNAVAILABLE = 'LOCK_EPOCH_UNAVAILABLE';
    case REBOOT_REQUIRED = 'REBOOT_REQUIRED';
    case REBOOT_PROOF_UNAVAILABLE = 'REBOOT_PROOF_UNAVAILABLE';
    case REBOOT_MARKER_BUSY = 'REBOOT_MARKER_BUSY';
    case REBOOT_MARKER_STALE = 'REBOOT_MARKER_STALE';
    case REBIND_PENDING = 'REBIND_PENDING';
    case REBIND_SUPERSEDED = 'REBIND_SUPERSEDED';
    case REBIND_ABORTED = 'REBIND_ABORTED';
    case REBIND_UNVERIFIED = 'REBIND_UNVERIFIED';
    case REBIND_CASE_UNAVAILABLE = 'REBIND_CASE_UNAVAILABLE';
    case MIGRATE_LOCK_MOVED = 'MIGRATE_LOCK_MOVED';
    case HOLDER_PRESENT = 'HOLDER_PRESENT';
    case HOLDER_UNPROVEN = 'HOLDER_UNPROVEN';
    case NAMESPACE_MISMATCH = 'NAMESPACE_MISMATCH';
    case NOT_LINUX = 'NOT_LINUX';
    case CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';
    /** A typed confirmation whose binding (displayed bytes, thread, challenge) does not match what this invocation displayed. */
    case CONFIRMATION_REJECTED = 'CONFIRMATION_REJECTED';
    /** A lock file whose mode, group or owner cannot be established or verified (§I.7.1). */
    case LOCK_METADATA_INVALID = 'LOCK_METADATA_INVALID';
    /** DAGENT_LOCK_OWNER is missing where required, does not resolve to exactly one usable non-root account, or differs from the recorded lock owner (§I.7.1 v0.4.16). */
    case LOCK_OWNER_INVALID = 'LOCK_OWNER_INVALID';
    /** A root-started process could not permanently drop to the lock owner, or reached agent filesystem paths without doing so (§I.7.1 R1, v0.4.16). */
    case PRIVILEGE_DROP_FAILED = 'PRIVILEGE_DROP_FAILED';
    /** A root-started activation of Git Deploy that is not provably `wp plugin activate deploy-agent` alone: refused before R1, because the drop would re-identify the rest of the command (§I.7.1 v0.4.16). */
    case ROOT_BULK_ACTIVATION_REFUSED = 'ROOT_BULK_ACTIVATION_REFUSED';
    /** A required audit row cannot be written, so the audited action is not taken. */
    case AUDIT_UNAVAILABLE = 'AUDIT_UNAVAILABLE';
    case SITE_KEY_UNAVAILABLE = 'SITE_KEY_UNAVAILABLE';
    case SITE_SECRET_REQUIRED = 'SITE_SECRET_REQUIRED';
    case MULTISITE_UNSUPPORTED = 'MULTISITE_UNSUPPORTED';
    case NATIVE_SODIUM = 'NATIVE_SODIUM';
    case EXTENSION_MISSING = 'EXTENSION_MISSING';
    case PLATFORM_UNSUPPORTED = 'PLATFORM_UNSUPPORTED';
    case STORAGE_ROOT_UNAVAILABLE = 'STORAGE_ROOT_UNAVAILABLE';
    case WORK_ROOT_UNAVAILABLE = 'WORK_ROOT_UNAVAILABLE';
    case DISK_FULL = 'DISK_FULL';
    case TOPOLOGY_CHANGED = 'TOPOLOGY_CHANGED';
    case FILE_MODS_DISALLOWED = 'FILE_MODS_DISALLOWED';

    public function httpStatus(): ?int
    {
        return match ($this) {
            self::IDEMPOTENCY_CONFLICT, self::DEPLOYMENT_IN_PROGRESS, self::MAINTENANCE_IN_PROGRESS,
            self::DATABASE_EFFECT_ACK_REQUIRED, self::INVALID_STATE => 409,
            self::SITE_NEEDS_ATTENTION => 423,
            self::ENVIRONMENT_MISMATCH, self::TARGET_NOT_GRANTED, self::SCOPE_DENIED, self::INSECURE_TRANSPORT => 403,
            self::AUTH_FAILED, self::AUTH_CLOCK_SKEW, self::AUTH_REPLAY => 401,
            self::ARTIFACT_TOO_LARGE => 413,
            self::MUTATIONS_UNAVAILABLE => 503,
            self::WRONG_CONTEXT => 421,
            self::RATE_LIMITED => 429,
            self::SCHEMA_INVALID, self::SCHEMA_UNSUPPORTED, self::SCHEMA_UNKNOWN_FIELD => 400,
            self::ARTIFACT_CHECKSUM_MISMATCH => 422,
            default => null,
        };
    }

    /** CLI exit codes: 78 = INSTALLATION_AWAITING_FPM (§H.4), 75 is the guard's drain refusal. */
    public function cliExitCode(): int
    {
        return match ($this) {
            self::INSTALLATION_AWAITING_FPM => 78,
            default => 1,
        };
    }
}
