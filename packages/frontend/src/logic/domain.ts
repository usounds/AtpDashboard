import pslData from '../data/publicSuffixList.json' with { type: 'json' };
import { TLD_LIST } from '../types/tlds.ts';

export const validTldSet = new Set(TLD_LIST.map((t) => t.toLowerCase()));
const pslSet = new Set(pslData);

export function getPublicSuffix(domain: string): string {
  const labels = domain.split('.');
  let match = '';

  for (let i = 0; i < labels.length; i++) {
    const sub = labels.slice(i).join('.');

    // Exception rule
    if (pslSet.has('!' + sub)) {
      return labels.slice(i + 1).join('.');
    }

    // Exact rule
    if (pslSet.has(sub)) {
      if (!match || sub.split('.').length > match.split('.').length) {
        match = sub;
      }
    }

    // Wildcard rule
    const parent = labels.slice(i + 1).join('.');
    if (parent && pslSet.has('*.' + parent)) {
      if (!match || sub.split('.').length > match.split('.').length) {
        match = sub;
      }
    }
  }

  return match || labels[labels.length - 1];
}

const registrantNsidCache = new Map<string, string>();

export function getRegistrantNsid(nsid: string): string {
  const cached = registrantNsidCache.get(nsid);
  if (cached !== undefined) return cached;

  const parts = nsid.split('.');
  const domain = [...parts].reverse().join('.');
  const suffix = getPublicSuffix(domain);
  const suffixParts = suffix.split('.').length;
  const registrantPartsCount = Math.min(parts.length, suffixParts + 1);
  const result = parts.slice(0, registrantPartsCount).join('.');
  registrantNsidCache.set(nsid, result);
  return result;
}

const webDomainCache = new Map<string, string>();

/**
 * Extracts apex web domain from an NSID (e.g., 'com.whtwnd.blog.entry' -> 'whtwnd.com').
 */
export function getWebDomainFromNsid(nsid: string): string {
  const cached = webDomainCache.get(nsid);
  if (cached !== undefined) return cached;

  const registrant = getRegistrantNsid(nsid);
  const result = registrant.split('.').reverse().join('.');
  webDomainCache.set(nsid, result);
  return result;
}

/**
 * Returns Google Favicon service URL for a web domain.
 */
export function getFaviconUrl(domain: string, size = 32): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}
