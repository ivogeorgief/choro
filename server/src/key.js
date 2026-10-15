// The pairing key: a random secret shared by the user's Choro servers and the
// browser extension (the user pastes it into the extension's popup once). It
// lives in a file only the user can read, so other local users, programs running
// as someone else, and web pages can't learn it.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configDir() {
  if (process.env.CHORO_CONFIG_DIR) return process.env.CHORO_CONFIG_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "choro");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "choro");
}

export const keyFile = () => path.join(configDir(), "pairing-key");

const VALID = /^[0-9a-f]{64}$/;

export function readKey() {
  try {
    const key = fs.readFileSync(keyFile(), "utf8").trim();
    return VALID.test(key) ? key : null;
  } catch {
    return null;
  }
}

// Returns the key, creating it on first use. Creation is atomic (written to a
// private temporary file, then linked into place), so two servers starting at
// once agree on one key.
export function ensureKey({ replace = false } = {}) {
  if (!replace) {
    const existing = readKey();
    if (existing) {
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(keyFile(), 0o600); // in case it was copied in with looser permissions
        } catch {
          /* not ours to change (a read-only or managed file); use it as it is */
        }
      }
      return existing;
    }
  }
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  const tmp = path.join(dir, `.pairing-key.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, key + "\n", { mode: 0o600 });
  try {
    if (replace) {
      fs.renameSync(tmp, keyFile());
      return key;
    }
    try {
      // Fails if another server created it first. Filesystems without hard links
      // get an exclusive create instead.
      try {
        fs.linkSync(tmp, keyFile());
      } catch (err) {
        if (err.code === "EEXIST") throw err;
        fs.writeFileSync(keyFile(), key + "\n", { flag: "wx", mode: 0o600 });
      }
      return key;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const theirs = readKey();
      if (!theirs) throw new Error(`${keyFile()} exists but doesn't hold a valid key; delete it and try again.`);
      return theirs;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
