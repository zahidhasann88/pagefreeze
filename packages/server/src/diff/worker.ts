import { parentPort } from 'node:worker_threads';
import type { DiffRequest, DiffResult } from './types.js';
import { runDiffInProcess } from './runDiff.js';

/**
 * Worker thread entry point for diffing.
 *
 * One request is processed at a time: pixelmatch and jsdiff are CPU bound and there is
 * no benefit to interleaving them inside a single thread. The owning
 * `WorkerDiffEngine` serialises calls.
 */

if (!parentPort) {
  throw new Error('diff worker must be started with a parent port');
}

const port = parentPort;

port.on('message', (request: DiffRequest) => {
  try {
    const result: DiffResult = runDiffInProcess(request);
    port.postMessage({ ok: true, result });
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
