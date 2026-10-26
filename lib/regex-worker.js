const port = (typeof require === "function" ? require("node:worker_threads").parentPort : null) || {
  on: (_name, callback) => {
    globalThis.onmessage = ({ data }) => callback(data);
  },
  postMessage: (message) => globalThis.postMessage(message),
};

let rows, row, expression, start, column, lastCell;
port.on("message", (message) => {
  try {
    if (!message.next) {
      rows = message.rows;
      expression = new RegExp(message.source, message.flags);
      row = start = column = 0;
      lastCell = false;
    }
    const cells = [];
    while (row < rows.length && cells.length < 512) {
      const text = rows[row];
      if (lastCell) {
        row++;
        expression.lastIndex = 0;
        start = column = 0;
        lastCell = false;
        continue;
      }
      let match;
      while ((match = expression.exec(text))) {
        if (!match[0].length)
          expression.lastIndex +=
            (expression.unicode || expression.unicodeSets) &&
            text.codePointAt(expression.lastIndex) > 0xffff
              ? 2
              : 1;
        if (match[0].length || (match.index !== 0 && match.index !== text.length)) break;
      }
      const separatorStart = match ? match.index : text.length;
      const separatorEnd = match ? match.index + match[0].length : text.length;
      let content = text.slice(start, separatorStart),
        contentStart = start;
      if (column) {
        const trimmed = content.trimStart();
        contentStart += content.length - trimmed.length;
        content = trimmed;
      }
      const contentEnd = contentStart + content.trimEnd().length;
      cells.push({
        row,
        column: column++,
        start: contentStart,
        end: contentEnd,
        separatorStart,
        separatorEnd,
        final: !match,
        separatorHead: match ? match[0].length - match[0].trimStart().length : 0,
        separatorTail: match ? match[0].length - match[0].trimEnd().length : 0,
      });
      start = separatorEnd;
      lastCell = !match;
    }
    const done = row >= rows.length;
    port.postMessage({ cells, done });
    if (done) rows = expression = null;
  } catch (error) {
    port.postMessage({ error: error.message });
  }
});
