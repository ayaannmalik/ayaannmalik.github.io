const assert = require('node:assert/strict');
const { test } = require('node:test');
const Engine = require('../assets/chess-engine.js');

class FakeWorker {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage({ data }); }
  ready() {
    this.emit('option name UCI_LimitStrength type check default false');
    this.emit('option name UCI_Elo type spin default 1320 min 1320 max 3190');
    this.emit('uciok');
    this.emit('readyok');
  }
}

function fixture(options = {}) {
  const workers = [];
  const engine = new Engine({ ...options, workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  return { engine, workers };
}

test('every fresh game enables the 1800 limit before any search and retains move history', async () => {
  const { engine, workers } = fixture();
  try {
    for (let game = 0; game < 2; game++) {
      const result = engine.move(['e2e4', 'e7e5', 'g1f3']);
      const worker = workers[game];
      assert.deepEqual(worker.messages, ['uci']);
      worker.ready();
      await Promise.resolve();
      assert.deepEqual(worker.messages, [
        'uci', 'setoption name Hash value 16', 'setoption name Ponder value false',
        'setoption name UCI_LimitStrength value true', 'setoption name UCI_Elo value 1800',
        'ucinewgame', 'isready', 'position startpos moves e2e4 e7e5 g1f3', 'go movetime 1000'
      ]);
      worker.emit('bestmove b8c6 ponder f1b5');
      assert.equal(await result, 'b8c6');
      engine.reset();
      assert.equal(worker.terminated, true);
    }
  } finally { engine.reset(); }
});

test('reset cancels loading and stale worker events cannot satisfy a new request', async () => {
  const { engine, workers } = fixture();
  try {
    const old = engine.move([]);
    const rejected = assert.rejects(old, { name: 'AbortError' });
    engine.reset();
    await rejected;
    const next = engine.move([]);
    workers[0].ready();
    workers[0].emit('bestmove a2a4');
    assert.deepEqual(workers[1].messages, ['uci']);
    workers[1].ready();
    await Promise.resolve();
    workers[1].emit('bestmove e2e4');
    assert.equal(await next, 'e2e4');
  } finally { engine.reset(); }
});

test('reset cancels an active search rather than applying its eventual move', async () => {
  const { engine, workers } = fixture();
  const result = engine.move([]);
  workers[0].ready();
  await Promise.resolve();
  const rejected = assert.rejects(result, { name: 'AbortError' });
  engine.reset();
  workers[0].emit('bestmove e2e4');
  await rejected;
  assert.equal(workers[0].terminated, true);
});

test('a worker without strength controls never starts unrestricted play', async () => {
  const { engine, workers } = fixture();
  const result = engine.move([]);
  workers[0].emit('uciok');
  await assert.rejects(result, /does not support/);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.some(message => message.startsWith('go ')), false);
});

test('load and search failures are bounded, with no infinite retries', async () => {
  const load = fixture({ startupTimeoutMs: 15 });
  await assert.rejects(load.engine.move([]), /loading timed out/);
  assert.equal(load.workers[0].terminated, true);
  const search = fixture({ searchTimeoutMs: 15 });
  const result = search.engine.move([]);
  search.workers[0].ready();
  await assert.rejects(result, /search timed out/);
  assert.equal(search.workers[0].terminated, true);
});

test('malformed history and a missing best move cannot reach the game', async () => {
  const { engine, workers } = fixture();
  await assert.rejects(engine.move(['e2e4\ngo infinite']), /Invalid move history/);
  assert.equal(workers.length, 0);
  const result = engine.move([]);
  workers[0].ready();
  await Promise.resolve();
  workers[0].emit('bestmove (none)');
  await assert.rejects(result, /did not return a move/);
  assert.equal(workers[0].terminated, true);
});
