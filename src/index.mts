import { createServer } from "node:http";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import router from "micro-router";

const partPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const commitPattern = /^[0-9a-f]{7,64}$/;
const snippetTypes = new Map([
  [".sh", "bash"],
  [".js", "node"],
  [".py", "python"],
]);

export function createRegistryServer({ repositoryRoot, stagingRoot = join(repositoryRoot, ".editor-staging"), oidc }) {
  const sessions = new Map();
  const routes = {
    "GET /health": async (_request, response) => sendJSON(response, 200, { status: "ok" }),
    "GET /auth/login": async (request, response) => {
      if (!oidc) return sendError(response, 503, "authentication is not configured");
      const returnTo = safeReturnTo(new URL(request.url!, "http://registry.local").searchParams.get("return_to"), oidc.webOrigin);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      sessions.set(state, { verifier, returnTo, expires: Date.now() + 10 * 60 * 1000 });
      const target = new URL("/authorize", oidc.provider);
      target.search = new URLSearchParams({
        response_type: "code",
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUri,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      response.writeHead(302, { Location: target.toString(), "set-cookie": cookie("snippet.login", state, 600) });
      response.end();
    },
    "GET /auth/callback": async (request, response) => {
      if (!oidc) return sendError(response, 503, "authentication is not configured");
      const url = new URL(request.url!, "http://registry.local");
      const cookies = requestCookies(request);
      const login = sessions.get(cookies["snippet.login"]);
      sessions.delete(cookies["snippet.login"]);
      if (!login || login.expires < Date.now() || !sameValue(url.searchParams.get("state"), cookies["snippet.login"])) {
        return sendError(response, 400, "invalid authentication state");
      }
      const tokens = await exchangeCode(oidc, url.searchParams.get("code") || "", login.verifier);
      const user = await authenticatedUser(oidc, tokens);
      const session = randomBytes(32).toString("base64url");
      sessions.set(session, { user, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      response.writeHead(302, { Location: login.returnTo, "set-cookie": [cookie("snippet.sid", session, 7 * 24 * 60 * 60), clearCookie("snippet.login")] });
      response.end();
    },
    "GET /auth/me": async (request, response) => {
      const user = currentUser(request, sessions);
      sendJSON(response, user ? 200 : 401, user || { error: "authentication required" });
    },
    "POST /auth/logout": async (request, response) => {
      const session = requestCookies(request)["snippet.sid"];
      sessions.delete(session);
      response.writeHead(204, { "set-cookie": clearCookie("snippet.sid") });
      response.end();
    },
    "GET /api/snippets/{owner}/{repo}": async (_request, response, params) => {
      const { owner, repo, type } = snippetTarget(params);
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      const commit = await resolveCommit(repository, "HEAD");
      const entrypoint = await entrypointFor(type, repository, commit);
      const script = await fileAtCommit(repository, commit, entrypoint);
      sendJSON(response, 200, { owner, repo, type, entrypoint, commit, script });
    },
    "POST /api/snippets/{owner}/{repo}": async (request, response, params) => {
      requireUser(request, sessions, oidc);
      const { owner, repo, type } = snippetTarget(params);
      const { content, message } = await createRequest(request);
      const root = await realpath(repositoryRoot);
      const repository = join(root, owner, repo);
      const commit = await createSnippet(repository, type, content, message);
      sendJSON(response, 201, { owner, repo, commit });
    },
    "DELETE /api/snippets/{owner}/{repo}": async (request, response, params) => {
      requireUser(request, sessions, oidc);
      const { owner, repo } = snippetTarget(params);
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      await rm(repository, { recursive: true });
      await rm(join(stagingRoot, owner, `${repo}.index`), { force: true });
      sendJSON(response, 200, { owner, repo, deleted: true });
    },
    "GET /api/snippets/{owner}": async (_request, response, params) => {
      const owner = validPart(params.owner);
      const root = await realpath(repositoryRoot);
      sendJSON(response, 200, await listOwnerSnippets(root, owner));
    },
    "GET /api/resolve/{owner}/{target}": async (_request, response, params) => {
      const { owner, repo, value, type } = referenceTarget(params);
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      const commit = await resolveCommit(repository, value);
      sendJSON(response, 200, { owner, repo, type, ref: value, commit });
    },
    "GET /api/download/{owner}/{target}": async (_request, response, params) => {
      const { owner, repo, value } = referenceTarget(params);
      if (!commitPattern.test(value)) throw invalidTarget("invalid commit");
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      streamArchive(response, repository, await resolveCommit(repository, value));
    },
    "PUT /api/editor/{owner}/{repo}/file": async (request, response, params) => {
      const user = requireUser(request, sessions, oidc);
      const { owner, repo } = snippetTarget(params);
      const path = new URL(request.url!, "http://registry.local").searchParams.get("path");
      if (!path || !validFilePath(path)) throw invalidTarget("invalid file path");
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      const index = await stagingIndex(stagingRoot, owner, repo);
      await stageFile(repository, index, path, await requestContent(request));
      sendJSON(response, 200, { path, staged: true });
    },
    "POST /api/editor/{owner}/{repo}/commit": async (request, response, params) => {
      const user = requireUser(request, sessions, oidc);
      const { owner, repo } = snippetTarget(params);
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      const index = await stagingIndex(stagingRoot, owner, repo);
      sendJSON(response, 201, { commit: await commitStaged(repository, index, await requestMessage(request)) });
    },
    "GET /api/editor/{owner}/{repo}": async (request, response, params) => {
      requireUser(request, sessions, oidc);
      const { owner, repo } = snippetTarget(params);
      const root = await realpath(repositoryRoot);
      const repository = await repositoryPath(root, owner, repo);
      const index = await stagingIndex(stagingRoot, owner, repo);
      sendJSON(response, 200, await editorSnippet(repository, { owner, repo }, index));
    },
  };

  const handler = router(routes, routeNotFound);
  return createServer(async (request, response) => {
    try {
      response.setHeader("access-control-allow-origin", oidc?.webOrigin || "https://snippets.run");
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type, Accept");
      response.setHeader("access-control-allow-credentials", "true");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        return response.end();
      }
      await handler(request, response);
    } catch (error: any) {
      handleError(response, error);
    }
  });
}

function snippetTarget(params) {
  const owner = validPart(params.owner);
  const repo = validPart(params.repo);
  return { owner, repo, type: snippetType(repo) };
}

function referenceTarget(params) {
  const owner = validPart(params.owner);
  const [repo, value] = decodePart(params.target).split("@", 2);
  if (!partPattern.test(repo) || !value) throw invalidTarget("Invalid snippet identifier");
  return { owner, repo, value, type: snippetType(repo) };
}

function validPart(value) {
  const decoded = decodePart(value);
  if (!partPattern.test(decoded)) throw invalidTarget("Invalid snippet identifier");
  return decoded;
}

function validFilePath(path) {
  return path.length <= 240 && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..");
}

function snippetType(repo) {
  for (const [suffix, type] of snippetTypes) {
    if (repo.endsWith(suffix) && repo.length > suffix.length) {
      return type;
    }
  }
  throw invalidTarget("repository name must end in .sh, .js, or .py");
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidTarget("Invalid URL encoding");
  }
}

function requestCookies(request) {
  const header = request.headers.cookie || "";
  return Object.fromEntries(header.split(";").filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return cookie(name, "", 0);
}

function currentUser(request, sessions) {
  const session = sessions.get(requestCookies(request)["snippet.sid"]);
  if (!session || session.expires < Date.now()) return null;
  return session.user;
}

function requireUser(request, sessions, oidc) {
  if (!oidc) return null;
  const user = currentUser(request, sessions);
  if (!user) throw authenticationRequired();
  return user;
}

function safeReturnTo(value, webOrigin) {
  try {
    const target = new URL(value || webOrigin);
    return target.origin === webOrigin ? target.toString() : webOrigin;
  } catch {
    return webOrigin;
  }
}

function sameValue(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticationRequired() {
  const error: Error & { code?: string } = new Error("authentication required");
  error.code = "AUTH_REQUIRED";
  return error;
}

function parseToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw authenticationRequired();
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString()),
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString()),
      signature: Buffer.from(parts[2], "base64url"),
      signed: Buffer.from(`${parts[0]}.${parts[1]}`),
    };
  } catch {
    throw authenticationRequired();
  }
}

async function verifyToken(token, oidc) {
  const { header, payload, signature, signed } = parseToken(token);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw authenticationRequired();
  const response = await fetch(new URL("/.well-known/jwks.json", oidc.provider));
  if (!response.ok) throw new Error("could not load authentication keys");
  const keys = await response.json();
  const jwk = keys.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk || !verify("RSA-SHA256", signed, createPublicKey({ key: jwk, format: "jwk" }), signature)) {
    throw authenticationRequired();
  }
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== oidc.provider || !audiences.includes(oidc.clientId) || typeof payload.sub !== "string" || typeof payload.exp !== "number" || payload.exp <= now) {
    throw authenticationRequired();
  }
  return payload;
}

async function exchangeCode(oidc, code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: oidc.clientId,
    client_secret: oidc.clientSecret,
    redirect_uri: oidc.redirectUri,
    code_verifier: verifier,
  });
  const response = await fetch(new URL("/token", oidc.provider), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("authentication exchange failed");
  return response.json();
}

async function authenticatedUser(oidc, tokens) {
  await verifyToken(tokens.id_token, oidc);
  const response = await fetch(new URL("/userinfo", oidc.provider), {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "X-Auth-Audience": oidc.clientId },
  });
  if (!response.ok) throw new Error("could not load authenticated user");
  return response.json();
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

async function createSnippet(repository, type, content, message) {
  try {
    await stat(repository);
    throw conflict("snippet already exists");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(join(repository, ".."), { recursive: true });
  const initialized = await git(join(repository, ".."), ["init", "--bare", "--initial-branch", "main", repository]);
  if (initialized.code !== 0) throw new Error("could not create snippet repository");
  if (content === undefined) return null;
  const entrypoint = type === "bash" ? "main.sh" : type === "python" ? "main.py" : "index.mjs";
  const blob = await git(repository, ["hash-object", "-w", "--stdin"], {}, content);
  if (blob.code !== 0) throw new Error("could not create snippet content");
  const index = `${repository}.create-index`;
  try {
    const environment = { GIT_INDEX_FILE: index };
    const added = await git(repository, ["update-index", "--add", "--cacheinfo", `100755,${blob.stdout.trim()},${entrypoint}`], environment);
    if (added.code !== 0) throw new Error("could not prepare snippet content");
    const tree = await git(repository, ["write-tree"], environment);
    if (tree.code !== 0) throw new Error("could not prepare snippet commit");
    const commit = await git(repository, ["commit-tree", tree.stdout.trim(), "-m", message || `Create ${entrypoint}`], {}, undefined, true);
    if (commit.code !== 0) throw new Error("could not create snippet commit");
    const updated = await git(repository, ["update-ref", "refs/heads/main", commit.stdout.trim()]);
    if (updated.code !== 0) throw new Error("could not publish snippet");
    return commit.stdout.trim();
  } finally {
    await rm(index, { force: true });
  }
}

async function editorSnippet(repository, target, index) {
  const head = await optionalCommit(repository);
  const files = head ? await trackedFiles(repository, head) : [];
  const staged = await stagedFiles(repository, index);
  const history = head ? await gitLines(repository, ["log", "-12", "--format=%H%x00%h%x00%s%x00%aI"]) : [];
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
    const head = await optionalCommit(repository);
    if (head) {
      const initialized = await git(repository, ["read-tree", head], environment);
      if (initialized.code !== 0) throw new Error("could not prepare staging area");
    }
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
  const tree = await git(repository, ["write-tree"], environment);
  if (tree.code !== 0) throw new Error("could not prepare snippet commit");
  const parent = await optionalCommit(repository);
  const arguments_ = ["commit-tree", tree.stdout.trim(), "-m", message || "Update snippet"];
  if (parent) arguments_.push("-p", parent);
  const result = await git(repository, arguments_, {}, undefined, true);
  if (result.code !== 0) throw new Error("could not create snippet commit");
  const updated = await git(repository, ["update-ref", "refs/heads/main", result.stdout.trim()]);
  if (updated.code !== 0) throw new Error("could not publish snippet");
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

async function createRequest(request) {
  const body = await requestBody(request);
  const url = new URL(request.url!, "http://registry.local");
  if (request.headers["content-type"]?.startsWith("application/json") === false) {
    const message = url.searchParams.get("message")?.trim() || "";
    if (body.length > 1024 * 1024) throw invalidTarget("file content exceeds 1 MB");
    if (message.length > 500 || message.includes("\0")) throw invalidTarget("invalid commit message");
    return { content: body, message };
  }
  let value: any;
  try { value = JSON.parse(body); } catch { throw invalidTarget("expected JSON request body"); }
  if (value.content !== undefined && typeof value.content !== "string") throw invalidTarget("snippet content must be a string");
  if (value.content === undefined) {
    const message = typeof value.message === "string" ? value.message.trim() : "";
    if (message.length > 500 || message.includes("\0")) throw invalidTarget("invalid commit message");
    return { content: undefined, message };
  }
  if (value.content.length > 1024 * 1024) throw invalidTarget("file content exceeds 1 MB");
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (message.length > 500 || message.includes("\0")) throw invalidTarget("invalid commit message");
  return { content: value.content, message };
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

async function optionalCommit(repository) {
  const result = await git(repository, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  return result.code === 0 ? result.stdout.trim() : null;
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

function git(repository, arguments_, environment = {}, input?: string, author = false) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const env = author ? { ...process.env, ...environment, GIT_AUTHOR_NAME: "Snippets.run", GIT_AUTHOR_EMAIL: "registry@snippets.run", GIT_COMMITTER_NAME: "Snippets.run", GIT_COMMITTER_EMAIL: "registry@snippets.run" } : { ...process.env, ...environment };
    const child = spawn("git", ["-C", repository, ...arguments_], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env });
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

function conflict(message) {
  const error: Error & { code?: string } = new Error(message);
  error.code = "CONFLICT";
  return error;
}

function routeNotFound(request, response) {
  const { pathname } = new URL(request.url!, "http://registry.local");
  const isKnownEndpoint = pathname === "/health"
    || /^\/auth\/(?:login|callback|me|logout)$/.test(pathname)
    || /^\/api\/snippets\/[^/]+(?:\/[^/]+)?$/.test(pathname)
    || /^\/api\/(?:resolve|download)\/[^/]+\/[^/]+$/.test(pathname)
    || /^\/api\/editor\/[^/]+\/[^/]+(?:\/(?:file|commit))?$/.test(pathname);
  if (isKnownEndpoint) {
    return sendError(response, 405, "method not allowed");
  }
  sendError(response, 404, "not found");
}

function handleError(response, error: any) {
  if (error.code === "ENOENT" || error.code === "NOT_FOUND") {
    return sendError(response, 404, "snippet or reference not found");
  }

  if (error.code === "INVALID_TARGET") {
    return sendError(response, 400, error.message);
  }
  if (error.code === "CONFLICT") {
    return sendError(response, 409, error.message);
  }
  if (error.code === "AUTH_REQUIRED") {
    return sendError(response, 401, error.message);
  }

  console.error(error);
  if (!response.headersSent) {
    return sendError(response, 500, "internal server error");
  }

  response.destroy(error);
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

  const provider = process.env.AUTH_PROVIDER;
  if (!provider) throw new Error("AUTH_PROVIDER is required");
  const oidc = {
    provider: new URL(provider).origin,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    redirectUri: process.env.OIDC_REDIRECT_URI,
    webOrigin: new URL(process.env.WEB_ORIGIN || "https://snippets.run").origin,
  };
  if (!oidc.clientId || !oidc.clientSecret || !oidc.redirectUri) {
    throw new Error("OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI are required");
  }

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = createRegistryServer({
    repositoryRoot,
    oidc,
    ...(process.env.SNIPPET_STAGING_PATH ? { stagingRoot: process.env.SNIPPET_STAGING_PATH } : {}),
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`registry listening on ${port}`);
  });
}
