export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  /*******************************************************************************
   * Function: runExclusive
   *
   * Serializes operations and releases the mutex when each operation
   * completes.
   ******************************************************************************/
  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.#tail;
    this.#tail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
