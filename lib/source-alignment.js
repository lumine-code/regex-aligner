const { TextBuffer } = require("lumine");
const WidthStore = require("./width-store");
const RegexWorker = require("./regex-worker-client");
const NATIVE_LINE_LIMIT = 8 * 1024 * 1024;

function literalSeparator(regex) {
  if (regex.flags.replace(/g/g, "")) return null;
  let expression = regex.source;
  while (/^\((?:\?:)?[^()]*\)$/.test(expression))
    expression = expression.slice(expression.startsWith("(?:") ? 3 : 1, -1);
  let result = "";
  const escapes = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" };
  for (let index = 0; index < expression.length; index++) {
    let char = expression[index];
    if (char === "\\") {
      char = expression[++index];
      if (!char || !"\\/.*+?^$()[]{}|nrtfv".includes(char)) return null;
      char = escapes[char] ?? char;
    } else if (".*+?^$()[]{}|".includes(char)) return null;
    result += char;
  }
  return result || null;
}

function spacesFactory() {
  const powers = [TextBuffer.createTextSnapshot(" ")];
  const empty = TextBuffer.createTextSnapshot();
  return (count) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid padding width");
    let result = empty,
      index = 0;
    while (count) {
      if (!powers[index])
        powers[index] = powers[index - 1].replace(
          powers[index - 1].length,
          powers[index - 1].length,
          powers[index - 1],
        );
      if (count % 2) result = result.replace(result.length, result.length, powers[index]);
      count = Math.floor(count / 2);
      index++;
    }
    return result;
  };
}

function rowInfo(source, row) {
  const start = source.lineStart(row),
    next = row + 1 < source.lineCount ? source.lineStart(row + 1) : source.length;
  let end = next;
  if (row + 1 < source.lineCount) end--;
  const lineEnd = row + 1 < source.lineCount && source.charCodeAt(end - 1) === 13 ? end - 1 : end;
  return { start, end, lineEnd, next, row };
}

function* trimmed(source, start, end, left) {
  if (left)
    while (start < end) {
      const text = source.slice(start, Math.min(end, start + 16384));
      const count = text.length - text.trimStart().length;
      start += count;
      if (count === text.length && text.length >= 16384) yield null;
      if (count !== text.length) break;
    }
  while (start < end) {
    const text = source.slice(Math.max(start, end - 16384), end);
    const count = text.length - text.trimEnd().length;
    end -= count;
    if (count === text.length && text.length >= 16384) yield null;
    if (count !== text.length) break;
  }
  return [start, end];
}

function* literalCells(source, info, separator) {
  let start = info.start,
    column = 0,
    cursor = start;
  let input = "",
    inputStart = -1,
    inputEnd = -1;
  for (;;) {
    let match = -1;
    if (!separator.includes("\n"))
      while (cursor + separator.length <= info.end) {
        if (cursor < inputStart || cursor + separator.length > inputEnd) {
          inputStart = cursor;
          inputEnd = Math.min(info.end, cursor + 65536 + separator.length - 1);
          input = source.slice(inputStart, inputEnd);
        }
        const found = input.indexOf(separator, cursor - inputStart);
        if (found >= 0) {
          match = inputStart + found;
          break;
        }
        if (inputEnd === info.end) break;
        cursor = Math.max(cursor, inputStart + 65536);
        inputStart = inputEnd = -1;
        yield null;
      }
    const separatorStart = match < 0 ? info.end : match;
    const separatorEnd = match < 0 ? info.end : match + separator.length;
    const [contentStart, contentEnd] = yield* trimmed(source, start, separatorStart, column > 0);
    yield {
      ...info,
      start: contentStart,
      end: contentEnd,
      column: column++,
      separatorStart,
      separatorEnd,
      final: match < 0,
      separatorHead: match < 0 ? 0 : separator.length - separator.trimStart().length,
      separatorTail: match < 0 ? 0 : separator.length - separator.trimEnd().length,
      lineEnd: info.lineEnd,
    };
    if (match < 0) return;
    start = cursor = separatorEnd;
  }
}

async function* cellBatches(source, block, regex, literal, worker, check) {
  if (literal !== null) {
    let batch = [];
    for (let row = block.start; row < block.end; row++) {
      for (const cell of literalCells(source, rowInfo(source, row), literal)) {
        if (cell) batch.push(cell);
        if (!cell || batch.length === 512) {
          if (batch.length === 512) {
            yield batch;
            batch = [];
          }
          const pending = check();
          if (pending) await pending;
        }
      }
      const pending = check();
      if (pending) await pending;
    }
    if (batch.length) yield batch;
    return;
  }
  for (let row = block.start; row < block.end;) {
    const rows = [],
      descriptions = [];
    let units = 0;
    while (row < block.end && rows.length < 256 && units < 1024 * 1024) {
      const info = rowInfo(source, row++);
      if (info.end - info.start > NATIVE_LINE_LIMIT)
        throw Object.assign(
          new Error(
            "This separator requires a complete native regex input. Its line exceeds 8 Mi UTF-16 units; use a literal separator for this line.",
          ),
          { code: "ERR_ALIGN_NATIVE_LINE_LIMIT" },
        );
      rows.push(source.slice(info.start, info.end));
      descriptions.push(info);
      units += info.end - info.start;
      const pending = check();
      if (pending) await pending;
    }
    let response = await worker.request({
      rows,
      source: regex.source,
      flags: regex.flags.replace(/g/g, "") + "g",
    });
    for (;;) {
      const pending = check();
      if (pending) await pending;
      yield response.cells.map((cell) => {
        const info = descriptions[cell.row];
        return {
          ...cell,
          row: info.row,
          start: info.start + cell.start,
          end: info.start + cell.end,
          separatorStart: info.start + cell.separatorStart,
          separatorEnd: info.start + cell.separatorEnd,
          lineEnd: info.lineEnd,
          next: info.next,
        };
      });
      if (response.done) break;
      response = await worker.request({ next: true });
    }
  }
}

function blocksFor(editor) {
  const result = [];
  for (const range of editor.getSelectedBufferRanges().sort((a, b) => a.compare(b))) {
    const start = range.start.row,
      end = range.end.row + (range.end.column > 0 ? 1 : 0);
    if (start >= end) continue;
    const previous = result.at(-1);
    if (previous && start < previous.end) previous.end = Math.max(previous.end, end);
    else result.push({ start, end });
  }
  return result;
}

async function align(editor, regex, { signal, isCurrent = () => true } = {}) {
  const buffer = editor.getBuffer(),
    source = buffer.getTextSnapshot(),
    revision = buffer.getTextRevision();
  const selected = editor.getSelectedBufferRanges(),
    blocks = blocksFor(editor);
  const controller = new AbortController();
  const linked = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const current = () =>
    !linked.aborted &&
    !editor.isDestroyed() &&
    !editor.isReadOnly() &&
    buffer.getTextRevision() === revision &&
    isCurrent() &&
    editor.getSelectedBufferRanges().length === selected.length &&
    editor.getSelectedBufferRanges().every((range, index) => range.isEqual(selected[index]));
  let externalSelectionChange = false;
  const subscriptions = [
    buffer.onDidChange(() => controller.abort()),
    editor.onDidDestroy(() => controller.abort()),
    editor.onDidChangeSelectionRange((event) => {
      if (!event.textChanged) externalSelectionChange = true;
      controller.abort();
    }),
  ];
  let deadline = performance.now() + 4;
  const check = () => {
    if (!current())
      throw Object.assign(new Error("Alignment was cancelled"), { name: "AbortError" });
    if (performance.now() >= deadline)
      return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
        deadline = performance.now() + 4;
        if (!current())
          throw Object.assign(new Error("Alignment was cancelled"), { name: "AbortError" });
      });
  };
  const literal = literalSeparator(regex),
    worker = literal === null ? new RegexWorker(linked) : null;
  const spaces = spacesFactory();
  const empty = TextBuffer.createTextSnapshot();
  async function* edits() {
    for (const block of blocks) {
      const widths = block.end - block.start > 1 ? new WidthStore() : null;
      try {
        if (widths)
          for await (const batch of cellBatches(source, block, regex, literal, worker, check))
            for (const cell of batch) {
              const pending = widths.update(cell.column, cell.end - cell.start);
              if (pending) await pending;
            }
        let cursor = source.lineStart(block.start),
          pendingText = empty,
          batch = [];
        const append = (text) => {
          if (!text.length) return;
          pendingText = pendingText.replace(pendingText.length, pendingText.length, text);
        };
        const retain = (start, end) => {
          if (start === end) return;
          const equal =
            start - cursor === pendingText.length &&
            pendingText.length <= 256 &&
            source.slice(cursor, start) === pendingText.toString();
          if (!equal && (cursor !== start || pendingText.length))
            batch.push({
              range: [source.positionAt(cursor), source.positionAt(start)],
              text: pendingText,
            });
          cursor = end;
          pendingText = empty;
        };
        for await (const cells of cellBatches(source, block, regex, literal, worker, check)) {
          for (const cell of cells) {
            if (cell.column) append(" ");
            retain(cell.start, cell.end);
            let width = widths ? widths.get(cell.column) : cell.end - cell.start;
            if (width?.then) width = await width;
            append(spaces(width - (cell.end - cell.start)));
            if (cell.separatorEnd > cell.separatorStart) {
              append(" ");
              const head = cell.separatorStart + cell.separatorHead,
                tail = cell.separatorEnd - cell.separatorTail;
              if (head >= tail) append(source.subtext(cell.separatorStart, cell.separatorEnd));
              else {
                append(source.subtext(cell.separatorStart, head));
                retain(head, tail);
                append(source.subtext(tail, cell.separatorEnd));
              }
            }
            if (cell.final) {
              pendingText = empty;
              if (cursor < cell.lineEnd)
                batch.push({
                  range: [source.positionAt(cursor), source.positionAt(cell.lineEnd)],
                  text: "",
                });
              cursor = cell.next;
            }
            if (batch.length >= 64) {
              yield batch;
              batch = [];
            }
          }
          const pending = check();
          if (pending) await pending;
        }
        if (batch.length) yield batch;
      } finally {
        await widths?.dispose();
      }
    }
  }
  try {
    const count = await buffer.applyTextEdits(edits(), {
      expectedRevision: revision,
      signal: linked,
      isCurrent: current,
    });
    if (!externalSelectionChange) editor.setSelectedBufferRanges(selected);
    return count;
  } finally {
    worker?.dispose();
    for (const subscription of subscriptions) subscription.dispose();
  }
}

module.exports = { align, spacesFactory, literalSeparator, literalCells, rowInfo };
