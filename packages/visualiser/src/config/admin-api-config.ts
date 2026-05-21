/**
 * Admin HTTP API URL persistence. Mirrors `broker-config`: each install
 * stores its preferred base URL in localStorage so reloads survive.
 */

const STORAGE_KEY = 'trainframe.visualiser.adminApiUrl';
export const DEFAULT_ADMIN_API_URL = 'http://127.0.0.1:3000';

export function loadAdminApiUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ADMIN_API_URL;
  } catch {
    return DEFAULT_ADMIN_API_URL;
  }
}

export function saveAdminApiUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url);
}
