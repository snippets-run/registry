import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createSnippetRepository, run, startRegistry } from "./helpers.mjs";

test("Go runner executes every supported snippet type", async (t) => {
  const root = process.env.RUNNERS_PATH ?? resolve(import.meta.dirname, "../../runners");
  const temporary = await mkdtemp(join(tmpdir(), "snippets-run-e2e-"));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  const binary = join(temporary, "run");
  const build = await run("go", ["build", "-o", binary, "./cmd/run"], { cwd: root });
  assert.equal(build.code, 0, build.stderr);

  for (const [repo, entrypoint, contents] of [
    ["hello.sh", "main.sh", "printf '%s\\n' \"$INPUTS_NAME\"\n"],
    ["hello.js", "index.js", "console.log(process.env.INPUTS_NAME)\n"],
    ["hello.py", "main.py", "import os\nprint(os.environ['INPUTS_NAME'])\n"],
  ]) {
    const snippet = await createSnippetRepository({ repo, entrypoint, contents });
    const registry = await startRegistry(snippet.root);
    try {
      const result = await run(binary, [`acme/${repo}@v1`, "--name=Alice"], {
        cwd: root,
        env: {
          ...process.env,
          SNIPPET_CACHE_PATH: join(temporary, "cache"),
          SNIPPET_REGISTRY_URL: registry.url,
        },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "Alice\n");
    } finally {
      await registry.close();
      await snippet.remove();
    }
  }
});
