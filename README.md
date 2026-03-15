# Zotero CCF Info

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org) [![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template) <img src="https://img.shields.io/github/stars/TimeTrapzz/zotero-ccf-info?style=social" alt="GitHub stars">

This is a plugin for easily obtaining the CCF rating of a paper and the corresponding conference/journal in [Zotero](https://www.zotero.org/).

CCF rank data is based on the [7th edition (2026)](https://ccf.atom.im/) of the CCF Recommended Catalog.

# Features

- Right-click one or more entries to fetch CCF rank info
- Auto-fetch CCF info when new items are added
- CCF rank displayed as colored badges in a custom column (A: red, B: yellow, C: green, None: gray)
- Data stored in Zotero's Extra field (`CCF-Rank` / `CCF-Abbr`), lightweight and portable

# Usage

Select one or more entries, right-click and choose "Get CCF Info".

![image](https://github.com/user-attachments/assets/5a2b939b-1a20-4b93-ba36-5170124be886)

# Add missing journal/conference information

If the journal/conference information is missing, you can add it in `src/modules/ccfRankList.ts`. The format is as follows:

```json
{
  "/conf/icml": {
    "rank": "A",
    "abbr": "ICML",
    "full": "International Conference on Machine Learning",
    "url": "/conf/icml",
    "dblp": "/conf/icml/icml"
  }
}
```

Then, you can submit a PR to add the missing information.

# Contributors

- [TimeTrapzz](https://github.com/TimeTrapzz): Zotero 7 Plugin Rewrite and Adaptation
- [tojunfeng](https://github.com/tojunfeng): Plugin Core Logic Implementation
- Claude (AI): Code Refactoring, CCF 7th Edition Data Update
