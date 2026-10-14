// Paramètres par utilisateur, stockés uniquement dans le localStorage de son navigateur.
const KEY = 'jira-modern.settings.v1';
const SCHEMA = 2;

const F = 'filter = 10100';
const OPEN_STATUSES = '"Ask for reopening", Escalated, "In progress", "In Progress", "In progress by support", "Is Running", "Material Recovery", "On Going Requester", Open, Pending, Reopened, "To Acknowledge", "To Do", "Waiting for approval", "Waiting for customer", "Waiting for Manager", "Waiting for Price Estimation", "Waiting for support", "Waiting for user validation", "Work in progress"';

// Reproduit exactement les requêtes des gadgets du dashboard Jira « CDS TEAM-IT » (filtre 10100).
export const DEFAULT_KPIS = [
  { group: 'tickets', label: 'VIP', tone: 'red', jql: `${F} AND created >= "2024-01-01" AND "VIP[Dropdown]" != Oui AND reporter IN membersOf("Support_VIP")` },
  { group: 'tickets', label: 'Total', tone: 'blue', jql: F },
  { group: 'tickets', label: 'Bloquant', tone: 'red', jql: `${F} AND priority = "P1 - Blocker"` },
  { group: 'tickets', label: 'Majeur', tone: 'orange', jql: `${F} AND priority = "P2 - Major"` },
  { group: 'tickets', label: 'Medium', tone: 'yellow', jql: `${F} AND priority = "P3 - Medium"` },
  { group: 'tickets', label: 'Faible', tone: 'green', jql: `${F} AND priority = "P4 - Low"` },
  { group: 'tickets', label: 'Arrivée de perso', tone: 'blue', jql: `${F} AND project in (ITS, ITC) AND summary ~ "the following person" AND status in (${OPEN_STATUSES}) AND assignee in (membersOf(CDS_Reporting))` },
  { group: 'sla', label: 'À prendre en charge', tone: 'blue', jql: `${F} AND project in (ITS) AND status in (open, "to acknowledge")` },
  { group: 'sla', label: 'GTI · en pause ou bientôt expirée', tone: 'orange', jql: `${F} AND project in (ITS) AND "Time to First Response" > remaining("15m") AND assignee in (membersOf(CDS_Reporting)) AND status not in (Closed, Done, Resolved, Résolu)` },
  { group: 'sla', label: 'GTR · en pause ou bientôt expirée', tone: 'orange', jql: `${F} AND (project in (ITS) AND "Time to resolution" > remaining("15m") AND assignee in (membersOf(CDS_Reporting)) OR assignee in (712020:1f2a8c6f-5760-429b-aa7c-ce5e989bdc69) AND status not in (Closed, Done, Resolved, Résolu))` },
];

export const DEFAULTS = {
  schema: SCHEMA,
  jiraUrl: 'https://moongy.atlassian.net',
  jiraEmail: '',
  jiraToken: '',
  theme: 'system', // 'system' | 'light' | 'dark'
  aiMode: 'code', // 'code' = Claude Code local, 'api' = clé API Anthropic
  allowWrite: false,
  claudeKey: '',
  claudeModel: 'claude-sonnet-5-5',
  openaiKey: '',
  openaiModel: 'gpt-4o',
  geminiKey: '',
  geminiModel: 'gemini-2.0-flash',
  filterId: '10100',
  baseJql: 'filter = 10100 ORDER BY updated DESC',
  plannedFieldId: 'customfield_10546',
  // Documentation (Confluence) : page racine « Gestion des incidents »
  docRootPageId: '1886748707',
  docSpace: 'ITG',
  autoDoc: true, // ouvre automatiquement la doc recommandée à l'ouverture d'un ticket
  // Tickets « à prendre en charge » surveillés pour les notifications
  todoJql: `${F} AND project in (ITS) AND status in (open, "to acknowledge")`,
  notif: { enabled: true, interval: 60, sound: false, types: { new: true, assigned: true, updated: true } },
  kpis: DEFAULT_KPIS,
};

// Fournisseurs d'IA : chacun branche le sien.
export const PROVIDERS = {
  code: { label: 'Claude Code', short: 'Claude Code', key: null },
  api: { label: 'Claude (clé API Anthropic)', short: 'Claude API', key: 'claudeKey' },
  openai: { label: 'ChatGPT (clé API OpenAI)', short: 'ChatGPT', key: 'openaiKey' },
  gemini: { label: 'Gemini (clé API Google)', short: 'Gemini', key: 'geminiKey' },
};

// Le fournisseur choisi est-il utilisable ? (Claude Code n'a pas besoin de clé)
export const aiConfigured = (s) => {
  const p = PROVIDERS[s.aiMode] || PROVIDERS.code;
  return p.key ? !!s[p.key] : true;
};

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    const merged = { ...DEFAULTS, ...stored };
    // Migration : anciennes versions → on garde les clés, on remplace les requêtes du dashboard.
    if ((stored.schema || 1) < SCHEMA) {
      merged.schema = SCHEMA;
      merged.kpis = DEFAULT_KPIS;
      merged.baseJql = DEFAULTS.baseJql;
      merged.aiMode = stored.claudeKey ? 'api' : 'code';
    }
    merged.notif = { ...DEFAULTS.notif, ...(stored.notif || {}), types: { ...DEFAULTS.notif.types, ...(stored.notif?.types || {}) } };
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}
