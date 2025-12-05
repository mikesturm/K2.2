const { Plugin, ItemView, TFile, Notice } = require('obsidian');

// Configuration
const S3_TAGS = ['today', 'asap', 'tomorrow', 'nextfewdays', 'week', 'month', 'later'];
const TASK_ID_REGEX = /\^t(\d+)\^/g;
const TIMESTAMP_REGEX = /TS(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;

// Helper: Get task block including subtasks
function getTaskBlock(lines, startIndex) {
  const block = [];
  if (startIndex < 0 || startIndex >= lines.length) return block;
  
  const headerLine = lines[startIndex];
  block.push(headerLine);
  
  const headerIndent = (headerLine.match(/^\s*/) || [''])[0].length;
  
  for (let j = startIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim().length === 0) {
      block.push(line);
      continue;
    }
    
    const indent = (line.match(/^\s*/) || [''])[0].length;
    if (indent <= headerIndent) break;
    
    block.push(line);
  }
  
  return block;
}

// Task class
class Task {
  constructor(id, block, file, lineStart, timestamp = null) {
    this.id = id;
    this.block = block;
    this.file = file;
    this.lineStart = lineStart;
    this.timestamp = timestamp || new Date(0);
    
    // Parse tags from header
    const header = block[0].toLowerCase();
    this.s3Tag = S3_TAGS.find(tag => header.includes('#' + tag)) || null;
    
    const projMatch = block[0].match(/#P(\d+)/i);
    this.projectId = projMatch ? 'P' + projMatch[1] : null;
    
    this.isCompleted = /^\s*-\s\[x\]/i.test(block[0]);
  }
  
  updateTimestamp() {
    this.timestamp = new Date();
    const token = ' TS' + this.timestamp.toISOString().slice(0, 19);
    
    // Remove old timestamp if exists
    let header = this.block[0].replace(/\s*TS\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '');
    
    // Add new timestamp after the task ID
    header = header.replace(/(\^t\d+\^)/, '$1' + token);
    
    this.block[0] = header.replace(/\s+/g, ' ').trim();
  }
  
  setS3Tag(newTag) {
    let header = this.block[0];
    
    // Remove all S3 tags
    S3_TAGS.forEach(tag => {
      const regex = new RegExp('#' + tag + '\\b', 'gi');
      header = header.replace(regex, '');
    });
    
    // Add new tag if not 'none'
    if (newTag && newTag !== 'none') {
      header = header + ' #' + newTag;
    }
    
    this.block[0] = header.replace(/\s+/g, ' ').trim();
    this.s3Tag = newTag;
    this.updateTimestamp();
  }
  
  updateTitle(newTitle) {
    const match = this.block[0].match(/^(\s*-\s\[[ xX]\]\s+\^t\d+\^\s+)(.+)$/);
    if (!match) return;
    
    const prefix = match[1];
    const rest = match[2];
    
    // Preserve all tags/metadata
    const tokens = rest.split(/\s+/);
    const metaTokens = tokens.filter(t => 
      t.startsWith('#') || t.startsWith('@') || t.startsWith('TS')
    );
    
    this.block[0] = (prefix + newTitle + ' ' + metaTokens.join(' ')).replace(/\s+/g, ' ').trim();
    this.updateTimestamp();
  }
}

// Task Index
class TaskIndex {
  constructor(app) {
    this.app = app;
    this.tasks = new Map();
  }
  
  async rebuild(excludeFile = null) {
    this.tasks.clear();
    const files = this.app.vault.getMarkdownFiles();
    
    for (const file of files) {
      if (excludeFile && file.path === excludeFile.path) continue;
      await this.indexFile(file);
    }
  }
  
  async indexFile(file) {
    const text = await this.app.vault.read(file);
    const lines = text.split('\n');
    
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      
      if (!/^\s*-\s\[[ xX]\]/.test(line) || !line.includes('^t')) {
        i++;
        continue;
      }
      
      const idMatch = line.match(/\^t(\d+)\^/);
      if (!idMatch) {
        i++;
        continue;
      }
      
      const id = 't' + idMatch[1];
      const block = getTaskBlock(lines, i);
      
      // Extract timestamp
      const tsMatch = block[0].match(TIMESTAMP_REGEX);
      const timestamp = tsMatch ? new Date(tsMatch[1]) : new Date(0);
      
      const task = new Task(id, block, file, i, timestamp);
      
      // Keep newest version only
      const existing = this.tasks.get(id);
      if (!existing || task.timestamp > existing.timestamp) {
        this.tasks.set(id, task);
      }
      
      i += block.length;
    }
  }
  
  async syncTask(task) {
    const files = this.app.vault.getMarkdownFiles();
    
    for (const file of files) {
      const text = await this.app.vault.read(file);
      const lines = text.split('\n');
      let modified = false;
      
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        
        if (!line.includes('^' + task.id + '^')) {
          i++;
          continue;
        }
        
        const block = getTaskBlock(lines, i);
        const localTask = new Task(task.id, block, file, i);
        
        // Update if stale
        if (localTask.timestamp < task.timestamp) {
          lines.splice(i, block.length, ...task.block);
          modified = true;
        }
        
        i += block.length;
      }
      
      if (modified) {
        await this.app.vault.modify(file, lines.join('\n'));
      }
    }
  }
  
  getActiveTasks() {
    return Array.from(this.tasks.values()).filter(t => !t.isCompleted);
  }
  
  getAllTasks() {
    return Array.from(this.tasks.values());
  }
}

// Smart Ledger
class SmartLedger {
  constructor(app, syncEngine) {
    this.app = app;
    this.syncEngine = syncEngine;
    this.ledgerPath = 'Kinetic-Ledger.md';
    this.s3ViewPath = 'S3-View.md';
  }
  
  async rebuildLedger() {
    await this.syncEngine.index.rebuild();
    
    const content = [];
    
    content.push('# Kinetic Task Ledger');
    content.push('');
    content.push('**Generated:** ' + new Date().toISOString());
    content.push('**Total Active Tasks:** ' + this.syncEngine.index.getActiveTasks().length);
    content.push('');
    content.push('---');
    content.push('');
    
    content.push('## System Overview');
    content.push('');
    content.push(this.generateSystemOverview());
    content.push('');
    
    content.push('## Tasks by Priority (S3)');
    content.push('');
    content.push(this.generateS3View());
    content.push('');
    
    content.push('## Tasks by Project');
    content.push('');
    content.push(this.generateProjectView());
    content.push('');
    
    content.push('## Complete Task List');
    content.push('');
    content.push(this.generateCompleteList());
    content.push('');
    
    const ledgerFile = this.app.vault.getAbstractFileByPath(this.ledgerPath);
    const finalContent = content.join('\n');
    
    if (ledgerFile) {
      await this.app.vault.modify(ledgerFile, finalContent);
    } else {
      await this.app.vault.create(this.ledgerPath, finalContent);
    }
    
    new Notice('Ledger updated: ' + this.syncEngine.index.getActiveTasks().length + ' active tasks');
  }
  
  async rebuildS3View() {
    await this.syncEngine.index.rebuild();
    
    // Get ALL tasks (including completed ones) to preserve them during rebuild
    const allTasks = this.syncEngine.index.getAllTasks();
    const activeTasks = this.syncEngine.index.getActiveTasks();
    
    const content = [];
    content.push('# S3 Priority View');
    content.push('');
    content.push('> **Editable View:** Move tasks between headers to change their S3 tags.');
    content.push('> Changes sync automatically after 2 seconds.');
    content.push('');
    content.push('---');
    content.push('');
    
    // Create sections for each S3 tag
    for (const tag of S3_TAGS) {
      const tagTasks = allTasks.filter(t => t.s3Tag === tag);
      
      content.push('## ' + tag + ' (' + activeTasks.filter(t => t.s3Tag === tag).length + ')');
      content.push('');
      
      if (tagTasks.length === 0) {
        content.push('*No tasks*');
        content.push('');
      } else {
        tagTasks.forEach(task => {
          // Only include the header line, not subtasks
          content.push(task.block[0]);
        });
        content.push('');
      }
    }
    
    // Unscheduled section
    const noTagTasks = allTasks.filter(t => !t.s3Tag);
    content.push('## Unscheduled (' + activeTasks.filter(t => !t.s3Tag).length + ')');
    content.push('');
    
    if (noTagTasks.length === 0) {
      content.push('*No tasks*');
      content.push('');
    } else {
      noTagTasks.forEach(task => {
        content.push(task.block[0]);
      });
      content.push('');
    }
    
    const s3File = this.app.vault.getAbstractFileByPath(this.s3ViewPath);
    const finalContent = content.join('\n');
    
    if (s3File) {
      await this.app.vault.modify(s3File, finalContent);
    } else {
      await this.app.vault.create(this.s3ViewPath, finalContent);
    }
    
    new Notice('S3 View updated: ' + activeTasks.length + ' active tasks');
  }
  
  generateSystemOverview() {
    const tasks = this.syncEngine.index.getActiveTasks();
    
    const s3Counts = {};
    S3_TAGS.forEach(tag => s3Counts[tag] = 0);
    s3Counts.none = 0;
    
    tasks.forEach(t => {
      const key = t.s3Tag || 'none';
      s3Counts[key] = (s3Counts[key] || 0) + 1;
    });
    
    const projectCounts = {};
    tasks.forEach(t => {
      const proj = t.projectId || 'No Project';
      projectCounts[proj] = (projectCounts[proj] || 0) + 1;
    });
    
    const lines = [];
    lines.push('### Priority Distribution');
    lines.push('```');
    lines.push('Today:         ' + (s3Counts.today || 0));
    lines.push('ASAP:          ' + (s3Counts.asap || 0));
    lines.push('Tomorrow:      ' + (s3Counts.tomorrow || 0));
    lines.push('Next Few Days: ' + (s3Counts.nextfewdays || 0));
    lines.push('This Week:     ' + (s3Counts.week || 0));
    lines.push('This Month:    ' + (s3Counts.month || 0));
    lines.push('Later:         ' + (s3Counts.later || 0));
    lines.push('Unscheduled:   ' + (s3Counts.none || 0));
    lines.push('```');
    lines.push('');
    lines.push('### Active Projects');
    lines.push('```');
    Object.entries(projectCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([proj, count]) => {
        lines.push(proj + ': ' + count + ' tasks');
      });
    lines.push('```');
    
    return lines.join('\n');
  }
  
  generateS3View() {
    const tasks = this.syncEngine.index.getActiveTasks();
    const lines = [];
    
    for (const tag of [...S3_TAGS, 'none']) {
      const tagTasks = tasks.filter(t => (t.s3Tag || 'none') === tag);
      if (tagTasks.length === 0) continue;
      
      const label = tag === 'none' ? 'Unscheduled' : '#' + tag;
      lines.push('### ' + label + ' (' + tagTasks.length + ')');
      lines.push('');
      
      tagTasks.forEach(task => {
        lines.push(...task.block);
        lines.push('');
      });
    }
    
    return lines.join('\n');
  }
  
  generateProjectView() {
    const tasks = this.syncEngine.index.getActiveTasks();
    const byProject = {};
    
    tasks.forEach(task => {
      const proj = task.projectId || 'No Project';
      if (!byProject[proj]) byProject[proj] = [];
      byProject[proj].push(task);
    });
    
    const lines = [];
    const sorted = Object.entries(byProject).sort((a, b) => {
      if (a[0] === 'No Project') return 1;
      if (b[0] === 'No Project') return -1;
      return a[0].localeCompare(b[0]);
    });
    
    sorted.forEach(([proj, projTasks]) => {
      lines.push('### ' + proj + ' (' + projTasks.length + ')');
      lines.push('');
      
      projTasks.forEach(task => {
        lines.push(...task.block);
        lines.push('');
      });
    });
    
    return lines.join('\n');
  }
  
  generateCompleteList() {
    const tasks = this.syncEngine.index.getActiveTasks();
    const lines = [];
    
    const sorted = tasks.sort((a, b) => {
      const aNum = parseInt(a.id.slice(1));
      const bNum = parseInt(b.id.slice(1));
      return aNum - bNum;
    });
    
    sorted.forEach(task => {
      lines.push(...task.block);
      lines.push('*Source: ' + task.file.path + '*');
      lines.push('');
    });
    
    return lines.join('\n');
  }
}

// Sync Engine
class SyncEngine {
  constructor(plugin) {
    this.plugin = plugin;
    this.index = new TaskIndex(plugin.app);
    this.ledger = new SmartLedger(plugin.app, this);
    this.isSyncing = false;
    this.pendingFiles = new Set();
    this.syncTimer = null;
  }
  
  scheduleSync(file) {
    if (this.isSyncing) return;
    
    this.pendingFiles.add(file);
    
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.executeSync();
    }, 2000);
  }
  
  async executeSync() {
    if (this.isSyncing) return;
    
    this.isSyncing = true;
    const filesToSync = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    
    try {
      console.log('Kinetic: Syncing ' + filesToSync.length + ' files');
      
      for (const file of filesToSync) {
        await this.syncFile(file);
      }
      
      // Rebuild both ledger and S3 view
      await this.ledger.rebuildLedger();
      await this.ledger.rebuildS3View();
      
      console.log('Kinetic: Sync complete');
    } catch (err) {
      console.error('Kinetic: Sync failed', err);
      new Notice('Kinetic: Sync failed - see console');
    } finally {
      this.isSyncing = false;
    }
  }
  
  async syncFile(file) {
    await this.assignTaskIds(file);
    await this.applyHeaderContexts(file);
    await this.index.indexFile(file);
    
    const text = await this.plugin.app.vault.read(file);
    const taskIds = Array.from(text.matchAll(TASK_ID_REGEX), m => 't' + m[1]);
    
    for (const id of taskIds) {
      const task = this.index.tasks.get(id);
      if (task) {
        await this.index.syncTask(task);
      }
    }
  }
  
  async applyHeaderContexts(file) {
    const text = await this.plugin.app.vault.read(file);
    const lines = text.split('\n');
    
    const contextStack = [{ level: 0, project: null, s3: null }];
    let modified = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Process headers
      const headerMatch = line.match(/^(#+)\s+(.+)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const headerText = headerMatch[2];
        
        // Pop stack to appropriate level
        while (contextStack.length > 0 && contextStack[contextStack.length - 1].level >= level) {
          contextStack.pop();
        }
        
        // Get parent context
        const parent = contextStack[contextStack.length - 1] || { level: 0, project: null, s3: null };
        
        // Extract tags from this header
        const projMatch = headerText.match(/#P(\d+)/i);
        const project = projMatch ? '#P' + projMatch[1] : parent.project;
        
        let s3 = parent.s3;
        for (const tag of S3_TAGS) {
          if (headerText.toLowerCase().includes('#' + tag)) {
            s3 = '#' + tag;
            break;
          }
        }
        
        // Check if header text is just the tag name (like "## today (5)")
        const simpleHeaderMatch = headerText.match(/^(today|asap|tomorrow|nextfewdays|week|month|later)\s*\(/i);
        if (simpleHeaderMatch) {
          s3 = '#' + simpleHeaderMatch[1].toLowerCase();
        }
        
        contextStack.push({ level, project, s3 });
        continue;
      }
      
      // Apply context to tasks
      if (/^\s*-\s\[[ xX]\]/.test(line) && /\^t\d+\^/.test(line)) {
        const block = getTaskBlock(lines, i);
        const context = contextStack[contextStack.length - 1] || { project: null, s3: null };
        
        let header = block[0];
        const original = header;
        
        // Remove ALL existing S3 tags first
        S3_TAGS.forEach(tag => {
          const regex = new RegExp('#' + tag + '\\b', 'gi');
          header = header.replace(regex, '');
        });
        
        // Remove ALL existing project tags
        header = header.replace(/#P\d+/gi, '');
        
        // Apply context tags
        if (context.s3) {
          header = header + ' ' + context.s3;
        }
        
        if (context.project) {
          header = header + ' ' + context.project;
        }
        
        if (header !== original) {
          block[0] = header.replace(/\s+/g, ' ').trim();
          lines.splice(i, block.length, ...block);
          modified = true;
        }
        
        i += block.length - 1;
      }
    }
    
    if (modified) {
      await this.plugin.app.vault.modify(file, lines.join('\n'));
    }
  }
  
  async assignTaskIds(file) {
    const text = await this.plugin.app.vault.read(file);
    const lines = text.split('\n');
    let changed = false;
    
    await this.index.rebuild();
    const existingIds = Array.from(this.index.tasks.keys()).map(id => parseInt(id.slice(1)));
    let nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!/^\s*-\s\[[ ]\]/.test(line)) continue;
      if (/\^t\d+\^/.test(line)) continue;
      
      const contentMatch = line.match(/^\s*-\s\[\s\]\s+(.+)$/);
      if (!contentMatch || contentMatch[1].trim().length < 4) continue;
      
      const idToken = '^t' + nextId + '^';
      lines[i] = line.replace(/^(\s*-\s\[\s\]\s+)/, '$1' + idToken + ' ');
      nextId++;
      changed = true;
    }
    
    if (changed) {
      await this.plugin.app.vault.modify(file, lines.join('\n'));
    }
  }
}

// Main Plugin
module.exports = class KineticPlugin extends Plugin {
  async onload() {
    this.syncEngine = new SyncEngine(this);
    
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith('.md')) return;
        
        this.syncEngine.scheduleSync(file);
      })
    );
    
    this.addCommand({
      id: 'sync-all',
      name: 'Sync All Tasks Now',
      callback: async () => {
        const files = this.app.vault.getMarkdownFiles();
        files.forEach(f => this.syncEngine.scheduleSync(f));
        new Notice('Kinetic: Full sync started');
      }
    });
    
    this.addCommand({
      id: 'rebuild-ledger',
      name: 'Rebuild AI Ledger',
      callback: async () => {
        await this.syncEngine.ledger.rebuildLedger();
      }
    });
    
    this.addCommand({
      id: 'rebuild-s3-view',
      name: 'Rebuild S3 View',
      callback: async () => {
        await this.syncEngine.ledger.rebuildS3View();
      }
    });
    
    this.addRibbonIcon('file-text', 'Rebuild AI Ledger', async () => {
      await this.syncEngine.ledger.rebuildLedger();
    });
    
    this.addRibbonIcon('columns', 'Rebuild S3 View', async () => {
      await this.syncEngine.ledger.rebuildS3View();
    });
  }
  
  async onunload() {
    // Cleanup if needed
  }
};
