# Repository Conventions (Git Commits, GitHub Releases, and Documentation)

You MUST strictly follow these formatting rules for every Git commit, GitHub release, and documentation update in this repository. Never deviate from this structure.

---

## 1. Git Commit Message Standard

Every commit MUST have:
1. **Subject Line (Title):** Written in **English**, starting with a capital letter, imperative mood, concise, natural human tone (no `feat(scope):` or robotic prefixes, no trailing period, no version numbers in parentheses).
2. **Body (Description):** Separated from the subject line by one blank line, containing **both English (`EN:`) and Turkish (`TR:`)** bullet points describing the changes.

### Exact Commit Template
```text
<Concise English summary in imperative mood>

EN:
- <English bullet point 1>
- <English bullet point 2>

TR:
- <Turkish bullet point 1>
- <Turkish bullet point 2>
```

---

## 2. GitHub Release Standard

Every GitHub Release MUST have:
1. **Tag Name (`tag_name`):** `vX.Y.Z` (e.g., `v2.19.6`).
2. **Release Title (`name`):** Written in **English** using the exact format:
   `Bridge vX.Y.Z — <Short English Release Title>`
3. **Release Notes (`body`):** Written in **both English and Turkish** using the exact section headers `### English` and `### Türkçe`, encoded cleanly as UTF-8.

### Exact Release Notes Template
```markdown
### English
- **<Topic 1>:** <Clear English explanation.>
- **<Topic 2>:** <Clear English explanation.>

### Türkçe
- **<Başlık 1>:** <Net Türkçe açıklama.>
- **<Başlık 2>:** <Net Türkçe açıklama.>
```

---

## 3. README.md Standard

- `README.md` MUST always remain bilingual with complete **English** (`## English`) and **Türkçe** (`## Türkçe`) sections and a top language switcher (`<a href="#english">English</a> · <a href="#türkçe">Türkçe</a>`).
- Any feature or build/install change added to one language section in `README.md` MUST be updated in both English and Turkish simultaneously.
