import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { createRegistryServer } from "../dist/index.mjs";

export async function createSnippetRepository(options = {}) {
  const {
    repo = "hello.sh",
    entrypoint = "main.sh",
    contents = "printf '%s\\n' \"$INPUTS_NAME\"\n",
  } = options;
  const root = await mkdtemp(join(tmpdir(), "snippets-run-registry-"));
  const repository = join(root, "acme", repo);
  await mkdir(repository, { recursive: true });
  runGit(repository, ["init"]);
  runGit(repository, ["config", "user.email", "test@example.com"]);
  runGit(repository, ["config", "user.name", "Test"]);
  await writeFile(join(repository, entrypoint), contents);
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-m", "initial snippet"]);
  runGit(repository, ["tag", "v1"]);
  runGit(repository, ["tag", "release/v1"]);
  const commit = runGit(repository, ["rev-parse", "HEAD"]).trim();
  return { root, repository, commit, remove: () => rm(root, { recursive: true, force: true }) };
}

export async function startRegistry(repositoryRoot) {
  const server = createRegistryServer({ repositoryRoot });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

export function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runGit(directory, arguments_) {
  const result = spawnSync("git", ["-C", directory, ...arguments_], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}
