const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('public/script.js', 'utf8');
const attemptSource = script.slice(script.indexOf('async function fetchImageAttempt('), script.indexOf('/**\n * Loads one card'));
function harness(fetch) {
  const context = vm.createContext({ fetch, AbortSignal, Error,
    StorageFetchError: class extends Error {}, readResponseBuffer: async r => r.arrayBuffer() });
  vm.runInContext(attemptSource, context);
  return (progress = () => {}) => context.fetchImageAttempt('/cached/example/image', {enabled:true}, progress);
}
for (const status of [404, 502, 503, 200]) {
  test(`origin error JSON is terminal at HTTP ${status}`, async () => {
    const phases = [];
    const run = harness(async () => Response.json({status:'error', errorStatusCode:503, message:'Origin unavailable'}, {status}));
    const result = await run(p => phases.push(p.phase));
    assert.equal(result.failed.phase, 'failed');
    assert.equal(result.failed.errorStatusCode, 503);
    assert.equal(result.pending, undefined);
    assert.deepEqual(phases, []);
  });
}
test('only explicit processing JSON polls', async () => {
  const phases = [];
  const run = harness(async () => Response.json({status:'processing',phase:'downloading'}, {status:503}));
  assert.equal((await run(p => phases.push(p.phase))).pending, true);
  assert.deepEqual(phases, ['downloading']);
});
test('plain proxy 503 is terminal rather than queued', async () => {
  const run = harness(async () => new Response('Proxy unavailable', {status:503}));
  assert.equal((await run()).failed.errorStatusCode, 503);
});
test('malformed JSON and network failures surface rather than queue forever', async () => {
  await assert.rejects(harness(async () => new Response('{', {status:503,headers:{'content-type':'application/json'}}))(), /Invalid cache API response/);
  await assert.rejects(harness(async () => {throw new Error('Failed to fetch')})(), /Cache API request failed/);
});
test('descriptor downloads ciphertext with a bounded request', async () => {
  let count = 0;
  const run = harness(async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    count++;
    return count === 1 ? Response.json({encrypted:true,url:'https://storage.example/blob'}) : new Response('ciphertext');
  });
  const result = await run();
  assert.equal(Buffer.from(result.payload).toString(), 'ciphertext');
  assert.equal(count, 2);
});
