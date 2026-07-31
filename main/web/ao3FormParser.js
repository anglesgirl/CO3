let DomParser = require('react-native-html-parser').DOMParser;

function elementsNamed(doc, tagName, fieldName) {
  return Array.from(doc.getElementsByTagName(tagName)).filter(
    element => element.getAttribute('name') === fieldName,
  );
}

export function parseAuthenticityToken(doc) {
  const input = elementsNamed(doc, 'input', 'authenticity_token')[0];
  return input?.getAttribute('value') || null;
}

export function parseBookmarkForm(html) {
  const doc = new DomParser().parseFromString(html, 'text/html');
  const token = parseAuthenticityToken(doc);
  const input = elementsNamed(doc, 'input', 'bookmark[pseud_id]')[0];
  // AO3 renders a select for accounts with multiple pseuds. Its selected
  // option is authoritative; only older single-pseud forms use a hidden input.
  // react-native-html-parser does not reliably preserve a boolean `selected`
  // attribute, so inspect that small form fragment before using the DOM fallback.
  const selected = String(html).match(
    /<option\b(?=[^>]*\bselected(?:\s|=|>))(?=[^>]*\bvalue=["']([^"']+)["'])[^>]*>/i,
  );
  const pseudId = selected?.[1] || parsePseudSelect(doc) || input?.getAttribute('value') || null;
  return { token, pseudId };
}

export function parseMarkForLaterForm(html) {
  const doc = new DomParser().parseFromString(html, 'text/html');
  const forms = Array.from(doc.getElementsByTagName('form'));
  const form = forms.find(item => item.getAttribute('action')?.includes('/mark_for_later'));
  return {
    action: form?.getAttribute('action') || null,
    token: parseAuthenticityToken(doc),
  };
}

function parsePseudSelect(doc) {
  const select = elementsNamed(doc, 'select', 'bookmark[pseud_id]')[0];
  if (!select) return null;
  const options = Array.from(select.getElementsByTagName('option'));
  const selected = options.find(option => option.getAttribute('selected') !== null);
  const fallback = options.find(option => option.getAttribute('value'));
  return (selected || fallback)?.getAttribute('value') || null;
}
