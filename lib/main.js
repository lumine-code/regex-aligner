const { CompositeDisposable, Disposable } = require("lumine");

/**
 * Regex Aligner Package
 * Aligns text in columns using regex patterns as separators.
 * Supports simple alignment by cursor position and regex-based tabularization.
 */
module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "regex-aligner",
      tips: [
        "You can align the selected lines on a pattern with {{ 'regex-aligner:toggle' | keystroke }}",
      ],
    };
  },

  /**
   * Activates the package and registers alignment commands.
   */
  activate() {
    this.disposables = new CompositeDisposable();
    // The dialog owns a mini editor, modal panel and several DOM listeners.
    // None of that is needed until the user invokes the toggle command, so
    // keep activation to the command registration itself.  Apart from making
    // startup cheaper this also means a package that is enabled but never used
    // does not allocate an otherwise invisible editor.
    this.dialog = null;
    this.dialogs = new Map();
    this.disposables.add(
      lumine.commands.add("lumine-text-editor:not([mini]):not([readonly])", {
        "regex-aligner:toggle": (event) => this.toggleDialog(event),
        "regex-aligner:simple": {
          description: "Align the cursors' lines on the column they already share.",
          didDispatch: (event) => this.simple(event),
        },
      }),
    );
  },

  /**
   * Deactivates the package and disposes resources.
   */
  deactivate() {
    for (const record of this.dialogs.values()) {
      record.lease.dispose();
      record.dialog.destroy();
    }
    this.dialogs.clear();
    this.dialog = null;
    this.disposables.dispose();
  },

  ensureDialog(window = lumine.workspace.getMainWindow()) {
    let record = this.dialogs.get(window);
    if (!record) {
      const dialog = new Dialog(window);
      const lease = window.onWillDestroy(() => {
        this.dialogs.delete(window);
        lease.dispose();
        dialog.destroy();
      });
      record = { dialog, lease };
      this.dialogs.set(window, record);
      if (window.isMain()) this.dialog = dialog;
    }
    return record.dialog;
  },

  editorForEvent(event) {
    return lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false });
  },

  toggleDialog(event) {
    const window = event?.context?.window ?? lumine.workspace.getMainWindow();
    const dialog = this.dialogs.get(window)?.dialog;
    if (dialog?.isVisible()) {
      dialog.hide();
      return;
    }
    const editor = this.editorForEvent(event);
    if (!editor) return;
    this.ensureDialog(window).showForEditor(editor);
  },

  /**
   * Performs simple column alignment at cursor positions.
   */
  simple(event) {
    const editor = this.editorForEvent(event);
    if (!editor) return;
    let buffer = editor.getBuffer();
    let cursors = editor.getCursors();
    let cols = cursors.map((c) => c.getBufferColumn());
    let rows = cursors.map((c) => c.getBufferRow());
    let texts = rows.map((r) => editor.lineTextForBufferRow(r));
    let maxCol = Math.max(...cols);
    let aligned = texts.map((text, i) => {
      let col = cols[i];
      let delta = maxCol - col;
      let start = text.slice(0, col);
      let mid = " ".repeat(delta);
      let end = text.slice(col);
      return `${start}${mid}${end}`;
    });
    buffer.transact(() => {
      aligned.forEach((text, i) => {
        let row = rows[i];
        let range = [
          [row, 0],
          [row, Infinity],
        ];
        buffer.setTextInRange(range, text);
      });
      cursors.forEach((cursor) => {
        cursor.moveToBeginningOfLine();
        cursor.moveRight(maxCol);
      });
    });
  },
};

class Dialog {
  constructor(window = lumine.workspace.getMainWindow()) {
    const document = window.getDocument();
    this.disposables = new CompositeDisposable();

    this.element = document.createElement("div");
    this.element.classList.add("dialog");
    this.element.classList.add("regex-dialog");

    this.promptText = document.createElement("label");
    this.promptText.classList.add("icon", "icon-arrow-right");
    this.promptText.textContent = "Use a regex to select the separator";
    this.element.appendChild(this.promptText);

    this.miniEditor = lumine.workspace.buildTextEditor({ mini: true });
    this.element.appendChild(this.miniEditor.element);
    this.panel = window.addModalPanel({
      item: this,
      autoFocus: this.miniEditor.element,
      visible: false,
    });
    this.disposables.add(
      this.panel.onDidChangeVisible((visible) => {
        if (!visible) this.editor = null;
      }),
    );

    const blurHandler = () => {
      if (document.hasFocus()) {
        return this.hide();
      }
    };
    this.miniEditor.element.addEventListener("blur", blurHandler);
    this.disposables.add(lumine.textEditors.add(this.miniEditor, { role: "input" }));
    this.disposables.add(
      new Disposable(() => this.miniEditor.element.removeEventListener("blur", blurHandler)),
    );

    this.errorMessage = document.createElement("div");
    this.errorMessage.classList.add("text-error");
    this.element.appendChild(this.errorMessage);

    this.disposables.add(
      lumine.commands.add(this.element, {
        "core:confirm": () => this.confirm(),
        "core:cancel": () => this.hide(),
      }),
    );
  }

  destroy() {
    this.hide();
    this.disposables.dispose();
    this.panel.destroy();
    this.miniEditor.destroy();
  }

  showForEditor(editor) {
    this.editor = editor;
    this.miniEditor.selectAll();
    this.errorMessage.textContent = "";
    this.panel.show();
    this.miniEditor.element.focus();
  }

  hide() {
    this.panel.hide();
  }

  isVisible() {
    return Boolean(this.panel?.isVisible());
  }

  confirm() {
    let regex = this.miniEditor.getText();
    const editor = this.editor;
    if (!editor || !regex.length) {
      return;
    }
    try {
      this.tabularize(new RegExp(regex, "g"), editor);
      this.hide();
    } catch (e) {
      this.errorMessage.textContent = "Error: " + e.message;
    }
  }

  tabularize(separatorRegex, editor) {
    const currSelRans = editor.getSelectedBufferRanges();

    // Change selections to entire lines inside selections
    for (let selection of editor.getSelections()) {
      let range = selection.getBufferRange();
      let endColumn = range.end.column ? 1e6 : 0;
      selection.setBufferRange([
        [range.start.row, 0],
        [range.end.row, endColumn],
      ]);
    }

    editor.mutateSelectedText((selection) => {
      const widths = [];
      const rows = selection
        .getText()
        .split("\n")
        .map((line) => {
          const cells = [];
          const separators = [];
          let start = 0;
          // String.split includes capture groups as extra cells. Slice at the
          // full matches instead, retaining empty cells and every separator.
          for (const match of line.matchAll(separatorRegex)) {
            if (match[0] === "" && (match.index === 0 || match.index === line.length)) continue;
            cells.push(line.slice(start, match.index));
            separators.push(match[0]);
            start = match.index + match[0].length;
          }
          cells.push(line.slice(start));
          return {
            separators,
            cells: cells.map((cell, column) => {
              const text = column === 0 ? cell.trimEnd() : cell.trim();
              widths[column] = Math.max(widths[column] || 0, text.length);
              return text;
            }),
          };
        });
      const result = rows
        .map(({ cells, separators }) => {
          const parts = [];
          cells.forEach((cell, column) => {
            parts.push(cell.padEnd(widths[column]));
            if (column < separators.length && separators[column] !== "") {
              parts.push(separators[column]);
            }
          });
          return parts.join(" ").trimEnd();
        })
        .join("\n");
      selection.insertText(result);
    });
    return editor.setSelectedBufferRanges(currSelRans);
  }
}
