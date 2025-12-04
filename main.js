const { Plugin, ItemView, TFile, Notice, PluginSettingTab, Setting } = require('obsidian');

// ---------- CONSTANTS ----------

const TASKS_LEDGER_PATH = 'Tasks/Kinetic-Tasks.md';
const PROJECTS_FILE_PATH = "Tasks/Projects.md";
const BOARD_VIEW_TYPE = 'kinetic-board';
const TAG_RULES_PATH = '_templates/Tag-Rules.yaml'; // <— Tag rules (optional)

// S3 tags (exclusive family)
const S3_TAGS = [
  'today',
  'asap',
  'tomorrow',
  'nextfewdays',
  'week',
  'month',
  'later',
];

const TASK_ID_REGEX = /\^t(\d+)\^/;
const PROJECT_TAG_REGEX = /#P(\d+)\b/gi;

// ---------- HELPERS ----------

function isTopLevelOpenTaskHeader(line) {
  // Treat 0–1 leading spaces before "- [ ]" as top-level.
  // This is more forgiving of how people actually type lists.
  const m = line.match(/^(\s*)-\s\[\s\]\s+/);
  if (!m) return false;
  const indent = m[1].length;
  return indent <= 1;
}

function isTaskHeaderChecked(line) {
  return /^\s*-\s\[[xX]\]/.test(line);
}

function getTaskBlock(lines, startIndex) {
  const block = [];
  if (startIndex < 0 || startIndex >= lines.length) return block;

  const headerLine = lines[startIndex];
  block.push(headerLine);

  const headerIndentMatch = headerLine.match(/^\s*/);
  const headerIndent = headerIndentMatch ? headerIndentMatch[0].length : 0;

  for (let j = startIndex + 1; j < lines.length; j++) {
    const line = lines[j];

    if (line.trim().length === 0) {
      block.push(line);
      continue;
    }

    const indentMatch = line.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0].length : 0;

    if (indent <= headerIndent) break;

    block.push(line);
  }

  return block;
}

// Strip ONLY S3 tags from a header line, keep all other tags
function stripS3TagsFromLine(line) {
  return line
    .replace(/#([A-Za-z0-9/_-]+)/g, (match, tag) => {
      const bare = tag.toLowerCase();
      if (S3_TAGS.includes(bare)) {
        return '';
      }
      return match;
    })
    .replace(/\s+/g, ' ')
    .trimEnd();
}

// Add a specific S3 tag to a line (assumes S3 tags have been stripped)
function addS3TagToLine(line, tagId) {
  if (!tagId || tagId === 'none') return line;
  const token = `#${tagId}`;
  if (line.includes(token)) return line;
  return `${line} ${token}`.replace(/\s+/g, ' ').trimEnd();
}

function stripProjectTagsFromLine(line) {
  return line
    .replace(/#P\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trimEnd();
}

function addProjectTagToLine(line, projectId) {
  if (!projectId || projectId === 'No Project') return line;
  const token = `#${projectId}`;
  if (line.includes(token)) return line;
  return `${line} ${token}`.replace(/\s+/g, ' ').trimEnd();
}

// Deduplicate subtask lines within a task block.  A task block consists of a
// header line followed by any number of nested list lines representing
// subtasks. When promoting tasks from files into the ledger or merging
// existing blocks, it's possible for the same subtask to be repeated
// multiple times (for example, due to earlier sync bugs or accidental
// duplication). This helper removes duplicate subtask lines by comparing
// their textual content (ignoring the checkbox state) and indentation.
// Only the first occurrence of a given subtask is kept.  The header line
// (index 0) is always preserved.
function dedupeTaskBlock(block) {
  if (!Array.isArray(block) || block.length === 0) return block;
  const result = [];
  const seen = new Set();
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    // Always keep the header line
    if (i === 0) {
      result.push(line);
      continue;
    }
    // Match lines that look like subtasks: "- [ ] text" or "- [x] text"
    const match = line.match(/^\s*-\s*\[[ xX]\]\s*(.*)$/);
    if (match) {
      const text = match[1].trim();
      // Use the subtask text as a key to detect duplicates. If we've
      // already seen this subtask, skip it; otherwise record it.
      if (seen.has(text)) {
        continue;
      }
      seen.add(text);
    }
    result.push(line);
  }
  return result;
}

// Preserve derived tags (S3 + project) from the ledger when promoting from files
function mergeDerivedTagsFromLedger(oldHeader, newHeader) {
  let merged = newHeader;
  const lowerNew = newHeader.toLowerCase();
  const lowerOld = oldHeader.toLowerCase();

  // Preserve S3 tag(s) if new header lacks any
  const newHasS3 = S3_TAGS.some(tag => lowerNew.includes(`#${tag}`));
  if (!newHasS3) {
    const oldS3Tags = S3_TAGS
      .filter(tag => lowerOld.includes(`#${tag}`))
      .map(tag => `#${tag}`);
    if (oldS3Tags.length) {
      merged = `${merged} ${oldS3Tags.join(' ')}`;
    }
  }

  // Preserve project tag(s) if new header lacks any
  const oldProjTags = oldHeader.match(/#P\d+\b/g) || [];
  const newProjTags = newHeader.match(/#P\d+\b/g) || [];
  if (oldProjTags.length && newProjTags.length === 0) {
    merged = `${merged} ${oldProjTags.join(' ')}`;
  }

  return merged.replace(/\s+/g, ' ').trimEnd();
}

// Parse header line for display metadata
function parseHeaderForDisplay(headerLine) {
  // remove checkbox prefix
  let text = headerLine.replace(/^-\s\[[ xX]\]\s+/, '');
  // remove ^tNN^ token
  text = text.replace(/\^t\d+\^\s*/, '');
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);

  const tags = [];
  const mentions = [];
  let due = null;
  const titleParts = [];

  for (const tok of tokens) {
    if (tok.startsWith('#')) {
      tags.push(tok);
      continue;
    }
    if (tok.startsWith('@due(') || tok.startsWith('📅')) {
      if (!due) due = tok;
      continue;
    }
    if (tok.startsWith('@')) {
      mentions.push(tok);
      continue;
    }
    titleParts.push(tok);
  }

  const title = titleParts.join(' ');
  return { title, tags, mentions, due };
}

async function openTaskInEditor(plugin, taskId) {
  const app = plugin.app;
  const file = app.vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
  if (!(file instanceof TFile)) {
    new Notice(`Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
    return;
  }

  const link = `${TASKS_LEDGER_PATH}#^${taskId}^`;
  await app.workspace.openLinkText(link, '', false);

  const leaf = app.workspace.getMostRecentLeaf();
  if (!leaf) return;
  const view = leaf.view;
  if (!view || !view.editor) return;

  const editor = view.editor;
  const lineCount = editor.lineCount();
  for (let i = 0; i < lineCount; i++) {
    const line = editor.getLine(i);
    if (line.includes(`^${taskId}^`)) {
      editor.setCursor({ line: i, ch: 0 });
      editor.scrollIntoView(
        { from: { line: i, ch: 0 }, to: { line: i + 3, ch: 0 } },
        true
      );
      editor.setSelection(
        { line: i, ch: 0 },
        { line: i, ch: line.length }
      );
      setTimeout(
        () =>
          editor.setSelection(
            { line: i, ch: 0 },
            { line: i, ch: 0 }
          ),
        900
      );
      break;
    }
  }
}

// ---------- TAG RULES & HEADER-BASED AUTO-TAGGING ----------

function getDefaultTagRules() {
  return {
    exclusive: {
      project: "^#P\\d+$",
      s3: "^(#today|#asap|#tomorrow|#nextfewdays|#week|#month|#later)$"
    },
    multi: {
      people: "^@who-",
      commitment: "^#Commitment$"
    },
    dates: {
      due: "@due(",
      target: "@target("
    },
    inheritance: {
      project: true,
      s3: true,
      people: true,
      commitment: true,
      due: true,
      target: true
    }
  };
}

function deepMergeTagRules(base, overrides) {
  const out = JSON.parse(JSON.stringify(base));
  if (!overrides) return out;

  for (const section of ['exclusive', 'multi', 'dates', 'inheritance']) {
    if (!overrides[section]) continue;
    if (!out[section]) out[section] = {};
    for (const [k, v] of Object.entries(overrides[section])) {
      out[section][k] = v;
    }
  }
  return out;
}

async function loadTagRules(app) {
  const defaults = getDefaultTagRules();
  const file = app.vault.getAbstractFileByPath(TAG_RULES_PATH);
  if (!(file instanceof TFile)) {
    new Notice('Kinetic: Tag-Rules.yaml not found, using defaults');
    return defaults;
  }
  try {
    const text = await app.vault.read(file);
    const partial = parseTagRulesYaml(text);
    // Merge partial rules over defaults so unspecified inheritance flags
    // (like s3) stay enabled.
    return deepMergeTagRules(defaults, partial);
  } catch (e) {
    console.error('Kinetic: failed to read Tag-Rules.yaml', e);
    new Notice('Kinetic: Failed to read Tag-Rules.yaml, using defaults');
    return defaults;
  }
}

// extremely small YAML parser for the simple structure we use
function parseTagRulesYaml(text) {
  const lines = text.split('\n');
  const rules = { exclusive: {}, multi: {}, dates: {}, inheritance: {} };
  let currentSection = null;

  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^(\w+):\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const entryMatch = line.match(/^(\w+):\s*(.+)$/);
    if (entryMatch && currentSection && rules[currentSection] !== undefined) {
      const key = entryMatch[1];
      let value = entryMatch[2].trim();
      const quoted = value.match(/^"(.*)"$/);
      if (quoted) value = quoted[1];

      if (currentSection === 'inheritance') {
        rules.inheritance[key] = value.toLowerCase() === 'true';
      } else {
        rules[currentSection][key] = value;
      }
    }
  }

  return rules;
}

// ------------------------------------------------------------------------------
// ID assignment helpers for auto-generating task IDs
// ------------------------------------------------------------------------------

async function getNextTaskIdNumber(app) {
  const ledger = app.vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
  if (!(ledger instanceof TFile)) {
    return 1;
  }
  try {
    const text = await app.vault.read(ledger);
    const ids = Array.from(
      text.matchAll(/\^t(\d+)\^/g),
      (m) => parseInt(m[1], 10)
    ).filter((n) => !isNaN(n));
    if (ids.length === 0) return 1;
    const maxId = Math.max(...ids);
    return maxId + 1;
  } catch (e) {
    console.error('Kinetic: failed to read ledger for next ID', e);
    return 1;
  }
}

async function assignIdsToNewTasks(plugin, file, text, threshold = 4) {
  let lines = text.split('\n');
  let changed = false;
  let nextId = await getNextTaskIdNumber(plugin.app);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!isTopLevelOpenTaskHeader(line)) continue;
    if (/\^t\d+\^/.test(line)) continue;

    const restMatch = line.match(/^\s*-\s*\[\s*\]\s*(.*)$/);
    if (restMatch) {
      const remaining = restMatch[1].trim();
      if (remaining.length < threshold) {
        continue;
      }
    }

    const idToken = `^t${nextId}^`;
    nextId++;
    lines[i] = line.replace(/^([\s*-]*-\s*\[\s*\]\s*)/, `$1${idToken} `);
    changed = true;
  }
  return { text: lines.join('\n'), changed };
}

// ---------- CONTEXT / HEADER RULES CORE ----------

function makeEmptyContext() {
  return {
    project: null,
    s3: null,
    people: [],
    commitment: false,
    due: null,
    target: null
  };
}

function cloneContext(ctx) {
  return {
    project: ctx.project,
    s3: ctx.s3,
    people: Array.isArray(ctx.people) ? [...ctx.people] : [],
    commitment: !!ctx.commitment,
    due: ctx.due,
    target: ctx.target
  };
}

function extractContextFromHeaderText(headerText, rules, parentCtx) {
  const ctx = cloneContext(parentCtx || makeEmptyContext());
  const tokens = headerText.split(/\s+/).filter((t) => t.length > 0);

  const exclusProjPattern = rules.exclusive?.project || "^#P\\d+$";
  const exclusS3Pattern =
    rules.exclusive?.s3 ||
    "^(#today|#asap|#tomorrow|#nextfewdays|#week|#month|#later)$";
  const projRegex = new RegExp(exclusProjPattern);
  const s3Regex = new RegExp(exclusS3Pattern);

  const peoplePattern = rules.multi?.people || "^@who-";
  const peopleRegex = new RegExp(peoplePattern);

  const commitmentPattern = rules.multi?.commitment || "^#Commitment$";
  const commitmentRegex = new RegExp(commitmentPattern);

  const duePrefix = (rules.dates && rules.dates.due) || "@due(";
  const targetPrefix = (rules.dates && rules.dates.target) || "@target(";

  const inh = rules.inheritance || {};

  const projectTags = [];
  let headerProject = null;
  let headerS3 = null;
  const headerPeople = [];
  let headerCommitment = null;
  let headerDue = null;
  let headerTarget = null;

  for (const tok of tokens) {
    if (inh.project && projRegex.test(tok)) {
      projectTags.push(tok);
      headerProject = tok;
      continue;
    }
    if (inh.s3 && s3Regex.test(tok)) {
      headerS3 = tok;
      continue;
    }
    if (inh.people && peopleRegex.test(tok)) {
      headerPeople.push(tok);
      continue;
    }
    if (inh.commitment && commitmentRegex.test(tok)) {
      headerCommitment = true;
      continue;
    }
    if (inh.due && tok.startsWith(duePrefix)) {
      headerDue = tok;
      continue;
    }
    if (inh.target && tok.startsWith(targetPrefix)) {
      headerTarget = tok;
      continue;
    }
  }

  let projectError = null;
  if (projectTags.length > 1) {
    projectError = `Multiple project tags in header: "${headerText}"`;
  } else if (projectTags.length === 1 && inh.project) {
    ctx.project = headerProject;
  }

  if (headerS3 && inh.s3) {
    ctx.s3 = headerS3;
  }

  if (headerPeople.length > 0 && inh.people) {
    ctx.people = headerPeople;
  }

  if (headerCommitment !== null && inh.commitment) {
    ctx.commitment = headerCommitment;
  }

  if (headerDue && inh.due) {
    ctx.due = headerDue;
  }

  if (headerTarget && inh.target) {
    ctx.target = headerTarget;
  }

  return { ctx, projectError };
}

function stripContextTagsFromLine(line, rules) {
  let result = line;

  const exclusProjPattern = rules.exclusive?.project || "^#P\\d+$";
  const projRegex = new RegExp(exclusProjPattern, 'g');
  result = result.replace(projRegex, '');

  const exclusS3Pattern =
    rules.exclusive?.s3 ||
    "^(#today|#asap|#tomorrow|#nextfewdays|#week|#month|#later)$";
  const s3Regex = new RegExp(exclusS3Pattern, 'g');
  result = result.replace(s3Regex, '');

  const peoplePattern = rules.multi?.people || "^@who-";
  const peopleRegex = new RegExp(peoplePattern, 'g');
  result = result.replace(peopleRegex, '');

  const commitmentPattern = rules.multi?.commitment || "^#Commitment$";
  const commitmentRegex = new RegExp(commitmentPattern, 'g');
  result = result.replace(commitmentRegex, '');

  const duePrefix = (rules.dates && rules.dates.due) || "@due(";
  const targetPrefix = (rules.dates && rules.dates.target) || "@target(";
  result = result
    .split(/\s+/)
    .filter((tok) => {
      if (!tok) return false;
      if (tok.startsWith(duePrefix)) return false;
      if (tok.startsWith(targetPrefix)) return false;
      return true;
    })
    .join(' ');

  return result.replace(/\s+/g, ' ').trimEnd();
}

function addContextTagsToLine(line, ctx, rules) {
  let result = line;

  function ensureToken(tok) {
    if (!tok) return;
    if (result.includes(tok)) return;
    result = `${result} ${tok}`.replace(/\s+/g, ' ').trimEnd();
  }

  if (ctx.project && rules.inheritance?.project) {
    ensureToken(ctx.project);
  }
  if (ctx.s3 && rules.inheritance?.s3) {
    ensureToken(ctx.s3);
  }
  if (Array.isArray(ctx.people) && ctx.people.length > 0 && rules.inheritance?.people) {
    for (const p of ctx.people) ensureToken(p);
  }
  if (ctx.commitment && rules.inheritance?.commitment) {
    ensureToken('#Commitment');
  }
  if (ctx.due && rules.inheritance?.due) {
    ensureToken(ctx.due);
  }
  if (ctx.target && rules.inheritance?.target) {
    ensureToken(ctx.target);
  }

  return result;
}

// Core engine: apply header rules to an arbitrary file
async function applyHeaderRulesToFile(plugin, file, preloadedText) {
  const app = plugin.app;
  if (!file || !(file instanceof TFile)) {
    new Notice('Kinetic: No file to apply header rules to.');
    return;
  }

  const rules = await loadTagRules(app);
  const text = preloadedText ?? await app.vault.read(file);
  const lines = text.split('\n');

  const contextByTaskId = new Map();
  const contextStack = [{ level: 0, ctx: makeEmptyContext() }];
  const projectErrors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const hMatch = line.match(/^(\s{0,3})(#+)\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[2].length;
      const headerText = hMatch[3];

      while (contextStack.length > 0 && contextStack[contextStack.length - 1].level >= level) {
        contextStack.pop();
      }
      const parentFrame =
        contextStack[contextStack.length - 1] || { level: 0, ctx: makeEmptyContext() };
      const parentCtx = parentFrame.ctx;

      const { ctx, projectError } = extractContextFromHeaderText(headerText, rules, parentCtx);
      if (projectError) {
        projectErrors.push(projectError);
      }

      contextStack.push({ level, ctx });
      continue;
    }

    if (isTopLevelOpenTaskHeader(line)) {
      const idMatch = line.match(TASK_ID_REGEX);
      if (!idMatch) continue;
      const id = `t${idMatch[1]}`;
      const topFrame =
        contextStack[contextStack.length - 1] || { level: 0, ctx: makeEmptyContext() };
      const currCtx = topFrame.ctx;
      contextByTaskId.set(id, cloneContext(currCtx));
    }
  }

  if (projectErrors.length > 0) {
    new Notice(
      'Kinetic: Multiple project tags found in some headers. Fix them and re-run header sync. First: ' +
        projectErrors[0]
    );
  }

  if (contextByTaskId.size === 0) {
    return;
  }
  // First, apply context directly to the active file itself so you can
  // actually see the project/S3/etc tags show up under each header.
  const updatedLines = [...lines];

  for (let i = 0; i < updatedLines.length; i++) {
    const line = updatedLines[i];

    if (!isTopLevelOpenTaskHeader(line)) continue;

    const idMatch = line.match(TASK_ID_REGEX);
    if (!idMatch) continue;
    const id = `t${idMatch[1]}`;

    const ctx = contextByTaskId.get(id);
    if (!ctx) continue;

    let updated = stripContextTagsFromLine(line, rules);
    updated = addContextTagsToLine(updated, ctx, rules);
    updatedLines[i] = updated;
  }

  // Write changes back to the source file (e.g. Inbox.md)
  await app.vault.modify(file, updatedLines.join('\n'));

  const ledgerFile = app.vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
  if (!(ledgerFile instanceof TFile)) {
    new Notice(`Kinetic: Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
    return;
  }

  const ledgerText = await app.vault.read(ledgerFile);
  const ledgerLines = ledgerText.split('\n');

  for (let i = 0; i < ledgerLines.length; i++) {
    let line = ledgerLines[i];
    if (!isTopLevelOpenTaskHeader(line)) continue;
    const m = line.match(TASK_ID_REGEX);
    if (!m) continue;
    const id = `t${m[1]}`;
    const ctx = contextByTaskId.get(id);
    if (!ctx) continue;

    let updated = stripContextTagsFromLine(line, rules);
    updated = addContextTagsToLine(updated, ctx, rules);
    ledgerLines[i] = updated;
  }

  await app.vault.modify(ledgerFile, ledgerLines.join('\n'));
  new Notice(`Kinetic: Header rules applied from "${file.path}" into ledger.`);
}

// ---------- SETTINGS ----------

const DEFAULT_SETTINGS = {
  showCardMetadata: true,
  showSubtasksByDefault: false,
  collapsedS3Columns: [],
  collapsedProjects: [],
  autoFullSyncOnLoad: true,
  autoFullSyncOnLedgerSave: false
};

class KineticSuiteSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Kinetic Suite – Settings' });

    new Setting(containerEl)
      .setName('Show card metadata (tags, people, due)')
      .setDesc('If disabled, cards only show the task title and ID.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showCardMetadata)
          .onChange(async (value) => {
            this.plugin.settings.showCardMetadata = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Expand subtasks by default')
      .setDesc('When enabled, cards show all subtasks initially.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSubtasksByDefault)
          .onChange(async (value) => {
            this.plugin.settings.showSubtasksByDefault = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Auto Full Sync on load')
      .setDesc('Automatically run full sync when Obsidian starts or the plugin is enabled.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoFullSyncOnLoad)
          .onChange(async (value) => {
            this.plugin.settings.autoFullSyncOnLoad = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Auto Full Sync when ledger is saved')
      .setDesc('Automatically run full sync whenever Tasks/Kinetic-Tasks.md is modified.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoFullSyncOnLedgerSave)
          .onChange(async (value) => {
            this.plugin.settings.autoFullSyncOnLedgerSave = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

// ---------- UNIFIED BOARD VIEW (S3 + Projects with toggle) ----------

class KineticBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = 's3';
    this.tasks = [];
    this.groups = {};
    this.contentContainer = null;
  }

  getViewType() {
    return BOARD_VIEW_TYPE;
  }

  getDisplayText() {
    return 'Kinetic Board';
  }

  getIcon() {
    return 'layout-kanban';
  }

  async onOpen() {
    this.mode = 's3';
    await this.reloadDataAndRender();
  }

  async reloadDataAndRender() {
    await this.loadDataFromLedger();
    this.renderRoot();
  }

  async loadDataFromLedger() {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);

    this.tasks = [];
    this.groups = {};

    if (!(file instanceof TFile)) {
      return;
    }

    const content = await vault.read(file);
    const lines = content.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!isTopLevelOpenTaskHeader(line)) {
        i++;
        continue;
      }

      const idMatch = line.match(TASK_ID_REGEX);
      if (!idMatch) {
        const block = getTaskBlock(lines, i);
        i += block.length;
        continue;
      }

      const id = `t${idMatch[1]}`;
      const block = getTaskBlock(lines, i);
      const header = block[0];
      const lower = header.toLowerCase();

      let s3 = null;
      for (const tag of S3_TAGS) {
        if (lower.includes(`#${tag}`)) {
          s3 = tag;
          break;
        }
      }
      const columnId = s3 || 'none';

      let projectId = 'No Project';
      let projNum = null;
      let m;
      PROJECT_TAG_REGEX.lastIndex = 0;
      while ((m = PROJECT_TAG_REGEX.exec(header)) !== null) {
        projNum = m[1];
        break;
      }
      if (projNum) projectId = `P${projNum}`;

      const task = { id, headerLine: header, block, columnId, projectId };
      this.tasks.push(task);

      if (!this.groups[projectId]) this.groups[projectId] = [];
      this.groups[projectId].push(task);

      i += block.length;
    }
  }

  renderRoot() {
    const root = this.contentEl;
    root.empty();
    root.addClass('kinetic-board-root');

    const toggleBar = root.createDiv('kinetic-toggle-bar');

    const s3Btn = toggleBar.createEl('button', { text: 'S3' });
    const projBtn = toggleBar.createEl('button', { text: 'Projects' });

    s3Btn.addClass('kinetic-toggle-btn');
    projBtn.addClass('kinetic-toggle-btn');

    if (this.mode === 's3') {
      s3Btn.addClass('active');
    } else {
      projBtn.addClass('active');
    }

    s3Btn.onclick = () => {
      if (this.mode === 's3') return;
      this.mode = 's3';
      s3Btn.addClass('active');
      projBtn.removeClass('active');
      this.renderContent();
    };

    projBtn.onclick = () => {
      if (this.mode === 'projects') return;
      this.mode = 'projects';
      projBtn.addClass('active');
      s3Btn.removeClass('active');
      this.renderContent();
    };

    this.contentContainer = root.createDiv('kinetic-board-content');
    this.renderContent();
  }

  renderContent() {
    const container = this.contentContainer;
    if (!container) return;
    container.empty();

    if (this.mode === 's3') {
      this.renderS3Board(container);
    } else {
      this.renderProjectDashboard(container);
    }
  }

  // ---------- S3 BOARD RENDERING ----------

  renderS3Board(root) {
    const topRow = root.createDiv('kinetic-s3-board-row');
    const stagingRow = root.createDiv('kinetic-s3-board-row staging');

    const tasksByColumn = {};
    for (const tag of [...S3_TAGS, 'none']) tasksByColumn[tag] = [];
    for (const t of this.tasks) {
      if (!tasksByColumn[t.columnId]) tasksByColumn[t.columnId] = [];
      tasksByColumn[t.columnId].push(t);
    }

    const collapsed = new Set(this.plugin.settings.collapsedS3Columns || []);

    for (const tag of S3_TAGS) {
      const colEl = topRow.createDiv('kinetic-s3-column');
      colEl.setAttr('data-s3-id', tag);
      if (collapsed.has(tag)) colEl.addClass('kinetic-s3-column-collapsed');

      const header = colEl.createDiv('kinetic-s3-column-header');
      const count = tasksByColumn[tag].length;
      const chevron = collapsed.has(tag) ? '▶' : '▼';
      const label = `#${tag}`;
      header.setText(`${chevron} ${label} (${count})`);

      header.onclick = async () => {
        const set = new Set(this.plugin.settings.collapsedS3Columns || []);
        if (set.has(tag)) set.delete(tag);
        else set.add(tag);
        this.plugin.settings.collapsedS3Columns = Array.from(set);
        await this.plugin.saveSettings();
        this.renderContent();
      };

      const list = colEl.createDiv('kinetic-s3-column-body');
      list.setAttr('data-drop-target', 'true');
      list.ondragover = (ev) => {
        ev.preventDefault();
        list.addClass('kinetic-s3-column-drop-hover');
      };
      list.ondragleave = () => {
        list.removeClass('kinetic-s3-column-drop-hover');
      };
      list.ondrop = async (ev) => {
        ev.preventDefault();
        list.removeClass('kinetic-s3-column-drop-hover');
        const taskId = ev.dataTransfer.getData('text/plain');
        if (!taskId) return;
        await this.moveTaskToS3(taskId, tag);
      };

      if (collapsed.has(tag)) continue;

      for (const t of tasksByColumn[tag]) {
        this.renderS3Card(list, t);
      }
    }

    const stagingCol = stagingRow.createDiv('kinetic-s3-column staging-full');
    stagingCol.setAttr('data-s3-id', 'none');

    const stagingHeader = stagingCol.createDiv('kinetic-s3-column-header');
    const stagingCount = tasksByColumn['none'].length;
    stagingHeader.setText(`No S3 Tag (${stagingCount})`);

    const stagingBody = stagingCol.createDiv('kinetic-s3-column-body');
    stagingBody.setAttr('data-drop-target', 'true');
    stagingBody.ondragover = (ev) => {
      ev.preventDefault();
      stagingBody.addClass('kinetic-s3-column-drop-hover');
    };
    stagingBody.ondragleave = () => {
      stagingBody.removeClass('kinetic-s3-column-drop-hover');
    };
    stagingBody.ondrop = async (ev) => {
      ev.preventDefault();
      stagingBody.removeClass('kinetic-s3-column-drop-hover');
      const taskId = ev.dataTransfer.getData('text/plain');
      if (!taskId) return;
      await this.moveTaskToS3(taskId, 'none');
    };

    for (const t of tasksByColumn['none']) {
      this.renderS3Card(stagingBody, t);
    }
  }

  renderS3Card(container, task) {
    const card = container.createDiv('kinetic-s3-card');
    card.setAttr('draggable', 'true');
    card.setAttr('data-task-id', task.id);

    card.ondragstart = (ev) => {
      ev.dataTransfer.setData('text/plain', task.id);
    };

       card.onclick = async (ev) => {
      // Ignore clicks on controls or inline inputs; only bare-card clicks
      // should navigate to the ledger.
      if (
        ev.target.closest('.kinetic-s3-card-toggle') ||
        ev.target.closest('.kinetic-s3-card-done') ||
        ev.target.closest('.kinetic-s3-card-edit') ||
        ev.target.closest('.kinetic-s3-card-title-input') ||
        ev.target.closest('input')
      ) {
        return;
      }
      await openTaskInEditor(this.plugin, task.id);
    };



    const parsed = parseHeaderForDisplay(task.headerLine);
    const titleText =
      parsed.title || task.headerLine.replace(/^-\s\[[ xX]\]\s+/, '');

       const titleRow = card.createDiv('kinetic-s3-card-title-row');
    const titleDiv = titleRow.createDiv('kinetic-s3-card-title');
    titleDiv.setText(titleText);

    // Click on the title itself to begin inline editing.
    titleDiv.onclick = (ev) => {
      ev.stopPropagation();
      this.beginInlineEditTitle(card, titleDiv, task);
    };

    // Small edit icon next to the title.
    const editButton = titleRow.createDiv('kinetic-s3-card-edit');
    editButton.setText('✎');
    editButton.setAttr('title', 'Edit title');
    editButton.onclick = (ev) => {
      ev.stopPropagation();
      this.beginInlineEditTitle(card, titleDiv, task);
    };

    const doneButton = titleRow.createDiv('kinetic-s3-card-done');
    doneButton.setText('✓');
    doneButton.setAttr('title', 'Mark done');
    doneButton.onclick = async (ev) => {
      ev.stopPropagation();
      await this.markTaskDone(task.id);
    };

    const toggle = titleRow.createDiv('kinetic-s3-card-toggle');


    toggle.setText(
      this.plugin.settings.showSubtasksByDefault ? '▾' : '▸'
    );

    const hasSubtasks = task.block.length > 1;
    let subtasksVisible = this.plugin.settings.showSubtasksByDefault;

    toggle.onclick = (ev) => {
      ev.stopPropagation();
      if (!hasSubtasks) return;
      subtasksVisible = !subtasksVisible;
      toggle.setText(subtasksVisible ? '▾' : '▸');
      subContainer.toggleClass('hidden', !subtasksVisible);
    };

    if (!hasSubtasks) {
      toggle.addClass('disabled');
      toggle.setText('');
    }

    if (this.plugin.settings.showCardMetadata) {
      const metaTop = card.createDiv('kinetic-s3-card-meta-top');
      const tags = [...parsed.tags, ...parsed.mentions];
      if (tags.length) metaTop.setText(tags.join(' '));

      if (parsed.due) {
        const metaBottom = card.createDiv('kinetic-s3-card-meta-bottom');
        metaBottom.setText(parsed.due);
      }
    }

    const idDiv = card.createDiv('kinetic-s3-card-id');
    idDiv.setText(task.id);

    const subContainer = card.createDiv('kinetic-s3-subtasks');
    if (!subtasksVisible) subContainer.addClass('hidden');

    for (let i = 1; i < task.block.length; i++) {
      const line = task.block[i];
      if (!line.trim()) continue;
      const subLine = subContainer.createDiv('kinetic-s3-subtask-line');
      const indent = (line.match(/^\s*/) || [''])[0].length;
      subLine.style.marginLeft = `${Math.max(0, indent - 2) * 0.6}ch`;
      subLine.setText(line.trim());
    }
  }

  async moveTaskToS3(taskId, newTag) {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
    if (!(file instanceof TFile)) {
      new Notice(`Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
      return;
    }

    const content = await vault.read(file);
    const lines = content.split('\n');

    let startIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isTopLevelOpenTaskHeader(line)) continue;
      const m = line.match(TASK_ID_REGEX);
      if (!m) continue;
      const id = `t${m[1]}`;
      if (id === taskId) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) {
      new Notice(`Task ${taskId} not found in ledger`);
      return;
    }

    const block = getTaskBlock(lines, startIndex);
    if (block.length === 0) {
      new Notice(`Task block for ${taskId} is empty`);
      return;
    }

    let header = block[0];
    header = stripS3TagsFromLine(header);
    if (newTag !== 'none') {
      header = addS3TagToLine(header, newTag);
    }
    block[0] = header;

    lines.splice(startIndex, block.length, ...block);
    await vault.modify(file, lines.join('\n'));
    await this.reloadDataAndRender();
  }

  async markTaskDone(taskId) {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
    if (!(file instanceof TFile)) {
      new Notice(`Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
      return;
    }

    const content = await vault.read(file);
    const lines = content.split('\n');

    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('^t')) continue;

      const m = line.match(TASK_ID_REGEX);
      if (!m) continue;
      const id = `t${m[1]}`;
      if (id !== taskId) continue;

      // Only operate on task headers
      if (!/^\s*-\s\[[ xX]\]/.test(line)) continue;

      const newLine = line.replace(
        /^(\s*)-\s\[[ xX]\]/,
        '$1- [x]'
      );

      if (newLine !== line) {
        lines[i] = newLine;
        updated = true;
      }
      break;
    }

    if (!updated) {
      new Notice(`Task ${taskId} not found in ledger`);
      return;
    }

    await vault.modify(file, lines.join('\n'));
    await this.reloadDataAndRender();
  }

  /**
   * Rename the title portion of a task header in the ledger. This will
   * locate the header line by taskId, preserve checkbox state, ID token,
   * tags, and any ✅ marker, but replace the actual title text. After
   * modification it will save the ledger and reload the board.
   *
   * @param {string} taskId The task ID (e.g. "t123") to rename
   * @param {string} newTitle The new title text to set
   */
  async renameTaskTitle(taskId, newTitle) {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
    if (!(file instanceof TFile)) {
      new Notice(`Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
      return;
    }

    const content = await vault.read(file);
    const lines = content.split('\n');
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('^t')) continue;
      const m = line.match(TASK_ID_REGEX);
      if (!m) continue;
      const id = `t${m[1]}`;
      if (id !== taskId) continue;

      // Only operate on task header lines with checkbox and ID token
      const headerMatch = line.match(/^(\s*-\s\[[ xX]\]\s+\^t\d+\^\s+)(.*)$/);
      if (!headerMatch) continue;

      const prefix = headerMatch[1];
      const rest = headerMatch[2];

      // Determine where tags or done marker start
      let splitIdx = rest.length;
      const tagIdx = rest.search(/(^|\s)#\S+/);
      if (tagIdx !== -1 && tagIdx < splitIdx) splitIdx = tagIdx;
      const doneIdx = rest.indexOf('✅');
      if (doneIdx !== -1 && doneIdx < splitIdx) splitIdx = doneIdx;

      const tail = splitIdx < rest.length ? rest.slice(splitIdx).trim() : '';
      const safeTitle = newTitle.trim();
      const newRest = tail ? `${safeTitle} ${tail}` : safeTitle;

      lines[i] = prefix + newRest;
      updated = true;
      break;
    }

    if (!updated) {
      new Notice(`Task ${taskId} not found in ledger`);
      return;
    }

    await vault.modify(file, lines.join('\n'));
    await this.reloadDataAndRender();
  }

  /**
   * Begin inline editing of a task title on the S3 board. Replaces the
   * provided titleDiv's content with a text input. On blur or Enter it
   * commits the change via renameTaskTitle; on Escape or no change it
   * restores the original title. Editing is confined to the card and
   * prevents propagation of click events.
   *
   * @param {HTMLElement} card The card element containing the title
   * @param {HTMLElement} titleDiv The div displaying the title text
   * @param {Object} task The task metadata, must contain id property
   */
  beginInlineEditTitle(card, titleDiv, task) {
    const current = titleDiv.getText();
    // Clear existing content and insert input
    titleDiv.empty();
    const input = titleDiv.createEl('input');
    input.type = 'text';
    input.value = current;

    const finish = async (commit) => {
      if (commit) {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== current) {
          await this.renameTaskTitle(task.id, newTitle);
          return; // reloadDataAndRender will refresh the board
        }
      }
      // Restore original text if no commit or no change
      titleDiv.empty();
      titleDiv.setText(current);
    };

    input.onblur = () => {
      finish(true);
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    };
    // Autofocus and select existing text
    input.focus();
    input.setSelectionRange(0, input.value.length);
  }
  async renameTaskTitle(taskId, newTitle) {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
    if (!(file instanceof TFile)) {
      new Notice(`Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
      return;
    }

    const content = await vault.read(file);
    const lines = content.split('\n');

    let updated = false;
    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle) {
      new Notice('Kinetic: Title cannot be empty.');
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('^t')) continue;

      const m = line.match(TASK_ID_REGEX);
      if (!m) continue;
      const id = `t${m[1]}`;
      if (id !== taskId) continue;

      // Expect: "- [ ] ^tNN^ Title #tags @who-... @due(...)"
      const headerMatch = line.match(/^(\s*-\s\[[ xX]\]\s+\^t\d+\^\s+)(.*)$/);
      if (!headerMatch) continue;

      const prefix = headerMatch[1];
      const rest = headerMatch[2];

      // Split rest into tokens; everything up to the first tag/date/mention
      // is considered the title, remaining tokens are metadata.
      const parts = rest.split(/\s+/).filter(t => t.length > 0);

      let metaIndex = parts.length;
      for (let j = 0; j < parts.length; j++) {
        const tok = parts[j];
        if (tok.startsWith('#') || tok.startsWith('@') || tok.startsWith('📅')) {
          metaIndex = j;
          break;
        }
      }

      const metaTokens = parts.slice(metaIndex);
      const newRest = metaTokens.length
        ? `${trimmedTitle} ${metaTokens.join(' ')}`
        : trimmedTitle;

      lines[i] = `${prefix}${newRest}`;
      updated = true;
      break;
    }

    if (!updated) {
      new Notice(`Task ${taskId} not found in ledger`);
      return;
    }

    await vault.modify(file, lines.join('\n'));
    await this.reloadDataAndRender();
  }

  beginInlineEditTitle(card, titleDiv, task) {
    const currentTitle = titleDiv.getText();

    titleDiv.empty();
    const input = titleDiv.createEl('input', {
      type: 'text',
      value: currentTitle
    });
    input.addClass('kinetic-s3-card-title-input');

    // Prevent clicks inside the input from bubbling up to the card.
    input.onclick = (ev) => {
      ev.stopPropagation();
    };
    input.onmousedown = (ev) => {
      ev.stopPropagation();
    };

    const finish = async (commit) => {
      const value = input.value.trim();
      if (commit && value && value !== currentTitle) {
        await this.renameTaskTitle(task.id, value);
        return; // reloadDataAndRender will be called from renameTaskTitle
      }

      // Cancel or no change: restore original title text
      titleDiv.empty();
      titleDiv.setText(currentTitle);
    };

    input.onblur = () => {
      // Commit on blur by default
      finish(true);
    };

    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    };

    input.focus();
    input.setSelectionRange(0, input.value.length);
  }


  // ---------- PROJECT DASHBOARD RENDERING ----------

  renderProjectDashboard(root) {
    const collapsed = new Set(this.plugin.settings.collapsedProjects || []);

    const projectIds = Object.keys(this.groups).sort((a, b) => {
      if (a === 'No Project') return 1;
      if (b === 'No Project') return -1;
      const na = parseInt(a.replace('P', ''), 10);
      const nb = parseInt(b.replace('P', ''), 10);
      if (isNaN(na) || isNaN(nb)) return a.localeCompare(b);
      return na - nb;
    });

    for (const pid of projectIds) {
      const tasks = this.groups[pid] || [];
      const section = root.createDiv('kinetic-project-group');
      section.setAttr('data-project-id', pid);

      const header = section.createDiv('kinetic-project-group-header');
      const count = tasks.length;
      const isCollapsed = collapsed.has(pid);
      const chevron = isCollapsed ? '▶' : '▼';
      const label = pid === 'No Project' ? 'No Project' : `Project ${pid}`;
      header.setText(`${chevron} ${label} (${count})`);

      header.onclick = async () => {
        const set = new Set(this.plugin.settings.collapsedProjects || []);
        if (set.has(pid)) set.delete(pid);
        else set.add(pid);
        this.plugin.settings.collapsedProjects = Array.from(set);
        await this.plugin.saveSettings();
        this.renderContent();
      };

      const body = section.createDiv('kinetic-project-group-body');
      body.setAttr('data-drop-target', 'true');
      body.ondragover = (ev) => {
        ev.preventDefault();
        body.addClass('kinetic-project-drop-hover');
      };
      body.ondragleave = () => {
        body.removeClass('kinetic-project-drop-hover');
      };
      body.ondrop = async (ev) => {
        ev.preventDefault();
        body.removeClass('kinetic-project-drop-hover');
        const taskId = ev.dataTransfer.getData('text/plain');
        if (!taskId) return;
        await this.moveTaskToProject(taskId, pid);
      };

      if (isCollapsed) {
        continue;
      }

      for (const t of tasks) {
        const card = body.createDiv('kinetic-project-card');
        card.setAttr('draggable', 'true');
        card.setAttr('data-task-id', t.id);

        card.ondragstart = (ev) => {
          ev.dataTransfer.setData('text/plain', t.id);
        };

        card.onclick = async () => {
          await openTaskInEditor(this.plugin, t.id);
        };

        const parsed = parseHeaderForDisplay(t.headerLine);
        const titleText =
          parsed.title || t.headerLine.replace(/^-\s\[[ xX]\]\s+/, '');

        const titleDiv = card.createDiv('kinetic-project-card-title');
        titleDiv.setText(titleText);

        if (this.plugin.settings.showCardMetadata) {
          const metaTop = card.createDiv('kinetic-project-card-meta-top');
          const tags = [...parsed.tags, ...parsed.mentions];
          if (tags.length) metaTop.setText(tags.join(' '));

          if (parsed.due) {
            const metaBottom = card.createDiv('kinetic-project-card-meta-bottom');
            metaBottom.setText(parsed.due);
          }
        }

        const idDiv = card.createDiv('kinetic-project-card-id');
        idDiv.setText(t.id);
      }
    }
  }

  async moveTaskToProject(taskId, newProjectId) {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
    if (!(file instanceof TFile)) {
      new Notice(`Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
      return;
    }

    const content = await vault.read(file);
    const lines = content.split('\n');

    let startIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isTopLevelOpenTaskHeader(line)) continue;
      const m = line.match(TASK_ID_REGEX);
      if (!m) continue;
      const id = `t${m[1]}`;
      if (id === taskId) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) {
      new Notice(`Task ${taskId} not found in ledger`);
      return;
    }

    const block = getTaskBlock(lines, startIndex);
    if (block.length === 0) {
      new Notice(`Task block for ${taskId} is empty`);
      return;
    }

    let header = block[0];
    header = stripProjectTagsFromLine(header);
    if (newProjectId !== 'No Project') {
      header = addProjectTagToLine(header, newProjectId);
    }
    block[0] = header;

    lines.splice(startIndex, block.length, ...block);
    await vault.modify(file, lines.join('\n'));
    await this.reloadDataAndRender();
  }
}

// ---------- CANONICAL TASK SYNC + PROJECTS REBUILD ----------

async function buildCanonicalTasksFromLedger(app) {
  const vault = app.vault;
  const file = app.vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
  if (!(file instanceof TFile)) {
    new Notice(`Kinetic: Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
    return new Map();
  }

  const text = await app.vault.read(file);
  const lines = text.split('\n');
  const canonical = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(/\^(t\d+)\^/);
    if (!idMatch) continue;

    const taskId = idMatch[1];
    const block = getTaskBlock(lines, i);
    if (block && block.length > 0) {
      canonical.set(taskId, block);
    }
  }

  return canonical;
}

async function buildShadowIndexAcrossVault(plugin, skipPath) {
  const vault = plugin.app.vault;
  const files = vault.getMarkdownFiles();
  const shadowIndex = new Map();

  for (const file of files) {
    if (file.path === TASKS_LEDGER_PATH) continue;
    if (skipPath && file.path === skipPath) continue;

    const text = await vault.read(file);
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idMatch = line.match(/\^(t\d+)\^/);
      if (!idMatch) continue;

      const taskId = idMatch[1];
      const block = getTaskBlock(lines, i);
      if (!block || block.length === 0) continue;

      const endIndex = i + block.length;

      if (!shadowIndex.has(taskId)) {
        shadowIndex.set(taskId, []);
      }
      shadowIndex.get(taskId).push({
        file,
        start: i,
        end: endIndex
      });
    }
  }

  return shadowIndex;
}

async function syncTasksFromLedgerIntoVault(plugin, skipPath) {
  const app = plugin.app;
  const vault = app.vault;

  const canonical = await buildCanonicalTasksFromLedger(app);
  if (!canonical || canonical.size === 0) {
    new Notice('Kinetic: No canonical tasks found in ledger to sync.');
    return;
  }

  const shadowIndex = await buildShadowIndexAcrossVault(plugin, skipPath);

  let touchedFiles = 0;
  const perFileEdits = new Map();
  for (const [taskId, shadows] of shadowIndex.entries()) {
    const block = canonical.get(taskId);
    if (!block) continue;

    for (const shadow of shadows) {
      const key = shadow.file.path;
      if (!perFileEdits.has(key)) {
        perFileEdits.set(key, { file: shadow.file, ranges: [] });
      }
      perFileEdits.get(key).ranges.push({
        taskId,
        start: shadow.start,
        end: shadow.end,
        block
      });
    }
  }

  for (const { file, ranges } of perFileEdits.values()) {
    ranges.sort((a, b) => b.start - a.start);

    const text = await vault.read(file);
    const lines = text.split('\n');

    for (const r of ranges) {
      const before = lines.slice(0, r.start);
      const after = lines.slice(r.end);
      lines.splice(0, lines.length, ...before, ...r.block, ...after);
    }

    await vault.modify(file, lines.join('\n'));
    touchedFiles++;
  }

  if (touchedFiles === 0) {
    new Notice('Kinetic: No shadow task blocks found to sync.');
  } else {
    new Notice(`Kinetic: Synced tasks into ${touchedFiles} file(s) from ledger.`);
  }
}

// Promote tasks from a given file into the ledger
async function promoteFileTasksToLedger(plugin, file) {
  const app = plugin.app;
  const ledgerFile = app.vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
  if (!(ledgerFile instanceof TFile)) {
    console.warn(
      `Kinetic: Tasks ledger not found at ${TASKS_LEDGER_PATH} while promoting from ${file.path}`
    );
    return;
  }

  const [ledgerText, fileText] = await Promise.all([
    app.vault.read(ledgerFile),
    app.vault.read(file)
  ]);

  const ledgerLines = ledgerText.split('\n');
  const fileLines = fileText.split('\n');

  const updatedBlocksById = {};
  const idsInFile = new Set();

  // Collect updated blocks from the edited file, keyed by task ID.
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    if (!line.includes('^t')) continue;
    // Skip lines that begin with a backtick (likely within a code block).
    const trimmedForTask = line.trimStart();
    if (trimmedForTask.startsWith('`')) continue;
    const m = line.match(TASK_ID_REGEX);
    if (!m) continue;
    const id = `t${m[1]}`;
    let block = getTaskBlock(fileLines, i);
    if (!block.length) continue;

    // Trim trailing blank lines from the block so we don't spray random whitespace
    while (block.length > 0 && block[block.length - 1].trim() === '') {
      block.pop();
    }
    if (!block.length) continue;

    updatedBlocksById[id] = block;
    idsInFile.add(id);
    i += block.length - 1;
  }

  if (idsInFile.size === 0) {
    return;
  }

  const newLedgerLines = [];
  const idsSeenInLedger = new Set();

  for (let i = 0; i < ledgerLines.length; i++) {
    const line = ledgerLines[i];
    // Non-task lines are copied verbatim. Also ignore lines that begin
    // with a backtick (likely a code-block or inline code) so that
    // accidental "^t" within code doesn't trigger task processing.
    if (!line.includes('^t')) {
      newLedgerLines.push(line);
      continue;
    }
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith('`')) {
      newLedgerLines.push(line);
      continue;
    }
    // Try to match a task ID on this line.
    const match = line.match(TASK_ID_REGEX);
    if (!match) {
      newLedgerLines.push(line);
      continue;
    }
    const id = `t${match[1]}`;
    const replacementBlock = updatedBlocksById[id];
    if (!replacementBlock) {
      // Existing block in ledger; copy or skip duplicates.
      if (idsSeenInLedger.has(id)) {
        // Skip this duplicate block entirely by advancing i.
        const block = getTaskBlock(ledgerLines, i);
        if (block.length) {
          i += block.length - 1;
        }
        continue;
      }
      // First time seeing this ID; copy the existing block and dedupe subtasks.
      idsSeenInLedger.add(id);
      const block = getTaskBlock(ledgerLines, i);
      if (block.length) {
        const deduped = dedupeTaskBlock(block);
        newLedgerLines.push(...deduped);
        i += block.length - 1;
      } else {
        newLedgerLines.push(line);
      }
    } else {
      // Replacement provided by the edited file; merge with existing ledger block.
      idsSeenInLedger.add(id);
      const oldBlock = getTaskBlock(ledgerLines, i);
      let finalBlock = replacementBlock;
      if (oldBlock.length && oldBlock[0]) {
        const oldHeader = oldBlock[0];
        const incomingHeader = replacementBlock[0];
        const ledgerChecked = isTaskHeaderChecked(oldHeader);
        const fileChecked = isTaskHeaderChecked(incomingHeader);
        // Merge derived tags (S3, project) from ledger into incoming header
        let mergedHeader = mergeDerivedTagsFromLedger(oldHeader, incomingHeader);
        // If either copy thinks the parent is done, treat it as done
        if (ledgerChecked || fileChecked) {
          mergedHeader = mergedHeader.replace(/^(\s*)-\s\[[ xX]\]/, '$1- [x]');
        }
        const mergedBlock = [mergedHeader];
        const maxLen = Math.max(oldBlock.length, replacementBlock.length);
        for (let j = 1; j < maxLen; j++) {
          const ledgerLine = j < oldBlock.length ? oldBlock[j] : '';
          const fileLine = j < replacementBlock.length ? replacementBlock[j] : '';
          if (!ledgerLine && !fileLine) continue;
          const bulletRe = /^\s*-\s\[([ xX])\]\s*(.*)$/;
          const ledgerMatch = ledgerLine.match(bulletRe);
          const fileMatch = fileLine.match(bulletRe);
          if (ledgerMatch && fileMatch) {
            const indentLedger = ledgerLine.match(/^\s*/);
            const indentFile = fileLine.match(/^\s*/);
            const indent = (indentFile ? indentFile[0] : '') || (indentLedger ? indentLedger[0] : '');
            const ledgerCheckedSub = ledgerMatch[1].toLowerCase() === 'x';
            const fileCheckedSub = fileMatch[1].toLowerCase() === 'x';
            const ledgerText = ledgerMatch[2].trim();
            const fileText = fileMatch[2].trim();
            if (ledgerText === fileText) {
              const checked = ledgerCheckedSub || fileCheckedSub;
              const box = checked ? 'x' : ' ';
              mergedBlock.push(`${indent}- [${box}] ${fileText}`);
              continue;
            }
          }
          // Default: prefer the file's version when present; otherwise use ledger's
          mergedBlock.push(fileLine || ledgerLine);
        }
        finalBlock = dedupeTaskBlock(mergedBlock);
      }
      newLedgerLines.push(...finalBlock);
      if (oldBlock.length) {
        i += oldBlock.length - 1;
      }
    }
  }

  // Append any new IDs not yet in the ledger (no extra blank lines injected).
  // Deduplicate their subtask lines as a precaution.
  for (const id of idsInFile) {
    if (idsSeenInLedger.has(id)) continue;
    let block = updatedBlocksById[id];
    if (!block || !block.length) continue;
    block = dedupeTaskBlock(block);
    newLedgerLines.push(...block);
  }

  const newLedgerText = newLedgerLines.join('\n');
  if (newLedgerText !== ledgerText) {
    await app.vault.modify(ledgerFile, newLedgerText);
  }
}

// Rebuild ONLY the "# Existing Projects" section in Projects.md from the ledger
async function rebuildExistingProjectsSectionFromLedger(plugin) {
  const app = plugin.app;
  const vault = app.vault;

  const projectsFile = vault.getAbstractFileByPath(PROJECTS_FILE_PATH);
  if (!(projectsFile instanceof TFile)) {
    return;
  }

  const ledgerFile = vault.getAbstractFileByPath(TASKS_LEDGER_PATH);
  if (!(ledgerFile instanceof TFile)) {
    new Notice(`Kinetic: Tasks ledger not found at ${TASKS_LEDGER_PATH}`);
    return;
  }

  const projectsText = await vault.read(projectsFile);
  const projectsLines = projectsText.split('\n');

  const existingIndex = projectsLines.findIndex(
    (line) => line.trim() === '# Existing Projects'
  );
  if (existingIndex === -1) {
    return;
  }

  const projectIndex = new Map();
  for (const line of projectsLines) {
    const rowMatch = line.match(/^\|\s*(P\d+)\s*\|\s*([^|]+)\s*\|/);
    if (rowMatch) {
      const pid = rowMatch[1];
      const name = rowMatch[2].trim();
      projectIndex.set(pid, name);
    }
  }

  const ledgerText = await vault.read(ledgerFile);
  const ledgerLines = ledgerText.split('\n');

  const tasksByProject = new Map();

  for (let i = 0; i < ledgerLines.length; i++) {
    const line = ledgerLines[i];
    const idMatch = line.match(/\^(t\d+)\^/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    const projectTagMatch = line.match(/#(P\d+)/);
    if (!projectTagMatch) continue;
    const pid = projectTagMatch[1];

    const block = getTaskBlock(ledgerLines, i);
    if (!block || block.length === 0) continue;

    if (!tasksByProject.has(pid)) {
      tasksByProject.set(pid, new Map());
    }
    const mapForPid = tasksByProject.get(pid);

    if (!mapForPid.has(taskId)) {
      mapForPid.set(taskId, block);
    }

    i += block.length - 1;
  }

  const newSectionLines = [];
  newSectionLines.push('# Existing Projects', '');

  for (const [pid, projectName] of projectIndex.entries()) {
    const byId = tasksByProject.get(pid);
    if (!byId || byId.size === 0) continue;

    const blocks = Array.from(byId.values());

    newSectionLines.push(`## 📁 ${projectName} (${pid})`, '');
    newSectionLines.push(
      `**Summary:** ${blocks.length} open task${blocks.length !== 1 ? 's' : ''}`,
      ''
    );

    for (const block of blocks) {
      const trimmed = [...block];
      while (
        trimmed.length > 0 &&
        trimmed[trimmed.length - 1].trim() === ''
      ) {
        trimmed.pop();
      }

      newSectionLines.push(...trimmed);
      newSectionLines.push('');
    }
  }

  if (newSectionLines.length === 2) {
    newSectionLines.push('_No active project tasks found in ledger._', '');
  }

  while (
    newSectionLines.length > 0 &&
    newSectionLines[newSectionLines.length - 1].trim() === ''
  ) {
    newSectionLines.pop();
  }
  newSectionLines.push('');

  const updatedLines = [
    ...projectsLines.slice(0, existingIndex),
    ...newSectionLines
  ];

  await vault.modify(projectsFile, updatedLines.join('\n'));
  new Notice('Kinetic: Existing Projects section updated from ledger.');
}

// ---------- MAIN PLUGIN ----------

module.exports = class KineticSuitePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.isSyncing = false;

    setTimeout(() => {
      this.registerDelayedSyncHandler();
    }, 750);

    this.registerView(
      BOARD_VIEW_TYPE,
      (leaf) => new KineticBoardView(leaf, this)
    );

    this.addCommand({
      id: 'kinetic-open-board',
      name: 'Kinetic: Open Board (S3 / Projects)',
      callback: async () => {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: BOARD_VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
      }
    });

    this.addCommand({
      id: 'kinetic-apply-header-rules-to-file',
      name: 'Kinetic: Apply Header Rules to This File',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !(activeFile instanceof TFile)) {
          new Notice('Kinetic: No active file to apply header rules to.');
          return;
        }
        await applyHeaderRulesToFile(this, activeFile);
      }
    });

    this.addCommand({
      id: 'kinetic-full-sync',
      name: 'Kinetic: Full Sync (Projects + Canonical)',
      callback: async () => {
        await this.runFullSync();
      }
    });

    this.addSettingTab(new KineticSuiteSettingTab(this.app, this));

    this.registerVaultHooks();

    if (this.settings.autoFullSyncOnLoad) {
      await this.runFullSync();
    }
  }

  async onunload() {
    this.app.workspace
      .getLeavesOfType(BOARD_VIEW_TYPE)
      .forEach((leaf) => leaf.detach());
  }

  registerVaultHooks() {
    if (!this.settings.autoFullSyncOnLedgerSave) return;
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (!(file instanceof TFile)) return;
        if (file.path !== TASKS_LEDGER_PATH) return;
        await this.runFullSync();
      })
    );
  }

  registerDelayedSyncHandler() {
    if (!this._debounceTimers) {
      this._debounceTimers = new Map();
    }
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.isSyncing) return;
        if (!(file instanceof TFile)) return;
        if (!file.path.toLowerCase().endsWith('.md')) return;
        if (file.path === TASKS_LEDGER_PATH) return;
        this.app.vault
          .read(file)
          .then((text) => {
            if (!/-\s*\[\s*\]/.test(text)) return;
            const existing = this._debounceTimers.get(file.path);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(async () => {
              this._debounceTimers.delete(file.path);
              await this.processModifiedFile(file);
            }, 1000);
            this._debounceTimers.set(file.path, timer);
          })
          .catch((e) => {
            console.error(
              'Kinetic: failed to schedule sync for file',
              file.path,
              e
            );
          });
      })
    );
  }

  async processModifiedFile(file) {
    try {
      if (file.path === TASKS_LEDGER_PATH) return;
      if (this.isSyncing) return;
      this.isSyncing = true;

      let text = await this.app.vault.read(file);

      const assignResult = await assignIdsToNewTasks(this, file, text);
      if (assignResult.changed) {
        await this.app.vault.modify(file, assignResult.text);
        text = assignResult.text;
      }

      if (/\^t\d+\^/.test(text)) {
        // Simplified auto-pipeline:
        // 1) Promote the file's tasks into the ledger (preserving derived tags).
        // 2) Sync canonical ledger blocks out to the rest of the vault,
        //    but DO NOT rewrite the file we are currently editing.
        await promoteFileTasksToLedger(this, file);
        await syncTasksFromLedgerIntoVault(this, file.path);
      }
    } catch (e) {
      console.error('Kinetic: processModifiedFile failed', e);
    } finally {
      this.isSyncing = false;
    }
  }

  async runFullSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      new Notice('Kinetic: Full Sync started…');

      const files = this.app.vault.getMarkdownFiles();
      for (const file of files) {
        if (file.path === TASKS_LEDGER_PATH) continue;
        await promoteFileTasksToLedger(this, file);
      }

      await rebuildExistingProjectsSectionFromLedger(this);
      await syncTasksFromLedgerIntoVault(this, null);

      new Notice('Kinetic: Full Sync completed.');
    } catch (e) {
      console.error('Kinetic: Full Sync failed', e);
      new Notice('Kinetic: Full Sync failed – see console for details.');
    } finally {
      this.isSyncing = false;
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
