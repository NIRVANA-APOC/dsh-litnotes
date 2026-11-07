/**
 * Write serialization for the library store.
 *
 * `makeDocQueue` provides the per-document promise chain that makes annotation
 * read-modify-write cycles and metadata writes atomic with respect to each
 * other; `makeSerialChain` is the simpler single chain used for library-level
 * files. Neither queue holds a lock after its tail settles, so an idle store
 * has no bookkeeping entries left behind.
 *
 * @module host/store/queue
 */

import type { DocumentQueue } from '../contracts.ts'

/** A single FIFO chain of asynchronous writes. */
export interface SerialChain {
  run: <T>(task: () => Promise<T>) => Promise<T>
}

/**
 * Create a per-document promise queue.
 *
 * @returns the queue facade documented by `DocumentQueue`.
 */
export function makeDocQueue(): DocumentQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    /**
     * Run `task` after every previously queued task for `id` settles.
     *
     * @param id - document id.
     * @param task - work to serialize.
     * @returns the task's own result (its failure does not poison the queue).
     */
    run<T>(id: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve()
      const run = previous.then(task)
      const tail: Promise<void> = run.then(
        () => undefined,
        () => undefined,
      )
      tails.set(id, tail)
      void tail.then(() => {
        if (tails.get(id) === tail) tails.delete(id)
      })
      return run
    },
    /** Snapshot of currently pending write chains. */
    pending(): Promise<unknown>[] {
      return [...tails.values()]
    },
    /** Number of documents with pending writes. */
    size(): number {
      return tails.size
    },
  }
}

/**
 * Create a single serial chain for library-level file writes.
 *
 * @returns the chain facade.
 */
export function makeSerialChain(): SerialChain {
  let tail: Promise<void> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task)
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
}
