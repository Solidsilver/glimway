/**
 * One in-order queue for every server call (design, "Client-side ordering"):
 * progress uploads, syncs and spends never overlap, so a request always sees
 * the revision the previous one returned. A failed task does not stop the
 * queue; its error goes to its own caller only.
 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks queued or running. */
  readonly size: number;
  /** Resolves once everything queued so far has settled. */
  idle(): Promise<void>;
}

export function createQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let size = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      size += 1;
      const result = tail.then(task, task);
      tail = result.then(
        () => {
          size -= 1;
        },
        () => {
          size -= 1;
        },
      );
      return result;
    },
    get size() {
      return size;
    },
    idle() {
      return tail.then(() => undefined);
    },
  };
}
