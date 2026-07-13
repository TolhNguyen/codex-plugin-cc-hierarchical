import fs from "node:fs";
import path from "node:path";

/**
 * Path-level enforcement for worker file access. No dependency on the agent
 * or skill registries — a `relPath` is treated as untrusted model output and
 * must never escape `rootDir`, even via symlinks or `..`/absolute tricks.
 */

const ALWAYS_WRITE_DENIED_GLOBS = [".ai-company/**", ".git/**"];

function isWin32() {
  return process.platform === "win32";
}

function toPosixRelative(value) {
  return String(value).split(path.sep).join("/").replace(/\\/g, "/");
}

// --- glob matcher -----------------------------------------------------

// Tokenizes a glob pattern left to right: "**/" (any depth incl. empty,
// followed by a segment), a trailing "/**" (any depth incl. empty, anchored
// at the end), a bare "**" (matches everything), "*" (single segment
// wildcard), "?" (single char) and literal characters (escaped one at a
// time so nothing special leaks through).
const GLOB_TOKEN_RE = /\*\*\/|\/\*\*(?=$)|\*\*|\*|\?|[^*?]/g;

function escapeRegexChar(char) {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExpSource(pattern) {
  const tokens = pattern.match(GLOB_TOKEN_RE) || [];
  let body = "";
  for (const token of tokens) {
    switch (token) {
      case "**/":
        body += "(?:.*/)?";
        break;
      case "**":
        body += ".*";
        break;
      case "*":
        body += "[^/]*";
        break;
      case "?":
        body += "[^/]";
        break;
      case "/**":
        body += "/.*";
        break;
      default:
        body += escapeRegexChar(token);
    }
  }
  return body;
}

export function matchGlob(pattern, relPath) {
  const normalizedPattern = toPosixRelative(pattern);
  const normalizedPath = toPosixRelative(relPath);
  const source = `^${globToRegExpSource(normalizedPattern)}$`;
  const regex = new RegExp(source, isWin32() ? "i" : "");
  return regex.test(normalizedPath);
}

// --- containment + symlink safety --------------------------------------

function computeRelativeCaseAware(rootDir, absPath) {
  if (isWin32()) {
    return path.relative(rootDir.toLowerCase(), absPath.toLowerCase());
  }
  return path.relative(rootDir, absPath);
}

function assertContained(rootDir, absPath, relPathForError) {
  const rel = computeRelativeCaseAware(rootDir, absPath);
  const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(`Path escapes workspace: ${relPathForError}`);
  }
}

// Walks up from `absPath` until it finds an ancestor that actually exists,
// realpath's that ancestor (resolving any symlink in the existing portion of
// the path) and rejoins the not-yet-existing suffix on top. This catches a
// symlink pointing outside rootDir whether or not the final target exists
// yet (e.g. a write into a not-yet-created file inside a symlinked dir).
function realpathDeepestExisting(absPath) {
  let current = absPath;
  const trailing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absPath;
    }
    trailing.unshift(path.basename(current));
    current = parent;
  }

  let real;
  try {
    real = fs.realpathSync(current);
  } catch {
    real = current;
  }
  return trailing.length > 0 ? path.join(real, ...trailing) : real;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

function resolveAndCheckContainment(rootDir, canonicalRootDir, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }

  // Lexical check first: catches ".."/absolute-path tricks by construction,
  // comparing like-for-like (both derived from the literal rootDir).
  const resolved = path.resolve(rootDir, relPath);
  assertContained(rootDir, resolved, relPath);

  // Symlink-aware check second: compares realpath'd target against a
  // realpath'd rootDir, so a symlinked rootDir itself (common for OS temp
  // dirs) doesn't produce a false "escapes workspace".
  const realResolved = realpathDeepestExisting(resolved);
  assertContained(canonicalRootDir, realResolved, relPath);

  return resolved;
}

function isAlwaysWriteDenied(relPath) {
  const normalized = toPosixRelative(relPath);
  return ALWAYS_WRITE_DENIED_GLOBS.some((glob) => matchGlob(glob, normalized));
}

function matchesAny(globs, relPath) {
  const normalized = toPosixRelative(relPath);
  return globs.some((glob) => matchGlob(glob, normalized));
}

export function createPermissionGuard(rootDir, permissions) {
  const readGlobs = (permissions && permissions.read) || [];
  const writeGlobs = (permissions && permissions.write) || [];
  const canonicalRootDir = safeRealpath(rootDir);

  function canRead(relPath) {
    try {
      resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    } catch {
      return false;
    }
    return matchesAny(readGlobs, relPath);
  }

  function canWrite(relPath) {
    try {
      resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    } catch {
      return false;
    }
    if (isAlwaysWriteDenied(relPath)) {
      return false;
    }
    return matchesAny(writeGlobs, relPath);
  }

  function assertRead(relPath) {
    const resolved = resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    if (!matchesAny(readGlobs, relPath)) {
      throw new Error(`Permission denied: read ${relPath}`);
    }
    return resolved;
  }

  function assertWrite(relPath) {
    const resolved = resolveAndCheckContainment(rootDir, canonicalRootDir, relPath);
    if (isAlwaysWriteDenied(relPath) || !matchesAny(writeGlobs, relPath)) {
      throw new Error(`Permission denied: write ${relPath}`);
    }
    return resolved;
  }

  return { canRead, canWrite, assertRead, assertWrite };
}
