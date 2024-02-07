import router from 'micro-router';
import { createServer } from 'node:http';
import { Store } from './store.js';

const store = Store.get(process.env.STORE_ID);
const snippetStore = store.getResource('s');

async function onReadSnippet(_req, res, args) {
  const { owner = 'snippets', name, platform } = args;
  let snippet;

  try {
    snippet = await getSnippet(owner, name);
  } catch (error) {
    res.writeHead(404, String(error));
    return;
  }

  if (snippet.platform !== platform) {
    res.writeHead(415, 'Snippet is for another platform').end();
    return;
  }

  switch (platform) {
    case 'node':
      return getNodeSnippet(res, snippet);

    case 'shell':
      return getShellSnippet(res, snippet);

    default:
      res.writeHead(400, 'Invalid snippet format: ' + platform);
  }
}

async function onWriteSnippet(req, res, args) {
  try {
    const { owner, name, platform } = args;
    const snippet = await readStream(req);
    const json = JSON.parse(snippet.toString('utf8'));
    const inputs = json.inputs.map((i) => ({ name: i.name, description: i.description }));
    const script = json.script;

    if (!script) {
      res.writeHead(400, 'Script cannot be empty').end();
      return;
    }

    const text = JSON.stringify({ inputs, script, platform });
    await snippetStore.set(`${owner}/${name}`, text);
    res.end('OK');
  } catch (error) {
    console.log(error);
    res.writeHead(500, String(error)).end();
  }
}

const handler = router({
  'GET /s/:platform/:name': onReadSnippet,
  'GET /s/:platform/:owner/:name': onReadSnippet,
  'POST /s/:platform/:owner/:name': onWriteSnippet,
});

createServer(handler).listen(Number(process.env.PORT));

async function getNodeSnippet(res, snippet) {
  try {
    const { inputs = [], script = '' } = snippet;
    const json = JSON.stringify({ inputs, script });
    res.end(json);
  } catch (error) {
    res.writeHead(400, String(error)).end();
  }
}

async function getShellSnippet(res, snippet) {
  try {
    const inputs = snippet.inputs.map((i) => `echo ${i.description || i.name}?\nread ${i.name}`).join('\n');
    const script = `#!/bin/bash
    ${inputs}
    ${snippet.script}
    `;
    res.end(script);
  } catch (error) {
    res.writeHead(400, String(error)).end();
  }
}

async function getSnippet(owner, name) {
  try {
    return await snippetStore.get(`${owner}/${name}`);
  } catch {
    throw new Error('Snippet not found');
  }
}

function readStream(stream): Promise<Buffer> {
  const all = [];

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', (c) => all.push(c));
    stream.on('end', () => resolve(Buffer.concat(all)));
  });
}
