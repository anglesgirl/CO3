jest.mock('../main/web/requestManager', () => ({
  __esModule: true,
  default: jest.fn(),
  postForm: jest.fn(),
}));

import {
  estimateInvitationDate,
  parseInvitePage,
  parseInviteStatus,
} from '../main/web/account/inviteRequests';

const queueHtml = `
  <form id="new_invite_request">
    <input name="authenticity_token" value="csrf-token" />
  </form>
  <p>
    There are currently 186558 people on the waiting list.
    We are sending out 6000 invitations every 12 hours.
  </p>
`;

describe('AO3 invitation parsing', () => {
  test('parses the queue count, sending rate, and form token', () => {
    expect(parseInvitePage(queueHtml)).toEqual({
      authenticityToken: 'csrf-token',
      queueCount: 186558,
      invitationsPerBatch: 6000,
      batchHours: 12,
    });
  });

  test('parses a successful queue position response', () => {
    const html = '<p>You are currently number 12500 on our waiting list.</p>';
    expect(parseInviteStatus(html)).toEqual({
      found: true,
      position: 12500,
    });
  });

  test('parses an unknown email response', () => {
    const html = "<p>Sorry, we can't find the email address you entered.</p>";
    expect(parseInviteStatus(html)).toEqual({ found: false, position: null });
  });

  test('estimates the next batch that can include the position', () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    const schedule = { batchSize: 6000, batchHours: 12 };
    expect(estimateInvitationDate(12500, schedule, now).toISOString())
      .toBe('2026-07-29T12:00:00.000Z');
  });
});
