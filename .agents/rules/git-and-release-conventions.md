---
name: git-and-release-conventions
description: Enforces fixed bilingual (English + Turkish) formatting for all Git commits, GitHub Releases, and README.md.
trigger: always_on
---

# Git Commit, GitHub Release, and README Standards

Follow the exact templates defined in `AGENTS.md` for every commit, release, and README edit:
- **Commit Subject / Title:** English only, capitalized imperative sentence, no `feat:`/`fix:` prefixes, no version tags in title.
- **Commit Body:** Mandatory `EN:` bullet list followed by `TR:` bullet list.
- **GitHub Release Title:** `Bridge vX.Y.Z` (version only, no description in title)
- **GitHub Release Body:** Mandatory `### English` bullet list followed by `### Türkçe` bullet list (always send UTF-8 encoded JSON bytes to the GitHub API).
- **README.md:** Bilingual (`## English` and `## Türkçe` sections kept in sync).
