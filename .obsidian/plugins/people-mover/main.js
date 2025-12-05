// PeopleMover – build/update Tasks/Kinetic-People.md from @mentions
//
// This version:
//
// - Scans markdown files for lines containing @Name
// - Treats each such line as the start of a "block" and pulls in its indented notes
// - STRIPS task checkboxes ("- [ ]", "- [x]") from child lines, and skips top-level tasks
// - NEVER writes tasks to Tasks/Kinetic-People.md
// - Skips generated/system files (Kinetic-People.md itself, Kinetic-Tasks.md, Projects.md)
// - Parses existing Tasks/Kinetic-People.md into:
//     * preamble (everything before the first "## " heading)
//     * person -> [blocks]
// - Merges new blocks by person with true dedupe:
//     * signature = person + first line (ignoring trailing @YYYY-MM-DD)
// - Rewrites the file so that there is exactly ONE "## @Person" heading per person,
//   with all that person’s blocks grouped under it.

const { Plugin, TFile, Notice, moment, normalizePath } = require("obsidian");

const PEOPLE_FILE_PATH = "Tasks/Kinetic-People.md";
const EXCLUDED_PATHS = new Set([
  normalizePath(PEOPLE_FILE_PATH),
  normalizePath("Tasks/Kinetic-Tasks.md"),
  normalizePath("Tasks/Projects.md"),
]);

module.exports = class PeopleMover extends Plugin {
  async onload() {
    console.log("PeopleMover: loaded");
    this.addCommand({
      id: "kinetic-collect-people-mentions",
      name: "Kinetic: Collect @people into People ledger",
      callback: () => this.collectPeopleMentions(),
    });
  }

  // Entry point
  async collectPeopleMentions() {
    const vault = this.app.vault;
    new Notice("Kinetic: collecting @people mentions…");

    // Build map: "@Name" -> array of blocks (each block = array of lines)
    const mentionsByPerson = {};

    // Scan all markdown files except excluded
    const files = vault.getMarkdownFiles().filter((file) => {
      const path = normalizePath(file.path);
      return !EXCLUDED_PATHS.has(path);
    });

    for (const file of files) {
      const content = await vault.cachedRead(file);
      const lines = content.split("\n");
      this.scanFileForMentions(lines, mentionsByPerson);
    }

    if (Object.keys(mentionsByPerson).length === 0) {
      new Notice("Kinetic: no new @people mentions found.");
      return;
    }

    await this.mergeIntoPeopleFile(mentionsByPerson);
    new Notice("✅ Kinetic: People ledger updated.");
  }

  // ---- Scanning: build blocks from notes ----------------------------------

  scanFileForMentions(lines, mentionsByPerson) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line.includes("@")) continue;

      const trimmedStart = line.trimStart();

      // If this is a top-level task line, skip it completely:
      // we don't want tasks in the People ledger.
      if (/^-\s\[[ xX]\]\s+/.test(trimmedStart)) {
        continue;
      }

      // Names: @First or @First Last (both words capitalized),
      // up to punctuation/whitespace after the second word.
      // This avoids "@Gregg wasn", "@Miles up", etc.
      const mentionRegex = /@([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)?)/g;

      let hasMention = false;
      const peopleOnLine = [];

      let m;
      while ((m = mentionRegex.exec(line)) !== null) {
        hasMention = true;
        let personName = m[1].trim();
        // Strip trailing punctuation from the captured name
        personName = personName.replace(/[.,;:!?]+$/, "");
        const key = `@${personName}`;
        if (!peopleOnLine.includes(key)) {
          peopleOnLine.push(key);
        }
      }

      if (!hasMention) continue;

      // Build the block: this line + nested more-indented lines
      const block = this.buildBlockFrom(lines, i);

      // Append capture date to the first line of the block
      if (block.length > 0) {
        const date = moment().format("YYYY-MM-DD");
        block[0] = block[0].replace(/\s+$/, "") + ` @${date}`;
      }

      for (const key of peopleOnLine) {
        if (!mentionsByPerson[key]) mentionsByPerson[key] = [];
        mentionsByPerson[key].push(block);
      }
    }
  }

  buildBlockFrom(lines, startIndex) {
    const block = [];
    const firstLine = lines[startIndex];
    block.push(firstLine);

    // Determine indentation of the first line
    const indentMatch = firstLine.match(/^\s*/);
    const baseIndent = indentMatch ? indentMatch[0].length : 0;

    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") break;

      const m = line.match(/^\s*/);
      const indent = m ? m[0].length : 0;

      // Only include more-indented lines as part of this block
      if (indent <= baseIndent) break;

      // For child lines, if it's a task ("- [ ]", "- [x]"), strip checkbox
      // so it becomes a normal bullet or text.
      const trimmedStart = line.trimStart();
      if (/^-\s\[[ xX]\]\s+/.test(trimmedStart)) {
        const withoutCheckbox = line.replace(
          /^(\s*)-\s\[[ xX]\]\s+/,
          "$1- "
        );
        block.push(withoutCheckbox);
      } else {
        block.push(line);
      }
    }

    return block;
  }

  // ---- Parse existing People file into preamble + person → blocks ---------

  parseExistingPeople(existingContent) {
    const lines = existingContent.split("\n");

    // Find first person heading
    let firstHeadingIdx = lines.findIndex((l) => l.startsWith("## "));
    if (firstHeadingIdx === -1) firstHeadingIdx = lines.length;

    const preambleLines = lines.slice(0, firstHeadingIdx);
    const preamble = preambleLines.join("\n").replace(/\s+$/, "");

    const peopleMap = {};
    const signatureSet = new Set();

    let i = firstHeadingIdx;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.startsWith("## ")) {
        i++;
        continue;
      }

      const person = line.substring(3).trim();
      if (!person) {
        i++;
        continue;
      }

      if (!peopleMap[person]) {
        peopleMap[person] = [];
      }

      i++; // move to first line after heading

      // Collect blocks under this heading, separated by blank lines
      let currentBlock = [];

      const flushBlock = () => {
        if (currentBlock.length === 0) return;
        const blockCopy = currentBlock.slice();
        peopleMap[person].push(blockCopy);

        // Build signature for dedupe (person + first line without @date)
        let firstLine = blockCopy[0] || "";
        firstLine = firstLine.replace(/\s+$/, "");
        firstLine = firstLine.replace(/\s+@\d{4}-\d{2}-\d{2}$/, "");
        const sig = `${person}::${firstLine}`;
        signatureSet.add(sig);

        currentBlock = [];
      };

      while (i < lines.length) {
        const l = lines[i];

        if (l.startsWith("## ")) {
          // Next person heading
          break;
        }

        if (l.trim() === "") {
          // Blank line separates blocks
          flushBlock();
          i++;
          continue;
        }

        currentBlock.push(l);
        i++;
      }

      // Flush trailing block, if any
      flushBlock();
    }

    return { preamble, peopleMap, signatureSet };
  }

  // ---- Merge new mentions into People file and rewrite --------------------

  async mergeIntoPeopleFile(mentionsByPerson) {
    const vault = this.app.vault;
    const peoplePath = normalizePath(PEOPLE_FILE_PATH);

    let existingContent = "";
    let peopleFile = vault.getAbstractFileByPath(peoplePath);

    if (peopleFile instanceof TFile) {
      existingContent = await vault.read(peopleFile);
    } else {
      // If no file yet, create a simple preamble
      existingContent = "# People Ledger\n";
    }

    const { preamble, peopleMap, signatureSet } =
      this.parseExistingPeople(existingContent);

    // Merge new blocks
    for (const personKey of Object.keys(mentionsByPerson)) {
      const blocks = mentionsByPerson[personKey];
      if (!blocks || blocks.length === 0) continue;

      const person = personKey; // already "@Name"
      if (!peopleMap[person]) {
        peopleMap[person] = [];
      }

      for (const block of blocks) {
        if (!block || block.length === 0) continue;

        let firstLine = block[0].replace(/\s+$/, "");
        const firstLineNoDate = firstLine.replace(
          /\s+@\d{4}-\d{2}-\d{2}$/,
          ""
        );
        const sig = `${person}::${firstLineNoDate}`;

        if (signatureSet.has(sig)) {
          // We already have this block for this person (ignoring date)
          continue;
        }

        signatureSet.add(sig);
        peopleMap[person].push(block.slice());
      }
    }

    // Rebuild entire file: preamble + grouped people sections
    let out = preamble.trimEnd() + "\n";

    const peopleKeys = Object.keys(peopleMap).sort((a, b) =>
      a.localeCompare(b)
    );

    for (const person of peopleKeys) {
      const blocks = peopleMap[person];
      if (!blocks || blocks.length === 0) continue;

      out += "\n\n" + `## ${person}\n`;

      for (const block of blocks) {
        for (const line of block) {
          out += line.replace(/\s+$/, "") + "\n";
        }
        out += "\n";
      }
    }

    out = out.trimEnd() + "\n";

    if (peopleFile instanceof TFile) {
      await vault.modify(peopleFile, out);
    } else {
      await vault.create(peoplePath, out);
    }
  }
};
