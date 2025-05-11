import { createServer } from "node:http";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const partPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const commitPattern = /^[0-9a-f]{7,64}$/;
const snippetTypes = new Map([
  [".sh", "bash"],
  [".js", "node"],
  [".py", "python"],
]);

export function createRegistryServer({ repositoryRoot, stagingRoot = join(repositoryRoot, ".editor-staging") }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://registry.local");

      if (url.pathname === "/health") {
        if (request.method !== "GET") return sendError(response, 405, "method not allowed");
        return sendJSON(response, 200, { status: "ok" });
      }

      const editorTarget = parseEditorTarget(url);
      if (editorTarget) {
        const root = await realpath(repositoryRoot);
        const repository = await repositoryPath(root, editorTarget.owner, editorTarget.repo);
        const index = await stagingIndex(stagingRoot, editorTarget.owner, editorTarget.repo);

        if (editorTarget.kind === "snippet" && request.method === "GET") {
          return sendJSON(response, 200, await editorSnippet(repository, editorTarget, index));
        }
        if (editorTarget.kind === "file" && request.method === "PUT") {
          const content = await requestContent(request);
          await stageFile(repository, index, editorTarget.path, content);
          return sendJSON(response, 200, { path: editorTarget.path, staged: true });
        }
        if (editorTarget.kind === "commit" && request.method === "POST") {
          const message = await requestMessage(request);
          const commit = await commitStaged(repository, index, message);
          return sendJSON(response, 201, { commit });
        }
        return sendError(response, 405, "method not allowed");
      }

      if (request.method !== "GET") {
        return sendError(response, 405, "method not allowed");
      }

      const browseTarget = parseBrowseTarget(url.pathname);
      if (browseTarget) {
        const root = await realpath(repositoryRoot);
        if (browseTarget.repo) {
          const type = snippetType(browseTarget.repo);
          const repository = await repositoryPath(root, browseTarget.owner, browseTarget.repo);
          const commit = await resolveCommit(repository, "HEAD");
          const entrypoint = await entrypointFor(type, repository, commit);
          const script = await fileAtCommit(repository, commit, entrypoint);

          return sendJSON(response, 200, {
            owner: browseTarget.owner,
            repo: browseTarget.repo,
            type,
            entrypoint,
            commit,
            script,
          });
        }

        return sendJSON(response, 200, await listOwnerSnippets(root, browseTarget.owner));
      }

      const target = parseTarget(url.pathname);

      if (!target) {
        return sendError(response, 404, "not found");
      }

      const root = await realpath(repositoryRoot);
      const type = snippetType(target.repo);
      const repository = await repositoryPath(root, target.owner, target.repo);

      if (target.kind === "resolve") {
        const commit = await resolveCommit(repository, target.value);

        return sendJSON(response, 200, {
          owner: target.owner,
          repo: target.repo,
          type,
          ref: target.value,
          commit,
        });
      }

      if (!commitPattern.test(target.value)) {
        return sendError(response, 400, "invalid commit");
      }

      const commit = await resolveCommit(repository, target.value);
      streamArchive(response, repository, commit);
    } catch (error: any) {
      if (error.code === "ENOENT" || error.code === "NOT_FOUND") {
        return sendError(response, 404, "snippet or reference not found");
      }

      if (error.code === "INVALID_TARGET") {
        return sendError(response, 400, error.message);
      }

      console.error(error);
      if (!response.headersSent) {
        return sendError(response, 500, "internal server error");
      }

      response.destroy(error);
    }
  });
}

function parseEditorTarget(url) {
  const prefix = "/api/editor/";
  if (!url.pathname.startsWith(prefix)) return null;
  const parts = url.pathname.slice(prefix.length).split("/");
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) {
    throw invalidTarget("expected owner/repository editor target");
  }
  const [owner, repo, action] = parts.map(decodePart);
  if (!partPattern.test(owner) || !partPattern.test(repo)) {
    throw invalidTarget("Invalid snippet identifier");
  }
  snippetType(repo);
  if (!action) return { kind: "snippet", owner, repo };
  if (action === "file") {
    const path = url.searchParams.get("path");
    if (!path || !validFilePath(path)) throw invalidTarget("invalid file path");
    return { kind: "file", owner, repo, path };
  }
  if (action === "commit") return { kind: "commit", owner, repo };
  throw invalidTarget("unknown editor action");
}

function validFilePath(path) {
  return path.length <= 240 && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..");
}

function parseBrowseTarget(pathname) {
  const prefix = "/api/snippets/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !part)) {
    throw invalidTarget("expected owner or owner/repository");
  }

  const [owner, repo] = parts.map(decodePart);
  if (!partPattern.test(owner) || (repo && !partPattern.test(repo))) {
    throw invalidTarget("Invalid snippet identifier");
  }
  return { owner, repo };
}

function snippetType(repo) {
  for (const [suffix, type] of snippetTypes) {
    if (repo.endsWith(suffix) && repo.length > suffix.length) {
      return type;
    }
  }
  throw invalidTarget("repository name must end in .sh, .js, or .py");
}

function parseTarget(pathname) {
  for (const [prefix, kind] of [["/api/resolve/", "resolve"], ["/api/download/", "download"]]) {
    if (!pathname.startsWith(prefix)) {
      continue;
    }
    const parts = pathname.slice(prefix.length).split("/");
    if (parts.length !== 2) {
      throw invalidTarget("expected owner/repo@reference");
    }
    const owner = decodePart(parts[0]);
    const [repo, value] = decodePart(parts[1]).split("@", 2);
    if (!partPattern.test(owner) || !partPattern.test(repo) || !value) {
      throw invalidTarget("Invalid snippet identifier");
    }
    return { kind, owner, repo, value };
  }
  return null;
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidTarget("Invalid URL encoding");
  }
}

async function repositoryPath(root, owner, repo) {
  const path = join(root, owner, repo);
  const info = await stat(path);
  if (!info.isDirectory()) {
    const error: any = new Error("Not found");
    error.code = "NOT_FOUND";
    throw error;
  }

  return path;
}

async function listOwnerSnippets(root, owner) {
  const ownerPath = join(root, owner);
  const entries = await readdir(ownerPath, { withFileTypes: true });
  const snippets = [] as Array<{ owner: string; repo: string; type: string }>;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      snippets.push({ owner, repo: entry.name, type: snippetType(entry.name) });
    } catch (error: any) {
      if (error.code !== "INVALID_TARGET") {
        throw error;
      }
    }
  }

  return snippets.sort((left, right) => left.repo.localeCompare(right.repo));
}

async function editorSnippet(repository, target, index) {
  const head = await resolveCommit(repository, "HEAD");
  const files = await trackedFiles(repository, head);
  const staged = await stagedFiles(repository, index);
  const history = await gitLines(repository, ["log", "-12", "--format=%H%x00%h%x00%s%x00%aI"]);
  return {
    owner: target.owner,
    repo: target.repo,
    files: await Promise.all(files.map(async (path) => ({
      path,
      content: await fileAtCommit(repository, head, path),
      staged: staged.includes(path),
    }))),
    history: history.map((line) => {
      const [commit, shortCommit, message, date] = line.split("\0");
      return { commit, shortCommit, message, date };
    }),
  };
}

async function stagingIndex(stagingRoot, owner, repo) {
  const directory = join(stagingRoot, owner);
  await mkdir(directory, { recursive: true });
  return join(directory, `${repo}.index`);
}

async function trackedFiles(repository, commit) {
  return gitLines(repository, ["ls-tree", "-r", "--name-only", commit]);
}

async function stagedFiles(repository, index) {
  const result = await git(repository, ["diff", "--name-only", "--cached"], { GIT_INDEX_FILE: index });
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

async function stageFile(repository, index, path, content) {
  const environment = { GIT_INDEX_FILE: index };
  try {
    await stat(index);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const initialized = await git(repository, ["read-tree", "HEAD"], environment);
    if (initialized.code !== 0) throw new Error("could not prepare staging area");
  }
  const blob = await git(repository, ["hash-object", "-w", "--stdin"], environment, content);
  if (blob.code !== 0 || !/^[0-9a-f]{40,64}$/.test(blob.stdout.trim())) throw new Error("could not stage file");
  const mode = (await git(repository, ["ls-tree", "HEAD", "--", path])).stdout.match(/^(\d+)/)?.[1] || "100644";
  const updated = await git(repository, ["update-index", "--add", "--cacheinfo", `${mode},${blob.stdout.trim()},${path}`], environment);
  if (updated.code !== 0) throw new Error("could not stage file");
}

async function commitStaged(repository, index, message) {
  const environment = { GIT_INDEX_FILE: index };
  const changes = await git(repository, ["diff", "--cached", "--quiet"], environment);
  if (changes.code === 0) throw invalidTarget("no staged changes to commit");
  if (changes.code !== 1) throw new Error("could not inspect staged changes");
  const result = await git(repository, ["commit", "--no-verify", "-m", message || "Update snippet"], environment);
  if (result.code !== 0) throw new Error("could not commit staged changes");
  const commit = await resolveCommit(repository, "HEAD");
  await rm(index, { force: true });
  return commit;
}

async function requestContent(request) {
  const content = await requestBody(request);
  if (content.length > 1024 * 1024) throw invalidTarget("file content exceeds 1 MB");
  return content;
}

async function requestMessage(request) {
  const body = await requestBody(request);
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw invalidTarget("expected JSON request body"); }
  const message = typeof (value as any).message === "string" ? (value as any).message.trim() : "";
  if (message.length > 500 || message.includes("\0")) throw invalidTarget("invalid commit message");
  return message;
}

function requestBody(request) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

async function gitLines(repository, arguments_) {
  const result = await git(repository, arguments_);
  if (result.code !== 0) throw new Error("git query failed");
  return result.stdout.split("\n").filter(Boolean);
}

async function entrypointFor(type, repository, commit) {
  if (type === "bash") return "main.sh";
  if (type === "python") return "main.py";

  const entries = await Promise.all(
    ["index.js", "index.mjs"].map(async (path) => ({
      path,
      exists: (await git(repository, ["cat-file", "-e", `${commit}:${path}`])).code === 0,
    })),
  );
  const matching = entries.filter((entry) => entry.exists);
  if (matching.length === 1) return matching[0].path;

  const error: Error & { code?: string } = new Error("invalid Node.js entrypoint");
  error.code = "NOT_FOUND";
  throw error;
}

async function fileAtCommit(repository, commit, path) {
  const result = await git(repository, ["show", `${commit}:${path}`]);
  if (result.code !== 0) {
    const error: Error & { code?: string } = new Error("not found");
    error.code = "NOT_FOUND";
    throw error;
  }
  return result.stdout;
}

async function resolveCommit(repository, ref) {
  const result = await git(repository, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);

  if (result.code !== 0) {
    const error: Error & { code?: string } = new Error("not found");
    error.code = "NOT_FOUND";
    throw error;
  }

  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error("git returned an invalid commit");
  }
  return commit;
}

function streamArchive(response, repository, commit) {
  const child = spawn("git", ["-C", repository, "archive", "--format=tar.gz", commit], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.once("error", (error) => {
    if (!response.headersSent) {
      sendError(response, 500, error.message);
    } else {
      response.destroy(error);
    }
  });

  child.once("close", (code) => {
    if (code !== 0 && !response.writableEnded) {
      console.error(`git archive failed: ${stderr.trim()}`);
      response.destroy();
    }
  });

  response.writeHead(200, {
    "content-type": "application/gzip",
    "cache-control": "public, immutable, max-age=31536000",
  });

  child.stdout.pipe(response);
}

function git(repository, arguments_, environment = {}, input?: string) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn("git", ["-C", repository, ...arguments_], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, ...environment } });
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    if (input !== undefined) child.stdin!.end(input);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

function invalidTarget(message) {
  const error: Error & { code?: string } = new Error(message);
  error.code = "INVALID_TARGET";
  return error;
}

function sendJSON(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body + '\n');
}

function sendError(response, status, message) {
  sendJSON(response, status, { error: message });
}

if (import.meta.main) {
  const repositoryRoot = process.env.SNIPPET_REPOSITORIES_PATH;

  if (!repositoryRoot) {
    throw new Error("SNIPPET_REPOSITORIES_PATH is required");
  }

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = createRegistryServer({
    repositoryRoot,
    ...(process.env.SNIPPET_STAGING_PATH ? { stagingRoot: process.env.SNIPPET_STAGING_PATH } : {}),
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`registry listening on ${port}`);
  });
}
