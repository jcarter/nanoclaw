import { google } from 'googleapis';
import fs from 'fs';

const CREDS_DIR = process.env.HOME + '/.gmail-mcp';
const keys = JSON.parse(fs.readFileSync(`${CREDS_DIR}/gcp-oauth.keys.json`, 'utf8'));
const creds = JSON.parse(fs.readFileSync(`${CREDS_DIR}/credentials.json`, 'utf8'));

console.log('Current expiry:', new Date(creds.expiry_date).toISOString());
console.log('Now:', new Date().toISOString());
console.log('Expired:', Date.now() > creds.expiry_date);

const oauth2 = new google.auth.OAuth2(
  keys.installed.client_id,
  keys.installed.client_secret,
  'http://localhost'
);
oauth2.setCredentials(creds);

try {
  const { credentials } = await oauth2.refreshAccessToken();
  fs.writeFileSync(`${CREDS_DIR}/credentials.json`, JSON.stringify(credentials, null, 2));
  console.log('Token refreshed! New expiry:', new Date(credentials.expiry_date).toISOString());
} catch (e) {
  console.error('Refresh failed:', e.message);
}
