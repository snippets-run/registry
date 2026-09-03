# Snippets.run Registry

Git-backed HTTP registry for the Snippets.run runner. It resolves branches, tags, and commit references without requiring the runner to clone repositories locally. The runner uses `latest` as the default reference when none is specified.

## Snippet Contract

Snippet repository names carry an immutable runtime suffix:

| Suffix | Type |
| --- | --- |
| `.sh` | `bash` |
| `.js` | `node` |
| `.py` | `python` |

Each type has exactly one required root-level entrypoint:

| Type | Entrypoint |
| --- | --- |
| `bash` | `main.sh` |
| `node` | exactly one of `index.js` or `index.mjs` |
| `python` | `main.py` |

Node repositories may contain `index.js` or `index.mjs`, but not both. The suffix determines the runtime and cannot change after repository creation. Repository contents never override it.

## Repository Storage

Repositories are stored at `$SNIPPET_REPOSITORIES_PATH/<owner>/<repo>`, for example `/repositories/snippets/hello.sh`. Bare and working-tree Git repositories are supported. Production deployments should mount the repository root read-only at `/repositories`.

## API

- Resolve a branch, tag, or commit:

```http
GET /api/resolve/snippets/hello.sh@v1
```

```json
{
  "owner": "snippets",
  "repo": "hello.sh",
  "type": "bash",
  "ref": "v1",
  "commit": "a672cb7f3d62e7c19fde5f4e0391a63d65d34a00"
}
```

- Download an immutable commit archive.
The response is a `tar.gz` stream produced by `git archive`.
Errors use JSON in the form `{"error":"message"}`.

```http
GET /api/download/snippets/hello.sh@a672cb7f3d62e7c19fde5f4e0391a63d65d34a00
```

- Returns the service health status.

```http
GET /health
```

- Browse an owner's snippets:

```http
GET /api/snippets/owner
```

```json
[
  {
    "owner": "snippets",
    "repo": "hello.sh",
    "type": "bash"
  }
]
```

- Show the current entrypoint source for a snippet:

```http
GET /api/snippets/snippets/hello.sh
```

The detail response includes `owner`, `repo`, `type`, `entrypoint`, the resolved `commit`, and `script`.
It reads `HEAD`; use the resolve and download endpoints when an immutable archive is required.

### Editor API

The editor API exposes a constrained workspace rather than Git. It only accepts validated owner, repository, and tracked-file identifiers, with content limited to 1 MB. Staged changes are held server-side in a private Git index until committed.

```http
GET /api/editor/snippets/hello.sh
PUT /api/editor/snippets/hello.sh/file?path=main.sh
POST /api/editor/snippets/hello.sh/commit
Content-Type: application/json

{"message":"Explain the update"}
```

The workspace response includes tracked file contents, staged state, and recent commit metadata. The commit message is optional and defaults to `Update snippet`.
Configure `SNIPPET_STAGING_PATH` to store private indexes outside the repository root.

## Development

Requires Node.js 22 or newer and Git.

```sh
npm ci
npm test
```

`npm test` builds the TypeScript server, exercises the registry API with temporary Git repositories, and runs Bash, Node.js, and Python snippets through the sibling `snippets-run/runners` checkout. Set `RUNNERS_PATH` when that checkout is elsewhere.

Run locally:

```sh
npm run build
SNIPPET_REPOSITORIES_PATH=/path/to/repositories PORT=3000 npm start
```

## Docker

```sh
docker build --no-cache -t ghcr.io/snippets-run/registry:latest .
docker push ghcr.io/snippets-run/registry:latest
```

The production image includes Node.js and Git, listens on port `3000` by default, and expects repositories at `/repositories`.
