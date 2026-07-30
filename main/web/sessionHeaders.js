import { getCredsToken } from '../storage/Credentials';

// The local ECH proxy is restarted independently of Android's CookieManager.
// Attach the saved AO3 session explicitly for authenticated form actions so a
// proxy restart cannot silently turn a bookmark page into AO3's login page.
export async function getSessionHeaders() {
  const token = await getCredsToken();
  if (!token) throw new Error('AO3 session is unavailable. Please log in again.');
  return {
    Cookie: `user_credentials=1; _otwarchive_session=${token}`,
  };
}
