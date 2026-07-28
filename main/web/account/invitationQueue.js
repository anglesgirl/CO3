function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'");
}

function toText(html) {
  return decodeHtml(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function numberFrom(match) {
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function intervalInHours(amount, unit) {
  const value = Number(amount);
  if (/day/i.test(unit)) return value * 24;
  if (/minute/i.test(unit)) return value / 60;
  return value;
}

export function parseInvitationQueue(html) {
  const text = toText(html);
  const waiting = numberFrom(
    text.match(/currently\s+([\d,]+)\s+people on the waiting list/i),
  );
  const rate = text.match(
    /sending out\s+([\d,]+)\s+invitations every\s+(\d+)\s+(minutes?|hours?|days?)/i,
  );
  const position = numberFrom(
    text.match(
      /(?:position(?: on the waiting list)?(?: is|:)?\s*(?:number\s*)?|currently number\s+)([\d,]+)/i,
    ),
  );
  const date = text.match(
    /(?:invitation|receive|sent)[^.]{0,100}?(?:on(?: or around)?|by):?\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
  );

  return {
    waiting,
    batchSize: rate ? numberFrom([null, rate[1]]) : null,
    intervalHours: rate ? intervalInHours(rate[2], rate[3]) : null,
    position,
    estimatedDate: date?.[1] ?? null,
  };
}

export function estimateInvitationDate(position, batchSize, intervalHours, now = new Date()) {
  if (!position || !batchSize || !intervalHours) return null;
  const batches = Math.ceil(position / batchSize);
  return new Date(now.getTime() + batches * intervalHours * 60 * 60 * 1000);
}

export function mergeQueueInfo(publicInfo, statusInfo) {
  const merged = { ...publicInfo };
  for (const [key, value] of Object.entries(statusInfo || {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  if (!merged.estimatedDate) {
    const estimate = estimateInvitationDate(
      merged.position,
      merged.batchSize,
      merged.intervalHours,
    );
    merged.estimatedDate = estimate?.toISOString() ?? null;
  }
  return merged;
}
