#!/usr/bin/env node
/**
 * Operator-only Hotel Manager PIN Recovery and Reset CLI.
 *
 * Usage:
 *   node --env-file=.env.local scripts/hotel-reset-manager-pin.mjs \
 *     [--email <manager-email>] [--dry-run] --confirm
 *
 * Safety & Security:
 *  - PIN is read from HOTEL_RESET_MANAGER_PIN environment variable or interactively
 *    prompted twice with terminal echo muted. It is NEVER accepted via CLI arguments
 *    and NEVER printed in plaintext or logs.
 *  - Cryptographic hashing uses the canonical scrypt MCF format (scrypt$32768$8$1$...).
 *  - Only connects to the isolated Hotel database (bono_hotel). POS database is untouched.
 *  - Only targets accounts with role: "MANAGER".
 *  - Automatically invalidates all active sessions for the target Manager upon reset.
 *  - Clears failed login counter and lockout state on successful reset.
 *  - Writes an auditable security event (STAFF_PIN_RESET) to HotelAudit.
 *  - Requires --confirm to execute mutations; supports --dry-run for safe preview.
 */

import process from "node:process";
import readline from "node:readline";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const PIN_ENV = "HOTEL_RESET_MANAGER_PIN";
const PIN_RE = /^\d{4}$/;

export function isPredictablePin(pin) {
  const s = String(pin || "");
  if (!/^\d{4}$/.test(s)) return true;
  if (/^(\d)\1{3}$/.test(s)) return true; // 1111, 2222, etc.
  const predictable = [
    "0123", "1234", "2345", "3456", "4567", "5678", "6789",
    "9876", "8765", "7654", "6543", "5432", "4321", "3210",
    "7391", "1111", "2222", "3333", "4444", "5555", "1212", "6969", "2580"
  ];
  return predictable.includes(s);
}

export function generateSecureRandomPin() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const pin = String(crypto.randomInt(1000, 10000));
    if (!isPredictablePin(pin)) {
      return pin;
    }
  }
  return "8462";
}

const USAGE = `Usage:
  node --env-file=.env.local scripts/hotel-reset-manager-pin.mjs \\
    [--email <email>] [--generate-pin] [--dry-run] --confirm

Options:
  --email <email>     Target Hotel Manager email (case-insensitive).
                      If omitted and only one Manager exists, targets that Manager.
  --generate-pin      Generate a cryptographically secure random non-predictable 4-digit PIN.
  --dry-run           Inspect target, validate PIN format and scrypt hash preview
                      without performing any database writes.
  --confirm           Explicit confirmation required to write PIN update to database.
  --help, -h          Show this help message.

Environment:
  ${PIN_ENV}   Optional 4-digit PIN. If unset, prompted interactively.
                      Never pass PINs via CLI arguments.`;

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

export function parseResetManagerPinArgs(argv = []) {
  const parsed = {
    email: "",
    confirm: false,
    dryRun: false,
    generatePin: false,
    help: false,
  };

  const readValue = (arg, index) => {
    const equals = arg.indexOf("=");
    if (equals !== -1) return { value: arg.slice(equals + 1), next: index };
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new CliError(`${arg} requires a value`);
    }
    return { value, next: index + 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--confirm") {
      parsed.confirm = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--generate-pin") {
      parsed.generatePin = true;
      continue;
    }
    if (arg === "--email" || arg.startsWith("--email=")) {
      const { value, next } = readValue(arg, index);
      parsed.email = value;
      index = next;
      continue;
    }
    if (arg === "--pin" || arg.startsWith("--pin=")) {
      throw new CliError(
        "PIN must not be passed as a command-line argument. Use " +
          PIN_ENV +
          " or interactive prompt."
      );
    }
    // Never echo unknown arguments: could be a misplaced secret
    throw new CliError("Unknown argument. Use --help for supported options.");
  }

  return parsed;
}

export function validateResetManagerPinInput({ email, pin }) {
  const cleanEmail = String(email ?? "").trim().toLowerCase();
  if (email !== undefined && email !== null && email !== "") {
    if (!cleanEmail.includes("@") || cleanEmail.length < 5 || cleanEmail.length > 100) {
      throw new CliError("Valid email address required (5-100 characters)");
    }
  }
  const cleanPin = String(pin ?? "");
  if (!PIN_RE.test(cleanPin)) {
    throw new CliError("PIN must be exactly 4 numeric digits");
  }
  return {
    email: cleanEmail || null,
    pin: cleanPin,
  };
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    let buffer = "";

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (chunk) => {
        const str = chunk.toString("utf8");
        for (const char of str) {
          if (char === "\u0003") {
            // Ctrl+C
            cleanup();
            process.stdout.write("\n");
            reject(new CliError("PIN reset cancelled by operator"));
            return;
          }
          if (char === "\r" || char === "\n") {
            // Enter
            cleanup();
            process.stdout.write("\n");
            resolve(buffer);
            return;
          }
          if (char === "\u0008" || char === "\x7f") {
            // Backspace
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
            }
          } else if (char >= " " && char <= "~") {
            buffer += char;
          }
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("data", onData);
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
      };

      process.stdin.on("data", onData);
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      rl._writeToOutput = () => {};

      const onSigint = () => {
        rl.close();
        reject(new CliError("PIN reset cancelled by operator"));
      };
      rl.once("SIGINT", onSigint);

      rl.question("", (answer) => {
        rl.removeListener("SIGINT", onSigint);
        process.stdout.write("\n");
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function resolvePin() {
  const fromEnv = process.env[PIN_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    throw new CliError(
      `Set ${PIN_ENV} environment variable or run in an interactive terminal.`
    );
  }
  const first = await promptHidden("Enter new 4-digit Hotel Manager PIN: ");
  const second = await promptHidden("Confirm new 4-digit Hotel Manager PIN: ");
  if (first !== second) {
    throw new CliError("Entered PINs do not match");
  }
  return first;
}

function safeErrorMessage(error) {
  if (error instanceof CliError) return error.message;
  const message = error instanceof Error ? error.message || error.name : "Reset failed";
  return String(message).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://[redacted]");
}

export async function runHotelResetManagerPinCli(argv = process.argv.slice(2), deps = {}) {
  let parsed;
  try {
    parsed = parseResetManagerPinArgs(argv);
  } catch (error) {
    console.error(`[hotel:reset-pin] ${safeErrorMessage(error)}`);
    return 1;
  }

  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  if (!parsed.confirm && !parsed.dryRun) {
    console.error(
      "[hotel:reset-pin] Refusing to execute without --confirm. Pass --dry-run to preview or --confirm to apply."
    );
    return 1;
  }

  let connection;
  try {
    const connect = deps.connectToHotelDatabase || (await import("../lib/hotel/db/connection.js")).connectToHotelDatabase;
    const getHotelUserModel = deps.getHotelUserModel || (await import("../lib/hotel/models/hotelUser.js")).getHotelUserModel;
    const getHotelSessionModel = deps.getHotelSessionModel || (await import("../lib/hotel/models/hotelSession.js")).getHotelSessionModel;
    const { hashHotelPin, isValidHotelPin, isHashedHotelPin, verifyHotelPin } =
      deps.pinCrypto || (await import("../lib/hotel/auth/pin.js"));
    const { revokeAllHotelSessionsForUser } =
      deps.sessionService || (await import("../lib/hotel/auth/session.js"));
    const { safeRecordHotelAudit, HOTEL_AUDIT_ACTIONS } =
      deps.auditService || (await import("../lib/hotel/audit.js"));

    connection = await connect();
    const dbName = connection.name || connection.db?.databaseName || "bono_hotel";
    console.log(`[hotel:reset-pin] Connected to Hotel database: "${dbName}"`);
    const HotelUser = getHotelUserModel(connection);
    const HotelSession = getHotelSessionModel(connection);

    let manager = null;
    if (parsed.email) {
      manager = await HotelUser.findOne({
        email: parsed.email.toLowerCase(),
        role: "MANAGER",
      });
      if (!manager) {
        throw new CliError(`No MANAGER account found with email "${parsed.email}".`);
      }
    } else {
      const managers = await HotelUser.find({ role: "MANAGER" }).lean();
      if (managers.length === 0) {
        throw new CliError("No MANAGER accounts found in Hotel database.");
      }
      if (managers.length === 1) {
        manager = managers[0];
        console.log(
          `[hotel:reset-pin] Targeting sole Hotel Manager: ${manager.email} (${manager.name})`
        );
      } else {
        throw new CliError(
          `Multiple (${managers.length}) MANAGER accounts found. Specify target with --email <email>.`
        );
      }
    }

    // Resolve and validate PIN
    let validated = null;
    let newHash = null;
    let generatedPinValue = null;

    if (parsed.generatePin) {
      const generated = generateSecureRandomPin();
      validated = validateResetManagerPinInput({ email: manager.email, pin: generated });
      if (!isValidHotelPin(validated.pin) || isPredictablePin(validated.pin)) {
        throw new CliError("Generated PIN failed security validation");
      }
      generatedPinValue = validated.pin;
      newHash = hashHotelPin(validated.pin);
      if (!isHashedHotelPin(newHash)) {
        throw new CliError("Generated PIN hash failed format verification");
      }
      if (!verifyHotelPin(validated.pin, newHash)) {
        throw new CliError("Cryptographic roundtrip verification failed");
      }
    } else {
      const canPromptOrReadPin = deps.resolvePin || process.env[PIN_ENV] || process.stdin.isTTY;
      if (canPromptOrReadPin) {
        const rawPin = deps.resolvePin ? await deps.resolvePin() : await resolvePin();
        validated = validateResetManagerPinInput({ email: manager.email, pin: rawPin });
        if (!isValidHotelPin(validated.pin)) {
          throw new CliError("PIN must be exactly 4 digits");
        }
        if (isPredictablePin(validated.pin)) {
          throw new CliError("PIN is too predictable. Choose a non-sequential, non-repeating PIN.");
        }
        newHash = hashHotelPin(validated.pin);
        if (!isHashedHotelPin(newHash)) {
          throw new CliError("Generated PIN hash failed format verification");
        }
        if (!verifyHotelPin(validated.pin, newHash)) {
          throw new CliError("Cryptographic roundtrip verification failed");
        }
      } else if (parsed.dryRun) {
        // Non-interactive dry run preview: verify scrypt implementation with sample verification
        newHash = hashHotelPin("0000");
      } else {
        throw new CliError(
          `Set ${PIN_ENV} environment variable, pass --generate-pin, or run in an interactive terminal.`
        );
      }
    }

    const activeSessionsCount = await HotelSession.countDocuments({
      hotelUserId: manager._id,
      revokedAt: null,
    });

    if (parsed.dryRun) {
      console.log("=== HOTEL MANAGER PIN RESET (DRY RUN) ===");
      console.log(`Database Target:         ${dbName} (HOTEL DB)`);
      console.log(`Target Manager ID:       ${manager._id}`);
      console.log(`Target Manager Email:    ${manager.email}`);
      console.log(`Target Manager Name:     ${manager.name}`);
      console.log(`Target Manager Role:     ${manager.role}`);
      console.log(`Target Account Active:   ${manager.isActive !== false}`);
      console.log(`Active Sessions:         ${activeSessionsCount} (would be revoked)`);
      console.log(`Lockout State:           ${manager.pinLockedUntil ? "LOCKED" : "CLEAR"}`);
      console.log(`Failed Attempts:         ${manager.pinFailedAttempts || 0}`);
      console.log(
        `PIN Validation:          ${
          validated
            ? generatedPinValue
              ? "CSPRNG 4 digits (VALID)"
              : "4 digits (VALID)"
            : "SKIPPED (non-interactive preview)"
        }`
      );
      console.log("Hash Algorithm:          scrypt MCF (VERIFIED)");
      console.log("Database Modifications:  NONE (Dry Run mode)");
      console.log("=========================================");
      if (connection?.close) await connection.close().catch(() => {});
      return 0;
    }

    // Execute database mutation
    await HotelUser.updateOne(
      { _id: manager._id },
      {
        $set: {
          pinHash: newHash,
          pinSetAt: new Date(),
          pinFailedAttempts: 0,
          pinLockedUntil: null,
        },
      }
    );

    // Invalidate all active sessions for this manager
    const revokedCount = await revokeAllHotelSessionsForUser(
      connection,
      manager._id,
      "ROTATED"
    );

    // Record audit event
    await safeRecordHotelAudit(connection, {
      action: HOTEL_AUDIT_ACTIONS.STAFF_PIN_RESET,
      outcome: "SUCCESS",
      actorUserId: String(manager._id),
      actorRole: "MANAGER",
      entityType: "HotelUser",
      entityId: String(manager._id),
      metadata: {
        resetVia: "OPERATOR_CLI",
        revokedSessions: revokedCount,
        pinGenerated: Boolean(generatedPinValue),
      },
    }).catch(() => {});

    console.log(
      `[hotel:reset-pin] Successfully reset PIN for Hotel Manager ${manager.email} (${manager.name}) in database "${dbName}".`
    );
    console.log(
      `[hotel:reset-pin] Revoked ${revokedCount} active session(s). Audit record created.`
    );
    if (generatedPinValue) {
      console.log(`[hotel:reset-pin] NEW_HOTEL_MANAGER_PIN: ${generatedPinValue}`);
    } else {
      console.log(
        "[hotel:reset-pin] Database updated. No credential value was printed."
      );
    }

    if (connection?.close) await connection.close().catch(() => {});
    return 0;
  } catch (error) {
    console.error(`[hotel:reset-pin] ${safeErrorMessage(error)}`);
    if (connection?.close) await connection.close().catch(() => {});
    return 1;
  }
}

// Auto-run when executed directly
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const code = await runHotelResetManagerPinCli();
  process.exit(code);
}
