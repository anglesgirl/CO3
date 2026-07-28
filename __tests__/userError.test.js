import { userErrorMessage } from '../main/utils/userError';

const t = key => key;

describe('user-facing error messages', () => {
  it('translates network failures without exposing raw English', () => {
    expect(userErrorMessage(new Error('Network request failed'), t)).toBe(
      'general_network_error',
    );
  });

  it('uses a generic localized message for unknown errors', () => {
    expect(userErrorMessage(new Error('Unexpected parser failure'), t)).toBe(
      'general_operation_failed',
    );
  });
});
