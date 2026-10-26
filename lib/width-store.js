const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Column counts can be as large as the input. Keep a bounded page cache and
// spill width metadata, never source text, to an operation-owned temporary file.
module.exports = class WidthStore {
  constructor({ pageUnits = 4096, cachePages = 32 } = {}) {
    this.pageUnits = pageUnits;
    this.cachePages = cachePages;
    this.pages = new Map();
    this.fileLength = 0;
  }

  update(index, width) {
    const page = this.page(index);
    const apply = (value) => {
      const offset = index % this.pageUnits;
      if (width > value.values[offset]) {
        value.values[offset] = width;
        value.dirty = true;
      }
    };
    return page?.then ? page.then(apply) : apply(page);
  }

  get(index) {
    const page = this.page(index),
      offset = index % this.pageUnits;
    return page?.then ? page.then((value) => value.values[offset]) : page.values[offset];
  }

  page(index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("Invalid alignment column");
    const id = Math.floor(index / this.pageUnits),
      found = this.pages.get(id);
    if (found) {
      this.pages.delete(id);
      this.pages.set(id, found);
      return found;
    }
    if (this.pages.size < this.cachePages && !this.file) {
      const page = { values: new Float64Array(this.pageUnits), dirty: false };
      this.pages.set(id, page);
      return page;
    }
    return this.load(id);
  }

  async load(id) {
    if (!this.file) {
      this.directory = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-align-widths-"));
      this.filePath = path.join(this.directory, "widths.bin");
      this.file = await fs.open(this.filePath, "wx+");
    }
    if (this.pages.size >= this.cachePages) {
      const [oldId, oldPage] = this.pages.entries().next().value;
      if (oldPage.dirty) {
        const bytes = Buffer.from(oldPage.values.buffer);
        const position = oldId * this.pageUnits * 8;
        let written = 0;
        while (written < bytes.length) {
          const count = (
            await this.file.write(bytes, written, bytes.length - written, position + written)
          ).bytesWritten;
          if (!count) throw new Error("Unable to write alignment width metadata");
          written += count;
        }
        this.fileLength = Math.max(this.fileLength, position + bytes.length);
      }
      this.pages.delete(oldId);
    }
    const page = { values: new Float64Array(this.pageUnits), dirty: false };
    const position = id * this.pageUnits * 8;
    if (position < this.fileLength) {
      const bytes = Buffer.from(page.values.buffer);
      let read = 0;
      while (read < bytes.length) {
        const result = await this.file.read(bytes, read, bytes.length - read, position + read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
    }
    this.pages.set(id, page);
    return page;
  }

  async dispose() {
    this.pages.clear();
    await this.file?.close();
    this.file = null;
    if (this.filePath)
      await fs.unlink(this.filePath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    if (this.directory)
      await fs.rmdir(this.directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
};
