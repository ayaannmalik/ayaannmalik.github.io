/* A strength-limited Stockfish worker. See stockfish/README.md for the pinned build. */
(function (root) {
  'use strict';

  var ENGINE_ELO = 1800;
  var WORKER_URL = 'assets/stockfish/stockfish-19-lite-single.js';
  var MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

  function cancelled() {
    var error = new Error('The game was reset.');
    error.name = 'AbortError';
    return error;
  }

  class SiteChessEngine {
    constructor(options = {}) {
      this.workerFactory = options.workerFactory || (() => new Worker(WORKER_URL));
      this.startupTimeoutMs = options.startupTimeoutMs || 30000;
      this.searchTimeoutMs = options.searchTimeoutMs || 15000;
      this.worker = null;
      this.ready = null;
      this.boot = null;
      this.search = null;
    }

    reset() {
      this.fail(cancelled());
    }

    fail(error) {
      var worker = this.worker;
      this.worker = null;
      this.ready = null;
      if (worker) worker.terminate();
      for (var key of ['boot', 'search']) {
        var pending = this[key];
        this[key] = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
      }
    }

    prepare() {
      if (this.ready) return this.ready;
      this.ready = new Promise((resolve, reject) => {
        var worker = this.workerFactory();
        this.worker = worker;
        var supportsLimit = false;
        var supportsElo = false;
        this.boot = {
          resolve, reject,
          timer: setTimeout(() => this.fail(new Error('Engine loading timed out.')), this.startupTimeoutMs)
        };
        worker.onerror = () => {
          if (this.worker === worker) this.fail(new Error('The chess engine could not load.'));
        };
        worker.onmessage = (event) => {
          if (this.worker !== worker) return;
          for (var line of String(event.data).split(/\r?\n/)) {
            line = line.trim();
            if (line.startsWith('option name UCI_LimitStrength type check')) supportsLimit = true;
            var range = line.match(/^option name UCI_Elo .* min (\d+) max (\d+)/);
            if (range) supportsElo = Number(range[1]) <= ENGINE_ELO && Number(range[2]) >= ENGINE_ELO;
            if (line === 'uciok') {
              if (!supportsLimit || !supportsElo) {
                this.fail(new Error('This engine does not support the requested strength.'));
                return;
              }
              worker.postMessage('setoption name Hash value 16');
              worker.postMessage('setoption name Ponder value false');
              worker.postMessage('setoption name UCI_LimitStrength value true');
              worker.postMessage('setoption name UCI_Elo value ' + ENGINE_ELO);
              worker.postMessage('ucinewgame');
              worker.postMessage('isready');
            } else if (line === 'readyok' && this.boot) {
              var boot = this.boot;
              this.boot = null;
              clearTimeout(boot.timer);
              boot.resolve();
            } else if (line.startsWith('bestmove ') && this.search) {
              var move = line.split(/\s+/)[1];
              if (!MOVE_PATTERN.test(move)) {
                this.fail(new Error('The engine did not return a move.'));
                return;
              }
              var search = this.search;
              this.search = null;
              clearTimeout(search.timer);
              search.resolve(move);
            }
          }
        };
        worker.postMessage('uci');
      });
      return this.ready;
    }

    async move(history) {
      if (!Array.isArray(history) || history.some(move => !MOVE_PATTERN.test(move))) {
        throw new Error('Invalid move history.');
      }
      var ready = this.prepare();
      var worker = this.worker;
      await ready;
      if (this.worker !== worker) throw cancelled();
      if (this.search) throw new Error('An engine move is already pending.');
      return new Promise((resolve, reject) => {
        this.search = {
          resolve, reject,
          timer: setTimeout(() => this.fail(new Error('Engine search timed out.')), this.searchTimeoutMs)
        };
        // Preserve repetition history instead of sending only the current FEN.
        worker.postMessage('position startpos' + (history.length ? ' moves ' + history.join(' ') : ''));
        worker.postMessage('go movetime 1000');
      });
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = SiteChessEngine;
  else root.SiteChessEngine = SiteChessEngine;
})(globalThis);
