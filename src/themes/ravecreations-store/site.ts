/** Links back to the RAVE Creations marketing site (a separate Worker). */
export const MAIN_SITE_URL = 'https://ravecreations.art';

export const MAIN_SITE_LINKS = [
  { text: 'Home', href: `${MAIN_SITE_URL}/` },
  { text: 'About', href: `${MAIN_SITE_URL}/about` },
  { text: 'Journal', href: `${MAIN_SITE_URL}/blog` },
  { text: 'FAQ', href: `${MAIN_SITE_URL}/faq` },
  { text: 'Contact', href: `${MAIN_SITE_URL}/contact` },
] as const;

export const SOCIAL_LINKS = [
  { text: 'Instagram', href: 'https://www.instagram.com/ravecreations.art' },
  { text: 'TikTok', href: 'https://www.tiktok.com/@ravecreations' },
  { text: 'Facebook', href: 'https://www.facebook.com/ravecreations.art' },
  { text: 'YouTube', href: 'https://www.youtube.com/@ravecreationsart' },
] as const;
