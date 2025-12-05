// Kinetic Projects Ledger – View-Only Edition
// ------------------------------------------------------------
// SAFETY GUARANTEES:
//  - Does NOT modify Tasks/Kinetic-Tasks.md
//  - Does NOT generate IDs
//  - Does NOT append text or mutate tasks
//  - Only reads tasks and rewrites the Existing Projects section
// ------------------------------------------------------------

const { Plugin, Notice, TFile } = require('obsidian');

// Source files
const TASKS_LEDGER_PATH = 'Tasks/Kinetic-Tasks.md';
const PROJECTS_FILE_PATH = 'Projects.md';

// Optional status filter
const STATUS_FILTER = '.'; // set to null to show all

class KineticProjectsLedgerPlugin extends Plugin {
  async onload() {
    console.log('KineticProjectsLedger (View-Only): loaded');

    this.addCommand({
      id: 'kinetic-build-projects-from-ledger',
      name: 'Kinetic: Rebuild Existing Projects section (View-Only)',
      callback: () => this.buildProjectsView()
    });
  }

  // ------------------------------------------------------------
  // Main
  // ------------------------------------------------------------
  async buildProjectsView() {
    const vault = this.app.vault;
    new Notice('Kinetic: rebuilding Existing Projects…');

    // Load Projects.md
    const projectsFile = vault.getAbstractFileByPath(PROJECTS_FILE_PATH);
    if (!(projectsFile instanceof TFile)) {
      new Notice(`❌ Projects file not found at: ${PROJECTS_FILE_PATH}`);
      return;
    }
    const projRaw = await vault.read(projectsFile);
    const projLines = projRaw.split('\n');

    // Parse index table
    const projectMap = this.parseProjectIndex(projLines);

    // Load tasks from ledger (read-only)
    const tasksFile = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
    if (!(tasksFile instanceof TFile)) {
      new Notice(`❌ Tasks ledger not found at: ${TASKS_LEDGER_PATH}`);
      return;
    }
    const tasksRaw = await vault.read(tasksFile);
    const tasksByProject = this.extractBlocksByProject(tasksRaw);

    // Build new view
    const newExistingSection = this.buildExistingProjectsSection(projectMap, tasksByProject);

    // Inject section
    const newProjectsContent = this.mergeIntoProjectsFile(projLines, newExistingSection);

    // Write back Projects.md only (safe)
    await vault.modify(projectsFile, newProjectsContent);
    new Notice('✅ Kinetic: Existing Projects section updated.');
  }

  // ------------------------------------------------------------
  // Parse the project index table in Projects.md
  // ------------------------------------------------------------
  parseProjectIndex(lines) {
    const map = {};
    const headerIdx = lines.findIndex((l) => l.match(/^\| *ID\b/i));
    if (headerIdx === -1) return map;

    let i = headerIdx + 2; // skip header + separator
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim().startsWith('|')) break;

      const cells = line.split('|').map((c) => c.trim());
      const idCell = cells[1] || '';
      const nameCell = cells[2] || '';
      const statusCell = cells[3] || '';

      const idMatch = idCell.match(/^P\d+$/i);
      if (idMatch) {
        const id = idMatch[0].toUpperCase();
        map[id] = {
          name: nameCell || id,
          status: statusCell || ''
        };
      }

      i++;
    }
    return map;
  }

  // ------------------------------------------------------------
  // Extract tasks grouped by project tags (#P1 etc.)
  // ------------------------------------------------------------
  extractBlocksByProject(tasksRaw) {
    const lines = tasksRaw.split('\n');

    const taskHeaderRe = /^\s*-\s\[[ xX]\]\s+/;
    const projTagRe = /#P(\d+)\b/gi;

    const blocks = {};
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!taskHeaderRe.test(line)) {
        i++;
        continue;
      }

      // Extract project tags
      let tags = [];
      let m;
      while ((m = projTagRe.exec(line)) !== null) {
        tags.push('P' + m[1]);
      }
      projTagRe.lastIndex = 0; // reset regex

      const block = this.getTaskBlock(lines, i);

      for (const tag of tags) {
        if (!blocks[tag]) blocks[tag] = [];
        blocks[tag].push(block);
      }

      i += block.length;
    }

    return blocks;
  }

  // ------------------------------------------------------------
  // Identify a task block (header + indented children)
  // ------------------------------------------------------------
  getTaskBlock(lines, start) {
    const block = [];
    const header = lines[start];
    block.push(header);

    const indent = header.match(/^\s*/)[0].length;

    for (let j = start + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        block.push(line);
        continue;
      }

      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent <= indent) break;

      block.push(line);
    }

    return block;
  }

  // ------------------------------------------------------------
  // Build the # Existing Projects section
  // ------------------------------------------------------------
  buildExistingProjectsSection(projectMap, tasksByProject) {
    let out = '# Existing Projects\n\n';

    const ids = Object.keys(tasksByProject).sort((a, b) => {
      const na = parseInt(a.slice(1));
      const nb = parseInt(b.slice(1));
      return na - nb;
    });

    for (const id of ids) {
      const meta = projectMap[id] || { name: id, status: '' };

      if (STATUS_FILTER) {
        const norm = (s) => s.toLowerCase().replace(/[.!\s]+$/g, '');
        if (norm(meta.status) !== norm(STATUS_FILTER)) continue;
      }

      const blocks = tasksByProject[id];
      if (!blocks || blocks.length === 0) continue;

      out += `## 📁 ${meta.name} (${id})\n\n`;

      // Summary
      const summary = this.summarize(blocks);
      out += `**Summary:** ${summary.total} open task${summary.total !== 1 ? 's' : ''}`;
      if (summary.tags.length > 0) out += ` (${summary.tags.join(', ')})`;
      out += '\n\n';

      // Emit task blocks exactly as they appear in the ledger,
      // without adding extra blank lines beyond what are already
      // present in the canonical ledger.
      for (const block of blocks) {
        for (const line of block) {
          out += line + '\n';
        }
      }
    }

    return out.trimEnd() + '\n';
  }

  summarize(blocks) {
    const tags = {
      today: 0,
      tomorrow: 0,
      week: 0,
      nextweek: 0,
      nextfewdays: 0
    };

    for (const block of blocks) {
      const line = block[0].toLowerCase();
      if (line.includes('#today')) tags.today++;
      if (line.includes('#tomorrow')) tags.tomorrow++;
      if (line.includes('#week')) tags.week++;
      if (line.includes('#nextweek')) tags.nextweek++;
      if (line.includes('#nextfewdays')) tags.nextfewdays++;
    }

    const tagText = [];
    if (tags.today) tagText.push(`${tags.today} #today`);
    if (tags.tomorrow) tagText.push(`${tags.tomorrow} #tomorrow`);
    if (tags.week) tagText.push(`${tags.week} #week`);
    if (tags.nextweek) tagText.push(`${tags.nextweek} #nextweek`);
    if (tags.nextfewdays) tagText.push(`${tags.nextfewdays} #nextfewdays`);

    return { total: blocks.length, tags: tagText };
  }

  // ------------------------------------------------------------
  // Inject section into Projects.md
  // ------------------------------------------------------------
  mergeIntoProjectsFile(lines, newSection) {
    const idx = lines.findIndex((l) =>
      l.trim().toLowerCase().startsWith('# existing projects')
    );

    let prefixLines;
    if (idx === -1) {
      prefixLines = [...lines];
      if (prefixLines[prefixLines.length - 1].trim() !== '') prefixLines.push('');
    } else {
      prefixLines = lines.slice(0, idx);
      while (prefixLines.length > 0 && prefixLines[prefixLines.length - 1].trim() === '') {
        prefixLines.pop();
      }
      // Only insert a single blank line if the last line is non-empty
      if (prefixLines.length === 0 || prefixLines[prefixLines.length - 1].trim() !== '') {
        prefixLines.push('');
      }
    }

    return prefixLines.join('\n') + '\n' + newSection;
  }
}

module.exports = KineticProjectsLedgerPlugin;
