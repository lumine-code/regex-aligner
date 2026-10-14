// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [],
  viewport: { width: 1100, height: 340 },
  async before() {},
  async prepare(context) {
    const { state, open } = context;
    state.editor = await open("usage/processing.txt");
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Key-value pairs before alignment.",
      timeout: 60000,
      async run() {},
      ready() {
        return Boolean(
          document.querySelector("lumine-workspace")?.getBoundingClientRect().height > 0 &&
          document.body.innerText.trim().length > 0,
        );
      },
    },
    {
      id: "scene-2",
      file: "demo-2.png",
      caption: "Columns aligned by Regex Aligner.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          state.editor.selectAll();
          const m = lumine.packages.getActivePackage("regex-aligner").mainModule;
          m.ensureDialog().showForEditor(state.editor);
          m.dialog.miniEditor.setText("=");
          m.dialog.confirm();
        }
      },
      ready(context) {
        const { state } = context;
        return Boolean(
          new Set(
            state.editor
              .getText()
              .trim()
              .split("\n")
              .map((l) => l.indexOf("=")),
          ).size === 1,
        );
      },
    },
  ],
  async cleanup() {},
};
