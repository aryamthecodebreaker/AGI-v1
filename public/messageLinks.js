// Pure message-link parsing kept separate from DOM rendering so URL edge cases
// can be regression-tested without a browser runtime.

const MESSAGE_LINK_PATTERN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^<>\s]+)>|(https?:\/\/[^\s<>()\[\]]+)/g;

export function parseMessageSegments(content) {
  const segments = [];
  let cursor = 0;
  for (const match of content.matchAll(MESSAGE_LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: content.slice(cursor, index) });
    const rawUrl = match[2] || match[3] || match[4];
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported link');
      segments.push({ text: match[1] || rawUrl, url: url.href });
    } catch {
      segments.push({ text: match[0] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor) });
  return segments;
}
