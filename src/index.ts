// @ts-ignore
import { Store } from 'https://store.homebots.io/index.mjs'
import router from "micro-router";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const store = Store.get(process.env.STORE_ID);
const snippetStore = store.getResource("s");
const getSnippetId = ({ platform, owner, name }) =>
  createHash("sha256").update(`${platform}:${owner}/${name}`).digest("hex");

const handler = router({
  "GET /index": onIndex,
  "GET /search": onSearch,
  "GET /uid/:platform/:owner/:name": onGetUid,
  "GET /snippets/:platform/:owner/:name": onGet,
  "GET /s/:platform/:owner/:name": onReadSnippet,
  "GET /s/:platform/:name": onReadSnippet,
  "PUT /s/:platform/:owner/:name": onWriteSnippet,
});

function onGetUid(_req, res, args) {
  const { owner = "snippets", name, platform } = args;
  res.send(getSnippetId({ platform, owner, name }));
}

async function onReadSnippet(_req, res, args) {
  const { owner = "snippets", name, platform } = args;
  let snippet;

  try {
    snippet = await getSnippet(platform, owner, name);
  } catch (error) {
    console.log(error);
    res.writeHead(404, String(error)).end();
    return;
  }

  switch (platform) {
    case "node":
      return getNodeSnippet(res, snippet);

    case "shell":
      return getShellSnippet(res, snippet);

    default:
      res.writeHead(400, "Invalid snippet format: " + platform);
  }
}

async function onWriteSnippet(req, res, args) {
  try {
    const { owner, name, platform } = args;
    const buffer = await readStream(req);
    const json = JSON.parse(buffer.toString("utf8"));
    const inputs = json.inputs?.map((i) => ({
      name: i.name,
      description: i.description,
    }));
    const script = json.script;
    const { description = "" } = json;

    if (!script) {
      res.writeHead(400, "Script cannot be empty").end();
      return;
    }

    const id = getSnippetId(args);
    const snippet = {
      id,
      inputs,
      script,
      platform,
      owner,
      name,
      description,
    };
    await snippetStore.set(id, snippet);
    res.end("OK");
  } catch (error) {
    console.log(error);
    res.writeHead(500, String(error)).end();
  }
}

async function onGet(_req, res, args) {
  try {
    const snippet = await snippetStore.get(getSnippetId(args));
    res.end(JSON.stringify(snippet));
  } catch (error) {
    res.writeHead(400, String(error)).end();
  }
}

async function onIndex(_req, res) {
  const list = await snippetStore.list();

  res.end(
    JSON.stringify(
      list.map((s) => ({ platform: s.platform, owner: s.owner, name: s.name }))
    )
  );
}

async function onSearch(_req, res) {
  const list = await snippetStore.list();
  res.end(JSON.stringify(list));
}

async function getNodeSnippet(res, snippet) {
  try {
    const { inputs = [], script = "", description = "" } = snippet;
    const json = JSON.stringify({ inputs, script, description });
    res.end(json);
  } catch (error) {
    console.log(error);
    res.writeHead(400, String(error)).end();
  }
}

async function getShellSnippet(res, snippet) {
  try {
    const inputs = snippet.inputs
      .map((i) => `echo ${i.description || i.name}?\nread ${i.name}`)
      .join("\n");
    const script = `#!/bin/bash
    ${inputs}
    ${snippet.script}
    `;
    res.end(script);
  } catch (error) {
    console.log(error);
    res.writeHead(400, String(error)).end();
  }
}

async function getSnippet(platform, owner, name) {
  const id = getSnippetId({ platform, owner, name });

  try {
    return await snippetStore.get(id);
  } catch (error) {
    console.log('getSnippet', error);
    throw new Error("Snippet not found");
  }
}

function readStream(stream): Promise<Buffer> {
  const all = [];

  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("data", (c) => all.push(c));
    stream.on("end", () => resolve(Buffer.concat(all)));
  });
}

createServer((req, res) => {
  const end = res.end;
  res.end = (...args) => {
    console.log(
      `${req.method} ${req.url} [${res.statusCode}] ${res.statusMessage}`
    );
    return end.call(res, ...args);
  };

  handler(req, res);
}).listen(Number(process.env.PORT));
