import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  analyzeRepository,
  writeProjectProfile
} from "../plugins/codex/scripts/orchestration/repository-analyzer.mjs";
import { validateAgainstSchema, loadOrchestrationSchema } from "../plugins/codex/scripts/lib/schema-validator.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "repo-analyzer-"));
}

function write(rootDir, relPath, content) {
  const absPath = path.join(rootDir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

test("analyzeRepository: full-featured Node repo produces a precise, schema-valid profile", () => {
  const rootDir = makeTempDir();
  try {
    write(
      rootDir,
      "package.json",
      JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          main: "index.js",
          scripts: {
            test: "node --test tests/*.test.mjs",
            build: "node build.js",
            lint: "eslint ."
          },
          dependencies: { express: "^4.0.0" },
          devDependencies: { typescript: "^5.0.0", jest: "^29.0.0" }
        },
        null,
        2
      )
    );
    write(rootDir, "index.js", "module.exports = {};\n");
    write(rootDir, "tsconfig.json", "{}\n");
    write(rootDir, "src/index.mjs", "export default {};\n");
    write(
      rootDir,
      "src/server.js",
      'const express = require("express");\nconst app = express();\napp.listen(3000);\n'
    );
    write(
      rootDir,
      "src/worker.js",
      'const { spawn } = require("child_process");\nspawn("ls");\n'
    );
    write(
      rootDir,
      "src/socket.js",
      'const net = require("net");\nnet.createServer();\n'
    );
    write(rootDir, "schemas/x.schema.json", "{}\n");
    write(rootDir, "tests/foo.test.mjs", "// test\n");
    write(rootDir, "scripts/cli.mjs", "#!/usr/bin/env node\nconsole.log('cli');\n");
    write(rootDir, ".github/workflows/ci.yml", "name: CI\n");
    write(rootDir, "docs/a.md", "# Doc\n");
    write(rootDir, "README.md", "# fixture\n");

    const profile = analyzeRepository(rootDir);

    assert.equal(profile.version, 1);
    assert.equal(typeof profile.generatedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(profile.generatedAt)));

    assert.deepEqual(profile.languages, ["javascript"]);
    assert.deepEqual(profile.frameworks, ["express", "jest", "typescript"]);

    assert.deepEqual(profile.commands, {
      test: "node --test tests/*.test.mjs",
      build: "node build.js",
      lint: "eslint ."
    });

    assert.deepEqual(profile.structure.dirs, [
      ".github",
      "docs",
      "schemas",
      "scripts",
      "src",
      "tests"
    ]);
    assert.deepEqual(profile.structure.entryPoints, [
      "index.js",
      "src/index.mjs",
      "scripts/cli.mjs"
    ]);

    assert.deepEqual(profile.testLayout, {
      dir: "tests",
      pattern: "*.test.*",
      runner: "node:test"
    });

    assert.deepEqual(profile.ci, {
      provider: "github-actions",
      workflows: [".github/workflows/ci.yml"]
    });

    assert.deepEqual(profile.docs, ["README.md", "docs/a.md"]);

    assert.deepEqual(profile.capabilities.technical, [
      "nodejs",
      "typescript",
      "background-jobs",
      "socket-communication",
      "http-api",
      "structured-state"
    ]);
    assert.deepEqual(profile.capabilities.domains, []);
    assert.deepEqual(profile.capabilities.crossCutting, ["testing", "ci", "concurrency"]);

    const schema = loadOrchestrationSchema("project-profile");
    const result = validateAgainstSchema(profile, schema);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("analyzeRepository: empty repo with a couple of .py files yields minimal profile", () => {
  const rootDir = makeTempDir();
  try {
    write(rootDir, "main.py", "print('hi')\n");
    write(rootDir, "util.py", "print('util')\n");

    const profile = analyzeRepository(rootDir);

    assert.deepEqual(profile.languages, ["python"]);
    assert.deepEqual(profile.commands, { test: null, build: null, lint: null });
    assert.equal("testLayout" in profile, false);
    assert.equal("ci" in profile, false);
    assert.deepEqual(profile.frameworks, []);
    assert.deepEqual(profile.structure.dirs, []);
    assert.deepEqual(profile.structure.entryPoints, []);
    assert.deepEqual(profile.docs, []);
    assert.deepEqual(profile.capabilities.technical, []);
    assert.deepEqual(profile.capabilities.domains, []);
    assert.deepEqual(profile.capabilities.crossCutting, []);

    const schema = loadOrchestrationSchema("project-profile");
    const result = validateAgainstSchema(profile, schema);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("analyzeRepository: ignores node_modules/.git content and never follows symlinked dirs", () => {
  const rootDir = makeTempDir();
  const realTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-analyzer-link-target-"));
  try {
    write(rootDir, "main.rb", "puts 'hi'\n");
    write(rootDir, "node_modules/pkg/index.js", "module.exports = {};\n");
    write(rootDir, "node_modules/pkg/marker.schema.json", "{}\n");
    write(rootDir, ".git/HEAD", "ref: refs/heads/main\n");

    for (let i = 1; i <= 5; i += 1) {
      fs.writeFileSync(path.join(realTargetDir, `g${i}.go`), "package main\n");
    }

    let symlinkCreated = false;
    try {
      fs.symlinkSync(realTargetDir, path.join(rootDir, "linked"), "junction");
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    const profile = analyzeRepository(rootDir);

    assert.equal(profile.structure.dirs.includes("node_modules"), false);
    assert.equal(profile.structure.dirs.includes(".git"), false);
    assert.equal(profile.capabilities.technical.includes("structured-state"), false);

    if (symlinkCreated) {
      assert.equal(profile.structure.dirs.includes("linked"), false);
      assert.equal(profile.languages.includes("go"), false);
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(realTargetDir, { recursive: true, force: true });
  }
});

test("writeProjectProfile: writes a validated, pretty-printed profile with trailing newline", () => {
  const rootDir = makeTempDir();
  try {
    const profile = analyzeRepository(rootDir);

    const filePath = writeProjectProfile(rootDir, profile);

    assert.equal(filePath, path.join(rootDir, ".ai-company", "project-profile.json"));
    assert.ok(fs.existsSync(filePath));

    const raw = fs.readFileSync(filePath, "utf8");
    assert.equal(raw, `${JSON.stringify(profile, null, 2)}\n`);
    assert.deepEqual(JSON.parse(raw), profile);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("writeProjectProfile: throws with validation errors for a schema-violating profile", () => {
  const rootDir = makeTempDir();
  try {
    const invalidProfile = {
      version: "not-a-number",
      generatedAt: new Date().toISOString(),
      languages: [],
      commands: { test: null, build: null, lint: null },
      structure: { dirs: [], entryPoints: [] },
      capabilities: { technical: [], domains: [], crossCutting: [] }
    };

    assert.throws(() => writeProjectProfile(rootDir, invalidProfile), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /expected integer/);
      return true;
    });

    assert.equal(fs.existsSync(path.join(rootDir, ".ai-company", "project-profile.json")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
