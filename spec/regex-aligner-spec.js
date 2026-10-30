describe("regex-aligner", () => {
  let workspaceElement, editor, editorElement, mainModule;

  beforeEach(async () => {
    jasmine.useRealClock();
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open();
    editorElement = lumine.views.getView(editor);
    await lumine.packages.activatePackage("language-text");

    // The package defers activation until one of its commands is dispatched.
    const activation = lumine.packages.activatePackage("regex-aligner");
    lumine.commands.dispatch(editorElement, "regex-aligner:simple");
    mainModule = (await activation).mainModule;
  });

  describe("regex-aligner:simple", () => {
    it("aligns multiple cursors to the rightmost one", async () => {
      editor.setText("a = 1\nbbb = 2\ncc = 3\n");
      editor.setCursorBufferPosition([0, 2]);
      editor.addCursorAtBufferPosition([1, 4]);
      editor.addCursorAtBufferPosition([2, 3]);

      lumine.commands.dispatch(editorElement, "regex-aligner:simple");

      expect(editor.getText()).toBe("a   = 1\nbbb = 2\ncc  = 3\n");
      for (const cursor of editor.getCursors()) {
        expect(cursor.getBufferColumn()).toBe(4);
      }
    });
  });

  describe("regex-aligner:toggle", () => {
    function getDialog() {
      return mainModule.dialog;
    }

    it("shows and hides the regex dialog", async () => {
      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      expect(getDialog().isVisible()).toBe(true);
      expect(getDialog().miniEditor.getGrammar().scopeName).toBe("text.plain");

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      expect(getDialog().isVisible()).toBe(false);
    });

    it("tabularizes the selection at the regex separator", async () => {
      editor.setText("a,bb,c\nddd,e,ff\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 8],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText(",");
      await dialog.confirm();

      expect(editor.getText()).toBe("a   , bb , c\nddd , e  , ff\n");
      expect(dialog.isVisible()).toBe(false);
    });

    it("keeps the dialog open and reports invalid regular expressions", async () => {
      editor.setText("a,b\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 3],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText("([");
      await dialog.confirm();

      expect(dialog.isVisible()).toBe(true);
      expect(dialog.inputDialog.getStatus().type).toBe("error");
      expect(dialog.inputDialog.getStatus().message).toContain("regular expression");
    });

    it("preserves an oversized draft across reopen without reading or aligning it", async () => {
      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText("x".repeat(65537));
      const oversizedRead = jasmine.createSpy("oversized read");
      const read = dialog.miniEditor.getText.bind(dialog.miniEditor);
      spyOn(dialog.miniEditor, "getText").and.callFake(() => {
        if (dialog.miniEditor.getBuffer().getLength() > 65536) {
          oversizedRead();
          throw new Error("Oversized input read");
        }
        return read();
      });
      const align = spyOn(dialog, "tabularize");
      await dialog.confirm();
      dialog.hide();
      dialog.showForEditor(editor);
      expect(oversizedRead).not.toHaveBeenCalled();
      expect(align).not.toHaveBeenCalled();
      expect(dialog.inputDialog.getQueryStatus().available).toBe(false);
      expect(dialog.miniEditor.getBuffer().getLength()).toBe(65537);
      expect(dialog.isVisible()).toBe(true);
    });

    it("does not duplicate separator capture groups", async () => {
      editor.setText("a,bb,c\nddd,e,ff\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 8],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText("(,)");
      await dialog.confirm();

      expect(editor.getText()).toBe("a   , bb , c\nddd , e  , ff\n");
    });

    it("keeps empty columns and their separators", async () => {
      editor.setText(",a,,b\n,c,,d\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 5],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText(",");
      await dialog.confirm();

      expect(editor.getText()).toBe(" , a ,  , b\n , c ,  , d\n");
    });

    it("does not add columns to lines with fewer separators", async () => {
      editor.setText("a,b,c\nd,e\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 3],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText("(,)|(=)");
      await dialog.confirm();

      expect(editor.getText()).toBe("a , b , c\nd , e\n");
    });

    it("aligns zero-width separators without losing the adjacent text", async () => {
      editor.setText("a,bb\nddd,e\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 5],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText("^|(?=,)|$");
      await dialog.confirm();

      expect(editor.getText()).toBe("a   ,bb\nddd ,e\n");
      expect(dialog.isVisible()).toBe(false);
    });
  });
});
