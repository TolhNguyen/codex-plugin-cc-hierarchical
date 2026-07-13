import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { matchGlob, createPermissionGuard } from "../plugins/codex/scripts/agents/permission-guard.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

function withTempDir(fn) {
  const rootDir = makeTempDir();
  try {
    fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test("matchGlob: table-driven cases", () => {
  const cases = [
    ["tests/**", "tests/a.mjs", true],
    ["tests/**", "tests/a/b.mjs", true],
    ["tests/**", "tests", false],
    ["tests/**", "other/a.mjs", false],
    ["src/**/*.mjs", "src/foo.mjs", true],
    ["src/**/*.mjs", "src/a/b/foo.mjs", true],
    ["src/**/*.mjs", "src/foo.js", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["docs/*.md", "docs/a.md", true],
    ["docs/*.md", "docs/sub/a.md", false],
    ["a?.txt", "ab.txt", true],
    ["a?.txt", "a.txt", false],
    ["a?.txt", "abc.txt", false],
    ["**", "anything/at/all.js", true],
    ["**/*.mjs", "a.mjs", true],
    ["**/*.mjs", "a/b/c.mjs", true]
  ];

  for (const [pattern, relPath, expected] of cases) {
    assert.equal(
      matchGlob(pattern, relPath),
      expected,
      `matchGlob(${JSON.stringify(pattern)}, ${JSON.stringify(relPath)}) should be ${expected}`
    );
  }
});

test("matchGlob: case-insensitive on win32", { skip: process.platform !== "win32" }, () => {
  assert.equal(matchGlob("tests/**", "TESTS/A.MJS"), true);
  assert.equal(matchGlob("*.MD", "readme.md"), true);
});

test("matchGlob: case-sensitive off win32", { skip: process.platform === "win32" }, () => {
  assert.equal(matchGlob("tests/**", "TESTS/A.MJS"), false);
});

test("guard: canRead/canWrite reflect the configured globs", () => {
  withTempDir((rootDir) => {
    fs.mkdirSync(path.join(rootDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "tests", "a.test.mjs"), "// test\n");
    fs.writeFileSync(path.join(rootDir, "secret.txt"), "shh\n");

    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["tests/**"] });

    assert.equal(guard.canRead("tests/a.test.mjs"), true);
    assert.equal(guard.canRead("secret.txt"), true);
    assert.equal(guard.canWrite("tests/a.test.mjs"), true);
    assert.equal(guard.canWrite("secret.txt"), false);
  });
});

test("guard: assertRead/assertWrite throw Permission denied when globs don't allow", () => {
  withTempDir((rootDir) => {
    const guard = createPermissionGuard(rootDir, { read: ["tests/**"], write: ["tests/**"] });

    assert.throws(() => guard.assertRead("secret.txt"), /Permission denied: read secret\.txt/);
    assert.throws(() => guard.assertWrite("secret.txt"), /Permission denied: write secret\.txt/);
  });
});

test("guard: assertWrite returns the resolved absolute path on success", () => {
  withTempDir((rootDir) => {
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["tests/**"] });

    const resolved = guard.assertWrite("tests/a.mjs");

    assert.equal(resolved, path.resolve(rootDir, "tests", "a.mjs"));
    assert.ok(path.isAbsolute(resolved));
  });
});

test("guard: '..' traversal escape throws Path escapes workspace", () => {
  withTempDir((rootDir) => {
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

    assert.throws(
      () => guard.assertRead("../outside.txt"),
      /Path escapes workspace: \.\.\/outside\.txt/
    );
    assert.throws(
      () => guard.assertWrite("../../etc/passwd"),
      /Path escapes workspace/
    );
  });
});

test("guard: absolute path escape throws Path escapes workspace", () => {
  withTempDir((rootDir) => {
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });
    const outsideDir = makeTempDir();
    try {
      const absoluteOutside = path.join(outsideDir, "outside.txt");

      assert.throws(
        () => guard.assertRead(absoluteOutside),
        /Path escapes workspace/
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("guard: canRead/canWrite return false (not throw) for escaping paths", () => {
  withTempDir((rootDir) => {
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

    assert.equal(guard.canRead("../outside.txt"), false);
    assert.equal(guard.canWrite("../outside.txt"), false);
  });
});

test("guard: .ai-company/** is always write-denied even when globs allow everything", () => {
  withTempDir((rootDir) => {
    fs.mkdirSync(path.join(rootDir, ".ai-company"), { recursive: true });
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

    assert.equal(guard.canWrite(".ai-company/agents/x.json"), false);
    assert.throws(
      () => guard.assertWrite(".ai-company/agents/x.json"),
      /Permission denied: write/
    );
    // reading is unaffected by the always-write-denied rule
    assert.equal(guard.canRead(".ai-company/agents/x.json"), true);
  });
});

test("guard: .git/** is always write-denied even when globs allow everything", () => {
  withTempDir((rootDir) => {
    fs.mkdirSync(path.join(rootDir, ".git"), { recursive: true });
    const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

    assert.equal(guard.canWrite(".git/config"), false);
    assert.throws(() => guard.assertWrite(".git/config"), /Permission denied: write/);
  });
});

test("guard: symlink pointing outside rootDir is denied", () => {
  withTempDir((rootDir) => {
    const outsideDir = makeTempDir();
    try {
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "outside\n");

      const linkPath = path.join(rootDir, "escape-link");
      let symlinked = true;
      try {
        fs.symlinkSync(outsideFile, linkPath, "file");
      } catch (err) {
        if (err.code === "EPERM" || err.code === "EACCES") {
          symlinked = false;
        } else {
          throw err;
        }
      }

      if (!symlinked) {
        return;
      }

      const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

      assert.throws(() => guard.assertRead("escape-link"), /Path escapes workspace/);
      assert.throws(() => guard.assertWrite("escape-link"), /Path escapes workspace/);
      assert.equal(guard.canRead("escape-link"), false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test("guard: a symlinked directory inside rootDir pointing outside denies files under it", () => {
  withTempDir((rootDir) => {
    const outsideDir = makeTempDir();
    try {
      const linkPath = path.join(rootDir, "linked-dir");
      let symlinked = true;
      try {
        fs.symlinkSync(outsideDir, linkPath, "dir");
      } catch (err) {
        if (err.code === "EPERM" || err.code === "EACCES") {
          symlinked = false;
        } else {
          throw err;
        }
      }

      if (!symlinked) {
        return;
      }

      const guard = createPermissionGuard(rootDir, { read: ["**"], write: ["**"] });

      assert.throws(() => guard.assertRead("linked-dir/new-file.txt"), /Path escapes workspace/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
