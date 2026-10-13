describe("alignment dialogs in editor windows", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("regex-aligner");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("regex-aligner");
    await lumine.workspace.discardEditorWindows();
  });
  it("keeps each separator query and editor target local", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    await lumine.commands.dispatch(first.getElement(), "regex-aligner:toggle");
    await lumine.commands.dispatch(second.getElement(), "regex-aligner:toggle");
    const main = lumine.packages.getActivePackage("regex-aligner").mainModule;
    const local = main.dialogs.get(workspace.getMainWindow()).dialog;
    const remote = main.dialogs.get(extra).dialog;
    expect(local.isVisible()).toBe(true);
    expect(remote.element.ownerDocument).toBe(extra.getDocument());
    local.miniEditor.setText("local");
    remote.miniEditor.setText("remote");
    expect(local.editor).toBe(first);
    expect(remote.editor).toBe(second);
    expect(local.miniEditor.getText()).toBe("local");
    await workspace.attachWindow(extra);
    expect(main.dialogs.has(extra)).toBe(false);
  });
});
