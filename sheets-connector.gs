/**
 * Alconost Brief Tracker → Google Sheets connector (Google Apps Script web app).
 *
 * ONE-TIME SETUP
 *  1. Go to https://script.google.com  →  New project.
 *  2. Delete the sample code, paste THIS whole file, Save.
 *  3. Deploy ▸ New deployment ▸ type "Web app".
 *       - Description: brief-tracker
 *       - Execute as:  Me
 *       - Who has access:  Anyone
 *     Deploy, authorize when prompted, and COPY the "Web app URL"
 *     (looks like https://script.google.com/macros/s/AKfy.../exec).
 *  4. Paste that URL into the dashboard the first time you click "→ Sheet".
 *
 * It writes to the tab named after the card ticket (e.g. PF-65623), filling
 * Project name / Languages codes / Original content and the language column
 * headers. It only touches columns A–E + the header row, so translations you
 * add later in the language columns are never overwritten.
 */

// The two spreadsheets, keyed by ticket prefix (IP).
var SHEETS = {
  MPY: '1YMqUI3ZUIMK4W0gpSvnBOTkCyxE4W3lnul80bx_FFss', // MPY-Linguini and Farming translations batches
  PF:  '1D-OdC4TeqX-nECnwAgYv_RlrCXtX2euayuPrJzmbYog'  // Pixel Flow translations
};

function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);
    var ssId = SHEETS[p.ip];
    if (!ssId) return _json({ ok: false, error: 'No spreadsheet mapped for "' + p.ip + '"' });

    var ss = SpreadsheetApp.openById(ssId);
    var name = String(p.tab).slice(0, 90).replace(/[:\\\/?*\[\]]/g, '-');
    var sheet = ss.getSheetByName(name);
    var existed = !!sheet;
    if (!sheet) sheet = ss.insertSheet(name, 0);

    var langs = p.langCodes || [];
    var header = ['Project name', 'Context', 'Languages', 'Languages codes', 'Original content'].concat(langs);
    var strings = (p.strings && p.strings.length) ? p.strings : [''];

    // header row (full width)
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    // body: only columns A–E (leave translation columns F+ untouched)
    var body = strings.map(function (s, i) {
      return [ i === 0 ? (p.projectName || '') : '', '', '', i === 0 ? langs.join(', ') : '', s ];
    });
    sheet.getRange(2, 1, body.length, 5).setValues(body);
    sheet.setFrozenRows(1);

    return _json({ ok: true, tab: name, existed: existed, rows: body.length, ip: p.ip });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

// Simple GET so you can confirm the deployment is live in a browser.
function doGet() {
  return _json({ ok: true, service: 'brief-tracker sheets connector', sheets: Object.keys(SHEETS) });
}

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
