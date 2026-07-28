import {
  estimateInvitationDate,
  parseInvitationQueue,
} from '../main/web/account/invitationQueue';

describe('AO3 invitation queue parsing', () => {
  it('reads the public queue size and sending rate', () => {
    const html = `
      <p>
        There are currently 186558 people on the waiting list.
        We are sending out 6000 invitations every 12 hours.
      </p>`;

    expect(parseInvitationQueue(html)).toEqual({
      waiting: 186558,
      batchSize: 6000,
      intervalHours: 12,
      position: null,
      estimatedDate: null,
    });
  });

  it('reads a user's queue position and AO3 estimated date', () => {
    const html = `
      <p>You are currently number <strong>12345</strong> on our waiting list!</p>
      <p>At our current rate, you should receive an invitation on or around:
        August 12, 2026.</p>`;

    expect(parseInvitationQueue(html)).toEqual({
      waiting: null,
      batchSize: null,
      intervalHours: null,
      position: 12345,
      estimatedDate: 'August 12, 2026',
    });
  });

  it('estimates a date from position and sending rate when AO3 omits one', () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    const result = estimateInvitationDate(12000, 6000, 12, now);

    expect(result.toISOString()).toBe('2026-07-29T00:00:00.000Z');
  });
});
