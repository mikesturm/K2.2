<%*
/*
  NewProject-Auto.js logic converted into a Templater template
*/

const projectsFile = "Tasks/Projects.md";

// Load file
const file = app.vault.getAbstractFileByPath(projectsFile);
if (!file) { 
  new Notice("❌ Could not find " + projectsFile); 
  return; 
}

let data = await app.vault.read(file);
let lines = data.split("\n");

// Find ID table header
let tableStart = lines.findIndex(l => l.match(/^\| *ID\b/));
if (tableStart === -1) { 
  new Notice("❌ Could not find project table header."); 
  return; 
}

// Find end of table
let idx = tableStart + 1;
let maxIDNum = 0;
while (idx < lines.length && lines[idx].trim().startsWith("|")) {
  const m = lines[idx].match(/\| *P(\d+)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > maxIDNum) maxIDNum = n;
  }
  idx++;
}
const tableEnd = idx;

// New ID
const newIDNum = maxIDNum + 1;
const newID = "P" + newIDNum;

// Prompt for project name
let projName = await tp.system.prompt("Project Name?");
if (!projName) projName = "Untitled Project";

// Insert new table row
const newRow = `| ${newID} | ${projName} | | | |`;
lines.splice(tableEnd, 0, newRow);

// Create project section appended to end of file
const newSection = `

## 📁 ${projName} (${newID})

`;

let updated = lines.join("\n").trimEnd() + newSection + "\n";

// Write back
await app.vault.modify(file, updated);

new Notice(`✅ Created project ${newID}: ${projName}`);
%>
