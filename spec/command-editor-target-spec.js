describe("Regex Aligner command editor targets", () => {
  let first, second, firstPane, main;

  beforeEach(async () => {
    for (const operation of ["openExternal", "openPath", "showItemInFolder", "openApplication"]) {
      if (!jasmine.isSpy(lumine.shell[operation])) {
        spyOn(lumine.shell, operation).and.returnValue(Promise.resolve(""));
      }
    }
    if (!jasmine.isSpy(lumine.application.openWindow)) {
      spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    }
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-text");
    first = await lumine.workspace.open();
    firstPane = lumine.workspace.paneForItem(first);
    firstPane.splitRight();
    second = await lumine.workspace.open();
    first.setText("x = 1\nyyy = 2\n");
    second.setText("a = 3\nbbb = 4\n");
    for (const editor of [first, second]) {
      editor.setCursorBufferPosition([0, 2]);
      editor.addCursorAtBufferPosition([1, 4]);
    }
    firstPane.activate();
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    main = (await lumine.packages.activatePackage("regex-aligner")).mainModule;
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("regex-aligner")) {
      await lumine.packages.unloadPackage("regex-aligner");
    }
    first?.destroy();
    second?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  it("aligns the split editor that dispatched Simple instead of the active editor", () => {
    lumine.commands.dispatch(second.element, "regex-aligner:simple");

    expect(second.getText()).toBe("a   = 3\nbbb = 4\n");
    expect(first.getText()).toBe("x = 1\nyyy = 2\n");
    expect(second.getCursors().map((cursor) => cursor.getBufferColumn())).toEqual([4, 4]);
  });

  it("captures the split editor that opens the regex dialog", () => {
    second.setText("a,bb\nddd,e\n");
    second.setSelectedBufferRange([
      [0, 0],
      [1, 5],
    ]);
    lumine.commands.dispatch(second.element, "regex-aligner:toggle");
    main.dialog.miniEditor.setText(",");
    lumine.commands.dispatch(main.dialog.miniEditor.element, "core:confirm");

    expect(second.getText()).toBe("a   , bb\nddd , e\n");
    expect(first.getText()).toBe("x = 1\nyyy = 2\n");
    expect(main.dialog.isVisible()).toBe(false);
  });

  it("does not redirect a workspace command to the active editor", () => {
    expect(lumine.commands.canDispatch(lumine.workspace.getElement(), "regex-aligner:simple")).toBe(
      false,
    );
    lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "regex-aligner:simple");

    expect(first.getText()).toBe("x = 1\nyyy = 2\n");
    expect(second.getText()).toBe("a = 3\nbbb = 4\n");
  });
});
