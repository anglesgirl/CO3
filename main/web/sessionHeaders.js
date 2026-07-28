import { getCredsToken } from '../storage/Credentials';

export async function getSessionHeaders(requireToken = true) {
  const token = await getCredsToken();
  if (!token) {
    if (requireToken) throw new Error('AO3 session is unavailable');
    return {};
  }
  return {
    Cookie: `user_credentials=1; _otwarchive_session=${token}`,
  };
}
