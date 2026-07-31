import * as Keychain from 'react-native-keychain';
import CookieManager from '@react-native-cookies/cookies';

const TIMESTAMP_SERVICE = 'creds_timestamp';

export async function setLastLogin() {
  try {
    await Keychain.setGenericPassword('last_login', new Date().toISOString(), {
      service: TIMESTAMP_SERVICE,
    });
  } catch (error) {
    console.error('Failed to update last login timestamp:', error);
  }
}

export async function getLastLogin() {
  try {
    const creds = await Keychain.getGenericPassword({ service: TIMESTAMP_SERVICE });
    return creds ? creds.password : null;
  } catch (error) {
    console.error('Failed to retrieve last login timestamp:', error);
    return null;
  }
}

export async function deleteLastLogin() {
  try {
    await Keychain.resetGenericPassword({ service: TIMESTAMP_SERVICE });
    console.log('Last login timestamp deleted.');
  } catch (error) {
    console.error('Failed to delete last login timestamp:', error);
    throw error;
  }
}

export async function getCredsPasswd() {
  try {
    const creds = await Keychain.getGenericPassword({
      service: 'creds_passwd',
      authenticationPrompt: {
        title: 'Authenticate to access saved credentials',
        subtitle: 'Access is protected by your biometrics or device passcode',
        description:
          'To ensure your security, you need to authenticate before the app can access your saved login information.',
      },
    });

    if (creds) {
      console.log('Credentials successfully loaded for user ' + creds.username);
      await setLastLogin();
      return creds; // Return credentials
    } else {
      console.log('No credentials stored for password service');
      return null;
    }
  } catch (error) {
    console.error('Failed to retrieve password credentials:', error);
    return null; // Return null on error
  }
}


// The password credential's username is the login identifier (email or AO3
// username). The separate username_only entry is reserved for AO3's canonical
// profile name, which is required in /users/:username URLs.
export async function setCredsPasswd(usrname, passwd) {
  try {
    await Keychain.setGenericPassword(usrname, passwd, {
      service: 'creds_passwd',
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      authenticationPrompt: {
        title: 'Authenticate to save your credentials',
        subtitle: 'Your credentials will be securely stored in the device Keychain',
        description: 'Authentication is required to securely save your login information. This allows the app to automatically log you in when needed.',
      }
    });
    console.log('Password successfully stored');
  } catch (error) {
    console.error('Failed to store password:', error);
    throw error;
  }
}

export async function getCredsToken() {
  try {
    const creds = await Keychain.getGenericPassword({ service: 'creds_token' });

    if (creds) {
      console.log('Token successfully loaded for user ' + creds.username);
      await setLastLogin();
      return creds.password; // Return the token value (which is stored as password)
    } else {
      console.log('No token stored');
      return null; // Return null if no token is stored
    }
  } catch (error) {
    console.error('Failed to retrieve token credentials:', error);
    return null; // Return null on error
  }
}

export async function setCredsToken(token) {
  try {

    await CookieManager.set('https://archiveofourown.org', {
      name: '_otwarchive_session',
      value: token,
      domain: 'archiveofourown.org',
      path: '/',
      version: '1',
      secure: true,
      httpOnly: true,
    });

    // Storing the token with a generic username 'ao3_token'
    await Keychain.setGenericPassword('ao3_token', token, { service: 'creds_token' });
    console.log('Token successfully stored');
  } catch (error) {
    console.error('Failed to store token:', error);
    throw error; // Re-throw to allow calling function to handle
  }
}

export async function deleteCredsPasswd() {
  try {
    await Keychain.resetGenericPassword({ service: 'creds_passwd' });
    await Keychain.resetGenericPassword({ service: 'username_only' });
    console.log('Password credentials deleted.');
  } catch (error) {
    console.error('Failed to delete password credentials:', error);
    throw error;
  }
}

export async function deleteCredsToken() {
  try {
    await Keychain.resetGenericPassword({ service: 'creds_token' });
    await CookieManager.clearAll(); //Why the hell do I need that and why the hell does it remember cookie on its own ???
    //Is it sentient ? I'm scarred. I never told it to remember cookies so why does it do ?
    console.log('Token credentials deleted.');
  } catch (error) {
    console.error('Failed to delete token credentials:', error);
    throw error;
  }
}

export async function getUsername() {
  try {
    const creds = await Keychain.getGenericPassword({
      service: 'username_only',
    });

    if (creds) {
      console.log('Username retrieved: ' + creds.username);
      return creds.username;
    } else {
      console.log('No username stored');
      return null;
    }
  } catch (error) {
    console.error('Failed to retrieve username:', error);
    return null;
  }
}

export async function setUsernameOnly(username) {
  try {
    await Keychain.setGenericPassword(username, 'placeholder', {
      service: 'username_only',
    });
    console.log('Username stored');
  } catch (error) {
    console.error('Failed to store username:', error);
    throw error;
  }
}

export async function hasStoredPassword() {
  try {
    const creds = await Keychain.getGenericPassword({ service: 'creds_passwd' });
    return creds !== false && creds !== null;
  } catch (error) {
    console.error('Failed to check for stored password:', error);
    return false;
  }
}
