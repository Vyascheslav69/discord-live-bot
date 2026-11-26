// Log em arquivo para entender erros em outros computadores.
// Windows: %APPDATA%\laele viewer\logs   Mac: ~/Library/Logs/laele viewer   Linux: ~/.config/laele viewer/logs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SIZE = 1024 * 1024; // passou disso, o log atual vira .old e começa outro

const dir = app.getPath('logs');
const file = path.join(dir, 'laele-viewer.log');

function rotate() {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > MAX_SIZE) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
  } catch {
    // sem log não é motivo para o app não abrir
  }
}

const format = (part) => {
  if (part instanceof Error) return part.stack ?? part.message;
  return typeof part === 'string' ? part : JSON.stringify(part);
};

function log(level, ...parts) {
  const line = `${new Date().toISOString()} [${level}] ${parts.map(format).join(' ')}\n`;
  try {
    fs.appendFileSync(file, line);
  } catch {
    // disco cheio ou sem permissão: ignora
  }
  if (level === 'erro') console.error(line.trimEnd());
}

rotate();
log('info', `--- laele viewer ${app.getVersion()} | ${process.platform} ${os.release()} ${process.arch} | Electron ${process.versions.electron}`);

module.exports = { log, file, dir };
