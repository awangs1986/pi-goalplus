import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY_FILE = "goalplus-origin.key";
const KEY_BYTES = 32;
const noFollow = constants.O_NOFOLLOW ?? 0;
const noBlock = constants.O_NONBLOCK ?? 0;

function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep);
}

function keyPath(ctx: ExtensionContext, create: boolean): string {
  const configured = resolve(getAgentDir());
  const cwd = realpathSync(ctx.cwd);
  const defaultDir = join(realpathSync(homedir()), CONFIG_DIR_NAME, "agent");
  if (inside(cwd, configured) && configured !== defaultDir) throw Error("Unsafe Pi agent directory");
  if (create) mkdirSync(configured, { recursive: true, mode: 0o700 });
  const directory = realpathSync(configured);
  if (inside(cwd, directory) && directory !== defaultDir) throw Error("Unsafe Pi agent directory");
  const info = statSync(directory);
  if (!info.isDirectory() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) {
    throw Error("Unsafe Pi agent directory");
  }
  return join(directory, KEY_FILE);
}

function readKey(path: string): Buffer {
  const entry = lstatSync(path);
  if (!entry.isFile()) throw Error("Invalid GoalPlus origin key");
  const fd = openSync(path, constants.O_RDONLY | noFollow | noBlock);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev ||
        stat.size !== KEY_BYTES || stat.nlink !== 1 ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw Error("Invalid GoalPlus origin key");
    }
    const key = Buffer.alloc(KEY_BYTES);
    if (readSync(fd, key) !== KEY_BYTES) throw Error("Invalid GoalPlus origin key");
    return key;
  } finally {
    closeSync(fd);
  }
}

function loadKey(ctx: ExtensionContext, create: boolean): Buffer {
  const path = keyPath(ctx, create);
  try {
    return readKey(path);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readKey(path);
  }
  try {
    writeFileSync(fd, randomBytes(KEY_BYTES));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return readKey(path);
}

export function createLocalAuthority() {
  const ephemeralKey = randomBytes(KEY_BYTES);

  function signature(ctx: ExtensionContext, parent: string | null, state: unknown, create: boolean): Buffer {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionPath = sessionFile === undefined ? null : resolve(sessionFile);
    const key = sessionPath === null ? ephemeralKey : loadKey(ctx, create);
    const payload = JSON.stringify([
      "pi-goalplus-origin-v1", ctx.sessionManager.getSessionId(), sessionPath, resolve(ctx.cwd), parent, state
    ]);
    return createHmac("sha256", key).update(payload).digest();
  }

  return {
    verify(ctx: ExtensionContext, parent: string | null, state: unknown, seal: unknown): boolean {
      if (typeof seal !== "string" || !/^[0-9a-f]{64}$/.test(seal)) return false;
      try {
        return timingSafeEqual(signature(ctx, parent, state, false), Buffer.from(seal, "hex"));
      } catch {
        return false;
      }
    },
    sign(ctx: ExtensionContext, parent: string | null, state: unknown, authorization: boolean): string {
      try {
        return signature(ctx, parent, state, authorization).toString("hex");
      } catch {
        throw Error("GoalPlus needs an owner-controlled Pi agent directory and a private origin key before it can save a verified Goal.");
      }
    }
  };
}
