const NETWORK_ERROR_PATTERN =
  /network request failed|failed to fetch|network error|timed?\s*out|timeout/i;

export function userErrorMessage(error, translate) {
  if (error?.code === 'ECH_REQUIRED') {
    return translate('general_protected_retry');
  }
  const message = error?.message ?? String(error ?? '');
  const key = NETWORK_ERROR_PATTERN.test(message)
    ? 'general_network_error'
    : 'general_operation_failed';

  return translate(key);
}
