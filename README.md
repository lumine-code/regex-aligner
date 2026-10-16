# regex-aligner

Align text using regular expressions or multiple cursors.

Enter a pattern and text is aligned at matching positions.

## Features

- **Regex alignment**: align text at regex-matched separators.
- **Cursor alignment**: align multiple cursors to the rightmost one.

![Key-value pairs before alignment.](.github/demo.png)

![Columns aligned by Regex Aligner.](.github/demo-2.png)

## Installation

To install `regex-aligner` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/regex-aligner`.

## Commands

Commands available in `lumine-text-editor:not([mini]):not([readonly])`:

- `regex-aligner:toggle`: open dialog to get a regex expression as separator,
- `regex-aligner:simple`: align multiple cursors to the rightmost one.

Commands act on the editor that invoked them, using the active editor when invoked from the application menu or command palette. The regex dialog keeps that editor as its target until confirmation.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
