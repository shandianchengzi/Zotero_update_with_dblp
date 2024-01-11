[中文简介](./README.md)

# Introduction

This is a JavaScript script that can run in Zotero. It is designed to automatically fetch and parse the first BibTeX entry from the dblp website when you select one or multiple items, and then use it to fill in the bibliographic information.

Currently, it primarily supports conference papers, journal articles, and books. If you need to add other types of entries, consider adding a few more mappings to the `field`.

Here are two data safety statements:

1. To ensure data safety, if the type of entry obtained does not match the original type in Zotero, a new entry will be created, and relevant information, attachments, and tags will be copied over, but the original entry will not be deleted.
2. Except for directly overwriting the author and editor information, and not overwriting the title information, any other information will only be introduced from the BibTeX entry if the original data is empty, meaning it will not overwrite existing information.

# How to Use

Currently, the way to use this script is to click "Tools" -> "Developers" -> "Run JavaScript", copy and paste the code into it. Future plans include UI packaging as a right-click plugin.

# To-Do

- [ ] Support more BibTeX source sites
- [ ] Refactor the code, using Zotero's database operations to streamline the process of copying entries
- [ ] Refactor the code, extract and design user-configurable options
- [ ] Develop a UI, to integrate it as a Zotero right-click option
- [ ] Package as an xpi plugin