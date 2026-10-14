// Thème clair / sombre / système. Le choix est appliqué sur <html data-theme="…"> (absent = système).
export const THEMES = [
  ['system', 'Système'],
  ['light', 'Clair'],
  ['dark', 'Sombre'],
];

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}
