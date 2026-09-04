import assert from "node:assert/strict";
import test from "node:test";

import { createSnippetRepository, startRegistry } from "./helpers.mjs";

test("resolves a tag and streams its archive", async (t) => {
  const snippet = await createSnippetRepository();
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const resolveResponse = await fetch(`${registry.url}/api/resolve/acme/hello.sh@v1`);
  assert.equal(resolveResponse.status, 200);
  assert.deepEqual(await resolveResponse.json(), {
    owner: "acme",
    repo: "hello.sh",
    type: "bash",
    ref: "v1",
    commit: snippet.commit,
  });

  const branchStyleRef = await fetch(`${registry.url}/api/resolve/acme/hello.sh@release%2Fv1`);
  assert.equal(branchStyleRef.status, 200);
  assert.equal((await branchStyleRef.json()).ref, "release/v1");

  const archiveResponse = await fetch(`${registry.url}/api/download/acme/hello.sh@${snippet.commit}`);
  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.headers.get("content-type"), "application/gzip");
  assert.ok((await archiveResponse.arrayBuffer()).byteLength > 0);
});

test("returns JSON errors for missing snippets", async (t) => {
  const snippet = await createSnippetRepository();
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const response = await fetch(`${registry.url}/api/resolve/acme/missing.sh@v1`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "snippet or reference not found" });
});

test("rejects repositories without an immutable type suffix", async (t) => {
  const snippet = await createSnippetRepository();
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const response = await fetch(`${registry.url}/api/resolve/acme/hello@v1`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "repository name must end in .sh, .js, or .py" });
});

test("returns the type encoded in each supported repository suffix", async (t) => {
  for (const [repo, entrypoint, type] of [
    ["hello.sh", "main.sh", "bash"],
    ["hello.js", "index.js", "node"],
    ["hello.py", "main.py", "python"],
  ]) {
    const snippet = await createSnippetRepository({ repo, entrypoint, contents: "" });
    const registry = await startRegistry(snippet.root);
    t.after(async () => {
      await registry.close();
      await snippet.remove();
    });

    const response = await fetch(`${registry.url}/api/resolve/acme/${repo}@v1`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).type, type);
  }
});

test("lists an owner's snippets and returns entrypoint details", async (t) => {
  const snippet = await createSnippetRepository({ contents: "printf 'hello\\n'\n" });
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const listResponse = await fetch(`${registry.url}/api/snippets/acme`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), [{ owner: "acme", repo: "hello.sh", type: "bash" }]);

  const detailResponse = await fetch(`${registry.url}/api/snippets/acme/hello.sh`);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(await detailResponse.json(), {
    owner: "acme",
    repo: "hello.sh",
    type: "bash",
    entrypoint: "main.sh",
    commit: snippet.commit,
    script: "printf 'hello\\n'\n",
  });
});

test("stages editor updates privately and commits them with a summary", async (t) => {
  const snippet = await createSnippetRepository({ contents: "printf 'hello\\n'\n" });
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const workspace = await fetch(`${registry.url}/api/editor/acme/hello.sh`);
  assert.equal(workspace.status, 200);
  assert.equal((await workspace.json()).files[0].content, "printf 'hello\\n'\n");

  const staged = await fetch(`${registry.url}/api/editor/acme/hello.sh/file?path=main.sh`, {
    method: "PUT",
    body: "printf 'updated\\n'\n",
  });
  assert.equal(staged.status, 200);

  const stagedWorkspace = await fetch(`${registry.url}/api/editor/acme/hello.sh`);
  assert.equal((await stagedWorkspace.json()).files[0].staged, true);

  const committed = await fetch(`${registry.url}/api/editor/acme/hello.sh/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Refresh greeting" }),
  });
  assert.equal(committed.status, 201);
  assert.match((await committed.json()).commit, /^[0-9a-f]{40}$/);

  const detail = await fetch(`${registry.url}/api/snippets/acme/hello.sh`);
  assert.equal((await detail.json()).script, "printf 'updated\\n'\n");
});

test("rejects unsafe editor file paths", async (t) => {
  const snippet = await createSnippetRepository();
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const response = await fetch(`${registry.url}/api/editor/acme/hello.sh/file?path=../secret`, {
    method: "PUT",
    body: "nope",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid file path" });
});

test("creates and deletes snippets through the API", async (t) => {
  const snippet = await createSnippetRepository();
  const registry = await startRegistry(snippet.root);
  t.after(async () => {
    await registry.close();
    await snippet.remove();
  });

  const created = await fetch(`${registry.url}/api/snippets/acme/goodbye.py`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "print('goodbye')\n", message: "Create goodbye" }),
  });
  assert.equal(created.status, 201);
  assert.match((await created.json()).commit, /^[0-9a-f]{40}$/);

  const detail = await fetch(`${registry.url}/api/snippets/acme/goodbye.py`);
  assert.deepEqual(await detail.json(), {
    owner: "acme",
    repo: "goodbye.py",
    type: "python",
    entrypoint: "main.py",
    commit: (await fetch(`${registry.url}/api/resolve/acme/goodbye.py@main`).then((response) => response.json())).commit,
    script: "print('goodbye')\n",
  });

  const duplicate = await fetch(`${registry.url}/api/snippets/acme/goodbye.py`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "print('again')\n" }),
  });
  assert.equal(duplicate.status, 409);

  const deleted = await fetch(`${registry.url}/api/snippets/acme/goodbye.py`, { method: "DELETE" });
  assert.deepEqual(await deleted.json(), { owner: "acme", repo: "goodbye.py", deleted: true });
  assert.equal((await fetch(`${registry.url}/api/snippets/acme/goodbye.py`)).status, 404);
});
