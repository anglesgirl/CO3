import getUrl, { postForm } from '../requestManager';

const AO3_URL = 'https://archiveofourown.org';
const INVITE_URL = `${AO3_URL}/invite_requests`;
const DomParser = require('react-native-html-parser').DOMParser;

function pageText(html) {
  const doc = new DomParser().parseFromString(html, 'text/html');
  return doc.getElementsByTagName('body')?.[0]?.textContent || html;
}

function parseNumber(value) {
  return value ? Number(value.replace(/,/g, '')) : null;
}

function findInviteToken(html) {
  const doc = new DomParser().parseFromString(html, 'text/html');
  const form = doc.getElementById('new_invite_request');
  const inputs = form?.getElementsByTagName('input') || [];

  for (let index = 0; index < inputs.length; index += 1) {
    if (inputs[index].getAttribute('name') === 'authenticity_token') {
      return inputs[index].getAttribute('value');
    }
  }
  return null;
}

export function parseInvitePage(html) {
  const text = pageText(html).replace(/\s+/g, ' ');
  const queue = text.match(/currently\s+([\d,]+)\s+people on the waiting list/i);
  const rate = text.match(/sending out\s+([\d,]+)\s+invitations every\s+(\d+)\s+hours?/i);

  return {
    authenticityToken: findInviteToken(html),
    queueCount: parseNumber(queue?.[1]),
    invitationsPerBatch: parseNumber(rate?.[1]),
    batchHours: parseNumber(rate?.[2]),
  };
}

export function parseInviteStatus(html) {
  const text = pageText(html).replace(/\s+/g, ' ');
  if (/can't find the email|cannot find the email|no invitation request/i.test(text)) {
    return { found: false, position: null };
  }

  const patterns = [
    /(?:currently|now)\s+(?:at\s+)?(?:number|position|#)?\s*([\d,]+)\s+(?:on|in)\s+(?:our|the)\s+waiting list/i,
    /(?:position|number)\s+(?:is\s+)?#?\s*([\d,]+)/i,
  ];
  const match = patterns.map(pattern => text.match(pattern)).find(Boolean);
  const position = parseNumber(match?.[1]);
  return { found: position !== null, position };
}

export function estimateInvitationDate(position, schedule, now = new Date()) {
  const { batchSize, batchHours } = schedule;
  if (!position || !batchSize || !batchHours) return null;
  const batches = Math.ceil(position / batchSize);
  return new Date(now.getTime() + batches * batchHours * 60 * 60 * 1000);
}

export async function fetchInviteInfo() {
  return parseInvitePage(await getUrl(INVITE_URL));
}

export async function fetchInviteStatus(email) {
  const url = `${INVITE_URL}/show?email=${encodeURIComponent(email)}`;
  return parseInviteStatus(await getUrl(url));
}

export async function requestInvitation(email) {
  const info = await fetchInviteInfo();
  if (!info.authenticityToken) throw new Error('Invitation form is unavailable');

  const response = await postForm(INVITE_URL, {
    authenticity_token: info.authenticityToken,
    'invite_request[email]': email,
    commit: 'Add me to the list',
  }, { Referer: INVITE_URL });
  const responseStatus = parseInviteStatus(response);
  const status = responseStatus.found ? responseStatus : await fetchInviteStatus(email);
  const position = status.position || (info.queueCount ? info.queueCount + 1 : null);

  return {
    position,
    estimatedAt: estimateInvitationDate(
      position,
      {
        batchSize: info.invitationsPerBatch,
        batchHours: info.batchHours,
      },
    ),
  };
}
