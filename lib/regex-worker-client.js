const { Worker } = require("node:worker_threads");

module.exports = class RegexWorker {
  constructor(signal) {
    this.signal = signal;
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Electron's Chromium Worker.
    if (process.type === "renderer" && typeof globalThis.Worker === "function") {
      const source = require("node:fs").readFileSync(require.resolve("./regex-worker"), "utf8");
      this.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Electron's Chromium Worker.
      this.worker = new globalThis.Worker(this.url);
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.fail(new Error(event.message));
      };
    } else {
      this.worker = new Worker(require.resolve("./regex-worker"));
      this.worker.on("message", (data) => this.receive(data));
      this.worker.on("error", (error) => this.fail(error));
      this.worker.unref();
    }
    this.abort = () =>
      this.fail(Object.assign(new Error("Alignment was cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  receive(data) {
    if (!this.pending) return;
    const { resolve, reject, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    if (data.error) reject(new Error(data.error));
    else resolve(data);
  }

  request(data) {
    if (this.signal?.aborted || this.disposed)
      return Promise.reject(
        Object.assign(new Error("Alignment was cancelled"), { name: "AbortError" }),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            Object.assign(
              new Error(
                "The separator expression exceeded its one-second execution budget. Simplify the expression.",
              ),
              { code: "ERR_ALIGN_REGEX_TIMEOUT" },
            ),
          ),
        1000,
      );
      this.pending = { resolve, reject, timer };
      this.worker.postMessage(data);
    });
  }

  fail(error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.abort);
    this.worker.terminate();
    if (this.url) URL.revokeObjectURL(this.url);
  }
};
