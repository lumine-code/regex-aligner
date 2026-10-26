const { TextBuffer } = require("lumine");
const fs = require("node:fs");

function reference(text, regex) {
  const widths = [];
  const rows = text.split("\n").map((line) => {
    const cells = [],
      separators = [];
    let start = 0;
    for (const match of line.matchAll(regex)) {
      if (!match[0] && (match.index === 0 || match.index === line.length)) continue;
      cells.push(line.slice(start, match.index));
      separators.push(match[0]);
      start = match.index + match[0].length;
    }
    cells.push(line.slice(start));
    return {
      separators,
      cells: cells.map((value, column) => {
        const cell = column ? value.trim() : value.trimEnd();
        widths[column] = Math.max(widths[column] || 0, cell.length);
        return cell;
      }),
    };
  });
  return rows
    .map(({ cells, separators }) => {
      const parts = [];
      cells.forEach((cell, column) => {
        parts.push(cell.padEnd(widths[column]));
        if (separators[column]) parts.push(separators[column]);
      });
      return parts.join(" ").trimEnd();
    })
    .join("\n");
}

describe("Source alignment", () => {
  let main, editor, align, WidthStore, RegexWorker;
  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage("regex-aligner")).mainModule;
    ({ align } = require("../lib/source-alignment"));
    WidthStore = require("../lib/width-store");
    RegexWorker = require("../lib/regex-worker-client");
    editor = await lumine.workspace.open();
  });
  afterEach(() => editor.destroy());

  it("matches native per-line separator, trim, capture and zero-width semantics", async () => {
    const values = [
      "a,bb,c\nddd,e,ff\n",
      ",a,,b\n,c,,d\n",
      " a = b\n  longer= tail \n",
      "😀, b\n c,😀😀\n",
      "a,b\naa,b\n",
      "\u2000a ,\u202fb\nccc, d  \n",
    ];
    const patterns = [/,/g, /(,)/g, /([,=])/g, /^|(?=,)|$/g, /(?<=a)(,)(?=b)/g, /\s+/g];
    for (const text of values)
      for (const regex of patterns) {
        editor.setText(text);
        editor.selectAll();
        await align(editor, regex);
        expect(editor.getText())
          .withContext(JSON.stringify([text, String(regex)]))
          .toBe(reference(text, regex));
      }
  }, 30000);

  it("preserves CRLF and native lookaround context on the CR code unit", async () => {
    editor.setText("a,b\r\nlong,c\r\n");
    editor.selectAll();
    await align(editor, /,/g);
    expect(editor.getText()).toBe("a    , b\r\nlong , c\r\n");
    editor.setText("a,b\r\nlong,c\r\n");
    editor.selectAll();
    await align(editor, /(?=\r$)/g);
    expect(editor.getText()).toBe("a,b\r\nlong,c\r\n");
  });

  it("spills width pages without losing columns and removes its temporary file", async () => {
    const widths = new WidthStore({ pageUnits: 4, cachePages: 2 });
    let file;
    try {
      for (let index = 0; index < 100; index++) await widths.update(index, index + 1);
      file = widths.filePath;
      expect(fs.existsSync(file)).toBe(true);
      for (let index = 99; index >= 0; index--) {
        await widths.update(index, index * 2);
        expect(await widths.get(index)).toBe(Math.max(index + 1, index * 2));
        expect(widths.pages.size).toBeLessThanOrEqual(2);
      }
      for (let index = 0; index < 100; index++)
        expect(await widths.get(index)).toBe(Math.max(index + 1, index * 2));
    } finally {
      await widths.dispose();
    }
    expect(fs.existsSync(file)).toBe(false);
  });

  it("aligns a cell and generated padding beyond the native string limit with exact markers and undo", async () => {
    let body = TextBuffer.createTextSnapshot("x".repeat(65536));
    for (let i = 0; i < 13; i++) body = body.replace(body.length, body.length, body);
    const source = body.replace(body.length, body.length, ",z\nb,q\n");
    const buffer = editor.getBuffer();
    buffer.setTextInRange(buffer.getRange(), source);
    editor.selectAll();
    buffer.clearUndoStack();
    const marker = buffer.markRange(
      [
        [1, 2],
        [1, 3],
      ],
      { invalidate: "never" },
    );
    const exclusive = buffer.markRange(
      [
        [1, 2],
        [1, 3],
      ],
      { invalidate: "never", exclusive: true },
    );
    const getText = spyOn(editor.getLastSelection(), "getText").and.throwError(
      "Do not flatten selections",
    );
    const result = align(editor, /(,)/g);
    getText.and.callThrough();
    await result;
    expect(buffer.lineLengthForRow(0)).toBe(body.length + 4);
    expect(buffer.lineLengthForRow(1)).toBe(body.length + 4);
    expect(marker.getRange().serialize()).toEqual([
      [1, body.length + 2],
      [1, body.length + 4],
    ]);
    expect(exclusive.getRange().serialize()).toEqual([
      [1, body.length + 3],
      [1, body.length + 4],
    ]);
    expect(buffer.undo()).toBe(true);
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
  }, 30000);

  it("simple alignment inserts shared padding without reading entire lines", () => {
    let body = TextBuffer.createTextSnapshot("x".repeat(65536));
    for (let i = 0; i < 13; i++) body = body.replace(body.length, body.length, body);
    const buffer = editor.getBuffer();
    buffer.setTextInRange(buffer.getRange(), body.replace(body.length, body.length, "\nbx\n"));
    editor.setCursorBufferPosition([0, body.length]);
    editor.addCursorAtBufferPosition([1, 1]);
    spyOn(editor, "lineTextForBufferRow").and.throwError("Do not flatten lines");
    main.simple({ target: editor.element });
    expect(buffer.lineLengthForRow(1)).toBe(body.length + 1);
    expect(editor.getCursors().map((cursor) => cursor.getBufferColumn())).toEqual([
      body.length,
      body.length,
    ]);
  });

  it("rejects an oversized general-regex line before mutation and cancels obsolete preparation", async () => {
    let body = TextBuffer.createTextSnapshot("x".repeat(65536));
    for (let i = 0; i < 8; i++) body = body.replace(body.length, body.length, body);
    const buffer = editor.getBuffer();
    buffer.setTextInRange(buffer.getRange(), body);
    editor.selectAll();
    await expectAsync(align(editor, /x+/g)).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_ALIGN_NATIVE_LINE_LIMIT" }),
    );
    expect(buffer.getTextSnapshot().equals(body)).toBe(true);
    const aligning = align(editor, /,/g);
    editor.setCursorBufferPosition([0, 12]);
    await expectAsync(aligning).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(buffer.getTextSnapshot().equals(body)).toBe(true);
  });

  it("terminates pending native regex work when cancelled", async () => {
    const controller = new AbortController(),
      worker = new RegexWorker(controller.signal);
    try {
      const pending = worker.request({
        rows: ["a".repeat(100000) + "!"],
        source: "(a+)+$",
        flags: "g",
      });
      controller.abort();
      await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
      expect(worker.disposed).toBe(true);
    } finally {
      worker.dispose();
    }
  });

  it("does not overwrite a selection changed by a postcommit observer", async () => {
    editor.setText("a,b\nlong,c\n");
    editor.selectAll();
    const subscription = editor
      .getBuffer()
      .onDidChangeText(() => editor.setCursorBufferPosition([0, 1]));
    try {
      await align(editor, /,/g);
      expect(editor.getSelectedBufferRange().serialize()).toEqual([
        [0, 1],
        [0, 1],
      ]);
    } finally {
      subscription.dispose();
    }
  });
});
