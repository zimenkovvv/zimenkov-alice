// Долгая память: факты, которые пользователь попросил запомнить голосом.
// Хранятся в JSON-файле: { "id пользователя": ["факт", ...] }
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { config } from './config.js';

const MAX_FACTS = 20;
const MAX_FACT_LENGTH = 200;

const facts = load();

function load() {
  const empty = new Map();
  try {
    const data = JSON.parse(readFileSync(config.memoryFile, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
    return new Map(Object.entries(data).filter(([, list]) => Array.isArray(list)));
  } catch {
    return empty; // файла ещё нет или он битый: начинаем с чистого листа
  }
}

function save() {
  // Пишем во временный файл и переименовываем: так файл не окажется записанным наполовину
  const tmp = `${config.memoryFile}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(facts), null, 2));
    renameSync(tmp, config.memoryFile);
  } catch (error) {
    console.error('✗ Не смог сохранить память:', error.message);
  }
}

export function getFacts(userId) {
  return facts.get(userId) || [];
}

export function remember(userId, fact) {
  fact = fact.slice(0, MAX_FACT_LENGTH);
  const list = getFacts(userId).filter((f) => f !== fact);
  list.push(fact);
  facts.set(userId, list.slice(-MAX_FACTS));
  save();
}

export function forget(userId) {
  facts.delete(userId);
  save();
}
