# Changelog

## 0.1.1

- The value table stays readable in a narrow editor, such as VS Code's default layout with the secondary side bar open. Below about 960 pixels the file facts move under the table, and the Name and Data columns keep a minimum width (the table scrolls sideways instead of squeezing them).
- The "Tools that often go with registry files" step links to Log Viewer instead of an extension that is not on the Marketplace yet.
- Nothing else changed: same editor, same Pro tools with 1 free try each, same prices.

## 0.1.0

- First release. Opens .reg files (Registry Editor 5.00 and REGEDIT4, UTF-16 or UTF-8) as a key tree with a value table and every value type decoded.
- Edit, add and remove values in the table as normal text edits.
- Syntax colors for .reg text and a problem mark on every line that cannot be read.
- Opens binary registry hives read-only through Open as Registry Hive (and .hiv files directly): keys, values, last write times, class names and search.
- Zovo Pro tools: Export and convert, Compare two registry files, Last write timeline (1 free try each).
