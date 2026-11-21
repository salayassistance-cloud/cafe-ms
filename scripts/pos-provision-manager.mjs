#!/usr/bin/env node
// Phase 2.2 — explicit first-Manager provisioning for the POS (Staff) store.
//
// Why this exists: AUTH-ARCH-8B removed all automatic Staff creation. A virgin
// POS database has no Manager account, so nobody can sign in to create one.
// The only supported bootstrap is this operator-run, one-time command.
//
// Usage (after configuring MONGODB_URI):
//   node --env-file=.env.local scripts/pos-provision-manager.mjs \
//     --name "Manager" [--username manager] --confirm
//
// The four-digit PIN is read from POS_PROVISION_MANAGER_PIN or prompted twice
// with echo disabled. It is never accepted as a command-line argument, printed,
// logged, or written to disk. Known default PINs are always refused here, even
// in development, because this is the bootstrap credential.
//
// The command refuses without --confirm and refuses if a MANAGER account
// already exists. Additional Managers must be provisioned through a separate,
// explicitly approved procedure.

import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import Staff from "../lib/models/Staff.js";
import { hashPin } from "../lib/pinCrypto.js";
import { isKnownDefaultPin } from "../lib/config/security.js";

const PIN_ENV = "POS_PROVISION_MANAGER_PIN";
const PIN_RE = /^\d{4}$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,30}$/;

const USAGE = `Usage:
  node --env-file=.env.local scripts/pos-provision-manager.mjs \\
    --name <name> [--username <username>] --confirm

Options:
  --name <name>       Display name for the first POS Manager (1-50 chars).
  --username <name>   Optional login username (2-30 chars: letters, digits, . _ -).
  --confirm           Required acknowledgement that this writes to the POS DB.
  --help              Show this help.

The four-digit PIN is read from ${PIN_ENV} when set, otherwise prompted twice
with echo disabled. Never pass a PIN as a command-line argument. Known default
PINs (1111/2222/3333/4444/5555) are refused.`;

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

export function parsePosProvisionArgs(argv = []) {
  const parsed = { name: "", username: "", confirm: false, help: false };

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
    if (arg === "--name" || arg.startsWith("--name=")) {
      const { value, next } = readValue(arg, index);
      parsed.name = value;
      index = next;
      continue;
    }
    if (arg === "--username" || arg.startsWith("--username=")) {
      const { value, next } = readValue(arg, index);
      parsed.username = value;
      index = next;
      continue;
    }
    // Never echo an unknown argument: it might contain a PIN.
    throw new CliError("Unknown argument. Use --help for supported options.");
  }

  return parsed;
}

export function validateProvisionInput({ name, username, pin }) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName || cleanName.length > 50) {
    throw new CliError("--name is required (1-50 characters)");
  }
  const cleanUsername = String(username ?? "").trim().toLowerCase();
  if (cleanUsername && !USERNAME_RE.test(cleanUsername)) {
    throw new CliError("--username must be 2-30 chars: letters, digits, dot, underscore, dash");
  }
  const cleanPin = String(pin ?? "");
  if (!PIN_RE.test(cleanPin)) {
    throw new CliError("PIN must be exactly 4 digits");
  }
  if (isKnownDefaultPin(cleanPin)) {
    throw new CliError("Refusing a known default PIN for the first Manager");
  }
  return { name: cleanName, username: cleanUsername || null, pin: cleanPin };
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl._writeToOutput = () => {};
    process.stdout.write(label);

    const onSigint = () => {
      rl.close();
      reject(new CliError("Provisioning cancelled"));
    };
    rl.once("SIGINT", onSigint);

    rl.question("", (answer) => {
      rl.removeListener("SIGINT", onSigint);
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function resolvePin() {
  const fromEnv = process.env[PIN_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new CliError(`Set ${PIN_ENV} or run this command in an interactive terminal.`);
  }
  const first = await promptHidden("Four-digit Manager PIN: ");
  const second = await promptHidden("Confirm Manager PIN: ");
  if (first !== second) throw new CliError("PINs do not match");
  return first;
}

function safeErrorMessage(error) {
  if (error instanceof CliError) return error.message;
  const message = error instanceof Error ? error.message || error.name : "Provisioning failed";
  // Never allow a connection string (with credentials) into output.
  return String(message).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://[redacted]");
}

export async function runPosProvisioningCli(argv = process.argv.slice(2), deps = {}) {
  let parsed;
  try {
    parsed = parsePosProvisionArgs(argv);
  } catch (error) {
    console.error(`[pos:provision] ${safeErrorMessage(error)}`);
    return 1;
  }

  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  if (!parsed.confirm) {
    console.error("[pos:provision] Refusing to write without --confirm. No database operation was performed.");
    return 1;
  }

  const uri = deps.uri ?? process.env.MONGODB_URI;
  if (!uri) {
    console.error("[pos:provision] MONGODB_URI is not set. No database operation was performed.");
    return 1;
  }

  const connect = deps.connect ?? (() => mongoose.connect(uri, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
    connectTimeoutMS: 10000,
  }));
  const disconnect = deps.disconnect ?? (() => mongoose.disconnect());

  try {
    const pin = await resolvePin();
    const input = validateProvisionInput({ name: parsed.name, username: parsed.username, pin });

    await connect();
    const existing = await Staff.exists({ role: "MANAGER" });
    if (existing) {
      throw new CliError(
        "A MANAGER account already exists. Refusing to create another through the bootstrap command."
      );
    }

    const doc = await Staff.create({
      name: input.name,
      username: input.username,
      role: "MANAGER",
      pinHash: hashPin(input.pin),
      isActive: true,
    });

    console.log(
      `[pos:provision] First POS Manager provisioned: ${doc.name} (${doc._id}). No PIN or hash was printed.`
    );
    return 0;
  } catch (error) {
    console.error(`[pos:provision] ${safeErrorMessage(error)}`);
    return 1;
  } finally {
    await Promise.resolve(disconnect()).catch(() => {});
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const exitCode = await runPosProvisioningCli();
  process.exitCode = exitCode;
}
