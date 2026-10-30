const { CompositeDisposable } = require("lumine");
const { align, spacesFactory } = require("./source-alignment");

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
    this.active = true;
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
      lumine.commands.add(".regex-dialog", {
        "regex-aligner:toggle": (event) => this.toggleDialog(event),
      }),
    );
  },

  /**
   * Deactivates the package and disposes resources.
   */
  deactivate() {
    this.active = false;
    const destroyed = [];
    for (const record of this.dialogs?.values() ?? []) {
      record.lease.dispose();
      destroyed.push(record.dialog.destroy());
    }
    this.dialogs?.clear();
    this.dialog = null;
    this.disposables?.dispose();
    this.disposables = null;
    return Promise.all(destroyed);
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
    if (editor.isReadOnly()) return;
    const buffer = editor.getBuffer(),
      revision = buffer.getTextRevision();
    const cursors = editor.getCursors(),
      ranges = editor.getSelectedBufferRanges();
    const rows = new Map();
    let maxColumn = 0;
    for (const cursor of cursors) {
      rows.set(cursor.getBufferRow(), cursor.getBufferColumn());
      maxColumn = Math.max(maxColumn, cursor.getBufferColumn());
    }
    const spaces = spacesFactory();
    const edits = Array.from(rows)
      .sort((a, b) => a[0] - b[0])
      .filter(([, column]) => column < maxColumn)
      .map(([row, column]) => ({
        range: [
          [row, column],
          [row, column],
        ],
        text: spaces(maxColumn - column),
      }));
    const current = () =>
      this.active &&
      !editor.isDestroyed() &&
      !editor.isReadOnly() &&
      buffer.getTextRevision() === revision &&
      editor.getSelectedBufferRanges().length === ranges.length &&
      editor.getSelectedBufferRanges().every((range, index) => range.isEqual(ranges[index]));
    const finish = () => {
      for (const cursor of cursors)
        if (!cursor.isDestroyed()) cursor.setBufferPosition([cursor.getBufferRow(), maxColumn]);
    };
    try {
      if (edits.length <= 128) {
        buffer.setTextInIndependentRanges(edits);
        finish();
      } else
        return buffer
          .applyTextEdits(edits, { expectedRevision: revision, isCurrent: current })
          .then(finish)
          .catch((error) => {
            if (error.name !== "AbortError" && error.code !== "ERR_STALE_EDIT")
              lumine.notifications.addError("Regex Aligner", {
                detail: error.message,
                dismissable: true,
              });
          });
    } catch (error) {
      lumine.notifications.addError("Regex Aligner", { detail: error.message, dismissable: true });
    }
  },
};

class Dialog {
  constructor(window = lumine.workspace.getMainWindow()) {
    const document = window.getDocument();
    this.disposables = new CompositeDisposable();

    this.promptText = document.createElement("div");
    this.promptText.classList.add("dialog-header", "dialog-label", "icon", "icon-arrow-right");
    this.promptText.textContent = "Use a regex to select the separator";
    this.inputDialogHost = lumine.workspace.addInputDialog(
      { headerElement: this.promptText },
      { window, className: "regex-dialog" },
    );
    this.inputDialog = this.inputDialogHost.getModel();
    this.element = this.inputDialog.getElement();
    this.element.classList.add("regex-dialog");
    this.miniEditor = this.inputDialog.getQueryEditor();
    this.panel = this.inputDialogHost.getPanel();
    this.disposables.add(
      this.inputDialog.onDidConfirm(() => this.confirm()),
      this.inputDialogHost.onDidHide(() => {
        this.controller?.abort();
        this.editor = null;
      }),
    );
  }

  destroy() {
    this.hide();
    this.disposables.dispose();
    return this.inputDialogHost.destroy();
  }

  showForEditor(editor) {
    this.controller?.abort();
    this.editor = editor;
    const query = this.miniEditor.getBuffer().getTextSnapshot();
    this.inputDialog.clearStatus();
    this.inputDialog.setLoadingState(null);
    this.inputDialogHost.show();
    this.inputDialog.setQuery(query, { select: true });
  }

  hide() {
    this.controller?.abort();
    this.inputDialogHost.hide();
  }

  isVisible() {
    return this.inputDialogHost.isVisible();
  }

  async confirm() {
    const editor = this.editor;
    if (
      !editor ||
      !this.inputDialog.getQueryStatus().available ||
      !this.miniEditor.getBuffer().getLength()
    )
      return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const regex = new RegExp(this.inputDialog.getQuery(), "g");
      this.inputDialog.setLoadingState({ message: "Aligning…" });
      await this.tabularize(regex, editor, {
        signal: controller.signal,
        isCurrent: () => this.editor === editor && this.controller === controller,
      });
      if (this.controller === controller) this.hide();
    } catch (error) {
      if (
        error.name !== "AbortError" &&
        error.code !== "ERR_STALE_EDIT" &&
        !this.inputDialog.isDestroyed() &&
        this.controller === controller
      ) {
        this.inputDialog.setStatus({
          type: "error",
          message:
            error.message +
            (error.committed ? " Alignment was committed; Undo remains available." : ""),
        });
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        if (!this.inputDialog.isDestroyed()) this.inputDialog.setLoadingState(null);
      }
    }
  }

  tabularize(separatorRegex, editor, options) {
    return align(editor, separatorRegex, options);
  }
}
