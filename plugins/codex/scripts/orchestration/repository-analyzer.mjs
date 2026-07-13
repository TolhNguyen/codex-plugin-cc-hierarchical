import fs from "node:fs";
import path from "node:path";

import { loadOrchestrationSchema, validateAgainstSchema } from "../lib/schema-validator.mjs";
import { writeJsonFile } from "../lib/fs.mjs";

/**
 * Deterministic repository analyzer: no LLM calls, no network. Walks a target
 * repository directory and produces a project-profile document describing
 * its languages, structure and capabilities.
 */

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".superpowers",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  "vendor",
  "__pycache__",
  ".ai-company"
]);

const MAX_DEPTH = 6;
const MAX_FILES = 5000;
const MAX_SCANNED_SOURCE_FILES = 200;
const MAX_SCANNED_FILE_BYTES = 256 * 1024;

const LANGUAGE_BY_EXTENSION = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp"
};

const FRAMEWORK_BY_DEPENDENCY = {
  react: "react",
  next: "next",
  vue: "vue",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nest",
  jest: "jest",
  vitest: "vitest",
  typescript: "typescript"
};

const DOMAIN_WORDS = new Set(["auth", "billing", "orders", "payments", "inventory", "users", "accounts"]);

const TEST_FILE_PATTERNS = [
  { name: "*.test.*", re: /\.test\.[^./]+$/ },
  { name: "*.spec.*", re: /\.spec\.[^./]+$/ },
  { name: "test_*.py", re: /^test_.*\.py$/ }
];

const BACKGROUND_JOBS_RE = /\b(spawn|worker_threads|child_process)\b/;
const SOCKET_COMMUNICATION_RE = /\bnet\.(createServer|createConnection)|WebSocket\b/;
const HTTP_API_RE = /\b(createServer|express\(\)|fastify\(\)|listen\(\d+)/;

function normalizeEntryCandidate(candidate) {
  let normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function isFile(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Single breadth-first walk of the repository, honoring the shared ignore
 * list, depth cap, file cap and symlink policy. Every other detector derives
 * from the result of this one walk.
 */
function walkRepository(rootDir) {
  const files = [];
  const allDirs = [];
  const topLevelDirs = [];
  let visitedFiles = 0;

  const queue = [{ absPath: rootDir, relPath: "", depth: 0 }];
  while (queue.length > 0) {
    const { absPath, relPath, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      const entryAbsPath = path.join(absPath, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        allDirs.push({ relPath: entryRelPath, name: entry.name, depth: depth + 1 });
        if (depth === 0) {
          topLevelDirs.push(entry.name);
        }
        if (depth + 1 <= MAX_DEPTH) {
          queue.push({ absPath: entryAbsPath, relPath: entryRelPath, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        if (visitedFiles >= MAX_FILES) {
          continue;
        }
        visitedFiles += 1;
        files.push({
          relPath: entryRelPath,
          absPath: entryAbsPath,
          name: entry.name,
          ext: path.extname(entry.name).toLowerCase()
        });
      }
    }
  }

  topLevelDirs.sort();
  return { files, allDirs, topLevelDirs };
}

function readPackageJson(rootDir) {
  const filePath = path.join(rootDir, "package.json");
  if (!isFile(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function detectLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[file.ext];
    if (!language) {
      continue;
    }
    counts.set(language, (counts.get(language) || 0) + 1);
  }

  if (counts.size === 0) {
    return [];
  }

  const significant = [...counts.entries()].filter(([, count]) => count >= 3).map(([language]) => language);
  if (significant.length > 0) {
    return significant.sort();
  }

  const [mostFrequent] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [mostFrequent[0]];
}

function detectFrameworks(pkg) {
  if (!pkg) {
    return [];
  }
  const dependencyNames = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {})
  ]);
  const frameworks = new Set();
  for (const name of dependencyNames) {
    const mapped = FRAMEWORK_BY_DEPENDENCY[name];
    if (mapped) {
      frameworks.add(mapped);
    }
  }
  return [...frameworks].sort();
}

function makefileHasTarget(makefileContent, targetName) {
  return new RegExp(`^${targetName}\\s*:`, "m").test(makefileContent);
}

function detectCommands(rootDir, pkg) {
  if (pkg) {
    const scripts = pkg.scripts || {};
    return {
      test: scripts.test ?? null,
      build: scripts.build ?? null,
      lint: scripts.lint ?? null
    };
  }

  const makefilePath = path.join(rootDir, "Makefile");
  if (!isFile(makefilePath)) {
    return { test: null, build: null, lint: null };
  }
  const content = fs.readFileSync(makefilePath, "utf8");
  return {
    test: makefileHasTarget(content, "test") ? "make test" : null,
    build: makefileHasTarget(content, "build") ? "make build" : null,
    lint: makefileHasTarget(content, "lint") ? "make lint" : null
  };
}

function detectStructureDirs(topLevelDirs) {
  return [...topLevelDirs].sort();
}

function detectEntryPoints(rootDir, files, pkg) {
  const seen = new Set();
  const entryPoints = [];

  function addCandidate(candidate) {
    if (!candidate) {
      return;
    }
    const normalized = normalizeEntryCandidate(candidate);
    if (seen.has(normalized)) {
      return;
    }
    if (!isFile(path.join(rootDir, ...normalized.split("/")))) {
      return;
    }
    seen.add(normalized);
    entryPoints.push(normalized);
  }

  if (pkg) {
    if (typeof pkg.main === "string") {
      addCandidate(pkg.main);
    }
    if (typeof pkg.bin === "string") {
      addCandidate(pkg.bin);
    } else if (pkg.bin && typeof pkg.bin === "object") {
      for (const value of Object.values(pkg.bin)) {
        if (typeof value === "string") {
          addCandidate(value);
        }
      }
    }
  }

  addCandidate("index.mjs");
  addCandidate("index.js");

  const srcIndexFiles = files
    .filter((file) => /^src\/index\.[^/]+$/.test(file.relPath))
    .map((file) => file.relPath)
    .sort();
  for (const relPath of srcIndexFiles) {
    addCandidate(relPath);
  }

  const shebangScripts = files
    .filter((file) => /^scripts\/[^/]+\.mjs$/.test(file.relPath))
    .filter((file) => {
      const content = fs.readFileSync(file.absPath, "utf8");
      const firstLine = content.split(/\r?\n/, 1)[0] || "";
      return firstLine.startsWith("#!");
    })
    .map((file) => file.relPath)
    .sort();
  for (const relPath of shebangScripts) {
    addCandidate(relPath);
  }

  return entryPoints.slice(0, 10);
}

function detectTestLayout(files, commands) {
  const testFiles = [];
  for (const file of files) {
    const matchedPattern = TEST_FILE_PATTERNS.find((pattern) => pattern.re.test(file.name));
    if (matchedPattern) {
      const segments = file.relPath.split("/");
      const dir = segments.length > 1 ? segments[0] : ".";
      testFiles.push({ dir, patternName: matchedPattern.name });
    }
  }

  if (testFiles.length === 0) {
    return null;
  }

  const dirCounts = new Map();
  for (const { dir } of testFiles) {
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }
  const [topDir] = [...dirCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const patternCounts = new Map();
  for (const { patternName } of testFiles) {
    patternCounts.set(patternName, (patternCounts.get(patternName) || 0) + 1);
  }
  const patternPriority = TEST_FILE_PATTERNS.map((pattern) => pattern.name);
  const [dominantPattern] = [...patternCounts.entries()].sort(
    (a, b) => b[1] - a[1] || patternPriority.indexOf(a[0]) - patternPriority.indexOf(b[0])
  )[0];

  const testLayout = { dir: topDir, pattern: dominantPattern };

  const testCommand = commands.test;
  if (typeof testCommand === "string" && testCommand.length > 0) {
    let runner;
    if (testCommand.includes("node --test")) {
      runner = "node:test";
    } else if (testCommand.includes("jest")) {
      runner = "jest";
    } else if (testCommand.includes("vitest")) {
      runner = "vitest";
    } else if (testCommand.includes("pytest")) {
      runner = "pytest";
    } else {
      runner = testCommand.trim().split(/\s+/)[0];
    }
    testLayout.runner = runner;
  }

  return testLayout;
}

function detectCi(files) {
  const workflows = files
    .filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.relPath))
    .map((file) => file.relPath)
    .sort();

  if (workflows.length === 0) {
    return null;
  }

  return { provider: "github-actions", workflows };
}

function detectDocs(rootDir, files) {
  const rootDocs = ["README.md", "CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md"].filter((name) =>
    isFile(path.join(rootDir, name))
  );
  const nestedDocs = files
    .filter((file) => file.relPath.startsWith("docs/") && file.relPath.endsWith(".md"))
    .map((file) => file.relPath);

  const docs = [...new Set([...rootDocs, ...nestedDocs])].sort();
  return docs.slice(0, 25);
}

function scanSourceFileContents(files) {
  const flags = { backgroundJobs: false, socketCommunication: false, httpApi: false };
  const sourceFiles = files
    .filter((file) => LANGUAGE_BY_EXTENSION[file.ext])
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .slice(0, MAX_SCANNED_SOURCE_FILES);

  for (const file of sourceFiles) {
    let stat;
    try {
      stat = fs.statSync(file.absPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_SCANNED_FILE_BYTES) {
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(file.absPath, "utf8");
    } catch {
      continue;
    }
    if (!flags.backgroundJobs && BACKGROUND_JOBS_RE.test(content)) {
      flags.backgroundJobs = true;
    }
    if (!flags.socketCommunication && SOCKET_COMMUNICATION_RE.test(content)) {
      flags.socketCommunication = true;
    }
    if (!flags.httpApi && HTTP_API_RE.test(content)) {
      flags.httpApi = true;
    }
    if (flags.backgroundJobs && flags.socketCommunication && flags.httpApi) {
      break;
    }
  }

  return flags;
}

function detectStructuredState(files, allDirs) {
  const hasSchemaFile = files.some((file) => file.name.endsWith(".schema.json"));
  const hasSchemasDir = allDirs.some((dir) => dir.name === "schemas");
  return hasSchemaFile || hasSchemasDir;
}

function detectTechnicalCapabilities(files, allDirs, pkg) {
  const nodejs = pkg !== null;

  const hasTsconfig = files.some((file) => !file.relPath.includes("/") && file.name.startsWith("tsconfig"));
  const hasTsFiles = files.some((file) => file.ext === ".ts" || file.ext === ".mts");
  const typescript = hasTsconfig || hasTsFiles;

  const contentFlags = scanSourceFileContents(files);
  const structuredState = detectStructuredState(files, allDirs);

  const flags = [];
  if (nodejs) flags.push("nodejs");
  if (typescript) flags.push("typescript");
  if (contentFlags.backgroundJobs) flags.push("background-jobs");
  if (contentFlags.socketCommunication) flags.push("socket-communication");
  if (contentFlags.httpApi) flags.push("http-api");
  if (structuredState) flags.push("structured-state");

  return {
    flags,
    backgroundJobs: contentFlags.backgroundJobs,
    socketCommunication: contentFlags.socketCommunication
  };
}

function detectDomains(topLevelDirs, allDirs) {
  const domains = new Set();
  for (const name of topLevelDirs) {
    if (DOMAIN_WORDS.has(name)) {
      domains.add(name);
    }
  }
  for (const dir of allDirs) {
    const segments = dir.relPath.split("/");
    if (segments.length === 2 && segments[0] === "src" && DOMAIN_WORDS.has(segments[1])) {
      domains.add(segments[1]);
    }
  }
  return [...domains].sort();
}

function detectCrossCutting(testLayout, ci, technical) {
  const crossCutting = [];
  if (testLayout) crossCutting.push("testing");
  if (ci) crossCutting.push("ci");
  if (technical.backgroundJobs || technical.socketCommunication) crossCutting.push("concurrency");
  return crossCutting;
}

export function analyzeRepository(rootDir) {
  const { files, allDirs, topLevelDirs } = walkRepository(rootDir);

  const pkg = readPackageJson(rootDir);
  const commands = detectCommands(rootDir, pkg);
  const testLayout = detectTestLayout(files, commands);
  const ci = detectCi(files);
  const technical = detectTechnicalCapabilities(files, allDirs, pkg);

  const profile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    languages: detectLanguages(files),
    frameworks: detectFrameworks(pkg),
    commands,
    structure: {
      dirs: detectStructureDirs(topLevelDirs),
      entryPoints: detectEntryPoints(rootDir, files, pkg)
    },
    docs: detectDocs(rootDir, files),
    capabilities: {
      technical: technical.flags,
      domains: detectDomains(topLevelDirs, allDirs),
      crossCutting: detectCrossCutting(testLayout, ci, technical)
    }
  };

  if (testLayout) {
    profile.testLayout = testLayout;
  }
  if (ci) {
    profile.ci = ci;
  }

  return profile;
}

export function writeProjectProfile(rootDir, profile) {
  const schema = loadOrchestrationSchema("project-profile");
  const { valid, errors } = validateAgainstSchema(profile, schema);
  if (!valid) {
    throw new Error(`Invalid project profile:\n${errors.join("\n")}`);
  }

  const outputDir = path.join(rootDir, ".ai-company");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "project-profile.json");
  writeJsonFile(filePath, profile);
  return filePath;
}
