describe("regex-aligner", () => {
  let workspaceElement, editor, editorElement, mainModule;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open();
    editorElement = lumine.views.getView(editor);

    // The package defers activation until one of its commands is dispatched.
    const activation = lumine.packages.activatePackage("regex-aligner");
    lumine.commands.dispatch(editorElement, "regex-aligner:simple");
    mainModule = (await activation).mainModule;
  });

  describe("regex-aligner:simple", () => {
    it("aligns multiple cursors to the rightmost one", () => {
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

    it("shows and hides the regex dialog", () => {
      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      expect(getDialog().isVisible()).toBe(true);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      expect(getDialog().isVisible()).toBe(false);
    });

    it("tabularizes the selection at the regex separator", () => {
      editor.setText("a,bb,c\nddd,e,ff\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 8],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText(",");
      lumine.commands.dispatch(dialog.miniEditor.element, "core:confirm");

      expect(editor.getText()).toBe("a   , bb , c\nddd , e  , ff\n");
      expect(dialog.isVisible()).toBe(false);
    });

    it("keeps the dialog open and reports invalid regular expressions", () => {
      editor.setText("a,b\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 3],
      ]);

      lumine.commands.dispatch(editorElement, "regex-aligner:toggle");
      const dialog = getDialog();
      dialog.miniEditor.setText("([");
      lumine.commands.dispatch(dialog.miniEditor.element, "core:confirm");

      expect(dialog.isVisible()).toBe(true);
      expect(dialog.errorMessage.textContent).toContain("Error:");
    });
  });
});
